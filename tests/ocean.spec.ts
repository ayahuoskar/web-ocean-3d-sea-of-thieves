import { test, expect } from '@playwright/test';
import {
  collectConsoleErrors,
  hasGpuAdapter,
  measureFrameRate,
  setCamera,
  setState,
  waitForOcean,
} from './helpers';
import { capture } from './lib/capture';
import { compareImages } from './lib/compare';
import type { RgbaImage } from './lib/png';

test.describe('boot and rendering', () => {
  test('boots with no console errors and draws a non-empty frame', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/');
    await waitForOcean(page);

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);

    // Whether WebGPU is actually reachable depends on the machine and, notably,
    // on the browser build: Playwright's bundled Chromium commonly exposes no
    // WebGPU adapter at all. Asserting "backend === webgpu" unconditionally would
    // therefore fail on a correctly-behaving fallback. Instead, ask the page what
    // is available and require the renderer to have made the right choice.
    const { backend, adapterAvailable } = await page.evaluate(async () => {
      let adapter = false;
      try {
        adapter = navigator.gpu ? (await navigator.gpu.requestAdapter()) !== null : false;
      } catch {
        adapter = false;
      }
      return {
        backend: (window as unknown as { __ocean: { backend: string } }).__ocean.backend,
        adapterAvailable: adapter,
      };
    });

    if (adapterAvailable) {
      expect(backend, 'a WebGPU adapter exists but the renderer did not use it').toBe('webgpu');
    } else {
      expect(backend, 'no WebGPU adapter, so the renderer must fall back').toBe('webgl');
    }

    // The canvas must contain a rendered scene, not a cleared buffer.
    //
    // Deliberately NOT via drawImage on the canvas: without preserveDrawingBuffer
    // that reads back blank on both WebGL and WebGPU, so it measures a readback
    // limitation rather than the render. The compositor screenshot is the honest
    // source. PNG is entropy-coded, so a flat frame compresses to a few KB while
    // a detailed ocean is orders of magnitude larger — size is a sound proxy for
    // "there is structure on screen".
    test.skip(
      !(await hasGpuAdapter(page)),
      'no GPU adapter: software rasterisation cannot deliver a screenshot in time',
    );
    const shot = await page.screenshot();
    expect(
      shot.byteLength,
      `frame compressed to ${shot.byteLength} bytes, which indicates a blank or uniform image`,
    ).toBeGreaterThan(120_000);
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
    // Each compositor screenshot can block for seconds when the browser is
    // pacing frames at ~1 Hz, and this test takes two of them.
    test.setTimeout(180_000);
    await page.goto('/');
    await waitForOcean(page);
    test.skip(
      !(await hasGpuAdapter(page)),
      'no GPU adapter: software rasterisation cannot deliver a screenshot in time',
    );
    await setCamera(page, [0, 12, 40], [0, 0, 0]);

    const first = await page.screenshot();
    // Generous: the browser may only be delivering ~1 frame per second, so a
    // short wait can capture the same frame twice and read as a frozen sim.
    await page.waitForTimeout(3000);
    const second = await page.screenshot();

    expect(Buffer.compare(first, second), 'frames are identical — simulation is frozen').not.toBe(0);
  });
});

