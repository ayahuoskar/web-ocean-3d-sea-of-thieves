# Lens flare, depth of field, bloom, colour grade — and a cinematic tour that shows the whole world

Design, 2026-08-04.

## Why

Five things are being asked for, and they are related in one direction: the last
three depend on the first two existing.

1. Lens flare above water.
2. Depth of field, colour grading and bloom.
3. Recapture the README's main screenshot so the ship is in frame with the island
   behind it.
4. Recapture the reef screenshot so the fish are actually in it.
5. Audit the cinematic tour against the scene's highlights, and fix what it
   misses.

### The audit, first, because it decides the scope

The tour in `src/cameras/Cinematic.ts` is six beats over 120 s.

| Highlight | Covered today |
|---|---|
| Ship under way, wake, buoyancy | yes — `open-water`, `ascent` |
| Island, cove, jetty, fort | yes — `landfall` |
| Reef, coral, fish | yes — `reef-run` |
| Underwater, Snell's window, god rays | yes — `reef-run` |
| Sun movement | partial — `TOUR_HOUR_SWING = 4.2` sweeps only 08:18 to 16:42 |
| Sunset, night, moon, stars | **no** — the tour never reaches them |
| Weather change | **no** — the tour never touches `Weather` at all |
| Shore break, surf zone | **no** — `landfall` flies at 55–96 m and never comes down |

So the answer to (5) is no, with two hard gaps and two soft ones. The decision
taken is the largest of the three options offered: add the missing beats *and*
re-author the existing six against the new light and weather.

### The look, decided

Restrained and physical. Whatever the default look is, is what the README shows —
the repository's own claim is that every gallery image is regenerated from the
current renderer by one command, and grading the screenshots differently from the
app would quietly make that false. So there is one look, and it is tuned to be
visibly better without reading as a filter.

---

## Part A — the post chain

### Placement

Today:

```
scenePass ─┬─ colour → UnderwaterPass → VolumetricFog ──rtt──► LensRain → outputNode
           └─ depth ──────────────────┘
```

After — one linear chain, with `scenePass`'s depth texture tapped by three stages:

```
scenePass.colour
  → UnderwaterPass  (depth)
  → VolumetricFog   (depth)
  → rtt
  → DepthOfField    (depth)          NEW
  → rtt   ─ call this `focused`
  → focused + Bloom(focused)         NEW
  → + LensFlare     (depth)          NEW
  → ColorGrade                       NEW
  → rtt
  → LensRain
  → outputNode
```

Two `rtt` resolves are added, to three total. Both are forced, not chosen:
`DepthOfField` and `Bloom` re-sample the image at offset coordinates, and a
composited colour node has no `.sample()`. This is the same constraint `LensRain`
already documents, and getting it wrong is silently fatal rather than merely
wrong — the frame comes out black.

`LensRain` stays last, for the reason its existing comment gives: droplets are
lenses, and what they should refract is the finished image.

### Everything here runs in linear HDR

`RenderPipeline` applies `renderer.toneMapping` (ACES) and the sRGB conversion
*after* `outputNode`, because `outputColorTransform` defaults to true. Three
consequences, all of them good:

- Bloom thresholding near 1.0 is physically meaningful — it selects light that
  genuinely exceeded the sensor, not light that merely looks bright after the
  tone curve.
- The colour grade lands before the tone curve, so it shapes what ACES then
  compresses rather than fighting the compression afterwards.
- The lens flare is summing real radiance, so it warms and dims with the sun
  rather than needing a separate authored ramp.

### A1. `src/post/DepthOfField.ts` — hand-written

Three ships `DepthOfFieldNode`, and it is not usable here: its `focalLengthNode`
means "how far an object can be from the focal plane before it is completely out
of focus", which is an artistic range and not a lens. There is no way to drive it
from a real aperture.

The circle of confusion is computed from the thin-lens equation:

```
f     = (sensorHeight / 2) / tan(fovY / 2)        focal length, metres
A     = f / N                                     aperture diameter, N = f-number
c(d)  = A · f · |d − focus| / (d · (focus − f))   CoC diameter on the sensor
r_px  = c(d) · (frameHeightPx / sensorHeight) / 2 CoC radius in pixels
```

`sensorHeight` is 24 mm (full-frame). `fovY` is the live camera's, so the CoC
stays correct if the field of view is ever changed. `r_px` is clamped to a
tier-scaled maximum.

Gather is a single pass: a golden-angle spiral of `dofSamples` taps out to
`r_px`, each tap weighted by whether *its own* CoC reaches the centre pixel. That
rejection is what stops a blurred foreground from bleeding over a sharp
background, and it is the one part of a cheap DOF that cannot be skipped without
it looking broken at every silhouette.

Focus distance comes from a new `CameraDirector.focusDistance()`:

