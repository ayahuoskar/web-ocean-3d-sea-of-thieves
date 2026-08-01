import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  cameraPosition,
  float,
  linearDepth,
  mix,
  normalize,
  positionLocal,
  positionWorld,
  screenUV,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
  viewportDepthTexture,
  viewportSafeUV,
  viewportSharedTexture,
} from 'three/tsl';

export interface WaterAppearance {
  /** Colour of light that survives deep transmission — the "body" of the water. */
  deepColor: THREE.Color;
  /** Colour in shallow water where the floor is close. */
  shallowColor: THREE.Color;
  /** Colour of light scattered back out of wave crests. */
  scatterColor: THREE.Color;
  foamColor: THREE.Color;
  /** Beer–Lambert extinction per metre, per channel. Higher = murkier. */
  extinction: THREE.Vector3;
  /** Strength of the subsurface glow on backlit crests. */
  scatterStrength: number;
  /** Base roughness of the microfacet surface. */
  roughness: number;
  /** Jacobian value at which foam starts to appear. Lower = less foam. */
  foamThreshold: number;
  /** Width of the fold range over which foam ramps from none to full. */
  foamSoftness: number;
}

export const DEFAULT_APPEARANCE: WaterAppearance = {
  deepColor: new THREE.Color(0x03202f),
  shallowColor: new THREE.Color(0x168f92),
  scatterColor: new THREE.Color(0x2fae9c),
  foamColor: new THREE.Color(0xeff8ff),
  extinction: new THREE.Vector3(0.34, 0.11, 0.07),
  scatterStrength: 1.0,
  roughness: 0.075,
  // Deeper folding required than the naive "J < 1" test: the swell cascade marks
  // broad areas as mildly folded, and treating all of that as whitecap covers a
  // fifth of the sea in white.
  foamThreshold: 0.24,
  foamSoftness: 0.55,
};

export interface OceanMaterialInputs {
  displacementTextures: THREE.Texture[];
  derivativeTextures: THREE.Texture[];
  tileSizes: number[];
  /**
   * Optional: a node returning the seafloor's depth below y=0 at a world
   * position. Supplying it switches the transmission term from a view-angle
   * approximation to a real water-column thickness, which is what produces the
   * turquoise-over-sand shallows and the hard read of a drop-off.
   */
  floorDepthNode?: ((worldPosition: any) => any) | null;
  /**
   * World-anchored foam accumulation buffer, from `physics/Wake`.
   *
   * `texture` is the resolved output target, whose reference is stable for the
   * lifetime of the buffer, so it is safe to bind once here at build time. The
   * buffer's *centre* moves every frame and is pushed in through
   * `setFoamCenter`; `extent` is the world size of the square it covers and is
   * fixed, so it is baked in as a constant rather than carried as a uniform.
   */
  foam?: { texture: THREE.Texture; extent: number } | null;
  /**
   * Planar reflection texture node, from `ocean/Reflections`.
   *
   * Omitted rather than mixed out where it is not wanted. Whether the reflection
   * exists is a *backend* decision, known once at startup and never revisited,
   * so it belongs in the graph's construction — leaving the node in and weighting
   * it to zero would still pay for the second view of the scene every frame.
   * Per-tier strength, which does change at runtime, is a uniform.
   */
  reflectionNode?: unknown | null;
}

/**
 * Physically motivated water surface.
 *
 * Layers, in the order they combine:
 *   transmission  Beer–Lambert absorption along the view path through water
 *   scattering    a wrapped term that brightens crests when the sun is behind
 *                 them — what gives real water its jade glow
 *   reflection    sky through a Schlick Fresnel term
 *   specular      GGX highlight for the sun disc
 *   foam          Jacobian-driven whitecaps composited on top
 */
/**
 * Cascade slots the shader is always built with.
 *
 * Fixed rather than derived from the active tier, so a tier change re-points
 * texture bindings instead of recompiling the graph. Matches `CASCADES` in
 * `Spectrum`; a tier asking for more than this would silently lose bands, so the
 * two are asserted equal at construction.
 */
const MAX_CASCADES = 3;

export class OceanMaterial {
  readonly material: THREE.MeshBasicNodeMaterial;

  // Cascade bindings, re-pointed by `setCascades` rather than rebuilt.
  private readonly displacementNodes: any[] = [];
  private readonly derivativeNodes: any[] = [];
  private readonly uTileSizes: any[] = [];
  private readonly uCascadeWeights: any[] = [];

