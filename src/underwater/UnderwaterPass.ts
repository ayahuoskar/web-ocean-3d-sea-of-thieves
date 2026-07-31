import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  atan,
  clamp,
  exp,
  float,
  length,
  luminance,
  max,
  mix,
  mx_noise_float,
  perspectiveDepthToViewZ,
  screenSize,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

/**
 * The submerged look, as a post-processing node graph.
 *
 * Three layers, composited in this order:
 *
 *   1. Beer–Lambert extinction along the view ray, per colour channel. Red is
 *      absorbed roughly five times faster than blue in sea water, and that
 *      asymmetry — not the fog colour itself — is what makes an image read as
 *      *underwater* rather than as a scene with blue fog in it.
 *   2. God rays: a screen-space radial accumulation from the projected sun,
 *      masked by the depth buffer so the shafts stop dead against near geometry
 *      (the hull) and only survive where the buffer is far away. The shaft
 *      source is striated with a noise field in polar coordinates around the
 *      sun, which is what gives the fan its individual blades.
 *   3. A blue-shifted grade with a depth-driven loss of saturation and contrast,
 *      standing in for the multiply-scattered light that fills the shadows.
 *
 * Everything cross-fades on `submersion`, and at `submersion === 0` the final
 * `mix` returns the input colour bit-for-bit, so a surface crossing is
 * continuous and the pass is free to stay in the chain permanently.
 *
 * The whole graph is built once. Every tunable is a uniform, including the
 * god-ray tap count (a dynamic loop bound, as `QualityManager.godRaySteps`
 * changes with the tier), so nothing here ever recompiles.
 *
 * Backend note: a post-processing pass is drawn with an internal fullscreen quad
 * and its own orthographic camera, so the built-in `cameraNear` / `cameraFar` /
 * `cameraProjectionMatrix` nodes would resolve to *that* camera, not the scene's.
 * The scene camera is therefore supplied explicitly via `setCamera`, and its
 * near/far and the projected sun position are pushed into uniforms each frame —
 * the same approach `PassNode` itself takes internally.
 */

export interface UnderwaterParams {
  /** 0 = fully above water, 1 = fully submerged. Cross-fade, never a hard cut. */
  submersion: number;
  /** Hue of the medium. */
  waterColor: THREE.Color;
  /** Beer–Lambert extinction per metre, per channel. */
  extinction: THREE.Vector3;
  /** Metres to ~10% contrast. */
  visibility: number;
  godRayStrength: number;
  /** 0 disables. */
  godRaySteps: number;
  sunDirection: THREE.Vector3;
  sunColor: THREE.Color;
  /** Depth of the camera below the surface, metres — drives light falloff. */
  cameraDepth: number;
  causticsStrength: number;
}

export const DEFAULT_UNDERWATER_PARAMS: UnderwaterParams = {
  submersion: 0,
  waterColor: new THREE.Color(0x1a5e7a),
  extinction: new THREE.Vector3(0.115, 0.031, 0.021),
  visibility: 38,
  godRayStrength: 0.9,
  godRaySteps: 24,
  sunDirection: new THREE.Vector3(0.35, 0.62, 0.7).normalize(),
  sunColor: new THREE.Color(0xd8f0ff),
  cameraDepth: 4,
  causticsStrength: 0.35,
};

/** Hard ceiling on the tap count, for sanity rather than for compilation. */
const MAX_GODRAY_STEPS = 64;

/** ln(10): the extinction that leaves 10% of the contrast at `visibility`. */
const LN10 = 2.302585092994046;

/** Clock wrap, seconds. */
const CLOCK_WRAP = 3600;

/** Reused scratch — `update` must not allocate. */
const _sunView = new THREE.Vector3();
const _sunClip = new THREE.Vector3();

export class UnderwaterPass {
  private readonly params: UnderwaterParams;

  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera | null = null;
  private clock = 0;
  private disposed = false;

  // --- medium --------------------------------------------------------------
  private readonly uSubmersion = uniform(0);
  private readonly uWaterColor = uniform(new THREE.Color(DEFAULT_UNDERWATER_PARAMS.waterColor));
  /** Total extinction per metre per channel: absorption + the visibility floor. */
  private readonly uSigma = uniform(new THREE.Vector3(0.2, 0.09, 0.08));
  /** Brightness of light scattered back out of the medium toward the viewer. */
  private readonly uAmbient = uniform(0.95);
  private readonly uCameraDepth = uniform(4);

