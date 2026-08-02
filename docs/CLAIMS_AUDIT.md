# Claims and wiring audit

Every advertised feature, UI control, quality setting, documentation claim and
gallery screenshot in this repository, mapped to the code that implements it,
the evidence that it works, and what was done about it.

**Method.** Each row was verified by reading the implementation path and, where
the claim is visual, by rendering it. The live inspection ran on the hardware
recorded in `docs/PERFORMANCE.md` at 1600 × 900, DPR 1, WebGPU backend, quality
High. Grep counts are whole-repository (`src/`) reference counts, so a setting
that appears only in its own type definition and tier table has **no consumer**.

**Status vocabulary.**

| Status | Meaning |
|---|---|
| **WIRED** | Connected to the real render or input path, and observably affects the result |
| **PARTIAL** | Connected, but does materially less than the claim states |
| **DEAD** | Declared and never read; no effect at any tier |
| **ABSENT** | Claimed in documentation, no implementation exists |
| **UNVERIFIED** | Implemented, but the evidence offered for it does not exist or cannot be trusted |

---

## 1. Quality tier settings

`src/core/QualityManager.ts` — `QualitySettings`, five tiers.

| Setting | Consumer | Status | Evidence | Action |
|---|---|---|---|---|
| `fftSize` | `main.ts:312` → `OceanSimulation.resize` | WIRED | Cascade targets reallocate; `peakWaveHeight` readback changes | Keep |
| `cascades` | `main.ts:312` → `OceanSimulation.resize` | WIRED | `activeCascadeCount` follows the tier | Keep |
| `meshRings` | `main.ts:328` → `OceanMesh` | WIRED | Triangle count changes in `renderer.info` | Keep |
| `meshSegments` | `main.ts:329` → `OceanMesh` | WIRED | As above | Keep |
| `cloudSteps` | `main.ts:334` → `Clouds.setParams` | WIRED | Raymarch bound is a uniform loop count | Keep |
| `godRaySteps` | `main.ts:401` → `UnderwaterPass.setParams` | WIRED | `uSteps` drives a dynamic `Loop` bound; 0 zeroes strength | Keep |
| `shadowMapSize` | `main.ts:335`, **as a boolean only** | PARTIAL | `renderer.shadowMap.enabled = size > 0`. The light is hardcoded to `2048` at `Atmosphere.ts:291`, so Low↔Max never changes shadow resolution | **Wire to the light's `shadow.mapSize`, with deterministic shadow-map disposal on change** |
| `underwaterParticles` | `main.ts:156`, **construction only** | PARTIAL | `UnderwaterParticles.setCount()` exists (`Particles.ts:136`) and is never called. Changing tier at runtime leaves the original count | **Call `setCount` from `applyQuality`** |
| `ssrEnabled` | none — 6 refs, all self | DEAD | Every reference is inside `QualityManager.ts` | **Deleted.** Reintroduced later by the reflection work as a real tier policy |
| `causticsEnabled` | none — 6 refs, all self | DEAD | Caustics are unconditionally injected at `main.ts:162` | **Deleted.** Replaced by a real per-tier caustics policy |
| `bloomEnabled` | none — 6 refs, all self | DEAD | No bloom node exists anywhere in the post chain | **Deleted.** No bloom is claimed after this pass unless one is implemented |
| `fishCount` | none — 6 refs, all self | DEAD | No fish system exists; `scene/Fish.ts` does not exist | **Deleted**, with the matching `SPEC.md` F19 claim |
| `renderScale` | none — 6 refs, all self | DEAD | Pixel ratio comes solely from the UI slider (`main.ts:284`) | **Deleted.** A tier-driven render scale would fight the user's explicit slider |

## 2. UI controls

`src/ui/Panel.ts`, `src/ui/Hud.ts`, `src/ui/types.ts`.

