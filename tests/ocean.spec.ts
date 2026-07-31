import { test, expect } from '@playwright/test';
import {
  collectConsoleErrors,
  measureFrameRate,
  setCamera,
  setState,
  waitForOcean,
} from './helpers';

test.describe('boot and rendering', () => {
  test('boots on WebGPU with no console errors and draws a non-empty frame', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/');
    await waitForOcean(page);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);

    const backend = await page.evaluate(
      () => (window as unknown as { __ocean: { backend: string } }).__ocean.backend,
    );
    expect(backend).toBe('webgpu');

    // The canvas must actually contain a rendered scene, not a cleared buffer.
    // Sample the framebuffer and require real colour variance.
    const variance = await page.evaluate(() => {
      const canvas = document.getElementById('viewport') as HTMLCanvasElement;
      const probe = document.createElement('canvas');
      probe.width = 64;
      probe.height = 36;
      const context = probe.getContext('2d');
      if (!context) return -1;
      context.drawImage(canvas, 0, 0, 64, 36);
      const { data } = context.getImageData(0, 0, 64, 36);
      let sum = 0;
      let sumSq = 0;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        sum += luma;
        sumSq += luma * luma;
        n++;
      }
      const mean = sum / n;
      return sumSq / n - mean * mean;
    });
    expect(variance, 'frame appears blank or uniform').toBeGreaterThan(50);
  });

  test('falls back to WebGL2 and still renders', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/?webgl=1');
    await waitForOcean(page);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);

    const backend = await page.evaluate(
      () => (window as unknown as { __ocean: { backend: string } }).__ocean.backend,
    );
    expect(backend).toBe('webgl');
  });
});

test.describe('wave simulation', () => {
  test('produces a physically plausible sea state', async ({ page }) => {
    await page.goto('/');
    await waitForOcean(page);

    const stats = await page.evaluate(async () => {
      const ocean = (window as unknown as { __ocean: Record<string, never> }).__ocean;
      const renderer = ocean.renderer as unknown as {
        readRenderTargetPixelsAsync: (
          t: unknown, x: number, y: number, w: number, h: number,
        ) => Promise<ArrayLike<number>>;
      };
      const simulation = ocean.simulation as unknown as {
        displacementTargets: unknown[];
        tileSizes: number[];
      };

      const halfToFloat = (bits: number) => {
        const sign = bits & 0x8000 ? -1 : 1;
        const exponent = (bits & 0x7c00) >> 10;
        const mantissa = bits & 0x03ff;
        if (exponent === 0) return sign * 2 ** -14 * (mantissa / 1024);
        if (exponent === 31) return mantissa ? NaN : sign * Infinity;
        return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
      };

      let peakHeight = 0;
      let nonFinite = 0;
      let foldedFraction = 0;
      let samples = 0;

      for (const target of simulation.displacementTargets) {
        // 64 wide keeps bytesPerRow a multiple of 256 so no padding rows appear.
        const raw = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 64, 64);
        const isHalf = (raw as ArrayLike<number> & { BYTES_PER_ELEMENT?: number })
          .BYTES_PER_ELEMENT === 2;
        for (let i = 0; i < raw.length; i += 4) {
          const height = isHalf ? halfToFloat(raw[i + 1]) : raw[i + 1];
          const jacobian = isHalf ? halfToFloat(raw[i + 3]) : raw[i + 3];
          if (!Number.isFinite(height)) nonFinite++;
          peakHeight = Math.max(peakHeight, Math.abs(height));
          if (jacobian < 0) foldedFraction++;
          samples++;
        }
      }

      return { peakHeight, nonFinite, foldedPercent: (100 * foldedFraction) / samples };
    });

    expect(stats.nonFinite, 'displacement field contains non-finite values').toBe(0);

    // At the default 15 m/s wind a fully developed sea has Hs ~= 5 m, so crest
    // amplitude should land in metres — not centimetres, and not tens of metres.
    expect(stats.peakHeight).toBeGreaterThan(0.4);
    expect(stats.peakHeight).toBeLessThan(12);

    // Whitecaps cover a few percent of a real sea at this wind speed. A large
    // number here means the surface is folding everywhere, which is the
    // signature of a broken transform or excessive choppiness.
    expect(stats.foldedPercent).toBeLessThan(8);
  });

  test('the surface actually animates', async ({ page }) => {
    await page.goto('/');
    await waitForOcean(page);
    await setCamera(page, [0, 12, 40], [0, 0, 0]);

    const first = await page.locator('#viewport').screenshot();
    await page.waitForTimeout(900);
    const second = await page.locator('#viewport').screenshot();

    expect(Buffer.compare(first, second), 'frames are identical — simulation is frozen').not.toBe(0);
  });
});

