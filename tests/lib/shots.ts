import type { Thresholds } from './compare';

/**
 * The canonical shot list.
 *
 * These are data, not code, on purpose: the visual harness, any future
 * before/after review loop, and the screenshots in the README should all be
 * framing the same seven views of this world, and the only way that stays true
 * is if there is exactly one place the framing lives.
 *
 * Every shot spells out **all** of the state it depends on, including values it
 * shares with the app defaults. `setState` mutates persistent app state, so a
 * shot that omitted `windSpeed` would inherit whatever the previous shot set and
 * would render differently depending on test ordering — which is the opposite of
 * what a baseline is for.
 */

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra' | 'max';

export type PresetId =
  | 'skyPro'
  | 'arctic'
  | 'blackFlag'
  | 'dusk'
  | 'foggy'
  | 'moonlit'
  | 'seaOfThieves'
  | 'storm'
  | 'sunset';

export type CameraMode = 'orbit' | 'fly' | 'boat';

export type Vec3 = readonly [number, number, number];

export interface ShotState {
  quality: QualityTier;
  cameraMode: CameraMode;
  windSpeed: number;
  peakWavelength: number;
  cloudCoverage: number;
  preset: PresetId;
}

export interface Shot {
  id: string;
  title: string;
  /** What this shot exists to catch a regression in. */
  purpose: string;
  state: ShotState;
  /**
   * Exact camera pin, or `null` when the camera mode owns the pose (chase).
   *
   * Pinned before the settle run, not after: the underwater pass, the fog and
   * the particle system all derive their parameters from the camera during
   * `update()`, so a camera moved after the world settled would be photographed
   * with another camera's atmosphere.
   */
  camera: { position: Vec3; target: Vec3 } | null;
  /** Simulation time, in seconds, that the world is rewound to. */
  time: number;
  /** Steps of 1/60 s used to settle buoyancy, foam and the chase rig. */
  settleSteps: number;
}

/**
 * Capture resolution, and the viewport the visual project runs at.
 *
 * 1280x720 rather than the 1600x900 the performance budget is quoted at. The
 * comparison is per-pixel and full-resolution either way; the only thing the
 * larger frame would buy is 44% more bytes in every checked-in baseline, and
 * the defects these shots exist to catch are not one-pixel defects.
 */
export const SHOT_VIEWPORT = { width: 1280, height: 720 } as const;

