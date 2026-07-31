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
- Measurements must be taken with nothing else using the GPU. During development
  of this project, concurrent headless browser sessions dropped the observed rate
  from 60 to 1–3 FPS — a reading that says nothing about the renderer.

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
| WebGPU, High | > 55 FPS | the target desktop experience |
| WebGL2, Low | > 30 FPS | the fallback floor |

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

## Results

> Populate from a clean run on the machine above.

| Configuration | Median FPS | Median frame ms |
|---|---|---|
| WebGPU · Low | | |
| WebGPU · Medium | | |
| WebGPU · High | | |
| WebGPU · Ultra | | |
| WebGPU · Max | | |
| WebGL2 · Low | | |
| WebGL2 · High | | |
