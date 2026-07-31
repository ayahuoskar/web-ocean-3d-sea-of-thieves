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
