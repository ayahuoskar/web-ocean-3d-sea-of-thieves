# Fidelity gap analysis — our renderer against the Shadertoy reference set

Rebuilt 2026-08-05 with the reference shaders **rendered and looked at**, not
only read. The first draft of this document was written from source alone and
got its ranking wrong in three places; those corrections are marked ⚠ below.

**Method.** All thirteen shaders in `research/shadertoy/` (31 renderpasses,
~6,900 lines) read end to end, then captured live at 1280×720 on this machine's
GPU via `scripts/capture-shadertoy.mjs`, then compared frame-by-frame against our
own gallery at Max. Open `research/shadertoy/compare.html` for the pairs.

**Nothing here copies reference source.** The set is CC BY-NC-SA at best and All
Rights Reserved for `DdKyR1`. Every item names a *technique* and cites where it
was observed; all are published elsewhere (iq's articles, the Frostbite and
Horizon Zero Dawn course notes, Hosek–Wilkie, Bruneton).

---

## 0. Where we already lead

Stated first because it changes what is worth spending effort on.

| Area | Us | Best reference |
|---|---|---|
| Water BRDF | Anisotropic Trowbridge–Reitz **D**, height-correlated **anisotropic Smith V**, Fresnel on the half-vector, dual-source specular AA | `4dSBDt` has `D_GGX` alone — no V, no F. `lt3GWj`, `4ljXWh`, `WtfyWj` use `pow(dot(reflect,l), n)`. |
| Wave field | FFT/JONSWAP, three cascades, Jacobian foam, per-band choppiness | Every reference is TDM's `sea_octave` — a sum of `abs(sin)` products. No spectrum, no fold. |
| Transmission | Depth-buffer column thickness, secant-corrected to the view ray, per-channel Beer–Lambert, HG subsurface on the *same* extinction | `Nt3XDM` does Beer's law on a refracted march. `lt3GWj` is a Fresnel lerp of two constants. |
| Surface from below | Snell's window via the real air-side angle, TIR sampling the backdrop | **No reference does this at all.** |
| Volumetric fog | Closed-form height transmittance, energy-conserving segment integration, step-count-independent opacity | `Nt3XDM` marches uniformly; `MdGfzh` uses Hillaire integration for clouds only. |
| Determinism | Every animated quantity is a closed form of a resettable clock | Irrelevant to them — and it is why we cannot simply adopt their TAA. |

The gaps are **not in the water's shading model**. They are in the land, the air,
and the light between things.

---

## 1. What the frames actually show

### Ours

**`surf.png` — the most damaging frame in the gallery.** At this range the
terrain's construction is visible directly:

- The **mesh triangulation is legible** across the beach as broad flat facets.
  `new Seafloor(4000)` with the default 256 segments is **15.6 m between
  vertices**, and normals come from `computeVertexNormals()`, so that is the
  finest slope the surface can express.
- The **sand normal map is smeared into horizontal streaks** on the sloped beach.
  It is sampled planar on world XZ (`positionWorld.xz * 1/13`, `* 1/47`), so it
  stretches by `1/cos θ` on any slope and degenerates entirely on steep ground.
- **Nothing on land casts or receives a shadow.** The palms, the beached ship,
  the rocks, the hill itself — all evenly lit. The hillside is a pure gradient.
- The canopy billboards resolve into **individual round sprites** — the
  "bubble-wrap" read.

**`clear-day.png` — ⚠ correction to the first draft.** I ranked surface aliasing
fifth. It is the most visible defect in the gallery. The entire mid-field is
hard-edged white blobs and dark holes, with no gradient at their boundaries; it
reads as torn paper rather than water. `island.png` shows the same failure as
scratchy stripes and `sunset.png` as dark speckle holes. Same cause, three
appearances.

Also visible here: clouds are **uniformly sized puffs at uniform spacing** all
the way to the horizon, where they stop abruptly into a haze band.

