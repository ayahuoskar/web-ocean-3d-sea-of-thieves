import * as THREE from 'three/webgpu';
import { Fn, float, mix, positionWorld, texture, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { smoothstepDown } from '../core/tslMath';
import { SEEDS, mulberry32 } from '../core/random';

/**
 * Sandy seafloor.
 *
 * The heightfield is the one piece of geometry in this project that must exist
 * simultaneously on the CPU and the GPU: buoyancy and camera collision query it
 * per frame, the water surface reads it to decide how much of the shallow
 * turquoise to let through, and the floor mesh itself is displaced by it. If
 * those three disagree, the ship's shadow lands on water that is a different
 * colour from the sand underneath it.
 *
 * So the noise is deliberately *not* an analytic hash. `sin(dot(p, k)) * 43758`
 * hashes are chaotic by construction: a float32 GPU and a float64 CPU evaluate
 * them to completely different values, and the two representations of the floor
 * drift apart. Instead a single 256² byte texture of random values is generated
 * once and sampled with hand-written bilinear interpolation on both sides.
 * Unsigned-byte texels decode to exactly `n / 255` on every backend, so the two
 * evaluations agree to float32 rounding.
 *
 * Layout the field produces:
 *   - a shallow plateau (~17 m) around the origin, where the play area sits and
 *     the seafloor is meant to read through the water;
 *   - a shelf break falling to ~88 m in open water;
 *   - a second rise around the island, which breaks the surface.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;

// ---------------------------------------------------------------- noise source

const NOISE_SIZE = 256;
const NOISE_MASK = NOISE_SIZE - 1;

const NOISE_BYTES = (() => {
  // Deterministic PRNG — the floor must be identical on every run and machine.
  const random = mulberry32(SEEDS.seafloorNoise);
  const bytes = new Uint8Array(NOISE_SIZE * NOISE_SIZE * 4);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (random() * 256) | 0;
  return bytes;
})();

function createNoiseTexture(): THREE.DataTexture {
  const map = new THREE.DataTexture(
    NOISE_BYTES,
    NOISE_SIZE,
    NOISE_SIZE,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  // Nearest + repeat means uv = (i + 0.5) / N lands exactly on texel i for any
  // integer i, positive or negative — which is what makes the hand-rolled
  // bilinear filter below reproducible against the CPU path.
  map.minFilter = THREE.NearestFilter;
  map.magFilter = THREE.NearestFilter;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.generateMipmaps = false;
  map.colorSpace = THREE.NoColorSpace;
  map.needsUpdate = true;
  return map;
}

function noiseTexel(ix: number, iy: number): number {
  const x = ix & NOISE_MASK;
  const y = iy & NOISE_MASK;
  return NOISE_BYTES[(y * NOISE_SIZE + x) * 4] / 255;
}

function valueNoise(px: number, py: number): number {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const fx = px - ix;
  const fy = py - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);

  const a = noiseTexel(ix, iy);
  const b = noiseTexel(ix + 1, iy);
  const c = noiseTexel(ix, iy + 1);
  const d = noiseTexel(ix + 1, iy + 1);

  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}

// FBM parameters. Shared verbatim by the CPU and TSL implementations; the
// rotation between octaves is what stops the sum from looking grid-aligned.
const OCTAVES = 4;
const LACUNARITY = 2.13;
const GAIN = 0.5;
const ROT = [0.8, 0.6, -0.6, 0.8] as const;
const OCTAVE_OFFSET = [17.3, 9.1] as const;
const FBM_NORM = (() => {
  let sum = 0;
  for (let o = 0, a = 1; o < OCTAVES; o++, a *= GAIN) sum += a;
  return sum;
})();

function fbm(x: number, y: number): number {
  let qx = x;
  let qy = y;
  let amplitude = 1;
  let sum = 0;
  for (let o = 0; o < OCTAVES; o++) {
    sum += valueNoise(qx, qy) * amplitude;
    const rx = qx * ROT[0] + qy * ROT[1];
    const ry = qx * ROT[2] + qy * ROT[3];
    qx = rx * LACUNARITY + OCTAVE_OFFSET[0];
    qy = ry * LACUNARITY + OCTAVE_OFFSET[1];
    amplitude *= GAIN;
  }
  return sum / FBM_NORM;
}

// ------------------------------------------------------------- floor structure

/** Rocky island the props dress and the distant silhouette comes from. */
export const ISLAND = {
  x: -1150,
  z: -780,
  /** Radius at which the island rise has fully died out. */
  radius: 260,
  /** Height of the island core above mean sea level, before props. */
  peak: 30,
} as const;

const DEEP_Y = -88;
const PLATEAU_Y = -17;
const PLATEAU_RADIUS = 320;
const SHELF_RADIUS = 1250;
const RELIEF = 11;
/** World metres per noise cell of the coarsest octave. */
const FEATURE_SCALE = 1 / 240;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Floor elevation in world metres (negative below sea level).
 *
 * Exported so `Props` can seat rocks and cliffs on the same surface the mesh is
 * built from, without either side owning the other.
 */
export function seafloorHeight(x: number, z: number): number {
  const n = fbm(x * FEATURE_SCALE, z * FEATURE_SCALE);

  const rOrigin = Math.sqrt(x * x + z * z);
  const dx = x - ISLAND.x;
  const dz = z - ISLAND.z;
  const dIsland = Math.sqrt(dx * dx + dz * dz);

  const shallowOrigin = 1 - smoothstep(PLATEAU_RADIUS, SHELF_RADIUS, rOrigin);
  const shallowIsland = smoothstep(ISLAND.radius * 2.4, ISLAND.radius * 0.6, dIsland);
  const shallowness = Math.max(shallowOrigin, shallowIsland);

  let y = DEEP_Y + (PLATEAU_Y - DEEP_Y) * shallowness;
  y += (n - 0.5) * RELIEF * (0.35 + 0.65 * shallowness);
  y += ISLAND.peak * smoothstep(ISLAND.radius, ISLAND.radius * 0.18, dIsland);
  return y;
}

/** Positive metres of water above the floor at (x, z); 0 where the floor is dry. */
export function seafloorDepth(x: number, z: number): number {
  return Math.max(0, -seafloorHeight(x, z));
}

// --------------------------------------------------------------- sand detail

/**
 * Tiling normal map for the sand, derived from the same noise field so the
 * micro-detail shares a family resemblance with the macro shape.
 */
function createSandNormalTexture(): THREE.DataTexture {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  // Two octaves at frequencies that divide `size`, so the result tiles exactly.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = valueNoise((x / size) * 16, (y / size) * 16);
      const b = valueNoise((x / size) * 48 + 31.7, (y / size) * 48 + 11.3);
      // Ripple ridges: sand under swell forms parallel bars, not isotropic bumps.
      const ripple = Math.sin((x / size) * Math.PI * 2 * 6 + a * 5.5) * 0.5 + 0.5;
      height[y * size + x] = a * 0.55 + b * 0.2 + ripple * 0.25;
    }
  }

  const strength = 2.6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xl = height[y * size + ((x - 1 + size) % size)];
      const xr = height[y * size + ((x + 1) % size)];
      const yd = height[((y - 1 + size) % size) * size + x];
      const yu = height[((y + 1) % size) * size + x];

      let nx = (xl - xr) * strength;
      let ny = (yd - yu) * strength;
      let nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;

      const i = (y * size + x) * 4;
      data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }

  const map = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.generateMipmaps = true;
  map.anisotropy = 8;
  map.colorSpace = THREE.NoColorSpace;
  map.needsUpdate = true;
  return map;
}

