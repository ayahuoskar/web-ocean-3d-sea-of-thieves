import * as THREE from 'three/webgpu';

export const GRAVITY = 9.81;

export interface SpectrumParams {
  /** Wind speed at 10 m reference height, m/s. */
  windSpeed: number;
  /** Wind direction in radians, measured in the XZ plane. */
  windDirection: number;
  /** Wavelength of the spectral peak, metres. Drives the dominant swell size. */
  peakWavelength: number;
  /**
   * Fraction of the spectrum's own peak frequency below which energy is culled.
   * Keeps neighbouring cascades from double-counting the same wavelengths.
   */
  fetch: number;
  /** Peak enhancement (JONSWAP gamma). 1 = Pierson–Moskowitz, 3.3 = typical fetch-limited sea. */
  gamma: number;
  /** Directional spreading exponent — higher is a tighter, more directional sea. */
  spreadExponent: number;
  /** Fraction of energy travelling against the wind (chop realism). */
  swell: number;
  /** Overall amplitude scale. */
  amplitude: number;
}

export const DEFAULT_SPECTRUM: SpectrumParams = {
  windSpeed: 15,
  windDirection: Math.PI * 0.25,
  peakWavelength: 47,
  fetch: 1,
  gamma: 3.3,
  spreadExponent: 4,
  swell: 0.2,
  amplitude: 1,
};

/**
 * One spectral band. Three cascades at decreasing tile sizes cover swell, chop
 * and ripple without any single tile becoming visibly periodic.
 */
export interface CascadeConfig {
  /** Physical size of the tile in metres. */
  tileSize: number;
  /** Wavelengths outside [minWavelength, maxWavelength] are culled from this band. */
  minWavelength: number;
  maxWavelength: number;
  /** Per-cascade weighting of horizontal displacement (choppiness). */
  choppiness: number;
}

export const CASCADES: CascadeConfig[] = [
  { tileSize: 512, minWavelength: 24, maxWavelength: 10000, choppiness: 1.1 },
  { tileSize: 128, minWavelength: 6, maxWavelength: 24, choppiness: 1.0 },
  { tileSize: 16, minWavelength: 0.05, maxWavelength: 6, choppiness: 0.85 },
];

/**
 * Builds the time-zero spectrum h0(k) for one cascade.
 *
 * Packing is RGBA = ( h0(k).re, h0(k).im, h0(-k).re, h0(-k).im ) so the per-frame
 * evolution pass can form the Hermitian pair with a single texture fetch.
 *
 * The model is JONSWAP in the frequency domain, mapped to wavenumber space via the
 * deep-water dispersion relation w^2 = g|k|, with a cosine-power directional
 * spreading term. Generated on the CPU: it is O(N^2) once per parameter change
 * (~1 ms at 256^2), and keeping it here avoids a GPU noise-generation pass and
 * gives byte-identical results across backends.
 */
export function generateInitialSpectrum(
  size: number,
  cascade: CascadeConfig,
  params: SpectrumParams,
  seed = 1337,
): Float32Array {
  const data = new Float32Array(size * size * 4);
  const random = mulberry32(seed);

  const peakOmega = Math.sqrt((GRAVITY * 2 * Math.PI) / params.peakWavelength);
  const deltaK = (2 * Math.PI) / cascade.tileSize;
  const windX = Math.cos(params.windDirection);
  const windZ = Math.sin(params.windDirection);

  // Precompute the Gaussian pairs so that changing wind speed re-weights an
  // unchanged noise field — the sea keeps its identity instead of reshuffling.
  const half = size / 2;

  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const kx = (x - half) * deltaK;
      const kz = (z - half) * deltaK;

      const g0 = gaussianPair(random);
      const g1 = gaussianPair(random);

      const index = (z * size + x) * 4;

      const amplitude = spectrumAmplitude(kx, kz, cascade, params, peakOmega, windX, windZ, deltaK);
      const amplitudeMirror = spectrumAmplitude(
        -kx,
        -kz,
        cascade,
        params,
        peakOmega,
        windX,
        windZ,
        deltaK,
      );

      data[index + 0] = g0.a * amplitude;
      data[index + 1] = g0.b * amplitude;
      data[index + 2] = g1.a * amplitudeMirror;
      data[index + 3] = g1.b * amplitudeMirror;
    }
  }

  return data;
}

function spectrumAmplitude(
  kx: number,
  kz: number,
  cascade: CascadeConfig,
  params: SpectrumParams,
  peakOmega: number,
  windX: number,
  windZ: number,
  deltaK: number,
): number {
  const kLength = Math.hypot(kx, kz);
  if (kLength < 1e-6) return 0;

  // Band-limit so cascades tile different wavelength ranges without overlap.
  const wavelength = (2 * Math.PI) / kLength;
  if (wavelength < cascade.minWavelength || wavelength > cascade.maxWavelength) return 0;

  const omega = Math.sqrt(GRAVITY * kLength);

  // --- JONSWAP energy density in the frequency domain ---
  const sigma = omega <= peakOmega ? 0.07 : 0.09;
  const peakRatio = (omega - peakOmega) / (sigma * peakOmega);
  const peakEnhancement = Math.pow(params.gamma, Math.exp(-0.5 * peakRatio * peakRatio));
  const alpha = 0.0081;
  const jonswap =
    ((alpha * GRAVITY * GRAVITY) / Math.pow(omega, 5)) *
    Math.exp(-1.25 * Math.pow(peakOmega / omega, 4)) *
    peakEnhancement;

  // --- Map frequency density to wavenumber density ---
  // dw/dk = g / (2w); the extra 1/k converts a 1-D density to a 2-D one.
  const jacobian = GRAVITY / (2 * omega * kLength);

  // --- Directional spreading ---
  const cosTheta = (kx * windX + kz * windZ) / kLength;
  // cos^2s lobe about the wind axis, with a floor so a little energy always
  // travels crosswind and against the wind.
  const forward = Math.max(cosTheta, 0);
  const directional =
    Math.pow(forward, params.spreadExponent * 2) +
    params.swell * Math.pow(Math.max(-cosTheta, 0), params.spreadExponent * 2);

  // Suppress the very shortest waves — beyond this they are normal-map detail,
  // not geometry, and they alias badly.
  const capillaryCutoff = Math.exp(-kLength * kLength * 0.0004);

  const energy = jonswap * jacobian * directional * capillaryCutoff * params.amplitude;
  if (!Number.isFinite(energy) || energy <= 0) return 0;

  // sqrt(2 * S(k) * dk^2) / sqrt(2) collapses to sqrt(S) * dk.
  return Math.sqrt(energy) * deltaK;
}

/** Box–Muller. Returns two independent standard normals per call. */
function gaussianPair(random: () => number): { a: number; b: number } {
  let u = random();
  const v = random();
  if (u < 1e-9) u = 1e-9;
  const radius = Math.sqrt(-2 * Math.log(u));
  return { a: radius * Math.cos(2 * Math.PI * v), b: radius * Math.sin(2 * Math.PI * v) };
}

/** Small deterministic PRNG so a given seed always yields the same sea. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSpectrumTexture(size: number, data: Float32Array): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Significant wave height implied by the spectrum, used to size the buoyancy
 * probe search and the camera's underwater test margin.
 */
export function significantWaveHeight(params: SpectrumParams): number {
  // Pierson–Moskowitz fully developed sea: Hs ~= 0.22 * U^2 / g.
  return (0.22 * params.windSpeed * params.windSpeed) / GRAVITY;
}
