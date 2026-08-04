import { test, expect } from '@playwright/test';
import { setCamera, setState } from './helpers';
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