| Mode | Focus |
|---|---|
| orbit | distance to the orbit target |
| boat | distance to the chase target (the hull) |
| cinematic | distance to the beat's look point — closed-form, so it stays deterministic |
| fly | the view ray's intersection with the wave surface via the sampler, else a default |

At a restrained aperture and this field of view the effect is deliberately
subtle: the frame plane is sharp, and only genuine near foreground and the far
horizon soften. The f-number is a tuned constant, adjusted against real captures
rather than asserted here.

### A2. Bloom — three's `bloom()` node, thinly wrapped

`BloomNode` is a five-level mip pyramid with separable Gaussians, and
reimplementing it would buy nothing. It is used as
`base.add(bloom(base, strength, radius, threshold))` — the node returns the bloom
contribution, not a composited image.

The wrapper (`src/post/Bloom.ts`) exists only to own the tier plumbing and to
record *why* this one stage is bought rather than built, so the next reader does
not have to rediscover it.

### A3. `src/post/LensFlare.ts` — hand-written

Three's `LensflareNode` is the John Chapman pseudo-flare: it takes the bloom
texture and pivots ghosts around screen centre from *any* bright spot. On this
scene every whitecap would throw a ghost chain. It is the wrong effect here.

Instead:

- **Anchor.** `atmosphere.sunDirection` projected to screen UV on the CPU, once
  per frame, into a uniform. No readback.
- **Occlusion.** A small disc of taps on the scene depth texture around the sun's
  UV; a tap is clear if it reads at or near the far plane. The clear fraction,
  smoothed, is the visibility term — so the island, the hull and the rigging
  cut the flare rather than it floating over them.
- **Gates.** `(1 − submersion)`, which is what makes it above-water only as asked;
  a smoothstep on sun elevation so it dies at the horizon; and a soft radial
  falloff past the frame edge so it fades out instead of popping when the sun
  leaves shot.
- **Elements.** A tight halo at the sun, three tinted ghosts along the
  sun→centre vector, one faint anamorphic horizontal streak, and a very slight
  full-frame veil. Aspect-corrected so ghosts stay round.
- **Colour.** Scaled by `atmosphere.sunColor × sunLight.intensity`, so it warms
  through sunset and is gone at night without a separate authored curve.
- **Moon.** The same path at a much smaller weight, because the tour now spends
  time at night and a bare moon disc reads flat.

### A4. `src/post/ColorGrade.ts` — hand-written

ASC CDL, which is the standard and is defined on linear values:

```
out = clamp(in · slope + offset, 0, ∞) ^ power
out = mix(luma709(out), out, saturation)
```

`Preset` gains a `grade` field:

```ts
grade: {
  slope: THREE.Color;
  offset: THREE.Color;
  power: THREE.Color;
  saturation: number;
}
```

defaulting to identity — `slope 1, offset 0, power 1, saturation 1` — so a preset
that declares nothing renders bit-identically to before the pass existed. Each
preset then gets a grade that reinforces what it already is: warmth into sunset,
a cool desaturation at moonlit, lifted blacks and lower saturation in storm, a
flattened curve in foggy.

The grade is *not* a second exposure control. `toneMappingExposure` already
carries that per preset and stays where it is.

### A5. Quality tiers

`QualitySettings` gains three fields, following the existing convention that a
tier expresses an effect as a cost knob rather than the renderer toggling
anything globally:

| Field | low | medium | high | ultra | max |
|---|---|---|---|---|---|
| `dofSamples` | 0 | 8 | 16 | 24 | 32 |
| `bloom` | 0 | 1 | 1 | 1 | 1 |
| `lensFlare` | 0 | 1 | 1 | 1 | 1 |

`dofSamples: 0` is a bit-exact pass-through, matching how `fogSteps: 0` and
`godRaySteps: 0` already behave.

The *strength* of each effect is not a tier knob. Tiers decide whether an effect
is affordable; the preset and the module constants decide what it looks like.
This mirrors `refraction` and `reflection`, which are policy at Low and look
everywhere else.

### A6. What is deliberately not being built

- **No new panel controls.** These stages are part of the look, in the same class
  as tone mapping, and the panel is already dense. The tier scales them and the
  fallback policy covers WebGL2.
- **No LUT grading.** `Lut3DNode` exists, but per-preset LUTs are nine new binary
  assets for something an analytic CDL does exactly as well.
- **No separate "cinematic" look profile.** One look, so the gallery and the tour
  are the same renderer — see "The look, decided" above.

### A7. WebGL2

All four stages are TSL and should compile on the WebGL2 backend. The existing
fallback policy applies if any of them does not: a coherent simpler image beats a
broken richer one, so a stage that misbehaves is disabled on that backend the way
`refraction` and the planar reflector already are. This is a contingency, not a
plan — the intent is that all four run.

---