**`waves.png`** — a band of **khaki-grey scratches across the mid-distance
water**, roughly 200–400 m out. That is beach-coloured, and it is the refracted
backdrop: over the 17 m plateau `absorption` stays high, so the refracted
seafloor shows through at close to full contrast, carrying the sand normal map's
aliasing with it. Also a visible **step in the sky gradient** near the horizon.

**`reef.png`** — **no caustics and no light shafts are visible at all**, despite
both systems being present and enabled. Fog has flattened the whole frame to one
teal value with almost no local contrast. Corals sit on the sand with **no
contact darkening**, so they read as pasted on. Diagonal hatching in the sand
upper-left.

**`underwater.png`** — the hull is a flat black cutout with no caustics and
almost no ambient; the Snell window boundary is hard and the surface's triangles
are visible as facets from below.

**`storm.png`** — the frame is **almost fully monochrome**; overcast desaturation
has removed the sea's colour entirely. Lens-rain droplets are large, uniform, and
sit on an *unblurred* backdrop, so they read as decals rather than lenses.

### Theirs

**`4ttSWf` (Rainforest, iq)** — ridges, gullies, cliff bands, a lit face against
a shaded face, and forest that varies in tone across the hillside.

**`Nt3XDM` (Niolon, XT95)** — the clearest AO demonstration in the set. Every
crevice, every underside of the arch, every rock-to-rock contact is darkened, and
that is what gives the geometry mass. Rock is **triplanar**, so overhangs and
vertical faces carry the same detail as flat ground. Light shafts through the
arch. Strong aerial perspective inside the opening.

**`MdGfzh` (Himalayas, reinder)** — four ridgelines readable *purely by haze
depth*.

**`4dSBDt` (Enscape Cube)** — the cloud deck converges into the horizon, puffs
shrinking and crowding into a warm haze band. Object reflection visible in the
water.

**`WtfyWj` / `4ljXWh`** — prominent god-ray shafts descending from the surface,
with the seabed brightest where they land. `4ljXWh` keeps strong local contrast
*and* a strong depth gradient; ours has neither.

**`ldj3Dm` (iq)** — the fish **casts a soft shadow on the seabed**. One shallow
carangiform bend, confirming our gait fix.

**⚠ Correction to the first draft.** I wrote that "every reference solves
[aliasing] the same way — temporal accumulation". `lt3GWj` has no TAA and is
still perfectly clean, because it carries **no high-frequency ripple band at
all** — its `sea_octave` sum has nothing near pixel scale. So the references are
clean for two different reasons, and only one is available to us: four of them
accumulate (`4ttSWf`, `MdGfzh`, `4dSBDt`, `Nt3XDM`), and the rest simply have
less detail than we do. Our speckle is the price of genuinely carrying three
cascades. That reframes the fix — see §6.

---

## 2. Ranked gaps

Reordered against the frames. ⚠ marks a change from the first draft.

| # | Gap | Domain | Impact | Effort | |
|---|---|---|---|---|---|
| 1 | Terrain has no relief; mesh facets and stretched detail are visible | terrain | ★★★★★ | M | |
| 2 | Nothing on land is shadowed or occluded | terrain, trees | ★★★★★ | M | |
| 3 | Surface aliasing — hard white blobs, stripes, speckle holes | ocean | ★★★★★ | M–L | ⚠ up from 5 |
| 4 | Cloud slab does not curve to the horizon; no vertical light gradient | clouds | ★★★★★ | S | |
| 5 | No aerial perspective on anything but water | all | ★★★★☆ | S | |
| 6 | Underwater is over-fogged; caustics and shafts invisible | underwater | ★★★★☆ | S | ⚠ up from 10 |
| 7 | No contact shadows or AO on any small object | reef, props, fish | ★★★★☆ | M | ⚠ new |
| 8 | Cloud lighting has no multi-scatter; coverage is spatially uniform | clouds | ★★★★☆ | S | |
| 9 | No god rays above water | sky, post | ★★★☆☆ | M | |
| 10 | Refracted seafloor bleeds through at mid distance | ocean | ★★★☆☆ | S | ⚠ new |
| 11 | Near vegetation is static; no leaf translucency | trees | ★★★☆☆ | M | |
| 12 | Cloud shadow reaches only the water | terrain, trees | ★★★☆☆ | S | |
| 13 | Overcast desaturates the storm to monochrome | sky | ★★★☆☆ | S | ⚠ new |
| 14 | Lens rain does not blur its backdrop, so drops read as decals | post | ★★☆☆☆ | S | ⚠ new |
| 15 | Preetham sky is being fought rather than used | sky | ★★★☆☆ | L | |
| 16 | IBL is a 128² sky-only capture | all | ★★☆☆☆ | S | |
| 17 | Waves do not shoal or refract toward the shore | ocean | ★★☆☆☆ | L | |