| Control | Handler | Status | Evidence | Action |
|---|---|---|---|---|
| Quality select | `onStateChange` → `applyQuality` | WIRED | Rebuilds simulation, mesh, material | Keep |
| Preset select | → `applyPreset` | WIRED | 9 presets each move sun, sea, water, fog, weather | Keep |
| Wind Speed slider | → `updateSpectrum` | WIRED | Asserted by `sliders drive the simulation` | Keep |
| Peak Wavelength slider | → `updateSpectrum` | WIRED | As above | Keep |
| Cloud Coverage slider | → `Clouds.setParams` | WIRED | Visible coverage change | Keep |
| Pixel Ratio slider | → `renderer.setPixelRatio` | WIRED | Canvas backing store changes | Keep |
| Buoyancy Probes toggle | → `Ship.setDebugProbesVisible` | WIRED | Four spheres appear | Keep |
| Wake Probes toggle | → `Wake.setDebugVisible` | WIRED | Magenta overlay appears | Keep |
| Force WebGL toggle | → reload with `?webgl=1` | WIRED | Asserted by `falls back to WebGL2 and still renders` | Keep |
| Camera mode 1 / 2 / 3 | → `CameraDirector.setMode` | WIRED | Asserted by `camera modes switch via keyboard` | Keep |
| HUD hint "Throttle **W S**" (Boat) | **none** | ABSENT | `Hud.ts:41`. Boat mode is a chase camera; `Ship.update()` only billows sails | **Implement the ship controller** (Phase 3) |
| HUD hint "Steer **A D**" (Boat) | **none** | ABSENT | `Hud.ts:40`. Same | **Implement the ship controller** (Phase 3) |
| HUD hint "Camera **Mouse**" (Boat) | **none** | ABSENT | `Hud.ts:42`. Chase camera ignores the mouse entirely | **Implement or correct the hint** (Phase 3) |
| "View Source" button | `href="#"` | DEAD | `Panel.ts:213` | **Point at the repository or remove** |
| "Documentation" button | `href="#"` | DEAD | `Panel.ts:215` | **Point at `docs/` or remove** |

## 3. Rendering features

