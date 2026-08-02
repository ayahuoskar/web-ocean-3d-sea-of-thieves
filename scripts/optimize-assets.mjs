#!/usr/bin/env node
/**
 * optimize-assets.mjs — decimates and compresses the scene-dressing models.
 *
 * Poly Haven publishes film-quality geometry. That is the right choice for their
 * audience and the wrong one for ours: `island_tree_01` arrives as a 58 MB `.bin`
 * of raw vertex data, and it is a background tree seen from forty metres. The six
 * dressing models between them are 180 MB, against 57 MB for the entire rest of
 * the project — committing that would triple the repository to render silhouettes.
 *
 * So the fetch step keeps its job (get the authoritative source, verify it
 * against the publisher's manifest) and this step does what a game pipeline
 * does: decimate to the detail the camera can resolve, weld, strip what is not
 * read, and re-encode through Meshopt. `AssetLoader` already advertises the
 * Meshopt decoder — its own comment says re-exporting through gltf-transform is
 * expected and should not require a code change — so nothing at runtime changes.
 *
 * Only the raw downloads are large, and only the `.glb` outputs are committed;
 * `.gitignore` carries the split. Both are reproducible:
 *
 *   node scripts/fetch-assets.mjs      # authoritative source, verified
 *   node scripts/optimize-assets.mjs   # what actually ships
 *
 * Usage:
 *   node scripts/optimize-assets.mjs           # build anything missing
 *   node scripts/optimize-assets.mjs --force   # rebuild everything
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = join(ROOT, 'public', 'models');
const OUT = join(MODELS, 'dressing');

const FORCE = process.argv.includes('--force');

/**
 * Per-asset simplification ratio and texture budget.
 *
 * `ratio` is the fraction of triangles to keep. The numbers are not uniform
 * because the assets are not: a tree's silhouette is carried by thousands of
 * separate leaf cards and collapses badly, while a rock is one closed surface
 * that decimates almost freely. `error` is the maximum allowed deviation as a
 * fraction of the mesh's extent — the simplifier stops early rather than exceed
 * it, so a low `ratio` on a shape that cannot take it degrades gracefully
 * instead of shredding.
 *
 * `texture` caps the longest edge. These are 1k downloads; at the distances they
 * are placed, 512 is generous and halves the payload again.
 */
const ASSETS = [
  // Trees are the worst case for a simplifier and the reason these ratios are
  // not uniform: the canopy is thousands of separate leaf cards with no shared
  // edges between them, so most of the triangle count cannot be collapsed at
  // all and the error bound stops the pass long before the ratio is reached.
  // Asking for 5% and getting 12% is the simplifier refusing to shred the
  // silhouette, which is the behaviour we want.
  // The error bound, not the ratio, is what actually moves a tree. At 0.02 the
  // simplifier refuses almost every collapse — the canopy is thousands of
  // separate leaf cards with no shared edges — and `jacaranda_tree` came out at
  // 16 MB for one background tree, two thirds of the entire shipped payload.
  // 0.06 lets whole leaf clusters merge. It is a visible trade at arm's length
  // and invisible at the forty metres these are actually seen from.
  { slug: 'island_tree_01', ratio: 0.022, error: 0.06, texture: 512 },
  { slug: 'pachira_aquatica_01', ratio: 0.15, error: 0.012, texture: 512 },
  { slug: 'island_tree_02', ratio: 0.03, error: 0.06, texture: 512 },
  { slug: 'island_tree_03', ratio: 0.017, error: 0.06, texture: 512 },
  { slug: 'jacaranda_tree', ratio: 0.008, error: 0.08, texture: 512 },
  { slug: 'fern_02', ratio: 0.35, error: 0.01, texture: 512 },
  { slug: 'shrub_sorrel_01', ratio: 0.35, error: 0.01, texture: 512 },
  { slug: 'grass_bermuda_01', ratio: 0.4, error: 0.01, texture: 512 },

  // Coastline edges carry the shoreline's silhouette, so they keep a little more
  // than the rock masses do — a decimated edge reads as a bitten one.
  { slug: 'coast_line_01', ratio: 0.08, error: 0.01, texture: 1024 },
  { slug: 'coast_line_02', ratio: 0.08, error: 0.01, texture: 1024 },
  { slug: 'coast_land_rocks_03', ratio: 0.06, error: 0.012, texture: 1024 },
  { slug: 'coastal_cliff_04', ratio: 0.06, error: 0.012, texture: 1024 },

  { slug: 'coast_rocks_01', ratio: 0.06, error: 0.012, texture: 1024 },
  { slug: 'coast_rocks_03', ratio: 0.06, error: 0.012, texture: 1024 },
  { slug: 'coastal_cliff_02', ratio: 0.06, error: 0.012, texture: 1024 },
  { slug: 'sand_rocks_small_01', ratio: 0.1, error: 0.012, texture: 512 },

  { slug: 'anthurium_botany_01', ratio: 0.3, error: 0.01, texture: 512 },
  { slug: 'calathea_orbifolia_01', ratio: 0.3, error: 0.01, texture: 512 },

  // Pirate cove. `ship_pinnace` and `cannon_01` are rigged in the source; the
  // rig is stripped by `prune` because nothing here animates them, and a boat
  // hauled up a beach does not need to.
  { slug: 'ship_pinnace', ratio: 0.2, error: 0.008, texture: 1024 },
  { slug: 'modular_wooden_pier', ratio: 0.25, error: 0.008, texture: 1024 },
  { slug: 'cannon_01', ratio: 0.25, error: 0.006, texture: 512 },
  { slug: 'wooden_barrels_01', ratio: 0.3, error: 0.008, texture: 512 },
  { slug: 'wooden_lantern_01', ratio: 0.35, error: 0.006, texture: 512 },
  { slug: 'wooden_crate_02', ratio: 0.3, error: 0.008, texture: 512 },

  // Pirate remains. Held to a tighter error than the rocks: these are handled
  // objects seen from a couple of metres, where a collapsed hilt or a faceted
  // jug is the thing the eye lands on.
  { slug: 'antique_estoc', ratio: 0.2, error: 0.004, texture: 512 },
  { slug: 'jug_01', ratio: 0.25, error: 0.005, texture: 512 },
  { slug: 'wooden_bucket_01', ratio: 0.3, error: 0.006, texture: 512 },
  { slug: 'modular_fort_01', ratio: 0.15, error: 0.01, texture: 1024 },

  { slug: 'treasure_chest', ratio: 0.3, error: 0.006, texture: 1024 },
  { slug: 'wooden_crate_01', ratio: 0.3, error: 0.008, texture: 512 },
  { slug: 'lambis_shell', ratio: 0.25, error: 0.008, texture: 512 },
];

