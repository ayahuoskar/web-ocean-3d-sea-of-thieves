import type { QualityTier } from '../core/QualityManager';
import { mulberry32 } from '../core/random';
import { NoiseBed, type NoiseBedOptions } from './NoiseBed';
import { NOISE_SECONDS, createNoiseBuffer } from './noise';
import { ParamTarget } from './ParamTarget';

/**
 * The scene's ambience, synthesised rather than sampled.
 *
 * There is no reliably-licensed CC0 ocean or wind recording this project could
 * fetch reproducibly — and the licensing is the smaller half of the argument. A
 * recording is a photograph of one sea. This scene changes wind speed, wave
 * height, rain rate, hull speed and submersion *live and continuously*, from a
 * slider the viewer is holding, and a fixed loop can only be cross-faded between:
 * which is audible as exactly what it is, two seas playing at once, each still
 * describing the wind it was recorded in. Filtered noise whose band and level
 * *are* functions of the wind speed has no such seam, because there is nothing to
 * cross-fade — there is one sea and the wind speed is a term in it. That is also
 * how a parameterised sea is actually built; sample libraries are for sounds that
 * do not have a parameter.
 *
 * The layers, and what drives each:
 *
 *  - **Surf.** Low-passed noise, level linear in wind speed and band opening with
 *    it, breathing on the swell period implied by the peak wavelength.
 *  - **Wind.** A separate, higher band that climbs far faster than the sea does,
 *    plus an aeolian tone off the rigging once it is blowing hard enough to sing.
 *  - **Rain.** Denser and brighter than the wind, with a separate hiss layer and a
 *    low drumming that only appears in a downpour.
 *  - **Hull.** Bow wash and the rush along the side, from hull speed.
 *  - **Underwater.** Not a switch: `submersion` continuously ducks and closes a
 *    low-pass over everything above, brings up a rumble, and starts entraining
 *    bubbles.
 *
 * Three constraints shaped the implementation more than the sound design did.
 *
 * **Autoplay.** An `AudioContext` may not start before a user gesture. This one
 * is constructed and then explicitly suspended, its master gain is pinned at zero
 * until `resume()` has been called from a gesture, and if the platform has no Web
 * Audio at all every method here is a no-op that returns rather than throwing.
 * Audio is the one subsystem that must never be able to take the frame down.
 *
 * **`update` allocates nothing.** It runs on the render loop. Every node exists
 * from construction, every parameter write goes through a `ParamTarget` that
 * smooths, dedupes and drops non-finite values, and the layer model is plain
 * arithmetic on preallocated fields. One-shots do allocate — a source node cannot
 * be restarted, so an event has to build its voice — but they are events, not
 * frames, and the voice count is capped per tier so a storm cannot turn into an
 * allocation storm.
 *
 * **Silence has to be free.** Under the capture harness this is muted for the
 * whole run. Muted, and while the context is not running, no parameter is written
 * at all: the model still advances so `resetClock` means something, but nothing
 * touches the audio thread. That is not only cheaper, it removes any path by which
 * scheduling audio could perturb the frame timing of a measurement.
 */

/** Scene state the ambience is a function of. */
export interface AudioSceneParams {
  /** Wind speed at the 10 m reference height, m/s. `UiState.windSpeed`. */
  windSpeed: number;
  /** Significant wave height, metres. `significantWaveHeight( spectrumParams )`. */
  waveHeight: number;
  /** JONSWAP peak wavelength, metres. `UiState.peakWavelength`. */
  peakWavelength: number;
  /** Rain reaching the sea, 0..1 — the value `Wake.setRainAgitation` is given. */
  rain: number;
  /** Camera submersion, 0..1. `CameraDirector.submersion()`. */
  submersion: number;
  /** Hull speed over ground, m/s. `ShipControlState.speed`; 0 with no ship. */
  hullSpeed: number;
}

export const DEFAULT_AUDIO_SCENE_PARAMS: AudioSceneParams = {
  windSpeed: 15,
  waveHeight: 5,
  peakWavelength: 47,
  rain: 0,
  submersion: 0,
  hullSpeed: 0,
};

export interface AudioQualitySettings {
  /** A second, opposite-panned surf bed. Without it the sea is mono. */
  stereoSurf: boolean;
  /** The resonant aeolian tone off the standing rigging. */
  rigging: boolean;
  /** A separate high-frequency hiss layer over the rain. */
  rainHiss: boolean;
  /**
   * Bubble blips per second at full submersion in a reference sea. 0 disables the
   * scheduler outright, which is what makes Low genuinely oscillator-free.
   */
  bubbleRate: number;
  /**
   * Concurrent one-shot voices. Events past the cap are dropped, never queued —
   * a queued splash arrives after the thing that splashed has gone.
   */
  voices: number;
}

/**
 * Tiers, in the same shape and order as `QUALITY_TIERS`.
 *
 * What changes between them is the number of sources actually being rendered:
 * Low runs five noise beds and no oscillators at all, Max runs eight beds and up
 * to twelve concurrent voices. Nothing here changes the *sound* of a layer, only
 * whether it is present — a tier drop should read as the sea getting simpler, not
 * as somebody moving the mix.
 */
export const AUDIO_QUALITY_TIERS: Record<QualityTier, AudioQualitySettings> = {
  low: { stereoSurf: false, rigging: false, rainHiss: false, bubbleRate: 0, voices: 3 },
  medium: { stereoSurf: false, rigging: true, rainHiss: true, bubbleRate: 1.2, voices: 5 },
  high: { stereoSurf: true, rigging: true, rainHiss: true, bubbleRate: 2.0, voices: 8 },
  ultra: { stereoSurf: true, rigging: true, rainHiss: true, bubbleRate: 2.6, voices: 10 },
  max: { stereoSurf: true, rigging: true, rainHiss: true, bubbleRate: 3.4, voices: 12 },
};

export interface AudioSystemOptions {
  /** Master volume, 0..1. */
  volume?: number;
  /** Starts muted. Defaults to false; the capture harness sets it. */
  muted?: boolean;
  quality?: QualityTier;
}

/**
 * Seeds for the procedural content here.
 *
 * Local rather than added to `SEEDS` in `core/random`, and literal constants for
 * the same reason that module gives: a value that drifts makes two runs
 * incomparable, so it is written where a change to it shows up in a diff.
 */
const AUDIO_SEEDS = {
  white: 0x0ce4a1,
  brown: 0x5b0d33,
  bubbles: 0xb0bb1f,
  gusts: 0x9c5751,
  oneShots: 0x5c1a5d,
  thunderShape: 0x7d0c4a,
} as const;

/** Clock wrap, seconds. Matches the other animated systems in this project. */
const CLOCK_WRAP = 3600;

const TAU = Math.PI * 2;
const GRAVITY = 9.81;

// --- master ----------------------------------------------------------------

/**
 * Compressor settings for the master bus.
 *
 * Not for loudness. The layers are summed with fixed gains chosen so a typical
 * sea sits comfortably, but the *worst* case is a full storm with rain, a hull at
 * speed and a close thunder crack landing on the same sample — and that case is
 * both rare and roughly 4x the typical one, so mixing to leave headroom for it
 * would leave everything else inaudibly quiet. A gentle 4:1 above -12 dBFS with a
 * soft knee costs one node and makes the loud case merely loud instead of clipped.
 * The 6 ms attack is deliberately slower than a limiter's: it lets the leading
 * edge of a thunder crack through, which is the only part of a crack that sounds
 * like one.
 */