| Feature | Implementation | Status | Evidence | Action |
|---|---|---|---|---|
| FFT spectral ocean | `OceanSimulation`, `FFT`, `Spectrum` | WIRED | Sea-state readback asserts amplitude, folding, no non-finite values | Keep |
| Three cascades, no tiling | `CASCADES`, per-cascade tile sizes | WIRED | Visible at range; separate geometry/shading LOD curves | Keep |
| Jacobian whitecaps | `OceanMaterial.ts:272-311` | PARTIAL | Foam is recomputed per frame from the instantaneous Jacobian. **No persistence, no advection, no dissipation.** Near-field coverage measured at roughly a third of frame as flat white sheets | **Rebuild as a persistent advected foam field** (Phase 2) |
| Wake foam | `physics/Wake.ts` | PARTIAL | The texture is correct, world-anchored, and updated every frame — and **`OceanMaterial` never samples it**. Only the debug overlay can display it | **Bind `Wake.texture` into the surface shader** (Phase 2/3) |
| Sky reflection | `OceanMaterial.ts:251-253` | PARTIAL | `mix(horizonColor, skyColor, reflectDir.y)` — an analytic two-colour gradient. Contains no scene geometry, no clouds, no sun disc, no ship | **Replace with real scene reflection** (Phase 2) |
| Refraction / transmission | none | ABSENT | The surface is an opaque `MeshBasicNodeMaterial` with no backdrop texture. `SPEC.md` F4 claims "refracted seafloor and submerged hull, distorted by surface normals" at P0 | **Implement depth-aware refraction against an opaque-scene backdrop** (Phase 2) |
| Beer–Lambert depth colour | `OceanMaterial.ts:229-238` | WIRED | Real water-column thickness when `floorDepthNode` is supplied | Keep — but see the bug below |
| Subsurface scattering | `OceanMaterial.ts:240-248` | WIRED | Backlit crest term | Keep, improve |
| GGX sun specular | `OceanMaterial.ts:255-263` | PARTIAL | Isotropic GGX. `SPEC.md` §2 requires glitter "anisotropic and stretched toward the viewer, not a round blob" | **Add anisotropic glitter** (Phase 2) |
| Caustics | `underwater/Caustics.ts` → seafloor only | PARTIAL | Injected into `Seafloor` at `main.ts:162`. `SPEC.md` F6 also claims caustics "on submerged geometry" — no other material receives the node | **Extend to submerged geometry, respond to wave motion and occlusion** (Phase 2) |
| Underwater fog + god rays | `underwater/UnderwaterPass.ts` | WIRED | Cross-fades on `submersion`; free above water behind a uniform branch | Keep |
| Underwater particulates + bubbles | `underwater/Particles.ts` | WIRED | Marine snow plus 14 bubble columns | Keep |
| Snell window / total internal reflection | none | ABSENT | `SPEC.md` §2 claims "looking up shows the surface underside with total internal reflection near the Snell window edge". The ocean material is `DoubleSide` and applies the identical topside shading from below | **Implement the underside** (Phase 2) |
| Volumetric clouds | `sky/Clouds.ts` | WIRED | Raymarched, `cloudSteps` per tier | Keep; storm framing needs work |
| Preetham sky, stars, moon | `sky/Atmosphere.ts` | WIRED | Env cube captured to `scene.environment` at `Atmosphere.ts:406` | Keep |
| Rain / snow | `sky/Weather.ts` | PARTIAL | Instanced camera-following particle volume. Not coupled to the ocean, the surface, the camera lens or the materials. Seeds use `Math.random()` (`Weather.ts:245-248`) so it is **not deterministic** | **Rebuild as a coupled weather system** (Phase 4) |
| Buoyancy | `physics/Buoyancy.ts` | WIRED | Probe-based rigid body; heave, pitch and roll from wave slope | Keep; extend with external forces |
| Ship control | none | ABSENT | See the HUD rows above | **Phase 3** |
| Adaptive quality | `AdaptiveQuality` | WIRED | One-way downgrade on sustained low FPS | Keep; retune against measured frame pressure |
| WebGL2 fallback | `core/Renderer.ts` | WIRED | Asserted by `falls back to WebGL2 and still renders` | Keep; needs an explicit per-effect policy |

## 4. Defects found during the audit

| # | Defect | Location | Impact |
|---|---|---|---|
| D1 | `applyQuality()` rebuilds `OceanMaterial` **without** `floorDepthNode` | `main.ts:318-322`, cf. `126-131` | After any quality change the water silently drops from real water-column thickness to the `1/cos(theta)` approximation. Shallow turquoise and the shelf-break edge are lost for the rest of the session. Invisible to typecheck; no test covers it |
| D2 | Scene content loads all-or-nothing | `main.ts:216-219` (`Promise.all`) | A single failing asset removes ship, props, buoyancy **and** wake together. Observed live: one `.bin` request failing left an ocean with no scene content at all, reported only as a console error |
| D3 | `THREE.PostProcessing` is deprecated in r185 | `main.ts:164` | Emits a console **warning** on every boot. `collectConsoleErrors` only captures `error`, so the suite is green while the renderer complains |
| D4 | Weather particle seeds are non-deterministic | `Weather.ts:245-248` | `Math.random()` at construction, so no two runs render the same rain. Blocks any visual baseline that includes weather |
| D5 | `Wake` is constructed and driven but never read by the surface | `main.ts:435-438`, `OceanMaterial` | Full per-frame cost of two fullscreen passes for a texture nothing samples |
| D6 | `npm run typecheck` **fails on a clean checkout** | `tsconfig.test.json` | The README documents it as a standard command. `tests/` probes `navigator.gpu` inside `page.evaluate` bodies but the test config omits `@webgpu/types`, so four `TS2339` errors are raised. Confirmed against unmodified `main` (`c03d73e`). `npm run build` runs `tsc --noEmit` over `src` only and therefore never caught it |

