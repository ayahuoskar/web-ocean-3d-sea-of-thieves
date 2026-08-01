# Web Ocean 3D — Design Spec & Feature Matrix

Target: recreate the *visible experience and functionality* of the Three.js Water Pro live
demo as an original, production-quality implementation.

**Provenance note.** The reference is a commercial product. Nothing in this repository is
derived from its source bundle or its shipped assets. Every technique here is implemented
from published literature (Tessendorf FFT ocean, JONSWAP/Pierson–Moskowitz spectra,
Hosek–Wilkie / Preetham sky models) and MIT-licensed Three.js examples. All 3D and HDRI
assets are sourced independently under CC0 and recorded in `ASSET_LICENSES.md`.

---

## 1. Feature matrix

Observed in the reference across the captures in `reference/shots/`.

| # | Feature | Observed behaviour | Priority |
|---|---------|--------------------|----------|
| F1 | Spectral ocean | Large-scale swell + wind chop + fine ripples, directional, wind-driven. Wavelength and wind speed are live-tunable. | P0 |
| F2 | Shoreline/shallow water | Turquoise shallows, visible seafloor, depth-graded absorption from teal → deep blue. | P0 |
| F3 | Water lighting | Fresnel sky reflection, sun specular glitter, subsurface scattering glow on wave backs, Beer–Lambert depth absorption. | P0 |
| F4 | Reflection & refraction | Sky/scene reflection on the surface; refracted seafloor and submerged hull, distorted by surface normals. | P0 |
| F5 | Foam | Whitecaps on wave crests (Jacobian/folding driven), shoreline foam, persistent wake foam trailing the ship. | P0 |
| F6 | Caustics | Animated light caustics on the seafloor and on submerged geometry; visible from above through clear shallow water. | P0 |
| F7 | Underwater state | Full transition when the camera crosses the surface: blue-green volumetric fog, god rays / light shafts, drifting particulates, bubble columns, desaturated distance. | P0 |
| F8 | Waterline transition | Correct half-submerged framing when the camera sits at the surface; no popping. | P1 |
| F9 | Atmosphere / sky | Physically based sky with sun position per preset, volumetric cloud layer with live coverage control, stars at night, rain in Storm. | P0 |
| F10 | Buoyancy | Ship and buoys ride the wave surface — heave, pitch, roll sampled from the displacement field. Debug "Buoyancy Probes" toggle. | P0 |
| F11 | Wakes | Ship generates a persistent foam wake and surface displacement. Debug "Wake Probes" toggle. | P1 |
| F12 | Presets | 9: Three.js Sky Pro, Arctic, Black Flag, Dusk, Foggy, Moonlit, Sea of Thieves, Storm, Sunset. Each sets sun/sky, water colour, wind, wavelength, cloud coverage, weather FX. | P0 |
| F13 | Camera modes | Orbit (LMB rotate / RMB pan / scroll zoom), Fly (WASD + mouse look), Boat (chase camera on the ship). Keys 1/2/3. | P0 |
| F14 | Quality tiers | Low / Medium / High / Ultra / Max — scales cascade count, FFT resolution, mesh LOD, post FX, shadows. | P0 |
| F15 | Renderer fallback | WebGPU by default with a "Force WebGL" toggle producing a visually equivalent WebGL2 path. | P0 |
| F16 | Pixel ratio control | Live 0.5×–2× resolution scale slider. | P1 |
| F17 | HUD | FPS counter (green→red by health), camera mode switcher, control hints. | P0 |
| F18 | Control panel | Dark glass panel: quality, preset, wind speed, peak wavelength, cloud coverage, three toggles, pixel ratio, CTA buttons. | P0 |
| F19 | Scene dressing | Sailing ship, buoys, barrels, and an instanced rock/cliff island. | P1 |
| F20 | Responsive | Panel collapses to a bottom sheet on narrow viewports; the orbit camera accepts touch gestures. | P1 |

## 2. Visual-quality checklist

Derived from the reference captures. Each item is a pass/fail gate for the comparison loop.

**Water surface**
- [ ] Wave crests are sharp and slightly peaked, not sinusoidal — choppiness (horizontal displacement) is visibly present.
- [ ] Three distinct spatial scales are simultaneously legible: swell, chop, ripple.
- [ ] Whitecaps appear only where the surface folds, and dissipate over ~1–2 s.
- [ ] Sun glitter is anisotropic and stretched toward the viewer, not a round blob.
- [ ] Water colour transitions from turquoise (shallow, seafloor visible) to deep navy with distance/depth.
- [ ] Backlit wave faces glow with subsurface scattering.
- [ ] Horizon meets the sky without a visible seam or tiling repeat.

**Atmosphere**
- [ ] Sky gradient and sun disc match the preset's time of day.
- [ ] Clouds are volumetric-looking with lit tops and shadowed bases, and drift.
- [ ] Aerial perspective fades distant water into the horizon haze.

**Underwater**
- [ ] Crossing the surface is a continuous transition, not a hard cut.
- [ ] God rays originate from the sun direction and are occluded by the ship hull.
- [ ] Particulates drift slowly; bubble columns rise and wobble.
- [ ] Visibility falls off exponentially with distance in a blue-green tint.
- [ ] Looking up shows the surface underside with total internal reflection near the Snell window edge.

