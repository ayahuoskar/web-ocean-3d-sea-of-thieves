import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  exp,
  float,
  interleavedGradientNoise,
  mx_fractal_noise_float,
  normalize,
  perspectiveDepthToViewZ,
  pow,
  screenCoordinate,
  select,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

/**
 * Volumetric sea fog, as a post-processing node graph.
 *
 * The medium is an exponential height layer: extinction is `density` at
 * `baseHeight` and falls off with an e-folding height of `heightFalloff`, so the
 * fog pools on the water and thins with altitude. That single property is what
 * separates sea fog from a haze — from the deck you are inside it and the
 * horizon is gone; from a mast or an orbit camera you are above it looking down
 * at a bank with a top surface.
 *
 * Three things are integrated along each view ray:
 *
 *   1. **Transmittance, analytically.** For a medium whose density varies only
 *      with height, the optical depth along a straight ray has a closed form
 *      (see `medium` below) — no march required. So how much of the scene
 *      survives the fog is *exact*, at every quality tier, and identical whether
 *      the march runs 8 steps or 48. This matters more than it sounds: the tier
 *      drops on its own when frames get long, and a fog whose thickness visibly
 *      changed with the step count would turn an invisible quality change into an
 *      obvious one. It also means the effect has no banding in its opacity at
 *      all, which is where a naive volumetric normally shows its steps first.
 *
 *   2. **In-scattering, marched.** What the march is actually for is the part
 *      that is *not* analytic: how the light reaching each point along the ray
 *      varies. Two terms do the work. The sun's transmittance down to a sample
 *      is itself a closed-form height integral (`sigma * H / sun.y`), so fog deep
 *      in the layer is lit far less than fog near its top — the bank glows along
 *      its upper surface and goes blue-grey inside, with no shadow map and no
 *      secondary march. And a Henyey–Greenstein lobe on the angle between the
 *      view ray and the sun makes looking toward the sun through fog bloom, while
 *      looking away from it stays flat and cool. The phase term is constant along
 *      the ray for a directional light, so it is evaluated once per pixel rather
 *      than once per step.
 *
 *   3. **An analytic tail.** Past `maxDistance` the march stops, but the fog does
 *      not, and stopping the integral there would leave a visible shell at that
 *      radius. The remaining segment is closed out with `L * (T(end) - T(scene))`,
 *      the exact single-scatter integral for a segment lit uniformly, which costs
 *      two exponentials once per pixel and makes `maxDistance` a pure performance
 *      control with no visual signature.
 *
 * Banks are a two-octave procedural field modulating the *scattering*, not the
 * extinction. That is a deliberate approximation and worth being honest about:
 * modulating extinction would make the banks vary in opacity, which is more
 * correct, but it also destroys the closed-form transmittance that item 1 is
 * built on and hands the banding back. What varies most visibly in real fog at
 * any distance is which patches are catching the light, and that is exactly what
 * modulating the scattered radiance reproduces — at the cost of a silhouette that
 * is smoother than the interior.
 *
 * Nothing here is temporally jittered. The published froxel solutions
 * (Wronski 2014, Hillaire 2015) reproject and jitter across frames because they
 * are backed by a TAA resolve; this project has none, so a temporal offset would
 * be a shimmer with nothing to average it away. The march start is dithered
 * spatially only, with interleaved gradient noise against the pixel coordinate.
 *
 * The whole graph is built once. Every tunable is a uniform, including the march
 * step count (a dynamic `Loop` bound, as the tier changes it), so nothing here
 * ever recompiles. The march is procedural throughout — no 3D noise texture, so
 * nothing to allocate, upload or keep resident, and nothing that would need a
 * storage or compute path on WebGL2.
 *
 * Backend note: a post-processing pass is drawn with an internal fullscreen quad
 * and its own orthographic camera, so the built-in `cameraNear` / `cameraFar` /
 * `cameraProjectionMatrix` nodes would resolve to *that* quad, not the scene's.
 * The scene camera is therefore supplied explicitly via `setCamera` and its
 * near/far, inverse projection and world matrix are pushed into uniforms each
 * frame — the same approach `PassNode` takes internally, and the same one
 * `UnderwaterPass` in this project already takes for its shaft march.
 */

