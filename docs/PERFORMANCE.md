# Performance

## Method

All figures come from the assertions in `tests/ocean.spec.ts` and the helpers in
`tests/helpers.ts`, not from eyeballing the FPS counter.

- The renderer is driven by `Loop`, which records a smoothed FPS and a per-frame
  wall-clock cost. `measureFrameRate` discards a 1.5 s settling window (shader
  compilation, mip chain construction, first GC) and then reports the **median**
  over a 4 s sample. Median rather than mean: a single compositor hitch moves a
  mean by several FPS and tells you nothing about the steady state.
- Playwright runs with `workers: 1`. Parallel WebGPU contexts contend for one
  device, which turns any frame-rate assertion into a coin flip.
### rAF throttling — read this before trusting any FPS number

**Automated Chromium throttles `requestAnimationFrame` independently of load.**
This project was measured at **1.1 FPS while spending 0.8 ms per frame** — work
that corresponds to roughly 1250 FPS. The same ~1.00 fps appears with god rays
off, particles off and submersion zero, which is the tell: the number does not
respond to workload at all, so it is describing the harness, not the renderer.

Consequently the suite asserts on **per-frame work (`frameMs`)**, not on
delivered frame rate. `measureFrameRate` returns a `rafThrottled` flag, and the
FPS assertion is only applied when that flag is false — so a genuine regression
on an interactive run still fails the gate, while a throttled CI run does not
produce a meaningless failure.

Two further caveats on `frameMs`:

- It measures the wall-clock cost of the render call. On WebGPU much of the GPU
  work is submitted asynchronously, so this **undercounts true GPU time**. It is
  a sound regression signal and an upper bound on CPU-side cost, not a GPU
  profile. Real GPU timings need timestamp queries, which this project does not
  yet implement.
- Take measurements with nothing else using the GPU.

Reproduce with:

```bash
npm run build
npm run preview
npx playwright test --grep performance
```

## Test hardware

> Fill in for the machine under test — figures are meaningless without it.

| | |
|---|---|
| GPU | _to be recorded_ |
| Driver | _to be recorded_ |
| OS | Windows 11 Pro 26200 |
| Browser | Chrome 151 |
| Resolution | 1600 × 900 @ DPR 1 |

## Budgets

The gates the suite enforces:

| Configuration | Gate | Rationale |
|---|---|---|
| WebGPU, High | frame work < 16.7 ms | the 60 FPS target desktop budget |
| WebGL2, Low | frame work < 33.3 ms | the 30 FPS fallback floor |

FPS is additionally asserted (> 55 and > 30 respectively) only when the browser
is not throttling rAF.

## Results

Full scene — ocean, sky, volumetric clouds, seafloor, ship, island, buoys,
barrels, wake and underwater pass — at 1600 × 900, DPR 1, WebGPU, in an
instrumented interactive session.

| Configuration | Median frame work | Max | Samples |
|---|---|---|---|
| WebGPU · Low | 0.3 ms | 0.6 ms | 4 |
| WebGPU · High | 1.1 ms | 4.6 ms | 5 |
| WebGPU · Max | 0.8 ms | 0.9 ms | 5 |

**Read these with the caveats above, not as a clean benchmark.** Specifically:

- The sample counts are 4–5 over a four-second window. That is the rAF throttle
  again: the browser delivered roughly one frame per second, so these are a
  handful of real measurements rather than a distribution.
- `frameMs` is wall-clock around the render call, and WebGPU submits most work
  asynchronously, so it **undercounts GPU time**. Max scoring lower than High is
  not physically meaningful — it is noise at this sample size, and a reminder
  that these numbers cannot resolve differences of under a millisecond.
- A one-off **57.6 ms** frame was observed immediately after the ship and props
  finished loading, which is pipeline compilation for the newly added materials,
  not steady-state cost. It is the strongest argument for compiling scene
  materials during the boot overlay rather than on first draw — see Known gaps.

What these figures *do* support: CPU-side cost per frame is far below the 16.7 ms
budget at every tier, and nothing in the scene produces a sustained stall. What
they do **not** establish is the true GPU frame time, which needs timestamp
queries and a browser that is not pacing rAF.

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

## Adaptive quality

`AdaptiveQuality` steps the tier down when the smoothed rate stays below 75 % of
target for 2.5 s. It is deliberately one-way within a session, with a 6 s
debounce and a 4 s startup grace period: oscillating between tiers is more
distracting than running one notch below optimal, and the first seconds of a
session are dominated by compilation rather than by steady-state cost.

## Memory

`does not leak GPU memory across quality changes` cycles Low↔High four times and
asserts the renderer's texture and geometry counts have not grown beyond a small
allowance. Every tier change disposes the previous FFT targets, surface material
and ocean geometry before allocating replacements.

## Known gaps

- **No true GPU timings.** Needs timestamp queries; `frameMs` is a CPU-side upper
  bound only.
- **No clean benchmark run.** Every measurement so far was taken in a browser
  that was throttling rAF. A headed, focused browser with vsync disabled would
  give a real distribution.
- **Material compilation is not prewarmed.** The 57.6 ms spike after asset load
  should be removed by compiling scene materials behind the boot overlay
  (`renderer.compileAsync`) instead of on first draw.
- **WebGL2 tiers unmeasured.** The fallback renders correctly and is exercised by
  the suite, but no frame-cost figures have been collected for it.