test.describe('interaction', () => {
  test('every preset applies without error and changes the image', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/');
    await waitForOcean(page);
    await setCamera(page, [0, 14, 48], [0, 2, 0]);

    const presets = [
      'skyPro', 'arctic', 'blackFlag', 'dusk', 'foggy',
      'moonlit', 'seaOfThieves', 'storm', 'sunset',
    ];

    const fingerprints = new Map<string, string>();
    for (const preset of presets) {
      await setState(page, { preset });
      const shot = await page.locator('#viewport').screenshot();
      // Average colour is a stable fingerprint despite per-frame wave motion.
      fingerprints.set(preset, await averageColor(shot));
    }

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);

    // Distinct presets must not collapse to the same look.
    const unique = new Set(fingerprints.values());
    expect(unique.size, `presets produced duplicate imagery: ${[...fingerprints]}`).toBeGreaterThan(
      presets.length - 3,
    );
  });

  test('camera modes switch via keyboard', async ({ page }) => {
    await page.goto('/');
    await waitForOcean(page);

    for (const [key, expected] of [['2', 'fly'], ['3', 'boat'], ['1', 'orbit']] as const) {
      await page.keyboard.press(key);
      await page.waitForTimeout(250);
      const mode = await page.evaluate(
        () =>
          (window as unknown as { __ocean: { director: { currentMode: string } } }).__ocean.director
            .currentMode,
      );
      expect(mode).toBe(expected);
    }
  });

  test('quality tiers apply cleanly and rebuild GPU resources', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/');
    await waitForOcean(page);

    for (const quality of ['low', 'medium', 'high', 'ultra', 'max', 'high']) {
      await setState(page, { quality });
    }

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('sliders drive the simulation', async ({ page }) => {
    await page.goto('/');
    await waitForOcean(page);

    await setState(page, { windSpeed: 3, peakWavelength: 20 });
    const calm = await peakWaveHeight(page);

    await setState(page, { windSpeed: 24, peakWavelength: 120 });
    const rough = await peakWaveHeight(page);

    expect(rough, `calm=${calm} rough=${rough}`).toBeGreaterThan(calm * 1.5);
  });
});