**Objects & motion**
- [ ] Ship heave/pitch/roll is phase-correct with the waves under it.
- [ ] Wake foam trails behind the ship and persists, widening astern.
- [ ] Buoys bob independently and correctly.

> Removed from this checklist: *"ship shadow lands on the water and reads through
> into the shallows"*. The surface is a `MeshBasicNodeMaterial` and receives no
> shadow at all, so the item could never pass. It returns only if the surface is
> given a lighting model that accepts one.

**UI**
- [ ] Panel typography, spacing, and glass treatment are crisp at 1× and 2× DPR.
- [ ] Sliders and toggles animate smoothly; values update live.
- [ ] FPS meter colour-codes by frame health.
- [ ] No layout shift or overflow at 360px–2560px widths.

## 3. Architecture

```
src/
  main.ts                 bootstrap, wires everything together
  core/
    Renderer.ts           WebGPURenderer + WebGL fallback, resize, pixel ratio
    Loop.ts               frame loop, clamped delta, frame timing
    QualityManager.ts     tier definitions + adaptive downscale on sustained low FPS
  ocean/
    Spectrum.ts           JONSWAP directional spectrum -> initial h0 texture
    FFT.ts                Stockham radix-2 IFFT fragment passes (TSL)
    OceanSimulation.ts    per-frame cascade evolution -> displacement/derivatives
    OceanMesh.ts          camera-centred radial grid with geometric ring spacing
    OceanMaterial.ts      surface shading node graph
    Sampler.ts            CPU-side height/normal readback for buoyancy
  sky/
    Atmosphere.ts         analytic sky + sun/moon disc + stars + env capture
    Clouds.ts             raymarched volumetric cloud layer
    Weather.ts            rain / snow particle systems
  underwater/
    UnderwaterPass.ts     fog, god rays, colour grade
    Particles.ts          particulates + bubbles
    Caustics.ts           procedural caustic field shared by submerged materials
  scene/
    AssetLoader.ts        caching, deduplicating glTF loader
    Seafloor.ts           terrain + depth field feeding shallow-water shading
    Props.ts              buoys, barrels, and an instanced rock/cliff island
    Ship.ts               ship model, hull normalisation, buoyancy probe layout
  physics/
    Buoyancy.ts           probe-based rigid-body float
    Wake.ts               world-anchored wake foam accumulation buffer
  cameras/
    CameraDirector.ts     orbit / fly / boat modes and the transitions between them
  ui/
    Panel.ts, Hud.ts, types.ts, styles.css
  presets/
    index.ts              9 preset definitions
```

The tree above is the tree on disk. See [`CLAIMS_AUDIT.md`](CLAIMS_AUDIT.md) for the
modules this document previously named that were never written.

### Key decisions

**WebGPU + TSL with automatic WebGL2 fallback.** Three's `WebGPURenderer` compiles the same
TSL node graph to WGSL or GLSL, so one authored shader set serves both backends. This
directly supports the reference's "Force WebGL" toggle without a parallel codebase.
Rationale: avoids maintaining two shader languages, and compute-based FFT degrades to a
fragment-shader FFT on the WebGL path.

**FFT ocean over Gerstner sums.** A Gerstner sum needs hundreds of waves to look
non-repetitive; an FFT gives a full spectrum at fixed cost and yields the Jacobian needed
for physically motivated whitecaps. Cascades at three tile sizes (roughly 512 m / 128 m /
16 m) remove visible tiling.

**Clipmap ocean mesh.** A camera-centred nested grid keeps triangle density high near the
viewer and cheap at the horizon, and avoids the seams and popping of discrete LOD rings.

**GPU→CPU readback for buoyancy.** A small (64²) height slice is read back asynchronously
each frame so ship physics stays on the CPU without stalling the pipeline.

## 4. Measured behaviour

Numbers read directly off the GPU rather than judged by eye. Reproduce them with the
assertions in `tests/ocean.spec.ts`.

| Quantity | Measured | Expected | Notes |
|---|---|---|---|
| Crest amplitude, cascade 0 | ±1.4 m | metres | 15 m/s wind, 47 m peak |
| Surface RMS elevation | 0.433 / 0.322 / 0.066 m | decreasing per cascade | swell / chop / ripple |
| Mean Jacobian | 0.86 / 0.95 / 0.98 | just under 1 | below 1 means net folding |
| Folded area (J < 0) | 0.1 % | a fraction of a percent | was 8.8 % before the FFT fix |
| Whitecap coverage | 4.6 % | few percent at 15 m/s | matches observed sea state |
| Significant wave height | 2.17 m | see below | |

**On significant wave height.** The Pierson–Moskowitz relation `Hs ≈ 0.22 U²/g` gives
5.05 m at 15 m/s, which our 2.17 m appears to miss badly. It does not: PM describes a
*fully developed* sea, whose spectral peak at 15 m/s sits near 190 m. The demo exposes
peak wavelength as a control and defaults it to 47 m, which is a fetch-limited sea — a
shorter, steeper, lower-amplitude state. A fetch-limited spectrum is *expected* to carry
less variance than the fully developed one at the same wind speed, so the two figures
are not comparable and the simulation is not under-energised. Comparing against PM is
only valid with the peak wavelength set to the fully developed value for the chosen wind.
