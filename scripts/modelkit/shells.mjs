#!/usr/bin/env node
/**
 * shells.mjs — can this model be placed at any angle?
 *
 * "One sided" turns out to mean two unrelated things, and a model can fail
 * either way, so this reports both.
 *
 * **Open shell.** Boundary edges — edges used by exactly one triangle — as a
 * percentage of triangles, counted after welding by position so a UV seam is not
 * mistaken for a hole. Under ~3% is a closed solid you can drop at any angle and
 * see from below. Foliage runs past 100% and that is meaningless rather than
 * bad: a canopy is thousands of separate leaf cards and every one of them is
 * boundary.
 *
 * **Shape.** A model can be perfectly closed and still only work from one
 * direction. Poly Haven's coastal set is the case that motivated this:
 * `coast_line_01` is closed to 0.3% and is a 55 x 2.6 x 43 m *plate* that only
 * reads lying flat, and `coastal_cliff_02` is closed to 0.8% and is a 41 m
 * *facade* 8 m deep that only reads from the front. Neither is a bad asset;
 * both have exactly one correct placement, and a scatter that spins them
 * randomly will show you the back of them.
 *
 * Usage:
 *   node scripts/modelkit/shells.mjs <file-or-dir> [...]
 */

import { documentBounds, io, resolveModels, triangleCount, weldedTriangles } from './lib.mjs';

/** Boundary fraction below which a mesh is a closed solid. */
const CLOSED = 3;
/** Height over footprint below which a model only reads lying flat. */
const PLATE = 0.12;
/** Depth over length below which a model only reads from the front. */
const FACADE = 0.3;

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: node scripts/modelkit/shells.mjs <file-or-dir> [...]');
  process.exit(1);
}

for (const file of resolveModels(targets)) {
  const document = await io.read(file);

  let tris = 0;
  let boundary = 0;
  let nonManifold = 0;

  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      tris += triangleCount(primitive);
      const edges = new Map();
      for (const [a, b, c] of weldedTriangles(primitive)) {
        for (const [u, v] of [
          [a, b],
          [b, c],
          [c, a],
        ]) {
          const k = u < v ? `${u}_${v}` : `${v}_${u}`;
          edges.set(k, (edges.get(k) ?? 0) + 1);
        }
      }
      for (const used of edges.values()) {
        if (used === 1) boundary++;
        else if (used > 2) nonManifold++;
      }
    }
  }

  const box = documentBounds(document);
  const [dx, dy, dz] = box.size;
  const footprint = Math.max(dx, dz);
  const depth = Math.min(dx, dz);
  const plate = footprint > 0 ? dy / footprint : 1;
  const wall = footprint > 0 ? depth / footprint : 1;
  const open = tris ? (boundary / tris) * 100 : 0;

  const verdict =
    open > 60
      ? 'foliage — the shell test does not apply'
      : plate < PLATE
        ? 'PLATE — only reads lying flat'
        : wall < FACADE
          ? 'FACADE — only reads from the front'
          : open < CLOSED
            ? 'all round — place at any angle'
            : 'OPEN SHELL — hollow from some angle';

  const name = file.replace(/^.*[\\/]/, '').replace(/\.(glb|gltf)$/i, '');
  console.log(
    `${name.padEnd(24)} ${String(tris).padStart(7)}t  ` +
      `open=${open.toFixed(1).padStart(5)}%  plate=${plate.toFixed(2)} wall=${wall.toFixed(2)}  ` +
      `nm=${String(nonManifold).padStart(4)}  ${verdict}`,
  );
}
