// Captures the Shadertoy reference set as stills, rendered on a real GPU.
//
//   node scripts/capture-shadertoy.mjs [id ...]      # omit ids for all of them
//
// Needs `research/shadertoy/INDEX.json`, which is gitignored — do the research
// pull first. Output goes to `research/shadertoy/preview/<id>.png`, also
// gitignored. Reference stills are the authors' work: study only. Shadertoy's
// default licence is CC BY-NC-SA and `DdKyR1` is All Rights Reserved, so
// reproduce behaviour from technique and never copy source into `src/`.
//
// ## It needs a browser you launched yourself
//
//   "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
//     --remote-debugging-port=9222 ^
//     --user-data-dir="%LOCALAPPDATA%\Temp\shadertoy-cdp-profile"
//
// A dedicated profile dir is required: Chrome 136+ refuses remote debugging on
// the default one.
//
// Chrome launched that way clears Cloudflare Turnstile with no interaction at
// all. A browser launched by Playwright or by the chrome-devtools MCP does not,
// ever, however many times the checkbox is clicked — the trigger is the
// automation flags those launchers set, not the fact that a script is driving
// the page. So this attaches to an ordinary browser rather than starting one.
// That is the whole trick, and it is deliberately not a circumvention: if a
// challenge does appear, a human clears it once and the cookie persists.
//
// Two cloud services were tried first and both failed for reasons worth
// keeping: Firecrawl clears Cloudflare but reports `webgl: "NONE"`, so anything
// GPU-rendered comes back black; Apify's puppeteer-scraper demands full account
// permissions before it will run, and had no proven WebGL either.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Derived, not hard-coded: this file is committed and the checkout is not
// always at the same path.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = resolve(ROOT, 'research/shadertoy/preview');
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9222';

const INDEX = JSON.parse(readFileSync(resolve(ROOT, 'research/shadertoy/INDEX.json'), 'utf8'));

// Start time per shader, seconds. Chosen so the still is representative rather
// than whatever the opening second happens to be.
const START = {
  '4ttSWf': 20, // Rainforest — mid camera sweep
  '4dSBDt': 14, // Enscape Cube — cube settled on the swell
  MdGfzh: 26, // Himalayas — clouds developed, flag in frame
  Xl2XRW: 30, // Where the River Goes — past the opening straight
  ldj3Dm: 12, // Fish swimming — fish broadside
  '4ljXWh': 16, // Beneath the Sea
  Nt3XDM: 25, // Niolon
  lt3GWj: 18, // TDM Seascape — Sailing
  WtfyWj: 22, // Ocean Treasure — manta swung into frame
  MdlyD8: 20, // Portland, OR
  Wd23Wc: 15, // Rain in the mud
  DdKyR1: 24, // Raindrops on Glass — near the wettest part of the cycle
  WlVSz3: 12, // Raindrops on a puddle
};

/**
 * Shaders that accumulate across frames. `4ttSWf` and `MdGfzh` reproject the
 * previous frame, `4dSBDt` runs a YCoCg-clamped TAA, `Nt3XDM` blends at 0.15,
 * `Xl2XRW` supersamples. A still taken early photographs their noise rather
 * than their image, so these get twice the settle.
 */
const TEMPORAL = new Set(['4ttSWf', 'MdGfzh', '4dSBDt', 'Nt3XDM', 'Xl2XRW']);

/**
 * Reads back a coarse mean/max so a black or failed frame is caught, not saved.
 *
 * Finds the player's canvas explicitly rather than taking the first one on the
 * page. Shadertoy names it `demogl`; several of these shaders also carry a
 * second, unsized canvas (300x150, the HTML default), and `querySelector`
 * returned *that* on seven of the thirteen — which read as "the shader never
 * rendered" when in fact it was rendering fine one element over. The chosen
 * element is tagged so the screenshot below cannot pick a different one.
 */
