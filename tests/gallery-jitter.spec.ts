import { expect, test } from '@playwright/test';
import { bootOcean, capture } from './lib/capture';
import { setCamera, setState } from './helpers';

/**
 * Shimmer, measured where genuine motion cannot reach.
 *
 * A plain frame-to-frame difference over the whole water cannot separate shimmer
 * from waves: the ripple cascade is a two-metre band, its phase speed is metres
 * per second, and it legitimately redraws the near field in 1/60 s. Every earlier
 * reading was mostly that.
 *
 * The far field is the discriminator. Beyond a couple of hundred metres a wave
 * moves a fraction of a pixel per frame, so anything that changes there is
 * sampling noise. This measures a horizontal band just under the horizon and
 * reports both the temporal change and the high-spatial-frequency energy, which
 * separates "the image is noisy" from "the noise is moving".
 */

/**
 * Two bands, and the second one is what stops this test rewarding blur.
 *
 * `FAR` sits just under the horizon, where a wave moves a fraction of a pixel
 * per frame and anything changing is sampling noise — so its high-frequency
 * energy is the shimmer figure. On its own that figure is minimised by
 * destroying detail, which would make "render a flat blue plane" the winning
 * strategy. `NEAR` is the bottom of the frame, metres away, where the wave
 * detail is genuinely resolvable and must survive: a change that smooths the
 * far field is only a fix if the near field still has structure in it.
 */
const FAR = { lo: 0.47, hi: 0.6 };
const NEAR = { lo: 0.78, hi: 0.96 };

interface BandStats {
  temporal: number;
  highFreq: number;
  /** Mean |luminance step| between horizontally adjacent pixels. */
  detail: number;
}

function analyse(
  a: Awaited<ReturnType<typeof capture>>,
  b: typeof a,
  band: { lo: number; hi: number },
): BandStats {
  const y0 = Math.floor(a.height * band.lo);
  const y1 = Math.floor(a.height * band.hi);
  let temporal = 0;
  let highFreq = 0;
  let detail = 0;
  let n = 0;
  const luma = (i: number, img: typeof a) =>
    0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
  for (let y = y0; y < y1; y++) {
    for (let x = 1; x < a.width - 1; x++) {
      const i = (y * a.width + x) * 4;
      const here = luma(i, a);
      temporal += Math.abs(here - luma(i, b));
      // Laplacian along the row: a smooth gradient gives ~0, per-pixel noise
      // gives its own amplitude.
      highFreq += Math.abs(2 * here - luma(i - 4, a) - luma(i + 4, a));
      detail += Math.abs(here - luma(i - 4, a));
      n++;
    }
  }
  return { temporal: temporal / n, highFreq: highFreq / n, detail: detail / n };
}

/**
 * Ceilings on far-field spatial noise, per tier.
 *
 * Set about 25% above the measured figures — room for driver and scheduling
 * variation, not room for a regression. Medium runs two cascades and the others
 * three, which is the whole reason the tiers differ here.
 */
const SHIMMER_CEILING: Record<string, number> = {
  medium: 1.8,
  high: 3.0,
  ultra: 3.2,
  max: 3.3,
};

/**
 * Ceilings on far-field frame-to-frame change.
 *
 * The spatial figure alone is not enough, and the first version of this test had
 * only that one: a band flashing uniformly from black to white every frame
 * carries no horizontal structure at all, so it scores zero on a Laplacian and
 * would have passed every ceiling while being the worst shimmer imaginable. Both
 * have to be bounded.
 */
const TEMPORAL_CEILING: Record<string, number> = {
  medium: 1.3,
  high: 2.2,
  ultra: 2.4,
  max: 2.3,
};

/**
 * Floor on near-field structure: the mean luminance step between horizontally
 * adjacent pixels.
 *
 * Not a Laplacian, and not a standard deviation. Per-pixel Laplacian energy
 * *rises* with distance — a distant pixel spans many wavelengths and a near one
 * spans a fraction of one — so the near field measured lower on it than the far
 * field, which makes it useless here. Standard deviation over the band is worse:
 * it cannot tell wave detail from a smooth vertical gradient, and this frame has
 * several of those in it (Fresnel, aerial perspective, the reflected sky), so a
 * flat band with an ordinary lighting ramp across it passes comfortably.
 *
 * The mean adjacent-pixel step has neither problem. A linear ramp of forty
 * levels across the frame contributes about 0.03 per pixel; water with waves in
 * it contributes a whole level or more.
 */
const DETAIL_FLOOR = 0.4;

test('the far field does not shimmer, and the near field keeps its detail', async ({ page }) => {
  test.setTimeout(600_000);
  await bootOcean(page);
  for (const quality of ['medium', 'high', 'ultra', 'max'] as const) {
    await setState(page, { quality, preset: 'skyPro', windSpeed: 15 });
    await setCamera(page, [-46, 9, 44], [-90, 6, 8]);

    await page.evaluate(() => window.__ocean.resetDeterministic(23.5, 60));
    const a = await capture(page);
    await page.evaluate(() => window.__ocean.step(1 / 60, 1));
    const b = await capture(page);

    const far = analyse(a, b, FAR);
    const near = analyse(a, b, NEAR);
    console.log(
      `SHIMMER ${quality.padEnd(7)} far temporal ${far.temporal.toFixed(3)} highFreq ` +
        `${far.highFreq.toFixed(3)}  |  near detail ${near.detail.toFixed(3)}`,
    );

    expect(
      far.highFreq,
      `${quality}: far-field high-frequency energy is ${far.highFreq.toFixed(3)}, ` +
        `over the ${SHIMMER_CEILING[quality]} ceiling — the distant water is boiling again`,
    ).toBeLessThan(SHIMMER_CEILING[quality]);

    expect(
      far.temporal,
      `${quality}: the far field changed by ${far.temporal.toFixed(3)} levels in one frame, ` +
        `over the ${TEMPORAL_CEILING[quality]} ceiling — at this distance a wave moves a ` +
        'fraction of a pixel, so this is the image reshuffling rather than the sea moving',
    ).toBeLessThan(TEMPORAL_CEILING[quality]);

    expect(
      near.detail,
      `${quality}: near-field structure collapsed to ${near.detail.toFixed(3)}. ` +
        'The shimmer figure can always be won by flattening the water; this is the ' +
        'assertion that stops that counting as a fix',
    ).toBeGreaterThan(DETAIL_FLOOR);
  }
});
