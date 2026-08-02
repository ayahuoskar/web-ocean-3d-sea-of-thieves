import { ParamTarget } from './ParamTarget';

/**
 * One continuous noise layer: a looping source, a high-pass, a shaping filter, a
 * gain and an optional pan.
 *
 * Surf, wind, rigging, rain, rain hiss, hull rush and the underwater rumble are
 * all this same chain with different filter settings and different numbers
 * driving them. That is not a coincidence or an economy — a broadband natural
 * sound *is* a noise source with a moving band, and the thing that distinguishes
 * wind from surf to the ear is almost entirely where that band sits and how it
 * moves.
 *
 * **Why the high-pass is a separate stage.** The shaping filter has to be free to
 * open right up — surf at 25 m/s runs to a couple of kilohertz — and a single
 * band-pass wide enough for that also passes everything underneath it. Sub-60 Hz
 * content in the air layers is not audible on the devices this runs on, but it is
 * very much present in the signal, and it eats the compressor's headroom on
 * behalf of sound nobody hears. The fixed high-pass removes it once, ahead of
 * everything.
 *
 * **Switching off means disconnecting, not muting.** A layer turned off by the
 * quality tier has to stop costing something, and a gain of zero costs exactly as
 * much as a gain of one — the audio thread still runs the source and both filters.
 * Disconnecting the tail makes the whole chain unreachable from the destination,
 * and an unreachable node is not rendered. The disconnect is deferred by
 * `DEACTIVATE_SECONDS` so the gain ramp finishes first; a disconnect mid-ramp is
 * a click, and a tier change is meant to be inaudible.
 *
 * The source is started once and never stopped, because an `AudioBufferSourceNode`
 * cannot be restarted — a stopped one is dead and would have to be replaced, which
 * is an allocation on a path that can be hit by the adaptive quality manager.
 * Reconnecting resumes at wherever the shared clock says the loop has got to,
 * which for noise is indistinguishable from having never stopped.
 *
 * That one start is deliberately *not* in the constructor. Starting a source on a
 * context that has not been unlocked makes Chrome log an autoplay warning per
 * source, so building the graph up front would put eight warnings in the console
 * of every session before the viewer has done anything — indistinguishable, to
 * anyone reading that console, from a real problem. `start` is idempotent and the
 * system calls it on the first resume.
 */

/** Delay between a layer's gain reaching zero and its chain being unhooked. */
const DEACTIVATE_SECONDS = 0.4;

export interface NoiseBedOptions {
  /** Shared looping noise. Not owned — several beds read the same buffer. */
  buffer: AudioBuffer;
  /** Bus this layer feeds. */
  destination: AudioNode;
  /** Shape of the moving filter. */
  filter: BiquadFilterType;
  frequency: number;
  q: number;
  /** Corner of the fixed high-pass ahead of the band. */
  highpass: number;
  /**
   * Rate this bed reads the shared buffer at. Distinct per bed, and mutually
   * irrational where it can be arranged, so no two layers repeat in step.
   */
  playbackRate: number;
  /** Seconds into the shared buffer this bed starts, for the same reason. */
  offset: number;
  pan: number;
  /** Time constant for level moves. Longer for beds that should swell. */
  gainTau?: number;
  /** Time constant for filter moves. */
  filterTau?: number;
}

export class NoiseBed {
  private readonly source: AudioBufferSourceNode;
  private readonly highpassNode: BiquadFilterNode;
  private readonly bandNode: BiquadFilterNode;
  private readonly gainNode: GainNode;
  private readonly panNode: StereoPannerNode | null;
  /** Last node in the chain — the one connected to (and cut from) the bus. */
  private readonly tail: AudioNode;
  private readonly destination: AudioNode;

  private readonly level: ParamTarget;
  private readonly frequency: ParamTarget;
  private readonly resonance: ParamTarget;
  private readonly highpassFrequency: ParamTarget;
  private readonly pan: ParamTarget | null;

  /** Every target this bed owns, so the system can flush them all at once. */
  readonly targets: ParamTarget[];

  /** Seconds into the shared buffer this bed starts. See `start`. */
  private readonly startOffset: number;

  private active = true;
  private started = false;
  private disconnectAt: number | null = null;
  private disposed = false;

