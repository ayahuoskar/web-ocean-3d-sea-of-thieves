import * as THREE from 'three/webgpu';
import {
  Fn,
  acos,
  cameraPosition,
  clamp,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  max,
  mix,
  mx_noise_float,
  normalize,
  positionGeometry,
  pow,
  saturate,
  sin,
  smoothstep,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';

/**
 * Analytic sky dome.
 *
 * The daylight term is a port of the Preetham model as implemented by the
 * MIT-licensed three.js example `three/addons/objects/Sky.js` (A. Preetham,
 * P. Shirley, B. Smits — "A Practical Analytic Model for Daylight"). The stock
 * example is a raw `ShaderMaterial`, which cannot participate in this project's
 * node pipeline, so the shading is re-authored here as a TSL node graph on a
 * `MeshBasicNodeMaterial`. The night hemisphere (stars, moon disc, halo) and the
 * ground term are original.
 *
 * Everything the caller can tune is a `uniform()`, so `setParams` never rebuilds
 * the node graph — it only writes uniform values.
 */

// ---------------------------------------------------------------------------
// Preetham constants (see Sky.js for their derivation).
// ---------------------------------------------------------------------------

/** Rayleigh scattering coefficient at sea level for the 680/550/450 nm primaries. */
const TOTAL_RAYLEIGH = new THREE.Vector3(
  5.804542996261093e-6,
  1.3562911419845635e-5,
  3.0265902468824876e-5,
);
/** pi * pow( ( 2 * pi ) / lambda, v - 2 ) * K, precomputed per primary. */
const MIE_CONST = new THREE.Vector3(
  1.8399918514433978e14,
  2.7798023919660528e14,
  4.0790479543861094e14,
);

const CUTOFF_ANGLE = 1.6110731556870734; // pi / 1.95 — fakes the earth shadow
const STEEPNESS = 1.5;
const SUN_ENERGY = 1000;
const RAYLEIGH_ZENITH_LENGTH = 8.4e3;
const MIE_ZENITH_LENGTH = 1.25e3;
/** cos of the sun's angular radius (~32 arc minutes). */
const SUN_ANGULAR_DIAMETER_COS = 0.9999566769464485;

/** 3 / ( 16 * pi ) */
const THREE_OVER_SIXTEEN_PI = 0.05968310365946075;
/** 1 / ( 4 * pi ) */
const ONE_OVER_FOUR_PI = 0.07957747154594767;

/**
 * Radius of the dome in metres. Deliberately small: the material disables the
 * depth test and the mesh renders first, so the dome never needs to enclose the
 * scene — it only needs to sit outside the near plane. Keeping it small avoids
 * any dependency on the app's `camera.far`.
 */
const SKY_RADIUS = 100;

/** Distance the directional light is parked at along the sun vector. */
const SUN_LIGHT_DISTANCE = 3000;

const ENV_SIZE = 128;

/**
 * Preetham returns scene-referred radiance in the tens; this maps it onto the
 * renderer's ACES filmic curve at `toneMappingExposure = 1`. Calibrated by
 * sampling the framebuffer: with `exposure: 1, rayleigh: 1.6, turbidity: 2.6` and
 * the sun at 0.46 rad, the zenith lands on ~#2E6FB5, matching ref-default.png.
 * `AtmosphereParams.exposure` then reads as a relative stop around that look.
 */
const SKY_RADIANCE_SCALE = 0.35;

/**
 * ACES filmic desaturates as it rolls off, which turns a deep zenith blue into
 * pale sky-blue. A small chroma expansion in linear space before tonemapping
 * restores the reference's zenith-to-horizon saturation without touching
 * luminance. This is a grade, not a second tonemap.
 */
const SKY_CHROMA = 1.06;

/**
 * Preetham's `sunIntensity` collapses steeply as the sun approaches the horizon
 * (it fakes the earth's shadow), and the long slant path costs another factor on
 * top. Measured at `exposure: 1`, the sky 10 degrees up drops from RGB ~(176,213,230)
 * at a 26-degree sun to ~(14,31,32) at a 1-degree sun — a 17x fall. A real camera
 * or eye would open up across that range; our renderer's exposure is fixed, so
 * the dome compensates itself. Without this every low-sun preset would have to
 * carry an `exposure` in the teens, and ref-sunset.png would render near black.
 *
 * The curve below is measured, not guessed: for each sun height the framebuffer
 * was sampled across an exposure sweep and the gain that lands the sky 10 degrees
 * up on RGB ~205 green (the value a 20-degree sun produces unaided) was read off.
 * The gain is deliberately capped near the horizon so dusk still reads as dusk
 * rather than flattening into a permanent noon.
 *
 * Pairs are [sin(sunElevation), gain], ascending.
 */
const TWILIGHT_CURVE: ReadonlyArray<readonly [number, number]> = [
  [-1.0, 17],
  [0.0, 17],
  [0.02, 15],
  [0.05, 11.5],
  [0.08, 7.6],
  [0.12, 4.5],
  [0.18, 2.7],
  [0.25, 1.8],
  [0.32, 1.0],
  [1.0, 1.0],
];

function twilightGain(sunY: number): number {
  for (let i = 1; i < TWILIGHT_CURVE.length; i++) {
    const [y1, g1] = TWILIGHT_CURVE[i];
    if (sunY <= y1) {
      const [y0, g0] = TWILIGHT_CURVE[i - 1];
      const k = y1 === y0 ? 0 : (sunY - y0) / (y1 - y0);
      // Smoothstep the blend so the gain has no slope kinks at the knots.
      return g0 + (g1 - g0) * (k * k * (3 - 2 * k));
    }
  }
  return 1;
}

/** Rec. 709 luminance weights. */
const LUMA = /*@__PURE__*/ new THREE.Vector3(0.2126, 0.7152, 0.0722);

export interface AtmosphereParams {
  sunElevation: number; // radians, may be negative (below horizon)
  sunAzimuth: number; // radians
  turbidity: number; // 1..20 haze
  rayleigh: number; // scattering strength
  mieCoefficient: number;
  mieDirectionalG: number; // 0..0.99 forward scattering
  exposure: number;
  groundColor: THREE.Color;
  nightIntensity: number; // 0 = day, 1 = full night (stars + moon)
  moonElevation: number;
  moonAzimuth: number;
}

export const DEFAULT_ATMOSPHERE_PARAMS: AtmosphereParams = {
  sunElevation: 0.42,
  sunAzimuth: 2.6,
  turbidity: 2.6,
  rayleigh: 1.6,
  mieCoefficient: 0.005,
  mieDirectionalG: 0.8,
  /**
   * 1 == the calibrated reference look (see SKY_RADIANCE_SCALE). Treat this as a
   * relative stop, not as three's `toneMappingExposure`.
   */
  exposure: 1,
  groundColor: new THREE.Color(0.05, 0.09, 0.13),
  nightIntensity: 0,
  moonElevation: 0.6,
  moonAzimuth: 1.2,
};

/** Colour of moonlight — a cool, desaturated blue. See ref-moonlit.png. */
const MOON_LIGHT_COLOR = new THREE.Color(0.44, 0.58, 0.9);

// Module-scope scratch — `update`/`setParams` must not allocate.
const _fex = new THREE.Vector3();
const _betaR = new THREE.Vector3();
const _betaM = new THREE.Vector3();

/** Hermite fade, matching GLSL `smoothstep` semantics on the CPU. */
function smoothstepScalar(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Spherical (elevation/azimuth) to the engine's Y-up right-handed basis. */
function directionFromAngles(elevation: number, azimuth: number, out: THREE.Vector3): THREE.Vector3 {
  const c = Math.cos(elevation);
  return out.set(c * Math.sin(azimuth), Math.sin(elevation), c * Math.cos(azimuth));
}

export class Atmosphere {
  readonly mesh: THREE.Mesh;
  readonly sunLight: THREE.DirectionalLight;
  readonly ambientLight: THREE.HemisphereLight;

  private readonly params: AtmosphereParams;

  private readonly geometry: THREE.SphereGeometry;
  private readonly material: THREE.MeshBasicNodeMaterial;

  /** Second mesh sharing geometry + material, used only for the env capture. */
  private readonly envMesh: THREE.Mesh;
  private readonly envScene: THREE.Scene;
  private readonly envTarget: THREE.CubeRenderTarget;
  private readonly envCamera: THREE.CubeCamera;
  private envDirty = true;
  private envScene3D: THREE.Scene | null = null;

  private readonly _sunDirection = new THREE.Vector3(0, 1, 0);
  private readonly _moonDirection = new THREE.Vector3(0, 1, 0);
  private readonly _sunColor = new THREE.Color(1, 1, 1);

  private elapsed = 0;
  /** Clamped copy of `nightIntensity`; also gates the moonlight source. */
  private nightAmount = 0;

  // --- uniforms -------------------------------------------------------------
  private readonly uSunDir = uniform(new THREE.Vector3(0, 1, 0));
  private readonly uMoonDir = uniform(new THREE.Vector3(0, 1, 0));
  private readonly uBetaR = uniform(new THREE.Vector3());
  private readonly uBetaM = uniform(new THREE.Vector3());
  private readonly uSunE = uniform(0);
  private readonly uMieG = uniform(0.8);
  /**
   * Day and night are scaled separately, folded on the CPU. They must not share
   * a multiplier: the twilight gain exists to rescue a *sunlit* sky near the
   * horizon, and applying it to the night term as well turns a moonlit sky into
   * a bright blue one.
   */
  private readonly uDayRadiance = uniform(SKY_RADIANCE_SCALE);
  private readonly uNightRadiance = uniform(0);
  // Colour uniforms are held loosely typed: TSL's declaration file narrows a
  // colour uniform to a float-ish node, which blocks legitimate vec3 chaining.
  private readonly uGround: any = uniform(new THREE.Color(0.05, 0.09, 0.13));
  private readonly uSunDiscVisible = uniform(1);
  private readonly uMoonDiscCos = uniform(0.9995);
  private readonly uTime = uniform(0);

  constructor(renderer: THREE.WebGPURenderer) {
    void renderer; // the dome needs no renderer-specific setup; kept for API symmetry

    this.params = { ...DEFAULT_ATMOSPHERE_PARAMS, groundColor: DEFAULT_ATMOSPHERE_PARAMS.groundColor.clone() };

    this.geometry = new THREE.SphereGeometry(1, 48, 32);

    this.material = new THREE.MeshBasicNodeMaterial();
    this.material.side = THREE.BackSide;
    this.material.depthWrite = false;
    // The dome is drawn first with the depth test off, so it can be tiny and
    // still sit behind everything — no `camera.far` coupling, no z-fighting.
    this.material.depthTest = false;
    this.material.fog = false;
    this.material.colorNode = this.buildSkyNode();
    // Sprite/points aside, `positionNode` replaces the local position: this
    // recentres the dome on the viewer entirely on the GPU, so there is no
    // per-frame CPU transform work and no need for the camera in `update`.
    this.material.positionNode = positionGeometry.mul(SKY_RADIUS).add(cameraPosition);

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'sky-dome';
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;

    // Environment capture: the same dome, but centred on the cube camera at the
    // origin. Geometry and material are shared, so the uniforms stay in sync.
    this.envMesh = new THREE.Mesh(this.geometry, this.material);
    this.envMesh.frustumCulled = false;
    this.envMesh.matrixAutoUpdate = false;
    this.envScene = new THREE.Scene();
    this.envScene.add(this.envMesh);

    this.envTarget = new THREE.CubeRenderTarget(ENV_SIZE, {
      type: THREE.HalfFloatType,
      generateMipmaps: false,
    });
    this.envCamera = new THREE.CubeCamera(1, SKY_RADIUS * 4, this.envTarget);

    this.sunLight = new THREE.DirectionalLight(0xffffff, 3.2);
    this.sunLight.name = 'sun';
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = SUN_LIGHT_DISTANCE * 2;
    this.sunLight.shadow.camera.left = -260;
    this.sunLight.shadow.camera.right = 260;
    this.sunLight.shadow.camera.top = 260;
    this.sunLight.shadow.camera.bottom = -260;
    this.sunLight.shadow.bias = -0.0006;
    this.sunLight.shadow.normalBias = 0.6;

    this.ambientLight = new THREE.HemisphereLight(0x88b7ff, 0x0d1a24, 1);
    this.ambientLight.name = 'sky-ambient';

    this.applyParams();
  }

  /**
   * Sets the sun shadow map resolution, or disables shadow casting at 0.
   *
   * The existing map has to be released explicitly: `WebGLShadowMap` allocates
   * its render target lazily from `mapSize` and then keeps it, so writing a new
   * size without disposing leaves the old target bound and the tier change has
   * no effect at all. Disposing forces reallocation at the requested size on the
   * next shadow pass.
   */
  setShadowMapSize(size: number): void {
    const enabled = size > 0;
    const side = enabled ? Math.max(256, Math.round(size)) : this.sunLight.shadow.mapSize.x;

    if (this.sunLight.castShadow === enabled && this.sunLight.shadow.mapSize.x === side) return;

    this.sunLight.castShadow = enabled;
    if (enabled && this.sunLight.shadow.mapSize.x !== side) {
      this.sunLight.shadow.mapSize.set(side, side);
      this.sunLight.shadow.dispose();
    }
  }

  /** Current sun shadow map resolution per side; 0 when shadows are off. */
  get shadowMapSize(): number {
    return this.sunLight.castShadow ? this.sunLight.shadow.mapSize.x : 0;
  }

  get sunDirection(): THREE.Vector3 {
    return this._sunDirection;
  }

  get sunColor(): THREE.Color {
    return this._sunColor;
  }

  /** Direction to the moon, normalised, world space. */
  get moonDirection(): THREE.Vector3 {
    return this._moonDirection;
  }

  /**
   * Written out field by field rather than looping `Object.keys` so that an app
   * animating the sun every frame does not allocate a key array per call, and so
   * that the environment map is only invalidated when a value really moved.
   */
  setParams(params: Partial<AtmosphereParams>): void {
    const p = this.params;
    let changed = false;

    if (params.sunElevation !== undefined && params.sunElevation !== p.sunElevation) {
      p.sunElevation = params.sunElevation;
      changed = true;
    }
    if (params.sunAzimuth !== undefined && params.sunAzimuth !== p.sunAzimuth) {
      p.sunAzimuth = params.sunAzimuth;
      changed = true;
    }
    if (params.turbidity !== undefined && params.turbidity !== p.turbidity) {
      p.turbidity = params.turbidity;
      changed = true;
    }
    if (params.rayleigh !== undefined && params.rayleigh !== p.rayleigh) {
      p.rayleigh = params.rayleigh;
      changed = true;
    }
    if (params.mieCoefficient !== undefined && params.mieCoefficient !== p.mieCoefficient) {
      p.mieCoefficient = params.mieCoefficient;
      changed = true;
    }
    if (params.mieDirectionalG !== undefined && params.mieDirectionalG !== p.mieDirectionalG) {
      p.mieDirectionalG = params.mieDirectionalG;
      changed = true;
    }
    if (params.exposure !== undefined && params.exposure !== p.exposure) {
      p.exposure = params.exposure;
      changed = true;
    }
    if (params.nightIntensity !== undefined && params.nightIntensity !== p.nightIntensity) {
      p.nightIntensity = params.nightIntensity;
      changed = true;
    }
    if (params.moonElevation !== undefined && params.moonElevation !== p.moonElevation) {
      p.moonElevation = params.moonElevation;
      changed = true;
    }
    if (params.moonAzimuth !== undefined && params.moonAzimuth !== p.moonAzimuth) {
      p.moonAzimuth = params.moonAzimuth;
      changed = true;
    }
    if (params.groundColor !== undefined && !p.groundColor.equals(params.groundColor)) {
      p.groundColor.copy(params.groundColor);
      changed = true;
    }

    if (!changed) return;
    this.applyParams();
    this.envDirty = true;
  }

  /** Read-only view of the currently applied parameters. */
  getParams(): Readonly<AtmosphereParams> {
    return this.params;
  }

  /**
   * Renders the sky into a small cube target and assigns it as `scene.environment`.
   * Cheap to call every frame: it is a no-op unless a parameter actually changed
   * or the target scene changed.
   */
  updateEnvironment(renderer: THREE.WebGPURenderer, scene: THREE.Scene): void {
    if (!this.envDirty && this.envScene3D === scene) return;
    this.envScene3D = scene;
    this.envDirty = false;

    // The Preetham sun disc is ~19000x the sky radiance; captured into 128px
    // faces it becomes a single blown-out texel that flickers as the sun moves.
    // Sky.js recommends hiding it for environment capture — do the same.
    const disc = this.uSunDiscVisible.value;
    this.uSunDiscVisible.value = 0;

    this.envCamera.update(renderer, this.envScene);

    this.uSunDiscVisible.value = disc;

    // Force the PMREM chain used by PBR materials to be rebuilt from the new faces.
    this.envTarget.texture.needsPMREMUpdate = true;
    scene.environment = this.envTarget.texture;
  }

  update(dt: number): void {
    this.elapsed += dt;
    // Star twinkle is driven from a CPU-integrated clock rather than the global
    // `time` node so it stays bounded and pauses with the simulation.
    this.uTime.value = this.elapsed % 3600;
  }

  /** Rewinds the animation clock, for reproducible captures. */
  resetClock(time = 0): void {
    this.elapsed = time;
    this.uTime.value = ((time % 3600) + 3600) % 3600;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.envTarget.dispose();
    this.envScene.remove(this.envMesh);
    this.sunLight.dispose();
    this.sunLight.shadow.dispose();
    this.ambientLight.dispose();
  }

  // -------------------------------------------------------------------------
  // Parameter -> uniform / light derivation (all CPU, all uniform-only inputs)
  // -------------------------------------------------------------------------

  private applyParams(): void {
    const p = this.params;

    directionFromAngles(p.sunElevation, p.sunAzimuth, this._sunDirection).normalize();
    directionFromAngles(p.moonElevation, p.moonAzimuth, this._moonDirection).normalize();

    this.uSunDir.value.copy(this._sunDirection);
    this.uMoonDir.value.copy(this._moonDirection);
    this.uMieG.value = Math.min(0.99, Math.max(0, p.mieDirectionalG));

    this.nightAmount = Math.min(1, Math.max(0, p.nightIntensity));
    const night = this.nightAmount;
    const base = p.exposure * SKY_RADIANCE_SCALE;
    this.uDayRadiance.value = base * twilightGain(this._sunDirection.y) * (1 - 0.95 * night);
    this.uNightRadiance.value = base * night;
    this.uGround.value.copy(p.groundColor);

    // Preetham's per-frame vertex-stage constants. They depend only on uniforms,
    // so they are cheaper (and more precise) computed once here on the CPU.
    const sunY = this._sunDirection.y;
    const sunfade = 1 - Math.min(1, Math.max(0, 1 - Math.exp(sunY)));
    const rayleighCoefficient = p.rayleigh - (1 - sunfade);

    _betaR.copy(TOTAL_RAYLEIGH).multiplyScalar(rayleighCoefficient);
    const c = 0.2 * p.turbidity * 1e-17;
    _betaM.copy(MIE_CONST).multiplyScalar(0.434 * c * p.mieCoefficient);

    this.uBetaR.value.copy(_betaR);
    this.uBetaM.value.copy(_betaM);

    const zenithCos = Math.min(1, Math.max(-1, sunY));
    this.uSunE.value =
      SUN_ENERGY * Math.max(0, 1 - Math.exp(-((CUTOFF_ANGLE - Math.acos(zenithCos)) / STEEPNESS)));

    this.computeSunColor();
    this.updateLights();
  }

  /**
   * Direct sunlight colour = solar spectrum after atmospheric extinction along
   * the sun's own path. Same `Fex` term the sky shader uses, evaluated once on
   * the CPU so scene lighting cannot drift from the dome.
   */
  private computeSunColor(): void {
    const y = Math.max(0.02, this._sunDirection.y);
    const zenithAngle = Math.acos(y);
    const inverse =
      1 /
      (Math.cos(zenithAngle) +
        0.15 * Math.pow(93.885 - (zenithAngle * 180) / Math.PI, -1.253));
    const sR = RAYLEIGH_ZENITH_LENGTH * inverse;
    const sM = MIE_ZENITH_LENGTH * inverse;

    _fex.set(
      Math.exp(-(_betaR.x * sR + _betaM.x * sM)),
      Math.exp(-(_betaR.y * sR + _betaM.y * sM)),
      Math.exp(-(_betaR.z * sR + _betaM.z * sM)),
    );

    const peak = Math.max(_fex.x, _fex.y, _fex.z) || 1;
    this._sunColor.setRGB(_fex.x / peak, _fex.y / peak, _fex.z / peak);
    // A touch of white keeps a low sun from going fully monochromatic red.
    this._sunColor.lerp(WHITE, 0.08);
  }

  private updateLights(): void {
    const p = this.params;
    const sunUp = smoothstepScalar(-0.06, 0.1, this._sunDirection.y);

    if (sunUp > 0.001) {
      this.sunLight.position.copy(this._sunDirection).multiplyScalar(SUN_LIGHT_DISTANCE);
      this.sunLight.color.copy(this._sunColor);
      this.sunLight.intensity = 3.4 * sunUp;
    } else {
      // Below the horizon the moon becomes the only shadow-casting source, so
      // the same light is retargeted rather than adding a second one. The switch
      // happens where the sun's contribution is already zero.
      const moonUp = smoothstepScalar(-0.02, 0.15, this._moonDirection.y);
      this.sunLight.position.copy(this._moonDirection).multiplyScalar(SUN_LIGHT_DISTANCE);
      this.sunLight.color.copy(MOON_LIGHT_COLOR);
      this.sunLight.intensity = 0.42 * moonUp * this.nightAmount;
    }

    const day = smoothstepScalar(-0.12, 0.22, this._sunDirection.y);
    const night = this.nightAmount;

    // Hemisphere fill approximates the dome's own irradiance: blue-dominant when
    // the sun is high, sun-tinted at low elevations, near-black at night.
    _skyTint.setRGB(0.32, 0.48, 0.82).lerp(this._sunColor, (1 - day) * 0.6);
    _skyTint.lerp(NIGHT_SKY_TINT, night);
    this.ambientLight.color.copy(_skyTint);
    this.ambientLight.groundColor.copy(p.groundColor);
    this.ambientLight.intensity = (0.15 + 0.85 * day) * (1 - 0.86 * night) + 0.03 * night;
  }

  // -------------------------------------------------------------------------
  // Node graph
  // -------------------------------------------------------------------------

  /**
   * NOTE: the whole graph is built inside a `Fn` body. TSL only maintains an
   * assignment stack while an `Fn` callback is executing, so `toVar()` and the
   * `*Assign` operators throw if they are reached during plain construction.
   */
  private buildSkyNode(): any {
    return Fn(() => {
      const dir = normalize(positionGeometry).toVar('skyDir');

      // --- Preetham daylight -------------------------------------------------
      const cosZenith = max(dir.y, 0.0);
      const zenithAngle = acos(cosZenith);
      const denom = cos(zenithAngle).add(
        pow(float(93.885).sub(zenithAngle.mul(180 / Math.PI)), -1.253).mul(0.15),
      );
      const opticalInverse = float(1).div(denom);
      const sR = opticalInverse.mul(RAYLEIGH_ZENITH_LENGTH);
      const sM = opticalInverse.mul(MIE_ZENITH_LENGTH);

      const betaR = this.uBetaR;
      const betaM = this.uBetaM;
      const fex = exp(betaR.mul(sR).add(betaM.mul(sM)).negate()).toVar('skyFex');

      const cosTheta = dot(dir, this.uSunDir).toVar('cosTheta');

      // Rayleigh phase, Sky.js convention (argument pre-biased into 0..1).
      const rArg = cosTheta.mul(0.5).add(0.5);
      const rPhase = rArg.mul(rArg).add(1).mul(THREE_OVER_SIXTEEN_PI);
      const mPhase = henyeyGreenstein(cosTheta, this.uMieG);

      const totalBeta = betaR.add(betaM);
      const scatter = betaR.mul(rPhase).add(betaM.mul(mPhase)).div(totalBeta).toVar('scatter');
      const sunE = this.uSunE;

      const lin = pow(
        scatter.mul(sunE).mul(vec3(1, 1, 1).sub(fex)),
        vec3(1.5, 1.5, 1.5),
      ).toVar('lin');
      lin.mulAssign(
        mix(
          vec3(1, 1, 1),
          pow(scatter.mul(sunE).mul(fex), vec3(0.5, 0.5, 0.5)),
          clamp(pow(float(1).sub(this.uSunDir.y), 5.0), 0.0, 1.0),
        ),
      );

      const sunDisc = smoothstep(
        SUN_ANGULAR_DIAMETER_COS,
        SUN_ANGULAR_DIAMETER_COS + 0.00002,
        cosTheta,
      ).mul(this.uSunDiscVisible);
      const l0 = fex.mul(0.1).add(fex.mul(sunE).mul(19000.0).mul(sunDisc));

      const dayColor = lin.add(l0).mul(0.04).add(vec3(0.0, 0.0003, 0.00075)).toVar('dayColor');

      // --- ground half -------------------------------------------------------
      // Below the horizon the dome shows a diffuse ground lit by the horizon sky.
      // It is mostly seen by the environment capture; the ocean hides it in view.
      const groundColor = this.uGround.mul(dayColor.mul(1.4).add(0.004));
      const belowness = smoothstep(0.0, -0.045, dir.y);
      const daySky = mix(dayColor, groundColor, belowness).toVar('daySky');

      // --- night -------------------------------------------------------------
      const nightSky = this.buildNightNode(dir).toVar('nightSky');

      const color = daySky
        .mul(this.uDayRadiance)
        .add(nightSky.mul(this.uNightRadiance))
        .toVar('skyColor');

      const luma = dot(color, vec3(LUMA.x, LUMA.y, LUMA.z));
      const graded = mix(vec3(luma, luma, luma), color, SKY_CHROMA);

      return vec4(graded.max(vec3(0, 0, 0)), 1.0);
    })();
  }

  private buildNightNode(d: any): any {
    // Faintly brighter toward the horizon, as real night skies are.
    const base = mix(
      vec3(0.016, 0.022, 0.044),
      vec3(0.0016, 0.0032, 0.0105),
      saturate(d.y.mul(1.7)),
    );

    // --- star field ----------------------------------------------------------
    // One candidate star per grid cell of direction space. Sparse enough that a
    // single-cell lookup (no 3x3 neighbourhood) is visually indistinguishable
    // and three times cheaper. The cell size is chosen so a star lands at rougly
    // one pixel at a typical field of view — finer than that and the whole field
    // aliases away between frames.
    const cellSpace = d.mul(130.0);
    const cell = floor(cellSpace);
    const local = fract(cellSpace);

    const r0 = hash13(cell);
    const r1 = hash13(cell.add(vec3(11.3, 7.7, 3.1)));
    const r2 = hash13(cell.add(vec3(23.7, 17.3, 5.9)));
    const r3 = hash13(cell.add(vec3(41.1, 29.5, 13.7)));

    const starCentre = vec3(r1, r2, r3);
    const dist = local.sub(starCentre).length();

    const present = smoothstep(0.938, 0.985, r0);
    const core = pow(saturate(float(1).sub(dist.mul(5.0))), 6.0);
    const twinkle = sin(this.uTime.mul(2.6).add(r0.mul(61.0))).mul(0.3).add(0.7);
    const tint = mix(vec3(0.72, 0.81, 1.0), vec3(1.0, 0.88, 0.74), r1);
    const magnitude = r2.mul(0.85).add(0.25);

    const horizonFade = smoothstep(-0.03, 0.2, d.y);
    const stars = tint.mul(core.mul(present).mul(twinkle).mul(magnitude).mul(11.0).mul(horizonFade));

    // --- moon ----------------------------------------------------------------
    const cosMoon = dot(d, this.uMoonDir).toVar('cosMoon');
    const discEdge = this.uMoonDiscCos;
    const disc = smoothstep(discEdge, discEdge.add(0.00025), cosMoon);
    // Cheap maria: low-frequency noise across the disc so it is not a flat blob.
    const maria = mx_noise_float(d.mul(85.0)).mul(0.14).add(0.9);
    const moonBody = vec3(1.0, 0.98, 0.92).mul(disc.mul(maria).mul(9.0));

    const halo = saturate(cosMoon);
    const glow = vec3(0.55, 0.68, 1.0).mul(
      pow(halo, 1400.0).mul(0.5).add(pow(halo, 60.0).mul(0.06)).add(pow(halo, 5.0).mul(0.014)),
    );
    // The halo should not wrap under the horizon.
    const aboveHorizon = smoothstep(-0.08, 0.05, d.y);

    return base.add(stars).add(moonBody.add(glow).mul(aboveHorizon));
  }
}

const WHITE = /*@__PURE__*/ new THREE.Color(1, 1, 1);
const NIGHT_SKY_TINT = /*@__PURE__*/ new THREE.Color(0.12, 0.2, 0.42);
const _skyTint = /*@__PURE__*/ new THREE.Color();

/**
 * Henyey–Greenstein phase function, normalised to 1/(4*pi) like Sky.js.
 * Node-typed values are intentionally `any`: TSL's chained builders are not
 * usefully expressible in TypeScript's type system.
 */
function henyeyGreenstein(cosTheta: any, g: any): any {
  const g2 = g.mul(g);
  const denom = pow(float(1).add(g2).sub(g.mul(cosTheta).mul(2.0)), 1.5);
  return float(1).sub(g2).div(denom).mul(ONE_OVER_FOUR_PI);
}

/** Cheap hash of a lattice cell to [0,1). Deterministic across both backends. */
function hash13(p: any): any {
  const q = p.mul(vec3(127.1, 311.7, 74.7));
  return fract(sin(q.x.add(q.y).add(q.z)).mul(43758.5453123));
}
