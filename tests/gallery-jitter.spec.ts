import { test } from '@playwright/test';
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

const BAND = { lo: 0.47, hi: 0.6 };

async function measure(page: any): Promise<{ temporal: number; highFreq: number }> {
  await page.evaluate(() => window.__ocean.resetDeterministic(23.5, 60));
  const a = await capture(page);
  await page.evaluate(() => window.__ocean.step(1 / 60, 1));
  const b = await capture(page);
  const y0 = Math.floor(a.height * BAND.lo);
  const y1 = Math.floor(a.height * BAND.hi);
  let temporal = 0;
  let highFreq = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 1; x < a.width - 1; x++) {
      const i = (y * a.width + x) * 4;
      temporal += Math.abs(a.data[i] - b.data[i]);
      // Laplacian along the row: a smooth gradient gives ~0, per-pixel noise
      // gives its own amplitude.
      highFreq += Math.abs(2 * a.data[i] - a.data[i - 4] - a.data[i + 4]);
      n++;
    }
  }
  return { temporal: temporal / n, highFreq: highFreq / n };
}

test('shimmer in the far field', async ({ page }) => {
  test.setTimeout(600_000);
  await bootOcean(page);
  for (const quality of ['medium', 'high', 'ultra', 'max'] as const) {
    await setState(page, { quality, preset: 'skyPro', windSpeed: 15 });
    await setCamera(page, [-46, 9, 44], [-90, 6, 8]);
    const m = await measure(page);
    console.log(
      `SHIMMER ${quality.padEnd(7)} temporal ${m.temporal.toFixed(3)}  highFreq ${m.highFreq.toFixed(3)}`,
    );
  }
});