const COMPRESSOR_THRESHOLD_DB = -12;
const COMPRESSOR_KNEE_DB = 14;
const COMPRESSOR_RATIO = 4;
const COMPRESSOR_ATTACK = 0.006;
const COMPRESSOR_RELEASE = 0.28;

/** Fades applied by the volume, mute and enable controls, seconds. */
const VOLUME_RAMP = 0.05;
const MUTE_RAMP = 0.02;
const ENABLE_RAMP = 0.2;
/** Fade-in on the first resume. A sea that cuts in at full level reads as a bug. */
const RESUME_RAMP = 0.6;
/** Grace between a disable fading out and the context being suspended. */
const SUSPEND_DELAY = 0.35;

// --- swell -----------------------------------------------------------------

/**
 * Waves per group.
 *
 * What makes a sea audibly *surge* rather than hiss is not individual waves, it
 * is groups of them, and the folklore figure of every seventh wave is close
 * enough to the beat period of a narrow wind-sea spectrum to use directly. Both
 * periods run at once, which is why the surge never lands on the same beat twice.
 */
const GROUP_WAVES = 7;
/** Phase offset between the two modulators, so they cannot start in step. */
const GROUP_PHASE = 1.7;
/** Phase the far surf bed lags the near one by, so the stereo image is not pumped. */
const SURF_FAR_PHASE = Math.PI / 3;
/** Modulation depth at a flat calm, and the span added by a full sea. */
const SWELL_DEPTH_CALM = 0.1;
const SWELL_DEPTH_SPAN = 0.32;
/** Significant wave height, metres, at which the surge is fully developed. */
const SWELL_FULL_HEIGHT = 5;

// --- surf ------------------------------------------------------------------

/**
 * Wind speed the surf bed is referenced to, m/s, and the ceiling on that ratio.
 *
 * Amplitude linear in wind speed is not a taste decision. The Knudsen/Wenz
 * ambient-sea-noise curves put the broadband level up by about 6 dB per doubling
 * of wind speed across the band that matters here, and 6 dB *is* a factor of two
 * in amplitude. 12 m/s is a fresh breeze — near the middle of the 0.5..25 range
 * the slider offers, so neither end of it is extrapolating far.
 */
const SURF_REFERENCE_WIND = 12;
const SURF_MAX_DRIVE = 1.5;
/** Level at a flat calm. A glassy sea is not silent; it slops. */
const SURF_CALM = 0.12;
const SURF_LEVEL = 0.5;
/**
 * Low-pass corner, Hz, and how it moves.
 *
 * The Knudsen spectra fall at roughly 5–6 dB per octave above a few hundred hertz,
 * which is what a 12 dB/octave low-pass over white noise gives once the shoulder
 * is accounted for. It opens with wind speed because a stronger wind breaks the
 * surface at smaller scales and small breakers are what the high end is; it closes
 * with wave height because a big sea's energy is in slow, heavy water.
 */
const SURF_CUTOFF_BASE = 430;
const SURF_CUTOFF_PER_WIND = 26;
const SURF_CUTOFF_PER_HEIGHT = 34;
const SURF_CUTOFF_MIN = 160;
const SURF_CUTOFF_MAX = 1600;
const SURF_Q = 0.6;
/** The second bed is quieter and darker: it is the sea further out. */
const SURF_FAR_LEVEL = 0.78;
const SURF_FAR_TILT = 0.72;
const SURF_PAN = 0.45;

// --- wind ------------------------------------------------------------------

/**
 * Wind noise climbs far faster than sea noise.
 *
 * Aerodynamic noise from an edge or a wire radiates as a power law in flow speed
 * with an exponent between 5 and 6 — that is in *power*, so somewhere near 3 in
 * amplitude. 1.6 is well under that on purpose: the real exponent applied across a
 * 0.5..25 m/s slider spans 15000:1, which is not a mix, it is a fault. What the
 * exponent has to do here is make the wind overtake the sea as it rises, and be
 * genuinely absent in a calm, and 1.6 does both.
 */
const WIND_EXPONENT = 1.6;
const WIND_REFERENCE_WIND = 16;
const WIND_MAX_DRIVE = 1.5;
const WIND_LEVEL = 0.34;
const WIND_BAND_BASE = 340;
const WIND_BAND_PER_WIND = 55;
const WIND_BAND_MIN = 300;
const WIND_BAND_MAX = 2400;
const WIND_Q = 0.75;
const WIND_HIGHPASS = 180;

/**
 * Aeolian tone off the standing rigging: f = St * U / d.
 *
 * The Strouhal number of a circular cylinder is very nearly 0.2 over the whole
 * Reynolds range a 6 mm wire sees in wind — which is why a shroud's pitch is a
 * usable wind gauge, and why this is a tone rather than a texture. At 15 m/s it
 * sings at 500 Hz. It is gated on wind speed because the tone only establishes
 * itself once vortex shedding is periodic; below that the wire is just an
 * obstacle in turbulent air.
 */
const STROUHAL = 0.2;
const RIGGING_DIAMETER = 0.006;
const RIGGING_MIN_HZ = 120;
const RIGGING_MAX_HZ = 2600;
const RIGGING_Q = 7;
const RIGGING_LEVEL = 0.1;
const RIGGING_ONSET = 9;
const RIGGING_FULL = 20;

/** Gusting: depth, hold between new targets, and how fast it gets there. */
const GUST_DEPTH = 0.18;
const GUST_HOLD_MIN = 1.4;
const GUST_HOLD_SPAN = 2.6;
const GUST_TAU = 1.1;

// --- rain ------------------------------------------------------------------

/**
 * Level exponent for rain.
 *
 * Sub-linear, because rain noise is the sum of a very large number of independent
 * impacts and doubling the rate of a Poisson process adds 3 dB, not 6. Above about
 * half intensity what changes is mostly the *spectrum* — bigger drops, more low
 * drumming — which is why the band moves rather than the level continuing to climb.
 */
const RAIN_EXPONENT = 0.6;
const RAIN_LEVEL = 0.42;
const RAIN_CUTOFF_BASE = 3400;
const RAIN_CUTOFF_PER_RATE = 1100;
const RAIN_CUTOFF_MIN = 1600;
const RAIN_CUTOFF_MAX = 3600;
const RAIN_Q = 0.5;
/**
 * The rain layer's high-pass drops as the rain hardens.
 *
 * This is the drumming. Light rain on water is all splash and no body; heavy rain
 * is large drops hitting hard enough to make the deck and the sea itself respond
 * down at a couple of hundred hertz. Opening the high-pass downward is what
 * separates a shower from a downpour far more than the level does.
 */
const RAIN_HIGHPASS_BASE = 340;
const RAIN_HIGHPASS_PER_RATE = 200;
const RAIN_HIGHPASS_MIN = 110;
const RAIN_HISS_LEVEL = 0.16;
const RAIN_HISS_EXPONENT = 1.4;
const RAIN_HISS_HZ = 5200;
const RAIN_PAN = 0.25;

// --- hull ------------------------------------------------------------------

/**
 * Reference hull speed, m/s. The same 7 the wake's foam deposition saturates at,
 * because they are describing the same event: water being thrown by the hull.
 */
const HULL_REFERENCE_SPEED = 7;
/**
 * Wave-making resistance rises steeply with speed and the noise rides on it, so
 * this is super-linear like the wake's amplitude — but 1.5 rather than the wake's
 * quadratic, because what is heard is the entrained air and not the wave.
 */
