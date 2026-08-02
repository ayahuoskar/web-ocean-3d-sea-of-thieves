#!/usr/bin/env node
/**
 * fetch-assets.mjs — reproducible asset downloader for web-ocean-3d.
 *
 * Downloads every third-party asset used by the demo into `public/`.
 * Every asset here is CC0 (Poly Haven, https://polyhaven.com/license) — see
 * ASSET_LICENSES.md at the repo root for the full per-file provenance table.
 *
 * Usage:
 *   node scripts/fetch-assets.mjs            # download anything missing, then verify
 *   node scripts/fetch-assets.mjs --force    # re-download everything
 *   node scripts/fetch-assets.mjs --verify   # verify on-disk files only, no network
 *
 * Idempotent: files that already exist with a non-zero size are skipped.
 * Exits non-zero if any download or verification step fails.
 *
 * No dependencies — Node built-ins only (global fetch, node:fs).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const API = 'https://api.polyhaven.com';

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const VERIFY_ONLY = args.has('--verify');

/**
 * The asset manifest. `slug` values were all verified against
 * https://api.polyhaven.com/assets?t=models and ?t=hdris before being added here.
 *
 * Texture resolution notes:
 *  - The ship is the hero object, so it gets 2k textures.
 *  - Props and rocks are background dressing at 1k to keep the payload small.
 *  - HDRIs are 2k .hdr (explicitly not 4k) so the environment loads fast.
 */