const bytes = (n) =>
  n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;

async function main() {
  await MeshoptEncoder.ready;
  await MeshoptSimplifier.ready;

  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

  mkdirSync(OUT, { recursive: true });

  let inTotal = 0;
  let outTotal = 0;
  let built = 0;
  let failed = 0;

  for (const asset of ASSETS) {
    const source = join(MODELS, asset.slug, `${asset.slug}_1k.gltf`);
    const dest = join(OUT, `${asset.slug}.glb`);

    if (!existsSync(source)) {
      console.error(`  MISSING  ${asset.slug} — run: node scripts/fetch-assets.mjs`);
      failed += 1;
      continue;
    }
    if (existsSync(dest) && !FORCE) {
      console.log(`  skip     ${asset.slug}.glb (${bytes(statSync(dest).size)})`);
      outTotal += statSync(dest).size;
      continue;
    }

    try {
      const document = await io.read(source);
      const before = countTriangles(document);

      await document.transform(
        // Welding first is what makes decimation work at all: an unwelded mesh
        // has no shared edges, so every triangle is an island and the simplifier
        // has nothing to collapse.
        weld(),
        simplify({ simplifier: MeshoptSimplifier, ratio: asset.ratio, error: asset.error }),
        dedup(),
        textureCompress({ targetFormat: 'webp', resize: [asset.texture, asset.texture] }),
        // After decimation, whole primitives and their materials can end up
        // unreferenced. Pruning last means the earlier passes decide what is
        // dead rather than this one guessing.
        prune(),
      );

      const after = countTriangles(document);
      await io.write(dest, document);

      const sourceSize = directorySize(join(MODELS, asset.slug));
      const destSize = statSync(dest).size;
      inTotal += sourceSize;
      outTotal += destSize;
      built += 1;

      console.log(
        `  build    ${asset.slug}.glb  ` +
          `${bytes(sourceSize)} -> ${bytes(destSize)}  ` +
          `${before.toLocaleString('en-US')} -> ${after.toLocaleString('en-US')} tris`,
      );
    } catch (error) {
      console.error(`  ERROR    ${asset.slug}: ${error instanceof Error ? error.message : error}`);
      failed += 1;
    }
  }

  console.log('\nSummary');
  console.log(`  built    : ${built} file(s)`);
  if (inTotal > 0) console.log(`  source   : ${bytes(inTotal)}`);
  console.log(`  shipped  : ${bytes(outTotal)}`);
  if (failed > 0) {
    console.error(`  FAILED   : ${failed}`);
    process.exitCode = 1;
  }
}

function countTriangles(document) {
  let n = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices();
      const position = primitive.getAttribute('POSITION');
      const count = indices ? indices.getCount() : (position?.getCount() ?? 0);
      n += Math.floor(count / 3);
    }
  }
  return n;
}

function directorySize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? directorySize(path) : statSync(path).size;
  }
  return total;
}

await main();