  // --- god rays ------------------------------------------------------------
  private readonly uGodRayStrength = uniform(0.9);
  // Loosely typed: a uniform used as a dynamic `Loop` bound is not modelled by
  // the TSL typings.
  private readonly uSteps: any = uniform(24, 'int');
  private readonly uInvSteps = uniform(1 / 24);
  private readonly uDecay = uniform(0.965);
  /** Fraction of the distance to the sun that the march covers. */
  private readonly uRayDensity = uniform(0.9);
  private readonly uSunColor = uniform(new THREE.Color(DEFAULT_UNDERWATER_PARAMS.sunColor));
  /** Projected sun position in the pass's uv space. */
  private readonly uSunScreen = uniform(new THREE.Vector2(0.5, 0.5));
  /** 1 when the sun is in front of the camera and roughly on screen. */
  private readonly uSunVisible = uniform(0);
  /** Depth window over which a shaft is unmasked by the geometry behind it. */
  private readonly uMaskNear = uniform(13);
  private readonly uMaskFar = uniform(46);
  private readonly uCaustics = uniform(DEFAULT_UNDERWATER_PARAMS.causticsStrength);

  // --- grade ---------------------------------------------------------------
  private readonly uTint = uniform(new THREE.Vector3(0.84, 0.99, 1.08));
  private readonly uDesaturate = uniform(0.2);
  private readonly uContrastLoss = uniform(0.12);

  // --- camera --------------------------------------------------------------
  private readonly uNear = uniform(0.1);
  private readonly uFar = uniform(40000);
  private readonly uTime = uniform(0);

  constructor() {
    this.params = {
      ...DEFAULT_UNDERWATER_PARAMS,
      waterColor: DEFAULT_UNDERWATER_PARAMS.waterColor.clone(),
      extinction: DEFAULT_UNDERWATER_PARAMS.extinction.clone(),
      sunDirection: DEFAULT_UNDERWATER_PARAMS.sunDirection.clone(),
      sunColor: DEFAULT_UNDERWATER_PARAMS.sunColor.clone(),
    };
    this.applyParams();
  }

