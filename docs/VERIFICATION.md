# Deterministic visual verification

A visual regression harness for the seven canonical shots: fixed world state,
checked-in baselines, a perceptual metric, and thresholds derived from a measured
noise floor rather than chosen to make the suite pass.

- Suite: `tests/visual.spec.ts`
- Shot definitions: `tests/lib/shots.ts`
- Metric: `tests/lib/compare.ts`
- Capture path: `tests/lib/capture.ts`
- PNG codec: `tests/lib/png.ts` (no dependencies — `node:zlib` only)
- Baselines: `tests/baselines/*.png` with a `*.json` provenance sidecar
- Artefacts: `test-results/visual/`

## Running it

```sh
npx playwright test --project=visual
```

The `visual` project is separate from `chromium-webgpu` and boots the app at
1280x720, DPR 1. Twelve tests, about 25 seconds on the reference stack.

| Environment variable | Effect |
| --- | --- |
| `UPDATE_BASELINES=1` | Regenerate every baseline PNG and sidecar from this run |
| `MEASURE_NOISE=1` | Re-measure the noise floor and print a block ready to paste into `MEASURED_NOISE_FLOOR` |
| `KEEP_ARTIFACTS=1` | Write actual/baseline/diff PNGs for shots that pass, not only for shots that fail |

Every run writes `test-results/visual/comparison.json` with the score and the
limit for each shot, pass or fail, so a shot creeping toward its threshold is
visible before it crosses.

## The canonical shots

Defined as data in `tests/lib/shots.ts` — preset, quality tier, wind, cloud
cover, camera mode, camera pose and simulation time — so the harness, any
before/after review loop and the README screenshots can all frame the same seven
views.

| Shot | Preset | What it is there to catch |
| --- | --- | --- |
| `clear-day-wide` | skyPro | Horizon integration, sun glitter, cloud lighting, the ship at silhouette distance |
| `near-water-detail` | skyPro | Wave shape, normal detail, crest foam, geometry-to-normal-map transition |
| `sunset` | sunset | Low-sun specular track, warm/cool gradient, highlight roll-off at the horizon |
| `storm` | storm | High sea state, rain, dense cloud, foam coverage, low contrast |
| `boat-chase` | seaOfThieves | Chase framing, buoyancy pose, hull material, contact shadow, wake footprint |
| `waterline` | skyPro | Grazing near-surface silhouette against sky, up-sun specular path to the horizon |
| `underwater` | skyPro | Extinction with depth, god rays, particulate, hull underside, surface from below |

**`boat-chase` is not "while moving".** The spec asks for the chase camera while
under way; there is no ship controller yet (Boat mode is a chase camera, W/S and
A/D are unimplemented), so the shot captures the chase framing of a hull that is
only bobbing on the swell. When the controller lands, the shot needs a ship input
applied before the settle and a longer settle so the wake has developed —
nothing else about it changes, and its baseline is expected to be regenerated.

**`waterline` is grazing, not a split.** `submersion` is currently a whole-frame
cross-fade rather than a screen-space split, and the camera director pushes the
camera out of a 0.35 m band around the surface to stop the underwater state
flickering. A true half-in/half-out meniscus shot cannot be framed until that
exists; this shot anchors the low-camera view in the meantime.

## How a capture is made

Per shot, in this order:

1. `setState` with the shot's full state. Every shot spells out all six values
   even where they match the app default, because `setState` mutates persistent
   state and an omitted field would inherit whatever the previous shot set.
   `preset` is applied last, so `applyPreset` rebuilds the spectrum once from the
   already-updated wind values.
2. `setCamera` — **before** the settle. The underwater pass, the fog and the
   particle field read the camera during `update()`, so a camera moved after the
   world settled would be photographed with another camera's atmosphere.
3. `resetDeterministic(time, 90)` — rewinds every clock, clears the wake buffer,
   returns floating bodies to their spawn poses, then settles by stepping 90
   increments of 1/60 s, each awaiting a fresh wave-field readback.
4. For `boat-chase`, `director.snapToTarget()`, which places the chase rig at its
   exact ideal pose instead of wherever the damping converged.
5. Three warm-up captures, discarded (see below).
6. `capturePixels()`.

Captures use `__ocean.capturePixels()`, never `page.screenshot()`. A screenshot
is whatever the compositor last presented: possibly a frame stale, subject to the
browser's colour management, and under automation — where requestAnimationFrame
is throttled to roughly 1 Hz — it may not arrive at all. `capturePixels` renders
the post chain into an offscreen target and reads it straight back.

