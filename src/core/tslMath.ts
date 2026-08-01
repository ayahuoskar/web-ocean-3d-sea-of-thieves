import { smoothstep } from 'three/tsl';

/**
 * A descending smooth ramp: 1 at or below `inner`, 0 at or above `outer`.
 *
 * This exists because the obvious spelling is undefined behaviour. Writing
 * `x.smoothstep(outer, inner)` with `outer > inner` reads as "fade out from
 * `outer` down to `inner`", and on every stack this project has been run on it
 * does exactly that — but both shading languages explicitly decline to promise
 * it:
 *
 * - WGSL: `smoothstep(low, high, x)` — "If `low >= high`, the results are
 *   indeterminate."
 * - GLSL ES 3.0: `smoothstep(edge0, edge1, x)` — "Results are undefined if
 *   `edge0 >= edge1`."
 *
 * The reason is not pedantry. The canonical expansion divides by
 * `edge1 - edge0`, so a reversed pair is a *negative* denominator; whether that
 * comes out as the mirrored ramp, as a clamp to a constant, or as a NaN depends
 * on whether the compiler emits the division at all, folds it, or lowers it to a
 * hardware instruction with its own saturation. A driver is free to pick any of
 * those. The one this project develops against picks the mirrored ramp, which is
 * why the artefacts never showed up.
 *
 * `smoothstep(inner, outer, x)` is ordered correctly by construction, and
 * `oneMinus()` flips it. One extra subtract, no behavioural change on the stacks
 * where the reversed form happened to work, and defined everywhere else.
 *
 * Arguments are `(x, inner, outer)` with **`inner < outer` always** — the
 * ascending pair, named for what they mean rather than for which end the ramp
 * starts at. Converting `x.smoothstep(a, b)` therefore means swapping: the
 * larger edge, which came first, goes last.
 *
 * The first draft of this function had exactly that swap wrong, and the result
 * was a constant zero rather than anything that looked like a broken ramp. It
 * was caught by a test asserting an effect was visible at all, not by reading the
 * shader — which is the argument for having such a test for every effect.
 */
export function smoothstepDown(x: any, inner: any, outer: any): any {
  return smoothstep(inner, outer, x).oneMinus();
}

/** `smoothstepDown` clamped to 0..1, for the call sites that were doing both. */
export function smoothstepDownClamped(x: any, inner: any, outer: any): any {
  return smoothstepDown(x, inner, outer).clamp(0, 1);
}
