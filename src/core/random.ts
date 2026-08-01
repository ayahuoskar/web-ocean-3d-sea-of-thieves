/**
 * Seeded pseudo-randomness.
 *
 * Three systems previously carried their own copy of this generator (`Seafloor`,
 * `Props`) while two others called `Math.random()` outright (`Weather`,
 * `Particles`). The unseeded ones made the scene different on every load, which
 * is fine to look at and fatal to compare: no visual baseline can survive a rain
 * curtain that is re-scattered each run.
 *
 * Everything procedural in this project now draws from here, and every draw is a
 * pure function of an explicit seed.
 */

/**
 * mulberry32 — small, fast, and good enough for scattering particles and props.
 *
 * Chosen over a hash of `Math.sin` because it is exactly reproducible in integer
 * arithmetic: the same seed yields the same sequence on every engine, which a
 * float-transcendental hash does not guarantee.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fills `out` with `out.length` values in [0, 1) from `seed`.
 *
 * The common case for instanced particle seeds, kept here so callers do not each
 * re-derive the loop.
 */
export function fillRandom(out: Float32Array, seed: number): Float32Array {
  const random = mulberry32(seed);
  for (let i = 0; i < out.length; i++) out[i] = random();
  return out;
}

/**
 * Distinct, stable seeds for the systems that need one.
 *
 * Literal constants rather than derived values: a baseline capture is only
 * comparable to a later run if these never drift, so they are written out where
 * a change to them is visible in a diff.
 */
export const SEEDS = {
  seafloorNoise: 0x0cea1f,
  props: 0x5eab0a7,
  rain: 0x7a12f7,
  snow: 0x5c0f1a,
  underwaterSnow: 0x3f0c05,
  bubbles: 0xb0bb1e,
  rainImpacts: 0x14ac71,
} as const;