---

## 3. Terrain (gaps 1, 2)

**What we do.** `seafloorHeight` is four octaves of value noise at
`FEATURE_SCALE = 1/240`, `RELIEF = 11 m`, plus named structural terms (crest,
apron, headland, spit, bay, lagoon). Mesh: `PlaneGeometry(4000, 4000, 256, 256)`,
CPU-displaced, `computeVertexNormals()`. Detail normal: the *sand* map, planar on
world XZ. Shadow: a ±260 m box that follows the camera. AO: none — `Seafloor.ts`
says so and substitutes a constant `envMapIntensity = 0.78`.

**Why the dome is smooth.** The finest noise octave is ~`240 / 2.13³ ≈ 25 m`
against 15.6 m vertex spacing — at Nyquist. So the normal can only describe slope
over ~30 m, and there is no shading-rate detail on land at all.

**What the references do.**

- `4ttSWf` computes **analytic derivatives** through the whole chain — `noised()`
  returns value *and* gradient, `fbmd_9` accumulates `d += b*m*n.yz` carrying the
  octave rotation, and even the cliff `smoothstep` is differentiated by the chain
  rule (`smoothstepd`). Exact normals at any distance, free per vertex.
- It then adds a **bump octave to the normal at shading time**, gated on slope:
  `nor = normalize(tnor + 0.8*(1-abs(tnor.y))*0.8*fbmd_7(pos*0.15*vec3(1,0.2,1)).yzw)`.
  The `(1 - |n.y|)` weight is the trick — flat ground stays smooth, slopes get
  rock. The `vec3(1, 0.2, 1)` stretches it vertically, which reads as strata.
- `MdGfzh` uses **derivative-damped fbm**: `a += b*n.x / (1 + dot(d,d))`. iq's
  erosion approximation — octaves suppressed where the terrain is already steep,
  giving ridges and smooth valley floors. One line, and most of why those
  mountains look like mountains.
- `Nt3XDM` shows the cheap triplanar: `tex3D` blends three projections by
  `abs(n)`, and `bumpMapping` derives a normal from the **luminance gradient** of
  that blend — three extra taps, no normal-map asset needed.
- `MdGfzh` evaluates one heightfield at **different octave counts for different
  jobs**: 7 for the march, 15 for the shading normal, 5 for a fake shadow, and
  `terrainMap(10) - terrainMap(7)` for **ambient occlusion**.
- `4ttSWf` marches shadows properly: `terrainShadow` 32 steps with
  `res = min(res, 32*hei/t)` and `clamp(hei, 2+t*0.1, 100)`; plus `treesShadow`
  and a single-intersection `cloudsShadowFlat`.

**Proposed, in ratio order.**

1. **Octave-difference AO** — `fbmFn(p, 10) - fbmFn(p, OCTAVES)`, six extra taps
   on an fbm we already have as a TSL `Fn`. Multiply the terrain's ambient and
   env contribution by it. Puts depth in every hollow for almost nothing.
2. **Heightfield sun shadow as a TSL node** — we already have `nodes.height`; a
   24-step march with iq's soft accumulator is ~20 lines and shadows the whole
   island at any range, independent of the shadow box. This is what gives the
   hill a lit face and a shaded face.
