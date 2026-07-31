import type { Page, ConsoleMessage } from '@playwright/test';

export interface OceanHandle {
  backend: 'webgpu' | 'webgl';
}

/**
 * Console errors that are environmental rather than defects in this project.
 * Kept deliberately narrow so real errors are never swallowed.
 */
const IGNORABLE = [
  /favicon\.ico/i,
  /powerPreference option is currently ignored/i,
  /Automatic fallback to software WebGL/i,
];

export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (IGNORABLE.some((pattern) => pattern.test(text))) return;
    errors.push(text);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

/** Waits for the app to finish booting and for the first frames to be drawn. */
export async function waitForOcean(page: Page, warmupFrames = 90): Promise<void> {
  await page.waitForFunction(() => '__ocean' in window, undefined, { timeout: 60_000 });
  await page.waitForFunction(
    (frames) => {
      const ocean = (window as unknown as { __ocean: { loop: { stats: { fps: number } } } }).__ocean;
      const counter = (window as unknown as { __frameCount?: number });
      counter.__frameCount = (counter.__frameCount ?? 0) + 1;
      return counter.__frameCount > frames && ocean.loop.stats.fps > 0;
    },
    warmupFrames,
    { timeout: 60_000 },
  );
  // Let the boot overlay finish fading so it never bleeds into a screenshot.
  await page.waitForTimeout(700);
}

/** Places the camera deterministically so screenshots are comparable run to run. */
export async function setCamera(
  page: Page,
  position: [number, number, number],
  target: [number, number, number],
): Promise<void> {
  await page.evaluate(
    ([p, t]) => {
      const ocean = (
        window as unknown as {
          __ocean: {
            setCamera: (
              px: number, py: number, pz: number,
              tx: number, ty: number, tz: number,
            ) => void;
          };
        }
      ).__ocean;
      ocean.setCamera(p[0], p[1], p[2], t[0], t[1], t[2]);
    },
    [position, target] as const,
  );
  await page.waitForTimeout(400);
}

export async function setState(page: Page, partial: Record<string, unknown>): Promise<void> {
  await page.evaluate((p) => {
    const ocean = (
      window as unknown as { __ocean: { setState: (x: Record<string, unknown>) => void } }
    ).__ocean;
    ocean.setState(p);
  }, partial);
  await page.waitForTimeout(600);
}

export interface FrameSample {
  fps: number;
  frameMs: number;
}

/** Samples smoothed FPS over a window, discarding an initial settling period. */
export async function measureFrameRate(page: Page, seconds = 4): Promise<FrameSample> {
  await page.waitForTimeout(1500); // settle: shader compiles, mip builds, GC
  return page.evaluate(async (duration) => {
    const ocean = (
      window as unknown as { __ocean: { loop: { stats: { fps: number; frameMs: number } } } }
    ).__ocean;
    const samples: { fps: number; frameMs: number }[] = [];
    const start = performance.now();
    while (performance.now() - start < duration * 1000) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      samples.push({ ...ocean.loop.stats });
    }
    // Median is robust to the occasional compositor hitch that a mean is not.
    const median = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    return {
      fps: median(samples.map((s) => s.fps)),
      frameMs: median(samples.map((s) => s.frameMs)),
    };
  }, seconds);
}