/**
 * TSL node objects are structurally dynamic; the generated types cannot express
 * a uniform whose component type is only known at construction, nor one used as
 * a dynamic loop bound. Node-typed fields are therefore `any` by design — the
 * class's public API stays typed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface VolumetricFogParams {
  /**
   * Extinction per metre at `baseHeight`, the densest point of the layer.
   * 0 disables the effect entirely. Roughly, visibility at the base is `1/density`
   * metres, so 0.0075 is a few hundred metres of sea room.
   */
  density: number;
  /** World Y the layer sits on. Mean sea level, normally. */
  baseHeight: number;
  /** e-folding height of the layer in metres. Small = a low bank, large = haze. */
  heightFalloff: number;
  /** Colour of the sky-lit scattering — the fog's own colour away from the sun. */
  color: THREE.Color;
  /** Brightness of that sky-lit term. 1 makes the far field settle on `color`. */
  ambient: number;
  /** Unit vector *toward* the sun. */
  sunDirection: THREE.Vector3;
  sunColor: THREE.Color;
  /** Brightness of the directional in-scattering that produces the sun bloom. */
  sunIntensity: number;
  /** Henyey–Greenstein g. Positive is forward scattering; ~0.7 for fog droplets. */
  anisotropy: number;
  /** Metres. Bounds the march only — beyond it the analytic tail takes over. */
  maxDistance: number;
  /** 0..1 strength of the procedural bank variation. 0 skips it per step. */
  detail: number;
  /** Horizontal feature size of the banks, metres. */
  detailScale: number;
  /** Drift speed of the banks, m/s. Slow — fog is not weather in a hurry. */
  windSpeed: number;
  /** Drift bearing, radians. */
  windDirection: number;
  /** March steps. 0 disables the effect, like `density` 0. */
  steps: number;
}

export const DEFAULT_VOLUMETRIC_FOG_PARAMS: VolumetricFogParams = {
  density: 0.0075,
  baseHeight: 0,
  heightFalloff: 18,
  color: new THREE.Color(0xb6c6d4),
  ambient: 0.9,
  sunDirection: new THREE.Vector3(0.35, 0.62, 0.7).normalize(),
  sunColor: new THREE.Color(0xffe9cf),
  sunIntensity: 0.55,
  anisotropy: 0.72,
  maxDistance: 1500,
  detail: 0.55,
  detailScale: 130,
  windSpeed: 2.2,
  windDirection: 2.6,
  steps: 24,
};

/** Hard ceiling on the loop the shader is compiled with. */
const MAX_STEPS = 64;

/** Clock wrap, seconds. Matches the other animated systems. */
const CLOCK_WRAP = 3600;

/**
 * Floor on |k| = |ray.y * t / H| in the closed-form optical depth.
 *
 * The integral carries a removable singularity at k = 0 — a perfectly horizontal
 * ray, where the exact answer is simply `sigma * t`. Clamping the *dimensionless*
 * k rather than the ray slope bounds the error independently of how far the ray
 * runs: below 1e-4 the ratio `(1 - exp(-k)) / k` is within 5e-5 of 1, which is
 * the limit it is heading for anyway. Clamping the slope instead would let the
 * error grow with distance, and near-horizontal rays are exactly the ones that
 * run furthest.
 */
const K_EPSILON = 1e-4;

/**
 * Ceiling on the exponent inside the optical depth, and on the depth itself.
 *
 * A ray pointing down through an exponential layer accumulates density
 * exponentially, and the sky depth this pass sees is the camera's far plane —
 * tens of kilometres. Without a cap the intermediate `exp` overflows to infinity
 * and the fog comes out NaN instead of opaque. exp(-40) is 4e-18; anything past
 * that is opaque by any measure a half-float framebuffer can hold.
 */
const EXP_CEIL = 32;
const TAU_CEIL = 40;

