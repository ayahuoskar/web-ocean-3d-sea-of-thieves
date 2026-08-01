import * as THREE from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  interleavedGradientNoise,
  max,
  min,
  mx_fractal_noise_float,
  normalize,
  positionGeometry,
  pow,
  screenCoordinate,
  smoothstep,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { smoothstepDown } from '../core/tslMath';

/**
 * Raymarched volumetric cloud layer.
 *
 * The layer is a horizontal slab of procedural FBM density between `altitude`
 * and `altitude + thickness`. It is rendered on a camera-locked dome: the dome
 * only supplies view rays, the march itself happens in world space, so the dome
 * radius is unrelated to the cloud altitude.
 *
 * Density is entirely procedural (`mx_fractal_noise_float`) — there is no 3D
 * noise texture to download and nothing to keep resident in VRAM.
 *
 * Lighting is single-scattering: a short secondary march toward the sun gives
 * per-sample transmittance (bright tops, dark bases), combined with a
 * Henyey–Greenstein lobe that produces the silver lining when looking near the
 * sun. Compare ref-default.png (scattered cumulus) and ref-storm.png (overcast).
 */

export interface CloudParams {
  coverage: number; // 0..1, wired to the demo's Cloud Coverage slider
  density: number;
  altitude: number; // metres
  thickness: number;
  windSpeed: number;
  windDirection: number;
  /**
   * Rate at which billows grow and erode in place, in noise units per second.
   *
   * Distinct from `windSpeed`, which only translates the layer. At the
   * kilometre feature scale this noise runs at, translation is imperceptible on
   * the timescale anyone looks at a demo for — evolution is what makes the sky
   * read as moving.
   */
  evolutionRate: number;
  steps: number; // raymarch steps; 0 disables the layer entirely
  color: THREE.Color;
  shadowColor: THREE.Color;
}

export const DEFAULT_CLOUD_PARAMS: CloudParams = {
  coverage: 0.32,
  density: 1,
  altitude: 1400,
  thickness: 700,
  windSpeed: 9,
  windDirection: 2.6,
  evolutionRate: 0.012,
  steps: 24,
  color: new THREE.Color(1.0, 0.99, 0.96),
  shadowColor: new THREE.Color(0.34, 0.38, 0.47),
};

/** Dome radius in metres — see Atmosphere for why this can be small. */
const DOME_RADIUS = 100;

/** Hard ceiling on the loop the shader is compiled with. */
const MAX_STEPS = 96;
/** Secondary samples taken toward the sun per march step. */
const LIGHT_STEPS = 4;

/** Longest slab crossing we will march, as a multiple of `thickness`. */
const MAX_SPAN_FACTOR = 10;

/** Feature scale of the base noise: 1 noise unit ~= 1/NOISE_SCALE metres. */
const NOISE_SCALE = 0.00055;

/**
 * Measured quantiles of `mx_fractal_noise_float(p, 4, 2, 0.5, 1) * 0.5 + 0.5`,
 * sampled over a 256^2 patch: the field is near-Gaussian around 0.5 with
 * sigma ~= 0.16, NOT uniform over 0..1.
 *
 * That matters because the naive `threshold = 1 - coverage` remap is then wildly
 * non-linear — coverage 0.32 would put the threshold at 0.68, i.e. above the
 * 90th percentile, leaving the sky essentially clear. Mapping coverage through
 * the measured inverse CDF instead makes the slider behave as "fraction of sky
 * covered", which is what the demo's Cloud Coverage control implies.
 *
 * Pairs are [coveredFraction, noiseThreshold], ascending in fraction.
 */
const COVERAGE_QUANTILES: ReadonlyArray<readonly [number, number]> = [
  [0.0, 1.05],
  [0.05, 0.761],
  [0.25, 0.612],
  [0.5, 0.502],
  [0.75, 0.388],
  [0.95, 0.239],
  [1.0, -0.06],
];