## 5. Documentation claims

### `docs/SPEC.md`

| Claim | Status | Action |
|---|---|---|
| Architecture lists `core/Disposer.ts` | ABSENT | **Removed from the tree** |
| Architecture lists `scene/Fish.ts` | ABSENT | **Removed** |
| Architecture lists `cameras/OrbitMode.ts`, `FlyMode.ts`, `BoatMode.ts` | ABSENT | **Removed** — one `CameraDirector.ts` owns all three modes |
| `OceanMesh.ts` described as "clipmap grid, projected/CDLOD" | Inaccurate | **Corrected** — it is a camera-centred radial grid, and the file's own comment explains why clipmaps were rejected |
| F4 Reflection & refraction, P0 | PARTIAL / ABSENT | Implemented in Phase 2 |
| F6 caustics "on submerged geometry" | PARTIAL | Implemented in Phase 2 |
| F7 underwater "muted audio-less ambience" | N/A | **Removed** — there is no audio system and none is planned |
| F19 "seaweed, grass, fish shoals" | ABSENT | **Claim removed.** Props are buoys, barrels, rocks and cliffs |
| F20 "touch controls" | PARTIAL | Only the panel sheet toggle and `OrbitControls`' built-in touch handling. **Claim narrowed**; compact touch controls are Phase 3 |
| §2 "sun glitter is anisotropic" | PARTIAL | Phase 2 |
| §2 "total internal reflection near the Snell window edge" | ABSENT | Phase 2 |
| §2 "ship shadow lands on the water and reads through into the shallows" | UNVERIFIED | No test; the ocean surface is `MeshBasicNodeMaterial` and therefore receives no shadow at all. **Claim removed pending implementation** |

### `README.md`

| Claim | Status | Action |
|---|---|---|
| "Measured numbers" — buoyancy pitch **r = 0.9869** | UNVERIFIED | No such assertion exists in `tests/`. **Removed or backed by a real test** |
| "Measured numbers" — seafloor CPU/GPU agreement **3 × 10⁻⁵ m** | UNVERIFIED | As above |
| "Measured numbers" — wake spread **19.3°** | UNVERIFIED | As above |
| "Measured numbers" — sky zenith **#256BB5** | UNVERIFIED | As above |
| "Whitecap coverage 4.6%" / "folded 0.1%" | WIRED | Genuinely asserted (`< 8%` folded) by the sea-state test |
| Frame work "0.3 / 1.1 / 0.8 ms" | UNVERIFIED | Wall-clock around an asynchronous submit, over 4–5 samples, under rAF throttling. README already says so; the number should not be quoted as a headline | **Replaced by measured GPU time** (Phase 1b) |
| "No screen-space reflections" | Accurate | Honest limitation, correctly stated |
| "wake foam does not persist as long as it should" | Understated | The wake is not sampled by the water at all | **Corrected** |

### `docs/PERFORMANCE.md`

| Claim | Status | Action |
|---|---|---|
| Test hardware table is `_to be recorded_` | Incomplete | **Filled in from the benchmark harness** |
| "No true GPU timings" | Accurate | Resolved in Phase 1b — `resolveTimestampsAsync` is available on this hardware |
| "Material compilation is not prewarmed" | Accurate | `compileAsync` appears nowhere in `src/`. Resolved in Phase 5 |
| "WebGL2 tiers unmeasured" | Accurate | Resolved in Phase 1b |

## 6. Gallery screenshots

`docs/images/` — seven captures referenced by `README.md`.

| Shot | Status | Note |
|---|---|---|
| `hero.png` | Genuine | A real render. Framed wide, where the near-field foam breakdown is not visible |
| `storm.png` | Genuine | Same framing caveat |
| `sunset.png`, `moonlit.png`, `waves.png`, `underwater.png` | Genuine | Renders of the stated presets |
| `interface.png` | Genuine | Panel and HUD with buoyancy probes on |