3. **Derivative-damped fbm** in `fbm`/`fbmFn`. Both twins carry the octave
   rotation already; they must also carry `d`. Changes the island's *shape*.
4. **Analytic normals** from the same accumulation, replacing
   `computeVertexNormals()`. Decouples normal quality from the grid — worth more
   than any tessellation increase, and it removes the visible facets.
5. **Slope-gated triplanar rock detail**, weighted `1 - |n.y|`.
6. **Wire the existing `Clouds.shadowNode()` to the land** (gap 12). It is built
   and passed only to `OceanMaterial`.

---

## 4. Ocean surface aliasing (gap 3) ⚠

Three appearances, one cause: hard white blobs in `clear-day.png`, scratchy
stripes in `island.png`, dark speckle holes in `sunset.png`.

`OceanMaterial` is honest about the mechanism: a **scalar** geometric
specular-AA filter cannot know that a pixel's normal varies more along the wind
than across it, and `SPECULAR_AA_VARIANCE_CEIL = 0.004` is a ceiling on a
heuristic. But the frames show it is not only specular — the **foam mask** is
also aliasing. `crestFoam` is `smoothstep(0.12, 0.78)` over a Jacobian fold
biased by elevation, and at mid distance the fold field is undersampled, so the
mask flips fully on and fully off between neighbouring pixels. That is what makes
the blobs hard-edged rather than soft.

**Options, in the order I would take them.**

1. **Anisotropic (slope-space) NDF filtering.** Carry the 2×2 covariance of the
   shading normal's screen-space derivatives and add it to `alphaT`/`alphaB`
   *separately* rather than adding a scalar to `a2`. We already have an
   orthonormal tangent frame and both roughnesses. Single-frame, preserves
   determinism. ~40 lines in the existing specular block.
2. **Band-limit the foam mask by footprint.** Widen the `crestFoam` smoothstep
   with the same `lostSlopeVariance` the specular already computes, so the mask
   softens exactly where the fold field stops being resolved. Cheap, and it
   targets the blobs directly.
3. **Reconsider cascade 2's shading fade** (`[160, 420]` m). Cheap, costs real
   glitter.
4. **TAA with YCoCg neighbourhood clamping** — `4dSBDt`'s Buffer C is the exact
   recipe. It would fix this *and* soften the terrain facets and canopy edges.
   It breaks frame-exact determinism, which the whole visual harness rests on;
   the harness could instead resolve N frames from a rewound clock and compare
   the converged image, which is arguably a better test. **Filed as an option,
   not a recommendation** — it changes the testing contract, not just the
   renderer.

---

## 5. Clouds (gaps 4, 8, 12)

### The deck does not curve

`Clouds.buildCloudNode` intersects a **flat slab**, clamps the crossing to
`MAX_SPAN_FACTOR × thickness`, then fades everything with
`smoothstep(0.015, 0.075, rd.y)`. The result is `clear-day.png`: the field stops
in a band with clear sky beneath it.

Both volumetric references wrap the layer on a sphere, in about eight lines.
`MdGfzh`: `interectCloudSphere(rd, r) = -b + sqrt(b*b + r*r + 2*R*r)` with
`b = R*rd.y`, `R = 1.5e6`; the camera is lifted to
`ro.y = sqrt(R² - dot(ro.xz, ro.xz))` and the in-layer coordinate becomes radial.
`4dSBDt` is the same with `R = 6300e3`. Note `R` is a free parameter — reinder
uses 1,500 km rather than 6,371 km precisely because it exaggerates convergence
at a game's scale.

`MAX_SPAN_FACTOR` and `horizonFade` both become unnecessary; the sphere bounds
the crossing naturally, which was the actual reason grazing rays were a problem.
**Highest impact-to-effort item in the document.**

### The lighting is flat

Ours is `shadowColor * ambientGain + color * (lightT * phase * powder * sunGain)`
— and `shadowColor * ambientGain` is a **constant**, identical at the base of a
1,400 m column and at its top.