const HULL_EXPONENT = 1.5;
const HULL_LEVEL = 0.3;
/** Faded in from rest, matching the wake's own 0.4..2.2 m/s amplitude fade. */
const HULL_ONSET = 0.4;
const HULL_FULL = 2.2;
const HULL_BAND_BASE = 200;
const HULL_BAND_PER_SPEED = 42;
const HULL_BAND_MIN = 200;
const HULL_BAND_MAX = 1100;
const HULL_Q = 0.55;
const HULL_HIGHPASS = 90;

// --- submersion ------------------------------------------------------------

/**
 * How much of the air mix survives at full submersion.
 *
 * Not all of it and not none. Sound crosses the air/water boundary badly — the
 * impedance mismatch reflects almost everything — but a swimmer under a breaking
 * sea is emphatically not in silence, because the breaking itself is happening in
 * the water. Ducking to a fifth and then closing the low-pass is what reads as
 * going under; ducking to zero reads as the audio failing.
 */
const AIR_DUCK = 0.8;
const AIR_OPEN_HZ = 18000;
const AIR_CLOSED_HZ = 320;
/**
 * Submersion exponent for the underwater bus.
 *
 * Above 1 would make the transition happen at the very end of the band and pop;
 * below 1 brings the rumble in as soon as the lens touches the water, which is
 * when it should arrive — the camera's submersion ramp is only 0.7 m wide and a
 * crest can cross it in a tenth of a second.
 */
const UNDER_EXPONENT = 0.7;
const RUMBLE_LEVEL = 0.55;
const RUMBLE_CALM = 0.45;
const RUMBLE_PER_WIND = 0.55;
const RUMBLE_HZ = 150;
const RUMBLE_Q = 1.1;
const RUMBLE_HIGHPASS = 25;

/**
 * Minnaert's constant, Hz·m: an air bubble in water rings at 3.26 / radius.
 *
 * That single relation is the whole reason synthesised bubbles are convincing —
 * the pitch is not a choice, it is the size of the bubble, and a spread of sizes
 * gives the scatter of pitches the ear expects. 0.8 to 5 mm is the range breaking
 * water and a hull entrain, which puts the blips between 650 Hz and 4 kHz.
 */
const MINNAERT_CONSTANT = 3.26;
const BUBBLE_MIN_RADIUS = 0.0008;
const BUBBLE_MAX_RADIUS = 0.005;
/**
 * How far the pitch rises over the blip.
 *
 * A bubble radiates while it is still detaching and shrinking, so its resonance
 * climbs — that upward chirp is the difference between a bubble and a beep.
 */
const BUBBLE_RISE = 1.6;
const BUBBLE_DECAY_MIN = 0.03;
const BUBBLE_DECAY_SPAN = 0.05;
const BUBBLE_LEVEL = 0.09;
const BUBBLE_CALM = 0.4;
const BUBBLE_PER_WIND = 0.6;
/**
 * Floor on the interval between scheduled bubbles, seconds.
 *
 * The scheduler drains its accumulated time in a `while` loop, and a Poisson
 * interval is `-ln(1 - u) / rate` — which is legitimately zero when `u` is. Without
 * a floor that is an infinite loop inside the frame update, i.e. a hung tab, for
 * one unlucky draw in a few billion. It also caps the worst case at 50 blips a
 * second whatever the rate is asked to be.
 */
const BUBBLE_MIN_GAP = 0.02;

// --- one-shots -------------------------------------------------------------

const SPLASH_LEVEL = 0.5;
const SPLASH_DECAY_MIN = 0.14;
const SPLASH_DECAY_SPAN = 0.4;
/**
 * The splash band sweeps down.
 *
 * An impact on water is bright at the instant of contact — the crown and the
 * spray — and then the cavity collapses, which is a larger, slower, lower event.
 * A splash on a fixed band sounds like a burst of static; the sweep is most of
 * what makes it read as water.
 */
const SPLASH_OPEN_HZ = 2600;
const SPLASH_CLOSE_HZ = 520;
const SPLASH_BODY_HZ = 190;
const SPLASH_BODY_LEVEL = 0.6;
/** Air entrained by the impact, surfacing over the following moment. */
const SPLASH_BUBBLES = 3;
const SPLASH_BUBBLE_WINDOW = 0.4;

const THUNDER_LEVEL = 0.85;
/**
 * e-folding distance for the crack, km.
 *
 * Atmospheric absorption is strongly frequency dependent — of order 2 dB/km at
 * 500 Hz and well over 20 dB/km at 4 kHz in ordinary conditions — so distance does
 * not merely quieten thunder, it removes the top of it. That is the entire
 * difference between a crack overhead and a roll on the horizon, and 1.4 km puts
 * the crossover where a viewer expects it.
 */
const THUNDER_ABSORPTION_KM = 1.4;
/** Geometric spreading plus scattering, as a simple inverse law. */
const THUNDER_SPREAD_PER_KM = 0.55;
const THUNDER_CRACK_SECONDS = 0.9;
const THUNDER_CRACK_HZ = 2600;
const THUNDER_CRACK_HIGHPASS = 260;
const THUNDER_ROLL_MIN_SECONDS = 1.5;
const THUNDER_ROLL_PER_KM = 0.5;
const THUNDER_ROLL_MAX_SECONDS = 8;
const THUNDER_ROLL_HZ = 110;
/**
 * Speed of sound, km/s. Not used by default — see `playThunder` — but it is the
 * number a caller wants when it triggers the sound off a lightning flash.
 */
export const SPEED_OF_SOUND_KM_S = 0.343;

/** Envelope curve resolution. 256 points over a roll is ~30 ms per point. */
const CURVE_POINTS = 256;

const UI_CLICK_HZ = 1250;
const UI_CLICK_FALL = 0.62;
const UI_CLICK_SECONDS = 0.045;
const UI_CLICK_LEVEL = 0.13;

/**
 * Per-bed playback rates and buffer offsets.
 *
 * Every air layer reads the same white buffer, so without this they would be
 * filtered copies of one signal — which comb-filters where their bands overlap and
 * makes the whole mix repeat on one period. Mutually incommensurate rates and
 * offsets spread across the buffer cost nothing and remove both.
 */
const BED_RATES = {
  surfNear: 0.83,
  surfFar: 1.07,
  wind: 0.91,
  rigging: 1.19,
  rain: 1.13,
  rainHiss: 0.97,
  hull: 1.03,
  rumble: 0.89,
} as const;

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

export class AudioSystem {
  /** False when the platform has no Web Audio. Every method is then a no-op. */
  readonly available: boolean;

  private ctx: AudioContext | null = null;
  private disposed = false;

  // --- master chain ---------------------------------------------------------
  private master!: GainNode;
  private compressor!: DynamicsCompressorNode;
  private mix!: GainNode;
  /** Everything above the waterline, before the muffle. */
  private airBus!: GainNode;
  private airMuffle!: BiquadFilterNode;
  private underBus!: GainNode;
  /**
   * UI feedback, routed past the muffle.
   *
   * A click is not in the world — it is the interface, and the interface does not
   * go underwater with the camera. Sending it through the air bus made pressing a
   * button while submerged sound like the panel was broken.
   */
  private uiBus!: GainNode;

  private airGain!: ParamTarget;
  private muffle!: ParamTarget;
  private underGain!: ParamTarget;