  // --- appearance ----------------------------------------------------------
  private readonly uDeepColor = uniform(new THREE.Color(DEFAULT_APPEARANCE.deepColor));
  private readonly uShallowColor = uniform(new THREE.Color(DEFAULT_APPEARANCE.shallowColor));
  private readonly uScatterColor = uniform(new THREE.Color(DEFAULT_APPEARANCE.scatterColor));
  private readonly uFoamColor = uniform(new THREE.Color(DEFAULT_APPEARANCE.foamColor));
  private readonly uExtinction = uniform(new THREE.Vector3().copy(DEFAULT_APPEARANCE.extinction));
  private readonly uScatterStrength = uniform(DEFAULT_APPEARANCE.scatterStrength);
  private readonly uRoughness = uniform(DEFAULT_APPEARANCE.roughness);
  private readonly uFoamThreshold = uniform(DEFAULT_APPEARANCE.foamThreshold);
  private readonly uFoamSoftness = uniform(DEFAULT_APPEARANCE.foamSoftness);

  // --- environment ---------------------------------------------------------
  private readonly uSunDirection = uniform(new THREE.Vector3(0.4, 0.5, 0.3).normalize());
  private readonly uSunColor = uniform(new THREE.Color(1.0, 0.94, 0.84));
  private readonly uSunIntensity = uniform(4.0);
  /**
   * How lit the scene is, 0..1, independent of the key light's colour.
   *
   * Terms that represent transmitted or scattered daylight — as opposed to
   * authored body colour — are scaled by this so they go out after dark.
   */
  private readonly uLightLevel = uniform(1);
  private readonly uSkyColor = uniform(new THREE.Color(0x5793d0));
  private readonly uHorizonColor = uniform(new THREE.Color(0xbdd6ec));
  private readonly uFogColor = uniform(new THREE.Color(0xb9d2e8));
  private readonly uFogDensity = uniform(0.00016);
  private readonly uDisplacementScale = uniform(1);

  // The ocean mesh is translated each frame to follow the camera. `positionLocal`
  // is pre-transform, so the vertex stage needs that translation to reconstruct a
  // stable world-space sample coordinate for the wave field.
  private readonly uOffsetX = uniform(0);
  private readonly uOffsetZ = uniform(0);

  /** Metres of screen-space offset applied to the refracted sample, at unit distance. */
  private readonly uRefractionStrength = uniform(0.22);
  /**
   * How much of the transmitted colour comes from the real scene behind the
   * surface, as opposed to the analytic body colour. 0 restores the pre-refraction
   * look exactly, which is what the WebGL2 fallback and Low tier use.
   */
  private readonly uRefractionAmount = uniform(1);
  /**
   * Camera far minus near, in metres.
   *
   * `linearDepth` normalises to the 0..1 range the camera spans, so a depth
   * difference has to be scaled by that span to become a thickness. Pushed as a
   * uniform rather than read from a camera node because this material is also
   * built for a WebGL2 path where the two must agree exactly.
   */
  private readonly uDepthRange = uniform(40000);

  /** Rain rate, 0..1. Drives how many lattice cells are producing impacts. */
  private readonly uRainIntensity = uniform(0);
  /** Strength of the impact slope perturbation. */
  private readonly uRainSlope = uniform(0.32);
  /** Rain clock, seconds. Separate from the wave clock so it can be frozen. */
  private readonly uRainTime = uniform(0);

  /** How much of the planar reflection reaches the surface, 0..1. */
  private readonly uReflectionAmount = uniform(1);
  /** Screen-space offset applied to the reflection lookup, at unit distance. */
  private readonly uReflectionDistortion = uniform(0.09);

  /** World centre of the foam accumulation buffer. See `setFoamCenter`. */
  private readonly uFoamCenter = uniform(new THREE.Vector2());
  /** How strongly accumulated foam reads against the surface, 0..1. */
  private readonly uFoamStrength = uniform(1);

  constructor(inputs: OceanMaterialInputs) {
    this.material = new THREE.MeshBasicNodeMaterial();
    this.material.side = THREE.DoubleSide; // visible from below when submerged
    this.material.name = 'ocean-water';

    // Transparent so the surface is drawn *after* the opaque scene and can read
    // it as a backdrop — that read is the whole basis of refraction, and before
    // the opaque pass there is simply nothing behind the water to sample.
    //
    // Depth is still written, unusually for a transparent material, because
    // everything downstream depends on the water having a position: the
    // underwater pass linearises this depth to bound its shaft march, and without
    // it the shafts would run straight through the surface to the sky.
    this.material.transparent = true;
    this.material.depthWrite = true;

    this.build(inputs);
  }

  // ---------------------------------------------------------------- accessors

  /**
   * The key light: whichever body is actually casting, at its real strength.
   *
   * `lightLevel` is separate from `intensity` because the two do different jobs.
   * `intensity` scales the specular highlight, which is a reflection of the light
   * source and so follows its brightness directly. `lightLevel` scales terms that
   * represent daylight having passed *through* the water, which have to go out
   * after dark but should not track a bright low sun the way a highlight does.
   */
  setSun(direction: THREE.Vector3, color: THREE.Color, intensity: number, lightLevel = 1): void {
    (this.uSunDirection.value as THREE.Vector3).copy(direction).normalize();
    (this.uSunColor.value as THREE.Color).copy(color);
    this.uSunIntensity.value = intensity;
    this.uLightLevel.value = Math.max(0, Math.min(1, lightLevel));
  }

