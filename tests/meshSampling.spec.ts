import { expect, test } from '@playwright/test';
import { QUALITY_TIERS } from '../src/core/QualityManager';
import { DEFAULT_MESH_OPTIONS, OceanMesh } from '../src/ocean/OceanMesh';
import {
  FOOTPRINT_SPACINGS,
  boxResponse,
  cascadeReach,
  filterFootprint,
  geometryLod,
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
  test('selects the mip whose footprint is two vertex spacings', () => {
    const spacingPerMetre = vertexSpacingPerMetre(288, 448, INNER, OUTER);
    const texel = 16 / 256; // ripple cascade: tile 16 m over a 256 FFT
    const lod = geometryLod(20, spacingPerMetre, texel);

    // A mip of level L averages 2^L texels, so its footprint is that many
    // texels wide — and it must come back to FOOTPRINT_SPACINGS spacings.
    const spacing = 20 * spacingPerMetre;
    expect(texel * Math.pow(2, lod)).toBeCloseTo(FOOTPRINT_SPACINGS * spacing, 6);
    expect(filterFootprint(20, spacingPerMetre)).toBeCloseTo(
      FOOTPRINT_SPACINGS * spacing,
      6,
    );
  });

  /**
   * The constant is 2 because that is where the box's null lands on the mesh's
   * Nyquist wavelength — not because 2 was a convenient number.
   *
   * An outside review caught the original comment claiming a width-`f` box
   * "suppresses wavelengths below `2f`". The null is at `f`, so that reasoning
   * placed the cutoff at twice its real wavelength and would have justified any
   * factor whatever. The test that shipped with it was no help either: it
   * rearranged the same asserted equation, so it could only ever agree with
   * itself. These assertions are on the actual sinc response, so a wrong factor
   * cannot pass them.
   */
  test('nulls the mesh Nyquist wavelength, for a wave along a texture axis', () => {
    const spacing = 0.75;
    const f = FOOTPRINT_SPACINGS * spacing;

    // Nyquist for a grid of this spacing is 2*spacing, and it is nulled.
    expect(Math.abs(boxResponse(f, 2 * spacing))).toBeLessThan(1e-9);

    // **But only along an axis, and the test name says so for a reason.** A mip
    // is a separable 2D kernel, so a wave crossing at 45 degrees presents
    // sqrt(2) times its wavelength to each axis and survives at ~12.8% rather
    // than being nulled. That is the honest bound on this whole model, it came
    // from an independent review, and it is asserted here so nobody re-derives
    // the constant from the axis-aligned case alone and concludes it is exact.
    const diagonal = boxResponse(f, 2 * spacing * Math.SQRT2) ** 2;
    expect(diagonal).toBeCloseTo(0.128, 3);

    // Everything shorter than Nyquist — the content that would alias — is held
    // in the sidelobes, whose worst case is 22%.
    let worst = 0;
    for (let lam = 0.05 * spacing; lam < 2 * spacing; lam += 0.001 * spacing) {
      worst = Math.max(worst, Math.abs(boxResponse(f, lam)));
    }
    expect(worst).toBeLessThan(0.22);

    // And what the mesh *can* carry is largely passed rather than destroyed.
    // This is the assertion that stops the footprint being widened "to be safe".
    expect(boxResponse(f, 4 * spacing)).toBeCloseTo(0.6366, 3);
    expect(boxResponse(f, 8 * spacing)).toBeCloseTo(0.9003, 3);
  });

  /**
   * The term an outside review caught missing. Without it a cascade runs on
   * until its 1x1 mip, which is far past the point where it has anything left
   * to contribute but sign-inverted sidelobe.
   */
  test('cuts a cascade where its own band is nulled, not at its 1x1 mip', () => {
    const maxWavelength = 6; // the ripple cascade
    expect(cascadeReach(0.4 * maxWavelength, maxWavelength)).toBe(1);
    expect(cascadeReach(maxWavelength, maxWavelength)).toBe(0);
    expect(cascadeReach(1.5 * maxWavelength, maxWavelength)).toBe(0);

    // The fade begins where the band's longest wave is still at 64% and ends
    // where it is exactly nulled. Past that everything left is sidelobe, and
    // sidelobes are sign-inverted — which is why this cuts rather than trails.
    expect(boxResponse(0.5 * maxWavelength, maxWavelength)).toBeCloseTo(0.6366, 3);
    expect(Math.abs(boxResponse(maxWavelength, maxWavelength))).toBeLessThan(1e-9);
    expect(boxResponse(1.25 * maxWavelength, maxWavelength)).toBeLessThan(0);

    // And it reaches zero far sooner than the 1x1 mip does. At High as
    // previously proportioned the ripple cascade's 1x1 level sits at 213 m,
    // which is the distance the deleted-fade version kept displacing to.
    const s = vertexSpacingPerMetre(288, 448, INNER, OUTER);
    expect(maxWavelength / (FOOTPRINT_SPACINGS * s)).toBeLessThan(100);
    expect(16 / (FOOTPRINT_SPACINGS * s)).toBeGreaterThan(200);
  });

  test('never asks for a sharper mip than level zero', () => {
    // Right under the camera the spacing is millimetres and the field is
    // already over-sampled; a negative level is not a thing to request.
    expect(geometryLod(0, 0.0375, 0.0625)).toBe(0);
    expect(geometryLod(0.01, 0.0375, 0.0625)).toBe(0);
  });

  test('is what the mesh itself reports', () => {
    // `undefined` material, so `THREE.Mesh` supplies its own default rather
    // than being handed a null it would later try to dispose.
    const mesh = new OceanMesh(undefined as never, {
      radialSegments: 288,
      angularSegments: 448,
    });
    expect(mesh.spacingPerMetre).toBeCloseTo(
      vertexSpacingPerMetre(
        288,
        448,
        DEFAULT_MESH_OPTIONS.innerRadius,
        DEFAULT_MESH_OPTIONS.outerRadius,
      ),
      6,
    );
    mesh.dispose();
  });

  /**
   * Independent corroboration, and the reason to trust the derivation over the
   * numbers: the fade is a function of mesh density and band edge alone, and it
   * still lands where somebody tuning by eye put it.
   */
  test('starts fading each cascade inside the ramp the old table used', () => {
    const s = vertexSpacingPerMetre(288, 448, INNER, OUTER);
    // `cascadeReach` begins cutting at footprint = maxWavelength/2 and finishes
    // at maxWavelength. The distances that correspond to, for High as it was
    // proportioned when that table was tuned:
    const startsAt = (maxWavelength: number) =>
      (0.5 * maxWavelength) / (FOOTPRINT_SPACINGS * s);

    // Ripple tops out at 6 m; the old table ramped 18 -> 55 m.
    expect(startsAt(6)).toBeGreaterThan(18);
    expect(startsAt(6)).toBeLessThan(55);

    // Chop tops out at 24 m; the old table ramped 110 -> 300 m.
    expect(startsAt(24)).toBeGreaterThan(110);
    expect(startsAt(24)).toBeLessThan(300);

    // Swell is the base band and must never be faded inside the mesh at all.
    expect(startsAt(10000)).toBeGreaterThan(24000);
  });
});