test.describe('interaction', () => {
  /**
   * Every preset must produce a *distinguishable* image, pairwise.
   *
   * The previous version of this test hashed bytes sampled out of the compressed
   * PNG that `page.screenshot()` returns and called the result an average colour.
   * It is not one: PNG is entropy-coded, so those bytes are deflate output and
   * the number means nothing about what is on screen. It went unnoticed because
   * the test also required a WebGPU adapter, which Playwright's Chromium did not
   * have until the launch flags were fixed — so it skipped rather than ran, and
   * the first time it actually executed all nine presets "fingerprinted"
   * identically.
   *
   * This compares real decoded pixels through the same CIE94 metric the visual
   * suite gates on, and checks every pair rather than counting distinct hashes —
   * a hash count cannot tell you *which* two looks collapsed together.
   */
  test('every preset applies without error and produces a distinct image', async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await page.goto('/');
    await waitForOcean(page);

    test.skip(
      !(await hasGpuAdapter(page)),
      'no GPU adapter: the software path cannot render these frames in time',
    );

    const presets = [
      'skyPro', 'arctic', 'blackFlag', 'dusk', 'foggy',
      'moonlit', 'seaOfThieves', 'storm', 'sunset',
    ] as const;

    const images = new Map<string, RgbaImage>();
    for (const preset of presets) {
      await setState(page, { preset });
      // Pinned time and camera, so what separates two captures is the preset and
      // nothing else — otherwise a pair could differ merely by wave phase.
      await page.evaluate(() => window.__ocean.resetDeterministic(30, 60));
      await setCamera(page, [0, 14, 48], [0, 2, 0]);
      images.set(preset, await capture(page));
    }

    expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);

    // Well clear of the measured run-to-run noise floor, which tops out around
    // mean ΔE 0.04 — two presets an order of magnitude apart in appearance
    // should be separated by far more than that.
    const MIN_SEPARATION = 1.0;
    const collapsed: string[] = [];
    for (let i = 0; i < presets.length; i++) {
      for (let j = i + 1; j < presets.length; j++) {
        const a = presets[i];
        const b = presets[j];
        const score = compareImages(images.get(a)!, images.get(b)!);
        if (score.meanDeltaE < MIN_SEPARATION) {
          collapsed.push(`${a} vs ${b}: mean ΔE ${score.meanDeltaE.toFixed(3)}`);
        }
      }
    }

    expect(
      collapsed,
      `preset pairs that render too similarly (mean ΔE < ${MIN_SEPARATION}):\n${collapsed.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * The wake buffer must reach the water.
   *
   * `physics/Wake` maintained a correct, world-anchored foam accumulation every
   * frame that `OceanMaterial` never sampled — two fullscreen passes of cost for
   * a texture nothing read, visible only through the debug overlay. Nothing
   * failed when it was disconnected, which is exactly why this test exists: it
   * deposits a wake and requires the rendered surface to change because of it.
   *
   * Deliberately not asserting on the wake's own texture. That would pass just as
   * happily with the binding removed again — the claim under test is that the
   * *water* shows it.
   */
  test('a deposited wake changes the rendered water', async ({ page }) => {
    await page.goto('/');
    await waitForOcean(page);

    test.skip(
      !(await hasGpuAdapter(page)),
      'no GPU adapter: the software path cannot render these frames in time',
    );

    await setState(page, { preset: 'seaOfThieves', quality: 'high' });

    // Looking down at open water well clear of the hull, so the only thing that
    // can differ between the two captures is the deposit.
    const look = async () => {
      await setCamera(page, [-30, 40, 55], [-25, 0, 0]);
      return capture(page);
    };

    await page.evaluate(() => window.__ocean.resetDeterministic(20, 60));
    const clean = await look();

    // Drive an emitter along a track, stepping between deposits so the buffer
    // accumulates a trail rather than a single stamp.
    await page.evaluate(async () => {
      const ocean = window.__ocean;
      for (let i = 0; i < 90; i++) {
        const x = -60 + i * (8 / 60);
        ocean.wake.emit(x, 0, 0, 8, 7);
        await ocean.step(1 / 60, 1);
      }
    });
    const withWake = await look();

    const score = compareImages(clean, withWake);

    // A Kelvin wedge across open water is a large, bright, unmistakable feature.
    // The bar is set far above the measured run-to-run noise floor (mean ΔE
    // around 0.04) but well below what the wedge actually produces, so this fails
    // on the binding being lost rather than on the foam being retuned.
    expect(
      score.meanDeltaE,
      `depositing a wake changed the water by mean ΔE ${score.meanDeltaE.toFixed(3)}; ` +
        'a value near zero means OceanMaterial is not sampling the wake buffer',
    ).toBeGreaterThan(0.5);
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
      await waitForOcean(page, 1200);

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
    });
  }
});

// ---------------------------------------------------------------------- utils

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