  setSky(sky: THREE.Color, horizon: THREE.Color, fog: THREE.Color, fogDensity: number): void {
    (this.uSkyColor.value as THREE.Color).copy(sky);
    (this.uHorizonColor.value as THREE.Color).copy(horizon);
    (this.uFogColor.value as THREE.Color).copy(fog);
    this.uFogDensity.value = fogDensity;
  }

  setAppearance(a: Partial<WaterAppearance>): void {
    if (a.deepColor) (this.uDeepColor.value as THREE.Color).copy(a.deepColor);
    if (a.shallowColor) (this.uShallowColor.value as THREE.Color).copy(a.shallowColor);
    if (a.scatterColor) (this.uScatterColor.value as THREE.Color).copy(a.scatterColor);
    if (a.foamColor) (this.uFoamColor.value as THREE.Color).copy(a.foamColor);
    if (a.extinction) (this.uExtinction.value as THREE.Vector3).copy(a.extinction);
    if (a.scatterStrength !== undefined) this.uScatterStrength.value = a.scatterStrength;
    if (a.roughness !== undefined) this.uRoughness.value = a.roughness;
    if (a.foamThreshold !== undefined) this.uFoamThreshold.value = a.foamThreshold;
    if (a.foamSoftness !== undefined) this.uFoamSoftness.value = a.foamSoftness;
  }

  setDisplacementScale(value: number): void {
    this.uDisplacementScale.value = value;
  }

  /**
   * Per-tier refraction policy.
   *
   * `amount` 0 drops the surface back to the analytic body colour without
   * recompiling anything — the node graph still contains the backdrop sample, but
   * its contribution is mixed out. That is the WebGL2 and Low-tier path: the
   * depth-buffer read is the part that is least portable, and a tier that cannot
   * afford it gets a coherent image rather than a broken one.
   */
  setRefraction(amount: number, strength = 0.22): void {
    this.uRefractionAmount.value = Math.max(0, Math.min(1, amount));
    this.uRefractionStrength.value = Math.max(0, strength);
  }

  /** Camera far minus near, in metres. See `uDepthRange`. */
  setDepthRange(metres: number): void {
    this.uDepthRange.value = Math.max(1, metres);
  }

  /**
   * Rain striking the surface.
   *
   * `time` is passed rather than integrated internally so the impacts share the
   * simulation clock — which is what lets a deterministic capture reproduce the
   * same rings, and what makes the rain stop when the world is paused.
   */
  setRain(intensity: number, time: number, slope = 0.32): void {
    this.uRainIntensity.value = Math.max(0, Math.min(1, intensity));
    this.uRainTime.value = time;
    this.uRainSlope.value = Math.max(0, slope);
  }

  /** Per-tier reflection strength. No effect when built without a reflection. */
  setReflection(amount: number, distortion = 0.09): void {
    this.uReflectionAmount.value = Math.max(0, Math.min(1, amount));
    this.uReflectionDistortion.value = Math.max(0, distortion);
  }

  /** Must be called with the ocean mesh's world translation every frame. */
  setWorldOffset(x: number, z: number): void {
    this.uOffsetX.value = x;
    this.uOffsetZ.value = z;
  }

  /**
   * Must be called with the foam buffer's world centre every frame.
   *
   * The buffer is anchored in the world and scrolls under a moving centre, so
   * the surface can only find the right texel if it is told where the buffer
   * currently sits. Getting this wrong does not fail loudly — the wake simply
   * slides around relative to the hull, which is the one thing a wake must
   * never do.
   */
  setFoamCenter(x: number, z: number): void {
    const centre = this.uFoamCenter.value as THREE.Vector2;
    centre.x = x;
    centre.y = z;
  }

  setFoamStrength(value: number): void {
    this.uFoamStrength.value = value;
  }

  dispose(): void {
    this.material.dispose();
  }

  // ----------------------------------------------------------------- internals

  /**
   * Rebinds the wave field without rebuilding the shader.
   *
   * A quality change recreates the simulation's render targets, so the surface
   * has to be pointed at the new ones. It used to be reconstructed wholesale for
   * that, which was wrong three ways: the node graph recompiled mid-session,
   * every rebuild had to remember to re-supply every input (and one of them
   * silently didn't — see `floorDepthNode`), and once the surface began sampling
   * the framebuffer for refraction each rebuild leaked the backdrop texture that
   * came with it, measured at forty textures over eight tier changes.
   *
   * The graph is therefore built once for the maximum cascade count and the
   * texture nodes are re-pointed here. Cascades the current tier does not use are
   * bound to a live texture and weighted to zero — binding nothing is not an
   * option, since a sampler with no texture is a validation error even when its
   * result is multiplied away.
   */
  setCascades(
    displacementTextures: THREE.Texture[],
    derivativeTextures: THREE.Texture[],
    tileSizes: number[],
  ): void {
    const active = Math.min(displacementTextures.length, MAX_CASCADES);
    for (let i = 0; i < MAX_CASCADES; i++) {
      const source = Math.min(i, active - 1);
      this.displacementNodes[i].value = displacementTextures[source];
      this.derivativeNodes[i].value = derivativeTextures[source];
      this.uTileSizes[i].value = tileSizes[source];
      this.uCascadeWeights[i].value = i < active ? 1 : 0;
    }
  }