export const SHOTS: readonly Shot[] = [
  {
    id: 'clear-day-wide',
    title: 'Clear day, wide',
    purpose:
      'The reference image. Horizon integration, sun glitter, cloud lighting, ' +
      'aerial perspective and the ship at a distance where its silhouette and ' +
      'its reflection both matter.',
    state: {
      quality: 'high',
      cameraMode: 'orbit',
      windSpeed: 15,
      peakWavelength: 47,
      cloudCoverage: 0.32,
      preset: 'skyPro',
    },
    // Looking roughly up-sun (skyPro's sun is toward +X/-Z) so the glitter track
    // runs through the frame instead of behind the camera.
    camera: { position: [-42, 21, 63], target: [0, 3, 0] },
    time: 12,
    settleSteps: 90,
  },
  {
    id: 'near-water-detail',
    title: 'Near-water detail',
    purpose:
      'Wave shape, normal detail, foam on breaking crests and the transition ' +
      'from resolved geometry to normal-mapped detail. This is where tiling, ' +
      'shimmer and over-bright specular show up first.',
    state: {
      quality: 'high',
      cameraMode: 'orbit',
      windSpeed: 15,
      peakWavelength: 47,
      cloudCoverage: 0.32,
      preset: 'skyPro',
    },
    // Away from the ship, cross-lit rather than up-sun, so the frame is water
    // and only water: this shot must fail for wave reasons, not hull reasons.
    camera: { position: [-46, 5, 44], target: [-64, 0, 26] },
    time: 23.5,
    settleSteps: 90,
  },
  {
    id: 'sunset',
    title: 'Sunset',
    purpose:
      'Low sun through a swell: the specular track, the warm-to-cool gradient ' +
      'across the water, and whether the tone mapping still holds highlight ' +
      'detail where the sun meets the horizon.',
    state: {
      quality: 'high',
      cameraMode: 'orbit',
      windSpeed: 6,
      peakWavelength: 24,
      cloudCoverage: 0.45,
      preset: 'sunset',
    },
    // The sunset sun sits almost due -X, so the camera looks straight down it.
    camera: { position: [58, 7, 9], target: [0, 4, 0] },
    time: 31.25,
    settleSteps: 90,
  },
  {
    id: 'storm',
    title: 'Storm',
    purpose:
      'Heavy sea state, rain, dense cloud and low contrast. Catches wave ' +
      'clipping at high amplitude, foam coverage running away, and rain that ' +
      'stops tracking the camera correctly.',
    state: {
      quality: 'high',
      cameraMode: 'orbit',
      windSpeed: 21,
      peakWavelength: 60,
      cloudCoverage: 0.95,
      preset: 'storm',
    },
    camera: { position: [34, 15, 54], target: [0, 4, 0] },
    time: 41,
    settleSteps: 90,
  },
  {
    id: 'boat-chase',
    title: 'Boat, chase camera',
    purpose:
      'The chase rig framing and the hull in wave contact: buoyancy pose, ' +
      'contact shadow, hull material response and the wake footprint.',
    state: {
      // `boat`, and this is load-bearing. `snapToTarget()` returns immediately
      // unless the director is actually in chase mode, so with `orbit` here the
      // shot never entered the chase rig at all: it photographed whatever camera
      // the previous shot happened to leave behind, and was stable only because
      // the suite runs in a fixed order. That is precisely the ordering
      // dependence the note at the top of this file exists to rule out.
      quality: 'high',
      cameraMode: 'boat',
      windSpeed: 13,
      peakWavelength: 40,
      cloudCoverage: 0.4,
      preset: 'seaOfThieves',
    },
    /**
     * `null` because the chase rig derives the pose from the hull; the harness
     * calls `director.snapToTarget()` after the settle so the pose is exact
     * rather than however far the damping happened to converge.
     *
     * The spec asks for this shot "while moving". There is no ship controller
     * yet — Boat mode is a chase camera and W/S/A/D are not implemented — so
     * what this captures today is the chase framing of a hull that is only
     * bobbing on the swell. When the controller lands, this shot needs a ship
     * input (throttle/rudder) applied before the settle and a longer settle so
     * the hull is under way with a developed wake; nothing else about it
     * changes, and the baseline is expected to be regenerated at that point.
     */
    camera: null,
    time: 55.5,
    settleSteps: 90,
  },
  {
    id: 'waterline',
    title: 'Waterline, grazing',
    purpose:
      'The camera low enough that crests pass through its height: silhouette ' +
      'of the near surface against the sky, and the horizon where the two meet.',
    state: {
      quality: 'high',
      cameraMode: 'orbit',
      // Calm on purpose. The director pushes the camera out of a 0.35 m band
      // around the surface to stop the underwater state flickering, so a shot
      // this low is only reproducible if the crests near the camera cannot
      // reach it. At 5 m/s they stay under a metre.
      windSpeed: 5,
      peakWavelength: 22,
      cloudCoverage: 0.3,
      preset: 'skyPro',
    },
    // Low, pointed away from the ship and up-sun, so the specular track runs
    // along the surface and out to the horizon.
    camera: { position: [34, 1.6, -30], target: [52, 1.4, -48] },
    time: 63.75,
    settleSteps: 90,
  },
  {
    id: 'underwater',
    title: 'Underwater',
    purpose:
      'Submerged look: extinction with depth, god rays, particulate, caustics ' +
      'on what is below, and the underside of the surface.',
    state: {
      quality: 'high',
      cameraMode: 'orbit',
      windSpeed: 10,
      peakWavelength: 36,
      cloudCoverage: 0.32,
      preset: 'skyPro',
    },
    // Well clear of the 0.35 m surface band, angled up so the surface underside
    // and the Snell window are both in frame.
    camera: { position: [-16, -7, 16], target: [-6, 2, 2] },
    time: 72.5,
    settleSteps: 90,
  },
] as const;

