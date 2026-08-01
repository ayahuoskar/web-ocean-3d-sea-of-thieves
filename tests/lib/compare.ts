import type { RgbaImage } from './png';

/**
 * Perceptual image comparison for the visual regression harness.
 *
 * Two things this deliberately is not:
 *
 * **Not average colour.** The existing preset test fingerprints a frame by its
 * mean channel values, which is fine for "did the preset change anything" and
 * useless as a regression gate: a shader that inverts the left and right halves
 * of the image has the same average as one that does not.
 *
 * **Not pixel-exact.** Even on one machine this renderer does not reproduce a
 * frame bit-for-bit across a full state re-application (see
 * `docs/VERIFICATION.md` for the measured noise floor), and across GPU vendors
 * it never will. A metric that only answers "identical or not" would have to be
 * disabled to be usable, which is the same as not having one.
 *
 * What it does instead is convert both images to CIELAB and score every pixel
 * with CIE94 (graphic-arts weights), then report three numbers that fail for
 * different reasons — see `ComparisonResult`.
 */

/**
 * Per-pixel colour distance above which a pixel is counted as "changed".
 *
 * ΔE ≈ 1 is the classic just-noticeable difference between two large flat
 * patches side by side under controlled viewing. Nothing about a 1280×720 frame
 * of moving water is those conditions: a sparkle highlight that lands on the
 * next facet over is a large per-pixel ΔE and no visible change at all. 2.5 is
 * where a difference survives being looked at rather than measured, and it is
 * the level at which `fractionAbove` becomes a statement about how much of the
 * frame moved rather than a count of the renderer's own dither.
 */
export const PER_PIXEL_DELTA_E = 2.5;

/** ΔE at which the diff heat map saturates to full red. */
const DIFF_SATURATION = PER_PIXEL_DELTA_E * 4;

export interface ComparisonResult {
  /**
   * Mean ΔE94 over every pixel. Sensitive to broad, low-amplitude shifts —
   * a changed exposure or fog colour moves this while barely moving `p95`.
   */
  meanDeltaE: number;
  /**
   * 95th-percentile ΔE94. Catches a change concentrated in a *large minority* of
   * the frame — more than 5% of pixels — that the mean averages away.
   *
   * It does **not** catch a small localised change, and an earlier version of
   * this comment claimed it did: "a broken reflection on the hull is 2% of the
   * frame and invisible to a mean". That is true of the mean and equally true of
   * p95, which by construction ignores everything outside the worst 5%. A 2%
   * region moves p99 and the max, not this. `fractionAbove` is the number that
   * actually answers it, and it is the one to tighten if a small-region
   * regression needs gating.
   */
  p95DeltaE: number;
  /** Largest single-pixel ΔE94. Diagnostic only — one bad pixel is not a gate. */
  maxDeltaE: number;
  /**
   * Fraction of pixels (0..1) whose ΔE94 exceeds `PER_PIXEL_DELTA_E`. This is
   * the "how much of the frame moved" number, and the one that separates
   * "sparkle reshuffled" from "the water is a different colour".
   */
  fractionAbove: number;
  /** Heat map, same dimensions as the inputs. See `renderDiff`. */
  diff: RgbaImage;
}

export interface Thresholds {
  meanDeltaE: number;
  p95DeltaE: number;
  fractionAbove: number;
}

/**
 * Scores `actual` against `baseline`.
 *
 * CIE94 rather than plain CIE76 because CIE76 is Euclidean distance in Lab, and
 * Lab is not uniform at high chroma: the saturated sky of the sunset and storm
 * shots reports ΔE76 values two to three times what the same visual change
 * produces on the near-neutral water, purely because the colours are far from
 * the neutral axis. CIE94 divides the chroma and hue terms by (1 + K·C₁), which
 * removes most of that bias for the cost of six lines. Not CIEDE2000: its extra
 * terms mainly refine the blue-hue region, but it is four times the code and its
 * correctness is not something this harness can cheaply demonstrate, and an
 * unverifiable metric is worse than a slightly coarser verifiable one.
 *
 * CIE94 is asymmetric — the weights use the *reference* colour's chroma — so
 * `baseline` is always the reference. Swapping the arguments changes the answer
 * slightly, which is why the harness never does.
 */