/** Softness of the cloud edge in noise units. Crisper = puffier cumulus. */
const EDGE_WIDTH = 0.1;

/** Strength of the single-scattering term with the sun fully above the horizon. */
const SUN_GAIN = 1.5;

function coverageToThreshold(coverage: number): number {
  const c = Math.min(1, Math.max(0, coverage));
  for (let i = 1; i < COVERAGE_QUANTILES.length; i++) {
    const [f1, t1] = COVERAGE_QUANTILES[i];
    if (c <= f1) {
      const [f0, t0] = COVERAGE_QUANTILES[i - 1];
      const k = f1 === f0 ? 0 : (c - f0) / (f1 - f0);
      return t0 + (t1 - t0) * k;
    }
  }
  return COVERAGE_QUANTILES[COVERAGE_QUANTILES.length - 1][1];
}

export class Clouds {
  readonly mesh: THREE.Mesh;

  private readonly params: CloudParams;
  private readonly geometry: THREE.SphereGeometry;
  private readonly material: THREE.MeshBasicNodeMaterial;

  /** Integrated wind displacement, metres. Reused — never reallocated. */
  private readonly windOffset = new THREE.Vector3();
  private readonly windVector = new THREE.Vector3(1, 0, 0);
  /** Accumulated evolution phase; see `update`. */
  private evolution = 0;
  private readonly uEvolution: any = uniform(new THREE.Vector3());

  // --- uniforms -------------------------------------------------------------
  /** Noise threshold derived from `coverage` on the CPU — see COVERAGE_QUANTILES. */
  private readonly uThreshold = uniform(0.66);
  private readonly uDensity = uniform(1);
  private readonly uAltitude = uniform(1400);
  private readonly uThickness = uniform(700);
  // Loosely typed on purpose — see the note in Atmosphere.ts. `uSteps` also has
  // to be usable as a dynamic `Loop` bound, which the typings do not model.
  private readonly uSteps: any = uniform(24, 'int');
  private readonly uInvSteps = uniform(1 / 24);
  private readonly uColor: any = uniform(new THREE.Color(1, 1, 1));
  private readonly uShadowColor: any = uniform(new THREE.Color(0.34, 0.38, 0.47));
  private readonly uSunDir = uniform(new THREE.Vector3(0, 1, 0));
  private readonly uWindOffset = uniform(new THREE.Vector3());
  /** Extinction per metre of unit density. */
  private readonly uExtinction = uniform(0.006);
  private readonly uLightStep = uniform(175);
  private readonly uSunGain = uniform(SUN_GAIN);
  private readonly uAmbientGain = uniform(0.55);

  constructor() {
    this.params = {
      ...DEFAULT_CLOUD_PARAMS,
      color: DEFAULT_CLOUD_PARAMS.color.clone(),
      shadowColor: DEFAULT_CLOUD_PARAMS.shadowColor.clone(),
    };

    this.geometry = new THREE.SphereGeometry(1, 40, 24);

    this.material = new THREE.MeshBasicNodeMaterial();
    this.material.side = THREE.BackSide;
    this.material.depthWrite = false;
    this.material.depthTest = false;
    this.material.fog = false;
    // Deliberately NOT `transparent`. Transparent materials are drawn after the
    // whole opaque queue, which would put the clouds on top of the ocean and the
    // ship. `CustomBlending` keeps the mesh in the opaque queue — where
    // renderOrder still orders it right behind the sky — while still alpha
    // blending. Both the WebGPU and the WebGL2 backend honour this.
    this.material.transparent = false;
    this.material.blending = THREE.CustomBlending;
    this.material.blendEquation = THREE.AddEquation;
    this.material.blendSrc = THREE.SrcAlphaFactor;
    this.material.blendDst = THREE.OneMinusSrcAlphaFactor;
    this.material.blendEquationAlpha = THREE.AddEquation;
    this.material.blendSrcAlpha = THREE.OneFactor;
    this.material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;

    this.material.colorNode = this.buildCloudNode();
    this.material.positionNode = positionGeometry.mul(DOME_RADIUS).add(cameraPosition);

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'cloud-layer';
    this.mesh.renderOrder = -900;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;

    this.applyParams();
  }