test.describe('performance', () => {
  /**
   * These gates key on per-frame WORK, not on delivered frame rate.
   *
   * Automated Chromium throttles requestAnimationFrame independently of load —
   * this project measured 1.1 "FPS" while spending 0.8 ms per frame, and the
   * same 1.00 fps appears with every effect switched off. Asserting on FPS here
   * would test the harness, not the renderer. When the browser is NOT throttling
   * we additionally assert the frame rate, so a real regression on an
   * interactive run still fails.
   */
  const budget = (target: number) => (sample: {
    fps: number;
    frameMs: number;
    rafThrottled: boolean;
  }) => {
    expect(
      sample.frameMs,
      `frame work was ${sample.frameMs.toFixed(2)} ms (budget ${target} ms); ` +
        `delivered ${sample.fps.toFixed(1)} FPS, rafThrottled=${sample.rafThrottled}`,
    ).toBeLessThan(target);
  };

  test('stays within the frame budget at High on WebGPU', async ({ page }) => {
    await page.goto('/');
    await waitForOcean(page);
    await setState(page, { quality: 'high' });

    const sample = await measureFrameRate(page, 4);
    budget(16.7)(sample);
    if (!sample.rafThrottled) {
      expect(sample.fps, `median FPS was ${sample.fps.toFixed(1)}`).toBeGreaterThan(55);
    }
  });

  test('stays within the fallback frame budget at Low on WebGL', async ({ page }) => {
    await page.goto('/?webgl=1');
    await waitForOcean(page);
    await setState(page, { quality: 'low' });

    const sample = await measureFrameRate(page, 4);
    budget(33.3)(sample);
    if (!sample.rafThrottled) {
      expect(sample.fps, `median FPS was ${sample.fps.toFixed(1)}`).toBeGreaterThan(30);
    }
  });

  test('does not leak GPU memory across quality changes', async ({ page }) => {
    await page.goto('/');
    await waitForOcean(page);

    const sample = async () =>
      page.evaluate(() => {
        const info = (
          window as unknown as {
            __ocean: { renderer: { info: { memory: { textures: number; geometries: number } } } };
          }
        ).__ocean.renderer.info.memory;
        return { textures: info.textures, geometries: info.geometries };
      });

    for (const quality of ['low', 'high', 'low', 'high']) await setState(page, { quality });
    const baseline = await sample();

    for (let i = 0; i < 4; i++) {
      await setState(page, { quality: 'low' });
      await setState(page, { quality: 'high' });
    }
    const after = await sample();

    // Allow a little slack for lazily-created internal targets, but a real leak
    // grows linearly with the number of cycles and will blow past this.
    expect(after.textures).toBeLessThanOrEqual(baseline.textures + 8);
    expect(after.geometries).toBeLessThanOrEqual(baseline.geometries + 4);
  });
});

test.describe('responsiveness', () => {
  for (const [label, width, height] of [
    ['desktop', 1920, 1080],
    ['laptop', 1440, 900],
    ['tablet', 834, 1112],
    ['phone', 390, 844],
    ['narrow', 360, 720],
  ] as const) {
    test(`${label} (${width}x${height}) has no layout overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      await waitForOcean(page, 40);

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
    });
  }
});

// ---------------------------------------------------------------------- utils

async function averageColor(png: Buffer): Promise<string> {
  // Cheap, dependency-free fingerprint: hash a coarse downsample of the bytes.
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < png.length - 3; i += 997) {
    r += png[i];
    g += png[i + 1];
    b += png[i + 2];
    n++;
  }
  return `${Math.round(r / n / 8)}-${Math.round(g / n / 8)}-${Math.round(b / n / 8)}`;
}

async function peakWaveHeight(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(async () => {
    const ocean = (window as unknown as { __ocean: Record<string, never> }).__ocean;
    const renderer = ocean.renderer as unknown as {
      readRenderTargetPixelsAsync: (
        t: unknown, x: number, y: number, w: number, h: number,
      ) => Promise<ArrayLike<number>>;
    };
    const simulation = ocean.simulation as unknown as { displacementTargets: unknown[] };
    const halfToFloat = (bits: number) => {
      const sign = bits & 0x8000 ? -1 : 1;
      const exponent = (bits & 0x7c00) >> 10;
      const mantissa = bits & 0x03ff;
      if (exponent === 0) return sign * 2 ** -14 * (mantissa / 1024);
      if (exponent === 31) return mantissa ? NaN : sign * Infinity;
      return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
    };
    const raw = await renderer.readRenderTargetPixelsAsync(
      simulation.displacementTargets[0], 0, 0, 64, 64,
    );
    const isHalf = (raw as ArrayLike<number> & { BYTES_PER_ELEMENT?: number })
      .BYTES_PER_ELEMENT === 2;
    let peak = 0;
    for (let i = 0; i < raw.length; i += 4) {
      const height = isHalf ? halfToFloat(raw[i + 1]) : raw[i + 1];
      if (Number.isFinite(height)) peak = Math.max(peak, Math.abs(height));
    }
    return peak;
  });
}