  /**
   * Wraps a scene pass.
   *
   * @param scenePassColor The colour texture node, e.g. `scenePass.getTextureNode()`.
   * @param sceneDepth     The *depth texture* node, e.g. `scenePass.getTextureNode('depth')`.
   *                       It must be a texture node — the pass re-samples it at
   *                       offset coordinates to mask the shafts, which a
   *                       pre-linearised scalar node cannot support.
   * @returns The graded node to hand to `PostProcessing.outputNode`.
   */
  build(scenePassColor: unknown, sceneDepth: unknown): unknown {
    const colorNode: any = scenePassColor;
    const depthNode: any = sceneDepth;

    if (colorNode === null || colorNode === undefined) {
      throw new Error('UnderwaterPass.build: scenePassColor is required.');
    }
    if (depthNode === null || depthNode === undefined || typeof depthNode.sample !== 'function') {
      throw new Error(
        'UnderwaterPass.build: sceneDepth must be a texture node, e.g. scenePass.getTextureNode( "depth" ).',
      );
    }

    // PassTextureNode leaves `uvNode` null and falls back to the quad's uv.
    const baseUv: any = colorNode.uvNode ?? uv();

    /** Distance from the camera to the nearest surface at a screen uv, metres. */
    const viewDistance = (p: any): any =>
      perspectiveDepthToViewZ(depthNode.sample(p).r, this.uNear, this.uFar).negate();

    return Fn(() => {
      const suv = vec2(baseUv).toVar('uwUv');
      const src = colorNode.sample(suv).toVar('uwSrc');
      const outRgb = vec3(src.rgb).toVar('uwOut');

      // Uniform-coherent branch: above water the whole effect costs one compare.
      If(this.uSubmersion.greaterThan(0.001), () => {
        // Sky pixels come back at `far`, which is exactly right here: looking at
        // "nothing" underwater means looking at an infinite column of water.
        const dist = viewDistance(suv).toVar('uwDist');

        // --- 1. transmission -------------------------------------------------
        const transmit = exp(this.uSigma.mul(dist.negate())).toVar('uwT');

        // How much daylight is left at the camera's own depth. Drives both the
        // inscatter brightness and the shaft brightness, so diving gets darker.
        const daylight = exp(this.uSigma.mul(this.uCameraDepth.mul(-0.55))).toVar('uwDay');
        const medium = this.uWaterColor.mul(this.uAmbient).mul(daylight).toVar('uwMedium');

        const fogged = src.rgb.mul(transmit).add(medium.mul(transmit.oneMinus())).toVar('uwFog');

        // --- 2. god rays -----------------------------------------------------
        const rays = vec3(0, 0, 0).toVar('uwRays');

        If(this.uGodRayStrength.mul(this.uSunVisible).greaterThan(0.0001), () => {
          const aspect = screenSize.x.div(max(screenSize.y, 1.0));
          const sun = vec2(this.uSunScreen).toVar('uwSun');

          const delta = sun.sub(suv).mul(this.uInvSteps).mul(this.uRayDensity).toVar('uwDelta');
          const cur = vec2(suv).toVar('uwCur');
          const weight = float(1).toVar('uwWeight');
          const acc = float(0).toVar('uwAcc');

          Loop(this.uSteps, () => {
            cur.addAssign(delta);

            // Polar coordinates about the sun, corrected for pixel aspect so the
            // fan is circular rather than elliptical.
            const rel = cur.sub(sun).mul(vec2(aspect, 1.0));
            const r = length(rel);

            // Brightness of the shaft source: a wide glow around the sun...
            const core = exp(r.mul(r).mul(-3.0));
            // ...striated into individual blades by an angular noise field. The
            // slow third axis makes the blades breathe as the surface moves.
            const angle = atan(rel.y, rel.x);
            const streak = mx_noise_float(
              vec3(angle.mul(7.0), r.mul(2.4), this.uTime.mul(0.07)),
            )
              .mul(0.5)
              .add(0.5);

            // Occlusion: a shaft only exists where nothing near blocks it.
            const tap = clamp(cur, vec2(0, 0), vec2(1, 1));
            const open = smoothstep(this.uMaskNear, this.uMaskFar, viewDistance(tap));

            acc.addAssign(core.mul(mix(float(0.22), float(1.0), streak)).mul(open).mul(weight));
            weight.mulAssign(this.uDecay);
          });

          acc.mulAssign(this.uInvSteps);

          // The surface lens focuses and defocuses the shafts; this is the same
          // phenomenon as the caustics on the floor, so it shares their strength.
          const flicker = float(1).add(
            mx_noise_float(vec3(suv.x.mul(6.0), suv.y.mul(6.0), this.uTime.mul(0.5))).mul(
              this.uCaustics,
            ),
          );

          rays.assign(
            this.uSunColor
              .mul(acc)
              .mul(this.uGodRayStrength)
              .mul(this.uSunVisible)
              .mul(daylight)
              .mul(max(flicker, 0.0)),
          );
        });

        const lit = fogged.add(rays).toVar('uwLit');

        // --- 3. grade --------------------------------------------------------
        // Depth robs the image of saturation first and of contrast second; both
        // are driven from `cameraDepth` on the CPU side.
        const grey = vec3(luminance(lit));
        const flat = mix(lit, grey, this.uDesaturate);
        const lifted = mix(flat, medium.mul(1.2), this.uContrastLoss);
        const tinted = lifted.mul(this.uTint);

        outRgb.assign(mix(src.rgb, tinted, this.uSubmersion));
      });

      return vec4(outRgb, src.a);
    })();
  }

  setParams(params: Partial<UnderwaterParams>): void {
    const p = this.params;
    if (params.waterColor !== undefined) p.waterColor.copy(params.waterColor);
    if (params.extinction !== undefined) p.extinction.copy(params.extinction);
    if (params.sunDirection !== undefined) p.sunDirection.copy(params.sunDirection);
    if (params.sunColor !== undefined) p.sunColor.copy(params.sunColor);
    if (params.submersion !== undefined) p.submersion = params.submersion;
    if (params.visibility !== undefined) p.visibility = params.visibility;
    if (params.godRayStrength !== undefined) p.godRayStrength = params.godRayStrength;
    if (params.godRaySteps !== undefined) p.godRaySteps = params.godRaySteps;
    if (params.cameraDepth !== undefined) p.cameraDepth = params.cameraDepth;
    if (params.causticsStrength !== undefined) p.causticsStrength = params.causticsStrength;
    this.applyParams();
  }

  getParams(): Readonly<UnderwaterParams> {
    return this.params;
  }

