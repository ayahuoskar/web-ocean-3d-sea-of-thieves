import * as THREE from 'three/webgpu';
import {
  Fn,
  clamp,
  exp,
  float,
  int,
  mx_worley_noise_float,
  pow,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';

/**
 * Procedural light caustics.
 *
 * The classic interlocking-web look comes from cellular (worley) noise rather
 * than from a scrolling texture: the distance-to-nearest-feature field of a
 * jittered point lattice already has exactly the right topology — closed cells
 * separated by thin bright ridges. Two octaves at different scales, drifting in
 * different directions, are multiplied together so the ridges of one break the
 * ridges of the other into the short, restless arcs real caustics have. A power
 * curve then crushes the midtones so only the ridges survive.
 *
 * Everything is a pure function of world position, so the same node can be
 * dropped into a seafloor material, a rock material and a hull material and the
 * pattern stays continuous across all of them — there is no projection texture
 * and no second render pass to keep in sync.
 *
 * Refraction at the surface is approximated by shearing the sample coordinate
 * along the sun's tilt: a point `d` metres below the surface is lit by the patch
 * of surface at `xz + (sunDir.xz / sunDir.y) * d`, which is what makes caustics
 * slide sideways as the sun moves toward the horizon.
 *
 * No textures, no render targets, no compute — this compiles to WGSL and GLSL
 * alike and costs one worley evaluation per octave per shaded fragment.
 */

export interface CausticsParams {
  /** Peak intensity of the web, before depth fade. */
  strength: number;
  /** Cells per metre. Larger = finer, busier caustics. */
  scale: number;
  /** Animation rate of the cell drift. */
  speed: number;
  /** Extinction per metre applied to the caustic below the surface. */
  depthFade: number;
  /** Exponent of the sharpening curve. Higher = thinner, brighter filaments. */
  sharpness: number;
  /** World Y of the water surface the caustics are cast from. */
  surfaceLevel: number;
}

export const DEFAULT_CAUSTICS_PARAMS: CausticsParams = {
  strength: 1.0,
  scale: 0.34,
  speed: 0.35,
  depthFade: 0.055,
  sharpness: 9,
  surfaceLevel: 0,
};

/** Clock wrap, seconds — long enough to be invisible, short enough for float32. */
const CLOCK_WRAP = 3600;

/** The sun tilt is clamped so a sun near the horizon cannot shear to infinity. */
const MAX_TILT = 3;

export class Caustics {
  private readonly params: CausticsParams;

  // --- uniforms ------------------------------------------------------------
  private readonly uTime = uniform(0);
  private readonly uStrength = uniform(DEFAULT_CAUSTICS_PARAMS.strength);
  private readonly uScale = uniform(DEFAULT_CAUSTICS_PARAMS.scale);
  private readonly uSpeed = uniform(DEFAULT_CAUSTICS_PARAMS.speed);
  private readonly uDepthFade = uniform(DEFAULT_CAUSTICS_PARAMS.depthFade);
  private readonly uSharpness = uniform(DEFAULT_CAUSTICS_PARAMS.sharpness);
  private readonly uSurfaceY = uniform(DEFAULT_CAUSTICS_PARAMS.surfaceLevel);
  /** Metres of horizontal shear per metre of depth, from the sun's elevation. */
  private readonly uSunTilt = uniform(new THREE.Vector2(0, 0));

  /**
   * The node graph, built exactly once. TSL functions are lazily compiled at
   * shader build time, so constructing this in the constructor is safe even
   * though there is no assign stack yet.
   */
  private readonly fn: any;

  private clock = 0;
  private disposed = false;

  constructor() {
    this.params = { ...DEFAULT_CAUSTICS_PARAMS };

    this.fn = Fn(([worldPosition]: any) => {
      const p = vec3(worldPosition).toVar('causticsP');

      // Depth below the surface; above water there is nothing to cast.
      const below = this.uSurfaceY.sub(p.y).max(0.0).toVar('causticsDepth');

      // Walk the refracted ray back up to the surface patch that lit this point.
      const surfaceXZ = vec2(p.x, p.z).add(this.uSunTilt.mul(below)).mul(this.uScale);

      const t = this.uTime.mul(this.uSpeed);

      // Octave A: the large cells. Time is the third noise axis, so the pattern
      // boils rather than sliding rigidly.
      // `mx_worley_noise_float` is overloaded on the point type; the typings
      // only model the two-argument form, hence the loose view.
      const worley = mx_worley_noise_float as unknown as (
        p: unknown,
        jitter: number,
        metric: unknown,
      ) => any;

      const a = worley(vec3(surfaceXZ.x, surfaceXZ.y, t), 1.0, int(0));

      // Octave B: finer, counter-drifting, offset so the lattices never align.
      const q = surfaceXZ.mul(1.87).add(vec2(13.7, -5.3));
      const b = worley(vec3(q.x, q.y, t.mul(-1.43).add(31.0)), 1.0, int(0));

      // The filaments live where the two distance fields agree: `a - b == 0` is
      // a set of curves through the plane, and because the two lattices have
      // different scales and drift in opposite directions those curves close on
      // themselves and cross — which is exactly the interlocking web. Raising it
      // to a high power is what turns a broad ramp into a thin bright line.
      const filament = pow(clamp(float(1).sub(a.sub(b).abs()), 0.0, 1.0), this.uSharpness);

      // A much dimmer pool of light inside each cell, so the web sits on top of
      // a soft dapple instead of floating on black.
      const ridgeA = clamp(float(1).sub(a), 0.0, 1.0);
      const ridgeB = clamp(float(1).sub(b), 0.0, 1.0);
      const dapple = pow(ridgeA.mul(ridgeB), 2.5).mul(0.45);

      const web = filament.add(dapple);

      const fade = exp(below.mul(this.uDepthFade).negate());

      return web.mul(this.uStrength).mul(fade);
    });

    this.setSunDirection(new THREE.Vector3(0.35, 0.62, 0.7));
  }

  /**
   * Caustic intensity, in the range `[0, strength]`, at a world-space point.
   *
   * Pure: the result depends only on `worldPosition` and the uniforms, so it can
   * be shared by any number of materials.
   *
   * @param worldPosition A `vec3` node — typically `positionWorld`.
   */
  intensityNode(worldPosition: unknown): unknown {
    return this.fn(worldPosition);
  }

  setParams(p: Partial<CausticsParams>): void {
    if (p.strength !== undefined) this.params.strength = p.strength;
    if (p.scale !== undefined) this.params.scale = p.scale;
    if (p.speed !== undefined) this.params.speed = p.speed;
    if (p.depthFade !== undefined) this.params.depthFade = p.depthFade;
    if (p.sharpness !== undefined) this.params.sharpness = p.sharpness;
    if (p.surfaceLevel !== undefined) this.params.surfaceLevel = p.surfaceLevel;

    this.uStrength.value = Math.max(0, this.params.strength);
    this.uScale.value = Math.max(1e-4, this.params.scale);
    this.uSpeed.value = this.params.speed;
    this.uDepthFade.value = Math.max(0, this.params.depthFade);
    this.uSharpness.value = Math.max(1, this.params.sharpness);
    this.uSurfaceY.value = this.params.surfaceLevel;
  }

  getParams(): Readonly<CausticsParams> {
    return this.params;
  }

  /** `dir` points *toward* the sun and need not be normalised. */
  setSunDirection(dir: THREE.Vector3): void {
    // A sun below ~9 degrees would shear the projection arbitrarily far; clamp
    // the elevation rather than the result so the tilt stays continuous.
    const y = Math.max(0.15, Math.abs(dir.y));
    const tilt = this.uSunTilt.value;
    tilt.set(
      clampNumber(dir.x / y, -MAX_TILT, MAX_TILT),
      clampNumber(dir.z / y, -MAX_TILT, MAX_TILT),
    );
  }

  update(dt: number): void {
    if (this.disposed) return;
    this.clock = (this.clock + dt) % CLOCK_WRAP;
    this.uTime.value = this.clock;
  }

  /**
   * Nothing here owns a GPU resource — the pattern is arithmetic, and the node
   * graph is owned by whichever material referenced it. `dispose` only latches
   * the clock so a stale reference cannot keep animating.
   */
  dispose(): void {
    this.disposed = true;
  }
}

function clampNumber(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
