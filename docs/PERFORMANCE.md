# Performance

Two different things measure this project, and they answer different questions.

- **`npm run bench`** — `scripts/benchmark.mjs`. A headed, focused Chrome window
  with vsync off, real WebGPU timestamp queries, and hundreds of samples per
  configuration. This is the only source of performance truth here.
- **`npm test`** — the Playwright suite. Functional and regression assertions.
  It runs in automated Chromium, which paces `requestAnimationFrame`
  independently of load, so it cannot settle a frame budget and does not try to.

Everything in the Results section below comes from the benchmark. The raw run is
checked in at [`bench-results/reference.json`](../bench-results/reference.json).

## Running the benchmark

```bash
npm run bench
```

That is the whole thing: it type-checks and builds, starts a `vite preview`
server on a free port, launches Chrome, and measures the matrix. Nothing needs to
be running first, and it does not reuse a server it did not start — an earlier
version of this harness silently benchmarked a stale `dist/` that another process
had left on port 4173.

Useful variations:

```bash
node scripts/benchmark.mjs --only webgpu-high,webgl-low   # just the gated pair
node scripts/benchmark.mjs --frames 1200 --warmup 300     # longer sample
node scripts/benchmark.mjs --dpr 2                        # 3200 x 1800
node scripts/benchmark.mjs --help
```

The run exits non-zero unless **every gated configuration is a measured PASS**.
An UNVERIFIED gate is not a pass and does not exit zero.

Take the measurement with nothing else on the GPU, and do not click away from the
window: the harness checks `document.hasFocus()` and refuses to report a pass
from a background window.

## What the harness does that the test suite cannot

**It gets real GPU time.** Three.js only allocates a timestamp query pool when
the backend's `trackTimestamp` flag is set, and this project constructs its
renderer without it. The flag does not have to be set at construction, though:
`WebGPUBackend` requests its device with *every* feature the adapter advertises,
so `timestamp-query` is already enabled on the device, and the pool is built
lazily on the first instrumented render pass. The harness therefore sets
`renderer.backend.trackTimestamp = true` at runtime, before the first sampled
frame, and no change to `src/` is required. (`renderer.trackTimestamp` is *not*
the flag — assigning it creates a stray property and changes nothing. The
property lives on the backend.)

Each sampled frame issues ~110 render passes at High. `resolveTimestampsAsync`
returns the summed GPU duration of the most recent frame's passes; the pool holds
2048 queries, so it has to be resolved every frame regardless.

**It pins the world.** Before sampling, the harness calls the deterministic reset
hook: every clock is rewound and every accumulation buffer cleared, and the world
is settled at simulation time 0 before being stepped forward at a fixed 1/60 s.
Without this the sampled scene is wherever the session happened to drift to.
Measured, before this was added: two runs of the Max tier differed by 505 000
triangles and 2.4 ms of GPU time, because the ship had wandered far enough
between them to change what the 4096² shadow frustum contained. With it, repeat
runs of Max produce byte-identical triangle counts and GPU medians within 1 %.

**It knows when the frame boundary is.** The harness pauses the app's own loop
and drives one frame per rAF tick through `Loop.step`, which runs the identical
update and render path and *awaits* the render. Owning the frame boundary is what
makes the rest possible: draw-call counters can be read before three.js resets
them, and a frame's timestamps can be resolved knowing the pool contains that
frame's passes and nothing else.

**It refuses to lie.** A configuration is reported UNVERIFIED, never PASS and
never FAIL, if any of these hold — a harness problem is not a regression:

| Condition | Why it invalidates the number |
|---|---|
| No WebGPU adapter | there is nothing to measure |
| `isFallbackAdapter`, or adapter/ANGLE strings naming SwiftShader, llvmpipe, lavapipe or a basic renderer | software rasterisation |
| Timestamp queries unavailable, or never returning a usable duration | no GPU time, only a CPU upper bound |
| rAF throttling detected | the browser is pacing the page, not the renderer |
| Window not focused, or page not visible | background tabs are throttled and descheduled |
| Fewer than 200 samples | percentiles over a handful of frames are noise |
| The requested backend is not the one that booted | measuring something else |
| The quality tier drifted mid-sample | `AdaptiveQuality` changed the thing under test |
| The ship did not load | a frame cost without the hero object is not this project's frame cost |
| The deterministic reset failed | the sample is not reproducible, so it cannot be a regression baseline |
| `--headless` | headless pacing and GPU scheduling are not representative |