  private build(inputs: OceanMaterialInputs): void {
    const { displacementTextures, derivativeTextures, tileSizes } = inputs;
    const floorDepth = inputs.floorDepthNode ?? null;
    const foam = inputs.foam ?? null;
    const planar = (inputs.reflectionNode ?? null) as any;

    // The graph is always built for the maximum cascade count; `setCascades`
    // decides how many of them contribute.
    const cascadeCount = MAX_CASCADES;
    for (let i = 0; i < MAX_CASCADES; i++) {
      const source = Math.min(i, displacementTextures.length - 1);
      this.displacementNodes.push(texture(displacementTextures[source]) as any);
      this.derivativeNodes.push(texture(derivativeTextures[source]) as any);
      this.uTileSizes.push(uniform(tileSizes[source]));
      this.uCascadeWeights.push(uniform(i < displacementTextures.length ? 1 : 0));
    }

    // ------------------------------------------------------------- vertex stage
    this.material.positionNode = Fn(() => {
      const local = positionLocal.toVar();
      const worldXZ = vec2(local.x.add(this.uOffsetX), local.z.add(this.uOffsetZ)).toVar();

      // The mesh is centred on the camera, so local XZ length is the ground
      // distance from the viewer in metres.
      const groundDistance = vec2(local.x, local.z).length().toVar();

      const displacement = vec3(0).toVar();

      // Fade the highest-frequency cascades out with distance. Beyond a few
      // hundred metres their wavelength is well under a pixel, and keeping them
      // only produces aliasing that no amount of MSAA will fix.
      for (let i = 0; i < cascadeCount; i++) {
        const sample = this.displacementNodes[i]
          .sample(worldXZ.div(this.uTileSizes[i]))
          .toVar();
        displacement.addAssign(
          sample.xyz
            .mul(cascadeGeometryFade(groundDistance, i, cascadeCount))
            .mul(this.uCascadeWeights[i]),
        );
      }

      displacement.mulAssign(this.uDisplacementScale);

      return vec3(local.x.add(displacement.x), displacement.y, local.z.add(displacement.z));
    })();

    // ----------------------------------------------------------- fragment stage
    this.material.colorNode = Fn(() => {
      const worldPos = positionWorld.toVar();
      const viewVector = cameraPosition.sub(worldPos).toVar();
      const viewDistance = viewVector.length().toVar();
      const viewDir = viewVector.div(viewDistance).toVar();

      // --- surface normal and fold from the derivative fields ----------------
      const slope = vec2(0).toVar();
      // Combine folding across cascades by keeping the most-folded value. Summing
      // would double-count independent bands and wash the whole surface white.
      const fold = float(1).toVar();
      for (let i = 0; i < cascadeCount; i++) {
        const d = this.derivativeNodes[i].sample(worldPos.xz.div(this.uTileSizes[i])).toVar();
        // Weight folds into the fade, so a cascade the tier does not use
        // contributes no slope and — via `mix` toward 1 — no folding either.
        const fade = cascadeShadingFade(viewDistance, i, cascadeCount).mul(
          this.uCascadeWeights[i],
        );
        slope.addAssign(vec2(d.x, d.y).mul(fade));
        fold.assign(fold.min(mix(float(1), d.z, fade)));
      }

      // Rain impacts, added to the wave slope before the normal is built so they
      // ride the surface rather than sitting on a plane over it.
      //
      // Faded out with distance, hard. The rings are decimetre features; past
      // thirty metres or so they are well under a pixel and all they can
      // contribute is aliasing — the same reason the finest wave cascade fades.
      // Behind a uniform branch, so every clear preset pays one compare.
      If(this.uRainIntensity.greaterThan(0.001), () => {
        const nearness = viewDistance.smoothstep(38, 6).clamp(0, 1);
        slope.addAssign(
          rainSlope(worldPos.xz, this.uRainTime, this.uRainIntensity)
            .mul(this.uRainSlope)
            .mul(nearness),
        );
      });

      const normal = normalize(vec3(slope.x.negate(), 1, slope.y.negate())).toVar();

      // Flatten the normal toward vertical with distance. Mip filtering removes
      // most of the undersampling shimmer, but past a few kilometres the residual
      // per-pixel slope variation still sparkles, and real water at that range
      // reads as a smooth sheet anyway.
      const flatten = viewDistance.smoothstep(2500, 9000).clamp(0, 1).toVar();
      const n = normalize(mix(normal, vec3(0, 1, 0), flatten)).toVar();

      const nDotV = n.dot(viewDir).clamp(1e-3, 1).toVar();

      // --- Fresnel (Schlick), F0 for an air/water interface ------------------
      const f0 = float(0.02);
      const oneMinus = float(1).sub(nDotV).toVar();
      const fresnelPow = oneMinus.mul(oneMinus).mul(oneMinus).mul(oneMinus).mul(oneMinus).toVar();
      const fresnel = f0.add(float(1).sub(f0).mul(fresnelPow)).clamp(0, 1).toVar();

      // --- transmitted colour -------------------------------------------------
      //
      // What the eye sees looking *into* the water: the scene behind the surface,
      // refracted, attenuated by the column of water it crossed, and progressively
      // replaced by light scattered back out of that column.
      //
      // The thickness of the column is measured, not assumed. Reading the depth
      // buffer behind the surface gives the real distance from the surface to
      // whatever is under it, so a hull a metre down stays legible while the
      // seafloor thirty metres down does not — and a drop-off reads as an edge
      // because it genuinely is one. The seafloor heightfield remains the fallback
      // for the WebGL2 path and for anything the depth buffer cannot answer for.

      // Surface normals bend the view ray. Scaled down with distance, because the
      // same lateral offset at the horizon is a whole screen away, and scaled by
      // depth so shallow water distorts less than deep — which is what stops the
      // distortion from tearing at a shoreline.
      const distortion = n.xz
        .mul(this.uRefractionStrength)
        .div(viewDistance.mul(0.06).add(1))
        .toVar();
      const refractedUv: any = (viewportSafeUV(screenUV.add(distortion)) as any).toVar();

      // Depth of the scene behind the surface, and of the surface itself.
      // `linearDepth` is normalised over the near/far range, so the difference is
      // scaled back into metres by `uDepthRange` before it means anything.
      const surfaceZ: any = (linearDepth() as any).toVar();
      const behindZ: any = (linearDepth(viewportDepthTexture(refractedUv)) as any).toVar();

      // A refracted sample can land on something *in front of* the water — the
      // hull's own topsides, most obviously — and pulling that colour underwater
      // smears it down the wave face. Where that happens, fall back to the
      // unrefracted sample, which is behind the surface by construction.
      const straightZ: any = (linearDepth(viewportDepthTexture(screenUV)) as any).toVar();
      const valid: any = behindZ.greaterThan(surfaceZ).toVar();
      const sampleUv: any = valid.select(refractedUv, screenUV).toVar();
      const backdropZ: any = valid.select(behindZ, straightZ).toVar();

      // Column thickness. Two independent estimates, and the smaller wins: the
      // depth buffer knows about the hull and the props, the heightfield knows
      // about seafloor the depth buffer may never have rendered.
      const bufferThickness: any = backdropZ.sub(surfaceZ).max(0).mul(this.uDepthRange).toVar();
      const pathLength: any = (
        floorDepth === null
          ? bufferThickness
          : bufferThickness.min(
              floorDepth(worldPos).max(0).mul(float(1).div(nDotV.max(0.25))),
            )
      ).toVar();

      const absorption: any = this.uExtinction.mul(pathLength).negate().exp().toVar();

      // Beer–Lambert on the refracted scene colour, plus the light scattered out
      // of the column toward the eye. The two are complementary: whatever the
      // water absorbed on the way through is what it has to give back as body
      // colour, which is why `absorption` weights one and its complement the
      // other rather than both being tuned independently.
      const refracted: any = viewportSharedTexture(sampleUv).rgb.toVar();
      const inscatter: any = mix(this.uDeepColor, this.uShallowColor, absorption).toVar();
      const bodyColor: any = mix(
        inscatter,
        refracted,
        absorption.mul(this.uRefractionAmount),
      ).toVar();

      // --- subsurface scattering ---------------------------------------------
      // Crests transmit light when the sun is behind them.
      const sunDir = normalize(this.uSunDirection).toVar();
      const back = viewDir.negate().dot(sunDir).clamp(0, 1).toVar();
      const backlight = back.mul(back).mul(back).toVar();
      const crest = worldPos.y.mul(0.28).clamp(0, 1).toVar();
      // Scaled by how much light there actually is.
      //
      // Subsurface scattering is transmitted *sunlight*: it cannot be brighter
      // than what is illuminating the water. The scatter colour is authored, so
      // without this it kept its full daytime value after dark, and the water
      // around the submerged hull glowed green at half past nine at night.
      const scatter = this.uScatterColor
        .mul(backlight.mul(crest).mul(this.uScatterStrength).mul(this.uLightLevel))
        .toVar();

      // --- reflection ----------------------------------------------------------
      // The analytic sky gradient is kept as the base layer, not replaced. It is
      // what fills the horizon, where a planar reflection has nothing to offer
      // and where its texture runs out anyway; the mirrored scene is composited
      // over it wherever it actually contains something.
      const reflectDir = viewDir.negate().reflect(n).toVar();
      const skyBlend = reflectDir.y.clamp(0, 1).sqrt().toVar();
      const reflection = mix(this.uHorizonColor, this.uSkyColor, skyBlend).toVar();

      if (planar !== null) {
        // The mirror is a flat plane; the water is not. Offsetting the lookup by
        // the surface normal is what makes the reflection ripple with the waves
        // rather than sitting on them like a decal. Scaled down with distance for
        // the same reason the refraction offset is: a fixed screen-space offset
        // is metres at the horizon and millimetres underfoot.
        const offset = n.xz
          .mul(this.uReflectionDistortion)
          .div(viewDistance.mul(0.05).add(1))
          .toVar();
        const rawUv = screenUV.add(offset).toVar();
        const mirrored = planar.sample(viewportSafeUV(rawUv)).toVar();

        // Faded out where the lookup leaves the reflection, rather than clamped
        // into it. A mirrored camera only covers what is in front of it, so near
        // the horizon the offset walks the lookup off the edge — and clamping
        // there streaks the last row of texels sideways, which showed up as a
        // dark band lying along the horizon.
        const rEdge = rawUv.min(rawUv.oneMinus()).toVar();
        const inFrame = rEdge.x.min(rEdge.y).smoothstep(0, 0.05).clamp(0, 1).toVar();

        // Also faded as the view flattens. At a grazing angle the reflected ray
        // leaves the plane almost immediately and the planar approximation stops
        // describing anything; the analytic sky is the better answer there, and
        // it is also what the eye expects, since distant water reads as sky.
        const facing = nDotV.smoothstep(0.02, 0.22).toVar();

        reflection.assign(
          mix(reflection, mirrored.rgb, inFrame.mul(facing).mul(this.uReflectionAmount)),
        );
      }

      // --- sun specular (GGX) ---------------------------------------------------
      const halfVector = normalize(viewDir.add(sunDir)).toVar();
      const nDotH = n.dot(halfVector).clamp(0, 1).toVar();
      const alpha = this.uRoughness.mul(this.uRoughness).toVar();
      const a2 = alpha.mul(alpha).toVar();
      const denom = nDotH.mul(nDotH).mul(a2.sub(1)).add(1).toVar();
      const ggx = a2.div(denom.mul(denom).mul(Math.PI).max(1e-4)).toVar();
      const nDotL = n.dot(sunDir).clamp(0, 1).toVar();
      const specular = this.uSunColor.mul(ggx.mul(nDotL).mul(this.uSunIntensity)).toVar();

      // --- combine ---------------------------------------------------------------
      // The body colour is authored for *daylight*. Its diffuse term bottomed out
      // at 0.45, which is a floor on how dark lit water can get — so at night the
      // shallow-water tint kept glowing at nearly half strength and the water
      // around the submerged hull read as a green lamp. It now falls with the
      // light, to a small floor rather than to zero: a night sea is dark, but it
      // is not black, because the whole sky is still faintly lighting it.
      const ambientFloor = mix(float(0.1), float(1), this.uLightLevel).toVar();
      const litBody = bodyColor
        .mul(nDotL.mul(0.55).add(0.45))
        .mul(ambientFloor)
        .add(scatter)
        .toVar();
      const surface = mix(litBody, reflection, fresnel).add(specular).toVar();

      // --- foam --------------------------------------------------------------------
      // The Jacobian is 1 on unstretched water and drops below 0 where the surface
      // folds onto itself; that fold region is physically where whitecaps break.
      const coverage = fold
        .smoothstep(this.uFoamThreshold, this.uFoamThreshold.sub(this.uFoamSoftness))
        .clamp(0, 1)
        .toVar();

      // Whitecaps break at crests, not in troughs. The Jacobian alone is a
      // low-frequency field and marks broad patches, so bias it by local
      // elevation: the same amount of folding produces foam on a crest and
      // almost none a metre lower down. This is what turns smooth blobs into
      // streaks that follow the wave tops.
      //
      // The bias now runs to zero rather than bottoming out at a quarter. That
      // floor was there to keep the instantaneous mask looking continuous, and
      // it is exactly what put a wash of foam into every trough; with the
      // accumulation buffer carrying persistence, this term no longer has to
      // pretend to be continuous and can be as selective as real whitecaps are.
      const crestBias = worldPos.y.smoothstep(-0.2, 2.2).clamp(0, 1).toVar();
      const biased = coverage.mul(crestBias).toVar();

      // Break the mask up with world-space noise at roughly the scale of real
      // foam clumps (sub-metre), so the edge dissolves into bubbles rather than
      // ending on a clean contour.
      const foamUv = worldPos.xz.mul(1.4).toVar();
      const breakup = float(0).toVar();
      let amplitude = 0.5;
      let frequency = 1;
      for (let octave = 0; octave < 4; octave++) {
        breakup.addAssign(
          valueNoise(foamUv.mul(frequency).add(vec2(octave * 17.3, octave * 9.1))).mul(amplitude),
        );
        amplitude *= 0.5;
        frequency *= 2.07;
      }
      // Centre the noise on zero so it perturbs the mask both ways instead of
      // only ever eating into it.
      const perturb = breakup.sub(0.5).toVar();

      // A wide smoothstep keeps the boundary soft; the noise decides *where* that
      // boundary falls, which reads as texture rather than as a fading blob.
      const crestFoam = biased
        .add(perturb.mul(0.45))
        .smoothstep(0.12, 0.78)
        .clamp(0, 1)
        .toVar();

      // --- accumulated foam ---------------------------------------------------
      // Wake and any other persistent deposit, read from the world-anchored
      // buffer. Unlike the crest mask above this is *history*: it was laid down
      // on earlier frames and has been decaying since, which is what lets a wake
      // trail behind a moving hull instead of being a decal under it.
      const accumulated = float(0).toVar();
      if (foam !== null) {
        const foamUvw = worldPos.xz.sub(this.uFoamCenter).div(foam.extent).add(0.5).toVar();

        // The buffer covers a finite square. Outside it there is no information,
        // and clamp-to-edge would smear the border across the whole ocean, so
        // fade out just inside the edge instead.
        const edge = foamUvw.min(foamUvw.oneMinus()).toVar();
        const inside = edge.x.min(edge.y).smoothstep(0, 0.02).clamp(0, 1).toVar();

        accumulated.assign(
          texture(foam.texture, foamUvw).r.clamp(0, 1).mul(inside).mul(this.uFoamStrength),
        );

        // Broken up by the same noise as the crest foam so the two read as one
        // material. Without this the wake is a smooth airbrushed streak against
        // bubbly whitecaps and the eye separates them immediately.
        //
        // The breakup is *gated on there being foam here at all*. Added
        // unconditionally it is a signed term, so on empty water the positive
        // half of the noise alone clears the threshold and sprays foam across an
        // ocean that has none — the mask has to be able to return exactly zero.
        const present = accumulated.smoothstep(0.02, 0.2).toVar();
        accumulated.assign(
          accumulated
            .add(perturb.mul(0.22).mul(present))
            .smoothstep(0.16, 0.72)
            .clamp(0, 1)
            .mul(present),
        );
      }

      const foamMask = crestFoam.max(accumulated).toVar();

      const withFoam = mix(surface, this.uFoamColor, foamMask).toVar();

      // --- aerial perspective --------------------------------------------------------
      const fogFactor = float(1)
        .sub(this.uFogDensity.mul(viewDistance).negate().exp())
        .clamp(0, 1)
        .toVar();
      const withFog = mix(withFoam, this.uFogColor, fogFactor).toVar();

      return vec4(withFog, 1);
    })();
  }
}

