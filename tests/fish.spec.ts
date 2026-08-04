import { test, expect } from '@playwright/test';
import * as THREE from 'three/webgpu';
import { normaliseImportedBody } from '../src/scene/Fish';

/**
 * `normaliseImportedBody` is the contract between an imported body and the
 * vertex stage that swims it, and it is worth a test in Node rather than a
 * screenshot because the failure it guards against is silent in every way that
 * a picture of a reef would catch.
 *
 * The body frame is not decorative. `Fish.ts` derives the travelling wave's body
 * axis as `s = 0.5 - x` and scales its amplitude by `s^3`, so the frame is what
 * keeps `s` inside 0..1 and the lateral swing inside a tenth of a body length.
 * Put the body somewhere else along x and the cubic does not degrade — it
 * explodes. At `s = 2` the envelope is already eight times the tail amplitude
 * the animal is supposed to have.
 *
 * These run without a browser: the function is pure geometry.
 */

/**
 * A body authored the way the real asset is — nose toward +z, a fraction of a
 * metre long, and deliberately off-centre in the other two axes.
 *
 * The length matters. The defect this file was written for applied the
 * normalising scale twice, which is invisible at unit length and enormous at the
 * 0.2 m the real `emperor_angelfish` is authored at. A fixture one unit long
 * would have passed against the broken implementation.
 */
function sourceBody(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  // A tetrahedron is enough: all that is read is the bounding box.
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        0.03, 0.02, 0.1,
        -0.01, -0.06, -0.1,
        0.03, -0.06, 0.1,
        -0.01, 0.02, -0.1,
      ],
      3,
    ),
  );
  return geometry;
}

/** Source extents, for the expectations below. Length 0.2 along the +z nose axis. */
const SOURCE_LENGTH = 0.2;
const SOURCE_HEIGHT = 0.08;
const SOURCE_WIDTH = 0.04;

test.describe('normaliseImportedBody', () => {
  test('puts the nose on +0.5x and the tail on -0.5x, one unit long', async () => {
    const geometry = normaliseImportedBody(sourceBody(), '+z');
    geometry.computeBoundingBox();
    const box = geometry.boundingBox as THREE.Box3;

    // The two numbers the wave actually depends on. `s = 0.5 - x` is 0 at the
    // nose and 1 at the tail only if these hold.
    expect(box.max.x).toBeCloseTo(0.5, 5);
    expect(box.min.x).toBeCloseTo(-0.5, 5);
  });

  test('centres the body on its other two axes', async () => {
    const geometry = normaliseImportedBody(sourceBody(), '+z');
    geometry.computeBoundingBox();
    const box = geometry.boundingBox as THREE.Box3;

    // Not cosmetic: the school frame places a fish by its origin and the weave
    // banks it about the same point, so a body whose mass sits off the origin
    // is a fish that orbits its own axis instead of rolling on it.
    expect((box.min.y + box.max.y) * 0.5).toBeCloseTo(0, 5);
    expect((box.min.z + box.max.z) * 0.5).toBeCloseTo(0, 5);

    // Uniformly scaled, so the source's proportions survive.
    const scale = 1 / SOURCE_LENGTH;
    expect(box.max.y - box.min.y).toBeCloseTo(SOURCE_HEIGHT * scale, 5);
    expect(box.max.z - box.min.z).toBeCloseTo(SOURCE_WIDTH * scale, 5);
  });

  test('keeps the wave amplitude envelope inside its designed range', async () => {
    const geometry = normaliseImportedBody(sourceBody(), '+z');
    const position = geometry.getAttribute('position');

    // The invariant stated as the shader states it. `WAVE_AMP * s^3` is the
    // lateral swing in body lengths; over a correct body it peaks at the
    // authored 0.085, and this asserts the input that guarantees it rather than
    // the constant, which the shader owns.
    let maxS = Number.NEGATIVE_INFINITY;
    let minS = Number.POSITIVE_INFINITY;
    for (let i = 0; i < position.count; i++) {
      const s = 0.5 - position.getX(i);
      if (s > maxS) maxS = s;
      if (s < minS) minS = s;
    }

    expect(minS).toBeCloseTo(0, 5);
    expect(maxS).toBeCloseTo(1, 5);
  });

  test('accepts a body authored along any of the four horizontal directions', async () => {
    // `-z` and `+x` reach the same frame by a different rotation; a sign error
    // in one of them puts the fish's nose where its tail should be, which the
    // wave then drives from the wrong end.
    for (const axis of ['+z', '-z', '+x', '-x'] as const) {
      const geometry = normaliseImportedBody(sourceBody(), axis);
      geometry.computeBoundingBox();
      const box = geometry.boundingBox as THREE.Box3;
      expect(box.max.x, `nose on +0.5x for ${axis}`).toBeCloseTo(0.5, 5);
      expect(box.min.x, `tail on -0.5x for ${axis}`).toBeCloseTo(-0.5, 5);
    }
  });
});