Note that `capturePixels` documents its buffer as bottom-up "render-target
origin". On the WebGPU backend it is not: the readback copies texture rows in
texture order, row 0 at the top. Flipping it produces an ocean above a sky. The
harness does not flip.

### Warm-up frames

The count is measured, not guessed. Re-applying a shot five times and scoring all
ten pairs:

| Warm-up captures | `storm` mean ΔE | `waterline` mean ΔE |
| --- | --- | --- |
| 1 | 1.346 | 1.103 |
| 2 | 0.035 | 0.000 |
| 3 | 0.037 | 0.000 |

The frame immediately after a state change is not converged; the next one is.
This is a factor of about thirty on the harness's sensitivity, and it is the
reason the noise floor below is small. Three warm-ups, because the second and
third measure the same and the extra costs about ten milliseconds per shot.

### The UI is excluded, and that is tested

`capturePixels` reads a render target, which cannot contain DOM — but that is an
argument, not evidence. `captures exclude the HUD and control panel` captures a
frame, hides `.hud`, `.panel` and `.panel-toggle`, captures again, and requires
the two to be byte-identical. It first asserts the overlay is actually present
and on screen, so it cannot pass vacuously on a page whose UI failed to build.
(`.panel-toggle` is `display: none` above the mobile breakpoint by design, so at
1280x720 only the HUD and the panel are on screen.)

## The metric

Both images are converted from sRGB to CIELAB (D65) and every pixel is scored
with **CIE94, graphic-arts weights** (kL = kC = kH = 1, K1 = 0.045, K2 = 0.015).
Three numbers are reported, and a shot fails if any one of them is over its
limit:

| Number | What it means | What it catches that the others miss |
| --- | --- | --- |
| `meanDeltaE` | Mean ΔE94 over all 921,600 pixels | A broad, low-amplitude shift — changed exposure, fog colour, tone curve |
| `p95DeltaE` | 95th-percentile ΔE94 | A localised change the mean drowns — a broken reflection is 2% of the frame |
| `fractionAbove` | Fraction of pixels with ΔE94 > 2.5 | How much of the frame moved, which separates reshuffled sparkle from a recoloured ocean |

`maxDeltaE` is also reported, as a diagnostic only. One bad pixel is not a gate.

**Why not average colour.** The preset test in `ocean.spec.ts` fingerprints a
frame by its mean channel values. That is fine for "did the preset change
anything" and useless as a regression gate: a shader that swaps the left and
right halves of the image has the same average as one that does not. The suite
carries a test — `a relocated patch scores non-zero despite an identical average`
— that fails if this metric ever degenerates into that one.

**Why not pixel-exact.** Across GPU vendors it can never hold, and even here it
would break the moment a driver updates. The harness compares on a recorded
equivalent stack and warns loudly when the stack has moved.

**Why CIE94 and not CIE76.** CIE76 is Euclidean distance in Lab, and Lab is not
uniform at high chroma: the saturated sky of the sunset and storm shots reports
ΔE76 values two to three times what the same visual change produces on the
near-neutral water, purely because those colours sit far from the neutral axis.
CIE94 divides the chroma and hue terms by (1 + K·C₁), which removes most of that
bias for six extra lines.

**Why not CIEDE2000.** Its additional terms mainly refine the blue-hue region,
which is relevant here — but it is four times the code and its correctness is not
something this harness can cheaply demonstrate. An unverifiable metric is worse
than a slightly coarser verifiable one.

CIE94 is asymmetric: the weights use the reference colour's chroma. The baseline
is always the reference, and the harness never swaps the arguments.

**The per-pixel threshold is 2.5.** ΔE ≈ 1 is the textbook just-noticeable
difference between two large flat patches under controlled viewing. A 1280x720
frame of moving water is not those conditions. 2.5 is where a difference survives
being looked at rather than measured.

## Thresholds

```
limit = 2 × measured_noise + absolute_floor
absolute_floor = { mean 0.10, p95 0.40, fractionAbove 0.0015 }
```

The multiplier covers the noise floor being an estimate from ten sample pairs
rather than a distribution. The additive floor is what keeps the gate meaningful
on the shots that are perfectly reproducible, where twice nothing is still
nothing and an honest rounding difference would fail the build.