export function compareImages(baseline: RgbaImage, actual: RgbaImage): ComparisonResult {
  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    throw new Error(
      `compareImages: size mismatch — baseline ${baseline.width}x${baseline.height}, ` +
        `actual ${actual.width}x${actual.height}`,
    );
  }

  const { width, height } = baseline;
  const count = width * height;
  const deltas = new Float32Array(count);

  const labA = new Float32Array(3);
  const labB = new Float32Array(3);

  let sum = 0;
  let max = 0;
  let above = 0;

  // ΔE histogram at 0.01 resolution. Sorting 900k floats to find a percentile
  // costs more than the whole comparison; a histogram is O(n) and the 0.01 bin
  // width is two orders of magnitude finer than any threshold here.
  const BINS = 20_000;
  const BIN_SCALE = 100; // bins per ΔE unit
  const histogram = new Uint32Array(BINS + 1);

  for (let i = 0; i < count; i++) {
    const p = i * 4;
    srgbToLab(baseline.data[p], baseline.data[p + 1], baseline.data[p + 2], labA);
    srgbToLab(actual.data[p], actual.data[p + 1], actual.data[p + 2], labB);
    const d = deltaE94(labA, labB);

    deltas[i] = d;
    sum += d;
    if (d > max) max = d;
    if (d > PER_PIXEL_DELTA_E) above++;
    histogram[Math.min(BINS, Math.round(d * BIN_SCALE))]++;
  }

  const p95Target = count * 0.95;
  let cumulative = 0;
  let p95 = 0;
  for (let bin = 0; bin <= BINS; bin++) {
    cumulative += histogram[bin];
    if (cumulative >= p95Target) {
      p95 = bin / BIN_SCALE;
      break;
    }
  }

  return {
    meanDeltaE: sum / count,
    p95DeltaE: p95,
    maxDeltaE: max,
    fractionAbove: above / count,
    diff: renderDiff(baseline, deltas),
  };
}

/** True when every reported number is inside its threshold. */
export function withinThresholds(result: ComparisonResult, thresholds: Thresholds): boolean {
  return (
    result.meanDeltaE <= thresholds.meanDeltaE &&
    result.p95DeltaE <= thresholds.p95DeltaE &&
    result.fractionAbove <= thresholds.fractionAbove
  );
}

export function formatResult(result: ComparisonResult, thresholds: Thresholds): string {
  const mark = (value: number, limit: number) => (value <= limit ? 'ok  ' : 'FAIL');
  return [
    `  ${mark(result.meanDeltaE, thresholds.meanDeltaE)} mean ΔE94     ` +
      `${result.meanDeltaE.toFixed(3)} (limit ${thresholds.meanDeltaE.toFixed(3)})`,
    `  ${mark(result.p95DeltaE, thresholds.p95DeltaE)} p95  ΔE94     ` +
      `${result.p95DeltaE.toFixed(3)} (limit ${thresholds.p95DeltaE.toFixed(3)})`,
    `  ${mark(result.fractionAbove, thresholds.fractionAbove)} pixels ΔE>${PER_PIXEL_DELTA_E}  ` +
      `${(100 * result.fractionAbove).toFixed(2)}% (limit ` +
      `${(100 * thresholds.fractionAbove).toFixed(2)}%)`,
    `       max  ΔE94     ${result.maxDeltaE.toFixed(3)}`,
  ].join('\n');
}

/**
 * Builds the diff artefact: the baseline, darkened and desaturated, with a ΔE
 * heat map composited over it.
 *
 * A boolean mask answers "did something change" — which the numbers already
 * said. What a human opening the artefact needs is *where*, *how much*, and
 * *over what*, so the ramp is continuous and the baseline stays legible
 * underneath it. Anything at or above `DIFF_SATURATION` is pure red, so a real
 * regression is a red shape and reshuffled glitter is a blue haze.
 */