/**
 * Weight for cascade `index` at world distance `distance` (metres).
 *
 * Keyed to real distance, NOT to the mesh's radial parameter: ring radii grow
 * geometrically, so a linear cutoff in radial parameter would kill the finest
 * cascade only a few metres from the camera.
 *
 * Each cascade is carried until its texel footprint approaches a pixel, then
 * cross-faded out. Cascade 0 holds the swell and never fades — it is what forms
 * the horizon silhouette.
 *
 * TSL node objects are structurally dynamic, so node-typed values are `any` here
 * by design — the module's public API stays strongly typed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Hash-based 2D value noise, bilinearly interpolated with a quintic fade.
 *
 * Procedural rather than a sampled texture so there is nothing extra to
 * download, and so the foam breakup is scale-free — it stays crisp no matter how
 * close the camera gets.
 */
/**
 * Rain striking the water, as a slope perturbation.
 *
 * Procedural against a lattice rather than a simulated field. Each cell of a
 * world-space grid launches one ring per cycle, at a position and a phase hashed
 * from the cell index, so impacts are scattered in space and time without any
 * state being stored anywhere. That matters more than it sounds: a buffer would
 * have to be camera-relative, and every impact near the edge would pop in and
 * out as the viewer moved. Anchored to the world by construction, a ripple stays
 * where it landed.
 *
 * The spec allows "a shared, camera-relative, low-resolution GPU field or another
 * bounded technique"; this is the second. It is bounded by the 3x3 neighbourhood,
 * costs no memory, needs no readback, and is deterministic — the same second of
 * simulation time produces the same rain on every machine.
 *
 * Slope is accumulated directly rather than height. The normal is what the
 * shading actually wants, and differentiating a height field would mean
 * evaluating this three times per fragment instead of once.
 */

