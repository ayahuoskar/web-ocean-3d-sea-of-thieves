import * as THREE from 'three/webgpu';
import { Fn, dot, max, mix, pow, uniform, vec3, vec4 } from 'three/tsl';

/**
 * A global colour grade, as the last thing that happens to the image before the
 * lens gets hold of it.
 *
 * **ASC CDL, and that choice is the whole design.** The grade is
 * `(x · slope + offset) ^ power`, per channel, followed by a saturation blend
 * about Rec.709 luma. That is the American Society of Cinematographers' colour
 * decision list — the interchange format a colourist's decisions are actually
 * shipped in — and it is defined on *linear* values, which is exactly what this
 * pass has. A lift/gamma/gain grade would have been the more obvious reach and
 * is defined on display-referred values; applying one here, before the tone
 * curve, would mean its gamma term was operating on scene radiance and doing
 * something quite unlike what its name promises.
 *
 * **Why here, and not after tone mapping.** `RenderPipeline` applies
 * `renderer.toneMapping` and the sRGB conversion *after* `outputNode`, because
 * `outputColorTransform` defaults to true. So everything in this chain is linear
 * HDR, and this pass shapes what ACES then compresses rather than fighting the
 * compression afterwards. Grading on top of a tone curve is how a highlight that
 * has already been rolled off gets pushed back up into a flat white; grading
 * underneath it means a warmed highlight is still a highlight when ACES gets to
 * it.
 *
 * **What this is not.** It is not a second exposure control — `toneMappingExposure`
 * is already per preset and already does that job, and duplicating it here would
 * give two knobs that fight. It is not a look *invention* either: each preset's
 * grade reinforces what that preset already is, because a preset that needs a
 * grade to become itself was not finished.
 *
 * The pass is not tiered. It costs a handful of arithmetic ops with no texture
 * reads, and a tier that dropped it would make the same preset a different
 * colour on different hardware — which is a worse outcome than the cost it
 * saves. Nor does it claim to be a pass-through at identity: the node graph is
 * built once and the grade lives in uniforms, so `pow` and `mix` are in every
 * frame at every tier, and `pow(x, 1)` is not guaranteed to return `x` bit-exactly.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ColorGradeParams {
  /** Per-channel multiplier. The CDL's gain — moves highlights most. */
  slope: THREE.Color;
  /** Per-channel addition. The CDL's lift — moves shadows most. */
  offset: THREE.Color;
  /** Per-channel exponent. The CDL's gamma — moves midtones most. */
  power: THREE.Color;
  /** 0 is monochrome, 1 is untouched, above 1 is more saturated. */
  saturation: number;
}

/** No-op grade. A preset spread over this is a preset that grades itself. */
export const IDENTITY_GRADE: Readonly<ColorGradeParams> = {
  slope: new THREE.Color(1, 1, 1),
  offset: new THREE.Color(0, 0, 0),
  power: new THREE.Color(1, 1, 1),
  saturation: 1,
};

/**
 * Rec.709 luma weights.
 *
 * The renderer's working primaries are sRGB/Rec.709, so these are the weights
 * that make a desaturated frame keep its apparent brightness. Using the naive
 * `(r+g+b)/3` instead is what turns a desaturating grade into one that also
 * darkens every green in the frame — which on a scene that is largely sky, sea
 * and canopy would be most of it.
 */
const LUMA_709 = /*@__PURE__*/ vec3(0.2126, 0.7152, 0.0722);

export class ColorGrade {
  private readonly uSlope = uniform(new THREE.Color(1, 1, 1));
  private readonly uOffset = uniform(new THREE.Color(0, 0, 0));
  private readonly uPower = uniform(new THREE.Color(1, 1, 1));
  private readonly uSaturation = uniform(1);

  /**
   * @param sceneColor Any composited colour node. Unlike the depth-of-field and
   *   lens-rain passes this one never re-samples the image at a displaced
   *   coordinate, so it does not need a texture node and imposes no `rtt`.
   */
  build(sceneColor: unknown): unknown {
    const src: any = sceneColor;
    if (src === null || src === undefined) {
      throw new Error('ColorGrade.build: sceneColor is required.');
    }

    return Fn(() => {
      const source = vec4(src).toVar('gradeSrc');

      // `max(0)` before the exponent, and it is not defensive tidiness: a
      // negative base with a fractional exponent is a NaN, and both the
      // volumetric fog's scattering integral and the lens flare's additive
      // ghosts can leave a channel a hair below zero in linear space. One NaN
      // pixel here survives every later stage and lands on screen.
      const lifted = max(source.rgb.mul(this.uSlope).add(this.uOffset), vec3(0)).toVar('gradeLift');
      const cdl = pow(lifted, this.uPower).toVar('gradeCdl');

      const luma = dot(cdl, LUMA_709).toVar('gradeLuma');
      return vec4(mix(vec3(luma), cdl, this.uSaturation), source.a);
    })();
  }

  setParams(params: Partial<ColorGradeParams>): void {
    if (params.slope !== undefined) this.uSlope.value.copy(params.slope);
    if (params.offset !== undefined) this.uOffset.value.copy(params.offset);
    if (params.power !== undefined) this.uPower.value.copy(params.power);
    if (params.saturation !== undefined) this.uSaturation.value = params.saturation;
  }

  /**
   * Owns no GPU resources.
   *
   * Present so that the post chain's teardown is uniform: every stage in
   * `src/post/` is disposed from `App.dispose`, and a stage that quietly did not
   * need it would be the one someone forgets to add when it later does.
   */
  dispose(): void {}
}