## Part B — the screenshots

### B1. The main screenshot

`docs/images/hero.png` exists and the README references it nowhere; line 8 points
at `island.png`, which also appears again mid-page as the terrain frame. So the
hero slot is free.

A new canonical shot **`ship-and-island`** fills it. The camera sits seaward of
the hull, looking down the island's bearing from the origin — roughly
`(−0.83, −0.56)`, since `ISLAND` is at `(−1150, −780)` — so the ship is in the
near third of the frame and the island fills the background about a kilometre and
a half beyond it. The island subtends roughly 39° at that range against the ~86°
horizontal field of a 55° vertical FOV at 16:9 — a little under half the frame
width, so it reads as a landmass rather than a smudge.

`island-approach` does **not** move. Its framing is derived from the reference
brief in `docs/ref/`, its comment records three attempts at getting the distance
right, and it is the frame the terrain and planting are tuned against. It keeps
`island.png` and its place mid-page.

README line 8 repoints to `hero.png`. `clear-day-wide`, which was the orphaned
hero, gains a proper row in the gallery table so the reference image is visible
somewhere.

### B2. The reef screenshot

`reef-dive` is retuned rather than replaced — the shot's purpose is unchanged, it
is simply not achieving it. Its own comment records two previous failures: the
first pointed the camera away from the school, and the second framed it at thirty
metres where a 0.42 m fish through 45 m visibility water is four pixels.

The camera will be chosen against measured numbers, not guessed: `FishSchool`
publishes `object.userData.schoolCentres`, and the harness can read it. The aim
is a school at close enough range to be unmistakably fish, with coral in the same
frame.

### B3. New shots

Three, mirroring the existing `cinematic-reef` / `cinematic-landfall` pattern —
a canonical shot pinned to a new beat's middle key, so each new beat is
regression-covered and has a gallery image:

- `cinematic-surf`
- `cinematic-squall`
- `cinematic-night`

Their comments must carry the same warning the existing two do: these copy beat
keys verbatim, and if a beat moves, they move with it.

### B4. Baseline regeneration

Bloom and depth of field change every pixel of every frame, so all twelve
existing baselines regenerate, plus four new ones. Order matters:

1. **Re-measure the noise floor** — `MEASURE_NOISE=1 npx playwright test
   --project=visual`. It cannot be assumed unchanged: the bloom pyramid samples a
   neighbourhood, and crest sparkle is exactly the stochastic term
   `MEASURED_NOISE_FLOOR` exists to record. Paste the measured block; do not widen
   the gate by hand.
2. **Regenerate baselines** against the new renderer.
3. **Regenerate the gallery** — `CAPTURE_GALLERY=1`, on the real GPU. The gallery
   test already skips on a software rasteriser, which is the correct behaviour and
   must not be worked around.

`docs/VERIFICATION.md` records the noise-floor values and the stack they came
from; it is updated with the new measurements.

---

## Part C — the cinematic tour

### C1. Beats

Nine, from six. The three new ones close the audit's gaps; the existing six are
re-timed against the new light rather than left where they were.

| Beat | Role | New? |
|---|---|---|
| `open-water` | ship at speed, wake as subject | re-timed |
| `outbound` | crane astern, run for the island | re-timed |
| `landfall` | cove, jetty, pinnace, fort from the air | re-timed |
| `surf-line` | the shore break from inside the surf zone | **new** |
| `return` | back to the plateau, down onto the water | re-timed |
| `squall` | rain, dark cloud, wet lens, flat light | **new** |
| `night-watch` | moon glitter, stars, the ship under moonlight | **new** |
| `reef-run` | reef, coral, fish, god rays | re-timed |
| `ascent` | up through the surface, re-acquire the hull | re-timed |

Exact durations, keys and throttles are authored during implementation. Two
properties are not negotiable and are checked by tests: the knot ring stays
cyclic and C¹ so the loop has no seam, and the hull's circuit still closes.

### C2. The environment curves

`CinematicDirector` grows a `CinematicEnvironment` alongside the pose and the
ship input:

```ts
interface CinematicEnvironment {
  hours: number;          // 0..24, reshaped periodic curve
  rain: number;           // 0..1, peaks on the squall beat
  cloudCoverage: number;  // 0..1, rises into the squall
  fogDensity: number;     // slider units, small rise in the squall
}
```

Every one is a **pure periodic function of the loop clock**, continuous in value
and in derivative at the wrap. That is the same rule `timeOfDayHours` already
follows and for the same reason: `resetClock(t)` must reproduce a frame exactly,
lighting and weather included, or every cinematic baseline becomes a function of
how many frames ran before it.