No screenshot is fabricated or borrowed. They are, however, **hand-picked and undated**, with no way to tell whether they still match the build. Phase 1c replaces them with harness-generated canonical captures that are regenerated and diffed on every visual change.

---

## 7. Status since the audit

The audit above records the state this pass started from. What has changed since,
with the commit that changed it:

| Row | Was | Now |
|---|---|---|
| Wake foam | PARTIAL — buffer computed, never sampled | **WIRED.** Bound into the surface; a test deposits a wake and requires the water to change |
| Jacobian whitecaps | PARTIAL — no persistence | **WIRED.** Breaking crests deposit into the same accumulation buffer and decay over seconds |
| Sky reflection | PARTIAL — analytic gradient | **WIRED.** Planar reflection of the scene on WebGPU; a test hides the ship and requires the water below the horizon to change |
| Refraction / transmission | ABSENT | **WIRED.** Scene backdrop sampled through the surface normal, water column measured from the depth buffer |
| Ship control | ABSENT | **WIRED.** Throttle and rudder as forces into the buoyancy solver; four behavioural tests |
| HUD W/S and A/D hints | ABSENT | **WIRED.** Both now do what they advertise; the unimplemented "Camera / Mouse" hint was removed |
| Underwater god rays | WIRED but wrong | **Rebuilt.** Volumetric integral of the caustics field along the view ray, converging on the refracted sun and occluded by geometry |
| `shadowMapSize`, `underwaterParticles` | PARTIAL | **WIRED**, and verified per tier |
| D1–D6 | 6 defects | All fixed |

Still open, and now recorded in `README.md` as limitations: the waterline is a
whole-frame cross-fade rather than a per-pixel split, there is no Snell window or
total internal reflection, sun glitter is isotropic, and rain wetting is uniform
over an object rather than driven by the surface normal.

Rain is no longer an uncoupled overlay. It disturbs the surface, aerates it into
foam, beads on the lens and wets the hull, and each of those has a test that
fails if the coupling is removed.

## 12. What regenerating the gallery found

The README's images had been captured by hand and were months of renderer work out
of date, with nothing able to detect it. `tests/gallery.spec.ts` replaces them with
one command through the same deterministic harness the baselines use.

Doing that surfaced a defect the visual suite could not: **`resetDeterministic`
does not make a shot independent of the one before it.** The boat shot captured
straight after the storm has visibly heavier foam than the same shot captured
first. Two causes, one fixed:

- The rain rate was rewound *after* the objects that snap their own state to it,
  so `LensRain.resetClock` set its coverage from the previous shot's intensity —
  a clear-sky image inherited a soaked lens and dried it over a 26 s constant that
  eight seconds of settling could not touch. The rate is now pushed in first.
- Something in the foam path still carries over. Not yet found; recorded rather
  than papered over.

The suite's baselines are self-consistent because it always runs the shots in one
order, which is exactly the ordering dependence `tests/lib/shots.ts` opens by
warning against. The gallery avoids it by reloading between images — the right
call for published output, and not a fix.

## 11. Fourth pass — the same reviewer, twice

The third pass ended with "no, not AAA" and six ranked architectural gaps. Four
were built; a second review of *those* found five implementation errors and four
overstated claims in the new work, which is the useful part of the exercise.

Built:

| Gap | What landed |
|---|---|
| Global waterline | Per-pixel: the medium is integrated over the segment of each eye ray below the surface, with the surface taken from the wave field where the ray meets it |
| No surface underside | Snell's window at 48.6 degrees with the air-side angle from Snell rather than a linear remap, and screen-space total internal reflection outside it |
| Isotropic glitter | Anisotropic GGX on a Gram-Schmidt tangent frame, with a matching anisotropic Smith visibility, ratio from Cox & Munk |
| Mirror reflections | Planar target mipmapped, sampled at a roughness- and distance-driven level |
| No cloud shadows | One sample of the cloud march's own density field, along the sun path |
| No shaft occlusion | Cloud deck plus an analytic hull ellipsoid in the hull's frame |
| Foam does not transport | Advected by wind plus Stokes drift; the elevation channel deliberately is not |