/**
 * Metres per lattice cell, and seconds between a cell's impacts.
 *
 * These two set the impact rate — one strike per cell per period, so at full
 * intensity the surface takes `1 / (RAIN_CELL² × RAIN_PERIOD)` hits per square
 * metre per second. That has to agree with how much rain is visibly falling, or
 * the scene shows a downpour landing as a drizzle. `Weather` renders 9000
 * streaks through a 68 m box; matching the two by eye at full intensity puts the
 * cell near a metre and the period near a second, not the 2.6 m and 1.35 s this
 * started with — which was roughly seven times too few impacts.
 */
const RAIN_CELL = 1.05;
const RAIN_PERIOD = 0.95;
/** Metres per second the ring expands. */
const RAIN_SPEED = 1.5;
/** Radians per metre across the ring — how tight the wavefront reads. */
const RAIN_FREQUENCY = 13.0;

const rainSlope = /*@__PURE__*/ Fn(([worldXZ, time, intensity]: [any, any, any]) => {
  const cell = worldXZ.div(RAIN_CELL).floor().toVar();
  const slope = vec2(0, 0).toVar();

  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const neighbour = cell.add(vec2(dx, dz)).toVar();
      const h = hash2(neighbour).toVar();

      // Where in the cell the drop landed, and how far through its cycle it is.
      const drop = neighbour.add(h).mul(RAIN_CELL).toVar();
      const age = time.div(RAIN_PERIOD).add(h.x.mul(7.13).add(h.y.mul(3.71))).fract()
        .mul(RAIN_PERIOD).toVar();

      // Rain rate sets how many cells are raining, not how hard each ring hits.
      // Scaling amplitude instead would make light rain look like heavy rain
      // seen through fog; scaling population is what actually changes.
      const active = h.y.step(intensity).toVar();

      const delta = worldXZ.sub(drop).toVar();
      const r = delta.length().max(1e-3).toVar();
      const front = age.mul(RAIN_SPEED).toVar();
      const x = r.sub(front).toVar();

      // A wave packet at the expanding front, dying with age and with distance.
      const envelope = x
        .mul(x)
        .mul(-9.0)
        .exp()
        .mul(float(1).sub(age.div(RAIN_PERIOD)))
        .mul(r.mul(-1.6).exp())
        .toVar();

      // d/dr of sin(x * F) * envelope, keeping the dominant term.
      const dhdr = x.mul(RAIN_FREQUENCY).cos().mul(RAIN_FREQUENCY).mul(envelope).toVar();
      slope.addAssign(delta.div(r).mul(dhdr).mul(active));
    }
  }
  return slope;
});

