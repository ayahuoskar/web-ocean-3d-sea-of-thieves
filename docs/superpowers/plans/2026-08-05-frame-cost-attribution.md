# Where the frame actually goes, and what the benchmark was telling us instead

Measurements, 2026-08-05, on the reference host (RTX 5090, Ryzen 7 9800X3D,
Chrome 150, 1600x900 @ DPR 1, tier `high`, `skyPro`, canonical wide shot).
Reproduce with `node scripts/profile-frame.mjs`.

## The defect, reproduced

**The application delivers 15.8-16.6 ms per frame — about 62 FPS — with vsync
disabled, on an RTX 5090, at 1600x900.** That is the reported problem and it is
real. `npm run bench` reports the same configuration as an 8.26 ms frame, which
would be 121 FPS, and both numbers are correct measurements of different things.

## The benchmark's metric mis-attributes, and here is the proof

`npm run bench` gates on `renderer.resolveTimestampsAsync('render')` — the
**sum of the frame's render-pass durations**. Run against the subtraction
harness it produced this ranking:

| removed | timestamp delta | share of an 8.5 ms frame |
|---|---|---|
| sun shadow | 5.76 ms | 68% |
| cloud layer | 4.91 ms | 58% |
| ocean surface | 0.36 ms | 4% |

The first row is wrong, and two controls establish it rather than argue it:

- **Leave exactly one 48-triangle caster in the shadow pass.** The pass still
  runs (132 render passes, unchanged) and draws essentially nothing. Frame
  delta: **-0.02 ms**. A pass that costs the same empty as it does full is not
  doing 5.8 ms of work.
- **Shrink the map from 2048 to 512** via `light.shadow.map.setSize`, which is
  the render target `ShadowNode` assigns at `three.webgpu.js:45214`. Frame
  delta: **-0.065 ms**.

Measured against delivered frame rate instead, the same removal is worth
**0.68 ms**. The timestamp sum over-attributed the shadow by about 8.5x.

The mechanism is in the metric's definition: it is a *sum of pass durations*, so
work the GPU overlaps is counted more than once, and a pass that spends part of
its bracket waiting charges the wait to itself. The harness also resolves
timestamps every frame, which `docs/PERFORMANCE.md` already records as draining
the pipeline between frames — the first pass of the frame absorbs that drain.

**This does not invalidate the gate.** GPU p50 is still a real, reproducible
property of the renderer and still the right thing to hold a budget against.
What it cannot do is tell you which pass to cut, and it was never asked that
question before.

## What the frame is actually spending

Delivered milliseconds, from the app's own loop running free with vsync off,
each scenario paired against a baseline measured immediately before it.
Cross-checked against the timestamp sum and against a
`queue.onSubmittedWorkDone()` wall clock; where the three disagree it is said so.

| removed | delivered Δ | share | corroboration |
|---|---|---|---|
| cloud layer | 5.27-6.29 ms | 34-37% | all three instruments agree |
| cloud march 18 -> 4 steps | 3.59-4.33 ms | 27% | all three agree |
| ocean surface | 3.29-3.58 ms | 21% | fence agrees (4.7); timestamp says 0.36 |
| planar reflection pass | 1.53-2.70 ms | 10-16% | — |
| props | 0.99-1.39 ms | 8% | — |
| sun shadow | 0.68 ms | 4% | timestamp claimed 5.76 |
| seafloor | 0.18 ms | 1% | — |
| SSR trace (24 steps) | **0.075 ms** | 0.5% | — |
| buoyancy readback | **0.02 ms** | 0.1% | — |

Two of these are worth stating as results in their own right:

- **The 24-step screen-space reflection march is free.** It was the obvious
  suspect and it costs nothing measurable. Do not spend effort there.
- **The per-frame `Sampler` readback is free.** It maps a render target back to
  host memory every frame and it does not bound the queue.

And one structural fact: **`reflectionScale` is not a cost lever.** Taking it
from 0.5 to 0.1 — a 25x reduction in reflection pixels — saved 0.009 ms. The
reflection pass is draw- and vertex-bound, not fill-bound, because it is a
second submission of the whole scene. The tier setting that claims to control
its cost controls only its sharpness.

## The half of the frame the first rounds never measured

Hiding a scene object cannot reach the post chain or the wave simulation, and
that is why the first ranking accounted for only about nine of fourteen
milliseconds. Measured with direct handles instead (`__ocean.post`,
`__ocean.simulation`):