  // --- layers ---------------------------------------------------------------
  private surfNear!: NoiseBed;
  private surfFar!: NoiseBed;
  private windBed!: NoiseBed;
  private rigging!: NoiseBed;
  private rainBed!: NoiseBed;
  private rainHiss!: NoiseBed;
  private hull!: NoiseBed;
  private rumble!: NoiseBed;
  private readonly beds: NoiseBed[] = [];
  private readonly targets: ParamTarget[] = [];

  private white!: AudioBuffer;

  // --- state ----------------------------------------------------------------
  private volume = 0.8;
  private muted = false;
  private enabled = true;
  private gestured = false;
  private tier: QualityTier = 'high';
  private settings: AudioQualitySettings = AUDIO_QUALITY_TIERS.high;
  private suspendAt: number | null = null;

  private clock = 0;
  private gust = 1;
  private gustTarget = 1;
  private gustTimer = 0;
  private bubbleTimer = 0;

  private bubbleRandom = mulberry32(AUDIO_SEEDS.bubbles);
  private gustRandom = mulberry32(AUDIO_SEEDS.gusts);
  private oneShotRandom = mulberry32(AUDIO_SEEDS.oneShots);

  private crackCurve!: Float32Array;
  private rollCurve!: Float32Array;

  /** Live one-shot sources, so a reset or a dispose can silence them. */
  private readonly voices: AudioScheduledSourceNode[] = [];

  constructor(options: AudioSystemOptions = {}) {
    this.volume = clamp01(finite(options.volume, this.volume));
    this.muted = options.muted ?? false;
    this.tier = options.quality ?? 'high';
    this.settings = AUDIO_QUALITY_TIERS[this.tier] ?? AUDIO_QUALITY_TIERS.high;

    const Ctor = resolveAudioContext();
    if (Ctor === null) {
      this.available = false;
      return;
    }

    try {
      // 'interactive' rather than 'playback'. A larger buffer would be cheaper and
      // more robust against a heavy frame, but the UI click has to land with the
      // press — 'playback' can put a couple of hundred milliseconds between them,
      // which does not read as latency, it reads as the button not having worked.
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.build(this.ctx);
      this.available = true;
    } catch {
      // Construction can fail outright on a locked-down or headless platform.
      // Audio going missing is acceptable; taking the scene with it is not.
      this.ctx = null;
      this.available = false;
      return;
    }

    // Some platforms hand back a context that is already running — a page that has
    // been interacted with, or one with an autoplay exemption. Left alone, that
    // starts the sea before the application has said it may.
    if (this.ctx.state === 'running') void this.ctx.suspend().catch(() => {});
  }

  /** `'unavailable'` when there is no Web Audio at all. */
  get contextState(): 'unavailable' | AudioContextState {
    return this.ctx === null ? 'unavailable' : this.ctx.state;
  }

  /** True while audio exists but is still waiting for its unlocking gesture. */
  get needsGesture(): boolean {
    return this.ctx !== null && !this.gestured;
  }

  /**
   * Unlocks audio. Must be called from inside a user gesture handler.
   *
   * Safe to call repeatedly and safe to call when there is no audio; resolves
   * `true` only once the context is genuinely running.
   */
  async resume(): Promise<boolean> {
    const ctx = this.ctx;
    if (ctx === null || this.disposed) return false;

    this.gestured = true;
    this.suspendAt = null;
    if (!this.enabled) return false;

    try {
      await ctx.resume();
    } catch {
      return false;
    }
    if (this.disposed || this.ctx === null) return false;

    // The model has been running since construction, so its targets are current;
    // pushing them in one go stops the scene fading in from a stale state.
    const now = ctx.currentTime;
    this.startBeds(now);
    this.flushAll(now);
    this.applyMasterGain(RESUME_RAMP);
    return ctx.state === 'running';
  }

  /**
   * Convenience: resumes on the first gesture on `target`.
   *
   * Returns a disposer. Entirely optional — a caller with its own gesture plumbing
   * should just call `resume()` from it.
   */
  resumeOnGesture(target?: EventTarget): () => void {
    // Resolved in the body, not as a default argument: a default is evaluated on
    // every call, so `= window` would throw on a platform without a DOM before
    // the `available` guard below could stop it.
    const listener = target ?? (typeof window === 'undefined' ? null : window);
    if (this.ctx === null || listener === null) return () => {};

    const events = ['pointerdown', 'keydown', 'touchstart'] as const;
    const handler = (): void => {
      void this.resume();
      for (const name of events) listener.removeEventListener(name, handler);
    };
    for (const name of events) listener.addEventListener(name, handler, { passive: true });
    return () => {
      for (const name of events) listener.removeEventListener(name, handler);
    };
  }

