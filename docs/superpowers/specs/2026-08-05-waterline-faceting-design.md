# The waterline is faceted, and the vertex stage is why

Design, 2026-08-05.

## Why

`tests/baselines/waterline.png` — the sea-level shot, High, 5 m/s, camera at
y = 0.02 — shows the water as a crumpled low-poly sheet. Isolated vertices spike
into triangular pyramids at the crests, and every crest line is a run of straight
segments with hard corners. From two centimetres above the surface that is most
of the frame.

It is not shading. The fragment stage takes its normal entirely from the
mip-filtered derivative fields, so shading across a facet is smooth; what the
crop shows is the *silhouette* and the *form*, which are geometry.

### The mechanism

**A vertex-stage texture read has no derivatives, so it samples LOD 0.**
`OceanMaterial.ts:718` displaces every vertex with

```ts
this.displacementNodes[i].sample(worldXZ.div(this.uTileSizes[i]))
```

which compiles to the sharpest mip regardless of how far apart the vertices are.
So the mesh is asked to carry the whole spectrum at every distance, including
wavelengths far below its own sampling rate. Each triangle then lands on an
essentially random phase of those waves, which is exactly what produces isolated
spikes and polygonal crests.

The numbers, for the High tier that captured the baseline — 288 rings and 448
segments over 0.6 → 24000 m, so radial vertex spacing is `0.0375 × distance` and
angular is `0.0140 × distance`:

| distance | vertex spacing | shortest λ the mesh can carry (4 samples/wave) | what is displacing it |
|---|---|---|---|
| 5 m | 0.19 m | 0.75 m | ripple, full strength, λ from 0.05 m |
| 20 m | 0.75 m | 3.0 m | ripple, full strength |
| 55 m | 2.1 m | 8.2 m | chop, full strength, λ from 6 m |
| 110 m | 4.1 m | 16.5 m | chop, full strength |

`Spectrum.ts:52-55` sets the bands: swell λ 24–10⁴ m at tile 512, chop λ 6–24 m
at tile 128, ripple λ 0.05–6 m at tile 16.

`CASCADE_GEOMETRY_FADE_METRES` (`OceanMaterial.ts:2013`) is the right idea and
its header states the right principle — "each cascade must stop displacing
vertices once its wavelength approaches that spacing". But it is expressed as
fixed metres, so it knows nothing about the tier's mesh density, and it is
several times too generous: the ripple cascade is at full strength out to 18 m,
where the mesh can carry 3 m waves and the cascade contains 0.05 m ones.

### What the reference set says