  constructor(ctx: BaseAudioContext, options: NoiseBedOptions) {
    // Ceiling on any filter corner: nine tenths of Nyquist, not Nyquist. A
    // biquad's bilinear-transform coefficients degenerate as the corner
    // approaches half the sample rate, and a resonant filter parked there is not
    // quiet — it is unstable, which is a burst of noise rather than the silence
    // the caller was reaching for.
    const maxFrequency = ctx.sampleRate * 0.45;

    this.destination = options.destination;

    this.source = ctx.createBufferSource();
    this.source.buffer = options.buffer;
    this.source.loop = true;
    this.source.playbackRate.value = options.playbackRate;

    this.highpassNode = ctx.createBiquadFilter();
    this.highpassNode.type = 'highpass';
    this.highpassNode.Q.value = 0.7;

    this.bandNode = ctx.createBiquadFilter();
    this.bandNode.type = options.filter;

    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = 0;

    this.source.connect(this.highpassNode);
    this.highpassNode.connect(this.bandNode);
    this.bandNode.connect(this.gainNode);

    // `createStereoPanner` is universal on the browsers this project targets, but
    // it is the one node here that is not, and a missing panner should cost the
    // layer its width and nothing else.
    const factory = (ctx as BaseAudioContext & { createStereoPanner?: () => StereoPannerNode })
      .createStereoPanner;
    if (typeof factory === 'function') {
      this.panNode = ctx.createStereoPanner();
      this.gainNode.connect(this.panNode);
      this.tail = this.panNode;
    } else {
      this.panNode = null;
      this.tail = this.gainNode;
    }
    this.tail.connect(this.destination);

    const gainTau = options.gainTau ?? 0.15;
    const filterTau = options.filterTau ?? 0.25;

    this.level = new ParamTarget(this.gainNode.gain, 0, gainTau, 0.002, 0, 4);
    this.frequency = new ParamTarget(
      this.bandNode.frequency,
      options.frequency,
      filterTau,
      3,
      20,
      maxFrequency,
    );
    this.resonance = new ParamTarget(this.bandNode.Q, options.q, filterTau, 0.02, 0.05, 24);
    this.highpassFrequency = new ParamTarget(
      this.highpassNode.frequency,
      options.highpass,
      filterTau,
      3,
      20,
      maxFrequency,
    );
    this.pan =
      this.panNode === null
        ? null
        : new ParamTarget(this.panNode.pan, options.pan, 0.3, 0.01, -1, 1);

    this.targets = [this.level, this.frequency, this.resonance, this.highpassFrequency];
    if (this.pan !== null) this.targets.push(this.pan);

    // Offset into the shared buffer, so beds reading the same noise are not
    // reading the same *sample* of it. Taken modulo the duration here rather than
    // at `start`: an offset past the end of the buffer is a range error, not a
    // wrap.
    const duration = options.buffer.duration;
    this.startOffset = duration > 0 ? options.offset % duration : 0;
  }

  /** Begins playback. Idempotent — a second call is a no-op, not an exception. */
  start(when: number): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.source.start(when, this.startOffset);
  }

  /**
   * Level, before the tier gate. An inactive bed pins itself to silence rather
   * than trusting the caller to stop asking for a level.
   */
  setLevel(value: number, now: number, live: boolean): void {
    this.level.set(this.active ? value : 0, now, live);
  }

  setBand(frequency: number, q: number, now: number, live: boolean): void {
    this.frequency.set(frequency, now, live);
    this.resonance.set(q, now, live);
  }

  setHighpass(frequency: number, now: number, live: boolean): void {
    this.highpassFrequency.set(frequency, now, live);
  }

  setPan(value: number, now: number, live: boolean): void {
    this.pan?.set(value, now, live);
  }

  /** Tier gate. See the note on disconnecting rather than muting. */
  setActive(active: boolean, now: number, live: boolean): void {
    if (this.disposed || active === this.active) return;
    this.active = active;

    if (active) {
      // A pending disconnect means the chain is still hooked up and only the
      // timer needs cancelling.
      if (this.disconnectAt !== null) this.disconnectAt = null;
      else this.tail.connect(this.destination);
      this.level.silence(now);
      return;
    }

    if (live) {
      this.level.set(0, now, true);
      this.disconnectAt = now + DEACTIVATE_SECONDS;
    } else {
      // Nothing is audible, so there is no ramp to protect and no clock to wait
      // on — a suspended context would never reach the deadline anyway.
      this.level.silence(now);
      this.disconnectAt = null;
      this.tail.disconnect();
    }
  }

  /** Retires a deferred disconnect. Called every frame; almost always a compare. */
  tick(now: number): void {
    if (this.disconnectAt === null || now < this.disconnectAt) return;
    this.disconnectAt = null;
    this.tail.disconnect();
  }

  flush(now: number): void {
    for (const target of this.targets) target.flush(now);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.started) {
      try {
        this.source.stop();
      } catch {
        // Already stopped, or the context died first.
      }
    }
    this.source.disconnect();
    this.highpassNode.disconnect();
    this.bandNode.disconnect();
    this.gainNode.disconnect();
    this.panNode?.disconnect();
  }
}