### Measured noise floor

Worst pairwise score over ten pairs, from five complete re-applications of each
shot inside one browser session — state, camera, `resetDeterministic`, settle,
warm-up, capture, five times over. Repeating only `capturePixels` would measure
the readback, which is exactly reproducible and would report zero; what the
harness actually repeats between runs is the whole protocol.

Measured 2026-08-01 on the reference stack below.

| Shot | mean ΔE | p95 ΔE | pixels ΔE > 2.5 |
| --- | --- | --- | --- |
| `clear-day-wide` | 0.0216 | 0.00 | 0.181% |
| `near-water-detail` | 0.0155 | 0.00 | 0.133% |
| `sunset` | 0.0146 | 0.00 | 0.078% |
| `storm` | 0.0387 | 0.00 | 0.256% |
| `boat-chase` | 0.0318 | 0.00 | 0.324% |
| `waterline` | 0.0000 | 0.00 | 0.000% |
| `underwater` | 0.0050 | 0.00 | 0.019% |

`p95 = 0.00` means more than 95% of pixels were bit-identical.

### Resulting limits and headroom

| Shot | mean limit | × noise | p95 limit | pixel-fraction limit | × noise |
| --- | --- | --- | --- | --- | --- |
| `clear-day-wide` | 0.143 | 6.6 | 0.40 | 0.512% | 2.8 |
| `near-water-detail` | 0.131 | 8.5 | 0.40 | 0.416% | 3.1 |
| `sunset` | 0.129 | 8.8 | 0.40 | 0.306% | 3.9 |
| `storm` | 0.177 | 4.6 | 0.40 | 0.662% | 2.6 |
| `boat-chase` | 0.164 | 5.2 | 0.40 | 0.798% | 2.5 |
| `waterline` | 0.100 | — | 0.40 | 0.150% | — |
| `underwater` | 0.110 | 22 | 0.40 | 0.188% | 9.9 |

Because the measured p95 is zero everywhere, the p95 limit is the absolute floor
for every shot and is the tightest of the three gates in practice.

### Cross-session behaviour

Baselines were written in one browser session and compared in three later ones.
Every shot scored exactly zero except `clear-day-wide`, which scored a mean ΔE
between 0.007 and 0.022 with 0.05–0.18% of pixels over 2.5 — inside its measured
noise floor. Session-to-session variation is therefore not larger than
within-session variation on this stack.

### What this can and cannot detect

Measured by perturbing a real input and re-running `clear-day-wide`:

| Change | mean ΔE | p95 ΔE | pixels > 2.5 | Result |
| --- | --- | --- | --- | --- |
| `cloudCoverage` 0.32 → 0.33 (+3%) | 0.046 | 0.34 | 0.167% | passes, just under the p95 limit |
| `cloudCoverage` 0.32 → 0.35 (+9%) | 0.080 | 0.58 | 0.160% | **fails** on p95 |

So the gate currently sits between a 3% and a 9% change in a single atmospheric
parameter. A regression smaller than the noise floor in the table above cannot be
detected at all — on this stack that means a change below roughly ΔE 0.04 mean,
or one touching under about 0.3% of the frame at ΔE 2.5.

That is far tighter than it was before the warm-up frames were added, where the
`storm` and `waterline` shots had noise floors of 1.35 and 1.10 mean ΔE with 13%
of pixels moving between identical runs. If temporal stability regresses, or a
future effect introduces genuinely chaotic per-frame content (screen-space
reflections with a temporal history, stochastic rain impacts), the noise floor
must be **re-measured** and the table above updated. It must never be raised to
make a failing shot pass.

## Artefacts

On failure — or always, with `KEEP_ARTIFACTS=1` — the harness writes three
full-resolution PNGs per shot to `test-results/visual/` and attaches them to the
Playwright report:

- `<shot>-actual.png` — what this run rendered
- `<shot>-baseline.png` — what it was compared against
- `<shot>-diff.png` — a ΔE heat map

The diff is not a boolean mask. The baseline is drawn underneath, darkened and
desaturated, so the difference is legible against what it happened to; on top of
it, ΔE runs through a dark-blue → cyan → yellow → red ramp that saturates at
ΔE 10. The ramp is square-root compressed, because on a linear ramp a broad
ΔE 0.5 shift across the whole frame — precisely the regression a mean catches and
an eye does not — renders as black, and the artefact would say "nothing happened"
while the numbers said otherwise.