Throttling is detected by comparing the delivered rAF interval against the
*measured* frame cost, not against the app's own `loop.stats.frameMs`. The app
times its render call, and on WebGPU that call returns once the work is
submitted — in the reference run it reads 0.5 ms for a High frame that costs
2.89 ms on the GPU. Compare a 10.0 ms delivered interval against 0.5 ms and a
perfectly healthy 141 FPS run is classified as throttled.

### Chrome flags, and what they change

| Flag | Effect on the measurement |
|---|---|
| `--disable-gpu-vsync`, `--disable-frame-rate-limit` | rAF is not paced to the display refresh, so the delivered rate reflects the page rather than the monitor |
| `--disable-dawn-features=timestamp_quantization` | Chrome otherwise rounds every WebGPU timestamp to 100 µs. Rounding ~110 passes independently and then summing them puts several milliseconds of noise into the frame total — more than the gap between two quality tiers |
| `--enable-unsafe-webgpu`, `--enable-dawn-features=allow_unsafe_apis` | timestamp queries |
| `--enable-features=Vulkan` | matches the Playwright project configuration |

The full flag list is recorded in every results file, because each of them
changes what the numbers mean relative to a stock browser.

### Deliberate distortions

Both of these make the numbers slightly *cleaner* than the app achieves
unaided, and both are recorded in the output:

- Frames are stepped at a fixed 1/60 s rather than wall clock, so the simulation
  advances identically in every configuration.
- Resolving timestamps maps a buffer back every frame, which drains the pipeline
  between frames. GPU time is measured on the GPU and is unaffected; **CPU** frame
  time loses the overlap it would normally get with the previous frame's GPU work.

And one caveat on the reported delivered FPS: it is the rate at which the browser
delivered rAF callbacks during a three-second observation of the app's own loop,
which is an *upper bound* on presented frames rather than a count of them. It is
recorded to prove the browser was not throttling, and for nothing else. The
headline is GPU frame time.

## Recorded hardware

Detected by the browser at runtime, not read off the OS — this machine has two
GPUs and only the browser knows which one it bound.

| | |
|---|---|
| WebGPU adapter | vendor `nvidia`, architecture `blackwell` (Chrome blanks `device`/`description`) |
| ANGLE renderer | `ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 (0x00002B85) Direct3D11 vs_5_0 ps_5_0, D3D11)` |
| Driver | 32.0.16.1062 — OS-reported, for provenance only |
| Also present | AMD Radeon(TM) Graphics (integrated); not the adapter Chrome selected |
| CPU | AMD Ryzen 7 9800X3D, 16 threads |
| OS | Windows 11 Pro 10.0.26200 |
| Browser | Chrome 150.0.7871.187, headed, focused, driven by Playwright 1.62.1 |
| Resolution | 1600 × 900 @ DPR 1 |

## Budgets

| Configuration | Gate | Rationale |
|---|---|---|
| WebGPU, High | GPU p50 < 16.7 ms | the 60 FPS target desktop budget |
| WebGL2, Low | GPU p50 < 33.3 ms | the 30 FPS fallback floor |

Those two are the gates from the brief. Every other tier is measured against its
backend's budget as well, but a failure there is informational: `max` is
deliberately allowed to cost more than 60 FPS on hardware that is not this.

The gate is on GPU frame time rather than on delivered FPS deliberately. Frame
time is a property of the renderer; delivered FPS is a property of the renderer,
the compositor, the display and the browser's scheduling policy, and this project
has already been burned once by treating the second as if it were the first.

## Results

Run of 2026-08-01, `bench-results/reference.json`. Full scene — ocean, sky,
volumetric clouds, seafloor, ship, island, buoys, barrels, wake and the
post-processing chain — at 1600 × 900, DPR 1, `skyPro` preset, camera pinned to
the canonical wide shot, world reset to simulation time 0. **600 samples per
configuration** after 150 discarded warm-up frames.

GPU frame time, milliseconds, from timestamp queries:

| Configuration | p50 | p90 | p95 | p99 | min | max | implied FPS | Verdict |
|---|---|---|---|---|---|---|---|---|
| WebGPU · Low | 0.30 | 0.31 | 0.31 | 0.32 | 0.27 | 0.82 | 3344 | PASS |
| WebGPU · Medium | 1.45 | 1.49 | 1.50 | 1.98 | 1.38 | 2.54 | 691 | PASS |
| **WebGPU · High** | **2.55** | 2.82 | 3.04 | 3.96 | 2.44 | 5.06 | **392** | **PASS** |
| WebGPU · Ultra | 3.88 | 4.25 | 4.37 | 4.80 | 3.51 | 5.63 | 258 | PASS |
| WebGPU · Max | 5.96 | 7.95 | 8.24 | 8.52 | 5.41 | 8.63 | 168 | PASS |
| **WebGL2 · Low** | **1.73** | 2.40 | 2.66 | 3.13 | 0.62 | 4.02 | **579** | **PASS** |
| WebGL2 · High | 4.56 | 5.92 | 6.38 | 7.05 | 3.21 | 8.37 | 219 | PASS |

Scene cost and CPU frame time for the same runs:

| Configuration | CPU p50 | CPU p99 | Draw calls | Render passes | Triangles | Textures | Render targets | Programs | Texture bytes |
|---|---|---|---|---|---|---|---|---|---|
| WebGPU · Low | 0.7 | 2.2 | 49 | 37 | 332 306 | 58 | 15 | 43 | 344 MB |
| WebGPU · Medium | 1.4 | 3.2 | 96 | 70 | 596 450 | 67 | 22 | 51 | 353 MB |
| WebGPU · High | 3.4 | 42.1 | 140 | 114 | 891 726 | 74 | 28 | 55 | 393 MB |
| WebGPU · Ultra | 2.6 | 8.4 | 140 | 114 | 1 260 622 | 74 | 28 | 55 | 393 MB |
| WebGPU · Max | 2.8 | 9.3 | 152 | 126 | 1 949 146 | 74 | 28 | 55 | 546 MB |
| WebGL2 · Low | 0.8 | 1.5 | 49 | 37 | 332 306 | 58 | 15 | 43 | 344 MB |
| WebGL2 · High | 1.9 | 3.1 | 140 | 114 | 891 726 | 74 | 28 | 55 | 393 MB |

Reading these:

- **Both gates pass with a wide margin on this GPU.** WebGPU High costs 2.55 ms
  against a 16.7 ms budget — 5.8× headroom; WebGL2 Low costs 0.66 ms against
  33.3 ms. That is an RTX 5090 result and it should be read as one; see
  Limitations.
- **GPU time tracks the tier cleanly**, 0.26 → 1.32 → 2.89 → 4.10 → 6.25 ms, a 24×
  span. Whatever else is true of these numbers, they are responding to the thing
  the quality tiers change.
- **CPU frame time does not track the tier**, staying between 2.6 and 2.9 ms from
  Medium to Max. CPU cost here is JS update work plus command submission, both
  roughly tier-independent. The renderer is GPU-bound at every WebGPU tier, which
  is what the tier system is supposed to arrange.
- **Ultra costs 58 % more GPU time than High for 29 % more triangles and the same
  draw-call count.** Ultra raises mesh density and raymarch step counts, not
  texture resolution — hence identical texture bytes and render-target counts.
- **Max is the only tier that moves memory**, 323 → 476 MB of textures: 512² FFT
  cascades and a 4096² shadow map, for 12 extra render passes.
- **WebGL2 High costs 65 % more GPU time than WebGPU High** for an identical
  scene, and WebGL2 Low costs 3.6× WebGPU Low. That is the price of the fallback
  path, measured rather than assumed.
- **Distributions are tight from Medium up.** p99/p50 sits between 1.1 and 2.0
  with no long tail — no compilation stalls, no periodic hitch. The two Low
  configurations look noisier in relative terms (2.9–3.2) simply because a
  0.3 ms frame is near the floor of what this instrumentation resolves. Two
  outliers are worth naming rather than smoothing away: one 135 ms WebGL2 High
  frame — p99 is 7.4 ms, so it is exactly one frame in 600 — and a 33.5 ms CPU
  p99 at Max. Neither reproduced in a repeat run.

### Cross-check: the number responds to workload

