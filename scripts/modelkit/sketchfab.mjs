#!/usr/bin/env node
/**
 * sketchfab.mjs — search, inspect and fetch Sketchfab models.
 *
 * Exists because this project needed marine life and island planting that no CC0
 * source publishes: Poly Haven has no coral, no sea fan, no anemone, no fish and
 * no coconut palm, and all 521 of their models were checked before concluding
 * that. Sketchfab has all of it, behind an authenticated download API.
 *
 * **It will only ever fetch CC0 or CC-BY.** That is not a preference — this
 * repository redistributes its assets, and Sketchfab's "Standard" licence does
 * not permit that. `get` refuses anything else and `info` prints the licence
 * first, because the licence is the thing that decides whether the rest of the
 * evaluation is worth doing. Search is filtered to the same two licences for the
 * same reason: there is no point looking at models that cannot be used.
 *
 * A token is needed for `get` and `info`, in `SKETCHFAB_API_TOKEN` or a
 * git-ignored `sketchfab-token` file at the repository root. Get one from
 * https://sketchfab.com/settings/password. Search works without it.
 *
 * Usage:
 *   node scripts/modelkit/sketchfab.mjs search "coral reef" [--animated] [--max-faces N]
 *   node scripts/modelkit/sketchfab.mjs info <uid>
 *   node scripts/modelkit/sketchfab.mjs get <uid> <name>
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREVIEW_DIR = join(ROOT, 'public', 'models', '_preview');
const API = 'https://api.sketchfab.com/v3';

/** The only licences this repository can ship. */
const ALLOWED = new Set(['CC0 Public Domain', 'CC Attribution']);

function token() {
  const fromEnv = process.env.SKETCHFAB_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const file = join(ROOT, 'sketchfab-token');
  if (!existsSync(file)) return null;
  const fromFile = readFileSync(file, 'utf8').trim();
  return fromFile.length > 0 ? fromFile : null;
}

function authHeaders() {
  const t = token();
  if (!t) {
    console.error(
      'No Sketchfab token. Put one in SKETCHFAB_API_TOKEN or ./sketchfab-token\n' +
        '(https://sketchfab.com/settings/password). Search works without one.',
    );
    process.exit(1);
  }
  return { Authorization: `Token ${t}`, 'user-agent': 'web-ocean-3d-modelkit' };
}

async function search(query, options) {
  // The licence filter takes one value per request, so the two allowed licences
  // are two searches merged rather than one query.
  const rows = [];
  for (const licence of ['cc0', 'by']) {
    const url = new URL(`${API}/search`);
    url.searchParams.set('type', 'models');
    url.searchParams.set('downloadable', 'true');
    url.searchParams.set('license', licence);
    url.searchParams.set('q', query);
    url.searchParams.set('count', '24');
    url.searchParams.set('sort_by', '-likeCount');
    if (options.animated) url.searchParams.set('animated', 'true');

    const response = await fetch(url, { headers: { 'user-agent': 'web-ocean-3d-modelkit' } });
    if (!response.ok) {
      console.error(`search failed: HTTP ${response.status}`);
      continue;
    }
    const body = await response.json();
    rows.push(...(body.results ?? []));
  }

  rows.sort((a, b) => b.likeCount - a.likeCount);
  const shown = rows.filter((m) => !options.maxFaces || m.faceCount <= options.maxFaces);

  if (shown.length === 0) {
    console.log('nothing downloadable under CC0 or CC-BY for that query.');
    return;
  }
  for (const m of shown.slice(0, 24)) {
    console.log(
      `${m.uid}  ${String(m.faceCount).padStart(8)}f  anim=${m.animationCount}  ` +
        `${String('♥' + m.likeCount).padStart(6)}  [${m.license?.label}]  ${m.name} — ${m.user?.displayName ?? m.user?.username}`,
    );
  }
  console.log(`\n${shown.length} result(s). Next: info <uid>, then get <uid> <name>.`);
}