// ------------------------------------------------------------------- the class

export interface SeafloorOptions {
  /** Grid subdivisions per side. 256 gives ~15 m spacing over a 4 km extent. */
  segments?: number;
  /** Metres of sand normal-map per tile. */
  detailTiling?: number;
}

export class Seafloor {
  readonly mesh: THREE.Mesh;
  readonly extent: number;

  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.MeshStandardNodeMaterial;
  private readonly noiseTexture: THREE.DataTexture;
  private readonly sandNormal: THREE.DataTexture;

  /** TSL entry points; built once, reused by every consumer. */
  private readonly nodes: NoiseNodes;

  private readonly uCausticsStrength = uniform(1);
  private causticsNode: Node = null;
  private disposed = false;

  constructor(extent: number, options: SeafloorOptions = {}) {
    this.extent = extent;
    const segments = options.segments ?? 256;
    const detailTiling = options.detailTiling ?? 7;

    this.noiseTexture = createNoiseTexture();
    this.sandNormal = createSandNormalTexture();
    this.sandNormal.repeat.set(extent / detailTiling, extent / detailTiling);

    this.nodes = buildNoiseNodes(this.noiseTexture);

    this.geometry = new THREE.PlaneGeometry(extent, extent, segments, segments);
    // Bake the flip into the attributes so the position attribute's y really is
    // world up — the displacement loop below depends on that.
    this.geometry.rotateX(-Math.PI / 2);

    const position = this.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      position.setY(i, seafloorHeight(position.getX(i), position.getZ(i)));
    }
    position.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();