Reading it: a red shape is a localised defect, a blue haze over a large area is a
low-amplitude global shift, and blue speckle along wave crests is specular
sparkle reshuffling.

**The metric does not replace looking at the images.** It has nothing to say
about whether the image is any good — seams, banding, tiling, blown highlights
and flat materials all reproduce perfectly. `KEEP_ARTIFACTS=1` exists so a human
can review the actual frames after a visual change, not only after a failure.

## Regenerating baselines

```sh
UPDATE_BASELINES=1 npx playwright test --project=visual
```

Deliberate and explicit; there is no auto-update on mismatch. Review the diff
artefacts before doing this — a regenerated baseline is an approval.

Each baseline gets a `tests/baselines/<shot>.json` sidecar recording:

- the stack it was captured on (backend, GPU, WebGPU adapter, browser build,
  resolution, DPR)
- the shot definition it was captured under (state, camera, time, settle steps)

Before comparing, the harness checks both against the current run and prints a
banner when either has moved:

```
==============================================================================
[visual] storm: COMPARING ACROSS A CHANGED STACK OR DEFINITION.
[visual] Whatever the numbers below say, they are not evidence of a
[visual] rendering regression until this is resolved.
[visual]   gpu: baseline "…RTX 5090…" vs current "…SwiftShader…"
==============================================================================
```

It warns rather than fails, because a deliberate camera move or a browser update
is a legitimate reason to see a large diff — but the warning also lands in the
failure message and in the Playwright report annotations, so the number can never
be read without it.

## Skip conditions

The shots skip, with the reason printed, when:

- the app is not on the WebGPU backend — the baselines are WebGPU renders, and
  comparing a WebGL2 fallback against them measures the backend; or
- the GPU string names a software rasteriser (SwiftShader, llvmpipe, …), whose
  filtering and rounding differ from any GPU.

Nothing is loosened to make a shot pass on an unsuitable stack. The four
`image pipeline` tests do not need a GPU and always run.

Getting a WebGPU device out of Playwright's Chromium on this machine needed two
launch flags beyond the existing ones, both in the `visual` project:

- `--enable-gpu`. Headless Chromium uses SwiftShader otherwise, and
  `navigator.gpu.requestAdapter()` returns null — the app falls back to WebGL2 on
  a CPU rasteriser and every shot skips.
- `--disable-dawn-features=use_dxc`. With `--enable-gpu` alone the adapter
  appears and then `requestDevice()` fails with
  `DynamicLib.Open: dxil.dll Windows Error: 87` — Chromium's bundled DXC shader
  compiler will not load here. Disabling the `use_dxc` Dawn feature falls back to
  FXC on the same D3D12 backend and the device comes up.

The `chromium-webgpu` project does **not** carry these flags, so the functional
suite still runs on SwiftShader and still skips its screenshot assertions. Adding
them there would put it on hardware too; that is a change to the functional and
performance suites and is deliberately left out of this one.

## Reference stack

Everything above was measured on:

| | |
| --- | --- |
| Backend | WebGPU (Dawn, D3D12, `use_dxc` disabled) |
| GPU | `ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 (0x00002B85) Direct3D11 vs_5_0 ps_5_0, D3D11)` |
| WebGPU adapter | `nvidia/blackwell` |
| Browser | `Chrome/151.0.7922.34` (Playwright bundled Chromium, headless) |
| Resolution | 1280x720, DPR 1 |
| Quality tier | High |
| OS | Windows 11 Pro 26200 |

1280x720 rather than the 1600x900 the performance budget is quoted at: the
comparison is per-pixel and full-resolution either way, and the larger frame
would only add 44% to the size of every checked-in baseline. The seven baselines
total about 6.3 MB.

## When a shot fails

1. Open `test-results/visual/<shot>-diff.png`. Where is the change?
2. Open `actual` and `baseline` side by side. Is the change an improvement, a
   regression, or a side effect of something unrelated?
3. Check for a stack or definition warning in the output. If the GPU, browser or
   camera moved, the number is not a regression signal.
4. If several shots fail together with a crest-speckle diff and scores near
   mean ΔE 1, suspect the warm-up protocol failing to converge on a slower or
   differently-driven stack, not a rendering change. Re-run `MEASURE_NOISE=1`
   before concluding anything.
5. If the change is intended, regenerate the baseline. If it is not, fix the
   renderer. Do not raise the threshold.