const hash2 = /*@__PURE__*/ Fn(([p]: [any]) => {
  const h = vec2(p.dot(vec2(127.1, 311.7)), p.dot(vec2(269.5, 183.3))).toVar();
  return h.sin().mul(43758.5453).fract();
});

const valueNoise = /*@__PURE__*/ Fn(([p]: [any]) => {
  const i = p.floor().toVar();
  const f = p.fract().toVar();
  // Quintic fade — a linear blend leaves visible grid creases in the derivative.
  const u = f.mul(f).mul(f.mul(f.mul(6).sub(15)).add(10)).toVar();

  const a = hash2(i).x.toVar();
  const b = hash2(i.add(vec2(1, 0))).x.toVar();
  const c = hash2(i.add(vec2(0, 1))).x.toVar();
  const d = hash2(i.add(vec2(1, 1))).x.toVar();

  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

/**
 * Geometry and shading need *different* LOD curves, and conflating them is what
 * makes naive ocean meshes sparkle.
 *
 * Geometry can only carry a wave if the local vertex spacing resolves it. On the
 * radial grid spacing grows in proportion to radius (~0.034r at the default
 * density), so each cascade must stop displacing vertices once its wavelength
 * approaches that spacing — otherwise every triangle lands on a random phase of
 * the wave and the surface breaks into noise.
 *
 * Shading has no such limit: the derivative textures are mipmapped, so the
 * fragment stage samples them correctly at any distance. Normals therefore carry
 * the detail far beyond where the geometry has flattened out, which is exactly
 * how real distant water reads — a smooth sheet with fine specular structure.
 */
const CASCADE_GEOMETRY_FADE_METRES: [number, number][] = [
  [900, 2600], // swell
  [110, 300], // chop
  [18, 55], // ripple
];

const CASCADE_SHADING_FADE_METRES: [number, number][] = [
  [Infinity, Infinity], // swell: always on
  [1400, 3000],
  [160, 420],
];

function fadeFrom(
  table: [number, number][],
  distance: any,
  index: number,
  count: number,
): any {
  if (count === 1 && index === 0) return float(1);
  const [start, end] = table[Math.min(index, table.length - 1)];
  if (!Number.isFinite(start)) return float(1);
  // smoothstep rises 0 -> 1 with distance, so invert it to get a fade-out.
  return float(1).sub(distance.smoothstep(start, end)).clamp(0, 1);
}

/** Vertex-stage weight: how much this cascade displaces geometry. */
function cascadeGeometryFade(distance: any, index: number, count: number): any {
  return fadeFrom(CASCADE_GEOMETRY_FADE_METRES, distance, index, count);
}

/** Fragment-stage weight: how much this cascade contributes to normals and foam. */
function cascadeShadingFade(distance: any, index: number, count: number): any {
  if (index === 0) return float(1);
  return fadeFrom(CASCADE_SHADING_FADE_METRES, distance, index, count);
}
