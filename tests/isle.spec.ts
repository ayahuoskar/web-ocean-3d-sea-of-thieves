import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { bootOcean, capture } from './lib/capture';
import { encodePng } from './lib/png';
import { setCamera, setState } from './helpers';

const OUT = process.env.ISLE_OUT ?? '.';
const I = { x: -1150, z: -780 };

test('island views', async ({ page }) => {
  test.setTimeout(900_000);
  await bootOcean(page);
  await setState(page, { quality: 'ultra', preset: 'skyPro', windSpeed: 12, cloudCoverage: 0.3 });

  const shots: [string, [number, number, number], [number, number, number]][] = [
    ['n-air', [I.x + 900, 380, I.z + 900], [I.x, 20, I.z]],
    ['n-approach', [I.x + 900, 60, I.z + 780], [I.x, 30, I.z]],
    ['n-cove', [I.x + 620, 26, I.z + 560], [I.x + 120, 20, I.z + 90]],
    ['n-water', [I.x + 700, 5, I.z + 620], [I.x + 150, 40, I.z + 120]],
  ];
  for (const [name, pos, target] of shots) {
    await setCamera(page, pos, target);
    await page.evaluate(() => window.__ocean.resetDeterministic(20, 120));
    const img = await capture(page);
    writeFileSync(`${OUT}/${name}.png`, encodePng(img));
    // Mean colour of the brightest land-ish pixels, to tell a sand albedo
    // problem from a lighting one.
    let r = 0, g = 0, b = 0, n = 0, clipped = 0;
    for (let i = 0; i < img.width * img.height; i++) {
      const o = i * 4;
      const R = img.data[o], G = img.data[o + 1], B = img.data[o + 2];
      // Land reads warm-neutral and bright; sea is strongly blue-dominant.
      if (R > 150 && R >= B - 6 && G >= B - 6) {
        r += R; g += G; b += B; n++;
        if (R > 248 && G > 248 && B > 248) clipped++;
      }
    }
    if (n > 0) {
      console.log(
        `[isle] ${name} land n=${n} mean rgb ${(r/n).toFixed(0)},${(g/n).toFixed(0)},${(b/n).toFixed(0)} clipped ${(100*clipped/n).toFixed(1)}%`,
      );
    } else {
      console.log(`[isle] ${name} (no land pixels found)`);
    }
  }
});