| removed | delivered Δ | share | note |
|---|---|---|---|
| **FFT + spectrum** | **5.07-5.47 ms** | **40-42%** | the largest single item in the frame |
| FFT run on alternate frames | 3.22 ms | 24% | what amortising it is worth |
| volumetric fog march | 1.79-2.32 ms | 14-18% | `fogSteps` 18 at High |
| depth of field | -0.14 ms | — | free, exactly as documented |
| bloom pyramid | -0.29 ms | — | free, exactly as documented |
| lens rain | 0.47-0.89 ms | — | **inside the noise band** (spread 0.82-0.98); not established |
| sky dome | 0.82 ms | — | at the edge of the noise band; not established |

**`docs/PERFORMANCE.md` says "the transform is deliberately *not* the
bottleneck; surface shading is". That is now falsified.** The transform is 40%
of the delivered frame and the surface is 21%.

**And its cost is command submission, not GPU maths.** With
`OceanSimulation.update` stubbed the frame's CPU *update* phase falls from
~5.9 ms to **0.22 ms**. Three cascades at 256² issue roughly 96 fullscreen
render passes every frame, and in three.js WebGPU that pass count is the cost.
The lever is therefore the number of passes, and there are three ways at it:
amortise the cascades, fold several butterfly stages into one pass, or use
compute on the WebGPU path and keep the fragment path for WebGL2.

Amortising is the cheap one and it should be derived rather than tuned. Deep
water dispersion gives `omega = sqrt(g k)`, so the swell band's shortest wave
(24 m) has a 3.9 s period and the chop band's (6 m) 2.0 s — hundreds of frames
and ~120 frames respectively. Only the ripple band evolves at anything like
frame rate. Updating the three bands at different rates is a sampling argument,
not a quality cut.

**It is not free of consequences**: the field a frame displaces from would be up
to N-1 frames stale, so every visual baseline moves. That makes it a decision to
take deliberately rather than fold into a performance pass.

## The cloud dome, measured and not landed

The layer is an 18-step raymarch with a nested 4-step light march, per fragment,
at full resolution, drawn at `renderOrder = -900` with `depthTest = false`. Every
pixel the seafloor, island, props and ship later painted over had already paid
for it. Depth-testing it and drawing it last measured **~16.0 -> 14.59 ms, 62.5
-> 68.5 FPS**, with the layer's own cost falling from 5.27-6.29 ms to 2.68.

Getting it correct took two attempts and the second one works:

- Moving `DOME_RADIUS` from 100 m to 30 km so the dome sits behind the world
  fails, because `ReflectorBaseNode` (`three.webgpu.js:37958-37973`) overwrites
  the third row of its projection matrix with an oblique near plane at the mirror
  (Lengyel). That destroys the far plane in the reflection pass, the dome is
  clipped out of the mirrored view, and the water loses its reflected clouds. A
  probe isolated it: the radius alone fails with the depth test still off.
- The radius cannot simply be reduced either — the sea is `transparent` with
  `depthTest` on and its outer ring is at 24 km, so a nearer dome would
  depth-reject the distant ocean instead of sitting behind it.
- Selecting the radius per rendering camera, on the GPU, from the camera's own
  height does work. An outside review proposed `cameraPosition.y < 0`; that is
  wrong here because this project has an underwater camera, and a submerged
  viewer would be mistaken for the mirror. Comparing against the viewer's actual
  height is right on either side of the surface.

**It was still not landed, because it is not free.** A full ordered run fails 5
of 21 shots:

| shot | mean ΔE94 | p95 | pixels ΔE>2.5 | max |
|---|---|---|---|---|
| shore-break | 0.218 (limit 0.100) | 0.640 | 2.07% (limit 0.15%) | 25.0 |
| waterline | 0.116 (limit 0.101) | **0.000** | 1.70% (limit 0.15%) | 20.8 |
| island-approach | 0.161 (limit 0.100) | 0.620 | 1.37% (limit 0.15%) | 20.8 |
| underwater | 0.079 ok | 0.450 | 0.55% ok | 56.1 |
| cinematic-surf | 0.038 ok | **0.000** | 0.45% (limit 0.15%) | 20.9 |

The shape is the tell. `waterline` and `cinematic-surf` have a p95 of **zero** —
over 95% of the frame is bit-identical — while 0.45-2.07% of pixels move by up
to ΔE 25. That is a localised fringe, not global noise, and every failing shot is
one with a prominent horizon or island silhouette. The renderer runs
`antialias: true`, so a depth-tested dome resolves per sample at exactly those
edges where it previously covered every sample and was overwritten.

