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
| F7 | Underwater state | Full transition when the camera crosses the surface: blue-green volumetric fog, god rays / light shafts, drifting particulates, bubble columns, muted audio-less ambience, desaturated distance. | P0 |
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
| F19 | Scene dressing | Sailing ship, buoys, island, rocks, seaweed, grass, fish shoals. | P1 |
| F20 | Responsive | Panel collapses / repositions on narrow viewports; touch controls. | P1 |

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
- [ ] Ship shadow lands on the water and reads through into the shallows.
- [ ] Wake foam trails behind the ship and persists, widening astern.
- [ ] Buoys bob independently and correctly.

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
    Loop.ts               fixed-step sim + render loop, frame timing
    QualityManager.ts     tier definitions + adaptive downscale on sustained low FPS
    Disposer.ts           deterministic GPU resource teardown
  ocean/
    Spectrum.ts           JONSWAP directional spectrum -> initial h0 texture
    FFT.ts                Stockham radix-2 IFFT compute passes (TSL)
    OceanSimulation.ts    per-frame cascade evolution -> displacement/normal/foam
    OceanMesh.ts          camera-centred clipmap grid, projected/CDLOD
    OceanMaterial.ts      PBR surface shading node graph
    Sampler.ts            CPU-side height/normal readback for buoyancy
  sky/
    Atmosphere.ts         analytic sky + sun/moon disc + stars
    Clouds.ts             raymarched volumetric cloud layer
    Weather.ts            rain / snow particle systems
  underwater/
    UnderwaterPass.ts     fog, god rays, colour grade
    Particles.ts          particulates + bubbles
    Caustics.ts           caustic projection onto seafloor + submerged meshes
  scene/
    Seafloor.ts           terrain + depth field feeding shallow-water shading
    Props.ts              island, rocks, seaweed, grass instancing
    Ship.ts               ship model + rig
    Fish.ts               boid shoals (compute)
  physics/
    Buoyancy.ts           probe-based rigid-body float
    Wake.ts               wake displacement + foam accumulation buffer
  cameras/
    OrbitMode.ts, FlyMode.ts, BoatMode.ts, CameraDirector.ts
  ui/
    Panel.ts, Hud.ts, styles.css
  presets/
    index.ts              9 preset definitions
```

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