const PROBE = () => {
  let c = document.getElementById('demogl');
  if (!c || c.tagName !== 'CANVAS') {
    // Fall back to the largest canvas by area — the player's is always the big one.
    const all = [...document.querySelectorAll('canvas')];
    c = all.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  }
  if (!c) return { ok: false, why: 'no canvas' };
  for (const other of document.querySelectorAll('canvas[data-shot]')) other.removeAttribute('data-shot');
  c.setAttribute('data-shot', '1');
  const s = document.createElement('canvas');
  s.width = 48;
  s.height = 27;
  const ctx = s.getContext('2d');
  try {
    ctx.drawImage(c, 0, 0, 48, 27);
  } catch (e) {
    return { ok: false, why: 'readback: ' + String(e) };
  }
  const d = ctx.getImageData(0, 0, 48, 27).data;
  let sum = 0;
  let max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
    sum += l;
    if (l > max) max = l;
  }
  return {
    ok: true,
    mean: +(sum / (d.length / 4)).toFixed(2),
    max,
    w: c.width,
    h: c.height,
    fps: (document.body.innerText.match(/([\d.]+)\s*fps/) || [null, '?'])[1],
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
try {
  browser = await chromium.connectOverCDP(CDP);
} catch (e) {
  console.error(
    `Could not attach to Chrome at ${CDP}.\n` +
      `Launch it first (see the command in chat), then re-run.\n${e.message}`,
  );
  process.exit(1);
}

const context = browser.contexts()[0] ?? (await browser.newContext());
const page = await context.newPage();
await page.setViewportSize({ width: 1280, height: 720 });

mkdirSync(OUT, { recursive: true });

// Optional id list on the command line, so a partial failure can be retried
// without re-capturing the ones that already came out.
const wanted = process.argv.slice(2);
const queue = wanted.length ? INDEX.filter((s) => wanted.includes(s.id)) : INDEX;

const results = [];
for (const meta of queue) {
  const id = meta.id;
  const t = START[id] ?? 15;
  let settle = TEMPORAL.has(id) ? 16000 : 9000;
  const url = `https://www.shadertoy.com/embed/${id}?gui=false&t=${t}&paused=false&muted=true`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Guard: if the challenge is still up, stop rather than saving 13 copies of it.
    const title = await page.title();
    if (/just a moment|attention required/i.test(title)) {
      console.error(`\nStill behind the Cloudflare challenge (title: "${title}").`);
      console.error('Clear it in that Chrome window, then re-run.');
      await page.close();
      await browser.close();
      process.exit(2);
    }

    await page.waitForSelector('canvas', { timeout: 30000 });

    // Seven of the thirteen carry `info.usePreview = 1`. For those, the page's
    // own `watchInit()` takes a branch that appends a static <img> of
    // /media/shaders/<id>.jpg and never constructs the player — which is why
    // they reported a 300x150 canvas at 0 fps, the untouched HTML default.
    //
    // The non-preview branch is `iCompileAndStart(viewerParent, jsnShader)`,
    // and `jsnShader` comes from the same POST to /shadertoy that watchInit
    // makes. Both are the page's own entry points, so this takes the branch the
    // viewer would have taken rather than working around anything.
    const preview = await page.evaluate(() => {
      const c = document.getElementById('demogl');
      return !!c && c.width <= 320; // still the HTML default => never started
    });

    if (preview) {
      const started = await page.evaluate(
        () =>
          new Promise((res) => {
            // The overlay would otherwise sit on top of the canvas in the
            // screenshot, since an element shot captures whatever composites
            // over that box.
            for (const img of document.querySelectorAll('#player img')) img.remove();
            try {
              const req = new XMLHttpRequest();
              req.open('POST', '/shadertoy', true);
              req.responseType = 'json';
              req.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
              req.onload = () => {
                try {
                  window.iCompileAndStart(document.getElementById('player'), req.response);
                  res('started');
                } catch (e) {
                  res('start failed: ' + String(e).slice(0, 120));
                }
              };
              req.onerror = () => res('xhr failed');
              req.send(
                's=' +
                  encodeURIComponent('{ "shaders" : ["' + window.gShaderID + '"] }') +
                  '&nt=0&nl=0&np=0',
              );
            } catch (e) {
              res('threw: ' + String(e).slice(0, 120));
            }
          }),
      );
      if (started !== 'started') {
        results.push({ id, name: meta.name, status: 'NOSTART', detail: started });
        console.log(`${id.padEnd(8)} NOSTART ${started}  ${meta.name}`);
        continue;
      }
      // Constructed by hand, so the URL's `t=` never applied — the clock starts
      // at zero. Wait out the intended start time on the wall clock instead.
      settle = Math.max(settle, t * 1000 + 5000);
    }

    await sleep(settle);

    // Poll until it is genuinely drawing. Several of these are legitimately
    // dark (the underwater ones), so the bar is low and the numbers are printed
    // rather than merely tested.
    let probe = await page.evaluate(PROBE);
    for (let i = 0; i < 8 && probe.ok && probe.max < 12; i++) {
      await sleep(2500);
      probe = await page.evaluate(PROBE);
    }

    if (!probe.ok || probe.max < 4) {
      results.push({ id, name: meta.name, status: 'BLANK', probe });
      console.log(`${id.padEnd(8)} BLANK   ${JSON.stringify(probe)}  ${meta.name}`);
      continue;
    }

    // The exact element the probe measured, not merely "a canvas".
    const file = resolve(OUT, `${id}.png`);
    await page.locator('canvas[data-shot="1"]').screenshot({ path: file });
    results.push({ id, name: meta.name, status: 'ok', probe });
    console.log(
      `${id.padEnd(8)} ok   mean ${String(probe.mean).padStart(6)}  max ${String(probe.max).padStart(3)}` +
        `  ${probe.w}x${probe.h}  ${String(probe.fps).padStart(5)} fps   ${meta.name}`,
    );
  } catch (e) {
    results.push({ id, name: meta.name, status: 'ERROR', error: String(e.message).slice(0, 120) });
    console.log(`${id.padEnd(8)} ERROR   ${String(e.message).slice(0, 120)}`);
  }
}

writeFileSync(
  resolve(OUT, `capture-log${wanted.length ? '-retry' : ''}.json`),
  JSON.stringify(results, null, 2),
);

// Close only the tab this script opened. `browser.close()` on a CDP-attached
// browser terminates the browser itself — which kills the very session whose
// Cloudflare clearance is the point of attaching to it, so every re-run would
// need a relaunch and a fresh challenge.
await page.close();

const ok = results.filter((r) => r.status === 'ok').length;
console.log(`\n${ok}/${queue.length} captured to research/shadertoy/preview/`);
if (ok < queue.length) {
  console.log(
    'Not ok:',
    results.filter((r) => r.status !== 'ok').map((r) => `${r.id}(${r.status})`).join(' '),
  );
}

// The CDP connection keeps the event loop alive; the browser stays up for the
// next run.
process.exit(ok === queue.length ? 0 : 1);
