import * as THREE from 'three';
import type { PresetId } from '../ui/types';
import type { WaterAppearance } from '../ocean/OceanMaterial';
import type { SpectrumParams } from '../ocean/Spectrum';

export type WeatherKind = 'clear' | 'rain' | 'snow';

export interface Preset {
  id: PresetId;
  label: string;
  /** Sky and lighting. */
  atmosphere: {
    sunElevation: number;
    sunAzimuth: number;
    turbidity: number;
    rayleigh: number;
    mieCoefficient: number;
    mieDirectionalG: number;
    exposure: number;
    nightIntensity: number;
    moonElevation: number;
    moonAzimuth: number;
  };
  clouds: {
    coverage: number;
    density: number;
    altitude: number;
    thickness: number;
    color: THREE.Color;
    shadowColor: THREE.Color;
  };
  weather: { kind: WeatherKind; intensity: number };
  /** Sea state. */
  sea: Pick<SpectrumParams, 'windSpeed' | 'windDirection' | 'peakWavelength' | 'gamma' | 'swell'>;
  water: Partial<WaterAppearance>;
  /** Aerial perspective applied to the water surface. */
  fog: { color: THREE.Color; density: number };
  /** Underwater medium. */
  underwater: {
    color: THREE.Color;
    extinction: THREE.Vector3;
    visibility: number;
    godRayStrength: number;
  };
  toneMappingExposure: number;
}

const color = (hex: number) => new THREE.Color(hex);
const vec = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * Nine environment looks. Each one moves the sun, the sea state, the medium and
 * the aerial perspective together — changing only the sky is what makes preset
 * switches in most demos look like a filter rather than a different place.
 *
 * Extinction triples follow real water: red is absorbed roughly an order of
 * magnitude faster than blue, so the third component is always the smallest.
 */