    this.material = new THREE.MeshStandardNodeMaterial();
    this.material.name = 'seafloor-sand';
    this.material.roughness = 0.93;
    this.material.metalness = 0;
    this.material.normalMap = this.sandNormal;
    this.material.normalScale.set(0.75, 0.75);

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'seafloor';
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    // The floor is a single 4 km quad centred on the world; culling it against
    // its own bounding sphere is pure overhead and it is never off screen.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();

    this.rebuildColorNode();
  }

  /** Signed depth below y = 0; positive means that much water above the floor. */
  depthAt(x: number, z: number): number {
    return -seafloorHeight(x, z);
  }

  /**
   * Floor depth as a TSL node, for the water shader's shallow-water tint.
   * `worldPosition` must be a vec3 node; only xz is read.
   */
  depthNode(worldPosition: unknown): unknown {
    const wp = worldPosition as Node;
    return this.nodes.height(vec2(wp.x, wp.z)).negate();
  }

  /** Floor elevation as a TSL node (negative below sea level). */
  heightNode(worldPosition: unknown): unknown {
    const wp = worldPosition as Node;
    return this.nodes.height(vec2(wp.x, wp.z));
  }

  /**
   * Injects the caustics projection. Expected to be centred near 1.0 — it
   * multiplies the sand's lit colour, so 1.0 means "no caustics here".
   * Triggers one shader rebuild; call it at setup, not per frame.
   */
  setCaustics(node: unknown): void {
    this.causticsNode = (node ?? null) as Node;
    this.rebuildColorNode();
  }

  /** Scales the injected caustics without a rebuild. */
  setCausticsStrength(value: number): void {
    this.uCausticsStrength.value = value;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.geometry.dispose();
    this.material.dispose();
    this.noiseTexture.dispose();
    this.sandNormal.dispose();
  }

  // ------------------------------------------------------------------ internals

  private rebuildColorNode(): void {
    const caustics = this.causticsNode;
    const strength = this.uCausticsStrength;
    const valueNoise = this.nodes.valueNoise;

    this.material.colorNode = Fn(() => {
      const wp = positionWorld.toVar();
      const depth = wp.y.negate().toVar();

      // Wet sand is darker and greener than dry; the transition happens over
      // the first couple of metres of water, which is what makes a beach read.
      const dryRock = vec3(0.4, 0.34, 0.26);
      const drySand = vec3(0.74, 0.65, 0.47);
      const wetSand = vec3(0.56, 0.5, 0.36);
      const deepSilt = vec3(0.14, 0.2, 0.22);

      const aboveWater = wp.y.smoothstep(-1.5, 6.0).toVar();
      const submerged = mix(deepSilt, wetSand, smoothstepDown(depth, 4, 70)).toVar();
      const exposed = mix(drySand, dryRock, wp.y.smoothstep(4, 26)).toVar();

      const base = mix(submerged, exposed, aboveWater).toVar();

      // Broad mottling: patches of weed and darker sediment, the dark blotches
      // visible through the shallows in the reference top-down shot.
      const patch = valueNoise(vec2(wp.x, wp.z).mul(1 / 26)).toVar();
      const mottled = base.mul(patch.mul(0.42).add(0.74)).toVar();

      if (caustics === null) return vec4(mottled, 1);

      // Caustics only exist under water, and fade out as the floor gets deep
      // enough that the surface pattern has diverged into ambient light.
      const reach = smoothstepDown(depth, 2, 48).mul(float(1).sub(aboveWater)).toVar();
      const lit = mix(float(1), caustics, reach.mul(strength)).toVar();
      return vec4(mottled.mul(lit), 1);
    })();

    this.material.needsUpdate = true;
  }
}