- **Height-graded ambient.** `MdGfzh`:
  `mix(vec3(39,67,87)*1.5/255, vec3(149,167,200)*1.5/255, norY)`. `4dSBDt`:
  `(0.5+0.6*h)*vec3(0.2,0.5,1.0)*6.5 + vec3(0.8)*max(0,1-2*h)`. This single
  substitution is most of what makes a cumulus read as a volume.
- **Multi-scatter.** `4dSBDt`:
  `exp(-x) + 0.5*s*exp(-0.1*x) + 0.4*s*exp(-0.02*x)` with
  `s = mix(0.008, 1.0, smoothstep(0.96, 0.0, mu))`. A single Beer term drives
  thick cloud to flat grey; the extra lobes keep the interior glowing.
- **Large-scale weather.** `4dSBDt` gates the fine field on a very low-frequency
  lookup, so the sky has clear regions and dense regions at the 20 km scale. Our
  `uThreshold` is one scalar over the whole hemisphere — which is exactly the
  uniform-puff field in `clear-day.png` and `waves.png`.
- **Fitted Mie phase.** `4dSBDt`'s `numericalMieFit` is four exponentials fitted
  to real Mie scattering. Our clamped `hg(0.76)*0.75 + hg(-0.2)*0.25` is
  reasonable, but the clamp to `[0.35, 3.2]` is damaging the forward peak.

### Low-sun cloud shadow

Already documented in `Clouds.shadowNode`: below ~14° elevation the single sample
lands outside the slab and the shadow *vanishes* rather than deepening. Sunset
and the tour's squall beat are exactly those cases. Fix is `Loop(3)` instead of
one sample.

---

## 6. Sky and aerial perspective (gaps 5, 13, 15)

### No aerial perspective on land

Three unrelated treatments: the ocean has `mix(color, uFogColor, 1-exp(-d))` with
an authored colour; `VolumetricFog` is a *sea* fog, off in clear presets; and
terrain, props, ship and canopy have **nothing at all**. That is why the island
in `waves.png` has foreground contrast at 1.4 km, and why `MdGfzh` can separate
four ridgelines by haze alone and we cannot separate two.

`4ttSWf`: `ext = exp2(-t * 0.00025 * vec3(1.0, 1.5, 4.0))` — **per-channel**
extinction, so distance shifts hue toward the sky rather than toward a grey
constant. `Xl2XRW` separates extinction from inscatter
(`k_vFogExt`, `k_vFogIn`), which is the physically correct split. `MdGfzh` and
`Nt3XDM` both use iq's height form `C*(1-exp(-t*rd.y*B))/rd.y`.

**Proposed.** One shared `aerialPerspective(color, distance, rayDir)` node in
`sky/`, per-channel, derived from the `uBetaR`/`uBetaM` the dome already
computes, applied to terrain, props, canopy, ship — and replacing the ocean's
`uFogColor`/`uFogDensity` pair. Deriving it from the sky's own coefficients is
what stops the horizon showing a step between sea, land and dome.

### Overcast is over-corrected ⚠

`storm.png` is nearly monochrome. `uOvercastDarken = 0.34` plus the dome's pull
toward `vec3(skyLuma) * uOvercastTint` plus the ambient's own desaturation
compound, and the water's reflection of that flat sky removes the last of its
colour. A real storm at sea keeps green-grey in the water. The tint exists
(`0.92, 0.96, 1.04`) but is applied to a luma that has already collapsed. Worth
re-deriving as a *partial* desaturation of the original chroma rather than a
replacement of it.

### Preetham is being fought

`Atmosphere.ts` carries three long comments that are the same complaint:
`TWILIGHT_CURVE` is a measured ten-point table compensating for the model's
collapse near the horizon; `SKY_CHROMA` is capped at 1.06 because Preetham's
linear red at 25° is already near zero and chroma extrapolation clips it to
black; `SKY_RADIANCE_SCALE` had to be re-derived when the grade moved. The
gradient step near the horizon in `waves.png` is the same model showing through.

