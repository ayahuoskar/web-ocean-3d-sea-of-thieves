/**
 * An `AudioParam` bundled with the value it is being driven toward.
 *
 * Four jobs, every one of which exists because `update` runs on the render loop
 * and therefore sixty times a second forever.
 *
 * **Smoothing.** Writing a value straight onto an `AudioParam` is a step change,
 * and a step change on a gain is a click and on a filter cutoff is a zipper. Every
 * write goes through `setTargetAtTime`, which is a one-pole approach to the target
 * evaluated in the audio thread — so the parameter keeps moving smoothly between
 * frames even when the render loop hitches, which is exactly when a
 * per-frame-interpolated value would stutter audibly.
 *
 * **Dedupe.** `setTargetAtTime` appends to the parameter's automation timeline.
 * Most frames the scene has not changed enough to matter, so a write whose target
 * is within `epsilon` of the last one is dropped: the wind speed slider sitting
 * still costs nothing rather than 3600 timeline events a minute.
 *
 * **The suspended-context trap.** A suspended `AudioContext` does not advance
 * `currentTime`. Automating a parameter every frame against a frozen clock
 * schedules an unbounded pile of events all at the same instant, none of which can
 * ever be retired, so a page whose audio is never unlocked leaks for as long as it
 * is open. `set` therefore takes a `live` flag: when the context is not running
 * the target is recorded and nothing is written, and `flush` pushes the recorded
 * state in one go the moment it starts.
 *
 * **The NaN gate.** Scene values arrive from a GPU readback that may not have
 * resolved yet. A NaN reaching an `AudioParam` throws on some paths and silently
 * poisons a filter on others — and a poisoned biquad stays dead for the rest of
 * the session, because there is no value you can write afterwards that gets it
 * out. Non-finite values are dropped here, at the one place every write passes
 * through, rather than guarded at each of the thirty call sites.
 */
export class ParamTarget {
  /** Last value actually written to the parameter. */
  private applied: number;
  /** Last value the model asked for, written or not. */
  private pending: number;

  constructor(
    private readonly param: AudioParam,
    initial: number,
    private readonly tau: number,
    private readonly epsilon: number,
    private readonly min = 0,
    private readonly max = Number.POSITIVE_INFINITY,
  ) {
    const start = clamp(initial, min, max);
    this.applied = start;
    this.pending = start;
    param.value = start;
  }

  /** The value the model last asked for. */
  get target(): number {
    return this.pending;
  }

  set(value: number, now: number, live: boolean): void {
    if (!Number.isFinite(value)) return;
    const wanted = clamp(value, this.min, this.max);
    this.pending = wanted;
    if (!live) return;
    if (Math.abs(wanted - this.applied) < this.epsilon) return;
    this.applied = wanted;
    this.param.setTargetAtTime(wanted, now, this.tau);
  }

  /**
   * Jumps the parameter to the last requested value.
   *
   * For the frame the context resumes on: the model has been running all along
   * and its targets are current, so ramping toward them from whatever was last
   * written would fade the whole scene in from a stale state.
   */
  flush(now: number): void {
    this.applied = this.pending;
    this.param.cancelScheduledValues(now);
    this.param.setValueAtTime(this.pending, now);
  }

  /**
   * Forces the parameter to zero without disturbing the model's target.
   *
   * Used when a layer is reconnected: the gain node still holds whatever it had
   * when the layer was switched off, and reconnecting at that level is a click.
   * The next `set` then ramps up from silence.
   */
  silence(now: number): void {
    this.applied = 0;
    this.param.cancelScheduledValues(now);
    this.param.setValueAtTime(0, now);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
