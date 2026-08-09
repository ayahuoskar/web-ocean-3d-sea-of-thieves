/** State contract shared between the UI layer and application shell. */
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
  windSpeed: number;
  peakWavelength: number;
  cloudCoverage: number;
  timeOfDay: number | null;
  fogDensity: number;
  volume: number;
  buoyancyProbes: boolean;
  wakeProbes: boolean;
  forceWebGL: boolean;
  pixelRatio: number;
  cameraMode: CameraMode;
}

export interface UiCallbacks {
  onChange<K extends keyof UiState>(key: K, value: UiState[K]): void;
}

export type RendererBackend = 'webgpu' | 'webgl';

/**
 * Ocean Feel Lab opens on the project's deliberately stylised turquoise sea
 * instead of the neutral reference-capture preset. Values match the preset so
 * the sliders and rendered state agree from the first frame.
 */
export const DEFAULT_UI_STATE: UiState = {
  quality: 'high',
  preset: 'seaOfThieves',
  windSpeed: 9,
  peakWavelength: 34,
  cloudCoverage: 0.36,
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