/**
 * Effective sky path length as a multiple of the straight-up path, for the
 * ambient self-shadow.
 *
 * The honest quantity is the average of `1/cos(theta)` over the hemisphere,
 * which diverges — grazing sky directions see an unbounded slab. Any usable
 * number is therefore a choice, not a derivation, and 1.0 is chosen low on
 * purpose: this term exists to give the bank an interior that is darker than its
 * top, not to extinguish it. At 2.0 a merely moderate fog went to slate.
 */
const AMBIENT_PATH = 1.0;

/**
 * Clamp on the Henyey–Greenstein lobe, relative to isotropic.
 *
 * At g = 0.72 the raw forward value is ~22x isotropic. On a cloud that spike is
 * confined to the silver lining along an edge; here it is multiplying a
 * full-screen integral, and unclamped it turns the quarter of the sky around the
 * sun into flat white. 6x still reads as a distinct bloom against the 0.1x floor
 * behind the viewer — a 60x range, which is more contrast than the phase
 * function is actually being asked to sell.
 */
const PHASE_MIN = 0.1;
const PHASE_MAX = 6;

/** Vertical feature size as a fraction of the horizontal one — banks are flat. */
const DETAIL_ASPECT = 0.22;

export class VolumetricFog {
  private readonly params: VolumetricFogParams;

  private camera: THREE.PerspectiveCamera | null = null;
  private clock = 0;
  private cameraHeight = 0;
  private disposed = false;

  /** Wind as a world vector, metres per second. Reused — never reallocated. */
  private readonly windVector = new THREE.Vector3(1, 0, 0);

  // --- medium ---------------------------------------------------------------
  /**
   * Extinction per metre at the base of the layer. Also the ceiling the marched
   * density is clamped to; see `medium`.
   */
  private readonly uSigmaBase = uniform(DEFAULT_VOLUMETRIC_FOG_PARAMS.density);
  /**
   * Extinction per metre at the camera's own height.
   *
   * Derived on the CPU each frame because the camera position is known there,
   * which keeps one exponential out of every pixel. It is computed from the
   * camera height *clamped to the base*, so a camera that drops below sea level
   * cannot make the layer denser than its own floor — the profile grows without
   * bound downward and there is no fog under the water anyway.
   */
  private readonly uSigmaOrigin = uniform(DEFAULT_VOLUMETRIC_FOG_PARAMS.density);
  private readonly uHeight = uniform(DEFAULT_VOLUMETRIC_FOG_PARAMS.heightFalloff);
  private readonly uInvHeight = uniform(1 / DEFAULT_VOLUMETRIC_FOG_PARAMS.heightFalloff);
  private readonly uMaxDistance = uniform(DEFAULT_VOLUMETRIC_FOG_PARAMS.maxDistance);

  // --- lighting -------------------------------------------------------------
  private readonly uColor = uniform(new THREE.Color(DEFAULT_VOLUMETRIC_FOG_PARAMS.color));
  private readonly uAmbient = uniform(DEFAULT_VOLUMETRIC_FOG_PARAMS.ambient);
  private readonly uSunDir = uniform(new THREE.Vector3(0.35, 0.62, 0.7).normalize());
  private readonly uSunColor = uniform(new THREE.Color(DEFAULT_VOLUMETRIC_FOG_PARAMS.sunColor));
  /** Sun brightness, already faded out by elevation — see `applyParams`. */
  private readonly uSunIntensity = uniform(DEFAULT_VOLUMETRIC_FOG_PARAMS.sunIntensity);
  private readonly uAnisotropy = uniform(DEFAULT_VOLUMETRIC_FOG_PARAMS.anisotropy);
  /** Sun path length as a multiple of the vertical one: 1 / max(sun.y, floor). */
  private readonly uSunPath = uniform(1.5);

  // --- banks ----------------------------------------------------------------
  private readonly uDetail = uniform(DEFAULT_VOLUMETRIC_FOG_PARAMS.detail);
  /** Reciprocal feature size per axis, so the noise lookup is a multiply. */
  private readonly uDetailScale = uniform(new THREE.Vector3());
  /** Reciprocal of the step length at which bank detail is fully faded out. */
  private readonly uDetailLod = uniform(1 / 78);
  /** Accumulated drift, metres. Added before scaling, so it stays a world offset. */
  private readonly uWindOffset = uniform(new THREE.Vector3());

