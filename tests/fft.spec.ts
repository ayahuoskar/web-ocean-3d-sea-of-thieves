import { expect, test } from '@playwright/test';
import { createButterflyTexture } from '../src/ocean/FFT';

/**
 * The transform, checked against the definition of a transform.
 *
 * Pure arithmetic — no browser, no GPU — for the same reason `meshSampling.spec`
 * is: the thing that decides whether this IFFT is correct is a table of twiddle
 * factors and read indices generated on the CPU, and that table can be executed
 * on the CPU too. The shader is a faithful transcription of one line
 * (`out = A + W * B`), so a table that transforms correctly here transforms
 * correctly there.
 *
 * **This exists because the bug it catches has already shipped once.** The
 * comment in `createButterflyTexture` records it: the twiddle exponent was taken
 * over the group width rather than the half-span, which makes stage 0 apply
 * `W^(N/2) = -1` to every odd row and scrambles the transform from the first
 * pass. Nothing in the suite would have failed. The sea would have looked
 * *wrong*, which is not the same as looking broken, and there was no test that
 * could tell the difference.
 *
 * The reference is a direct O(N^2) DFT written from the definition rather than
 * from this implementation. That distinction is the whole value of the file: a
 * test that restates the implementation's own algebra proves nothing, and this
 * project has made that mistake before too.
 */

/** One complex sequence as interleaved re/im, the layout the butterfly uses. */
type Complex = { re: Float64Array; im: Float64Array };

function randomSignal(size: number, seed: number): Complex {
  // Deterministic LCG: a failure has to be reproducible to be worth anything.
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000 - 0.5;
  };
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    re[i] = next();
    im[i] = next();
  }
  return { re, im };
}

/**
 * The inverse discrete Fourier transform, unnormalised, straight from the
 * definition: `X[k] = sum_n x[n] * e^(+2*pi*i*k*n/N)`.
 *
 * The positive exponent is what makes it the *inverse* transform, and it is what
 * the butterfly's `+sin` twiddle encodes. No scaling by 1/N: the shader does not
 * apply one either, because the spectrum it is handed is scaled for it upstream.
 */
function referenceIDFT(input: Complex): Complex {
  const size = input.re.length;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let k = 0; k < size; k++) {
    let sumRe = 0;
    let sumIm = 0;
    for (let n = 0; n < size; n++) {
      const angle = (2 * Math.PI * k * n) / size;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      sumRe += input.re[n] * c - input.im[n] * s;
      sumIm += input.re[n] * s + input.im[n] * c;
    }
    re[k] = sumRe;
    im[k] = sumIm;
  }
  return { re, im };
}

/**
 * Executes the butterfly table exactly as `butterflyPassNode` does.
 *
 * One pass per stage; for each output row the table supplies a signed twiddle
 * and the two rows to read, and the output is `A + W * B`. Ping-ponging is a
 * plain buffer swap here, as it is on the GPU.
 */
function runButterfly(table: Float32Array, stages: number, input: Complex): Complex {
  const size = input.re.length;
  let readRe = Float64Array.from(input.re);
  let readIm = Float64Array.from(input.im);
  let writeRe = new Float64Array(size);
  let writeIm = new Float64Array(size);

  for (let stage = 0; stage < stages; stage++) {
    for (let y = 0; y < size; y++) {
      const offset = (stage + y * stages) * 4;
      const twiddleRe = table[offset + 0];
      const twiddleIm = table[offset + 1];
      const idxA = table[offset + 2];
      const idxB = table[offset + 3];

      const aRe = readRe[idxA];
      const aIm = readIm[idxA];
      const bRe = readRe[idxB];
      const bIm = readIm[idxB];

      // cMul(twiddle, b)
      writeRe[y] = aRe + (twiddleRe * bRe - twiddleIm * bIm);
      writeIm[y] = aIm + (twiddleRe * bIm + twiddleIm * bRe);
    }
    [readRe, writeRe] = [writeRe, readRe];
    [readIm, writeIm] = [writeIm, readIm];
  }

  return { re: readRe, im: readIm };
}