// -------------------------------------------------------------- TSL heightfield

interface NoiseNodes {
  /** vec2 -> float in [0, 1]. */
  valueNoise: (p: Node) => Node;
  /** vec2 -> float in [0, 1]. */
  fbm: (p: Node) => Node;
  /** World xz (vec2) -> floor elevation in metres. */
  height: (p: Node) => Node;
}

/**
 * Builds the TSL mirror of the CPU heightfield.
 *
 * Everything is expressed as parameterised `Fn`s rather than closures over
 * caller-scope variables. A no-argument `Fn` that reads a `toVar()` declared by
 * its caller is only correct if TSL happens to inline the body; passing the
 * value in as a parameter is correct either way.
 */
function buildNoiseNodes(map: THREE.Texture): NoiseNodes {
  /**
   * Bilinear value noise matching `valueNoise()` above, texel for texel.
   *
   * Explicit LOD 0 on every fetch: the water material may call `depthNode()`
   * from its vertex stage, where implicit derivatives do not exist and an
   * unqualified sample is a WGSL validation error.
   */
  const valueNoise = Fn(([p]: [Node]) => {
    const i = p.floor().toVar();
    const f = p.sub(i).toVar();
    const u = f.mul(f).mul(f.mul(-2).add(3)).toVar();

    const base = i.add(0.5).div(NOISE_SIZE).toVar();
    const step = float(1 / NOISE_SIZE);

    const a = texture(map, base, 0).r.toVar();
    const b = texture(map, base.add(vec2(step, 0)), 0).r.toVar();
    const c = texture(map, base.add(vec2(0, step)), 0).r.toVar();
    const d = texture(map, base.add(vec2(step, step)), 0).r.toVar();

    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  });

  const fbmFn = Fn(([p]: [Node]) => {
    const q = p.toVar();
    const sum = float(0).toVar();
    let amplitude = 1;
    for (let o = 0; o < OCTAVES; o++) {
      sum.addAssign(valueNoise(q).mul(amplitude));
      const rx = q.x.mul(ROT[0]).add(q.y.mul(ROT[1])).toVar();
      const ry = q.x.mul(ROT[2]).add(q.y.mul(ROT[3])).toVar();
      q.assign(
        vec2(
          rx.mul(LACUNARITY).add(OCTAVE_OFFSET[0]),
          ry.mul(LACUNARITY).add(OCTAVE_OFFSET[1]),
        ),
      );
      amplitude *= GAIN;
    }
    return sum.mul(1 / FBM_NORM);
  });

  /** Mirrors `seafloorHeight()` exactly. */
  const height = Fn(([p]: [Node]) => {
    const xz = p.toVar();
    const n = fbmFn(xz.mul(FEATURE_SCALE)).toVar();

    const rOrigin = xz.length().toVar();
    const dIsland = xz.sub(vec2(ISLAND.x, ISLAND.z)).length().toVar();

    const shallowOrigin = float(1).sub(rOrigin.smoothstep(PLATEAU_RADIUS, SHELF_RADIUS)).toVar();
    const shallowIsland = smoothstepDown(dIsland, ISLAND.radius * 0.6, ISLAND.radius * 2.4).toVar();
    const shallowness = shallowOrigin.max(shallowIsland).toVar();

    const y = float(DEEP_Y).add(float(PLATEAU_Y - DEEP_Y).mul(shallowness)).toVar();
    y.addAssign(n.sub(0.5).mul(RELIEF).mul(shallowness.mul(0.65).add(0.35)));
    y.addAssign(float(ISLAND.peak).mul(smoothstepDown(dIsland, ISLAND.radius * 0.18, ISLAND.radius)));
    return y;
  });

  return {
    valueNoise: (p: Node) => valueNoise(p),
    fbm: (p: Node) => fbmFn(p),
    height: (p: Node) => height(p),
  };
}
