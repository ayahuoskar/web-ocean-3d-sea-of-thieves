#!/usr/bin/env node
/**
 * inspect.mjs — what is actually in a glTF.
 *
 * Per primitive: triangles, material, alpha mode, which texture slots are
 * filled, attribute set, and local bounds. The things that decide whether an
 * asset will work in this project and none of which a viewer shows you.
 *
 * Two of them have caused real bugs here and are worth knowing to look for:
 *
 *  - `alpha=BLEND` on a material whose base colour is a JPEG. There is no alpha
 *    channel to blend, so the declaration buys nothing and costs the kind its
 *    place in the opaque pass — every tree in this project shipped that way.
 *  - Several primitives sharing one material name but appearing separately. That
 *    is a kit file (a row of variants for someone to choose from), not a model,
 *    and instancing it whole gives you the shop display.
 *
 * Usage:
 *   node scripts/modelkit/inspect.mjs <file-or-dir> [...]
 */

import { statSync } from 'node:fs';
import { bytes, documentBounds, io, primitiveBounds, resolveModels, triangleCount } from './lib.mjs';

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: node scripts/modelkit/inspect.mjs <file-or-dir> [...]');
  process.exit(1);
}

for (const file of resolveModels(targets)) {
  const document = await io.read(file);
  const root = document.getRoot();

  let tris = 0;
  const rows = [];
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const n = triangleCount(primitive);
      tris += n;
      const material = primitive.getMaterial();
      rows.push({
        tris: n,
        mesh: mesh.getName() || '-',
        material: material?.getName() ?? '-',
        alpha: material?.getAlphaMode() ?? '-',
        cutoff: material?.getAlphaCutoff(),
        doubleSided: material?.getDoubleSided() ?? false,
        base: !!material?.getBaseColorTexture(),
        normal: !!material?.getNormalTexture(),
        attributes: primitive.listSemantics().join(','),
        bounds: primitiveBounds(primitive),
      });
    }
  }

  const box = documentBounds(document);
  const extensions = root.listExtensionsUsed().map((e) => e.extensionName);

  console.log(
    `\n=== ${file}  ${bytes(statSync(file).size)}  ${tris.toLocaleString('en-US')} tris ===`,
  );
  console.log(
    `    size=[${box.size.map((v) => v.toFixed(2)).join(' x ')}]  yMin=${box.min[1].toFixed(3)}  ` +
      `nodes=${root.listNodes().length}  materials=${root.listMaterials().length}  ` +
      `textures=${root.listTextures().length}  skins=${root.listSkins().length}  ` +
      `animations=${root.listAnimations().length}`,
  );
  if (extensions.length) console.log(`    extensions: ${extensions.join(', ')}`);

  for (const r of rows) {
    const alpha = r.alpha === 'MASK' ? `MASK@${r.cutoff}` : r.alpha;
    console.log(
      `  ${String(r.tris).padStart(7)}t  ${r.material.padEnd(30)} ${alpha.padEnd(10)}` +
        `ds=${r.doubleSided ? 'Y' : 'n'} tex=${r.base ? 'base' : '----'}${r.normal ? '+nrm' : ''}  ` +
        `size=[${r.bounds.size.map((v) => v.toFixed(2)).join(' ')}]  ${r.attributes}`,
    );
  }

  // The check that is invisible in a viewer and expensive to miss.
  const suspect = rows.filter((r) => r.alpha === 'BLEND');
  if (suspect.length) {
    console.log(
      `    NOTE  ${suspect.length} BLEND material(s). If the base colour has no alpha channel this` +
        ` is spurious — see promoteToOpaque in scripts/optimize-assets.mjs.`,
    );
  }
}
