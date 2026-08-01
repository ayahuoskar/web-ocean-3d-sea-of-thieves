# Web Ocean 3D

A realtime spectral ocean rendered with **Three.js**, **WebGPU** and **TSL** — FFT wave
synthesis, physically motivated water optics, foam, caustics, buoyancy, wakes, underwater
transitions and a volumetric sky, with a graceful WebGL2 fallback from the same shader source.

![Web Ocean 3D](docs/images/hero.png)

<p align="center">
  <img alt="Three.js r185" src="https://img.shields.io/badge/three.js-r185-000000?style=flat-square&logo=three.js&logoColor=white">
  <img alt="WebGPU" src="https://img.shields.io/badge/WebGPU-TSL-005a9c?style=flat-square">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-6-646CFF?style=flat-square&logo=vite&logoColor=white">
  <img alt="Assets CC0" src="https://img.shields.io/badge/assets-CC0-4ade80?style=flat-square">
</p>

---

## Quick start

```bash
npm install
npm run dev            # http://127.0.0.1:5173
```

```bash
npm run build          # typecheck + production bundle
npm run preview        # http://127.0.0.1:4173
npm test               # Playwright suite (starts its own preview server)
```

Assets are committed, but the set is reproducible from scratch:

```bash
node scripts/fetch-assets.mjs             # idempotent
node scripts/fetch-assets.mjs --force     # re-fetch everything
node scripts/fetch-assets.mjs --verify    # offline integrity check
```

**Requirements** — Node 20+, and a browser with WebGPU for the full experience
(Chrome/Edge 113+, Safari 18+). Without it the app falls back to WebGL2 automatically; the
**Force WebGL** switch exercises that path deliberately.

---

## Gallery

Nine environment presets. Each moves the sun, sea state, water optics, aerial perspective
and weather together — so switching reads as a different *place*, not a colour filter.

| Clear Day | Storm |
|---|---|
| ![Clear day](docs/images/hero.png) | ![Storm](docs/images/storm.png) |
| Cumulus, 15 m/s wind, turquoise shallows | 21 m/s, overcast deck, rain, heavy chop |

| Sunset | Moonlit |
|---|---|
| ![Sunset](docs/images/sunset.png) | ![Moonlit](docs/images/moonlit.png) |
| Low sun, warm haze, near-glassy swell | Sun below horizon, star field, long swell |

| Wave detail | Underwater |
|---|---|
| ![Waves](docs/images/waves.png) | ![Underwater](docs/images/underwater.png) |
| Jacobian-driven whitecaps at 19 m/s | Hull from below, particulates, caustics |

![Interface](docs/images/interface.png)

*The control panel and HUD. Buoyancy probes are switched on here, showing the four hull
sample points the physics solves against.*