  // --- march ----------------------------------------------------------------
  /**
   * 1 when the effect should run at all, 0 when it must cost a single compare.
   * Uniform across the draw, so the branch is coherent for every wave on the GPU.
   */
  private readonly uEnabled = uniform(1);
  // Loosely typed: a uniform used as a dynamic `Loop` bound is not modelled by
  // the TSL typings.
  private readonly uSteps: any = uniform(DEFAULT_VOLUMETRIC_FOG_PARAMS.steps, 'int');
  private readonly uInvSteps = uniform(1 / DEFAULT_VOLUMETRIC_FOG_PARAMS.steps);

  // --- ray reconstruction ---------------------------------------------------
  // A post pass draws with the post-processor's own orthographic quad camera, so
  // the built-in camera matrix nodes describe that quad and not the scene. Both
  // matrices are pushed explicitly, exactly as `uNear`/`uFar` are, and for the
  // same reason.
  private readonly uInvProjection = uniform(new THREE.Matrix4());
  private readonly uCameraWorld = uniform(new THREE.Matrix4());
  private readonly uCameraPos = uniform(new THREE.Vector3());
  private readonly uNear = uniform(0.1);
  private readonly uFar = uniform(40000);

  constructor() {
    this.params = {
      ...DEFAULT_VOLUMETRIC_FOG_PARAMS,
      color: DEFAULT_VOLUMETRIC_FOG_PARAMS.color.clone(),
      sunDirection: DEFAULT_VOLUMETRIC_FOG_PARAMS.sunDirection.clone(),
      sunColor: DEFAULT_VOLUMETRIC_FOG_PARAMS.sunColor.clone(),
    };
    this.applyParams();
  }