So it is a real trade — roughly 1.4-2.0 ms for a visible change along silhouettes
in five shots — and whether to take it belongs to whoever owns the look.

## A methodology correction worth more than any of the numbers

An earlier revision of this document claimed **"shore-break and ship-and-island
fail against their committed baselines on untouched `main`"**. That was wrong,
and the way it was wrong is the point.

Every run behind that claim used `-g` to select a subset of shots. The suite is
sequential and shots share a page: `LensRain.ts:805-823` documents the effect
directly — a clear-day frame photographed through a lens that still had rain on
it, because it follows `underwater` in the shot list. Run a shot out of sequence
and it starts from different state, so it renders a different, equally correct
image.

Run in full and in order, **the clean tree passes 21 of 21 in 2.7 minutes** —
the same figure the previous session recorded. There were never any pre-existing
failures. The 17-minute run that first raised the suspicion was slow *because*
13 shots were failing and writing traces and diff attachments.

Two other diagnoses died on the way to this one, both recorded so nobody spends
the time again:

- **Not a browser change.** The baselines record `Chrome/151.0.7922.34` and the
  installed Chrome is 150.0.7871.189 — which looks damning and is irrelevant,
  because `playwright.config.ts` sets no `channel` and the suite runs
  Playwright's *bundled* Chromium. That is 151.0.7922.34, matching the
  baselines exactly. The harness's stack-mismatch warning
  (`visual.spec.ts:317-329`) stayed silent because there was no mismatch.
- **Not the code.** `git diff 7f26207..HEAD -- src/` is a cached field, a
  `RangeError` guard, comments and a test hook — behaviour-neutral.

**A subset run is not evidence about this suite.** Only a full ordered run is.

## The two ways to cut the transform, prototyped and compared

The transform is 108 render passes per frame at High: per cascade, 2 evolve +
2 x (2 x log2 256) butterfly + 2 assemble = 36, times three cascades. **96 of
those 108 are butterfly**, so the butterfly is 89% of the transform.

Both candidates were measured by proxy rather than written, each paired against
its own baseline in the same run.

| | proxy measured | worth | image |
|---|---|---|---|
| **Fold the stages (radix-4)** | run half the butterfly stages | **2.4-3.5 ms** | unchanged |
| **Amortise** | run the transform on alternate frames | **2.0-3.2 ms** | every baseline moves |

**The radix-4 proxy is exact rather than approximate.** Radix-2 needs
`log2(256) = 8` stages per direction and radix-4 needs `log4(256) = 4`, so a
radix-4 butterfly halves the pass count at identical texel count — which is
precisely what running half the stages does. The wave field it produces is the
same field.

**They cost the same and one of them is free.** On raw milliseconds the two are
inside each other's error bars, but amortising leaves the displaced field up to
N-1 frames stale, which moves every visual baseline and has to be re-approved;
folding the stages changes nothing anyone can see. Fold first.

**And the two ways of folding compose.** Radix-4 halves the butterfly passes;
packing the two ping-pong pairs into one pass through a multiple-render-target
attachment halves them again, since the pairs are independent transforms of the
same size. Together that is 96 butterfly passes down to 24. At the per-pass cost
implied above — roughly 7.24 ms for 108 passes, and the CPU update phase falling
from ~5.7 ms to 0.22 ms when the transform is stubbed, so about 50 microseconds
of *command submission* per fullscreen pass — that is the difference between a
16 ms frame and something near 11.

**Measurement caveat.** The delivered-frame baseline drifted between sittings
(13.2 ms early, 16.4 ms late) on an otherwise idle machine. Deltas are only
comparable *within* a run, which is why the harness pairs a fresh baseline with
every scenario. Cross-run absolute figures are not evidence.

## What a render pass costs, measured directly

The transform's cost was inferred to be per-pass. This measures the pass itself,
by *adding* work rather than removing it: run 96 extra fullscreen passes before
the real update, into a target the real update immediately overwrites, so the
wave field is untouched and only the cost moves.

| added | delivered Δ | per pass |
|---|---|---|
| 96 passes, one material reused | 5.09 ms | **53 us** |
| 96 passes, 48 distinct materials cycled | 5.73 ms | **60 us** |

