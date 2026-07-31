import * as THREE from 'three/webgpu';
import type { OceanSimulation } from './OceanSimulation';

/**
 * CPU-side query of the wave surface, for buoyancy and camera collision.
 *
 * The displacement field lives on the GPU, so a slice of it is copied back into
 * host memory. The readback is asynchronous and deliberately *not* awaited by the
 * frame loop: stalling on a GPU fence would cost far more than the one-frame
 * staleness it buys, and at 60 Hz a frame of lag on a floating hull is invisible.
 *
 * Sampling is not a plain texture lookup. The surface is choppy, meaning a vertex
 * at grid position p is displayed at p + D(p) — so finding the height *above a
 * given world point* requires inverting that map. A few fixed-point iterations
 * converge quickly for the displacement magnitudes we allow (the map stays
 * invertible as long as the Jacobian stays positive, which is also the condition
 * for not generating foam).
 */

const READBACK_SIZE = 64;

interface CascadeSlice {
  tileSize: number;
  /** RGBA half-float texels, READBACK_SIZE^2. */
  data: Float32Array | null;
}

export class OceanSampler {
  private readonly renderer: THREE.WebGPURenderer;
  private readonly simulation: OceanSimulation;
  private readonly slices: CascadeSlice[] = [];
  private pending = false;
  private everResolved = false;

  constructor(renderer: THREE.WebGPURenderer, simulation: OceanSimulation) {
    this.renderer = renderer;
    this.simulation = simulation;
    this.rebuild();
  }

  /** True once at least one readback has landed; before that, height() returns 0. */
  get ready(): boolean {
    return this.everResolved;
  }

  rebuild(): void {
    this.slices.length = 0;
    for (const tileSize of this.simulation.tileSizes) {
      this.slices.push({ tileSize, data: null });
    }
    this.everResolved = false;
  }

  /**
   * Kicks off a readback if one is not already in flight. Safe to call every
   * frame; it self-throttles to one outstanding copy.
   */
  update(): void {
    if (this.pending) return;
    this.pending = true;
    void this.readback();
  }

  private async readback(): Promise<void> {
    try {
      const targets = this.simulation.displacementTargets;
      for (let i = 0; i < this.slices.length && i < targets.length; i++) {
        const raw = await this.renderer.readRenderTargetPixelsAsync(
          targets[i],
          0,
          0,
          READBACK_SIZE,
          READBACK_SIZE,
        );
        this.slices[i].data = toFloat32(raw);
      }
      this.everResolved = true;
    } catch {
      // A readback can fail while the device is being reconfigured (resize,
      // backend switch). Dropping the frame is correct; the next one retries.
    } finally {
      this.pending = false;
    }
  }

  /**
   * Raw displacement at an undisplaced grid point, summed over cascades.
   * `out` receives (Dx, Dy, Dz).
   */
  private displacementAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    for (const slice of this.slices) {
      if (!slice.data) continue;
      sampleBilinear(slice.data, x / slice.tileSize, z / slice.tileSize, this.scratchTexel);
      out.x += this.scratchTexel[0];
      out.y += this.scratchTexel[1];
      out.z += this.scratchTexel[2];
    }
    return out;
  }

  private readonly scratchTexel = new Float32Array(4);
  private readonly scratchDisp = new THREE.Vector3();

  /**
   * Water surface height at world (x, z).
   *
   * Inverts the choppy displacement by fixed-point iteration: start from the
   * assumption that the grid point equals the world point, then repeatedly pull
   * the guess back by the horizontal displacement found there.
   */
  height(x: number, z: number): number {
    if (!this.everResolved) return 0;
    let gx = x;
    let gz = z;
    for (let i = 0; i < 4; i++) {
      const d = this.displacementAt(gx, gz, this.scratchDisp);
      gx = x - d.x;
      gz = z - d.z;
    }
    return this.displacementAt(gx, gz, this.scratchDisp).y;
  }

  /**
   * Surface normal at world (x, z), via central differences on the height field.
   * `epsilon` should be comparable to the finest wavelength you care about.
   */
  normal(x: number, z: number, epsilon = 0.6, out = new THREE.Vector3()): THREE.Vector3 {
    const hL = this.height(x - epsilon, z);
    const hR = this.height(x + epsilon, z);
    const hD = this.height(x, z - epsilon);
    const hU = this.height(x, z + epsilon);
    return out.set(hL - hR, 2 * epsilon, hD - hU).normalize();
  }

  dispose(): void {
    this.slices.length = 0;
  }
}

/** Wraps to [0,1) then samples with bilinear interpolation. */
function sampleBilinear(data: Float32Array, u: number, v: number, out: Float32Array): void {
  const size = READBACK_SIZE;
  const fx = (((u % 1) + 1) % 1) * size - 0.5;
  const fz = (((v % 1) + 1) % 1) * size - 0.5;
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const tx = fx - x0;
  const tz = fz - z0;

  const wrap = (n: number) => ((n % size) + size) % size;
  const x0w = wrap(x0);
  const x1w = wrap(x0 + 1);
  const z0w = wrap(z0);
  const z1w = wrap(z0 + 1);

  for (let c = 0; c < 4; c++) {
    const a = data[(z0w * size + x0w) * 4 + c];
    const b = data[(z0w * size + x1w) * 4 + c];
    const d = data[(z1w * size + x0w) * 4 + c];
    const e = data[(z1w * size + x1w) * 4 + c];
    out[c] = (a + (b - a) * tx) * (1 - tz) + (d + (e - d) * tx) * tz;
  }
}

/**
 * Render-target readbacks come back typed to match the attachment. Half-float
 * targets yield a Uint16Array of raw IEEE-754 binary16 bit patterns, which must
 * be decoded — reading them as integers silently produces values in the tens of
 * thousands instead of the tenths of a metre they represent.
 */
function toFloat32(raw: ArrayBufferView): Float32Array {
  if (raw instanceof Float32Array) return raw;
  if (raw instanceof Uint16Array) {
    const out = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = halfToFloat(raw[i]);
    return out;
  }
  const view = raw as unknown as ArrayLike<number>;
  const out = new Float32Array(view.length);
  for (let i = 0; i < view.length; i++) out[i] = view[i];
  return out;
}

function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits & 0x7c00) >> 10;
  const mantissa = bits & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (mantissa / 1024);
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}