function renderDiff(baseline: RgbaImage, deltas: Float32Array): RgbaImage {
  const { width, height } = baseline;
  const out = new Uint8Array(width * height * 4);

  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    const luma =
      0.2126 * baseline.data[p] + 0.7152 * baseline.data[p + 1] + 0.0722 * baseline.data[p + 2];
    const base = luma * 0.22;

    // Square root, not linear. On a linear ramp a broad ΔE 0.5 shift across the
    // whole frame — a changed exposure, exactly the regression a mean catches
    // and an eye does not — renders as black, and the artefact says "nothing
    // happened" while the numbers say otherwise. Compressing the low end puts
    // that shift at a visible dark blue while a ΔE 10 defect is still the only
    // red in the frame.
    const t = Math.sqrt(Math.min(1, deltas[i] / DIFF_SATURATION));
    const heat = ramp(t);
    // The ramp takes over gradually rather than at a hard cut, so a gradient of
    // difference reads as a gradient rather than a contour map.
    const mix = Math.min(1, t * 1.6);

    out[p] = clamp255(base * (1 - mix) + heat[0] * mix);
    out[p + 1] = clamp255(base * (1 - mix) + heat[1] * mix);
    out[p + 2] = clamp255(base * (1 - mix) + heat[2] * mix);
    out[p + 3] = 255;
  }

  return { width, height, data: out };
}

/** Dark blue → cyan → yellow → red. Monotonic in luminance so it reads on print. */
function ramp(t: number): [number, number, number] {
  const stops: [number, number, number, number][] = [
    [0.0, 12, 16, 46],
    [0.25, 30, 70, 210],
    [0.5, 40, 205, 200],
    [0.75, 250, 220, 60],
    [1.0, 255, 40, 25],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, r0, g0, b0] = stops[i - 1];
      const [t1, r1, g1, b1] = stops[i];
      const k = (t - t0) / (t1 - t0);
      return [r0 + (r1 - r0) * k, g0 + (g1 - g0) * k, b0 + (b1 - b0) * k];
    }
  }
  return [255, 40, 25];
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

// ------------------------------------------------------------------- colour

/** sRGB 8-bit → linear, precomputed because it is called six times per pixel. */
const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** D65 white point, the reference illuminant sRGB is defined against. */
const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;

function srgbToLab(r8: number, g8: number, b8: number, out: Float32Array): void {
  const r = LINEAR[r8];
  const g = LINEAR[g8];
  const b = LINEAR[b8];

  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / XN;
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / YN;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / ZN;

  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);

  out[0] = 116 * fy - 16;
  out[1] = 500 * (fx - fy);
  out[2] = 200 * (fy - fz);
}

function labF(t: number): number {
  // 6/29 cubed; below it the curve is linear, which keeps the derivative finite
  // near black where a cube root would blow up on quantisation noise.
  return t > 0.008856451679 ? Math.cbrt(t) : 7.787037037 * t + 16 / 116;
}

/** CIE94, graphic-arts parameters (kL = kC = kH = 1, K1 = 0.045, K2 = 0.015). */
function deltaE94(reference: Float32Array, sample: Float32Array): number {
  const dL = reference[0] - sample[0];
  const da = reference[1] - sample[1];
  const db = reference[2] - sample[2];

  const c1 = Math.hypot(reference[1], reference[2]);
  const c2 = Math.hypot(sample[1], sample[2]);
  const dC = c1 - c2;

  // ΔH² = Δa² + Δb² − ΔC². Negative only through floating-point error.
  const dH2 = Math.max(0, da * da + db * db - dC * dC);

  const sC = 1 + 0.045 * c1;
  const sH = 1 + 0.015 * c1;

  return Math.sqrt(dL * dL + (dC * dC) / (sC * sC) + dH2 / (sH * sH));
}