  /**
   * Wraps a scene colour node and its depth texture.
   *
   * @param sceneColor A colour node. Either a texture node — e.g.
   *                   `scenePass.getTextureNode()` — in which case it is sampled
   *                   at this pixel's uv, or any already-composited colour node,
   *                   such as the output of another pass, in which case it is
   *                   used as-is. That second form is what lets this sit anywhere
   *                   in the chain.
   * @param sceneDepth The *depth texture* node, e.g.
   *                   `scenePass.getTextureNode( 'depth' )`. It must be a texture
   *                   node: the march is bounded by where the scene stops, and a
   *                   pre-linearised scalar node cannot be sampled at this pass's
   *                   own uv.
   * @returns The fogged node, to hand to `RenderPipeline.outputNode` or to the
   *          next pass in the chain.
   */
  build(sceneColor: unknown, sceneDepth: unknown): unknown {
    const colorNode: any = sceneColor;
    const depthNode: any = sceneDepth;

    if (colorNode === null || colorNode === undefined) {
      throw new Error('VolumetricFog.build: sceneColor is required.');
    }
    if (depthNode === null || depthNode === undefined || typeof depthNode.sample !== 'function') {
      throw new Error(
        'VolumetricFog.build: sceneDepth must be a texture node, e.g. scenePass.getTextureNode( "depth" ).',
      );
    }

    // `isTextureNode` rather than a duck-typed `.sample`: TSL registers method
    // chaining globally, so *every* node object answers to `.sample` whether or
    // not sampling it means anything.
    const isTexture = colorNode.isTextureNode === true;
    // PassTextureNode leaves `uvNode` null and falls back to the quad's uv.
    const baseUv: any = (isTexture ? colorNode.uvNode : null) ?? uv();

    return Fn(() => {
      const suv = vec2(baseUv).toVar('fogUv');
      const src = (isTexture ? colorNode.sample(suv) : vec4(colorNode)).toVar('fogSrc');
      const outRgb = vec3(src.rgb).toVar('fogOut');

      // Uniform-coherent branch: with the fog off the whole pass is one compare
      // and a copy.
      If(this.uEnabled.greaterThan(0.5), () => {
        // --- the view ray, in world space ------------------------------------
        const ndc = suv.mul(2).sub(1).toVar('fogNdc');
        const viewH = this.uInvProjection.mul(vec4(ndc.x, ndc.y, -1, 1)).toVar('fogViewH');
        const viewDir = normalize(viewH.xyz.div(viewH.w)).toVar('fogViewDir');
        const rd = normalize(this.uCameraWorld.mul(vec4(viewDir, 0)).xyz).toVar('fogRd');

        // The depth buffer measures along the camera's forward axis; the ray
        // needs it along *this* pixel's direction, which is longer off-centre.
        // Sky pixels come back at the far plane, which is what we want: looking
        // at nothing means looking through the entire depth of the layer.
        const axial = viewDir.z.negate().max(1e-3).toVar('fogAxial');
        const sceneZ = perspectiveDepthToViewZ(
          depthNode.sample(suv).r,
          this.uNear,
          this.uFar,
        ).negate();
        const dist = sceneZ.div(axial).max(0).toVar('fogDist');

        // Rate of change of the height exponent per metre travelled. The whole
        // closed form is a function of this and the origin density.
        const slope = rd.y.mul(this.uInvHeight).toVar('fogSlope');
        const sigmaOrigin = this.uSigmaOrigin;

        // --- transmittance, in closed form -----------------------------------
        const toScene = this.medium(dist, sigmaOrigin, slope);
        const transmittance = toScene.transmittance.toVar('fogT');

        const tEnd = dist.min(this.uMaxDistance).toVar('fogEnd');
        const atEnd = this.medium(tEnd, sigmaOrigin, slope);

        // --- the phase lobe, once for the whole ray --------------------------
        // A directional sun subtends the same scattering angle at every point on
        // a straight ray, so this is a per-pixel constant and has no business
        // inside the loop.
        const phase = henyeyGreenstein(rd.dot(this.uSunDir), this.uAnisotropy)
          .clamp(PHASE_MIN, PHASE_MAX)
          .toVar('fogPhase');

        // --- in-scattering ---------------------------------------------------
        //
        // Samples are distributed as t = tEnd * s^2 rather than uniformly. The
        // weight this integral carries is sigma(t) * T(t), and both factors are
        // largest near the camera — one because the viewer is usually inside the
        // layer, the other because transmittance only ever falls. Uniform steps
        // spend most of their samples out where the integrand has already decayed
        // to nothing. This is the same reasoning behind the exponential depth
        // slices of a froxel volume, minus the volume.
        //
        // The partition stays exact: cell i spans s in [i/N, (i+1)/N], so its
        // length in t is tEnd * (2i + 1) / N^2, and the dither only chooses where
        // *within* that cell the single sample lands. Step count therefore
        // changes the noise, never the total.
        const dither = interleavedGradientNoise(screenCoordinate).toVar('fogDither');
        const cell = tEnd.mul(this.uInvSteps).mul(this.uInvSteps).toVar('fogCell');
        const acc = vec3(0, 0, 0).toVar('fogAcc');

        Loop(this.uSteps, ({ i }: any) => {
          const s = float(i).add(dither).mul(this.uInvSteps).toVar('fogS');
          const t = tEnd.mul(s).mul(s).toVar('fogT2');
          const dt = cell.mul(float(i).mul(2).add(1)).toVar('fogDt');

          const m = this.medium(t, sigmaOrigin, slope);
          const sigma = m.sigma.toVar('fogSigma');

          const light = this.lightAt(sigma, phase).toVar('fogLight');

          If(this.uDetail.greaterThan(0.001), () => {
            const p = this.uCameraPos.add(rd.mul(t)).toVar('fogP');
            const q = p.add(this.uWindOffset).mul(this.uDetailScale).toVar('fogQ');
            // Two octaves. Three or more would be prettier and this is the one
            // place in the loop that could plausibly cost real time — a previous
            // effect in this project evaluated two 3D lattices per step and took
            // the frame from milliseconds to seconds.
            const n = mx_fractal_noise_float(q, 2, 2.0, 0.5, 1.0).toVar('fogN');

            // Detail the march cannot resolve is not detail, it is noise. Cells
            // grow quadratically toward the far end of the march, and past
            // roughly the feature size the bank field is being point-sampled far
            // below its Nyquist rate — which shows up as the banks crawling as
            // the camera turns. Fade it out with the cell size instead. Same
            // reasoning as the cloud layer's detail fade.
            const lod = float(1).sub(dt.mul(this.uDetailLod)).clamp(0, 1).toVar('fogLod');
            light.mulAssign(float(1).add(n.mul(this.uDetail).mul(lod)).clamp(0.05, 2.2));
          });

          acc.addAssign(light.mul(sigma).mul(m.transmittance).mul(dt));
        });

        // --- the tail past the march -----------------------------------------
        // For a segment lit uniformly, the single-scatter integral of
        // `sigma * T` collapses to the difference of the transmittances at its
        // ends. Exact, two exponentials, and it is the reason `maxDistance` can
        // be lowered for performance without carving a visible shell out of the
        // horizon.
        const tailLight = this.lightAt(atEnd.sigma, phase);
        const tail = tailLight.mul(atEnd.transmittance.sub(transmittance).max(0));

        outRgb.assign(src.rgb.mul(transmittance).add(acc).add(tail));
      });

      return vec4(outRgb, src.a);
    })();
  }