Caught in the new work by the second review:

- The per-pixel result was still multiplied by the global `submersion` scalar, so
  a ray crossing ten metres of water got half the treatment at the waterline.
- The shaft march started at `t = 0` rather than where the ray enters the water,
  spending its samples in air.
- `-eyeH / rayY` divided by zero at exactly horizontal rays — a NaN at the horizon
  line of every frame.
- The anisotropic tangent frame was the wind axis and its horizontal
  perpendicular, which is orthonormal only where the surface is flat. On a tilted
  wave the NDF was not normalised.
- The Smith visibility was left isotropic against an anisotropic distribution,
  which is not a partial implementation but an unmatched BRDF.
- Foam drift was advecting the wake's *elevation* channel too, dragging the
  Kelvin pattern downwind.
- The cloud shadow attenuated over the slab's vertical thickness rather than the
  sun path's length through it, so a low sun cast the same shadow as noon.
- The hull occluder was axis-aligned and did not follow the bow.
- The specular antialiasing was attributed to Kaplanyan et al. It is the cheaper
  geometric variant, which discards the anisotropic covariance the paper's method
  keeps.

Still open, and recorded in `README.md`: no temporal antialiasing or
reconstruction, SSR still single-ray and non-temporal, refraction still a UV
offset rather than a solved ray, clouds still a procedural slab, foam still
reading as ribboning rather than multiscale bubbles.

Also from this pass: a validation error that had been hiding behind four
successive "fixes", and which took two more attempts after this section was first
written — the drain requested its GPU fence before joining the frame already
inside `renderAsync`, and `setState({ quality, preset })` submitted an environment
capture between the fence being requested and it resolving. Toggling `renderer.shadowMap.enabled`, calling
`shadow.dispose()`, toggling `castShadow`, and resizing the mipmapped reflector
each *triggered* it, and each fix removed one trigger and revealed the next. The
cause was none of them: a tier change destroys GPU resources that a submitted
command buffer still references, which WebGPU states plainly as *"Destroyed
texture used in a submit"*. Tier changes now pause the loop, wait on
`queue.onSubmittedWorkDone`, apply, compile the new pipelines, and drain again
before resuming. The benchmark's console-error gate — added in the previous pass
and, at the time, catching nothing — is what finally surfaced it.

## 10. Third pass — an adversarial quality review

The second pass was still a review of *this* codebase against *its own* claims. A
third was run against external references instead: does the rendering hold up
next to a shipping AAA ocean, and are the physics claims true?

Six substantive errors, all now fixed (`4eca54e`):

| Claim | What was actually there |
|---|---|
| "GGX sun specular" | The normal *distribution* function alone — no Fresnel, no masking-shadowing, no `1/(4 (N·L)(N·V))`. The NDF is not a reflectance; its peak scales as `1/(pi·a2)`, which at 0.075 roughness is ~10,000 before the sun's intensity. The single largest reason the water read as white foil. |
| Underwater absorption | Used axial depth-buffer distance as path length, so absorption weakened toward the frame edges and depended on the field of view |
| World-anchored wake | The anchor was published to the surface one frame before the buffer was recentred, so the wake slid against the hull while the camera moved |
| "Bow wave and shoulder trough" | Only the mound existed |
| Monahan whitecap law | Scaled the surface's *read strength*, not the deposit rate — the empirical coverage law was decorating opacity while generation was a constant |
| Caustics mip footprint | Used the full 3D march step for a 2D map indexed by world XZ, over-blurring the near-vertical rays that carry the shafts |

Four claims were overstated rather than wrong, and are now worded accurately: the
grazing reflection fade is not a Smith term, the wake is Kelvin-*inspired* rather
than a Kelvin solution, the fog transmittance is exact only for the uncapped
profile, and the overcast model is authored rather than derived from cloud
optical depth.