  setParams(params: Partial<CloudParams>): void {
    if (params.color !== undefined) this.params.color.copy(params.color);
    if (params.shadowColor !== undefined) this.params.shadowColor.copy(params.shadowColor);
    if (params.coverage !== undefined) this.params.coverage = params.coverage;
    if (params.density !== undefined) this.params.density = params.density;
    if (params.altitude !== undefined) this.params.altitude = params.altitude;
    if (params.thickness !== undefined) this.params.thickness = params.thickness;
    if (params.windSpeed !== undefined) this.params.windSpeed = params.windSpeed;
    if (params.windDirection !== undefined) this.params.windDirection = params.windDirection;
    if (params.evolutionRate !== undefined) this.params.evolutionRate = params.evolutionRate;
    if (params.steps !== undefined) this.params.steps = params.steps;
    this.applyParams();
  }

  getParams(): Readonly<CloudParams> {
    return this.params;
  }

  setSunDirection(dir: THREE.Vector3): void {
    this.uSunDir.value.copy(dir).normalize();
    // Once the sun is under the horizon the single-scattering term has to go
    // with it, otherwise the deck stays lit like midday against a night sky.
    // Derived here rather than exposed, so callers only have to push the vector.
    const above = Math.min(1, Math.max(0, (this.uSunDir.value.y + 0.09) / 0.18));
    this.uSunGain.value = SUN_GAIN * above * above * (3 - 2 * above);
  }

  /**
   * Returns the wind advection to its origin.
   *
   * The offset is *accumulated*, not derived from a clock, so unlike the other
   * animated systems it cannot be reproduced by setting a time — it has to be
   * rewound explicitly for a capture to be repeatable.
   */
  resetWind(): void {
    this.windOffset.set(0, 0, 0);
    this.uWindOffset.value.copy(this.windOffset);
    this.evolution = 0;
    this.uEvolution.value.set(0, 0, 0);
  }

