import { expect, test } from '@playwright/test';
import {
  SAMPLES_PER_WAVELENGTH,
  geometryLod,
  resolvedWavelength,
  squareGrid,
  vertexSpacingPerMetre,
} from '../src/ocean/meshSampling';

/**
 * Pure arithmetic — no browser, no GPU. It runs in the functional project
 * because that project ignores only the visual specs by name.
 */

/** The built mesh's own bounds. See `DEFAULT_MESH_OPTIONS`. */
const INNER = 0.6;
const OUTER = 24000;

test.describe('vertex spacing', () => {
  test('reports the worse of the two axes', () => {
    // High: 288 rings, 448 segments. Radial (0.0375) is the worse axis.
    expect(vertexSpacingPerMetre(288, 448, INNER, OUTER)).toBeCloseTo(0.03748, 4);

    // Invert the split and the angular axis becomes the worse one: 2*pi/64.
    expect(vertexSpacingPerMetre(2000, 64, INNER, OUTER)).toBeCloseTo(
      (Math.PI * 2) / 64,
      6,
    );
  });

  test('scales as one over the ring count', () => {
    const coarse = vertexSpacingPerMetre(144, 100000, INNER, OUTER);
    const fine = vertexSpacingPerMetre(288, 100000, INNER, OUTER);
    // exp(L/R) - 1, so not exactly a factor of two — but close, and monotone.
    expect(coarse / fine).toBeGreaterThan(1.9);
    expect(coarse / fine).toBeLessThan(2.1);
  });
});

test.describe('square grid', () => {
  test('equalises the two axes at a fixed vertex budget', () => {
    const { radialSegments, angularSegments } = squareGrid(288 * 448, INNER, OUTER);
    expect(radialSegments).toBe(469);
    expect(angularSegments).toBe(275);

    const radial = Math.pow(OUTER / INNER, 1 / radialSegments) - 1;
    const angular = (Math.PI * 2) / angularSegments;
    // Within a tenth of a percent. The closed-form seed alone lands a full
    // percent out — it solves L/R rather than exp(L/R)-1 — so this bound is
    // what pins the search that corrects it, and it is the whole point of
    // the split.
    expect(Math.abs(radial - angular) / radial).toBeLessThan(0.001);
  });

  test('spends no more vertices than it was given', () => {
    const budget = 288 * 448;
    const { radialSegments, angularSegments } = squareGrid(budget, INNER, OUTER);
    expect(radialSegments * angularSegments).toBeLessThan(budget * 1.02);
  });

  test('resolves shorter waves than the split it replaces', () => {
    const before = vertexSpacingPerMetre(288, 448, INNER, OUTER);
    const { radialSegments, angularSegments } = squareGrid(288 * 448, INNER, OUTER);
    const after = vertexSpacingPerMetre(radialSegments, angularSegments, INNER, OUTER);
    expect(before / after).toBeGreaterThan(1.55);
  });
});

test.describe('geometry LOD', () => {
  test('keeps exactly the wavelengths the mesh can carry', () => {
    const spacingPerMetre = vertexSpacingPerMetre(288, 448, INNER, OUTER);
    const texel = 16 / 256; // ripple cascade: tile 16 m over a 256 FFT
    const lod = geometryLod(20, spacingPerMetre, texel);

    // A mip of level L averages 2^L texels; a box average of width f
    // suppresses wavelengths under 2f. So the shortest surviving wavelength
    // is 2 * texel * 2^lod, and it must equal SAMPLES_PER_WAVELENGTH spacings.
    const surviving = 2 * texel * Math.pow(2, lod);
    const spacing = 20 * spacingPerMetre;
    expect(surviving).toBeCloseTo(SAMPLES_PER_WAVELENGTH * spacing, 6);
    expect(resolvedWavelength(20, spacingPerMetre)).toBeCloseTo(surviving, 6);
  });

  test('never asks for a sharper mip than level zero', () => {
    // Right under the camera the spacing is millimetres and the field is
    // already over-sampled; a negative level is not a thing to request.
    expect(geometryLod(0, 0.0375, 0.0625)).toBe(0);
    expect(geometryLod(0.01, 0.0375, 0.0625)).toBe(0);
  });

  test('reproduces the fade distances that were tuned by eye', () => {
    const s = vertexSpacingPerMetre(288, 448, INNER, OUTER);
    // The ripple cascade tops out at 6 m; it is extinguished once the
    // shortest surviving wavelength passes that. The table it replaces
    // ramped 18 -> 55 m.
    const rippleGone = 6 / (SAMPLES_PER_WAVELENGTH * s);
    expect(rippleGone).toBeGreaterThan(18);
    expect(rippleGone).toBeLessThan(55);

    // Chop tops out at 24 m; its table ramped 110 -> 300 m.
    const chopGone = 24 / (SAMPLES_PER_WAVELENGTH * s);
    expect(chopGone).toBeGreaterThan(110);
    expect(chopGone).toBeLessThan(300);
  });
});
