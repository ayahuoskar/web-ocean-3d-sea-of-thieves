import { test, expect } from '@playwright/test';
import { frameMean, setCamera, setState } from './helpers';
import { bootOcean } from './lib/capture';

/**
 * The post chain's four image stages: grade, bloom, depth of field, lens flare.
 *
 * These are behavioural rather than pictorial on purpose. What a graded frame
 * *looks* like is the visual suite's job, and it answers it by comparing whole
 * images against a baseline. What this file asks is narrower and cannot be
 * answered that way: is the stage actually in the chain, does its one defining
 * property hold, and does turning it off genuinely turn it off. A baseline
 * comparison passes just as happily against a stage that was never wired in —
 * it only knows the image changed, not which of five things changed it.
 *
 * Every test here pins a camera and calls `resetDeterministic` before measuring,
 * for the reason the shot list's own header gives: without it a measurement
 * depends on whatever the previous test left behind.
 */

test.describe('colour grade', () => {
  test('is in the chain, and a warm slope warms the frame', async ({ page }) => {
    await bootOcean(page);
    await setState(page, { preset: 'skyPro', quality: 'high', cameraMode: 'orbit' });
    await setCamera(page, [-42, 21, 63], [0, 3, 0]);
    await page.evaluate(() => window.__ocean.resetDeterministic(12, 90));

    const identity = await page.evaluate(async () => {
      window.__ocean.setGrade({
        slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1,
      });
      await window.__ocean.step(1 / 60, 2);
      const { data } = await window.__ocean.capturePixels();
      return Array.from(data.slice(0, 4096));
    });

    const warmed = await page.evaluate(async () => {
      window.__ocean.setGrade({
        slope: [1.25, 1, 0.8], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1,
      });
      await window.__ocean.step(1 / 60, 2);
      const { data } = await window.__ocean.capturePixels();
      return Array.from(data.slice(0, 4096));
    });

    // Wired at all.
    expect(warmed).not.toEqual(identity);

    // And wired the right way round. A slope that lifts red and cuts blue must
    // raise the red-to-blue ratio; a stage that was in the chain backwards, or
    // reading the wrong uniform, would still fail the equality above.
    const channel = (a: number[], offset: number) =>
      a.reduce((sum, v, i) => (i % 4 === offset ? sum + v : sum), 0);
    const identityRatio = channel(identity, 0) / channel(identity, 2);
    const warmedRatio = channel(warmed, 0) / channel(warmed, 2);
    expect(warmedRatio).toBeGreaterThan(identityRatio);

    // Leave it as it was found: `setGrade` writes uniforms that outlive the test,
    // and the suite shares a page across tests in some projects.
    await page.evaluate(() =>
      window.__ocean.setGrade({
        slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1,
      }),
    );
  });

  test('desaturating to zero leaves a monochrome frame', async ({ page }) => {
    await bootOcean(page);
    await setState(page, { preset: 'skyPro', quality: 'high', cameraMode: 'orbit' });
    await setCamera(page, [-42, 21, 63], [0, 3, 0]);
    await page.evaluate(() => window.__ocean.resetDeterministic(12, 90));

    const spread = await page.evaluate(async () => {
      window.__ocean.setGrade({
        slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], saturation: 0,
      });
      await window.__ocean.step(1 / 60, 2);
      const { data } = await window.__ocean.capturePixels();
      // Largest channel spread anywhere in the frame. A correct desaturation
      // makes this zero up to the 8-bit quantisation of three equal linear
      // values through the tone curve, which is at most one level.
      let worst = 0;
      for (let i = 0; i < data.length; i += 4) {
        const max = Math.max(data[i], data[i + 1], data[i + 2]);
        const min = Math.min(data[i], data[i + 1], data[i + 2]);
        worst = Math.max(worst, max - min);
      }
      return worst;
    });

    expect(spread).toBeLessThanOrEqual(1);

    await page.evaluate(() =>
      window.__ocean.setGrade({
        slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1,
      }),
    );
  });
});

/**
 * Rewind, set the stage, then measure — in that order, every time.
 *
 * `frameMean` advances the world by two steps to let the frame converge, so two
 * consecutive calls photograph *different seas* and their difference is mostly
 * the swell moving. That is not a subtle effect: it is larger than the whole
 * contribution of a restrained bloom, and it is what made the first cut of the
 * Low test fail against a stage that was working correctly.
 */
async function measureAt(
  page: import('@playwright/test').Page,
  time: number,
  prepare: () => Promise<void>,
): Promise<number> {
  await page.evaluate((t) => window.__ocean.resetDeterministic(t, 90), time);
  await prepare();
  return frameMean(page);
}

test.describe('bloom', () => {
  const SUNSET_TIME = 31.25;

  test('lifts the sun track and cannot darken the frame', async ({ page }) => {
    await bootOcean(page);
    // Sunset, looking straight down the sun's track: the one composition in the
    // shot list where a large part of the frame is genuinely above 1.0 in
    // linear, which is what the pyramid's threshold selects on.
    await setState(page, { preset: 'sunset', quality: 'high', cameraMode: 'orbit' });
    await setCamera(page, [58, 7, 9], [0, 4, 0]);

    const on = await measureAt(page, SUNSET_TIME, () =>
      page.evaluate(() => window.__ocean.setBloomEnabled(true)),
    );
    const off = await measureAt(page, SUNSET_TIME, () =>
      page.evaluate(() => window.__ocean.setBloomEnabled(false)),
    );

    // Additive by construction: `bloom()` returns a contribution which the chain
    // adds. If this ever came out darker, the stage would be replacing the image
    // rather than adding to it — which is the mistake the node's own usage
    // example exists to prevent, and which a baseline diff would not name.
    expect(on).toBeGreaterThan(off);

    await page.evaluate(() => window.__ocean.setBloomEnabled(true));
  });

  test('the Low tier actually reaches the stage', async ({ page }) => {
    await bootOcean(page);
    await setState(page, { preset: 'sunset', quality: 'low', cameraMode: 'orbit' });
    await setCamera(page, [58, 7, 9], [0, 4, 0]);

    // Low differs from High for a dozen reasons besides bloom, so comparing the
    // two tiers proves nothing about this stage. What does prove something is
    // asking whether the tier's own value arrived: at Low, turning bloom off
    // must be a no-op, and forcing it on must not be. A `bloom` field that
    // nothing read would pass the second check and fail the first.
    const asTierLeftIt = await measureAt(page, SUNSET_TIME, async () => {});
    const forcedOff = await measureAt(page, SUNSET_TIME, () =>
      page.evaluate(() => window.__ocean.setBloomEnabled(false)),
    );
    expect(Math.abs(forcedOff - asTierLeftIt)).toBeLessThan(0.01);

    const forcedOn = await measureAt(page, SUNSET_TIME, () =>
      page.evaluate(() => window.__ocean.setBloomEnabled(true)),
    );
    expect(forcedOn).toBeGreaterThan(asTierLeftIt);

    await setState(page, { quality: 'high' });
  });
});