  /**
   * Drives every layer from the current scene state.
   *
   * Allocates nothing. `params` is read and not retained, so a caller that hoists
   * one object and mutates its fields allocates nothing either.
   */
  update(dt: number, params: Readonly<AudioSceneParams>): void {
    const ctx = this.ctx;
    if (ctx === null || this.disposed) return;

    const step = clampNumber(finite(dt, 0), 0, 0.1);
    this.clock = (this.clock + step) % CLOCK_WRAP;

    const now = ctx.currentTime;

    // Deferred work first: it has to run even when nothing else does, or a
    // disabled system keeps its sources rendering forever.
    if (this.suspendAt !== null && now >= this.suspendAt) {
      this.suspendAt = null;
      void ctx.suspend().catch(() => {});
    }
    for (let i = 0; i < this.beds.length; i++) this.beds[i].tick(now);

    const live = this.enabled && !this.muted && ctx.state === 'running';

    const wind = clampNumber(finite(params.windSpeed, 0), 0, 40);
    const waveHeight = clampNumber(finite(params.waveHeight, 0), 0, 20);
    const wavelength = clampNumber(finite(params.peakWavelength, 47), 4, 400);
    const rain = clamp01(finite(params.rain, 0));
    const submersion = clamp01(finite(params.submersion, 0));
    const hullSpeed = clampNumber(finite(params.hullSpeed, 0), 0, 40);

    // --- gusting ------------------------------------------------------------
    this.gustTimer -= step;
    if (this.gustTimer <= 0) {
      this.gustTimer = GUST_HOLD_MIN + GUST_HOLD_SPAN * this.gustRandom();
      this.gustTarget = 1 + GUST_DEPTH * (this.gustRandom() * 2 - 1);
    }
    // Framerate-independent approach, so a hitch does not jump the gust.
    this.gust += (this.gustTarget - this.gust) * (1 - Math.exp(-step / GUST_TAU));

    // --- swell --------------------------------------------------------------
    // Deep-water dispersion, the same relation the wake's crest spacing comes
    // from: a wave of length L has period sqrt(2*pi*L/g). The default 47 m sea
    // breathes at 5.5 s.
    const swellPeriod = Math.sqrt((TAU * wavelength) / GRAVITY);
    const groupPeriod = swellPeriod * GROUP_WAVES;
    const swellDepth =
      SWELL_DEPTH_CALM + SWELL_DEPTH_SPAN * clamp01(waveHeight / SWELL_FULL_HEIGHT);
    const swellNear = this.swellAt(swellDepth, swellPeriod, groupPeriod, 0);
    const swellFar = this.swellAt(swellDepth, swellPeriod, groupPeriod, SURF_FAR_PHASE);

    // --- surf ---------------------------------------------------------------
    const windDrive = Math.min(wind / SURF_REFERENCE_WIND, SURF_MAX_DRIVE);
    const seaLevel = SURF_LEVEL * (SURF_CALM + windDrive);
    const surfCutoff = clampNumber(
      SURF_CUTOFF_BASE + SURF_CUTOFF_PER_WIND * wind - SURF_CUTOFF_PER_HEIGHT * waveHeight,
      SURF_CUTOFF_MIN,
      SURF_CUTOFF_MAX,
    );
    this.surfNear.setLevel(seaLevel * swellNear, now, live);
    this.surfNear.setBand(surfCutoff, SURF_Q, now, live);
    this.surfFar.setLevel(seaLevel * SURF_FAR_LEVEL * swellFar, now, live);
    this.surfFar.setBand(surfCutoff * SURF_FAR_TILT, SURF_Q, now, live);

    // --- wind ---------------------------------------------------------------
    const windLoud = Math.pow(Math.min(wind / WIND_REFERENCE_WIND, WIND_MAX_DRIVE), WIND_EXPONENT);
    this.windBed.setLevel(WIND_LEVEL * windLoud * this.gust, now, live);
    this.windBed.setBand(
      clampNumber(WIND_BAND_BASE + WIND_BAND_PER_WIND * wind, WIND_BAND_MIN, WIND_BAND_MAX),
      WIND_Q,
      now,
      live,
    );

    const singing = smoothstepNumber(wind, RIGGING_ONSET, RIGGING_FULL);
    this.rigging.setLevel(RIGGING_LEVEL * windLoud * singing * this.gust, now, live);
    this.rigging.setBand(
      clampNumber((STROUHAL * wind) / RIGGING_DIAMETER, RIGGING_MIN_HZ, RIGGING_MAX_HZ),
      RIGGING_Q,
      now,
      live,
    );

    // --- rain ---------------------------------------------------------------
    // Rain gusts with the wind but less than the wind does: a squall arrives in
    // sheets, and the sheets are the same air movement.
    const rainGust = 0.85 + 0.15 * this.gust;
    this.rainBed.setLevel(RAIN_LEVEL * Math.pow(rain, RAIN_EXPONENT) * rainGust, now, live);
    this.rainBed.setBand(
      clampNumber(
        RAIN_CUTOFF_BASE - RAIN_CUTOFF_PER_RATE * rain,
        RAIN_CUTOFF_MIN,
        RAIN_CUTOFF_MAX,
      ),
      RAIN_Q,
      now,
      live,
    );
    this.rainBed.setHighpass(
      Math.max(RAIN_HIGHPASS_MIN, RAIN_HIGHPASS_BASE - RAIN_HIGHPASS_PER_RATE * rain),
      now,
      live,
    );
    this.rainHiss.setLevel(RAIN_HISS_LEVEL * Math.pow(rain, RAIN_HISS_EXPONENT), now, live);

    // --- hull ---------------------------------------------------------------
    const speedDrive = Math.min(hullSpeed / HULL_REFERENCE_SPEED, 1.3);
    this.hull.setLevel(
      HULL_LEVEL *
        Math.pow(speedDrive, HULL_EXPONENT) *
        smoothstepNumber(hullSpeed, HULL_ONSET, HULL_FULL),
      now,
      live,
    );
    this.hull.setBand(
      clampNumber(
        HULL_BAND_BASE + HULL_BAND_PER_SPEED * hullSpeed,
        HULL_BAND_MIN,
        HULL_BAND_MAX,
      ),
      HULL_Q,
      now,
      live,
    );

    // --- submersion ---------------------------------------------------------
    this.airGain.set(1 - AIR_DUCK * submersion, now, live);
    // Geometric, not linear. Cutoff is heard in octaves: a linear sweep from
    // 18 kHz spends nine tenths of its travel in a range the ear still calls
    // bright and then collapses over the last stretch, so the water arrives all
    // at once instead of closing over the lens.
    this.muffle.set(AIR_OPEN_HZ * Math.pow(AIR_CLOSED_HZ / AIR_OPEN_HZ, submersion), now, live);
    this.underGain.set(Math.pow(submersion, UNDER_EXPONENT), now, live);
    this.rumble.setLevel(
      RUMBLE_LEVEL * (RUMBLE_CALM + RUMBLE_PER_WIND * windDrive) * swellNear,
      now,
      live,
    );

    // --- bubbles ------------------------------------------------------------
    const bubbleRate =
      this.settings.bubbleRate * submersion * (BUBBLE_CALM + BUBBLE_PER_WIND * windDrive);
    if (live && bubbleRate > 0.001) {
      this.bubbleTimer -= step;
      // Spread across the frame rather than all landing on its first sample. Two
      // bubbles at the same instant are one louder bubble, not two.
      let offset = 0;
      while (this.bubbleTimer <= 0) {
        this.spawnBubble(
          now + offset,
          this.underBus,
          BUBBLE_LEVEL * (0.55 + 0.45 * this.bubbleRandom()),
        );
        offset += BUBBLE_MIN_GAP;
        // Poisson inter-arrival, floored: see BUBBLE_MIN_GAP.
        const u = this.bubbleRandom();
        this.bubbleTimer += Math.max(BUBBLE_MIN_GAP, -Math.log(1 - u) / bubbleRate);
      }
    } else if (this.bubbleTimer < 0) {
      this.bubbleTimer = 0;
    }
  }

  setVolume(value: number): void {
    this.volume = clamp01(finite(value, this.volume));
    this.applyMasterGain(VOLUME_RAMP);
  }

  getVolume(): number {
    return this.volume;
  }

