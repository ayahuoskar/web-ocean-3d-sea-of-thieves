import * as THREE from 'three/webgpu';
import { Fn, float, int, ivec2, uniform, textureLoad, uv, vec2, vec4 } from 'three/tsl';

/**
 * Cooley–Tukey radix-2 IFFT executed as ping-ponged fullscreen passes.
 *
 * Deliberately fragment-based rather than compute-based: Three's WebGL2 backend
 * has no compute shaders and no storage textures, so a compute implementation
 * would need an entirely separate fallback path. Fragment passes compile to both
 * backends from one TSL source. At the sizes we run (<= 512^2, ~9 passes per
 * direction) the cost difference is not the bottleneck — the surface shading is.
 *
 * Each texel carries TWO independent complex values (rg and ba), so one pass
 * transforms two spectra at once. Four spectra per cascade therefore need two
 * ping-pong pairs rather than four.
 *
 * Reference: J. Tessendorf, "Simulating Ocean Water" (SIGGRAPH course notes);
 * butterfly-texture formulation after Flügge, "Realtime GPGPU FFT Ocean Water
 * Simulation" (2017). Implementation here is original.
 */

/** Precomputed twiddle factors and read indices: width = log2(N), height = N. */
export function createButterflyTexture(size: number): THREE.DataTexture {
  const stages = Math.log2(size);
  if (!Number.isInteger(stages)) throw new Error(`FFT size must be a power of two, got ${size}`);

  const data = new Float32Array(stages * size * 4);
  const reversed = bitReverseIndices(size);

  for (let stage = 0; stage < stages; stage++) {
    for (let y = 0; y < size; y++) {
      const span = 1 << stage; // butterfly half-span at this stage
      const groupSize = span << 1;

      // Twiddle exponent for this row. Both halves of a butterfly share the same
      // W^k and differ only by the sign of the term, so k is the position within
      // the HALF-span, not within the whole group. Using the group width here
      // makes stage 0 apply W^(N/2) = -1 to every odd row, which scrambles the
      // transform from the very first pass.
      const k = (y % span) * (size / groupSize);
      const angle = (2 * Math.PI * k) / size;
      const twiddleRe = Math.cos(angle);
      const twiddleIm = Math.sin(angle);

      const inGroup = y % groupSize;
      const isTop = inGroup < span;

      let topIndex: number;
      let bottomIndex: number;
      if (isTop) {
        topIndex = y;
        bottomIndex = y + span;
      } else {
        topIndex = y - span;
        bottomIndex = y;
      }

      // The first stage reads bit-reversed, folding the permutation into the
      // transform instead of paying for a separate reorder pass.
      if (stage === 0) {
        topIndex = reversed[topIndex];
        bottomIndex = reversed[bottomIndex];
      }

      const offset = (stage + y * stages) * 4;
      // Sign of the twiddle differentiates the two halves of the butterfly.
      data[offset + 0] = isTop ? twiddleRe : -twiddleRe;
      data[offset + 1] = isTop ? twiddleIm : -twiddleIm;
      data[offset + 2] = topIndex;
      data[offset + 3] = bottomIndex;
    }
  }

  const texture = new THREE.DataTexture(data, stages, size, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function bitReverseIndices(size: number): Uint32Array {
  const bits = Math.log2(size);
  const out = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let value = i;
    let reversed = 0;
    for (let b = 0; b < bits; b++) {
      reversed = (reversed << 1) | (value & 1);
      value >>= 1;
    }
    out[i] = reversed;
  }
  return out;
}

/** Complex multiply, (a.x + i a.y) * (b.x + i b.y). */
export const cMul = /*@__PURE__*/ Fn(([a, b]: [any, any]) =>
  vec2(a.x.mul(b.x).sub(a.y.mul(b.y)), a.x.mul(b.y).add(a.y.mul(b.x))),
);

export interface FFTResources {
  size: number;
  stages: number;
  butterfly: THREE.DataTexture;
}

export function createFFTResources(size: number): FFTResources {
  return { size, stages: Math.log2(size), butterfly: createButterflyTexture(size) };
}

/**
 * Builds the node graph for one butterfly pass. `direction` 0 = horizontal
 * (transform along x), 1 = vertical.
 */
export function butterflyPassNode(
  resources: FFTResources,
  sourceTexture: THREE.Texture,
  stageUniform: any,
  direction: 0 | 1,
) {
  const { size, butterfly } = resources;

  return Fn(() => {
    // Integer texel coordinate of the fragment being written. `screenCoordinate`
    // is not dependable across backends for offscreen targets of arbitrary size,
    // so derive it from uv against the known target size instead.
    const coord = ivec2(
      float(size).mul(uv().x).floor().toInt(),
      float(size).mul(uv().y).floor().toInt(),
    ).toVar();

    // The transform axis index selects which row of the butterfly texture to use.
    const axis = direction === 0 ? coord.x : coord.y;

    const bf = textureLoad(butterfly, ivec2(stageUniform.toInt(), axis)).toVar();
    const twiddle = vec2(bf.x, bf.y).toVar();
    const idxA = bf.z.toInt().toVar();
    const idxB = bf.w.toInt().toVar();

    const coordA =
      direction === 0 ? ivec2(idxA, coord.y) : ivec2(coord.x, idxA);
    const coordB =
      direction === 0 ? ivec2(idxB, coord.y) : ivec2(coord.x, idxB);

    const a = textureLoad(sourceTexture, coordA).toVar();
    const b = textureLoad(sourceTexture, coordB).toVar();

    // Two independent complex values per texel: (r,g) and (b,a).
    const out0 = vec2(a.x, a.y).add(cMul(twiddle, vec2(b.x, b.y)));
    const out1 = vec2(a.z, a.w).add(cMul(twiddle, vec2(b.z, b.w)));

    return vec4(out0.x, out0.y, out1.x, out1.y);
  })();
}

export { int, float, uniform };