Two documentation figures were unsupported: a "whitecap coverage 4.6%" attributed
to a test that never measures it, and a performance headline that contradicted the
checked benchmark artifact. Both corrected.

The gaps the review names as still open — no prefiltered or temporal reflection,
no anisotropic glitter, no cloud shadows, no sun occlusion for shafts, a global
rather than per-pixel waterline, no temporal reconstruction — are recorded under
Known Limitations in `README.md` rather than closed.

## 9. Second pass

A later audit, prompted by a viewer looking at the running app rather than at the
code, found a further set of claims that were true of the design and false of the
build. They are recorded here because the pattern is the point: every one of them
was a feature that existed, was wired, had a test, and did not work.

| Claim | What was true | Status |
|---|---|---|
| Volumetric fog | Both fog passes built their view ray with NDC y from a top-down screen uv, inverting every ray. Sky integrated the whole column; water got none. | **Fixed**, and the same flip in the underwater pass with it |
| Underwater god rays | Same inverted ray — the shafts pointed away from the sun | **Fixed** |
| Per-preset fog | One global extinction for all nine presets, sixty times Sea of Thieves' aerial perspective | **Fixed** — `Preset.fog.volumetric` |
| Whitecaps respond to sea state | `setBreaking` and `setFoamStrength` were never called; one threshold and rate for every preset and wind speed | **Fixed** — coverage follows Monahan's U^3.41 |
| Day/night slider | Declared with a label and a formatter; never built, because the panel placed sliders by index | **Fixed**, and construction now throws if a declared slider is unplaced |
| "Diving is a headline feature" | The camera was teleported out of a 0.7 m band around the surface, which made crossing impossible in either direction | **Fixed** |
| Lens rain | Droplets ran up the screen | **Fixed** |
| Reversed-edge `smoothstep` | ~20 sites relying on behaviour both WGSL and GLSL leave undefined | **Fixed** — `core/tslMath` |
| Shadow map size per tier | `shadow.dispose()` nulled the node's target; the planar reflector then read `depthTexture` off null on the next frame | **Fixed** |
| Benchmark gates on GPU samples | Only the *CPU* sample count was checked; console errors never reached the verdict | **Fixed** |
| Leak test | 8 transitions, 8 textures allowed — one per transition, which is exactly the leak it exists to catch | **Fixed** — measures a rate across two segments |
| "WebGL2 still renders" | Asserted the backend string and an empty console; never read a frame | **Fixed** |
| Reflection test covers SSR | Planar and SSR are composited and driven by one tier number, so the test passed on planar alone | **Fixed** — a second test turns planar off |
| No per-frame allocation | The sampler readback allocated ~190 kB a frame decoding half-floats | **Fixed** — pooled per slice |

Three defects were introduced during the work and caught by the harness rather
than by review — a framebuffer feedback loop, a pooled-readback buffer read past
its length, and a backdrop texture leaked on every tier change. They are
described in the commits that fixed them.

## 8. Summary

- **5 dead quality settings** removed.
- **2 partially wired settings** (`shadowMapSize`, `underwaterParticles`) connected properly.
- **6 defects** found (D1–D6), 3 of them invisible to the existing suite. This said "5" while
  the table above listed six — corrected after an independent review caught the contradiction.
- **9 documentation claims** removed or corrected as unimplemented; **4 "measured" numbers** had no measurement behind them.
- **6 P0/P1 rendering features** were partial or absent at the time of the audit: scene reflection, refraction, persistent foam, the wake binding, the underwater surface underside, and coupled weather. All but the surface underside have since been *wired and tested* — see §7.
  **"Wired" is not "working at the claimed fidelity"**, and an independent review
  pointed out that saying "implemented" here repeats the exact confusion §9 exists
  to prevent. Each of those five works and has a test that fails if it is
  disconnected; each is also a first-generation implementation with named
  shortfalls, listed under Known Limitations in `README.md`.
