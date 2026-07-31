# Web Ocean 3D

A realtime spectral ocean rendered with Three.js, WebGPU and TSL: FFT wave
synthesis, physically motivated water optics, foam, caustics, buoyancy, wakes,
underwater transitions and a volumetric sky — with a graceful WebGL2 fallback.

<!-- Screenshots are produced by the verification loop; see docs/PERFORMANCE.md -->

## Quick start

```bash
npm install
npm run dev            # http://127.0.0.1:5173
```

Production build and preview:

```bash
npm run build          # typecheck + vite build
npm run preview        # http://127.0.0.1:4173
```

Tests (starts its own preview server):

```bash
npx playwright install chromium   # once
npm test
```

Re-download the 3D and HDRI assets from scratch:

```bash
node scripts/fetch-assets.mjs             # idempotent
node scripts/fetch-assets.mjs --force     # re-fetch everything
node scripts/fetch-assets.mjs --verify    # offline integrity check
```

### Requirements

- **Node 20+**
- A browser with **WebGPU** for the full experience (Chrome/Edge 113+, Safari 18+).
  Without it the app automatically falls back to WebGL2 and drops the effects
  that depend on it. The Force WebGL switch in the panel exercises that path
  deliberately.

## Controls

| | |
|---|---|
| **1 / 2 / 3** | Orbit / Fly / Boat camera |
| **Orbit** | LMB drag rotate · RMB drag pan · scroll zoom |
| **Fly** | click to capture the mouse · WASD move · Space/Ctrl up/down · Shift boost |
| **Boat** | chase camera locked to the ship |

Drop the camera below the surface in any mode to trigger the underwater state.

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

`docs/SPEC.md` holds the feature matrix, the visual-quality checklist and the
per-module design notes.

### Why these choices

**WebGPU + TSL, with WebGL2 from the same source.** Three's `WebGPURenderer`
compiles one TSL node graph to either WGSL or GLSL, so the fallback is a
configuration flag rather than a parallel shader codebase.

**FFT waves instead of a Gerstner sum.** A Gerstner sum needs hundreds of waves
before it stops looking periodic. An FFT gives a full directional spectrum at
fixed cost, and — more usefully — it yields the Jacobian of the displacement map,
which is *physically* where whitecaps form. Foam is therefore derived rather than
painted. Three cascades at 512 m / 128 m / 16 m tiles cover swell, chop and
ripple without any single tile reading as a repeat.

**The IFFT runs as fragment passes, not compute.** Three's WebGL2 backend has
neither compute shaders nor storage textures, so a compute implementation would
have needed an entirely separate fallback path. At our sizes the transform is not
the bottleneck — surface shading is.

**Geometry LOD and shading LOD are separate.** Vertex spacing on the radial ocean
grid grows with radius, so a cascade must stop *displacing* geometry well before
it stops contributing *normals*. Conflating the two is what makes naive ocean
meshes sparkle: every triangle lands on a random phase of a wave it cannot
resolve. Geometry flattens with distance while mipmapped derivative textures
carry fine detail to the horizon.

**Buoyancy reads back asynchronously.** A small slice of the displacement field
is copied to host memory without awaiting the GPU fence. One frame of staleness
on a floating hull is invisible; a pipeline stall is not.

## Documentation

- [`docs/SPEC.md`](docs/SPEC.md) — feature matrix, visual checklist, architecture
- [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) — measured frame times and budgets
- [`ASSET_LICENSES.md`](ASSET_LICENSES.md) — every asset, source and licence

## Licence and provenance

Project code is original. The reference experience it targets is a commercial
product; nothing here derives from its source or ships its assets. Techniques are
implemented from published literature — Tessendorf's FFT ocean, JONSWAP and
Pierson–Moskowitz spectra, Preetham/Hosek–Wilkie sky models — and from
MIT-licensed Three.js examples.

All 3D models and HDRIs are CC0, sourced independently and listed with author and
URL in `ASSET_LICENSES.md`.
