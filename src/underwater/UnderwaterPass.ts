import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  exp,
  float,
  interleavedGradientNoise,
  luminance,
  min,
  mix,
  normalize,
  perspectiveDepthToViewZ,
  screenCoordinate,
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

/**
 * The caustics field, as a TSL function of world position.
 *
 * Supplied rather than reimplemented so the shafts in the water and the pattern
 * on the seafloor are the same evaluation of the same field — see
 * `underwater/Caustics`.
 */
export type CausticsField = (worldPosition: unknown, lod?: unknown) => unknown;

/** Hard ceiling on the tap count, for sanity rather than for compilation. */
const MAX_GODRAY_STEPS = 64;

/** ln(10): the extinction that leaves 10% of the contrast at `visibility`. */
const LN10 = 2.302585092994046;

/** Clock wrap, seconds. */
const CLOCK_WRAP = 3600;

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
  /**
   * Brightness of light scattered back out of the medium toward the viewer.
   *
   * 0.36, down from 0.95 and then from 0.55. The inscatter term replaces the
   * scene in proportion to how much the water absorbed, so a bright medium does
   * not just tint the view — it *is* the view at any distance. At 0.95 the
   * submerged scene was a flat teal wash with the seafloor eleven metres away
   * completely invisible; 0.55 still left a hull at ten metres reading as a faint
   * smudge against a milky field, which is what a viewer described as washed out.
   *
   * Real water darkens as it thickens. It does not converge on a bright fog: the
   * limiting colour looking into open water from below is the small fraction of
   * downwelling light that scatters back, and against a sunlit surface directly
   * above, that is a *dark* blue-green, not a pale one. What should be bright is
   * the shafts and the surface itself, both of which are added separately — so
   * lowering this raises the contrast between them and the medium rather than
   * darkening the frame as a whole.
   */
  private readonly uAmbient = uniform(0.36);
  private readonly uCameraDepth = uniform(4);

  // --- volumetric shafts ---------------------------------------------------
  private readonly uGodRayStrength = uniform(0.9);
  // Loosely typed: a uniform used as a dynamic `Loop` bound is not modelled by
  // the TSL typings.
  private readonly uSteps: any = uniform(24, 'int');
  private readonly uInvSteps = uniform(1 / 24);
  private readonly uSunColor = uniform(new THREE.Color(DEFAULT_UNDERWATER_PARAMS.sunColor));
  /** How far along the view ray shafts are integrated, metres. */
  private readonly uShaftRange = uniform(90);
  /**
   * Fraction of the light passing through a metre of water that is scattered
   * toward the viewer — the single-scattering albedo term of the integral.
   *
   * Small, and it has to be. The integral runs over tens of metres and the
   * caustics field averages a few tenths across the cell interiors, not the near
   * zero its thin bright filaments suggest, so the accumulated path radiance
   * lands in the single digits before this term is applied. At 0.55 the whole
   * frame saturated to white. Sea water is a weak forward scatterer and the
   * number should look like one.
   */
  private readonly uShaftDensity = uniform(0.05);
  /** World Y of the mean water surface the shafts descend from. */
  private readonly uSeaLevel = uniform(0);
  private readonly uCaustics = uniform(DEFAULT_UNDERWATER_PARAMS.causticsStrength);
  /**
   * World size of one texel of the caustics field, metres.
   *
   * Pushed in rather than assumed, because it is the caustics module that owns
   * its resolution and extent, and the mip level the march asks for is only
   * correct relative to the real texel size.
   */
  private readonly uCausticsTexel = uniform(320 / 768);

  // --- ray reconstruction ---------------------------------------------------
  // A post pass draws with the post-processor's own orthographic quad camera, so
  // the built-in camera matrix nodes describe that quad and not the scene. Both
  // matrices are therefore pushed explicitly, exactly as `uNear`/`uFar` already
  // are, and for the same reason.
  private readonly uInvProjection = uniform(new THREE.Matrix4());
  private readonly uCameraWorld = uniform(new THREE.Matrix4());
  private readonly uCameraPos = uniform(new THREE.Vector3());

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
  build(scenePassColor: unknown, sceneDepth: unknown, causticsNode: CausticsField): unknown {
    const colorNode: any = scenePassColor;
    const depthNode: any = sceneDepth;
    const caustics = causticsNode as (worldPosition: any, lod?: any) => any;

    if (colorNode === null || colorNode === undefined) {
      throw new Error('UnderwaterPass.build: scenePassColor is required.');
    }
    if (depthNode === null || depthNode === undefined || typeof depthNode.sample !== 'function') {
      throw new Error(
        'UnderwaterPass.build: sceneDepth must be a texture node, e.g. scenePass.getTextureNode( "depth" ).',
      );
    }
    if (typeof caustics !== 'function') {
      throw new Error(
        'UnderwaterPass.build: causticsNode is required — the volumetric shafts are ' +
          'an integral of the caustics field along the view ray, so there is nothing ' +
          'to integrate without it.',
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
        const axialDist = viewDistance(suv).toVar('uwAxial');

        // Beer-Lambert wants the distance the light travelled, and the depth
        // buffer measures along the camera's *forward axis*.
        //
        // Off-centre pixels look further to reach the same axial depth — by
        // `1 / cos(theta)`, which at the edge of a 55-degree vertical field with
        // a 16:9 frame is about 1.25. Using the axial value directly therefore
        // under-absorbed toward the edges of the frame and, worse, made the
        // absorption depend on the field of view: the same scene through a wider
        // lens got clearer water. The shaft march below already made this
        // correction for itself, which is what made the inconsistency visible.
        //
        // Reconstructed from the projection rather than from the pixel angle, so
        // it stays correct if the projection is ever changed.
        const ndc0 = vec2(suv.x.mul(2).sub(1), suv.y.mul(-2).add(1)).toVar('uwNdc0');
        const viewH0 = this.uInvProjection.mul(vec4(ndc0.x, ndc0.y, -1, 1)).toVar('uwViewH0');
        const viewDir0 = normalize(viewH0.xyz.div(viewH0.w)).toVar('uwViewDir0');
        const axialCos = viewDir0.z.negate().max(1e-3).toVar('uwAxialCos');
        const dist = axialDist.div(axialCos).toVar('uwDist');

        // --- 1. transmission -------------------------------------------------
        const transmit = exp(this.uSigma.mul(dist.negate())).toVar('uwT');

        // How much daylight is left at the camera's own depth. Drives both the
        // inscatter brightness and the shaft brightness, so diving gets darker.
        const daylight = exp(this.uSigma.mul(this.uCameraDepth.mul(-0.55))).toVar('uwDay');
        const medium = this.uWaterColor.mul(this.uAmbient).mul(daylight).toVar('uwMedium');

        const fogged = src.rgb.mul(transmit).add(medium.mul(transmit.oneMinus())).toVar('uwFog');

        // --- 2. volumetric shafts --------------------------------------------
        //
        // Marched along the view ray in world space, not smeared radially out
        // from the projected sun.
        //
        // The radial approach is the standard *atmospheric* sun-shaft effect,
        // and underwater it is wrong in three separate ways. Light refracts
        // entering the water, so the apparent sun sits far closer to vertical
        // than the true one and rays that fan from its unrefracted screen
        // position point the wrong way. Real shafts are not a fan at all: they
        // are columns descending from the bright filaments of the surface caustic
        // pattern, so they stay near-vertical however the viewer turns. And a
        // screen-space effect anchored to the sun has to fade out when the sun
        // leaves the frame, whereas shafts are all around a diver and are most
        // visible looking *across* them.
        //
        // So each sample walks back up to the patch of surface that lit it and
        // asks the caustics field how bright that patch is. Shafts and the
        // pattern they cast on the seafloor are then the same light, evaluated
        // in the same place, rather than two effects tuned to resemble each
        // other.
        const rays = vec3(0, 0, 0).toVar('uwRays');

        If(this.uGodRayStrength.greaterThan(0.0001), () => {
          // Rebuild the world-space view ray for this pixel.
          //
          // **NDC y is flipped, and that is not cosmetic.** Screen uv runs
          // top-down on the WebGPU backend and is explicitly flipped to run
          // top-down on the WebGL one, while NDC y runs bottom-up on both — the
          // same asymmetry `clipToScreenUV` in `ScreenSpaceReflection` exists to
          // absorb. Taking `suv.y * 2 - 1` builds a ray pointing *down* wherever
          // the pixel looks up, which sent every shaft the wrong way and was the
          // reason the god rays never converged on the sun.
          const worldDir = normalize(
            this.uCameraWorld.mul(vec4(viewDir0, 0)).xyz,
          ).toVar('uwWorldDir');

          // `dist` is already along this pixel's ray — see the transmission term
          // above, which now makes the same correction rather than leaving the
          // two describing different path lengths.
          const march = min(dist, this.uShaftRange).toVar('uwMarch');
          const stepLength = march.mul(this.uInvSteps).toVar('uwStep');

          // Mip level matched to the march's own sampling rate.
          //
          // The footprint is the step's **horizontal** extent, not its length.
          // The caustics field is a 2D map indexed by world XZ, so a vertical
          // metre of march moves the lookup by nothing at all (bar the sun-shear
          // term, which is far smaller). Using the full 3D step length asked for
          // a coarser level than the sampler needed and over-blurred exactly the
          // near-vertical rays that carry the shafts.
          //
          // `log2(footprint / texel)` is then the level at which one texel spans
          // one step — the Nyquist level for this sampler. Below it the march
          // point-samples a signal it cannot resolve, and because the start
          // offset is an interleaved gradient noise the variance arrives as a
          // stationary screen-space lattice rather than as noise.
          //
          // Backed off to 0.75 of the full level: the exact figure is right for a
          // box filter and this is a trilinear one, which over-blurs slightly.
          const stepHorizontal = stepLength.mul(worldDir.xz.length()).toVar('uwStepH');
          const shaftLod = stepHorizontal
            .div(this.uCausticsTexel)
            .max(1)
            .log2()
            .mul(0.75)
            .max(0)
            .toVar('uwShaftLod');

          // Start the march at a per-pixel fraction of a step. Without it every
          // pixel samples the same set of planes and the shafts show up as
          // concentric bands; the dither trades that for fine noise, which the
          // eye reads as suspended particulate.
          const dither = interleavedGradientNoise(screenCoordinate).toVar('uwDither');
          // `uwMarchT`, not `uwT` — the transmission term above already claims
          // that name, and TSL silently renames the collision rather than
          // failing, which makes the shader harder to read than it needs to be.
          const t = stepLength.mul(dither).toVar('uwMarchT');
          const acc = float(0).toVar('uwAcc');

          Loop(this.uSteps, () => {
            const p = this.uCameraPos.add(worldDir.mul(t)).toVar('uwP');

            // Above the waterline there is no medium to scatter in. Softened
            // rather than a hard cut so a sample crossing the surface does not
            // flicker as the wave moves under it.
            const submerged = this.uSeaLevel.sub(p.y).smoothstep(-0.4, 0.4).toVar('uwSub');

            // The caustics field already carries its own extinction from the
            // surface down to the sample, so this is the light *arriving* here.
            // What it does not know is how much survives the trip back to the
            // eye, which is the second term.
            const arriving = caustics(p, shaftLod).mul(submerged);
            const toEye = exp(this.uSigma.mul(t.negate()));

            acc.addAssign(arriving.mul(toEye.g).mul(stepLength));
            t.addAssign(stepLength);
          });

          // `acc` is a Riemann sum weighted by `stepLength`, so it is already an
          // integral over path length and does not get divided by anything —
          // dividing by the range would turn it back into an average and throw
          // away the very accumulation that makes a shaft brighter the further
          // you look along it. What it is missing is the fraction of that light
          // actually scattered toward the eye per metre, which is what
          // `uShaftDensity` supplies. Because the sum carries `stepLength`,
          // changing the tier's step count changes only the sampling noise, not
          // the brightness.
          rays.assign(
            this.uSunColor
              .mul(acc.mul(this.uShaftDensity))
              .mul(this.uGodRayStrength)
              .mul(daylight),
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
  /** World metres per texel of the caustics field. See `uCausticsTexel`. */
  setCausticsTexelSize(metres: number): void {
    this.uCausticsTexel.value = Math.max(1e-3, metres);
  }

  setCamera(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera): void {
    this.camera = camera;
  }

  /** Rewinds the animation clock, for reproducible captures. */
  resetClock(time = 0): void {
    this.clock = ((time % CLOCK_WRAP) + CLOCK_WRAP) % CLOCK_WRAP;
    this.uTime.value = this.clock;
  }

  update(dt: number): void {
    if (this.disposed) return;
    this.clock = (this.clock + dt) % CLOCK_WRAP;
    this.uTime.value = this.clock;

    const camera = this.camera;
    if (camera === null) return;

    this.uNear.value = camera.near;
    this.uFar.value = camera.far;

    // Everything the shaft march needs to turn a screen uv back into a world ray.
    // `matrixWorld` is read rather than recomputed: the camera has already been
    // updated for this frame by the director, and the post pass runs after it.
    camera.updateMatrixWorld();
    (this.uInvProjection.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (this.uCameraWorld.value as THREE.Matrix4).copy(camera.matrixWorld);
    (this.uCameraPos.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld);
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

    const steps = Math.max(0, Math.min(MAX_GODRAY_STEPS, Math.round(p.godRaySteps)));
    // steps === 0 is the Low tier: the march must cost nothing at all.
    this.uGodRayStrength.value = steps > 0 ? Math.max(0, p.godRayStrength) : 0;
    this.uSteps.value = Math.max(1, steps);
    this.uInvSteps.value = 1 / Math.max(1, steps);

    // How far the shafts are integrated. Tied to visibility because there is no
    // point marching through water the medium has already made opaque: past
    // roughly two visibility lengths the transmittance term has closed the
    // contribution down to nothing and the samples are pure cost.
    this.uShaftRange.value = Math.max(12, Math.min(180, p.visibility * 2.2));

    this.uCaustics.value = Math.max(0, p.causticsStrength);
  }
}

function clampNumber(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