A GPU timer that does not move with load is not measuring anything. WebGPU High
re-run at DPR 2 (3200 × 1800, four times the pixels) costs **6.76 ms** against
2.89 ms — 2.3×, which is what a mix of resolution-independent FFT passes and
fragment-bound surface shading should do. Reproduce with:

```bash
node scripts/benchmark.mjs --only webgpu-high --dpr 2
```

## Results file format

Every run writes `bench-results/bench-<timestamp>.json` and overwrites
`bench-results/latest.json`. Schema id `web-ocean-3d/bench@1`:

| Field | Contents |
|---|---|
| `schema`, `startedAt`, `finishedAt`, `durationMs`, `command`, `argv` | provenance |
| `host` | platform, OS release, CPU model, RAM, Node version |
| `osReportedGpus` | `Win32_VideoController` — driver versions, for provenance only |
| `browser` | channel, version, the full flag list, headless flag |
| `budgets`, `minSamples` | the thresholds this run was judged against |
| `configurations[]` | one entry per `{backend, tier, resolution, dpr}` |
| `summary` | pass/fail/unverified counts, plus per-gate verdicts and reasons |

Each `configurations[]` entry carries:

| Field | Contents |
|---|---|
| `id`, `gate`, `requestedBackend`, `backend`, `tier`, `preset`, `camera` | what was measured |
| `resolution`, `drawingBuffer` | requested size and DPR, and the buffer actually allocated |
| `adapter` | browser-reported WebGPU adapter, its feature list, `isFallbackAdapter` |
| `gl` | WebGL2 version and the unmasked ANGLE vendor/renderer strings |
| `focus` | `hasFocus`, `visibilityState` at the end of the sample |
| `gpuTiming` | whether timestamps were enabled, by what route, and any error |
| `pacing` | classification, delivered FPS, rAF interval percentiles, the app loop's own `frameMs` |
| `sampling` | warm-up and sample counts, GPU-sample count and misses, truncation flag, step size, deterministic-reset outcome, simulation time at the end of the sample |
| `cpuFrameMs`, `gpuFrameMs` | `{samples, min, p50, p90, p95, p99, max, mean}` |
| `fps` | delivered p50, and the rates implied by GPU p50 and CPU p50 |
| `render`, `memory` | `renderer.info.render` and `renderer.info.memory` snapshots |
| `sceneContent` | whether the ship loaded, and which binaries the harness served |
| `budget`, `verdict`, `reasons`, `consoleErrors` | the judgement and its evidence |

The schema is additive-stable: fields may be added at `@1`, and anything that
changes or removes a field bumps the id.

## Cost model

Where the frame goes, and the lever for each.

| Stage | Scales with | Lever |
|---|---|---|
| Spectrum evolution | `fftSize²` × cascades × 2 | quality tier |
| IFFT butterfly passes | `fftSize²` × log2(fftSize) × 2 × cascades × 2 | quality tier |
| Output assembly + mipmaps | `fftSize²` × cascades × 2 | quality tier |
| Ocean surface raster | `meshRings` × `meshSegments` triangles, then fragment cost at screen resolution | quality tier, pixel-ratio slider |
| Sky dome | one fullscreen-ish pass | negligible |
| Volumetric clouds | `cloudSteps` × screen pixels | `cloudSteps`, 0 disables |
| Underwater god rays | `godRaySteps` × screen pixels, only when submerged | `godRaySteps`, 0 disables |

At 256² with three cascades the transform runs 96 fullscreen passes per frame —
about 6.3 M trivial fragment invocations, against roughly 2 M for a single 1080p
raster pass. The transform is deliberately *not* the bottleneck; surface shading
is, which is why the quality tiers move mesh density and post effects more
aggressively than they move `fftSize`.

The measured render-pass counts agree: 36 passes at Low (one cascade), 113 at
High (three cascades at 256²), 125 at Max (three at 512²). The jump from High to
Max costs 2.4× the GPU time for 12 extra passes, so it is the 512² transform, the
denser surface mesh and the 4096² shadow map paying, not the pass count.

## Adaptive quality

`AdaptiveQuality` steps the tier down when the smoothed rate stays below 75 % of
target for 2.5 s. It is deliberately one-way within a session, with a 6 s
debounce and a 4 s startup grace period: oscillating between tiers is more
distracting than running one notch below optimal, and the first seconds of a
session are dominated by compilation rather than by steady-state cost.