**A fullscreen render pass costs about 53 microseconds in this engine**, near
enough regardless of what it draws. The transform issues 108 of them, which is
5.7 ms — and the frame's CPU update phase, measured independently by stubbing
`OceanSimulation.update`, falls from ~5.7 ms to 0.22 ms. Two unrelated routes to
the same number. The transform's cost is its pass count, fully.

**And material identity is a minor term, which kills a hypothesis of mine.** The
theory was that cycling 96 distinct `NodeMaterial`s through `quad.material`
before each pass was driving the cost through pipeline and bind-group churn.
Measured, it is 7 us of the 60 — **13%**. An independent review predicted exactly
this and gave the mechanism: programs are cached by generated shader text and
pipelines by program plus state, so 96 graphs differing only in direction and
texture identity collapse to about two pipelines; and reusing one material cannot
remove per-pass state encoding anyway, because each target switch starts a new
pass and state deduplication only operates *within* one.

Collapsing the 96 materials to two is therefore worth roughly 0.7 ms rather than
the bulk — cheap and safe (`TextureNode.value` is mutable and
`NodeSampledTexture.update` picks the swap up with no pipeline rebuild), but a
side-win, not the fix.

**The fix has to remove passes.** At 53 us each: halving 108 to 57 is worth
~2.7 ms; folding the pairs *and* mixed-radix-4 together would reach roughly 33
passes and ~4 ms, on a frame that is currently 16.

One correction to this document's earlier reasoning: radix-4 was dismissed here
because only 256 of the three tier sizes is a power of four. That is wrong. 128
and 512 take mixed radix — three or four radix-4 stages plus one radix-2 — which
takes the stage count from 7/8/9 to **4/4/5**, a larger proportional cut at 128
than at 256. It is deferred behind the pair fold, not ruled out.

## The fold, landed as an atlas

Both spectra pairs now live side by side in one double-width ping-pong — pair A
in `x < size`, pair B beyond it — and one set of passes steps both. Per cascade
that is 1 evolve + 16 butterfly + 2 assemble = **19 passes against 36**, so the
transform went from 108 render passes a frame to 57.

**Measured: the transform fell from 7.24 ms to 4.54 ms, and the frame baseline
from 16.49-17.02 ms to 14.47 ms — about 69 FPS against 61.** The saving is
2.70 ms and the model predicted 2.70: 51 fewer passes at the 53 microseconds a
pass costs here. Three significant figures, which is the strongest evidence that
the per-pass cost model is right and not a coincidence of one measurement.

Verified: **21 of 21 visual baselines pass**, so the sea is pixel-identical; the
CPU-side butterfly test passes at every tier size; `ocean.spec`'s sea-state
assertion is back in range; and the WebGL2 fallback renders with zero console
errors and inside its frame budget. Memory is unchanged — two targets of
`2N x N` replace four of `N x N`.

### Why an atlas and not a multiple-render-target

MRT was the first choice and it is the cleaner expression: one pass, two colour
attachments, no index arithmetic. It was implemented and reverted, because
**three.js silently writes nothing** through it on this path.

The evidence, in the order it was gathered:

- `ocean.spec`'s sea-state assertion reported `peakHeight` of exactly **0** with
  zero non-finite values — a zeroed field, not a corrupted one.
- Both attachments read back as exactly 4096 over 64x64: `(0, 0, 0, 1)` in every
  texel, the clear value.
- Texture count was 2 and the names were `["pairA", "pairB"]` on both ends of the
  ping-pong, so `getTextureIndex` had something to match.
- **No WebGPU validation errors and no MRT-related warnings.**
- Both spellings failed identically — `material.fragmentNode = mrt(...)` and
  `material.mrtNode = mrt(...)` with `fragmentNode` null, which is the one
  `NodeMaterial.setup` actually consults.
- **A constant failed too.** `vec4(7,7,7,7)` through `mrtNode` left both
  attachments at the clear value, which rules out the node graph and the wave
  mathematics entirely.

Three attempts failing the same silent way is the signal to change approach
rather than try a fourth. The atlas needs no capability beyond a wider texture,
which both backends already had.

### The seam, and what guards it

Atlasing moves the risk into index arithmetic, which is exactly where this file
has been bitten before. Two rules carry it:

- The butterfly's axis index is the position *within* a half, and horizontal
  reads are offset back into the fragment's own half. Reading across the seam
  would mix two unrelated transforms.
- Vertical reads keep the fragment's own column, which already carries the
  offset, so they need no adjustment at all.