// --------------------------------------------------------------- noise floor

export interface NoiseFloor {
  meanDeltaE: number;
  p95DeltaE: number;
  fractionAbove: number;
}

/**
 * The worst pairwise score over ten pairs, from five complete re-applications of
 * each shot, on this project's reference stack.
 *
 * This is not a fudge factor and it is not a guess. It is the cost of the fact
 * that a rendered frame is not perfectly reproducible: what moves between two
 * identical runs is specular sparkle on wave crests, where a difference far below
 * display precision in the wave field decides which facets catch the sun. A
 * regression smaller than these numbers cannot be detected, which is why they are
 * recorded rather than absorbed into a round tolerance.
 *
 * They are small — mean ΔE under 0.04 everywhere, with over 95% of pixels
 * bit-identical on every shot — but that is a property of the current renderer
 * and of the warm-up protocol in `applyShot`, not a guarantee. A future effect
 * with a genuinely stochastic or temporally-accumulated component will raise
 * them, and the correct response is to re-measure, not to widen the gate.
 *
 * Regenerate with `MEASURE_NOISE=1 npx playwright test --project=visual`; the
 * measurement writes `test-results/visual/noise-floor.json` and prints a block
 * ready to paste here. `docs/VERIFICATION.md` records the values, the stack they
 * came from, and how sensitive the resulting gate is to a real change.
 */
export const MEASURED_NOISE_FLOOR: Readonly<Record<string, NoiseFloor>> = {
  'clear-day-wide': { meanDeltaE: 0.0216, p95DeltaE: 0.0, fractionAbove: 0.00181 },
  'near-water-detail': { meanDeltaE: 0.0155, p95DeltaE: 0.0, fractionAbove: 0.00133 },
  sunset: { meanDeltaE: 0.0146, p95DeltaE: 0.0, fractionAbove: 0.00078 },
  storm: { meanDeltaE: 0.0387, p95DeltaE: 0.0, fractionAbove: 0.00256 },
  'boat-chase': { meanDeltaE: 0.0318, p95DeltaE: 0.0, fractionAbove: 0.00324 },
  waterline: { meanDeltaE: 0.0, p95DeltaE: 0.0, fractionAbove: 0.0 },
  underwater: { meanDeltaE: 0.005, p95DeltaE: 0.0, fractionAbove: 0.00019 },
};

/**
 * How far above the measured noise a shot has to drift before it fails.
 *
 * 2x, plus a small absolute term. The multiplier covers the noise floor itself
 * being an estimate from ten sample pairs rather than a distribution; the
 * additive term is what keeps the gate meaningful on the shots that are almost
 * perfectly reproducible, where 2x of nearly nothing is still nearly nothing and
 * an honest rounding difference would fail the build.
 */
const NOISE_MULTIPLIER = 2;
const ABSOLUTE_FLOOR: NoiseFloor = {
  meanDeltaE: 0.1,
  p95DeltaE: 0.4,
  fractionAbove: 0.0015,
};

export function thresholdsFor(shotId: string): Thresholds {
  const noise = MEASURED_NOISE_FLOOR[shotId];
  if (!noise) throw new Error(`no measured noise floor for shot "${shotId}"`);
  return {
    meanDeltaE: noise.meanDeltaE * NOISE_MULTIPLIER + ABSOLUTE_FLOOR.meanDeltaE,
    p95DeltaE: noise.p95DeltaE * NOISE_MULTIPLIER + ABSOLUTE_FLOOR.p95DeltaE,
    fractionAbove: noise.fractionAbove * NOISE_MULTIPLIER + ABSOLUTE_FLOOR.fractionAbove,
  };
}
