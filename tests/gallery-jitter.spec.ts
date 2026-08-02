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
  /** Luminance standard deviation — how much structure the band actually holds. */
  spread: number;
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
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 1; x < a.width - 1; x++) {
      const i = (y * a.width + x) * 4;
      temporal += Math.abs(a.data[i] - b.data[i]);
      // Laplacian along the row: a smooth gradient gives ~0, per-pixel noise
      // gives its own amplitude.
      highFreq += Math.abs(2 * a.data[i] - a.data[i - 4] - a.data[i + 4]);
      sum += a.data[i];
      sumSq += a.data[i] * a.data[i];
      n++;
    }
  }
  const mean = sum / n;
  return {
    temporal: temporal / n,
    highFreq: highFreq / n,
    spread: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
  };
}

/**
 * Ceilings on far-field shimmer, per tier.
 *
 * Set about 25% above the measured figures, which is room for driver and
 * scheduling variation without room for a regression. Medium runs two cascades
 * and the others three, which is the whole reason the tiers differ here.
 */
const SHIMMER_CEILING: Record<string, number> = {
  medium: 3.0,
  high: 4.6,
  ultra: 5.0,
  max: 5.2,
};

/**
 * Floor on near-field structure, as a luminance standard deviation.
 *
 * Not a Laplacian. Per-pixel Laplacian energy *rises* with distance, because a
 * distant pixel spans many wavelengths and a near one spans a fraction of
 * one — the near field measured lower than the far field on it, which makes it
 * useless as a detail floor. Standard deviation over the band asks the question
 * that matters instead: is there still wave structure here, or has it been
 * smoothed into a sheet? A flat plane scores near zero whatever its shading.
 *
 * Well below the measured figures, because its job is to catch a collapse
 * rather than to pin the exact amount of structure.
 */
const DETAIL_FLOOR = 8;

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
        `${far.highFreq.toFixed(3)}  |  near spread ${near.spread.toFixed(3)} ` +
        `highFreq ${near.highFreq.toFixed(3)}`,
    );

    expect(
      far.highFreq,
      `${quality}: far-field high-frequency energy is ${far.highFreq.toFixed(3)}, ` +
        `over the ${SHIMMER_CEILING[quality]} ceiling — the distant water is boiling again`,
    ).toBeLessThan(SHIMMER_CEILING[quality]);

    expect(
      near.spread,
      `${quality}: near-field structure collapsed to ${near.spread.toFixed(3)}. ` +
        'The shimmer figure can always be won by flattening the water; this is the ' +
        'assertion that stops that counting as a fix',
    ).toBeGreaterThan(DETAIL_FLOOR);
  }
});
