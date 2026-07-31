import * as THREE from 'three/webgpu';
import {
  Fn,
  cameraPosition,
  float,
  mix,
  normalize,
  positionLocal,
  positionWorld,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
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
export class OceanMaterial {
  readonly material: THREE.MeshBasicNodeMaterial;

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

  constructor(inputs: OceanMaterialInputs) {
    this.material = new THREE.MeshBasicNodeMaterial();
    this.material.side = THREE.DoubleSide; // visible from below when submerged
    this.material.name = 'ocean-water';
    this.build(inputs);
  }

  // ---------------------------------------------------------------- accessors

  setSun(direction: THREE.Vector3, color: THREE.Color, intensity: number): void {
    (this.uSunDirection.value as THREE.Vector3).copy(direction).normalize();
    (this.uSunColor.value as THREE.Color).copy(color);
    this.uSunIntensity.value = intensity;
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

  /** Must be called with the ocean mesh's world translation every frame. */
  setWorldOffset(x: number, z: number): void {
    this.uOffsetX.value = x;
    this.uOffsetZ.value = z;
  }

  dispose(): void {
    this.material.dispose();
  }

  // ----------------------------------------------------------------- internals

  private build(inputs: OceanMaterialInputs): void {
    const { displacementTextures, derivativeTextures, tileSizes } = inputs;
    const cascadeCount = displacementTextures.length;

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
        const sample = texture(displacementTextures[i], worldXZ.div(tileSizes[i])).toVar();
        displacement.addAssign(
          sample.xyz.mul(cascadeGeometryFade(groundDistance, i, cascadeCount)),
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
        const d = texture(derivativeTextures[i], worldPos.xz.div(tileSizes[i])).toVar();
        const fade = cascadeShadingFade(viewDistance, i, cascadeCount);
        slope.addAssign(vec2(d.x, d.y).mul(fade));
        fold.assign(fold.min(mix(float(1), d.z, fade)));
      }

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
      // Grazing views look through more water, so the body darkens toward the
      // horizon while steep views let the shallow tint through.
      const pathLength = float(1).div(nDotV).mul(3.5).toVar();
      const absorption = this.uExtinction.mul(pathLength).negate().exp().toVar();
      const bodyColor = mix(this.uDeepColor, this.uShallowColor, absorption as never).toVar();

      // --- subsurface scattering ---------------------------------------------
      // Crests transmit light when the sun is behind them.
      const sunDir = normalize(this.uSunDirection).toVar();
      const back = viewDir.negate().dot(sunDir).clamp(0, 1).toVar();
      const backlight = back.mul(back).mul(back).toVar();
      const crest = worldPos.y.mul(0.28).clamp(0, 1).toVar();
      const scatter = this.uScatterColor
        .mul(backlight.mul(crest).mul(this.uScatterStrength))
        .toVar();

      // --- sky reflection ------------------------------------------------------
      const reflectDir = viewDir.negate().reflect(n).toVar();
      const skyBlend = reflectDir.y.clamp(0, 1).sqrt().toVar();
      const reflection = mix(this.uHorizonColor, this.uSkyColor, skyBlend).toVar();

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
      const litBody = bodyColor.mul(nDotL.mul(0.55).add(0.45)).add(scatter).toVar();
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
      const crestBias = worldPos.y.smoothstep(-0.6, 1.8).clamp(0, 1).toVar();
      const biased = coverage.mul(crestBias.mul(0.75).add(0.25)).toVar();

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
      const foamMask = biased
        .add(perturb.mul(0.45))
        .smoothstep(0.12, 0.78)
        .clamp(0, 1)
        .toVar();

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
