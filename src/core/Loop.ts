export type Updatable = (dt: number, elapsed: number) => void;

export interface FrameStats {
  /** Smoothed frames per second. */
  fps: number;
  /** Milliseconds of wall clock spent in the last frame. */
  frameMs: number;
}

/**
 * Frame driver. Simulation receives a clamped delta so that a tab switch or a
 * long shader compile cannot teleport the ship across the ocean.
 */
export class Loop {
  private readonly updates: Updatable[] = [];
  private readonly renderFn: (dt: number, elapsed: number) => void | Promise<void>;
  private running = false;
  private last = 0;
  private elapsed = 0;
  private handle = 0;
  private inFlight = false;

  readonly stats: FrameStats = { fps: 0, frameMs: 0 };

  /** Exponential moving average keeps the readout stable without lagging real drops. */
  private static readonly FPS_SMOOTHING = 0.1;
  private static readonly MAX_DELTA = 1 / 15;

  constructor(renderFn: (dt: number, elapsed: number) => void | Promise<void>) {
    this.renderFn = renderFn;
  }

  add(update: Updatable): void {
    this.updates.push(update);
  }

  remove(update: Updatable): void {
    const i = this.updates.indexOf(update);
    if (i >= 0) this.updates.splice(i, 1);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.handle = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.handle);
  }

  private tick = async (now: number): Promise<void> => {
    if (!this.running) return;
    this.handle = requestAnimationFrame(this.tick);

    // Skip if the previous async render has not resolved — prevents unbounded
    // queueing of GPU work when the device is the bottleneck.
    if (this.inFlight) return;

    const rawDelta = (now - this.last) / 1000;
    this.last = now;
    const dt = Math.min(rawDelta, Loop.MAX_DELTA);
    this.elapsed += dt;

    for (const update of this.updates) update(dt, this.elapsed);

    this.inFlight = true;
    const started = performance.now();
    try {
      await this.renderFn(dt, this.elapsed);
    } finally {
      this.inFlight = false;
      this.stats.frameMs = performance.now() - started;
      const instantaneous = rawDelta > 0 ? 1 / rawDelta : 0;
      this.stats.fps =
        this.stats.fps === 0
          ? instantaneous
          : this.stats.fps + (instantaneous - this.stats.fps) * Loop.FPS_SMOOTHING;
    }
  };
}