const MANIFEST = [
  // ---- Hero: sailing ship -------------------------------------------------
  {
    kind: 'model',
    slug: 'dutch_ship_medium',
    res: '2k',
    dir: 'models/dutch_ship_medium',
    note: 'Hero sailing ship',
  },

  // ---- Floating props -----------------------------------------------------
  { kind: 'model', slug: 'ocean_buoy', res: '1k', dir: 'models/ocean_buoy', note: 'Floating marine buoy' },
  { kind: 'model', slug: 'barrel_03', res: '1k', dir: 'models/barrel_03', note: 'Floating barrel' },

  // ---- Island silhouette --------------------------------------------------
  { kind: 'model', slug: 'rock_07', res: '1k', dir: 'models/rock_07', note: 'Standalone rock' },
  {
    kind: 'model',
    slug: 'namaqualand_cliff_01',
    res: '1k',
    dir: 'models/namaqualand_cliff_01',
    note: 'Cliff face for island silhouette',
  },

  // ---- Island and shore dressing -----------------------------------------
  //
  // These are the *source* downloads, not what ships. Poly Haven publishes film
  // -quality geometry — `island_tree_01` is a 58 MB `.bin` for a background tree —
  // so `scripts/optimize-assets.mjs` decimates and Meshopt-encodes them into
  // `public/models/dressing/*.glb`, and only those are committed. 177 MB of
  // source becomes 15 MB shipped.
  //
  // Almost all of these come from Poly Haven's `smugglers_cove` collection,
  // which is the same set the hero ship is from. That matters for more than
  // convenience: assets authored for one scene share a scale, a texel density
  // and a colour response, so they sit together without per-asset correction.
  // Mixing packs is how dressing ends up looking like dressing.
  //
  // 1k throughout. These are background geometry seen from tens of metres away;
  // the ship is the only thing that earns 2k.
  // Coastline. `coast_line_01/02` are the pieces that make a shore read as a
  // shore rather than as a hill meeting water: they are authored as *edges*,
  // with a wave-cut platform and a back slope, so they sit along a contour
  // instead of being another rock standing on one.
  { kind: 'model', slug: 'coast_line_01', res: '1k', dir: 'models/coast_line_01', note: 'Shoreline edge' },
  { kind: 'model', slug: 'coast_line_02', res: '1k', dir: 'models/coast_line_02', note: 'Shoreline edge' },
  { kind: 'model', slug: 'coast_land_rocks_03', res: '1k', dir: 'models/coast_land_rocks_03', note: 'Shore rock mass' },
  // A second cliff form, because six copies of one silhouette standing in a row
  // is what made the island's back read as a stage flat.
  { kind: 'model', slug: 'coastal_cliff_04', res: '1k', dir: 'models/coastal_cliff_04', note: 'Island cliff face' },
  { kind: 'model', slug: 'coast_rocks_01', res: '1k', dir: 'models/coast_rocks_01', note: 'Shore rock cluster' },
  { kind: 'model', slug: 'coast_rocks_03', res: '1k', dir: 'models/coast_rocks_03', note: 'Shore rock cluster' },
  { kind: 'model', slug: 'coastal_cliff_02', res: '1k', dir: 'models/coastal_cliff_02', note: 'Island cliff face' },
  { kind: 'model', slug: 'sand_rocks_small_01', res: '1k', dir: 'models/sand_rocks_small_01', note: 'Small shore rocks' },

  { kind: 'model', slug: 'island_tree_01', res: '1k', dir: 'models/island_tree_01', note: 'Island tree' },
  { kind: 'model', slug: 'pachira_aquatica_01', res: '1k', dir: 'models/pachira_aquatica_01', note: 'Tropical tree' },
  { kind: 'model', slug: 'fern_02', res: '1k', dir: 'models/fern_02', note: 'Undergrowth' },
  { kind: 'model', slug: 'shrub_sorrel_01', res: '1k', dir: 'models/shrub_sorrel_01', note: 'Undergrowth' },
  { kind: 'model', slug: 'grass_bermuda_01', res: '1k', dir: 'models/grass_bermuda_01', note: 'Grass tuft' },

  // ---- Tropical planting ---------------------------------------------------
  //
  // Poly Haven has no coconut palm, and there is no point pretending otherwise:
  // the tropical read comes from broadleaf shapes and density rather than from
  // the one silhouette everyone associates with it. `pachira_aquatica` above is
  // the closest tree they publish; these two are genuine tropical understorey
  // from the same cove collection.
  { kind: 'model', slug: 'anthurium_botany_01', res: '1k', dir: 'models/anthurium_botany_01', note: 'Tropical broadleaf' },
  { kind: 'model', slug: 'calathea_orbifolia_01', res: '1k', dir: 'models/calathea_orbifolia_01', note: 'Tropical broadleaf' },
  // Three more canopy forms. Nine copies of one tree is not a wood, however
  // many of them there are — the eye finds the repeat long before it runs out
  // of trees, and a grove needs different silhouettes more than it needs more
  // instances. `jacaranda` is the broadest crown Poly Haven publishes, which is
  // what a tropical canopy is mostly made of.
  { kind: 'model', slug: 'island_tree_02', res: '1k', dir: 'models/island_tree_02', note: 'Island tree' },
  { kind: 'model', slug: 'island_tree_03', res: '1k', dir: 'models/island_tree_03', note: 'Island tree' },
  { kind: 'model', slug: 'jacaranda_tree', res: '1k', dir: 'models/jacaranda_tree', note: 'Broad canopy tree' },

  // ---- Pirate cove ---------------------------------------------------------
  //
  // All from `smugglers_cove`, which is what the collection is: the hero ship's
  // own set, so the pier, the cannon and the barrels share its scale, wood tone
  // and wear. That coherence is the whole reason to take dressing from one pack.
  { kind: 'model', slug: 'ship_pinnace', res: '1k', dir: 'models/ship_pinnace', note: "Ship's boat, beached" },
  { kind: 'model', slug: 'modular_wooden_pier', res: '1k', dir: 'models/modular_wooden_pier', note: 'Jetty on the island' },
  { kind: 'model', slug: 'cannon_01', res: '1k', dir: 'models/cannon_01', note: 'Shore battery' },
  { kind: 'model', slug: 'wooden_barrels_01', res: '1k', dir: 'models/wooden_barrels_01', note: 'Barrel stack' },
  { kind: 'model', slug: 'wooden_lantern_01', res: '1k', dir: 'models/wooden_lantern_01', note: 'Lantern on the pier' },
  { kind: 'model', slug: 'wooden_crate_02', res: '1k', dir: 'models/wooden_crate_02', note: 'Cargo crate' },

  // ---- Pirate remains ------------------------------------------------------
  //
  // A wreck site tells a story or it is litter, and the story needs objects a
  // person left behind rather than objects that washed up. Poly Haven has no
  // skeleton — that one is built procedurally, see `src/scene/Remains.ts`.
  { kind: 'model', slug: 'antique_estoc', res: '1k', dir: 'models/antique_estoc', note: 'Sword, half-buried' },
  { kind: 'model', slug: 'jug_01', res: '1k', dir: 'models/jug_01', note: 'Bottle / jug' },
  { kind: 'model', slug: 'wooden_bucket_01', res: '1k', dir: 'models/wooden_bucket_01', note: 'Bucket' },
  // A ruin gives the island a landmark and a reason for the cannon to be where
  // it is. Modular in the source; one section is enough.
  { kind: 'model', slug: 'modular_fort_01', res: '1k', dir: 'models/modular_fort_01', note: 'Ruined shore fort' },

  // ---- Underwater find ----------------------------------------------------
  { kind: 'model', slug: 'treasure_chest', res: '1k', dir: 'models/treasure_chest', note: 'Sunken treasure chest' },
  { kind: 'model', slug: 'wooden_crate_01', res: '1k', dir: 'models/wooden_crate_01', note: 'Sunken crate' },
  { kind: 'model', slug: 'lambis_shell', res: '1k', dir: 'models/lambis_shell', note: 'Shell on the seabed' },

  // ---- Environment maps (day / sunset / foggy / moonlit) ------------------
  { kind: 'hdri', slug: 'kloofendal_43d_clear_puresky', res: '2k', dir: 'hdris', note: 'Preset: day' },
  { kind: 'hdri', slug: 'industrial_sunset_puresky', res: '2k', dir: 'hdris', note: 'Preset: sunset' },
  { kind: 'hdri', slug: 'kloofendal_misty_morning_puresky', res: '2k', dir: 'hdris', note: 'Preset: foggy / overcast' },
  { kind: 'hdri', slug: 'satara_night_no_lamps', res: '2k', dir: 'hdris', note: 'Preset: moonlit night' },
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const bytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
};

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`  ERROR  ${msg}`);
};

