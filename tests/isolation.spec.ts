import { expect, test } from '@playwright/test';
import { applyShot, bootOcean, capture } from './lib/capture';
import { SHOTS, type Shot } from './lib/shots';

/**
 * `resetDeterministic` must make a shot independent of the shot before it.
 *
 * It did not, and the failure was expensive rather than obvious: the boat shot
 * captured straight after the storm came out with heavier foam and a wetter hull
 * than the same shot captured first, so every baseline was quietly a function of
 * the order the suite happened to run in. The gallery works around it by
 * reloading the page between images, which is the right thing for a published
 * picture and the wrong thing to rely on — a workaround downstream of a defect
 * cannot tell you when the defect comes back.
 *
 * This is the check that can. It photographs the same shot twice, once cold and
 * once immediately after the most extreme state in the shot list, and requires
 * the two to agree. It fails when the reset path is *disconnected* — drop any
 * `resetClock` from `resetDeterministic` and the storm leaks through.
 */

const shot = (id: string): Shot => {
  const found = SHOTS.find((s) => s.id === id);
  if (found === undefined) throw new Error(`isolation: no canonical shot "${id}"`);
  return found;
};

/**
 * Mean absolute luminance difference per pixel, 0..255.
 *
 * The tolerance is not zero. Two legitimately-identical frames still differ by a
 * fraction of a level from half-float rounding in the FFT and the order the GPU
 * happens to reduce a tile in, so an exact comparison would fail on noise. The
 * defect this guards against was worth several levels across a third of the
 * frame, which this catches with room to spare.
 */
function meanDifference(a: Awaited<ReturnType<typeof capture>>, b: typeof a): number {
  expect(a.width).toBe(b.width);
  expect(a.height).toBe(b.height);
  let total = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    total +=
      (Math.abs(a.data[o] - b.data[o]) +
        Math.abs(a.data[o + 1] - b.data[o + 1]) +
        Math.abs(a.data[o + 2] - b.data[o + 2])) /
      3;
  }
  return total / n;
}

test.describe('shot isolation', () => {
  for (const target of ['boat-chase', 'clear-day-wide']) {
    test(`${target} is independent of the shot before it`, async ({ page }) => {
      test.setTimeout(300_000);

      // Cold: a fresh page, this shot and nothing else.
      await page.goto('/');
      await bootOcean(page);
      await applyShot(page, shot(target));
      const cold = await capture(page);

      // Hot: the storm first — the heaviest sea state, rain rate and wetness in
      // the list — then the same shot, on the same page.
      await page.goto('/');
      await bootOcean(page);
      await applyShot(page, shot('storm'));
      await capture(page);
      await applyShot(page, shot(target));
      const hot = await capture(page);

      const difference = meanDifference(cold, hot);
      console.log(`[isolation] ${target}: mean |dL| after storm = ${difference.toFixed(3)}`);
      expect(difference).toBeLessThan(1.5);
    });
  }
});