**Hosek–Wilkie (2012)** is the drop-in: same shape of API, materially better
below 10°, and it takes ground albedo, which matters over water. **Bruneton** LUTs
are the larger answer and would make aerial perspective correct rather than
authored. Recommendation: Hosek–Wilkie now; Bruneton only if sunset and squall
still fail after everything else here.

### No god rays above water (gap 9)

`VolumetricFog`'s march has **no occlusion term at all** — its own header says
lighting varies only by a closed-form height transmittance and an HG lobe. So
there are no crepuscular rays through the cloud deck, none through the rigging,
none over the ridge.

`Nt3XDM` Buffer C is the recipe in ~30 lines: blue-noise jitter the start, ten
steps, evaluate a shadow function at each, weight by phase, composite at half
resolution. We already have the march, the jitter, the phase term and — via
`Clouds.shadowNode()` — a shadow function. **The occlusion term is the only
missing piece.** Underwater we already do this correctly; the above-water pass is
simply behind it.

---

## 7. Underwater (gaps 6, 7) ⚠

`reef.png` shows caustics and shafts that are *present in code and invisible in
the image*, under fog that has flattened the frame to one value.

1. **Fog is eating the scene.** `4ljXWh` keeps strong local contrast at the
   near seabed *and* a strong gradient to the far water. Ours loses local
   contrast first, which is the opposite ordering — a sign the extinction is too
   high at short range rather than the scene being too dark.
2. **Caustics never arrive.** `reach = smoothstepDown(depth, 2, 48)` should give
   a healthy factor at the reef's ~13 m, but whatever survives is then multiplied
   into a colour the fog has already collapsed. `4ljXWh`, `WtfyWj`, `Nt3XDM` and
   `ldj3Dm` all put caustics on *every* lit surface, and `WtfyWj` additionally
   modulates all material by `0.4 + 0.6*godLight(p, lightPos)`.
3. **Shafts are invisible.** `WtfyWj` and `4ljXWh` make them the dominant
   feature; ours are set up but do not read.
4. **No contact shadow or AO anywhere** (gap 7, new). Corals sit on sand with no
   darkening at their base. `Fish.ts:896` sets `castShadow = false`, and several
   `Props` scatters do the same — defensible for cost, but the *replacement*
   (a cheap AO or a fake contact darkening) was never added. iq's fish in
   `ldj3Dm` casts a soft shadow, and it is a large part of why it sits *in* the
   scene. `Nt3XDM`'s hemispherical SDF AO and `WtfyWj`'s two-tap `calcOcc` are
   both cheap enough to copy in spirit.
5. **The submerged hull is unlit.** `Caustics.intensityNode` is explicitly built
   to be shared ("a seafloor material, a rock material and a hull material") and
   is wired to the seafloor only.
6. **The Snell window posterises** — a hard `smoothstep(0.88, 1.0, sinT²)` and
   the surface's triangles visible as facets from below.

---

## 8. Trees (gap 11)

`island.png` and `surf.png` both show it: identical round blobs at identical
tone, and palms that never move.

1. **The near trees are completely static.** Only the billboards sway.
   `Canopy`'s model is right — shear by `corner.y²`, one travelling gust wave so
   neighbours move together — and needs applying to the instanced tree materials.
2. **No leaf translucency.** `Props` records that the old procedural palm faked
   transmission through `emissiveNode` and that it was removed for being neither
   shadowed nor tone-mapped. Correct call, wrong conclusion: the right term is a
   wrapped back-scatter *inside* the lit material, so it takes the shadow and the
   tone curve. `4ttSWf` does the cheap version — `dif *= a + (1-a)*sha2`, so
   canopy shadow is partial rather than binary — plus a fresnel rim
   `1.10*vec3(0.9,1.0,0.8)*pow(fre,5)*occ` that fades past 200 m.