async function getJson(url, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'web-ocean-3d-asset-fetcher' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
  throw new Error(`GET ${url} failed after ${attempts} attempts: ${lastErr.message}`);
}

async function download(url, destPath, expected = {}, attempts = 3) {
  mkdirSync(dirname(destPath), { recursive: true });
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'web-ocean-3d-asset-fetcher' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error('empty response body');
      if (expected.size && buf.length !== expected.size) {
        throw new Error(`size mismatch: got ${buf.length}, expected ${expected.size}`);
      }
      if (expected.md5) {
        const got = createHash('md5').update(buf).digest('hex');
        if (got !== expected.md5) throw new Error(`md5 mismatch: got ${got}, expected ${expected.md5}`);
      }
      writeFileSync(destPath, buf);
      return buf.length;
    } catch (err) {
      lastErr = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
  throw new Error(`download ${url} failed after ${attempts} attempts: ${lastErr.message}`);
}

/** Resolve one manifest entry into a flat list of { url, rel, size, md5 }. */
async function plan(entry) {
  const files = await getJson(`${API}/files/${entry.slug}`);

  if (entry.kind === 'hdri') {
    const node = files?.hdri?.[entry.res]?.hdr;
    if (!node?.url) throw new Error(`${entry.slug}: no hdri/${entry.res}/hdr in API response`);
    const name = posix.basename(new URL(node.url).pathname);
    return [{ url: node.url, rel: `${entry.dir}/${name}`, size: node.size, md5: node.md5 }];
  }

  const node = files?.gltf?.[entry.res]?.gltf;
  if (!node?.url) throw new Error(`${entry.slug}: no gltf/${entry.res}/gltf in API response`);

  const out = [];
  const gltfName = posix.basename(new URL(node.url).pathname);
  out.push({ url: node.url, rel: `${entry.dir}/${gltfName}`, size: node.size, md5: node.md5 });

  // `include` maps a path *relative to the .gltf* -> the file to fetch.
  // Keeping these relative paths intact is what makes the .gltf resolvable.
  for (const [relPath, info] of Object.entries(node.include ?? {})) {
    out.push({ url: info.url, rel: `${entry.dir}/${relPath}`, size: info.size, md5: info.md5 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

const MIN_SIZE = 256; // anything smaller than this is an error page, not an asset

/** Sanity-check a file on disk by extension. Returns null if OK, else a reason. */
function verifyFile(absPath) {
  if (!existsSync(absPath)) return 'missing';
  const size = statSync(absPath).size;
  if (size === 0) return 'zero bytes';
  if (size < MIN_SIZE) return `implausibly small (${size} B)`;

  const lower = absPath.toLowerCase();

  if (lower.endsWith('.glb')) {
    const head = readFileSync(absPath).subarray(0, 12);
    const magic = head.subarray(0, 4).toString('ascii');
    if (magic !== 'glTF') return `bad GLB magic: ${JSON.stringify(magic)}`;
    const declared = head.readUInt32LE(8);
    if (declared !== size) return `GLB length header ${declared} != file size ${size}`;
    return null;
  }

  if (lower.endsWith('.gltf')) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(absPath, 'utf8'));
    } catch (err) {
      return `not valid JSON: ${err.message}`;
    }
    if (!doc.asset?.version) return 'glTF JSON has no asset.version';
    if (!Array.isArray(doc.meshes) || doc.meshes.length === 0) return 'glTF JSON has no meshes';
    // Every buffer/image URI referenced by the .gltf must exist next to it.
    const base = dirname(absPath);
    const uris = [
      ...(doc.buffers ?? []).map((b) => b.uri),
      ...(doc.images ?? []).map((i) => i.uri),
    ].filter((u) => u && !u.startsWith('data:'));
    for (const uri of uris) {
      const target = join(base, decodeURIComponent(uri));
      if (!existsSync(target) || statSync(target).size === 0) return `referenced file missing: ${uri}`;
    }
    return null;
  }

  if (lower.endsWith('.hdr')) {
    const head = readFileSync(absPath).subarray(0, 10).toString('ascii');
    if (!head.startsWith('#?RADIANCE') && !head.startsWith('#?RGBE')) {
      return `bad Radiance HDR signature: ${JSON.stringify(head)}`;
    }
    return null;
  }

  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    const head = readFileSync(absPath).subarray(0, 3);
    if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) return 'bad JPEG SOI marker';
    return null;
  }

  if (lower.endsWith('.png')) {
    const head = readFileSync(absPath).subarray(0, 8).toString('hex');
    if (head !== '89504e470d0a1a0a') return 'bad PNG signature';
    return null;
  }

  if (lower.endsWith('.bin')) return null; // opaque buffer; size check above is all we can do

  return null;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(PUBLIC_DIR, { recursive: true });

  console.log(`web-ocean-3d asset fetcher`);
  console.log(`  destination: ${PUBLIC_DIR}`);
  console.log(`  mode:        ${VERIFY_ONLY ? 'verify only' : FORCE ? 'force re-download' : 'incremental'}`);
  console.log('');

  /** @type {string[]} every relative path we expect to exist afterwards */
  const allRel = [];
  let downloadedBytes = 0;
  let downloadedCount = 0;
  let skippedCount = 0;

  for (const entry of MANIFEST) {
    console.log(`[${entry.kind}] ${entry.slug} @ ${entry.res} — ${entry.note}`);

    let items;
    if (VERIFY_ONLY) {
      // Without network, fall back to whatever is on disk under the target dir.
      console.log('  (verify-only: skipping API lookup)');
      items = null;
    } else {
      try {
        items = await plan(entry);
      } catch (err) {
        fail(`${entry.slug}: ${err.message}`);
        continue;
      }
    }

    if (!items) continue;

    for (const item of items) {
      const abs = join(PUBLIC_DIR, item.rel);
      allRel.push(item.rel);

      // Idempotency: skip files already on disk. The API gives us an expected
      // size, so we also use it to detect truncated/corrupt files and re-fetch
      // them rather than skipping a broken asset forever.
      if (!FORCE && existsSync(abs)) {
        const onDisk = statSync(abs).size;
        if (onDisk > 0 && (!item.size || onDisk === item.size)) {
          skippedCount += 1;
          console.log(`  skip     ${item.rel} (${bytes(onDisk)})`);
          continue;
        }
        console.log(`  stale    ${item.rel} (${bytes(onDisk)}, expected ${bytes(item.size)}) — refetching`);
      }

      try {
        const n = await download(item.url, abs, { size: item.size, md5: item.md5 });
        downloadedBytes += n;
        downloadedCount += 1;
        console.log(`  get      ${item.rel} (${bytes(n)})`);
      } catch (err) {
        fail(`${item.rel}: ${err.message}`);
      }
    }
    console.log('');
  }

  // -- verification pass ----------------------------------------------------
  console.log('Verifying files on disk...');
  const toCheck = allRel.length ? allRel : listAllUnder(PUBLIC_DIR);
  let okCount = 0;
  let totalBytes = 0;
  for (const rel of toCheck) {
    const abs = join(PUBLIC_DIR, rel);
    const reason = verifyFile(abs);
    if (reason) {
      fail(`verify ${rel}: ${reason}`);
    } else {
      okCount += 1;
      totalBytes += statSync(abs).size;
    }
  }

  console.log('');
  console.log('Summary');
  console.log(`  downloaded : ${downloadedCount} file(s), ${bytes(downloadedBytes)}`);
  console.log(`  skipped    : ${skippedCount} file(s) already present`);
  console.log(`  verified   : ${okCount}/${toCheck.length} file(s) OK`);
  console.log(`  total size : ${bytes(totalBytes)} (${totalBytes} bytes)`);

  if (failures > 0) {
    console.error(`\n${failures} problem(s). See ERROR lines above.`);
    process.exitCode = 1;
    return;
  }
  console.log('\nAll assets present and verified.');
}

/**
 * Recursively list asset files under `dir`, as paths relative to `dir`.
 * Dotfiles (e.g. the `.gitattributes` that keeps git from mangling these binaries)
 * are not assets and are excluded from the count and the size total.
 */
function listAllUnder(dir, prefix = '') {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...listAllUnder(join(dir, ent.name), rel));
    else out.push(rel);
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