  update(dt: number): void {
    if (!this.mesh.visible) return;
    this.windOffset.addScaledVector(this.windVector, dt * this.params.windSpeed);
    // Wrap on the noise period so the offset never grows large enough to eat
    // float precision in a long-running session.
    const period = 1 / NOISE_SCALE;
    this.windOffset.x %= period;
    this.windOffset.z %= period;
    this.uWindOffset.value.copy(this.windOffset);

    // Evolution runs across the wind, so growth is not just more translation
    // wearing a different name.
    this.evolution += dt * this.params.evolutionRate;
    this.evolution %= 1000;
    this.uEvolution.value.set(this.evolution * 0.31, this.evolution, this.evolution * -0.19);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  // -------------------------------------------------------------------------

  private applyParams(): void {
    const p = this.params;

    this.uThreshold.value = coverageToThreshold(p.coverage);
    this.uDensity.value = Math.max(0, p.density);
    this.uAltitude.value = p.altitude;
    this.uThickness.value = Math.max(1, p.thickness);
    this.uColor.value.copy(p.color);
    this.uShadowColor.value.copy(p.shadowColor);

    const steps = Math.max(0, Math.min(MAX_STEPS, Math.round(p.steps)));
    // steps === 0 is the Low tier: the layer must cost literally nothing.
    this.mesh.visible = steps > 0;
    this.uSteps.value = Math.max(1, steps);
    this.uInvSteps.value = 1 / Math.max(1, steps);

    this.uLightStep.value = (p.thickness / LIGHT_STEPS) * 1.1;

    this.windVector.set(Math.cos(p.windDirection), 0, Math.sin(p.windDirection));
  }

  /**
   * Density at a world-space point. Written as a plain helper rather than a
   * `Fn` with a declared layout so it inlines at both call sites (main march and
   * light march) without needing an exact TSL signature.
   */
  /**
   * @param softness 0..1 LOD term. The march step grows with distance, so far
   *   clouds are sampled far below the Nyquist rate of the noise field and
   *   shimmer. Widening the density edge in step with the step size band-limits
   *   the field instead — distant decks go smooth rather than hatched.
   */
  private densityAt(p: any, softness: any): any {
    const h = p.y.sub(this.uAltitude).div(this.uThickness);

    // Flat base, rounded top — the cumulus profile in ref-default.png. Raising
    // the threshold toward the top and bottom of the slab (rather than only
    // scaling density) is what makes the puffs read as rounded volumes instead
    // of as a sheet with soft edges.
    const profile = smoothstep(0.0, 0.12, h).mul(smoothstepDown(h, 0.42, 1.0));

    const q = p.sub(this.uWindOffset).mul(NOISE_SCALE);
    const base = mx_fractal_noise_float(q, 4, 2.0, 0.5, 1.0).mul(0.5).add(0.5);

    // A second, higher-frequency field erodes the billow edges so the silhouette
    // is not a smooth blob. Centred on zero so it breaks edges up without
    // shifting the overall coverage the threshold was calibrated for.
    //
    // It is also *evolved*, on its own clock, at right angles to the wind.
    // Translation alone cannot make a cloud look alive: features here are
    // kilometre-scale, so at any honest wind speed a puff takes minutes to cross
    // its own width and the layer reads as a painted backdrop being slid past.
    // What the eye actually reads as weather is the silhouette changing —
    // billows growing and eroding in place — and that is a second offset through
    // the noise field rather than a faster one along the wind.
    const detail = mx_fractal_noise_float(
      q.mul(4.3).add(vec3(7.3, 2.1, 5.7)).add(this.uEvolution),
      3,
      2.0,
      0.5,
      1.0,
    ).mul(0.5);

    const edge = this.uThreshold.add(float(1).sub(profile).mul(0.22));
    const width = float(EDGE_WIDTH).add(softness.mul(0.4));

    // The erosion octave fades out as the march coarsens.
    //
    // `softness` already widened the edge with step size, which softens the
    // silhouette but does nothing about the detail field itself — and that field
    // runs at 4.3x the base frequency, so its features are a few hundred metres
    // across. The storm preset marches a 1400 m slab in 24 steps, nearly 60 m a
    // sample, and sampling a 400 m feature at 60 m intervals along a ray whose
    // direction varies smoothly across the screen is exactly the recipe for
    // moire — which is what the banding across the storm cloud deck was. Detail
    // the march cannot resolve is not detail, it is noise, so it is faded rather
    // than sampled. Same reasoning as the wave cascades' geometry fade.
    const detailFade = float(1).sub(softness).clamp(0, 1);
    const shaped = smoothstep(edge, edge.add(width), base.add(detail.mul(detailFade).mul(0.3)));

    return shaped.mul(profile).mul(this.uDensity);
  }

  private buildCloudNode(): any {
    return Fn(() => {
      const rd = normalize(positionGeometry).toVar('cloudRd');
      const ro = cameraPosition.toVar('cloudRo');

      const result = vec4(0, 0, 0, 0).toVar('cloudResult');
      const up = rd.y.toVar('cloudUp');

      If(up.greaterThan(0.015), () => {
        const hBottom = this.uAltitude.sub(ro.y);
        const hTop = this.uAltitude.add(this.uThickness).sub(ro.y);

        const tEnter = max(hBottom.div(up), 0.0).toVar('tEnter');
        const tExitRaw = max(hTop.div(up), 0.0);
        // Grazing rays cross an enormous span; clamping keeps the step size —
        // and therefore the banding — bounded near the horizon.
        const tExit = min(tExitRaw, tEnter.add(this.uThickness.mul(MAX_SPAN_FACTOR))).toVar('tExit');

        If(tExit.greaterThan(tEnter), () => {
          const stepSize = tExit.sub(tEnter).mul(this.uInvSteps).toVar('cloudStep');
          // Offsetting each pixel's first sample turns the raymarch's concentric
          // banding into fine noise, which reads as cloud texture instead of as
          // contour lines. Interleaved gradient noise rather than a plain hash:
          // a 2D hash of the pixel coordinate leaves visible diagonal hatching at
          // these step counts, IGN does not.
          const jitter = interleavedGradientNoise(screenCoordinate);
          const t = tEnter.add(stepSize.mul(jitter)).toVar('cloudT');

          const transmittance = float(1).toVar('cloudTr');
          const scattered = vec3(0, 0, 0).toVar('cloudScatter');

          const cosTheta = dot(rd, this.uSunDir).toVar('cloudCos');
          // Strong forward lobe + a weak backward lobe: the forward term is what
          // makes cloud edges glow when the sun is behind them. The raw HG spike
          // is ~30x at zero scattering angle, which blows the disc around the sun
          // to pure white, so it is clamped to a usable silver-lining range.
          const phase = clamp(
            hg(cosTheta, 0.76).mul(0.75).add(hg(cosTheta, -0.2).mul(0.25)).mul(12.566),
            0.35,
            3.2,
          ).toVar('cloudPhase');

          const softness = clamp(stepSize.mul(0.0032), 0.0, 1.0).toVar('cloudLod');

          Loop(this.uSteps, () => {
            const p = ro.add(rd.mul(t));
            const d = this.densityAt(p, softness).toVar('cloudD');

            If(d.greaterThan(0.002), () => {
              // --- single-scattering: transmittance toward the sun ------------
              const lightAcc = float(0).toVar('cloudLightAcc');
              Loop(LIGHT_STEPS, ({ i }: any) => {
                const lp = p.add(this.uSunDir.mul(this.uLightStep.mul(float(i).add(1.0))));
                lightAcc.addAssign(this.densityAt(lp, softness));
              });
              const lightT = exp(
                lightAcc.mul(this.uLightStep).mul(this.uExtinction).negate(),
              ).toVar('cloudLightT');

              // Powder term — darkens the parts of the cloud facing the viewer
              // that are optically thin, which reads as internal structure.
              const powder = float(1).sub(exp(d.mul(-2.4)));

              const sunTerm = lightT.mul(phase).mul(powder).mul(this.uSunGain);
              const lum = this.uShadowColor
                .mul(this.uAmbientGain)
                .add(this.uColor.mul(sunTerm))
                .toVar('cloudLum');

              const sampleT = exp(d.mul(stepSize).mul(this.uExtinction).negate());
              // Energy-conserving analytic integration over the step.
              scattered.addAssign(lum.mul(float(1).sub(sampleT)).mul(transmittance));
              transmittance.mulAssign(sampleT);
            });

            t.addAssign(stepSize);

            If(transmittance.lessThan(0.01), () => {
              Break();
            });
          });

          // Aerial perspective: the deck has to dissolve into haze with distance
          // or the slab reads as a hard ceiling with a cut-off edge. Kept gentle
          // — too strong and full overcast stops reaching the horizon.
          const distanceFade = exp(tEnter.mul(-0.000012));
          result.assign(vec4(scattered, float(1).sub(transmittance).mul(distanceFade)));
        });
      });

      // Fade the slab out at the horizon, where it would otherwise stretch to
      // infinity along a grazing ray.
      const horizonFade = smoothstep(0.015, 0.075, up);
      const alpha = clamp(result.w.mul(horizonFade), 0.0, 1.0);

      return vec4(result.xyz, alpha);
    })();
  }
}

/** Henyey–Greenstein phase, 1/(4*pi) normalised. */
function hg(cosTheta: any, g: number): any {
  const g2 = g * g;
  const denom = pow(float(1 + g2).sub(cosTheta.mul(2 * g)), 1.5);
  return float(1 - g2).div(max(denom, 1e-4)).mul(0.07957747154594767);
}