  /**
   * The scene camera. Required for depth linearisation and for projecting the
   * sun; see the backend note at the top of this file.
   */
  setCamera(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera): void {
    this.camera = camera;
  }

  update(dt: number): void {
    if (this.disposed) return;
    this.clock = (this.clock + dt) % CLOCK_WRAP;
    this.uTime.value = this.clock;

    const camera = this.camera;
    if (camera === null) return;

    this.uNear.value = camera.near;
    this.uFar.value = camera.far;

    // Project the sun onto the pass's uv space. A direction is transformed into
    // view space and pushed out along itself; `applyMatrix4` then does the
    // perspective divide. NDC maps to uv without a Y flip, because the pass
    // samples with the quad's own uv attribute (origin bottom-left), which is
    // the same handedness as NDC on both backends.
    _sunView.copy(this.params.sunDirection).normalize().transformDirection(camera.matrixWorldInverse);

    // The camera looks down -Z in view space, so anything with z >= 0 is behind
    // it and would project to a mirrored, meaningless point.
    const facing = -_sunView.z;
    if (facing <= 1e-4) {
      this.uSunVisible.value = 0;
      return;
    }

    _sunClip.copy(_sunView).multiplyScalar(1000).applyMatrix4(camera.projectionMatrix);
    const sx = _sunClip.x * 0.5 + 0.5;
    const sy = _sunClip.y * 0.5 + 0.5;
    this.uSunScreen.value.set(sx, sy);

    // Fade the shafts out as the sun leaves the frame rather than cutting them.
    const outside = Math.max(Math.abs(sx - 0.5), Math.abs(sy - 0.5)) * 2;
    const onScreen = smoothstepNumber(2.1, 0.95, outside);
    const front = smoothstepNumber(0.0, 0.25, facing);
    this.uSunVisible.value = onScreen * front;
  }

  /**
   * The pass owns no geometry, material or render target — it contributes a node
   * graph to whichever `PostProcessing` instance consumed it, and that owns the
   * compiled material. `dispose` therefore only stops the clock so a stale
   * reference cannot keep driving uniforms.
   */
  dispose(): void {
    this.disposed = true;
    this.camera = null;
  }

  // -------------------------------------------------------------------------

  private applyParams(): void {
    const p = this.params;

    this.uSubmersion.value = clampNumber(p.submersion, 0, 1);
    this.uWaterColor.value.copy(p.waterColor);
    this.uSunColor.value.copy(p.sunColor);

    // `extinction` is the per-channel colour of the absorption; `visibility` is
    // the achromatic scattering floor that sets the overall range. Adding them
    // keeps both controls meaningful instead of one overriding the other.
    const floorSigma = LN10 / Math.max(1, p.visibility);
    this.uSigma.value.set(
      Math.max(0, p.extinction.x) + floorSigma,
      Math.max(0, p.extinction.y) + floorSigma,
      Math.max(0, p.extinction.z) + floorSigma,
    );

    const depth = Math.max(0, p.cameraDepth);
    this.uCameraDepth.value = depth;

    // Grade strength ramps over the first ~40 m of descent and then holds.
    const descent = Math.min(1, depth / 40);
    this.uDesaturate.value = 0.14 + 0.3 * descent;
    this.uContrastLoss.value = 0.08 + 0.24 * descent;

    // Shafts must clear the near geometry; tie the mask window to visibility so
    // a murkier medium does not simply hide them.
    this.uMaskNear.value = Math.max(2, p.visibility * 0.34);
    this.uMaskFar.value = Math.max(4, p.visibility * 1.2);

    const steps = Math.max(0, Math.min(MAX_GODRAY_STEPS, Math.round(p.godRaySteps)));
    // steps === 0 is the Low tier: the march must cost nothing at all.
    this.uGodRayStrength.value = steps > 0 ? Math.max(0, p.godRayStrength) : 0;
    this.uSteps.value = Math.max(1, steps);
    this.uInvSteps.value = 1 / Math.max(1, steps);
    // More taps means each contributes less, so decay has to lengthen with them.
    this.uDecay.value = Math.pow(0.42, 1 / Math.max(1, steps));

    this.uCaustics.value = Math.max(0, p.causticsStrength);
  }
}

function clampNumber(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** GLSL `smoothstep` semantics, including the reversed-edge case. */
function smoothstepNumber(edge0: number, edge1: number, x: number): number {
  const t = clampNumber((x - edge0) / (edge1 - edge0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}