/**
 * The vertex budget each tier had before the split was squared. Hard-coded
 * rather than derived, so that a tier quietly growing its budget shows up as a
 * failure here rather than as a frame-rate regression somewhere else.
 */
const TIER_BEFORE: Record<string, [number, number]> = {
  low: [128, 192],
  medium: [192, 288],
  high: [288, 448],
  ultra: [384, 576],
  max: [512, 768],
};

/** True vertex and triangle counts of the built grid. See `buildRadialGrid`. */
const vertices = (r: number, s: number) => (r + 1) * s + 1;
const triangles = (r: number, s: number) => s * (2 * r + 1);

test.describe('quality tiers', () => {
  test('spend their vertices on square triangles', () => {
    for (const name of Object.keys(TIER_BEFORE)) {
      const tier = QUALITY_TIERS[name as keyof typeof QUALITY_TIERS];
      const radial = Math.pow(OUTER / INNER, 1 / tier.meshRings) - 1;
      const angular = (Math.PI * 2) / tier.meshSegments;
      const ratio = Math.max(radial, angular) / Math.min(radial, angular);
      expect(
        Math.abs(radial - angular) / radial,
        `${name} is ${ratio.toFixed(2)}x out of square, so the finer axis is buying nothing`,
      ).toBeLessThan(0.005);
    }
  });

  test('resolve shorter waves than they did, and cost no more', () => {
    for (const [name, [r, s]] of Object.entries(TIER_BEFORE)) {
      const tier = QUALITY_TIERS[name as keyof typeof QUALITY_TIERS];
      const was = vertexSpacingPerMetre(r, s, INNER, OUTER);
      const now = vertexSpacingPerMetre(tier.meshRings, tier.meshSegments, INNER, OUTER);
      expect(was / now, `${name} did not improve`).toBeGreaterThan(1.55);

      // Not "identical cost" — an outside review was right to object to that
      // phrasing. Trading segments for rings at a fixed rings*segments lowers
      // both true counts slightly, so the bound is "no more than before".
      expect(
        vertices(tier.meshRings, tier.meshSegments),
        `${name} grew its vertex count`,
      ).toBeLessThanOrEqual(vertices(r, s));
      expect(
        triangles(tier.meshRings, tier.meshSegments),
        `${name} grew its triangle count`,
      ).toBeLessThanOrEqual(triangles(r, s));
    }
  });

  test('are what squareGrid derives, so the table cannot drift from its rule', () => {
    for (const [name, [r, s]] of Object.entries(TIER_BEFORE)) {
      const tier = QUALITY_TIERS[name as keyof typeof QUALITY_TIERS];
      const derived = squareGrid(r * s, INNER, OUTER);
      expect({ r: tier.meshRings, s: tier.meshSegments }, name).toEqual({
        r: derived.radialSegments,
        s: derived.angularSegments,
      });
    }
  });
});

test.describe('squareGrid contract', () => {
  test('rejects a budget it cannot serve rather than exceeding it', () => {
    // Below 6 there is no pair satisfying R >= 2, S >= 3, and a non-finite
    // budget makes the search bound non-finite. Both used to fall through to
    // the initialised 2x3 — which spends 6 vertices whatever it was given.
    expect(() => squareGrid(5, INNER, OUTER)).toThrow(RangeError);
    expect(() => squareGrid(Number.POSITIVE_INFINITY, INNER, OUTER)).toThrow(RangeError);
    expect(() => squareGrid(Number.NaN, INNER, OUTER)).toThrow(RangeError);
    expect(() => squareGrid(6, INNER, OUTER)).not.toThrow();
  });
});
