import { defineConfig, devices } from '@playwright/test';

/**
 * The scene is GPU-heavy and non-deterministic frame to frame, so the suite is
 * built around *behavioural* assertions (no console errors, stable frame budget,
 * interactions take effect) plus screenshot comparison with a generous pixel
 * tolerance rather than exact-match snapshots.
 *
 * Workers are pinned to 1: parallel WebGPU contexts contend for the same device
 * and turn frame-rate assertions into coin flips.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 90_000,
  expect: { timeout: 20_000 },

  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium-webgpu',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1600, height: 900 },
        deviceScaleFactor: 1,
        launchOptions: {
          args: [
            '--enable-unsafe-webgpu',
            '--enable-features=Vulkan',
            // Deterministic frame pacing for the performance assertions.
            '--disable-frame-rate-limit',
            '--disable-gpu-vsync',
          ],
        },
      },
    },
  ],

  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
