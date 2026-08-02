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

/**
 * Readback grid per cascade, in texels per side.
 *
 * This used to be a constant 64, read as `readRenderTargetPixelsAsync(target,
 * 0, 0, 64, 64)` from a target that is `fftSize` square — 128, 256 or 512. That
 * is not a downsample. It is the **bottom-left corner**, and `sampleBilinear`
 * then spread those 64 texels across the whole tile, so the physics floated the
 * hull on the corner quarter of the wave field stretched over all of it.
 *
 * The two seas had the same amplitude and nothing else: measured against the
 * true field reconstructed from the same targets, correlation was 0.075 and the
 * rms difference 2.30 m, worst 6.26 m. The hull's height relative to the water
 * a viewer can see was therefore very nearly uncorrelated with it, which is what
 * "the ship sometimes goes under" actually was — not a buoyancy failure but the
 * solver and the renderer disagreeing about where the water is. It also explains
 * why it was intermittent: whether the hull sat high or low depended on where it
 * happened to be relative to a phase error, not on the sea state.
 *
 * The slice now covers the whole target. The size is per-cascade because a tier
 * change moves `fftSize`, and it is read back from the target rather than
 * assumed.
 */
interface CascadeSlice {
  tileSize: number;
  /** Texels per side of this slice. Matches the target it was read from. */
  size: number;
  /** RGBA half-float texels, `size^2`. */
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
      this.slices.push({ tileSize, size: 0, data: null });
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

  /**
   * Performs a readback and **waits for it**.
   *
   * The fire-and-forget `update()` is the right trade for interactive play — a
   * frame of staleness on a floating hull is invisible and a pipeline stall is
   * not — but it makes the physics irreproducible: whether a readback lands on
   * step 7 or step 9 changes where the ship ends up. Deterministic stepping calls
   * this instead, accepting the stall in exchange for a repeatable result.
   */
  async readNow(): Promise<void> {
    // Let any in-flight fire-and-forget copy retire first, so this one is not
    // racing it for the same slices. Yielding to the *macrotask* queue, not the
    // microtask queue: the outstanding readback resolves on a GPU fence, and
    // spinning on `Promise.resolve()` would starve the very task that clears it.
    while (this.pending) await new Promise((resolve) => setTimeout(resolve, 0));
    this.pending = true;
    await this.readback();
  }

  private async readback(): Promise<void> {
    try {
      const targets = this.simulation.displacementTargets;
      for (let i = 0; i < this.slices.length && i < targets.length; i++) {
        // The whole target. Half-float RGBA is 8 bytes a texel, so a 256 row is
        // 2048 bytes and a 512 row 4096 — both multiples of the 256-byte
        // alignment the readback needs, so no padding rows appear and the
        // partial-read trap that produced the corner bug cannot recur.
        const size = targets[i].width;
        const raw = await this.renderer.readRenderTargetPixelsAsync(
          targets[i],
          0,
          0,
          size,
          size,
        );
        this.slices[i].size = size;
        this.slices[i].data = decodeInto(raw, this.slices[i]);
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
      sampleBilinear(
        slice.data,
        slice.size,
        x / slice.tileSize,
        z / slice.tileSize,
        this.scratchTexel,
      );
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
function sampleBilinear(
  data: Float32Array,
  size: number,
  u: number,
  v: number,
  out: Float32Array,
): void {
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
 * Decodes a readback into the slice's own buffer, allocating at most once.
 *
 * Render-target readbacks come back typed to match the attachment. Half-float
 * targets yield a Uint16Array of raw IEEE-754 binary16 bit patterns, which must
 * be decoded — reading them as integers silently produces values in the tens of
 * thousands instead of the tenths of a metre they represent.
 *
 * The decode used to allocate its output every call. At the default 64x64 slice
 * that is 64 kB per cascade per readback, and the readback runs every frame for
 * every cascade — around 190 kB of garbage a frame at three cascades, in a
 * project whose stated performance policy is no per-frame allocation. It never
 * showed up in the frame time because the cost is deferred to whenever the
 * collector decides to run, which is exactly what makes this kind of allocation
 * worth removing rather than measuring.
 *
 * The buffer is grown, never shrunk, and reused across readbacks; a tier change
 * that alters the slice size reallocates once and then settles.
 */
function decodeInto(raw: ArrayBufferView, slice: CascadeSlice): Float32Array {
  // A Float32 target needs no decode, but it must still be copied: the array the
  // renderer hands back is not guaranteed to outlive the next readback.
  const source =
    raw instanceof Float32Array || raw instanceof Uint16Array
      ? raw
      : (raw as unknown as ArrayLike<number>);
  const length = source.length;

  let out = slice.data;
  if (out === null || out.length !== length) {
    out = new Float32Array(length);
    slice.data = out;
  }

  if (source instanceof Uint16Array) {
    for (let i = 0; i < length; i++) out[i] = halfToFloat(source[i]);
  } else {
    for (let i = 0; i < length; i++) out[i] = source[i];
  }
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