  setParams(params: Partial<VolumetricFogParams>): void {
    const p = this.params;
    if (params.color !== undefined) p.color.copy(params.color);
    if (params.sunDirection !== undefined) p.sunDirection.copy(params.sunDirection);
    if (params.sunColor !== undefined) p.sunColor.copy(params.sunColor);
    if (params.density !== undefined) p.density = params.density;
    if (params.baseHeight !== undefined) p.baseHeight = params.baseHeight;
    if (params.heightFalloff !== undefined) p.heightFalloff = params.heightFalloff;
    if (params.ambient !== undefined) p.ambient = params.ambient;
    if (params.sunIntensity !== undefined) p.sunIntensity = params.sunIntensity;
    if (params.anisotropy !== undefined) p.anisotropy = params.anisotropy;
    if (params.maxDistance !== undefined) p.maxDistance = params.maxDistance;
    if (params.detail !== undefined) p.detail = params.detail;
    if (params.detailScale !== undefined) p.detailScale = params.detailScale;
    if (params.windSpeed !== undefined) p.windSpeed = params.windSpeed;
    if (params.windDirection !== undefined) p.windDirection = params.windDirection;
    if (params.steps !== undefined) p.steps = params.steps;
    this.applyParams();
  }

  getParams(): Readonly<VolumetricFogParams> {
    return this.params;
  }

  /**
   * March steps for the current tier. 0 disables the effect entirely.
   *
   * Separate from `setParams` only because the tier changes it on its own
   * schedule, independently of anything an artist touched.
   */
  setSteps(steps: number): void {
    this.params.steps = steps;
    this.applyParams();
  }

  /**
   * The scene camera. Required for depth linearisation and for rebuilding the
   * world-space view ray; see the backend note at the top of this file.
   */
  setCamera(camera: THREE.PerspectiveCamera): void {
    this.camera = camera;
    this.cameraHeight = camera.position.y;
    this.refreshOriginDensity();
  }

  /** Rewinds the drift, for reproducible captures. */
  resetClock(time = 0): void {
    this.clock = ((time % CLOCK_WRAP) + CLOCK_WRAP) % CLOCK_WRAP;
    this.refreshWind();
  }