export const PRESETS: Record<PresetId, Preset> = {
  skyPro: {
    id: 'skyPro',
    label: 'Clear Day',
    atmosphere: {
      sunElevation: 0.46,
      sunAzimuth: 2.4,
      turbidity: 2.2,
      rayleigh: 1.5,
      mieCoefficient: 0.004,
      mieDirectionalG: 0.8,
      exposure: 1,
      nightIntensity: 0,
      moonElevation: -0.5,
      moonAzimuth: 0,
    },
    clouds: {
      coverage: 0.32,
      density: 0.9,
      altitude: 1600,
      thickness: 700,
      color: color(0xffffff),
      shadowColor: color(0x8fa8c4),
    },
    weather: { kind: 'clear', intensity: 0 },
    sea: {
      windSpeed: 15,
      windDirection: Math.PI * 0.25,
      peakWavelength: 47,
      gamma: 3.3,
      swell: 0.2,
    },
    water: {
      deepColor: color(0x04283c),
      shallowColor: color(0x1fa9a6),
      scatterColor: color(0x36bda8),
      extinction: vec(0.32, 0.1, 0.06),
      roughness: 0.07,
      foamThreshold: 0.42,
    },
    fog: { color: color(0xbfd8ee), density: 0.00016 },
    underwater: {
      color: color(0x1d6f96),
      extinction: vec(0.28, 0.09, 0.055),
      visibility: 45,
      godRayStrength: 1,
    },
    toneMappingExposure: 1,
  },

  arctic: {
    id: 'arctic',
    label: 'Arctic',
    atmosphere: {
      sunElevation: 0.16,
      sunAzimuth: 1.6,
      turbidity: 1.6,
      rayleigh: 2.4,
      mieCoefficient: 0.003,
      mieDirectionalG: 0.75,
      exposure: 1.1,
      nightIntensity: 0,
      moonElevation: -0.5,
      moonAzimuth: 0,
    },
    clouds: {
      coverage: 0.55,
      density: 0.7,
      altitude: 1200,
      thickness: 500,
      color: color(0xeaf3ff),
      shadowColor: color(0x9db4cc),
    },
    weather: { kind: 'snow', intensity: 0.45 },
    sea: {
      windSpeed: 11,
      windDirection: Math.PI * 0.8,
      peakWavelength: 38,
      gamma: 2.4,
      swell: 0.3,
    },
    water: {
      deepColor: color(0x081f2e),
      shallowColor: color(0x2f8fa8),
      scatterColor: color(0x59c8d4),
      extinction: vec(0.4, 0.16, 0.1),
      roughness: 0.09,
      foamThreshold: 0.5,
    },
    fog: { color: color(0xd8e6f2), density: 0.00034 },
    underwater: {
      color: color(0x14526e),
      extinction: vec(0.34, 0.13, 0.08),
      visibility: 30,
      godRayStrength: 0.7,
    },
    toneMappingExposure: 1.05,
  },

  blackFlag: {
    id: 'blackFlag',
    label: 'High Seas',
    atmosphere: {
      sunElevation: 0.55,
      sunAzimuth: 3.1,
      turbidity: 3.4,
      rayleigh: 1.2,
      mieCoefficient: 0.006,
      mieDirectionalG: 0.82,
      exposure: 1,
      nightIntensity: 0,
      moonElevation: -0.5,
      moonAzimuth: 0,
    },
    clouds: {
      coverage: 0.4,
      density: 1.1,
      altitude: 1800,
      thickness: 900,
      color: color(0xfff6e8),
      shadowColor: color(0x7f93ad),
    },
    weather: { kind: 'clear', intensity: 0 },
    sea: {
      windSpeed: 13,
      windDirection: Math.PI * 0.1,
      peakWavelength: 55,
      gamma: 3.3,
      swell: 0.25,
    },
    water: {
      deepColor: color(0x04303f),
      shallowColor: color(0x18b5a4),
      scatterColor: color(0x3fd0b0),
      extinction: vec(0.28, 0.085, 0.05),
      roughness: 0.06,
      foamThreshold: 0.44,
    },
    fog: { color: color(0xc8e0ee), density: 0.00014 },
    underwater: {
      color: color(0x1c7f92),
      extinction: vec(0.24, 0.075, 0.045),
      visibility: 55,
      godRayStrength: 1.15,
    },
    toneMappingExposure: 1,
  },

  dusk: {
    id: 'dusk',
    label: 'Dusk',
    atmosphere: {
      sunElevation: 0.045,
      sunAzimuth: 4.3,
      turbidity: 5,
      rayleigh: 2.6,
      mieCoefficient: 0.009,
      mieDirectionalG: 0.86,
      exposure: 0.95,
      nightIntensity: 0.25,
      moonElevation: 0.35,
      moonAzimuth: 1.4,
    },
    clouds: {
      coverage: 0.42,
      density: 1,
      altitude: 2000,
      thickness: 800,
      color: color(0xffd9b3),
      shadowColor: color(0x5a5470),
    },
    weather: { kind: 'clear', intensity: 0 },
    sea: {
      windSpeed: 7,
      windDirection: Math.PI * 1.2,
      peakWavelength: 42,
      gamma: 2.8,
      swell: 0.35,
    },
    water: {
      deepColor: color(0x08192b),
      shallowColor: color(0x1a5f74),
      scatterColor: color(0x8a6a52),
      extinction: vec(0.34, 0.13, 0.09),
      roughness: 0.05,
      foamThreshold: 0.46,
    },
    fog: { color: color(0x9a8ea6), density: 0.00026 },
    underwater: {
      color: color(0x11364f),
      extinction: vec(0.36, 0.14, 0.09),
      visibility: 26,
      godRayStrength: 0.55,
    },
    toneMappingExposure: 0.95,
  },

  foggy: {
    id: 'foggy',
    label: 'Foggy',
    atmosphere: {
      sunElevation: 0.3,
      sunAzimuth: 2,
      turbidity: 9,
      rayleigh: 0.9,
      mieCoefficient: 0.02,
      mieDirectionalG: 0.7,
      exposure: 1,
      nightIntensity: 0,
      moonElevation: -0.5,
      moonAzimuth: 0,
    },
    clouds: {
      coverage: 0.85,
      density: 0.6,
      altitude: 900,
      thickness: 600,
      color: color(0xdfe6ea),
      shadowColor: color(0xa8b4bd),
    },
    weather: { kind: 'clear', intensity: 0 },
    sea: {
      windSpeed: 5,
      windDirection: Math.PI * 0.6,
      peakWavelength: 30,
      gamma: 2,
      swell: 0.4,
    },
    water: {
      deepColor: color(0x14252c),
      shallowColor: color(0x3f7b82),
      scatterColor: color(0x5f9296),
      extinction: vec(0.42, 0.2, 0.14),
      roughness: 0.1,
      foamThreshold: 0.5,
    },
    fog: { color: color(0xccd6da), density: 0.0016 },
    underwater: {
      color: color(0x2a5560),
      extinction: vec(0.46, 0.24, 0.17),
      visibility: 16,
      godRayStrength: 0.35,
    },
    toneMappingExposure: 1,
  },

  moonlit: {
    id: 'moonlit',
    label: 'Moonlit',
    atmosphere: {
      sunElevation: -0.35,
      sunAzimuth: 5,
      turbidity: 1.4,
      rayleigh: 0.6,
      mieCoefficient: 0.002,
      mieDirectionalG: 0.8,
      exposure: 1.4,
      nightIntensity: 1,
      moonElevation: 0.7,
      moonAzimuth: 2.1,
    },
    clouds: {
      coverage: 0.22,
      density: 0.8,
      altitude: 1900,
      thickness: 700,
      color: color(0x9fb0c8),
      shadowColor: color(0x18202e),
    },
    weather: { kind: 'clear', intensity: 0 },
    sea: {
      windSpeed: 6,
      windDirection: Math.PI * 1.7,
      peakWavelength: 80,
      gamma: 2.2,
      swell: 0.45,
    },
    water: {
      deepColor: color(0x020a12),
      shallowColor: color(0x0d3f4a),
      scatterColor: color(0x18525a),
      extinction: vec(0.36, 0.14, 0.09),
      roughness: 0.045,
      foamThreshold: 0.48,
    },
    fog: { color: color(0x0d1926), density: 0.0003 },
    underwater: {
      color: color(0x07202e),
      extinction: vec(0.38, 0.16, 0.1),
      visibility: 22,
      godRayStrength: 0.3,
    },
    toneMappingExposure: 1.35,
  },

  seaOfThieves: {
    id: 'seaOfThieves',
    label: 'Tropical',
    atmosphere: {
      sunElevation: 0.62,
      sunAzimuth: 1.9,
      turbidity: 2.6,
      rayleigh: 1.3,
      mieCoefficient: 0.005,
      mieDirectionalG: 0.8,
      exposure: 1.05,
      nightIntensity: 0,
      moonElevation: -0.5,
      moonAzimuth: 0,
    },
    clouds: {
      coverage: 0.36,
      density: 1.2,
      altitude: 1500,
      thickness: 1000,
      color: color(0xffffff),
      shadowColor: color(0x86a6c8),
    },
    weather: { kind: 'clear', intensity: 0 },
    sea: {
      windSpeed: 9,
      windDirection: Math.PI * 0.45,
      peakWavelength: 34,
      gamma: 3,
      swell: 0.2,
    },
    water: {
      deepColor: color(0x03414f),
      shallowColor: color(0x2fd4c0),
      scatterColor: color(0x4ee0c2),
      extinction: vec(0.22, 0.06, 0.035),
      roughness: 0.055,
      foamThreshold: 0.42,
    },
    fog: { color: color(0xcfeaf4), density: 0.00012 },
    underwater: {
      color: color(0x1fa0ab),
      extinction: vec(0.18, 0.05, 0.03),
      visibility: 70,
      godRayStrength: 1.35,
    },
    toneMappingExposure: 1.05,
  },

  storm: {
    id: 'storm',
    label: 'Storm',
    atmosphere: {
      sunElevation: 0.22,
      sunAzimuth: 3.6,
      turbidity: 12,
      rayleigh: 0.7,
      mieCoefficient: 0.024,
      mieDirectionalG: 0.72,
      exposure: 0.85,
      nightIntensity: 0.1,
      moonElevation: -0.5,
      moonAzimuth: 0,
    },
    clouds: {
      coverage: 0.95,
      density: 1.6,
      altitude: 800,
      thickness: 1400,
      color: color(0x9aa3ad),
      shadowColor: color(0x2b3138),
    },
    weather: { kind: 'rain', intensity: 0.9 },
    sea: {
      windSpeed: 21,
      windDirection: Math.PI * 1.1,
      peakWavelength: 60,
      gamma: 3.3,
      swell: 0.15,
    },
    water: {
      deepColor: color(0x0a1620),
      shallowColor: color(0x21525f),
      scatterColor: color(0x2c6a6f),
      extinction: vec(0.4, 0.18, 0.12),
      roughness: 0.12,
      foamThreshold: 0.55,
    },
    fog: { color: color(0x6f7a86), density: 0.0007 },
    underwater: {
      color: color(0x16323f),
      extinction: vec(0.44, 0.2, 0.14),
      visibility: 14,
      godRayStrength: 0.25,
    },
    toneMappingExposure: 0.85,
  },

  sunset: {
    id: 'sunset',
    label: 'Sunset',
    atmosphere: {
      sunElevation: 0.075,
      sunAzimuth: 4.6,
      turbidity: 6,
      rayleigh: 2.9,
      mieCoefficient: 0.012,
      mieDirectionalG: 0.88,
      exposure: 1,
      nightIntensity: 0.05,
      moonElevation: -0.5,
      moonAzimuth: 0,
    },
    clouds: {
      coverage: 0.45,
      density: 1,
      altitude: 2200,
      thickness: 900,
      color: color(0xffcfa8),
      shadowColor: color(0x6b5f78),
    },
    weather: { kind: 'clear', intensity: 0 },
    sea: {
      windSpeed: 2.5,
      windDirection: Math.PI * 1.35,
      peakWavelength: 20,
      gamma: 2.2,
      swell: 0.5,
    },
    water: {
      deepColor: color(0x0a2230),
      shallowColor: color(0x1c6f7c),
      scatterColor: color(0xb5825a),
      extinction: vec(0.3, 0.12, 0.08),
      roughness: 0.04,
      foamThreshold: 0.52,
    },
    fog: { color: color(0xd0aa9c), density: 0.00022 },
    underwater: {
      color: color(0x14455c),
      extinction: vec(0.32, 0.12, 0.08),
      visibility: 30,
      godRayStrength: 0.7,
    },
    toneMappingExposure: 1,
  },
};

export const PRESET_LIST: Preset[] = Object.values(PRESETS);

export function getPreset(id: PresetId): Preset {
  return PRESETS[id];
}