  /**
   * Hard silence, without changing anything else.
   *
   * While muted no parameter is written at all — the model keeps running so
   * `resetClock` still means something, but the audio thread is left alone. That
   * makes a muted capture run cost nothing and, more importantly, removes any way
   * for audio scheduling to show up in a frame-time measurement.
   */
  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    this.applyMasterGain(MUTE_RAMP);
    const ctx = this.ctx;
    // Unmuting resumes writing, and the graph has been frozen wherever it was
    // when the mute landed.
    if (!muted && ctx !== null && ctx.state === 'running') this.flushAll(ctx.currentTime);
  }

  isMuted(): boolean {
    return this.muted;
  }

  /**
   * Turns the whole system off, and suspends the context once the fade is done —
   * so audio the viewer has switched off stops costing a thread, rather than
   * rendering eight noise beds into a gain of zero.
   */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.applyMasterGain(ENABLE_RAMP);

    const ctx = this.ctx;
    if (ctx === null) return;

    if (!enabled) {
      // Only meaningful while time is moving; an already-suspended context would
      // never reach the deadline.
      this.suspendAt = ctx.state === 'running' ? ctx.currentTime + SUSPEND_DELAY : null;
      return;
    }

    this.suspendAt = null;
    if (!this.gestured) return;
    void ctx
      .resume()
      .then(() => {
        if (this.disposed || this.ctx === null) return;
        const now = this.ctx.currentTime;
        this.startBeds(now);
        this.flushAll(now);
        this.applyMasterGain(ENABLE_RAMP);
      })
      .catch(() => {});
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Applies a quality tier. Never rebuilds the graph — layers are connected and
   * disconnected, so a tier change costs no allocation and makes no sound.
   */
  setQuality(tier: QualityTier): void {
    const settings = AUDIO_QUALITY_TIERS[tier];
    if (settings === undefined || this.tier === tier) return;
    this.tier = tier;
    this.settings = settings;
    this.applyQuality();
  }

  getQuality(): QualityTier {
    return this.tier;
  }

  /**
   * A splash, synthesised.
   *
   * @param intensity 0..1. Scales the level, how far the band sweeps, how long the
   *                  cavity takes to collapse, and how much air is entrained.
   */
  playSplash(intensity = 1): void {
    const ctx = this.ctx;
    if (ctx === null || !this.canPlay()) return;
    const amount = clamp01(finite(intensity, 0));
    if (amount < 0.02) return;
    if (!this.acquireVoice()) return;

    const random = this.oneShotRandom;
    const now = ctx.currentTime;
    const decay = SPLASH_DECAY_MIN + SPLASH_DECAY_SPAN * amount;
    const level = SPLASH_LEVEL * Math.pow(amount, 0.8);

    const source = ctx.createBufferSource();
    source.buffer = this.white;
    source.loop = true;
    source.playbackRate.value = 0.85 + 0.3 * random();

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 0.7;
    band.frequency.setValueAtTime(SPLASH_OPEN_HZ, now);
    band.frequency.exponentialRampToValueAtTime(SPLASH_CLOSE_HZ, now + decay);

    const crown = ctx.createGain();
    envelope(crown.gain, now, 0.003, level, decay);

    // The body: the cavity closing, lower and slower than the crown that made it.
    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.value = SPLASH_BODY_HZ;
    body.Q.value = 0.9;

    const thump = ctx.createGain();
    envelope(thump.gain, now, 0.01, level * SPLASH_BODY_LEVEL * amount, decay * 1.6);

    source.connect(band);
    band.connect(crown);
    crown.connect(this.airBus);
    source.connect(body);
    body.connect(thump);
    thump.connect(this.airBus);

    const tail = decay * 1.6 + 0.05;
    source.start(now, random() * this.white.duration);
    source.stop(now + tail);
    this.trackVoice(source, band, crown, body, thump);

    // Entrained air, surfacing behind the impact.
    const count = Math.round(1 + SPLASH_BUBBLES * amount);
    for (let i = 0; i < count; i++) {
      this.spawnBubble(
        now + 0.02 + random() * SPLASH_BUBBLE_WINDOW * (0.5 + amount),
        this.airBus,
        BUBBLE_LEVEL * (0.4 + 0.6 * amount),
      );
    }
  }

  /**
   * Thunder, synthesised as a crack and a roll whose balance is the distance.
   *
   * @param distanceKm   Distance to the strike, km. Distance does not merely
   *                     quieten it — see `THUNDER_ABSORPTION_KM`.
   * @param delaySeconds Delay before it is heard. Left at 0 by default so the
   *                     caller stays in control of its own timing; a caller
   *                     triggering off a lightning flash wants
   *                     `distanceKm / SPEED_OF_SOUND_KM_S`, which is ~2.9 s per km.
   */
  playThunder(distanceKm = 3, delaySeconds = 0): void {
    const ctx = this.ctx;
    if (ctx === null || !this.canPlay()) return;
    if (!this.acquireVoice()) return;

    const distance = clampNumber(finite(distanceKm, 3), 0.05, 40);
    const now = ctx.currentTime + Math.max(0, finite(delaySeconds, 0));

    // Everything above a kilohertz is absorbed out of a distant strike, so the
    // crack fades exponentially while the roll only spreads.
    const crackWeight = Math.exp(-distance / THUNDER_ABSORPTION_KM);
    const spread = 1 / (1 + distance * THUNDER_SPREAD_PER_KM);
    const rollSeconds = Math.min(
      THUNDER_ROLL_MAX_SECONDS,
      THUNDER_ROLL_MIN_SECONDS + THUNDER_ROLL_PER_KM * distance,
    );

    const source = ctx.createBufferSource();
    source.buffer = this.white;
    source.loop = true;
    // Under 1, so the noise is darker and the loop outlasts the longest roll.
    source.playbackRate.value = 0.7;

    const crackHigh = ctx.createBiquadFilter();
    crackHigh.type = 'highpass';
    crackHigh.frequency.value = THUNDER_CRACK_HIGHPASS;
    crackHigh.Q.value = 0.7;

    const crackLow = ctx.createBiquadFilter();
    crackLow.type = 'lowpass';
    crackLow.Q.value = 0.7;
    crackLow.frequency.value = Math.max(400, THUNDER_CRACK_HZ * crackWeight);

    // The curve carries the shape and the gain after it carries the level, since
    // `setValueCurveAtTime` writes absolute values and cannot be scaled.
    //
    // Nothing else is scheduled on these two parameters, deliberately: a curve
    // throws `NotSupportedError` if any other automation event falls inside its
    // window, and that includes the `setValueAtTime` that assigning `.value`
    // implies. What holds the path silent before `now` is the source not having
    // started, not the gain being zeroed.
    const crackEnv = ctx.createGain();
    crackEnv.gain.setValueCurveAtTime(this.crackCurve, now, THUNDER_CRACK_SECONDS);

    const crackLevel = ctx.createGain();
    crackLevel.gain.value = THUNDER_LEVEL * spread * crackWeight;

    const rollLow = ctx.createBiquadFilter();
    rollLow.type = 'lowpass';
    rollLow.frequency.value = THUNDER_ROLL_HZ;
    rollLow.Q.value = 1.2;

    const rollEnv = ctx.createGain();
    rollEnv.gain.setValueCurveAtTime(this.rollCurve, now, rollSeconds);

    const rollLevel = ctx.createGain();
    // A near strike is mostly crack; a far one is only roll.
    rollLevel.gain.value = THUNDER_LEVEL * spread * (0.35 + 0.65 * (1 - crackWeight));

    source.connect(crackHigh);
    crackHigh.connect(crackLow);
    crackLow.connect(crackEnv);
    crackEnv.connect(crackLevel);
    crackLevel.connect(this.airBus);

    source.connect(rollLow);
    rollLow.connect(rollEnv);
    rollEnv.connect(rollLevel);
    rollLevel.connect(this.airBus);

    source.start(now, this.oneShotRandom() * this.white.duration);
    source.stop(now + Math.max(THUNDER_CRACK_SECONDS, rollSeconds) + 0.1);
    this.trackVoice(
      source,
      crackHigh,
      crackLow,
      crackEnv,
      crackLevel,
      rollLow,
      rollEnv,
      rollLevel,
    );
  }

  /** UI feedback. Deliberately not routed through the underwater muffle. */
  playUiClick(): void {
    const ctx = this.ctx;
    if (ctx === null || !this.canPlay()) return;
    if (!this.acquireVoice()) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    // A falling pitch, because a click with a fixed pitch is a beep. The drop is
    // what makes it read as something being struck rather than something sounding.
    osc.frequency.setValueAtTime(UI_CLICK_HZ, now);
    osc.frequency.exponentialRampToValueAtTime(UI_CLICK_HZ * UI_CLICK_FALL, now + UI_CLICK_SECONDS);

    const gain = ctx.createGain();
    envelope(gain.gain, now, 0.0015, UI_CLICK_LEVEL, UI_CLICK_SECONDS);

    osc.connect(gain);
    gain.connect(this.uiBus);
    osc.start(now);
    osc.stop(now + UI_CLICK_SECONDS + 0.01);
    this.trackVoice(osc, gain);
  }

  /**
   * Rewinds every clock this system owns and silences anything still ringing.
   *
   * The audible output is not what a capture compares, but the *state* is: the
   * gust walk, the bubble scheduler and the swell phase all persist across a
   * session, so without this a deterministic run would inherit whatever the
   * previous shot left behind. Note that the swell modulator is a CPU-side phase
   * for exactly this reason — an `OscillatorNode`'s phase cannot be set, so a
   * hardware LFO would be a piece of state no reset could reach.
   */
  resetClock(time = 0): void {
    this.clock = ((time % CLOCK_WRAP) + CLOCK_WRAP) % CLOCK_WRAP;
    this.bubbleRandom = mulberry32(AUDIO_SEEDS.bubbles);
    this.gustRandom = mulberry32(AUDIO_SEEDS.gusts);
    this.oneShotRandom = mulberry32(AUDIO_SEEDS.oneShots);
    this.gust = 1;
    this.gustTarget = 1;
    this.gustTimer = 0;
    this.bubbleTimer = 0;
    this.stopVoices();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const ctx = this.ctx;
    this.ctx = null;
    if (ctx === null) return;

    this.stopVoices();
    for (const bed of this.beds) bed.dispose();
    this.beds.length = 0;
    this.targets.length = 0;

    this.airBus.disconnect();
    this.airMuffle.disconnect();
    this.underBus.disconnect();
    this.uiBus.disconnect();
    this.mix.disconnect();
    this.master.disconnect();
    this.compressor.disconnect();

    void ctx.close().catch(() => {});
  }

  // ------------------------------------------------------------------ internals

  private build(ctx: AudioContext): void {
    this.white = createNoiseBuffer(ctx, 'white', AUDIO_SEEDS.white);
    const brown = createNoiseBuffer(ctx, 'brown', AUDIO_SEEDS.brown);

    const shape = mulberry32(AUDIO_SEEDS.thunderShape);
    // Two shapes, not one: a crack and a roll are different envelopes, and a
    // parameter cannot cross-fade between two curves. They are separate paths,
    // weighted by distance.
    this.crackCurve = buildThunderCurve(CURVE_POINTS, shape, 7, 0.015, 2, 0.35);
    this.rollCurve = buildThunderCurve(CURVE_POINTS, shape, 2.2, 0.08, 4, 0.55);

    this.master = ctx.createGain();
    // Pinned at zero until a gesture. Belt and braces against the suspend in the
    // constructor: a platform that ignores both still makes no sound.
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    // The compressor sits *before* the master, so the volume control is a clean
    // output trim. Behind it, turning the volume down would also reduce what the
    // compressor sees, so quiet playback would be less compressed than loud
    // playback — a volume slider that changes the mix as well as the level.
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = COMPRESSOR_THRESHOLD_DB;
    this.compressor.knee.value = COMPRESSOR_KNEE_DB;
    this.compressor.ratio.value = COMPRESSOR_RATIO;
    this.compressor.attack.value = COMPRESSOR_ATTACK;
    this.compressor.release.value = COMPRESSOR_RELEASE;
    this.compressor.connect(this.master);

    this.mix = ctx.createGain();
    this.mix.connect(this.compressor);

    // Past the compressor as well as past the muffle: an interface sound should
    // be the same every time it is heard, and routing it through the world bus
    // would have a thunderclap duck it.
    this.uiBus = ctx.createGain();
    this.uiBus.connect(this.master);

    this.airMuffle = ctx.createBiquadFilter();
    this.airMuffle.type = 'lowpass';
    this.airMuffle.frequency.value = AIR_OPEN_HZ;
    this.airMuffle.Q.value = 0.7;
    this.airMuffle.connect(this.mix);

    this.airBus = ctx.createGain();
    this.airBus.gain.value = 1;
    this.airBus.connect(this.airMuffle);

    this.underBus = ctx.createGain();
    this.underBus.gain.value = 0;
    this.underBus.connect(this.mix);

    const nyquist = ctx.sampleRate * 0.45;
    this.airGain = new ParamTarget(this.airBus.gain, 1, 0.2, 0.004, 0, 1);
    this.muffle = new ParamTarget(
      this.airMuffle.frequency,
      AIR_OPEN_HZ,
      // Fast, because the waterline is crossed by a crest in a fraction of a
      // second and a lazy cutoff turns that into a slow wash rather than a duck.
      0.08,
      4,
      20,
      nyquist,
    );
    this.underGain = new ParamTarget(this.underBus.gain, 0, 0.12, 0.004, 0, 1);
    this.targets.push(this.airGain, this.muffle, this.underGain);

    // Offsets spread across the buffer so no two beds read the same sample of it.
    const spacing = NOISE_SECONDS / 8;

    this.surfNear = this.addBed(ctx, {
      buffer: this.white,
      destination: this.airBus,
      filter: 'lowpass',
      frequency: SURF_CUTOFF_BASE,
      q: SURF_Q,
      highpass: 60,
      playbackRate: BED_RATES.surfNear,
      offset: spacing * 0,
      pan: -SURF_PAN,
      // Slow: the sea's level is the swell, and a short time constant would make
      // the modulation a tremolo instead of a surge.
      gainTau: 0.35,
    });
    this.surfFar = this.addBed(ctx, {
      buffer: this.white,
      destination: this.airBus,
      filter: 'lowpass',
      frequency: SURF_CUTOFF_BASE * SURF_FAR_TILT,
      q: SURF_Q,
      highpass: 60,
      playbackRate: BED_RATES.surfFar,
      offset: spacing * 1,
      pan: SURF_PAN,
      gainTau: 0.35,
    });
    this.windBed = this.addBed(ctx, {
      buffer: this.white,
      destination: this.airBus,
      filter: 'bandpass',
      frequency: WIND_BAND_BASE,
      q: WIND_Q,
      highpass: WIND_HIGHPASS,
      playbackRate: BED_RATES.wind,
      offset: spacing * 2,
      pan: 0,
      gainTau: 0.2,
    });
    this.rigging = this.addBed(ctx, {
      buffer: this.white,
      destination: this.airBus,
      filter: 'bandpass',
      frequency: 500,
      q: RIGGING_Q,
      highpass: 100,
      playbackRate: BED_RATES.rigging,
      offset: spacing * 3,
      pan: -0.2,
      gainTau: 0.3,
    });
    this.rainBed = this.addBed(ctx, {
      buffer: this.white,
      destination: this.airBus,
      filter: 'lowpass',
      frequency: RAIN_CUTOFF_BASE,
      q: RAIN_Q,
      highpass: RAIN_HIGHPASS_BASE,
      playbackRate: BED_RATES.rain,
      offset: spacing * 4,
      pan: RAIN_PAN,
      gainTau: 0.25,
    });
    this.rainHiss = this.addBed(ctx, {
      buffer: this.white,
      destination: this.airBus,
      filter: 'highpass',
      frequency: RAIN_HISS_HZ,
      q: 0.6,
      highpass: RAIN_HISS_HZ,
      playbackRate: BED_RATES.rainHiss,
      offset: spacing * 5,
      pan: -RAIN_PAN,
      gainTau: 0.25,
    });
    this.hull = this.addBed(ctx, {
      buffer: this.white,
      destination: this.airBus,
      filter: 'bandpass',
      frequency: HULL_BAND_BASE,
      q: HULL_Q,
      highpass: HULL_HIGHPASS,
      playbackRate: BED_RATES.hull,
      offset: spacing * 6,
      pan: 0,
      gainTau: 0.18,
    });
    this.rumble = this.addBed(ctx, {
      // Brown, not white: what is left after a hundred metres of water is the
      // bottom of the spectrum, and a low-passed white bed to match would need a
      // filter steep enough to ring.
      buffer: brown,
      destination: this.underBus,
      filter: 'lowpass',
      frequency: RUMBLE_HZ,
      q: RUMBLE_Q,
      highpass: RUMBLE_HIGHPASS,
      playbackRate: BED_RATES.rumble,
      offset: spacing * 7,
      pan: 0,
      gainTau: 0.4,
    });

    this.applyQuality();
  }

  private addBed(ctx: AudioContext, options: NoiseBedOptions): NoiseBed {
    const bed = new NoiseBed(ctx, options);
    this.beds.push(bed);
    for (const target of bed.targets) this.targets.push(target);
    return bed;
  }

  private applyQuality(): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const now = ctx.currentTime;
    const live = this.enabled && !this.muted && ctx.state === 'running';
    const settings = this.settings;

    this.surfFar.setActive(settings.stereoSurf, now, live);
    // With only one surf bed the sea has to come from the middle, or the whole
    // ocean is off to port.
    this.surfNear.setPan(settings.stereoSurf ? -SURF_PAN : 0, now, live);
    this.rigging.setActive(settings.rigging, now, live);
    this.rainHiss.setActive(settings.rainHiss, now, live);
  }

  private swellAt(depth: number, period: number, groupPeriod: number, phase: number): number {
    const wave = Math.sin((TAU * this.clock) / period + phase);
    const group = Math.sin((TAU * this.clock) / groupPeriod + phase + GROUP_PHASE);
    return 1 + depth * (0.62 * wave + 0.38 * group);
  }

  private applyMasterGain(rampSeconds: number): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const now = ctx.currentTime;
    // `gestured` is in the target, not just in `resume`: until the viewer has
    // asked for audio, nothing this class can be told to do makes a sound.
    const target = this.enabled && !this.muted && this.gestured ? this.volume : 0;
    const param = this.master.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    if (rampSeconds > 0) param.linearRampToValueAtTime(target, now + rampSeconds);
    else param.setValueAtTime(target, now);
  }

  private flushAll(now: number): void {
    for (const target of this.targets) target.flush(now);
  }

  /**
   * Starts the noise sources, on the first resume rather than at construction.
   *
   * See the note in `NoiseBed`: a source started on a locked context is an
   * autoplay warning in the console per source, and eight of those before the
   * viewer has touched anything is a false alarm the next person to read that
   * console has to work out for themselves.
   */
  private startBeds(now: number): void {
    for (const bed of this.beds) bed.start(now);
  }

  /** Whether a one-shot should be built at all. */
  private canPlay(): boolean {
    const ctx = this.ctx;
    return (
      !this.disposed && ctx !== null && this.enabled && !this.muted && ctx.state === 'running'
    );
  }

  private acquireVoice(): boolean {
    return this.voices.length < this.settings.voices;
  }

  /**
   * Registers a one-shot's nodes for cleanup.
   *
   * Without this every splash leaves its chain hanging off the bus: still
   * connected, still summed, and — because the source is stopped but not
   * disconnected — never collected. A busy sea would accumulate them until the
   * audio thread ran out of budget.
   */
  private trackVoice(source: AudioScheduledSourceNode, ...nodes: AudioNode[]): void {
    this.voices.push(source);
    source.onended = () => {
      source.disconnect();
      for (const node of nodes) node.disconnect();
      const index = this.voices.indexOf(source);
      if (index >= 0) this.voices.splice(index, 1);
    };
  }

  private stopVoices(): void {
    // Backwards: `onended` splices from this array, and although it is queued as a
    // task rather than fired synchronously, iterating forwards over a list that
    // something else shortens is a bug waiting for a scheduler change.
    for (let i = this.voices.length - 1; i >= 0; i--) {
      try {
        this.voices[i].stop();
      } catch {
        // Already stopped.
      }
    }
  }

  private spawnBubble(when: number, destination: AudioNode, level: number): void {
    const ctx = this.ctx;
    if (ctx === null || !this.acquireVoice()) return;

    const random = this.bubbleRandom;
    const radius = BUBBLE_MIN_RADIUS + (BUBBLE_MAX_RADIUS - BUBBLE_MIN_RADIUS) * random();
    const frequency = MINNAERT_CONSTANT / radius;
    const decay = BUBBLE_DECAY_MIN + BUBBLE_DECAY_SPAN * random();

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, when);
    osc.frequency.exponentialRampToValueAtTime(frequency * BUBBLE_RISE, when + decay);

    const gain = ctx.createGain();
    envelope(gain.gain, when, 0.002, level, decay);

    osc.connect(gain);
    gain.connect(destination);
    osc.start(when);
    osc.stop(when + decay + 0.02);
    this.trackVoice(osc, gain);
  }
}