function maxAbsError(a: Complex, b: Complex): number {
  let worst = 0;
  for (let i = 0; i < a.re.length; i++) {
    worst = Math.max(worst, Math.abs(a.re[i] - b.re[i]), Math.abs(a.im[i] - b.im[i]));
  }
  return worst;
}

/** Every size the quality tiers can ask for, plus small ones a failure is readable at. */
const SIZES = [4, 8, 16, 128, 256, 512];

test.describe('the butterfly table', () => {
  for (const size of SIZES) {
    test(`transforms a ${size}-point signal exactly as the definition does`, () => {
      const texture = createButterflyTexture(size);
      const stages = Math.log2(size);
      const table = texture.image.data as Float32Array;

      const input = randomSignal(size, 0x5eed + size);
      const actual = runButterfly(table, stages, input);
      const expected = referenceIDFT(input);

      // The table is float32 and the reference is float64, so the error floor is
      // the table's own precision amplified by `stages` rounds of accumulation.
      // Scaled by the transform's magnitude, which grows as N for a DC-heavy
      // signal, rather than fixed — a fixed epsilon would either be slack at 512
      // or unmeetable at 4.
      let scale = 0;
      for (let i = 0; i < size; i++) {
        scale = Math.max(scale, Math.abs(expected.re[i]), Math.abs(expected.im[i]));
      }
      const tolerance = Math.max(1e-9, scale * 1e-5);

      expect(
        maxAbsError(actual, expected),
        `the butterfly table does not compute an inverse DFT at N=${size}. ` +
          'Check the twiddle exponent (it is taken over the half-span, not the ' +
          'group width) and the stage-0 bit reversal.',
      ).toBeLessThan(tolerance);

      texture.dispose();
    });
  }

  /**
   * The property the historical bug broke, asserted on its own — and asserted
   * on the value rather than on the magnitude, which is the whole point.
   *
   * At stage 0 the half-span is 1, so `k = y % 1 = 0` on every row: the twiddle
   * is `W^0 = 1`, and the two halves of each butterfly differ only in the sign
   * the table bakes in. Even rows are tops and carry `+1`; odd rows are bottoms
   * and carry `-1`.
   *
   * **The first version of this test asserted unit magnitude and a zero
   * imaginary part, and the historical bug passed it.** Taking the exponent over
   * the group width gives odd rows `W^(N/2) = -1`, which is also unit magnitude
   * and also purely real — and then the table's own sign flip turns it back into
   * `+1`, so the bug shows up precisely as an odd row carrying `+1` where it
   * should carry `-1`. A test that checks the magnitude of a number whose sign
   * is the defect is not a test. Verified by re-introducing the bug: the earlier
   * form passed, this form fails.
   */
  test('stage 0 carries +1 on tops and -1 on bottoms, with no rotation', () => {
    const size = 64;
    const texture = createButterflyTexture(size);
    const stages = Math.log2(size);
    const table = texture.image.data as Float32Array;

    for (let y = 0; y < size; y++) {
      const offset = (0 + y * stages) * 4;
      const re = table[offset + 0];
      const im = table[offset + 1];
      const expected = y % 2 === 0 ? 1 : -1;
      expect(Math.abs(im), `stage 0 row ${y} has an imaginary twiddle component`).toBeLessThan(1e-6);
      expect(
        Math.abs(re - expected),
        `stage 0 row ${y} carries ${re}, expected ${expected} — the twiddle exponent is ` +
          'being taken over the group width rather than the half-span',
      ).toBeLessThan(1e-6);
    }

    texture.dispose();
  });

  test('rejects a size that is not a power of two', () => {
    expect(() => createButterflyTexture(100)).toThrow(/power of two/);
  });
});