  update(dt: number): void {
    if (this.disposed) return;
    this.clock = (this.clock + dt) % CLOCK_WRAP;
    this.refreshWind();

    const camera = this.camera;
    if (camera === null) return;

    this.uNear.value = camera.near;
    this.uFar.value = camera.far;

    // `matrixWorld` is read rather than recomputed: the camera has already been
    // updated for this frame by the director, and the post pass runs after it.
    camera.updateMatrixWorld();
    (this.uInvProjection.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (this.uCameraWorld.value as THREE.Matrix4).copy(camera.matrixWorld);
    const origin = this.uCameraPos.value as THREE.Vector3;
    origin.setFromMatrixPosition(camera.matrixWorld);

    if (origin.y !== this.cameraHeight) {
      this.cameraHeight = origin.y;
      this.refreshOriginDensity();
    }
  }

  /**
   * The pass owns no geometry, material, texture or render target — it
   * contributes a node graph to whichever pipeline consumed it, and that owns the
   * compiled material. `dispose` therefore only stops the clock so a stale
   * reference cannot keep driving uniforms.
   */
  dispose(): void {
    this.disposed = true;
    this.camera = null;
  }

  // -------------------------------------------------------------------------

  /**
   * The medium sampled along a ray, at distance `t`.
   *
   * For density that varies only with height, `sigma(y) = sigma_b * exp(-(y - base) / H)`,
   * the optical depth along a ray leaving `y0` with vertical slope `dy` is
   *
   *   tau(t) = sigma_0 * (1 - exp(-k)) / (dy / H),   k = t * dy / H
   *
   * with `sigma_0` the extinction at the origin. Written as `sigma_0 * t * (1 - exp(-k)) / k`
   * so the ill-behaved factor is the dimensionless `(1 - exp(-k)) / k`, whose
   * limit at k = 0 is 1 — a horizontal ray through a constant column, which is
   * simply `sigma_0 * t`. See K_EPSILON for how that limit is reached safely.
   *
   * The exponential is shared: `exp(-k)` is both the density ratio and the
   * numerator of the optical depth, so the pair costs two exponentials rather
   * than three. `sigma` is clamped at the layer's base value, which makes the
   * profile a constant slab below `baseHeight` instead of an unbounded one —
   * there is no fog under the water, and the unbounded form would otherwise
   * dominate any ray that dipped below the surface.
   *
   * Returned as a plain object rather than a struct-typed `Fn` so both fields
   * inline at all three call sites without needing a declared TSL layout.
   */
  private medium(t: any, sigmaOrigin: any, slope: any): { sigma: any; transmittance: any } {
    const k = slope.mul(t).toVar();
    const magnitude = k.abs().max(K_EPSILON);
    const kSafe = select(k.lessThan(0), magnitude.negate(), magnitude).toVar();

    const decay = exp(kSafe.negate().min(EXP_CEIL)).toVar();
    const tau = sigmaOrigin.mul(t).mul(float(1).sub(decay)).div(kSafe);

    return {
      sigma: sigmaOrigin.mul(decay).min(this.uSigmaBase),
      transmittance: exp(tau.clamp(0, TAU_CEIL).negate()),
    };
  }

  /**
   * Radiance scattered toward the viewer from a point of extinction `sigma`.
   *
   * `sigma * H` is the optical depth from that point straight up to the top of
   * the layer — the same closed form as `medium`, evaluated for a vertical ray
   * of infinite length, where it collapses to a single multiply. Scaling it by
   * `1 / sun.y` gives the depth along the slanted path to the sun, and by a fixed
   * factor gives a stand-in for the sky. Two exponentials, and the bank gets a
   * lit top and a shadowed interior without a shadow map or a secondary march.
   *
   * The approximation is the usual planar one: it ignores the planet's curvature
   * and it integrates to infinity rather than to the top of a finite layer, both
   * of which are exact enough for a medium whose scale height is tens of metres.
   * It does blow up as the sun approaches the horizon, which is why `uSunPath`
   * carries a floor rather than a raw reciprocal.
   */
  private lightAt(sigma: any, phase: any): any {
    const vertical = sigma.mul(this.uHeight).toVar();
    const sky = exp(vertical.mul(AMBIENT_PATH).negate());
    const sun = exp(vertical.mul(this.uSunPath).negate());
    return this.uColor
      .mul(this.uAmbient)
      .mul(sky)
      .add(this.uSunColor.mul(this.uSunIntensity).mul(phase).mul(sun));
  }

  private applyParams(): void {
    const p = this.params;

    const density = Math.max(0, p.density);
    const falloff = Math.max(0.5, p.heightFalloff);
    this.uSigmaBase.value = density;
    this.uHeight.value = falloff;
    this.uInvHeight.value = 1 / falloff;
    this.uMaxDistance.value = Math.max(1, p.maxDistance);

    this.uColor.value.copy(p.color);
    this.uAmbient.value = Math.max(0, p.ambient);
    this.uSunColor.value.copy(p.sunColor);
    this.uAnisotropy.value = clampNumber(p.anisotropy, -0.95, 0.95);

    const sun = this.uSunDir.value as THREE.Vector3;
    sun.copy(p.sunDirection);
    if (sun.lengthSq() < 1e-8) sun.set(0, 1, 0);
    sun.normalize();

    // Once the sun is under the horizon its in-scattering has to go with it, or
    // the fog stays lit like midday against a night sky. Folded into the
    // intensity rather than exposed, so callers only have to push the vector.
    const above = smoothstepScalar(-0.06, 0.12, sun.y);
    this.uSunIntensity.value = Math.max(0, p.sunIntensity) * above;
    // Floored: the slant path to a sun on the horizon is unbounded, and the
    // in-scattering term would go to zero across the whole layer at exactly the
    // elevation where fog is at its most photogenic.
    this.uSunPath.value = 1 / Math.max(0.1, sun.y);

    this.uDetail.value = clampNumber(p.detail, 0, 1);
    const scale = Math.max(4, p.detailScale);
    // Banks are wide and shallow, so the field varies several times faster
    // vertically than horizontally. Without the anisotropy the noise reads as
    // spherical blobs floating in the layer rather than as stratified fog.
    (this.uDetailScale.value as THREE.Vector3).set(
      1 / scale,
      1 / (scale * DETAIL_ASPECT),
      1 / scale,
    );
    // Bank detail is gone by the time a march cell spans much of a feature.
    this.uDetailLod.value = 1 / (scale * 0.6);

    this.windVector.set(Math.cos(p.windDirection), 0, Math.sin(p.windDirection));
    this.windVector.multiplyScalar(Math.max(0, p.windSpeed));
    this.refreshWind();

    const steps = Math.max(0, Math.min(MAX_STEPS, Math.round(p.steps)));
    // steps === 0 is the Low tier, and density === 0 is the UI slider at rest:
    // either has to cost a single compare, not a march that adds nothing.
    this.uEnabled.value = steps > 0 && density > 0 ? 1 : 0;
    this.uSteps.value = Math.max(1, steps);
    this.uInvSteps.value = 1 / Math.max(1, steps);

    this.refreshOriginDensity();
  }

  /** The world offset applied to the bank field. Negated so banks drift *with* the wind. */
  private refreshWind(): void {
    (this.uWindOffset.value as THREE.Vector3)
      .copy(this.windVector)
      .multiplyScalar(-this.clock);
  }

  private refreshOriginDensity(): void {
    const p = this.params;
    const falloff = Math.max(0.5, p.heightFalloff);
    const above = Math.max(0, this.cameraHeight - p.baseHeight);
    this.uSigmaOrigin.value = Math.max(0, p.density) * Math.exp(-above / falloff);
  }
}

/**
 * Henyey–Greenstein phase, normalised so that isotropic scattering is exactly 1.
 *
 * The usual 1/(4*pi) normalisation integrates to one over the sphere, which is
 * correct but leaves every value two orders of magnitude below the radiance it
 * multiplies. Scaling by 4*pi expresses the lobe as a factor *relative to
 * isotropic*, so g = 0 leaves the in-scattering exactly as it was and the
 * anisotropy control only ever redistributes it.
 */
function henyeyGreenstein(cosTheta: any, g: any): any {
  const g2 = g.mul(g);
  const denom = pow(float(1).add(g2).sub(cosTheta.mul(g).mul(2)).max(1e-4), 1.5);
  return float(1).sub(g2).div(denom);
}

function clampNumber(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstepScalar(edge0: number, edge1: number, x: number): number {
  const t = clampNumber((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
