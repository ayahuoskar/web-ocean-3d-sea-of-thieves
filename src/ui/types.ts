/**
 * State contract shared between the UI layer and the application shell.
 *
 * This module is deliberately dependency-free: nothing in `src/ui` imports
 * three.js, so the whole control layer can be mounted and tested standalone.
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

export type CameraMode = 'orbit' | 'fly' | 'boat' | 'cinematic';

export interface UiState {
  quality: QualityTier;
  preset: PresetId;
  /** Wind speed at 10 m reference height, m/s. Range 0.5..25. */
  windSpeed: number;
  /** JONSWAP peak wavelength in metres. Range 10..150. */
  peakWavelength: number;
  /** Volumetric cloud layer coverage, 0..1. */
  cloudCoverage: number;
  /**
   * Time of day, 0..24 hours. 12 is noon, 0 and 24 are midnight.
   *
   * Overrides the preset's own sun elevation once the viewer touches it — a
   * preset describes a *look*, and the time of day is the one part of that look
   * the viewer is being invited to drive. `null` means the preset still owns it.
   */
  timeOfDay: number | null;
  /** Volumetric fog density, 0..1. 0 is a bit-exact pass-through. */
  fogDensity: number;
  /**
   * Master audio level, 0..1. 0 is silence.
   *
   * The audio graph stays suspended until a user gesture whatever this says —
   * browsers require one — so a non-zero default is a statement of intent
   * rather than a promise of noise.
   */
  volume: number;
  buoyancyProbes: boolean;
  wakeProbes: boolean;
  forceWebGL: boolean;
  /** Device pixel ratio multiplier, 0.5..2. */
  pixelRatio: number;
  cameraMode: CameraMode;
}

export interface UiCallbacks {
  onChange<K extends keyof UiState>(key: K, value: UiState[K]): void;
}

/** Renderer backend reported back to the HUD badge. */
export type RendererBackend = 'webgpu' | 'webgl';

/** Default state, matching the reference capture. */
export const DEFAULT_UI_STATE: UiState = {
  quality: 'high',
  preset: 'skyPro',
  windSpeed: 15,
  peakWavelength: 47,
  cloudCoverage: 0.32,
  timeOfDay: null,
  fogDensity: 0.35,
  volume: 0.4,
  buoyancyProbes: false,
  wakeProbes: false,
  forceWebGL: false,
  pixelRatio: 1,
  cameraMode: 'orbit',
};

export const QUALITY_TIERS: readonly QualityTier[] = ['low', 'medium', 'high', 'ultra', 'max'];

export const PRESET_IDS: readonly PresetId[] = [
  'skyPro',
  'arctic',
  'blackFlag',
  'dusk',
  'foggy',
  'moonlit',
  'seaOfThieves',
  'storm',
  'sunset',
];

export const CAMERA_MODES: readonly CameraMode[] = ['orbit', 'fly', 'boat', 'cinematic'];