It also has to be neutralised during a benchmark. It reads `loop.stats.fps`,
which `Loop.step` never writes, so on a slow configuration it would otherwise act
on a stale rAF-era number and change the tier *during* the sample. The harness
pins the value it watches, and then asserts afterwards that the tier did not
move — a drifted tier is an UNVERIFIED result, not a quiet one.

## Memory

The suite cycles Low↔High and asserts the renderer's texture and geometry counts
have not grown beyond a small allowance. Every tier change disposes the previous
FFT targets, surface material and ocean geometry before allocating replacements.

The benchmark records `renderer.info.memory` per configuration, so the tier cost
is visible directly: 273 MB of textures at Low, 323 MB at High and Ultra, 476 MB
at Max, with render-target counts of 14/27/27 respectively.

## Limitations, and what is still unverified

- **One machine.** Every number here is from an RTX 5090, and a 2.89 ms frame on
  that part says very little about a laptop iGPU. The budgets are *met*, not
  *stressed*: nothing in this run establishes where the tiers stop working. The
  harness is the deliverable; the numbers describe one host, which is why the
  hardware block above is as detailed as it is.
- **Adaptive downgrade is untested against real pressure.** On this GPU no tier
  gets close to the trigger, so the downgrade path has not been exercised by a
  genuine frame-rate drop here.
- **Delivered frame rate is not presented frame rate.** With vsync disabled the
  rAF callback rate runs ahead of what the compositor puts on screen — the WebGL2
  Low run reports 1000 delivered FPS, which is a main-thread spin rate, not 1000
  images. Only GPU frame time is treated as a measurement.
- **Timestamp quantisation is disabled by a flag.** These GPU numbers are not
  what a stock browser would report; a stock browser would report the same frames
  rounded to 100 µs per pass.
- **The camera is never underwater.** The canonical shot is above the waterline,
  so the submerged branch — god rays at full strength, the underwater particle
  system, which is skipped entirely while dry — contributes nothing to these
  numbers. A submerged benchmark configuration is the obvious next addition.
- **Environment quirk on this host: `.bin` responses return HTTP 204.** In a
  *headed* browser on this machine, every glTF binary payload served by
  `vite preview` arrives as `204, zero bytes`, while `curl` and the same Chrome
  build in headless mode both receive the full 200 from the same server and port.
  Something outside the browser is eating `application/octet-stream` on visible
  sessions. Untreated, `GLTFLoader` reports `Failed to load buffer`, the ship and
  props are absent, and the benchmark measures an empty ocean — 113 draw calls
  and 394 493 triangles at High instead of 138 and 633 229, which is a 38 % lie
  in the direction nobody notices. `scripts/benchmark.mjs` therefore fulfils those requests from
  `dist/` itself, records every interception in `sceneContent.binariesServedFromDisk`,
  and reports UNVERIFIED if the ship is missing anyway. This is an observation
  about this host, not a defect in the application — but it is exactly the kind
  of thing that turns a benchmark into fiction, so it is written down.

## Running the test suite: hardware matters

The Playwright suite is only fully meaningful on a machine with a real GPU
adapter.

Observed on a software-only runner (Playwright's bundled Chromium, no WebGPU
adapter, so WebGL2 backed by a software rasteriser): **9 failed, 6 passed,
1 skipped in 21.7 minutes**. Nearly every failure was a timeout, not an
assertion — a single frame of this scene through software rasterisation can take
tens of seconds, so anything that waits on rendering runs out of time.

Which is which:

- **Trustworthy anywhere** — the sea-state assertions (read straight off the GPU
  via `readRenderTargetPixelsAsync`), the WebGL fallback boot, and typecheck.
  These passed on the software runner.
- **Needs a GPU** — everything that waits on presented frames: screenshots,
  preset comparison and the interaction tests that poll after a state change.
  These time out on a software runner and their failure says nothing about the
  code.

Timeouts are set to 240 s to give a software runner a chance, but the honest
recommendation is to run on GPU hardware and treat a software-runner result as
inconclusive rather than as a regression. Frame budgets are not the suite's job
at all — that is `npm run bench`.