`4dSBDt` (Enscape Cube) and `lt3GWj` (TDM's Seascape — Sailing) both carry fewer
octaves in geometry than in shading: `ITER_GEOMETRY` 3 and 2 against
`ITER_FRAGMENT` 5. Every other ocean in the set raymarches a heightfield, where
this class of artefact cannot arise because there is no mesh to under-sample.

So the reference corroborates the split this project already has. What it does
not supply, because none of them need it, is the *calibration* — and the
calibration is the whole defect. Nothing is copied from any of them; the licence
position in `research/shadertoy/README.md` stands unchanged.

## The design

### 1. Band-limit the vertex displacement to the mesh's sampling rate

A mesh with vertex spacing `s` carries waves of λ ≥ N·s, with N ≈ 4 before
crests turn polygonal. A box average of width `f` suppresses λ < 2f. Setting
2f = N·s gives f = 2s, so the mip level to sample cascade *i* at is

```
lod_i = log2( max( 2·s / texel_i , 1 ) )
s     = groundDistance × K
K     = max(growth − 1, 2π / angularSegments)
texel_i = tileSize_i / fftSize
```

`K` is a property of the built mesh and is one uniform. `texel_i` is
0.0625 m (ripple), 0.5 m (chop) and 2 m (swell) at fftSize 256.

**This law reproduces the hand-tuned fade table**, which is the evidence that it
is the right one rather than merely a different one:

| cascade | band | current fixed fade | where the LOD extinguishes it |
|---|---|---|---|
| ripple | λ 0.05–6 m | 18 → 55 m (mid 36) | 4s ≥ 6 m at **40 m** |
| chop | λ 6–24 m | 110 → 300 m (mid 205) | 4s ≥ 24 m at **160 m** |
| swell | λ 24–10⁴ m | 900 → 2600 m (mid 1750) | see below |

Two of the three land inside the ramp somebody tuned by eye, near its middle.
That is agreement from an independent direction, and it also governs the near
field, where the table has no opinion and where the spikes are.

The swell needs its energy taken into account rather than its nominal band. Its
band nominally runs to 10 km, which by the strict criterion would never
extinguish inside a 24 km mesh — but the spectrum's energy sits at the peak,
20 m for this shot, and what little rides above 100 m of wavelength is gone once
`4s ≳ 100 m`, i.e. beyond roughly 700 m. That is the 900 → 2600 m ramp again.

A cascade extinguishes itself: once `lod` runs past the last mip the sampler
clamps to the 1×1 level, which is the mean of a zero-mean field. So
`CASCADE_GEOMETRY_FADE_METRES` is removed rather than kept — retaining it would
attenuate twice. `cascadeShadingFade` is untouched; the fragment stage keeps
carrying detail far beyond where geometry has flattened, which is the existing
and correct split.

**The cost is zero.** Both output targets go through `makeOutputTarget`
(`OceanSimulation.ts:533`), which sets `generateMipmaps: true` and
`LinearMipmapLinearFilter`. The displacement mip chain is already built every
frame for a consumer that does not exist; this change gives it one. Coarser mips
are also more cache-coherent than LOD 0, so if anything moves, it moves the right
way.

One tunable survives: N, samples per wavelength. It is physically meaningful and
it is the knob to reach for if verification says the surface went too flat.

**Also applies to the wake displacement** (`OceanMaterial.ts:747`), which reads
the accumulation buffer at LOD 0 in the vertex stage under the same argument —
0.41 m per texel, displaced out to 620 m where spacing is 23 m. Conditional on
that buffer carrying a mip chain; if it does not, its existing distance fade
stays and this is left alone rather than half-done.

### 2. Square the triangles

High builds 288 rings × 448 segments: radial spacing `0.0375r`, angular
`0.0140r`. The triangles are slivers 2.7× longer radially than they are wide.
Band-limiting is governed by the **worst** axis, so the angular over-sampling
buys nothing at all — it is vertex budget spent on a direction that was never the
constraint.

At fixed vertex count `V = R·S`, the worst axis is minimised when the two agree:

```
L = ln(outerRadius / innerRadius) = 10.6
S = 2πR / L  ⇒  R = sqrt(V / 0.593)
```

| tier | now (R×S) | squared | worst-axis spacing | gain |
|---|---|---|---|---|
| low | 128×192 | 204×121 | 0.0863r → 0.0533r | 1.62× |
| medium | 192×288 | 305×181 | 0.0567r → 0.0354r | 1.60× |
| high | 288×448 | 466×277 | 0.0375r → 0.0230r | 1.63× |
| ultra | 384×576 | 611×362 | 0.0280r → 0.0175r | 1.60× |
| max | 512×768 | 814×483 | 0.0209r → 0.0131r | 1.60× |

Vertex count and triangle count are unchanged, so the cost is unchanged. What it
buys is a 1.6× shorter wavelength surviving the band-limit at every distance and
every tier — which is precisely the detail item 1 would otherwise remove.

What it spends is horizon smoothness: the outer ring becomes a 277-gon instead
of a 448-gon, and at 24 km its chord sags `r(1 − cos(π/S))` = 1.54 m. Seen from
that range it subtends 6.4×10⁻⁵ rad, against 9.7×10⁻⁴ rad for one pixel at 720
lines over a 40° vertical field. Fifteen times under a pixel, from any camera
height.

### 3. Foam, measured before it is changed

The white in the baseline frame is **not yet established to be foam**. At 2 cm
eye height every wave face is at grazing incidence, where Fresnel drives
reflectance toward 1 and the sea legitimately returns the pale sky. And whitecap
coverage already follows Monahan and is pinned by `tests/foam.spec.ts`, so the
*amount* is unlikely to be the defect.

So the first step is a measurement, not an edit: capture the same frame with
foam strength and surf strength forced to zero, and difference it against the
baseline.

- **If the white is reflection** — no foam change is made. It will read correctly
  once the crests are crests rather than pyramids.
- **If it is foam** — the defect is placement. `crestBias`
  (`OceanMaterial.ts:1434`) gates foam on the *displaced* `worldPos.y`, and item 1
  makes that field smoother and rounder, so the bias must be re-tied to the
  shading-detail elevation or foam will slide off the crests as they round.

Either way item 1 changes the surface foam sits on, so tuning foam ahead of it
would be tuning against a surface that is about to be replaced.

## Verification

`tests/gallery-jitter.spec.ts` is the gate, and specifically its `DETAIL_FLOOR`
of 0.4. "Fixed the shimmer by flattening the sea" is a real and likely failure
mode of item 1, and that assertion exists to catch exactly it. Expected:
far-field `highFreq` falls, near-field `detail` holds.

Also:

- Re-capture `waterline` and every water-heavy gallery shot; all water baselines
  move.
- `tests/ocean.spec.ts` buoyancy assertions, including "a moderate sea leaves the
  hull on its designed waterline". The drawn surface is now band-limited while
  the CPU `Sampler` still reads the field at full detail, so the hull floats on a
  slightly different surface than the one drawn. Near the camera, where the ship
  is, the divergence is centimetres — but it is a real divergence and it is
  asserted on, so it is checked rather than assumed.
- `tests/foam.spec.ts` — Monahan coverage must still hold after the surface
  changes shape.

## Rejected

**Redistributing rings between the near and far field.** The geometric profile
gives `spacing = (L/R) × r` with `L = 10.6` fixed by the 0.6 → 24000 m range, so
halving the spacing requires either twice the rings or a 200× smaller radial
range — the first costs, the second gives up the horizon. Band-limited, the mesh
still carries the 20 m energy-peak swell out to roughly 250 m, which is where
this shot lives. Item 2 wins the same ground at no cost.

**A projected grid or GPU tessellation.** Constant screen-space triangle size by
construction, and the structurally correct answer to faceting at grazing angles.
Rejected for scope: it discards the reason `OceanMesh` is radial in the first
place — a camera-locked grid swims through a world-space wave field as the camera
turns — and it would rewrite the LOD structure that items 1 and 2 are calibrating.
Worth revisiting only if the band-limit proves insufficient.

**Widening the foam threshold by its own footprint.** Already tried twice and
rejected on measurement; see the note at `OceanMaterial.ts:1481`. Not revisited.
