import { expect, test } from '@playwright/test';
import { bootOcean, capture } from './lib/capture';
import { setCamera, setState } from './helpers';

/**
 * Is the white in the waterline shot foam, or is it the sky?
 *
 * The question is not rhetorical and it gates real work. At a camera two
 * centimetres above the surface every wave face is at grazing incidence, where
 * Fresnel reflectance approaches one and the water legitimately returns a pale
 * sky — so a frame full of white is not evidence of a foam problem. Whitecap
 * *coverage* is already governed by Monahan and pinned by `foam.spec.ts`, so the
 * amount is unlikely to be wrong either.
 *
 * Changing the foam terms on the strength of "it looks white" would therefore be
 * tuning a term that may not be the one at fault. This measures which it is
 * before anything is touched: capture the frame, force foam and surf to zero,
 * capture again, and see how much of the water actually moves.
 */
interface FoamShare {
  /** Fraction of water pixels moving more than 8 levels when foam is removed. */
  fraction: number;
  mean: number;
  peak: number;
}

/**
 * How much of the lower half of a given shot is foam.
 *
 * Takes the whole shot rather than one varying parameter, because the control
 * and the measurement need to differ in scene as well as in wind — see the
 * comment on the control below.
 */
async function foamShare(
  page: Parameters<typeof capture>[0],
  shot: {
    state: Record<string, unknown>;
    camera: { position: [number, number, number]; target: [number, number, number] };
    time: number;
  },
): Promise<FoamShare> {
  await setState(page, shot.state);
  await setCamera(page, shot.camera.position, shot.camera.target);

  await page.evaluate(() => window.__ocean.setFoamOverride(null));
  await page.evaluate((t) => window.__ocean.resetDeterministic(t, 90), shot.time);
  const withFoam = await capture(page);

  await page.evaluate(() => window.__ocean.setFoamOverride(0));
  await page.evaluate((t) => window.__ocean.resetDeterministic(t, 90), shot.time);
  const without = await capture(page);
  await page.evaluate(() => window.__ocean.setFoamOverride(null));

  const luma = (i: number, img: typeof withFoam) =>
    0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];

  let changed = 0;
  let total = 0;
  let sum = 0;
  let peak = 0;
  // The horizon sits just under half way up this frame, so the lower half is
  // water and nothing else.
  for (let y = Math.floor(withFoam.height / 2); y < withFoam.height; y++) {
    for (let x = 0; x < withFoam.width; x++) {
      const i = (y * withFoam.width + x) * 4;
      const delta = Math.abs(luma(i, withFoam) - luma(i, without));
      sum += delta;
      peak = Math.max(peak, delta);
      if (delta > 8) changed++;
      total++;
    }
  }
  return { fraction: changed / total, mean: sum / total, peak };
}

test('how much of the waterline shot is foam rather than reflected sky', async ({ page }) => {
  test.setTimeout(900_000);
  await bootOcean(page);

  // **The positive control comes first, and it is the whole reason this test is
  // shaped like this.**
  //
  // The first version measured only the waterline shot and read 0.0% of pixels
  // moving, peak one level. That is indistinguishable from a dead hook — and the
  // hook *was* dead: `setFoamOverride` set a field that only `applyPreset` ever
  // read back to the uniform, and `applyPreset` runs on a state change rather
  // than per frame, so foam 0 and foam 3 produced bit-identical frames. A
  // measurement with no control would have reported "no foam here" and closed
  // the question in exactly the wrong direction.
  //
  // The control is a different *scene*, not merely a different wind: raising
  // `windSpeed` under a calm preset does not reliably produce whitecaps, so the
  // storm shot — which unambiguously has them — is what proves the instrument
  // works before the quiet frame is asked anything.
  const gale = await foamShare(page, {
    state: {
      quality: 'high',
      preset: 'storm',
      windSpeed: 21,
      peakWavelength: 60,
      cloudCoverage: 0.95,
    },
    camera: { position: [34, 15, 54], target: [0, 4, 0] },
    time: 41,
  });
  console.log(
    `[foam-attribution] control (storm shot): ${(100 * gale.fraction).toFixed(1)}% of ` +
      `water pixels move, mean ${gale.mean.toFixed(2)}, peak ${gale.peak.toFixed(0)}`,
  );
  expect(
    gale.fraction,
    'forcing foam off in the storm shot changed almost nothing, so `setFoamOverride` ' +
      'is not reaching the surface and no reading from this test can be trusted',
  ).toBeGreaterThan(0.02);

  // And the frame the complaint was actually about.
  const breeze = await foamShare(page, {
    state: {
      quality: 'high',
      preset: 'skyPro',
      windSpeed: 5,
      peakWavelength: 20,
      cloudCoverage: 0.3,
    },
    camera: { position: [-46, 0.02, 44], target: [-76, 1, 24] },
    time: 63.75,
  });
  console.log(
    `[foam-attribution] waterline shot: ${(100 * breeze.fraction).toFixed(1)}% of ` +
      `water pixels move, mean ${breeze.mean.toFixed(2)}, peak ${breeze.peak.toFixed(0)}`,
  );

  // Monahan puts whitecap coverage at 5 m/s near a tenth of a percent, so a
  // frame that is visibly pale at this wind is reflecting sky, not foaming. This
  // asserts that the renderer agrees — and it is the evidence for leaving the
  // foam terms alone rather than tuning them at the grazing camera.
  expect(
    breeze.fraction,
    `at 5 m/s the shot is ${(100 * breeze.fraction).toFixed(1)}% foam by area, which is ` +
      'far more than Monahan allows at that wind — the pallor is foam after all',
  ).toBeLessThan(0.02);
});