3. **All cards share two colours.** `CARD_VARIATION` jitters *size* by ±42% but
   colour is `mix(shade, sunlit, cornerY)` with no per-instance term, so 24,000
   cards are two tones. `4ttSWf` gives each tree `oMat = 0.5*hash1(cell)` plus a
   `brownAreas = fbm_4(pos.zx*0.015)` field mixing dry patches across the whole
   forest. Two lines, large payoff.

---

## 9. Smaller, concrete items

**Refracted seafloor bleeds at mid distance (gap 10, new).** The khaki band in
`waves.png`. Over the 17 m plateau `absorption` stays high 200–400 m out, so the
backdrop shows through at close to full contrast and brings the sand normal's
aliasing with it. Fading `uRefractionAmount` with view distance — the same
argument the cascades' shading fade already makes — should close it.

**Lens rain does not blur its backdrop (gap 14, new).** `LensRain` has only a
"four-tap ring" mist blur (`LensRain.ts:541`), so droplets sit on a sharp scene
and read as decals. `DdKyR1`'s defining move is *differential* blur:
`Blur = mix(MinBlur, MaxBlur, ...)` sampled through `textureLod`, so the world is
soft **outside** drops and each drop shows a sharp refracted micro-image. That
inversion is the entire effect.

**IBL is sky-only (gap 16).** `Atmosphere.updateEnvironment` captures the dome at
128² with the sun suppressed — no clouds, no sea, no island. Cheapest fix: put
the cloud dome in `envScene` (it is already a camera-locked mesh) and go to 256².

**Waves do not shoal (gap 17).** Our surf is a depth-driven foam band — McCowan's
criterion, parabolic bore, travelling sets — and it reads well in `surf.png`.
What is missing is that the wave *field* is unaware of the seabed, so swell never
refracts to arrive parallel to the beach. No reference does this either; it is
ranked last for that reason.

---

## 10. Sequencing

**Phase A — the land reads as land** (gaps 1, 2, 12)
Octave-difference AO → heightfield sun shadow → cloud shadow on land →
derivative-damped fbm → analytic normals → slope-gated triplanar detail.
Ordered so the two cheapest, highest-impact items land first and the
shape-changing ones last.

**Phase B — the air reads as air** (gaps 4, 5, 8, 9, 13)
Spherical cloud layer → height-graded ambient → three-term Beer → low-frequency
coverage → shared per-channel aerial perspective → cloud occlusion in the fog
march → overcast chroma re-derivation.

**Phase C — the surface holds up** (gaps 3, 10)
Anisotropic NDF filtering → footprint-widened foam mask → distance-faded
refraction. Decide on TAA separately and explicitly.

**Phase D — the detail** (gaps 6, 7, 11, 14, 16)
Underwater fog re-balance → caustics and ambient on submerged geometry → cheap
AO on reef instances → tree wind → leaf translucency → per-instance canopy
variation → lens-rain differential blur → clouds in the env capture.

**Phase E — the hard ones** (gaps 15, 17)
Hosek–Wilkie; wave shoaling. Each is genuine research; decide after A–D.

---

## 11. What this costs the test suite

- **Phase A changes the island's shape** (items 3–4). Every visual baseline
  containing the island regenerates, `tests/visual.spec.ts` noise floors
  re-measure, and the tour's surf-beat keys — authored on bearings and radii
  against a 500 m shore — must be re-verified against the new `shoreFraction`.
  The first three items (AO, shadow, cloud shade) change *shading only* and can
  land first with a cheaper baseline pass.
- **Phase B changes every frame with sky in it**, which is all of them.
- **Phase C** changes the water everywhere; the noise floors will move, and
  `storm` and `boat-chase` are already the two most sensitive shots.
- **Phase D** is mostly local and additive.
- **TAA, if chosen, changes the determinism contract** that `resetDeterministic`
  and the whole capture harness rest on. That is a decision about the project's
  testing philosophy, not a rendering change.

Regenerate baselines once per phase, not once per commit.
