#!/usr/bin/env node
/**
 * plates.mjs — find the patch of ground a scan was standing on.
 *
 * Photogrammetry of a plant includes the plant *and* the dirt under it, welded
 * into the same primitive. Every Poly Haven tree in this project shipped that
 * way, and at scene scale it reads as a white dinner plate at the foot of each
 * one — `island_tree_03` carried a slab 1.5 m across.
 *
 * The slab is found as a connected component rather than by a height rule,
 * because the two are not the same test and the difference matters: a rule that
 * says "flat and near the bottom" also catches the low limbs a windswept tree
 * rests on the ground, and cutting those leaves the tree floating. A slab is a
 * separate surface — the trunk does not share an edge with it — so component
 * connectivity separates them exactly.
 *
 * This tool only reports. `stripGroundPlate` in `scripts/optimize-assets.mjs`
 * does the cutting, using the same rule and the thresholds printed here.
 *
 * Usage:
 *   node scripts/modelkit/plates.mjs <file-or-dir> [...]
 */

import { io, primitiveBounds, resolveModels, weldedTriangles } from './lib.mjs';

/** Thickness over footprint below which a component is a slab rather than a shape. */
const FLATNESS = 0.22;
/** How close to the model's own base a slab has to sit, as a fraction of its height. */
const GROUNDED = 0.03;
/** Footprint below which a component is too small to be scenery. */
const MIN_FOOTPRINT = 0.05;

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: node scripts/modelkit/plates.mjs <file-or-dir> [...]');
  process.exit(1);
}

for (const file of resolveModels(targets)) {
  const document = await io.read(file);
  const hits = [];

  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      if (!position) continue;

      // Union-find over welded vertices: two triangles are in the same component
      // when they share a vertex.
      const parent = new Int32Array(position.getCount());
      for (let i = 0; i < parent.length; i++) parent[i] = i;
      const find = (x) => {
        while (parent[x] !== x) {
          parent[x] = parent[parent[x]];
          x = parent[x];
        }
        return x;
      };
      const union = (a, b) => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[rb] = ra;
      };

      const triangles = [...weldedTriangles(primitive)];
      for (const [a, b, c] of triangles) {
        union(a, b);
        union(b, c);
      }

      // Component bounds need vertex positions, which the welded indices no
      // longer address — so walk the primitive again by original index.
      const indices = primitive.getIndices();
      const element = [0, 0, 0];
      const components = new Map();
      let baseY = Infinity;
      let topY = -Infinity;

      for (let t = 0; t < triangles.length; t++) {
        const root = find(triangles[t][0]);
        let box = components.get(root);
        if (!box) {
          box = { tris: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
          components.set(root, box);
        }
        box.tris += 1;
        for (let k = 0; k < 3; k++) {
          const vertex = indices ? indices.getScalar(t * 3 + k) : t * 3 + k;
          position.getElement(vertex, element);
          for (let d = 0; d < 3; d++) {
            if (element[d] < box.min[d]) box.min[d] = element[d];
            if (element[d] > box.max[d]) box.max[d] = element[d];
          }
        }
        if (box.min[1] < baseY) baseY = box.min[1];
        if (box.max[1] > topY) topY = box.max[1];
      }

      const height = topY - baseY;
      for (const box of components.values()) {
        const footprint = Math.max(box.max[0] - box.min[0], box.max[2] - box.min[2]);
        const thickness = box.max[1] - box.min[1];
        if (
          thickness < FLATNESS * footprint &&
          box.min[1] < baseY + GROUNDED * height &&
          footprint > MIN_FOOTPRINT * height
        ) {
          hits.push({
            material: primitive.getMaterial()?.getName() ?? '-',
            tris: box.tris,
            size: [box.max[0] - box.min[0], thickness, box.max[2] - box.min[2]],
            yMin: box.min[1],
            ratio: thickness / footprint,
            modelHeight: height,
          });
        }
      }
    }
  }

  const name = file.replace(/^.*[\\/]/, '');
  if (hits.length === 0) {
    console.log(`${name.padEnd(30)} no ground slab`);
    continue;
  }

  const total = hits.reduce((n, h) => n + h.tris, 0);
  console.log(`${name}  —  ${hits.length} slab component(s), ${total} triangles`);
  for (const h of hits) {
    console.log(
      `    ${String(h.tris).padStart(5)}t  ${h.material.padEnd(26)} ` +
        `size=[${h.size.map((v) => v.toFixed(2)).join(' ')}]  yMin=${h.yMin.toFixed(3)}  ` +
        `thickness/footprint=${h.ratio.toFixed(2)}  (model height ${h.modelHeight.toFixed(2)})`,
    );
  }
  console.log(`    Cut it with a \`plate:\` entry in scripts/optimize-assets.mjs.`);
}