// ---------------------------------------------------------------------------

/**
 * Attack-and-decay on a gain parameter.
 *
 * The decay is exponential and stops at a small non-zero value rather than at 0,
 * because `exponentialRampToValueAtTime` cannot reach zero — it throws on a target
 * of 0, and a linear tail in its place is audible as the decay changing character
 * right at the end. -80 dB is inaudible and the node is stopped immediately after.
 */
function envelope(
  param: AudioParam,
  start: number,
  attack: number,
  peak: number,
  decay: number,
): void {
  // An exponential ramp is also undefined from a starting value of zero, which is
  // what a zero peak would leave on the parameter after the attack.
  const level = Math.max(1e-4, peak);
  param.setValueAtTime(0, start);
  param.linearRampToValueAtTime(level, start + attack);
  param.exponentialRampToValueAtTime(level * 1e-4, start + attack + decay);
}

/**
 * A decaying envelope with a few slow bumps in it, normalised to peak at 1.
 *
 * Thunder is not one impulse. The channel is kilometres long and tortuous, so its
 * sections arrive at different times and from different directions — which is why
 * thunder rolls rather than bangs, and why a single exponential decay sounds like
 * a gunshot in a stairwell. The bumps are a handful of sinusoids at seeded,
 * mutually irrational rates: enough structure to read as a roll, slow enough that
 * they never turn into a tremolo.
 */