`tests/fft.spec.ts` guards the table those indices come from — it executes the
butterfly on the CPU against a brute-force inverse DFT and is mutation-verified
against the twiddle bug this project shipped once. It does not cover the seam
itself; the 21 visual baselines do, and a seam error is not subtle.

### And then every cascade, in the same atlas

The butterfly reads nothing cascade-specific — only the ping-pong texture and
the twiddle table — so running it once per cascade paid the per-pass cost three
times for one pass of work, exactly as the two pairs had. The atlas therefore
widened again: `2 * cascadeCount` slots, slot `2c` being cascade c's pair A and
slot `2c + 1` its pair B, with the initial spectra in a matching
`cascadeCount * size` texture so one evolution serves them all.

Per frame that is **1 evolve + 16 butterfly + 6 assemble = 23 passes against the
original 108.** Only the unpacking stays per cascade, because only it writes
somewhere different.

| | passes | transform | frame | delivered |
|---|---|---|---|---|
| before | 108 | 7.24 ms | 16.5-17.0 ms | ~61 FPS |
| pairs folded | 57 | 4.54 ms | 14.47 ms | ~69 FPS |
| cascades folded | **23** | **2.55 ms** | **12.31 ms** | **~81 FPS** |

The transform is down 65% and the frame by about 4.2 ms, with 21 of 21 visual
baselines unchanged at every step.

One thing this cost, and it is worth stating plainly: the seam arithmetic is now
load-bearing in three places rather than one — the butterfly's slot offset, the
evolution's cascade-to-spectrum-column mapping, and the unpack's base offset.
The first version of the cascade fold got exactly this wrong, generalising the
simulation to N slots while leaving `butterflyPassNode` on the two-slot
arithmetic where the offset could only ever be 0 or `size`. It did not error; it
produced a sea whose Jacobian folded over 66% of the surface. `ocean.spec`'s
sea-state assertion caught it, which is the argument for having a numeric
assertion on the field and not only pictures.

### Still available, in order

**Mixed-radix-4** takes the stage count from 7/8/9 to 4/4/5 at 128/256/512,
halving the butterfly passes again: 57 to roughly 33, worth about another
1.3 ms. 128 and 512 need a radix-2 stage alongside the radix-4 ones, so it is
three cases rather than one, and the CPU test would have to grow a mixed-radix
reference before it could be trusted.

**Collapsing the butterfly materials** is worth about 0.7 ms — material identity
measured 7 of the 60 microseconds a pass costs. `TextureNode.value` is mutable
and `NodeSampledTexture.update` picks the swap up with no pipeline rebuild, so
two materials could replace the current per-stage set.

## What is worth doing next, in order

1. ~~Fold the two spectra pairs into one pass.~~ **Done** — landed as an atlas,
   2.70 ms, 21 of 21 baselines unchanged. See above.
2. **Cheapen the nested light march.** Raised by an outside review and it is
   the best-argued item here: `Clouds.ts` already documents that nested callers
   cannot afford full density, yet every one of the 4 light samples per march
   step calls the full `densityAt`. Coarse octaves there, or fewer light steps,
   costs fine self-shadowing and may need the extinction retuned.
3. **Render the cloud layer at half resolution.** Still 18% of the frame after
   the change above, the march is inherently low-frequency, and the step count
   is the dominant term (18 -> 4 steps recovers 4.3 ms of the old 5.6). Roughly
   quarters the fragment work. Needs a render target, an upsample composite,
   care where the layer meets aerial perspective, and a separate mirrored-camera
   render for the water to stay right.
4. **Make the reflection pass cost something proportional to what it buys.**
   1.5-2.7 ms for a second view of the world that is sampled through a rippling
   normal at half resolution. `reflectionScale` does not touch it. The lever is
   what gets *submitted*, which means a layer mask on the virtual camera rather
   than the visibility toggle tried above.
5. **Decide on the cloud dome.** The change is written up above and measured on
   both axes: ~1.4-2.0 ms against a silhouette fringe in five shots.

## Not worth doing

- The sun shadow. 0.68 ms, and the benchmark's claim that it was 68% of the
  frame is an artifact.
- The SSR trace. 0.075 ms.
- The buoyancy readback. 0.02 ms.
- Depth-testing the sky dome. Measured -0.16 ms, and it is unsafe besides: the
  dome shares its geometry *and material* with `envMesh`, whose CubeCamera far
  plane is 400 m (`Atmosphere.ts:413,423`), so moving its radius would push the
  environment capture out of frustum and silently empty the environment cube.