`hours` stops being a single sine. A pure sine has to choose between reaching
night and dwelling in day, and it puts the extreme wherever the phase lands —
which, at the current phase, is the middle of the underwater run, where night
means a black frame. The replacement is a small sum of harmonics with a chosen
phase: it dwells in day through the island beats, sweeps through sunset on
`return`, sits at night for `night-watch`, and comes back at dawn for `reef-run`.
Still periodic, still C¹, still closed-form.

### C3. The tour will not change the wave spectrum

Stated plainly because it is a real limitation and not an oversight.

`OceanSimulation.updateSpectrum` regenerates the initial spectrum on the CPU for
every cascade — 256² complex values times three at High — and re-uploads all of
them. That is a multi-millisecond hitch, and a moving camera is the worst place
in the application to spend it. Ramping wind speed through the squall would put
one of those on every frame the ramp touched.

So the squall's weather is carried by everything that *is* a uniform write: rain
intensity, the whitecap deposit rate through `Wake.setBreaking`, rain agitation,
`SurfaceWetness`, cloud coverage and the cloud shadow field, volumetric fog
density, and the key light dimming under the overcast. The base sea state for the
tour is chosen lively enough that a squall over it reads as weather rather than
as rain on a millpond.

If this proves too weak in the captures, the fallback is a stepped spectrum
change at a single beat boundary — one hitch per loop instead of sixty per
second — and that trade is made against real frames, not in advance.

### C4. The environment cube must follow the sun

Today the tour drives `Atmosphere.setParams` directly every frame and never calls
`updateEnvironment`. Across an 08:18–16:42 sweep the frozen IBL is close enough
that nothing shows. At night it is badly wrong: every PBR surface in the scene —
hull, rigging, cannon, wet rock — would still be lit by a noon sky while the
visible sky is black.

`updateEnvironment` already early-outs on an internal dirty flag and renders only
the sky mesh into a 128 px cube, but the PMREM rebuild that follows is the real
cost. It is therefore re-captured on a **sun-elevation delta threshold**, not
every frame: enough to keep the fill honest through sunset and into night,
infrequent enough not to be felt.

### C5. The hull's circuit must stay over the plateau

`TRACK_RADIUS = TOTAL_ARC / (2π)` — that identity is what makes the circuit close,
and it means the radius grows with the loop length. At today's throttles a 165 s
loop would take the radius from 161 m to about 222 m, putting the ship's far
point at 444 m: off the 320 m shallow plateau, over deep water, with nothing
under it to look at.

The new beats therefore carry low throttles, chosen so the radius stays under
about 180 m. This is a constraint on the authoring, and it is written down here
because the failure mode is silent — the tour would still loop perfectly and
would simply have sailed somewhere boring.

### C6. Tests

- The existing seam test in `tests/ocean.spec.ts` applies unchanged; the curve is
  still a cyclic C¹ spline.
- New: the environment curves are continuous at the wrap, to the same standard the
  pose is held to.
- New: the tour actually reaches what it claims — sun elevation goes negative
  somewhere on the loop, and rain exceeds zero somewhere on the loop. Without
  these, a future edit could quietly flatten the curves back and every other test
  would still pass.

---

## Files

**New**

- `src/post/DepthOfField.ts`
- `src/post/Bloom.ts` (wrapper over three's `bloom()`)
- `src/post/LensFlare.ts`
- `src/post/ColorGrade.ts`

**Changed**

- `src/main.ts` — post chain assembly, per-frame parameter feed, tier application,
  the tour's environment application, throttled environment re-capture
- `src/cameras/Cinematic.ts` — beats, environment curves
- `src/cameras/CameraDirector.ts` — `focusDistance()`, environment pass-through
- `src/core/QualityManager.ts` — `dofSamples`, `bloom`, `lensFlare`
- `src/presets/index.ts` — `Preset.grade`, nine grades
- `tests/lib/shots.ts` — `ship-and-island`, retuned `reef-dive`, three new
  cinematic shots, re-measured noise floor
- `tests/gallery.spec.ts` — gallery mapping
- `tests/ocean.spec.ts` — new tour assertions
- `README.md` — hero image, gallery table
- `docs/VERIFICATION.md` — new noise-floor measurements
- `docs/SPEC.md` — the post chain is no longer only "fog, god rays, colour grade"

**Regenerated**

- All of `tests/baselines/`, all of `docs/images/`

## Success criteria

1. Lens flare appears above water, anchored to the sun, occluded by geometry, and
   absent below the surface and at night.
2. Depth of field, bloom and colour grading are present, tier-scaled, and off at
   Low as a bit-exact pass-through.
3. The README's main image shows the ship in frame with the island behind it.
4. The reef image shows fish unmistakably.
5. The cinematic tour visits ship, island, shore break, reef, underwater, a
   weather change, and a full day into night and back — and still loops without a
   seam.
6. `npm run typecheck` and `npm test` pass, with baselines regenerated against a
   re-measured noise floor rather than a widened gate.