function buildThunderCurve(
  points: number,
  random: () => number,
  decayRate: number,
  attack: number,
  bumps: number,
  depth: number,
): Float32Array {
  const rates = new Float64Array(bumps);
  const phases = new Float64Array(bumps);
  for (let b = 0; b < bumps; b++) {
    rates[b] = 0.7 + 3.2 * random();
    phases[b] = TAU * random();
  }

  const curve = new Float32Array(points);
  let peak = 0;
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    let wobble = 0;
    for (let b = 0; b < bumps; b++) wobble += Math.sin(TAU * rates[b] * t + phases[b]);
    const shaped = Math.max(0, 1 + (depth * wobble) / bumps);
    const value = Math.min(1, t / attack) * Math.exp(-t * decayRate) * shaped;
    curve[i] = value;
    if (value > peak) peak = value;
  }

  const scale = peak > 1e-6 ? 1 / peak : 0;
  for (let i = 0; i < points; i++) curve[i] *= scale;
  // The curve holds its last value after it finishes, so it has to end at silence.
  curve[points - 1] = 0;
  return curve;
}

function resolveAudioContext(): AudioContextConstructor | null {
  if (typeof window === 'undefined') return null;
  // Through `unknown`: `webkitAudioContext` is not on the `Window` lib type at
  // all, and intersecting an optional override onto a required member of it
  // produces a property type that is not what either half says.
  const scope = window as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

function finite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function clampNumber(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return clampNumber(v, 0, 1);
}

function smoothstepNumber(x: number, edge0: number, edge1: number): number {
  const t = clampNumber((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
