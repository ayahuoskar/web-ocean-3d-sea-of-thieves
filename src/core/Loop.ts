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
  private paused = false;
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

  /**
   * Simulation clock, in seconds. Every animated system in the project is a
   * function of this value, so reading and restoring it is what makes a frame
   * reproducible.
   */
  get elapsedTime(): number {
    return this.elapsed;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Detaches the simulation from wall clock.
   *
   * While paused the rAF callback keeps firing but neither advances time nor
   * renders; `step()` becomes the only way the world moves. This is the basis of
   * every deterministic capture: real frame pacing varies by machine and by
   * whatever else the GPU is doing, so a baseline taken against wall-clock time
   * can never be reproduced exactly.
   */
  setPaused(paused: boolean): void {
    this.paused = paused;
    // Resuming must not integrate the entire pause as one delta.
    this.last = performance.now();
  }

  /** Hard-sets the simulation clock without running any update. */
  setElapsed(seconds: number): void {
    this.elapsed = seconds;
  }

  /**
   * Advances the simulation by exactly `steps` increments of `dt` and renders
   * once, awaiting the render.
   *
   * Stepping several small increments rather than one large one matters: the
   * buoyancy solver, the wake decay and the foam advection all integrate over
   * `dt`, and a single 1 s step lands somewhere a 60 × 16.7 ms sequence never
   * would.
   */
  async step(dt: number, steps = 1): Promise<void> {
    for (let s = 0; s < steps; s++) {
      this.elapsed += dt;
      for (const update of this.updates) update(dt, this.elapsed);
    }
    const started = performance.now();
    await this.renderFn(dt, this.elapsed);
    this.stats.frameMs = performance.now() - started;
  }

  private tick = async (now: number): Promise<void> => {
    if (!this.running) return;
    this.handle = requestAnimationFrame(this.tick);

    // Paused: `step()` owns the clock. Keep the rAF chain alive so resuming does
    // not need to restart it.
    if (this.paused) return;

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