async function info(uid) {
  const meta = await (await fetch(`${API}/models/${uid}`, { headers: authHeaders() })).json();
  const licence = meta.license?.label ?? '(unknown)';
  console.log(`name        : ${meta.name}`);
  console.log(`licence     : ${licence}${ALLOWED.has(licence) ? '' : '   <== CANNOT SHIP THIS'}`);
  console.log(`author      : ${meta.user?.displayName ?? meta.user?.username}  ${meta.user?.profileUrl ?? ''}`);
  console.log(`faces       : ${meta.faceCount?.toLocaleString('en-US')}  verts: ${meta.vertexCount?.toLocaleString('en-US')}`);
  console.log(`animations  : ${meta.animationCount}`);
  console.log(`downloadable: ${meta.isDownloadable}`);
  console.log(`page        : ${meta.viewerUrl}`);
  if (!ALLOWED.has(licence)) {
    console.log('\nRefusing further use: only CC0 and CC-BY may be committed here.');
    console.log('See the Policy section of ASSET_LICENSES.md.');
  }
}

async function get(uid, name) {
  const headers = authHeaders();
  const meta = await (await fetch(`${API}/models/${uid}`, { headers })).json();
  const licence = meta.license?.label ?? '(unknown)';

  if (!ALLOWED.has(licence)) {
    console.error(`refusing "${meta.name}": licence is "${licence}".`);
    console.error('Only CC0 and CC-BY may be committed here — see ASSET_LICENSES.md.');
    process.exit(1);
  }
  if (!meta.isDownloadable) {
    console.error(`"${meta.name}" is not downloadable through the API.`);
    process.exit(1);
  }

  const links = await (await fetch(`${API}/models/${uid}/download`, { headers })).json();
  // `glb` comes back as a bare .glb; `gltf` is a zip, and nothing here reads zips.
  if (!links?.glb?.url) {
    console.error('no glb download link in the API response.');
    process.exit(1);
  }

  mkdirSync(PREVIEW_DIR, { recursive: true });
  const dest = join(PREVIEW_DIR, `${name}.glb`);
  const buffer = Buffer.from(await (await fetch(links.glb.url)).arrayBuffer());
  writeFileSync(dest, buffer);

  console.log(`saved ${dest}  ${(buffer.length / 1048576).toFixed(1)} MB`);
  console.log(`  "${meta.name}" by ${meta.user?.displayName ?? meta.user?.username}  [${licence}]`);
  console.log(`  ${meta.viewerUrl}`);
  console.log(`\nLook at it:  http://127.0.0.1:5173/scripts/modelkit/viewer.html`);
  console.log(`             await loadModel('/models/_preview/${name}.glb')`);
  console.log(`Check it:    node scripts/modelkit/shells.mjs public/models/_preview/${name}.glb`);
  if (licence === 'CC Attribution') {
    console.log(`\nCC-BY: if this ships, its credit is a licence condition. Record it in`);
    console.log(`ASSET_LICENSES.md and add it to the SKETCHFAB manifest in fetch-assets.mjs.`);
  }
}

const [command, ...rest] = process.argv.slice(2);

if (command === 'search') {
  const query = rest.filter((a) => !a.startsWith('--')).join(' ');
  if (!query) {
    console.error('usage: sketchfab.mjs search "<query>" [--animated] [--max-faces N]');
    process.exit(1);
  }
  const maxFacesArg = rest.indexOf('--max-faces');
  await search(query, {
    animated: rest.includes('--animated'),
    maxFaces: maxFacesArg >= 0 ? Number(rest[maxFacesArg + 1]) : 0,
  });
} else if (command === 'info') {
  if (!rest[0]) {
    console.error('usage: sketchfab.mjs info <uid>');
    process.exit(1);
  }
  await info(rest[0]);
} else if (command === 'get') {
  if (!rest[0] || !rest[1]) {
    console.error('usage: sketchfab.mjs get <uid> <name>');
    process.exit(1);
  }
  await get(rest[0], rest[1]);
} else {
  console.error('usage: sketchfab.mjs <search|info|get> ...');
  console.error('  search "coral reef" [--animated] [--max-faces N]');
  console.error('  info <uid>');
  console.error('  get <uid> <name>');
  process.exit(1);
}
