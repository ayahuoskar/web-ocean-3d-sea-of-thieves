/**
 * Shared plumbing for the modelkit tools.
 *
 * One I/O instance configured the way the shipped assets need it — Meshopt
 * decoding, every glTF extension registered — and the two or three geometry
 * helpers all the tools want. Kept apart from the tools themselves so that
 * adding a tool does not mean copying a decoder registration.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;

export const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

/** Every `.glb`/`.gltf` under the given paths, whether files or directories. */
export function resolveModels(paths) {
  const out = [];
  for (const path of paths) {
    if (!statSync(path).isDirectory()) {
      out.push(path);
      continue;
    }
    for (const name of readdirSync(path).sort()) {
      if (/\.(glb|gltf)$/i.test(name)) out.push(join(path, name));
    }
  }
  return out;
}

export function triangleCount(primitive) {
  const indices = primitive.getIndices();
  const position = primitive.getAttribute('POSITION');
  const count = indices ? indices.getCount() : (position?.getCount() ?? 0);
  return Math.floor(count / 3);
}

/** Axis-aligned bounds of a primitive, in the mesh's own space. */
export function primitiveBounds(primitive) {
  const position = primitive.getAttribute('POSITION');
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const element = [0, 0, 0];
  for (let i = 0; i < position.getCount(); i++) {
    position.getElement(i, element);
    for (let d = 0; d < 3; d++) {
      if (element[d] < min[d]) min[d] = element[d];
      if (element[d] > max[d]) max[d] = element[d];
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/** Bounds over every primitive in the document, in mesh space. */
export function documentBounds(document) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const box = primitiveBounds(primitive);
      for (let d = 0; d < 3; d++) {
        if (box.min[d] < min[d]) min[d] = box.min[d];
        if (box.max[d] > max[d]) max[d] = box.max[d];
      }
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/**
 * Vertex indices welded by position, so a UV seam does not read as a hole.
 *
 * Every topology question below — is this closed, what are its connected
 * components — is meaningless without this: an exported mesh splits vertices
 * wherever a UV or a normal changes, and counting raw indices would call a
 * perfectly closed rock an open shell.
 */
export function weldByPosition(primitive) {
  const position = primitive.getAttribute('POSITION');
  const key = new Map();
  const remap = new Int32Array(position.getCount());
  const element = [0, 0, 0];
  for (let i = 0; i < position.getCount(); i++) {
    position.getElement(i, element);
    const k = `${Math.round(element[0] * 1e4)},${Math.round(element[1] * 1e4)},${Math.round(element[2] * 1e4)}`;
    let id = key.get(k);
    if (id === undefined) {
      id = key.size;
      key.set(k, id);
    }
    remap[i] = id;
  }
  return remap;
}

/** Triangle corner indices of a primitive, welded by position. */
export function* weldedTriangles(primitive) {
  const indices = primitive.getIndices();
  const position = primitive.getAttribute('POSITION');
  if (!position) return;
  const remap = weldByPosition(primitive);
  const count = indices ? indices.getCount() : position.getCount();
  for (let i = 0; i < count; i += 3) {
    yield [
      remap[indices ? indices.getScalar(i) : i],
      remap[indices ? indices.getScalar(i + 1) : i + 1],
      remap[indices ? indices.getScalar(i + 2) : i + 2],
    ];
  }
}

export const bytes = (n) =>
  n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