> Gallery shots are captured with the UI hidden. The FPS readout is omitted from the
> interface shot on purpose — see [Performance](#performance) for why a frame-rate number
> captured under browser automation would be meaningless.

---

## Controls

| | |
|---|---|
| **1 / 2 / 3** | Orbit / Fly / Boat camera |
| **Orbit** | LMB drag rotate · RMB drag pan · scroll zoom |
| **Fly** | click to capture the mouse · WASD · Space/Ctrl up-down · Shift boost |
| **Boat** | **W/S** throttle ahead and astern · **A/D** rudder · chase camera follows the hull |

Boat mode selects the ship, not just a camera. Leaving it releases ship input, so Orbit and
Fly keep their own keys. The rudder is a foil: it has little authority until the ship has way
on, and it reverses when making sternway.

Drop the camera below the surface in any mode to trigger the underwater state.

---

## Features

**Ocean**
- Depth-aware refraction: the scene behind the surface, distorted by the wave normal, with
  the water column measured from the depth buffer and Beer–Lambert absorption over it
- Planar reflection of ship, props and clouds, faded out at the frame edge and at grazing
  angles where the plane approximation stops describing anything
- Persistent foam: breaking crests and the ship's wake deposit into one world-anchored buffer
  that decays over seconds, rather than a mask recomputed every frame
- JONSWAP directional spectrum with live wind-speed and peak-wavelength control
- Three spectral cascades (512 m / 128 m / 16 m tiles) — swell, chop and ripple with no
  visible tiling
- Jacobian-derived whitecaps: foam appears where the surface genuinely folds, biased toward
  crests and broken up with world-space noise
- Fresnel sky reflection, Beer–Lambert transmission, subsurface scattering on backlit
  crests, GGX sun specular
- Shallow-water tint driven by real seafloor depth

**World**
- Steerable sailing ship: throttle and rudder resolved into forces the buoyancy solver
  integrates, so propulsion composes with heave, pitch and roll instead of overriding them
- Trailing Kelvin wake driven by speed along the bow, curving with the turn and dissipating
- Buoys and barrels floating independently
- Procedural seafloor with animated caustics; island silhouette
- Preetham-model sky with raymarched volumetric clouds, stars, moon, rain and snow

**Underwater**
- Extinction fog, god rays, drifting particulates and bubble columns
- Continuous cross-fade across the waterline rather than a hard cut

**Engineering**
- Five quality tiers plus adaptive downgrade under sustained load
- Live pixel-ratio control
- Deterministic test hooks for automated verification

---

## Architecture

```
src/
  core/        renderer bootstrap + fallback, frame loop, quality tiers
  ocean/       spectrum, FFT, simulation, mesh, surface shading, CPU sampler
  sky/         atmosphere, volumetric clouds, weather
  underwater/  fog and god rays, particulates, caustics
  scene/       asset loading, ship, props, seafloor
  physics/     buoyancy, wake accumulation
  cameras/     orbit / fly / boat director
  ui/          control panel, HUD (framework-free DOM)
  presets/     nine environment definitions
```

### Design decisions worth explaining

**One shader source, two backends.** Three's `WebGPURenderer` compiles the same TSL node
graph to WGSL or GLSL, so the WebGL2 fallback is a configuration flag rather than a parallel
codebase.

**FFT waves, not a Gerstner sum.** A Gerstner sum needs hundreds of waves before it stops
looking periodic. An FFT gives a full directional spectrum at fixed cost and — more usefully
— yields the *Jacobian* of the displacement map, which is physically where whitecaps form.
Foam is therefore derived, not painted.

**The IFFT runs as fragment passes, not compute.** Three's WebGL2 backend has neither compute
shaders nor storage textures, so a compute implementation would need a separate fallback
path. At our sizes the transform is not the bottleneck; surface shading is.

**Geometry LOD and shading LOD are separate curves.** Vertex spacing on the radial ocean grid
grows with radius, so a cascade must stop *displacing* geometry well before it stops
contributing *normals*. Conflating the two is what makes naive ocean meshes sparkle — every
triangle lands on a random phase of a wave it cannot resolve. Geometry flattens with distance
while mipmapped derivative textures carry fine detail to the horizon.

**Buoyancy reads back asynchronously.** A small slice of the displacement field is copied to
host memory without awaiting the GPU fence. One frame of staleness on a floating hull is
invisible; a pipeline stall is not.

---

## Verification

Two suites. The functional one asserts behaviour; the visual one compares seven canonical shots
against checked-in baselines with a CIE94 ΔE metric whose thresholds come from a *measured*
run-to-run noise floor — not pixel-exact equality, which no GPU render can hold to. Notable
checks:

- Sea state read straight off the GPU: crest amplitude in metres, no non-finite values,
  whitecap coverage under 8%
- Boot on both backends with zero console errors
- Presets must each change the image and not collapse to one look
- Texture and geometry counts across repeated quality cycles, to catch leaks
- Layout overflow from 360 px to 1920 px

**Measured numbers**, read off the GPU rather than judged by eye:

| Quantity | Measured | Asserted by |
|---|---|---|
| Whitecap coverage at 15 m/s | **4.6%** | `produces a physically plausible sea state` |
| Folded surface area | **0.1%** | same (gate: `< 8%`) |
| Crest amplitude, cascade 0 | **±1.4 m** | same (gate: `0.4 m … 12 m`) |

> An earlier revision of this table also quoted a buoyancy/wave-slope correlation,
> a seafloor CPU/GPU agreement figure, a wake spread angle and a sky zenith
> colour. No assertion in the suite produced any of them, so they have been
> removed rather than left standing as unsourced numbers. See
> [`docs/CLAIMS_AUDIT.md`](docs/CLAIMS_AUDIT.md).

Two bugs were found by measuring rather than looking, and both were invisible to typecheck:

1. The FFT butterfly twiddle exponent used the group width where it needed the half-span,
   applying `W^(N/2) = -1` to every odd row at stage 0. Folding fell from 8.8% of the surface
   to 0.1%.
2. Geometry and shading shared one LOD curve, undersampling the wave field into speckle.

---

## Performance

Frame work measures **0.3 / 1.1 / 0.8 ms** at Low / High / Max on WebGPU at 1600 × 900.

**Read that with care.** Automated Chromium throttles `requestAnimationFrame` independently
of load — this project measured 1.1 "FPS" while spending 0.8 ms per frame, and the same
~1 fps appears with every effect disabled. The test suite therefore gates on per-frame *work*
(16.7 ms WebGPU, 33.3 ms WebGL) and only asserts frame rate when the browser is demonstrably
not throttling. `frameMs` is also wall-clock around the render call, and WebGPU submits work
asynchronously, so it **undercounts true GPU time**.

Full methodology, cost model and the honest list of what remains unmeasured:
[`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).

---

## Known limitations

- **The waterline is not a true split.** `submersion` cross-fades the whole frame rather than
  masking it per pixel, so a camera sitting exactly at the surface does not show water below
  and air above in the same image. The canonical `waterline` shot is a grazing view, not a
  meniscus.
- **No Snell window or total internal reflection.** Looking up from below shows the surface
  underside shaded like the topside, not the compressed disc of sky and mirrored water that
  real water produces.
- **Sun glitter is isotropic.** It should stretch toward the viewer rather than reading as a
  round highlight.
- **The ship is not wetted by rain.** Rain reaches the water and the lens, but hull surfaces do
  not darken or gloss under it.
- **`refraction: 0` is a visual policy, not a cost saving.** The backdrop and depth reads are
  unconditional in the node graph; a tier that sets it to zero still pays for them.
- **One machine.** Every performance figure comes from a single RTX 5090; nothing here
  establishes where the quality tiers stop working.
- Playwright's bundled Chromium exposes no WebGPU adapter, so it renders through a software
  rasteriser. Screenshot-dependent tests skip there rather than being loosened until they
  pass; a software-runner result is inconclusive, not a pass.

---

## Documentation

- [`docs/SPEC.md`](docs/SPEC.md) — feature matrix, visual checklist, measured behaviour
- [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) — methodology, budgets, cost model
- [`docs/CLAIMS_AUDIT.md`](docs/CLAIMS_AUDIT.md) — every claim in this repository, mapped to
  its implementation and its evidence
- [`ASSET_LICENSES.md`](ASSET_LICENSES.md) — every asset, source, author and licence

---

## Licence and provenance

Project code is original. Techniques are implemented from published literature — Tessendorf's
FFT ocean, JONSWAP and Pierson–Moskowitz spectra, the Preetham sky model — and from
MIT-licensed Three.js examples.

All 3D models and HDRIs are **CC0**, sourced independently from
[Poly Haven](https://polyhaven.com), and listed with author and URL in
[`ASSET_LICENSES.md`](ASSET_LICENSES.md).

Dependencies: three.js (MIT), Vite (MIT), TypeScript (Apache-2.0), Playwright (Apache-2.0).
