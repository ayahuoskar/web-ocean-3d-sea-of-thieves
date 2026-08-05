# Waterline Faceting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the ocean mesh being displaced by wavelengths it cannot resolve, so the sea-level view reads as water rather than as a crumpled low-poly sheet.

**Architecture:** The vertex stage samples the displacement fields at an explicit mip level derived from the local vertex spacing, replacing a table of hand-tuned distance fades. The radial grid's ring/segment split is rebalanced so radial and angular spacing agree, which minimises the worst-axis spacing at unchanged vertex count. All the arithmetic lives in one pure, unit-tested module; the shader and the quality tiers consume it.

**Tech Stack:** TypeScript, three.js r0.185.1 (`three/webgpu` + TSL node materials), Vite, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-05-waterline-faceting-design.md`

## Global Constraints

- Nothing from `research/shadertoy/` may be copied into `src/`. Reproduce behaviour from technique only. See `research/shadertoy/README.md`.
- `npm run typecheck` must pass (`tsc --noEmit` over both `tsconfig.json` and `tsconfig.test.json`).
- Comments in this codebase explain **why**, at length, and cite measurements. Match that register — a bare restatement of the code is not acceptable here.
- Functional tests run under the `chromium-webgpu` Playwright project; visual/foam/jitter tests run under `visual` at 1280x720. Do not run visual specs under the functional project.
- Visual baselines will fail from Task 3 until Task 8 regenerates them. That is expected and is not a reason to stop.
- The one physical knob is `SAMPLES_PER_WAVELENGTH`. Do not introduce a second tuning multiplier anywhere.

---

### Task 1: The sampling-rate arithmetic, as a pure module

Extracted rather than inlined so it can be tested without a GPU, a browser, or a `three` import — and because the quality tiers and the shader must agree on it exactly.

**Files:**
- Create: `src/ocean/meshSampling.ts`
- Test: `tests/meshSampling.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SAMPLES_PER_WAVELENGTH: number` (= 4)
  - `vertexSpacingPerMetre(radialSegments: number, angularSegments: number, innerRadius: number, outerRadius: number): number`
  - `squareGrid(vertexBudget: number, innerRadius: number, outerRadius: number): { radialSegments: number; angularSegments: number }`
  - `geometryLod(distanceMetres: number, spacingPerMetre: number, texelMetres: number): number`
  - `resolvedWavelength(distanceMetres: number, spacingPerMetre: number): number`

- [ ] **Step 1: Write the failing test**

Create `tests/meshSampling.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import {
  SAMPLES_PER_WAVELENGTH,
  geometryLod,
  resolvedWavelength,
  squareGrid,
  vertexSpacingPerMetre,
} from '../src/ocean/meshSampling';

/**
 * Pure arithmetic — no browser, no GPU. It runs in the functional project
 * because that project ignores only the visual specs by name.
 */

/** The built mesh's own bounds. See `DEFAULT_MESH_OPTIONS`. */
const INNER = 0.6;
const OUTER = 24000;

test.describe('vertex spacing', () => {
  test('reports the worse of the two axes', () => {
    // High: 288 rings, 448 segments. Radial (0.0375) is the worse axis.
    expect(vertexSpacingPerMetre(288, 448, INNER, OUTER)).toBeCloseTo(0.03748, 4);

    // Invert the split and the angular axis becomes the worse one: 2*pi/64.
    expect(vertexSpacingPerMetre(2000, 64, INNER, OUTER)).toBeCloseTo(
      (Math.PI * 2) / 64,
      6,
    );
  });

  test('scales as one over the ring count', () => {
    const coarse = vertexSpacingPerMetre(144, 100000, INNER, OUTER);
    const fine = vertexSpacingPerMetre(288, 100000, INNER, OUTER);
    // exp(L/R) - 1, so not exactly a factor of two — but close, and monotone.
    expect(coarse / fine).toBeGreaterThan(1.9);
    expect(coarse / fine).toBeLessThan(2.1);
  });
});

test.describe('square grid', () => {
  test('equalises the two axes at a fixed vertex budget', () => {
    const { radialSegments, angularSegments } = squareGrid(288 * 448, INNER, OUTER);
    expect(radialSegments).toBe(466);
    expect(angularSegments).toBe(277);

    const radial = Math.pow(OUTER / INNER, 1 / radialSegments) - 1;
    const angular = (Math.PI * 2) / angularSegments;
    // Within a percent of each other: that is the whole point of the split.
    expect(Math.abs(radial - angular) / radial).toBeLessThan(0.01);
  });

  test('spends no more vertices than it was given', () => {
    const budget = 288 * 448;
    const { radialSegments, angularSegments } = squareGrid(budget, INNER, OUTER);
    expect(radialSegments * angularSegments).toBeLessThan(budget * 1.02);
  });

  test('resolves shorter waves than the split it replaces', () => {
    const before = vertexSpacingPerMetre(288, 448, INNER, OUTER);
    const { radialSegments, angularSegments } = squareGrid(288 * 448, INNER, OUTER);
    const after = vertexSpacingPerMetre(radialSegments, angularSegments, INNER, OUTER);
    expect(before / after).toBeGreaterThan(1.55);
  });
});

test.describe('geometry LOD', () => {
  test('keeps exactly the wavelengths the mesh can carry', () => {
    const spacingPerMetre = vertexSpacingPerMetre(288, 448, INNER, OUTER);
    const texel = 16 / 256; // ripple cascade: tile 16 m over a 256 FFT
    const lod = geometryLod(20, spacingPerMetre, texel);

    // A mip of level L averages 2^L texels; a box average of width f
    // suppresses wavelengths under 2f. So the shortest surviving wavelength
    // is 2 * texel * 2^lod, and it must equal SAMPLES_PER_WAVELENGTH spacings.
    const surviving = 2 * texel * Math.pow(2, lod);
    const spacing = 20 * spacingPerMetre;
    expect(surviving).toBeCloseTo(SAMPLES_PER_WAVELENGTH * spacing, 6);
    expect(resolvedWavelength(20, spacingPerMetre)).toBeCloseTo(surviving, 6);
  });

  test('never asks for a sharper mip than level zero', () => {
    // Right under the camera the spacing is millimetres and the field is
    // already over-sampled; a negative level is not a thing to request.
    expect(geometryLod(0, 0.0375, 0.0625)).toBe(0);
    expect(geometryLod(0.01, 0.0375, 0.0625)).toBe(0);
  });

  test('reproduces the fade distances that were tuned by eye', () => {
    const s = vertexSpacingPerMetre(288, 448, INNER, OUTER);
    // The ripple cascade tops out at 6 m; it is extinguished once the
    // shortest surviving wavelength passes that. The table it replaces
    // ramped 18 -> 55 m.
    const rippleGone = 6 / (SAMPLES_PER_WAVELENGTH * s);
    expect(rippleGone).toBeGreaterThan(18);
    expect(rippleGone).toBeLessThan(55);

    // Chop tops out at 24 m; its table ramped 110 -> 300 m.
    const chopGone = 24 / (SAMPLES_PER_WAVELENGTH * s);
    expect(chopGone).toBeGreaterThan(110);
    expect(chopGone).toBeLessThan(300);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx playwright test --project=chromium-webgpu tests/meshSampling.spec.ts
```

Expected: FAIL — `Cannot find module '../src/ocean/meshSampling'`.

- [ ] **Step 3: Write the implementation**

Create `src/ocean/meshSampling.ts`:

```ts
/**
 * What the ocean mesh can and cannot resolve.
 *
 * Kept apart from `OceanMesh` and from `OceanMaterial` because three consumers
 * have to agree on it exactly — the grid that is built, the quality tiers that
 * size it, and the vertex stage that decides how much of the wave field to
 * displace by — and because it is pure arithmetic that deserves to be tested
 * without standing up a GPU to do it.
 *
 * The whole module rests on one number. A displaced grid stops reading as a
 * surface and starts reading as facets when it carries fewer than about four
 * vertices per wavelength: at two it is at Nyquist and every triangle lands on
 * a different phase, which is what spikes isolated vertices into pyramids. Four
 * is the point where a crest is a curve rather than a corner.
 */
export const SAMPLES_PER_WAVELENGTH = 4;

/**
 * Metres of vertex spacing per metre of ground distance, for a radial grid.
 *
 * Both axes are computed and the **worse** one is returned, because that is the
 * one that governs: a wave survives only if it is resolved along every
 * direction, so over-sampling one axis buys nothing while the other is coarse.
 * On the grid as originally proportioned the two differ by 2.7x, which is why
 * `squareGrid` below exists.
 *
 * Radii grow geometrically, so radial spacing is `r * (growth - 1)` and is
 * proportional to distance; the angular spacing `2*pi*r/segments` is too. That
 * shared proportionality is what lets the whole question collapse to a single
 * scalar.
 */
export function vertexSpacingPerMetre(
  radialSegments: number,
  angularSegments: number,
  innerRadius: number,
  outerRadius: number,
): number {
  const growth = Math.pow(outerRadius / innerRadius, 1 / radialSegments);
  return Math.max(growth - 1, (Math.PI * 2) / angularSegments);
}

/**
 * The ring/segment split that minimises the worse axis for a given vertex count.
 *
 * Radial spacing is `L/R` for `L = ln(outer/inner)` and angular is `2*pi/S`.
 * Their max is smallest where they are equal, so `S = 2*pi*R/L`; substituting
 * `R*S = budget` gives `R = sqrt(budget * L / 2*pi)`.
 *
 * The rounding is deliberately toward the radial axis — `S` is derived from the
 * rounded `R` rather than both being rounded independently — because a spare
 * vertex is worth more on the axis that was the constraint.
 */
export function squareGrid(
  vertexBudget: number,
  innerRadius: number,
  outerRadius: number,
): { radialSegments: number; angularSegments: number } {
  const l = Math.log(outerRadius / innerRadius);
  const radialSegments = Math.round(Math.sqrt((vertexBudget * l) / (Math.PI * 2)));
  const angularSegments = Math.round((Math.PI * 2 * radialSegments) / l);
  return { radialSegments, angularSegments };
}

/**
 * The shortest wavelength the mesh can carry at this distance, metres.
 */
export function resolvedWavelength(
  distanceMetres: number,
  spacingPerMetre: number,
): number {
  return SAMPLES_PER_WAVELENGTH * distanceMetres * spacingPerMetre;
}

/**
 * The mip level to displace geometry from, for a field of this texel size.
 *
 * A mip of level L is an average over `2^L` texels, so its footprint is
 * `2^L * texelMetres` metres; a box average of width `f` suppresses wavelengths
 * below `2f`. Wanting everything under `SAMPLES_PER_WAVELENGTH * spacing` gone
 * therefore means a footprint of half that, and the level follows by logarithm.
 *
 * Clamped at zero rather than allowed to go negative. Near the camera the
 * spacing is millimetres and the field is already over-sampled; there is no
 * sharper level than the one that exists, and asking for one is a request the
 * sampler would have to invent an answer to.
 */
export function geometryLod(
  distanceMetres: number,
  spacingPerMetre: number,
  texelMetres: number,
): number {
  const footprint = (SAMPLES_PER_WAVELENGTH / 2) * distanceMetres * spacingPerMetre;
  return Math.max(0, Math.log2(Math.max(footprint / texelMetres, 1)));
}
```

**Correction to `squareGrid`, found by running it.** The closed form above is
wrong enough to matter and the committed implementation does not use it as
written. It solves `L/R = 2*pi/S`, but the radial spacing is really
`exp(L/R) - 1` — about 1% larger at these ring counts — so it lands 0.7% off the
best pair and leaves the two axes a full percent apart, which is precisely the
state the function exists to remove.

The committed version keeps that expression as a **seed** and searches ±10%
around it for the pair with the smallest worse axis, taking `floor(budget/R)` so
the budget is never exceeded. Consequences for the steps above: the expected
pair is **469×275, not 466×277**, and the squareness bound is **0.001, not
0.01**. See `src/ocean/meshSampling.ts` as committed.

- [ ] **Step 4: Run tests to verify they pass**

```
npx playwright test --project=chromium-webgpu tests/meshSampling.spec.ts
npm run typecheck
```

Expected: 8 passed; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/ocean/meshSampling.ts tests/meshSampling.spec.ts
git commit -m "Work out what the mesh can actually resolve, in one place"
```

---

### Task 2: `OceanMesh` publishes its own sampling rate

**Files:**
- Modify: `src/ocean/OceanMesh.ts` (constructor and class body, around lines 37-51)
- Test: `tests/meshSampling.spec.ts` (append)

**Interfaces:**
- Consumes: `vertexSpacingPerMetre` from Task 1.
- Produces: `OceanMesh.spacingPerMetre: number` — a readonly field, consumed by `main.ts` in Task 3.

- [ ] **Step 1: Write the failing test**

Append to `tests/meshSampling.spec.ts`:

Add to the imports at the top of the file:

```ts
import { DEFAULT_MESH_OPTIONS, OceanMesh } from '../src/ocean/OceanMesh';
```

and append the test:

```ts
test.describe('OceanMesh', () => {
  test('publishes the spacing its own options imply', () => {
    // `undefined` material, so `THREE.Mesh` supplies its own default rather
    // than being handed a null it will later try to dispose.
    const mesh = new OceanMesh(undefined as never, {
      radialSegments: 288,
      angularSegments: 448,
    });
    expect(mesh.spacingPerMetre).toBeCloseTo(
      vertexSpacingPerMetre(
        288,
        448,
        DEFAULT_MESH_OPTIONS.innerRadius,
        DEFAULT_MESH_OPTIONS.outerRadius,
      ),
      6,
    );
    mesh.dispose();
  });
});
```

A static import is safe here: `three/webgpu` imports cleanly under Node (verified), and `tests/fish.spec.ts:3` already imports a three-dependent `src/` module the same way.

- [ ] **Step 2: Run test to verify it fails**

```
npx playwright test --project=chromium-webgpu tests/meshSampling.spec.ts -g "publishes the spacing"
```

Expected: FAIL — `mesh.spacingPerMetre` is `undefined`, so `toBeCloseTo` receives undefined.

- [ ] **Step 3: Implement**

In `src/ocean/OceanMesh.ts`, add the import at the top:

```ts
import { vertexSpacingPerMetre } from './meshSampling';
```

Add the field and its assignment to the class:

```ts
export class OceanMesh {
  readonly geometry: THREE.BufferGeometry;
  readonly mesh: THREE.Mesh;
  /**
   * Metres of vertex spacing per metre of ground distance — the worse of the
   * two axes. The vertex stage needs it to decide how much of the wave field
   * this mesh is entitled to be displaced by; see `ocean/meshSampling`.
   */
  readonly spacingPerMetre: number;
  private readonly options: OceanMeshOptions;

  constructor(material: THREE.Material, options: Partial<OceanMeshOptions> = {}) {
    this.options = { ...DEFAULT_MESH_OPTIONS, ...options };
    this.spacingPerMetre = vertexSpacingPerMetre(
      this.options.radialSegments,
      this.options.angularSegments,
      this.options.innerRadius,
      this.options.outerRadius,
    );
    this.geometry = buildRadialGrid(this.options);
    // ...unchanged from here
```

While in this file, correct the stale claim in the class header: it says "Vertex positions are unit-space; the world radius is applied in the vertex shader", and `buildRadialGrid` writes world metres directly. Replace that sentence with:

```
 * Vertex positions are world metres about the mesh origin, and the mesh origin
 * is snapped to the camera every frame — so a vertex's own XZ length is its
 * ground distance from the viewer, which is what the vertex stage's level of
 * detail is computed from.
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx playwright test --project=chromium-webgpu tests/meshSampling.spec.ts
npm run typecheck
```

Expected: 8 passed; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/ocean/OceanMesh.ts tests/meshSampling.spec.ts
git commit -m "Let the mesh say how finely it samples the world"
```

---

### Task 3: Band-limit the vertex displacement

The fix. After this task the visual baselines will not match; that is expected until Task 8.

**Files:**
- Modify: `src/ocean/OceanSimulation.ts` (add a `resolution` getter near the `tileSizes` getter, ~line 175)
- Modify: `src/ocean/OceanMaterial.ts` (inputs interface ~line 63; uniforms ~line 334; `setCascades` ~line 645; vertex stage ~lines 712-728; fade table ~lines 1998-2047)
- Modify: `src/main.ts` (`buildWaterMaterial` ~line 1119; mesh construction ~line 391 and ~line 1179; `setCascades` call ~line 1165)

**Interfaces:**
- Consumes: `geometryLod`, `SAMPLES_PER_WAVELENGTH` from Task 1; `OceanMesh.spacingPerMetre` from Task 2.
- Produces:
  - `OceanSimulation.resolution: number` (getter)
  - `OceanMaterial.setVertexSpacing(spacingPerMetre: number): void`
  - `OceanMaterial.setCascades(displacementTextures, derivativeTextures, tileSizes, resolution: number)` — **fourth parameter added**
  - `OceanMaterialInputs.resolution: number` — **new required field**

- [ ] **Step 1: Expose the FFT resolution**

In `src/ocean/OceanSimulation.ts`, next to the existing `tileSizes` getter:

```ts
  /**
   * Texels per side of every cascade's output.
   *
   * Published because a tile size alone does not say how finely the field is
   * sampled, and the surface needs metres-per-texel to choose a mip level.
   */
  get resolution(): number {
    return this.size;
  }
```

- [ ] **Step 2: Add the uniforms and the setters**

In `src/ocean/OceanMaterial.ts`, add `log2` to the `three/tsl` import list, and add to the imports:

```ts
import { SAMPLES_PER_WAVELENGTH } from './meshSampling';
```

Add the required field to `OceanMaterialInputs`, immediately after `tileSizes`:

```ts
  /** Texels per side of each cascade's output, for metres-per-texel. */
  resolution: number;
```

Add these fields alongside `uTileSizes` in the class:

```ts
  /**
   * Metres of vertex spacing per metre of ground distance, from the mesh.
   *
   * Zero would mean an infinitely fine mesh, so it is the safe default: it
   * makes the level of detail zero and the surface behaves exactly as it did
   * before this was wired, rather than silently flattening the sea if a caller
   * forgets `setVertexSpacing`.
   */
  private readonly uVertexSpacing = uniform(0);
  /** Metres per texel of each cascade's field. See `setCascades`. */
  private readonly uTexelMetres: any[] = [];
```

Push a uniform per cascade inside the existing `for (let i = 0; i < MAX_CASCADES; i++)` loop in `build()`, beside the `uTileSizes.push(...)` line:

```ts
      this.uTexelMetres.push(uniform(tileSizes[source] / inputs.resolution));
```

Add the setter next to `setWakeDisplacement`:

```ts
  /**
   * Tells the surface how finely the mesh it is drawn on samples the world.
   *
   * Must be called whenever the mesh is built or rebuilt. Getting it wrong does
   * not fail loudly: too small displaces geometry by waves it cannot resolve
   * and the surface facets, too large flattens the sea into a sheet.
   */
  setVertexSpacing(spacingPerMetre: number): void {
    this.uVertexSpacing.value = Math.max(0, spacingPerMetre);
  }
```

Extend `setCascades` to take and apply the resolution:

```ts
  setCascades(
    displacementTextures: THREE.Texture[],
    derivativeTextures: THREE.Texture[],
    tileSizes: number[],
    resolution: number,
  ): void {
    const active = Math.min(displacementTextures.length, MAX_CASCADES);
    for (let i = 0; i < MAX_CASCADES; i++) {
      const source = Math.min(i, active - 1);
      this.displacementNodes[i].value = displacementTextures[source];
      this.derivativeNodes[i].value = derivativeTextures[source];
      this.uTileSizes[i].value = tileSizes[source];
      this.uTexelMetres[i].value = tileSizes[source] / resolution;
      this.uCascadeWeights[i].value = i < active ? 1 : 0;
    }
  }
```

- [ ] **Step 3: Replace the fade with the level of detail**

In `src/ocean/OceanMaterial.ts`, replace the vertex-stage displacement loop (currently lines 714-726, the comment beginning "Fade the highest-frequency cascades out with distance") with:

```ts
      // Displace by exactly as much of the field as this mesh can carry, and
      // not one wave more.
      //
      // A vertex-stage texture read has no derivatives, so it compiles to LOD 0
      // and takes the sharpest mip whatever the vertex spacing is. That is the
      // whole of the faceting: the ripple cascade runs down to 5 cm wavelengths
      // and was displacing geometry whose vertices are 20 cm apart at five
      // metres and 75 cm apart at twenty, so every triangle landed on an
      // unrelated phase and isolated vertices spiked into pyramids.
      //
      // The level is not a fade and not a distance ramp. It is the mip whose
      // footprint low-passes the field to the shortest wavelength four vertices
      // can describe — see `ocean/meshSampling`. Where the old table had an
      // opinion this agrees with it, extinguishing the ripple cascade at 40 m
      // against its 18-55 m ramp and the chop at 160 m against its 110-300 m;
      // what it adds is the near field, where the table said nothing and where
      // the spikes were.
      //
      // A cascade puts itself out. Once the level runs past the last mip the
      // sampler clamps to the 1x1 level, which is the mean of a zero-mean
      // field — so the distance table is gone rather than kept, since keeping
      // it would attenuate the same thing twice.
      //
      // The mip chains cost nothing extra: `makeOutputTarget` has always built
      // them, for a consumer that until now only existed in the fragment stage.
      // Hoisted: the footprint is a property of this vertex, not of a cascade.
      // Only the division by a cascade's own texel size varies inside the loop.
      const footprint = groundDistance
        .mul(this.uVertexSpacing)
        .mul(SAMPLES_PER_WAVELENGTH / 2)
        .toVar();
      for (let i = 0; i < cascadeCount; i++) {
        const lod = log2(footprint.div(this.uTexelMetres[i]).max(1)).toVar();
        const sample = this.displacementNodes[i]
          .sample(worldXZ.div(this.uTileSizes[i]))
          .level(lod)
          .toVar();
        displacement.addAssign(sample.xyz.mul(this.uCascadeWeights[i]));
      }
```

**On the duplicated formula.** `geometryLod` in `ocean/meshSampling` and these three lines compute the same thing, and they can drift. The duplication is accepted because a TSL node graph cannot be evaluated in a Node test, so the tested copy is the only way to pin the arithmetic at all; what stops the drift mattering is that the one number with a physical meaning — `SAMPLES_PER_WAVELENGTH` — is imported here rather than written twice. Say so in a comment at the `log2` line, so the next reader knows the TS copy exists and is the specification.

Then delete `CASCADE_GEOMETRY_FADE_METRES` and `cascadeGeometryFade` (lines ~2013-2017 and ~2038-2041), and rewrite the shared header above `CASCADE_SHADING_FADE_METRES` so it still explains the geometry/shading split that remains:

```ts
/**
 * Geometry and shading need *different* LOD curves, and conflating them is what
 * makes naive ocean meshes sparkle.
 *
 * Geometry's limit is its own sampling rate, and it is now enforced where it
 * belongs — in the vertex stage, as a mip level computed from the local vertex
 * spacing. See `ocean/meshSampling` and the displacement loop in `build`. The
 * fixed-metre table that used to stand here is gone: it could not know the
 * tier's mesh density, and the level does.
 *
 * Shading has no such limit: the derivative textures are mipmapped, so the
 * fragment stage samples them correctly at any distance. Normals therefore carry
 * the detail far beyond where the geometry has flattened out, which is exactly
 * how real distant water reads — a smooth sheet with fine specular structure.
 */
```

Leave `cascadeShadingFade` and `fadeFrom` exactly as they are. `fadeFrom`'s `count === 1` early return is still reached through `cascadeShadingFade`.

**Leave the wake displacement alone.** It reads the accumulation buffer at LOD 0 under the same argument, but that buffer is built by `Wake.ts:1510` with `generateMipmaps: false` and `LinearFilter` — there is no mip chain to select from, so its existing 220-620 m distance fade stays. Do not add a half-measure here.

- [ ] **Step 4: Wire it up in `main.ts`**

In `buildWaterMaterial`, add the resolution beside the tile sizes:

```ts
      tileSizes: this.simulation.tileSizes,
      resolution: this.simulation.resolution,
```

At the boot-time mesh construction (after `this.scene.add(this.oceanMesh.mesh);`, ~line 395) and again at the tier-change rebuild (~line 1183), add:

```ts
    this.water.setVertexSpacing(this.oceanMesh.spacingPerMetre);
```

At the `setCascades` call (~line 1165), pass the resolution:

```ts
    this.water.setCascades(
      this.simulation.displacementTextures,
      this.simulation.derivativeTextures,
      this.simulation.tileSizes,
      this.simulation.resolution,
    );
```

- [ ] **Step 5: Verify it compiles and the shader builds**

```
npm run typecheck
npx playwright test --project=chromium-webgpu tests/ocean.spec.ts
```

Expected: typecheck clean. `ocean.spec.ts` passes — it exercises tier changes, which is what proves `setCascades` and `setVertexSpacing` are called on every path and that the graph still compiles after `.level()` was introduced.

If the shader fails to build, the suspect is the node composition: `.sample(uv).level(lod)` clones twice and each clone sets `referenceNode` to the base, which is what keeps `setCascades`'s `.value` writes propagating. Three's own `textureLevel` helper composes it the same way (`TextureNode.js:1006`). Do not work around a build failure by binding a fresh `texture()` per frame — that recompiles the graph mid-session, which is the exact failure `setCascades` exists to prevent.

- [ ] **Step 6: Commit**

```bash
git add src/ocean/meshSampling.ts src/ocean/OceanMaterial.ts src/ocean/OceanSimulation.ts src/main.ts
git commit -m "Displace the mesh by the waves it can carry, and no others"
```

---

### Task 4: Measure what Task 3 did, before changing anything else

A measurement task with no production edit. It exists because the next task and the foam work both depend on knowing whether the band-limit worked and how much detail it cost.

**Files:**
- Create: `docs/superpowers/plans/2026-08-05-waterline-measurements.md` (a scratch record, committed)

- [ ] **Step 1: Capture the shot the complaint was about**

```bash
KEEP_ARTIFACTS=1 npx playwright test --project=visual tests/visual.spec.ts -g "waterline"
```

The shot will fail against its baseline — that is the point. Playwright writes the actual frame under `test-results/`. Find it and copy it to `docs/superpowers/plans/waterline-after-bandlimit.png` **temporarily**; it is a working artefact and Task 8 deletes it.

- [ ] **Step 2: Compare it against the baseline by eye**

Open `tests/baselines/waterline.png` and the new capture side by side. Record in the measurements file, honestly, whether:
- the triangular pyramids at the crests are gone,
- the crest lines read as curves rather than runs of straight segments,
- the mid-field has gone visibly flatter, and by how much.

The third is the cost of this change and must be written down even if it is bad.

- [ ] **Step 3: Run the shimmer gate**

```bash
npx playwright test --project=visual tests/gallery-jitter.spec.ts
```

Record every printed `SHIMMER <tier> far temporal … highFreq … | near detail …` line in the measurements file.

Expected direction: far-field `highFreq` falls or holds; near-field `detail` stays above `DETAIL_FLOOR` (0.4).

**If `detail` has fallen below 0.4, the band-limit went too far and the fix is `SAMPLES_PER_WAVELENGTH`, not the floor.** Lower it from 4 toward 3, re-run Task 1's tests (the "reproduces the fade distances" test will tighten), and re-measure. Do not move `DETAIL_FLOOR` — it exists precisely to catch "fixed the shimmer by flattening the sea", which is this change's most likely failure mode.

- [ ] **Step 4: Commit the measurements**

```bash
git add docs/superpowers/plans/2026-08-05-waterline-measurements.md
git commit -m "Record what the band-limit actually did"
```

---

### Task 5: Square the tier grids

**Files:**
- Modify: `src/core/QualityManager.ts` (`meshRings`/`meshSegments` in all five tiers: lines ~228, ~256, ~284, ~310, ~336)
- Test: `tests/meshSampling.spec.ts` (append)

**Interfaces:**
- Consumes: `squareGrid`, `vertexSpacingPerMetre` from Task 1.
- Produces: nothing new — the tier table's values change, its shape does not.

- [ ] **Step 1: Write the failing test**

Append to `tests/meshSampling.spec.ts`:

```ts
/**
 * The vertex budget each tier had before the split was squared. Hard-coded
 * rather than imported, so that a tier quietly growing its budget shows up as a
 * failure here rather than as a frame-rate regression somewhere else.
 */
const TIER_BUDGET: Record<string, number> = {
  low: 128 * 192,
  medium: 192 * 288,
  high: 288 * 448,
  ultra: 384 * 576,
  max: 512 * 768,
};

test.describe('quality tiers', () => {
  test('spend their vertices on square triangles', () => {
    for (const [name, budget] of Object.entries(TIER_BUDGET)) {
      const tier = QUALITY_TIERS[name as keyof typeof QUALITY_TIERS];
      const radial = Math.pow(24000 / 0.6, 1 / tier.meshRings) - 1;
      const angular = (Math.PI * 2) / tier.meshSegments;
      expect(
        Math.abs(radial - angular) / radial,
        `${name} is still ${(Math.max(radial, angular) / Math.min(radial, angular)).toFixed(2)}x ` +
          'out of square, so the finer axis is buying nothing',
      ).toBeLessThan(0.02);

      expect(
        tier.meshRings * tier.meshSegments,
        `${name} grew its vertex budget`,
      ).toBeLessThan(budget * 1.02);
    }
  });

  test('resolve shorter waves than they did', () => {
    const before: Record<string, [number, number]> = {
      low: [128, 192],
      medium: [192, 288],
      high: [288, 448],
      ultra: [384, 576],
      max: [512, 768],
    };
    for (const [name, [r, s]] of Object.entries(before)) {
      const tier = QUALITY_TIERS[name as keyof typeof QUALITY_TIERS];
      const was = vertexSpacingPerMetre(r, s, 0.6, 24000);
      const now = vertexSpacingPerMetre(tier.meshRings, tier.meshSegments, 0.6, 24000);
      expect(was / now, `${name} did not improve`).toBeGreaterThan(1.55);
    }
  });
});
```

Add to the imports at the top of the file:

```ts
import { QUALITY_TIERS } from '../src/core/QualityManager';
```

`src/core/QualityManager.ts` has no imports of its own, so this costs the test nothing.

- [ ] **Step 2: Run test to verify it fails**

```
npx playwright test --project=chromium-webgpu tests/meshSampling.spec.ts -g "quality tiers"
```

Expected: FAIL — high is 2.7x out of square.

- [ ] **Step 3: Change the tier table**

Set these values, and put the explanation on the `meshRings` field's doc comment (~line 10, which already says "vertex spacing scales as radius / meshRings"):

| tier | meshRings | meshSegments |
|---|---|---|
| low | 206 | 119 |
| medium | 308 | 179 |
| high | 469 | 275 |
| ultra | 613 | 360 |
| max | 817 | 481 |

These are `squareGrid`'s output, not the closed form's — see the note in Task 1
Step 3. Regenerate them rather than trusting this table if the bounds change:
`squareGrid(meshRings * meshSegments, 0.6, 24000)` for each tier's old pair.

Amend the `meshRings` doc comment to:

```ts
  /**
   * The lever on surface fidelity, and it is the *worse* of the two mesh axes
   * that pulls it.
   *
   * Radial spacing is `ln(24000/0.6) / meshRings` per metre of distance and
   * angular is `2*pi / meshSegments`; a wave survives displacement only if both
   * resolve it, so the coarser axis governs and over-sampling the finer one is
   * vertices spent on nothing. These pairs are square to within 0.3% — see
   * `squareGrid` in `ocean/meshSampling` — which at unchanged vertex and
   * triangle count buys a 1.6x shorter surviving wavelength at every distance
   * and every tier.
   *
   * What it spends is the horizon ring's smoothness: at High the outer ring is
   * a 275-gon rather than a 448-gon, and at 24 km its chord sags 1.57 m, which
   * subtends 6.5e-5 rad against 9.7e-4 rad for a pixel at 720 lines over a 40
   * degree field. Fifteen times under a pixel, from any camera height.
   */
  meshRings: number;
```

- [ ] **Step 4: Run tests to verify they pass**

```
npx playwright test --project=chromium-webgpu tests/meshSampling.spec.ts
npm run typecheck
npx playwright test --project=chromium-webgpu tests/ocean.spec.ts
```

Expected: all `meshSampling` tests pass; typecheck clean; `ocean.spec.ts` passes, which is what proves every tier still builds a mesh and cycles without error.

- [ ] **Step 5: Re-measure**

```bash
npx playwright test --project=visual tests/gallery-jitter.spec.ts
KEEP_ARTIFACTS=1 npx playwright test --project=visual tests/visual.spec.ts -g "waterline"
```

Append the new `SHIMMER` lines to `docs/superpowers/plans/2026-08-05-waterline-measurements.md`, under a heading that says the grid was squared, and note whether the near-field `detail` figure recovered any of what Task 4 recorded losing.

- [ ] **Step 6: Commit**

```bash
git add src/core/QualityManager.ts tests/meshSampling.spec.ts docs/superpowers/plans/2026-08-05-waterline-measurements.md
git commit -m "Stop spending half the vertex budget on the axis that was never the constraint"
```

---

### Task 6: Establish whether the white is foam or sky

**Files:**
- Modify: `src/main.ts` (test API block ~line 2347, near `setRainOverride`; and the per-frame foam write at ~line 1495)
- Modify: `docs/superpowers/plans/2026-08-05-waterline-measurements.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `window.__ocean.setFoamOverride(strength: number | null): void`

- [ ] **Step 1: Add the override, following the `setRainOverride` pattern**

In `src/main.ts`, add a field beside the existing `rainOverride`:

```ts
  /**
   * Test-only foam strength, or `null` for the weather system's own.
   *
   * Exists so a capture can answer a question a single frame cannot: at a
   * sea-level camera every wave face is at grazing incidence, where Fresnel
   * drives reflectance toward one and the sea legitimately returns the pale
   * sky — so white in that frame is not evidence of foam. Differencing the
   * frame against one with the foam and the surf forced off separates them.
   */
  private foamOverride: number | null = null;
```

At the per-frame write (~line 1495), respect it:

```ts
    this.water.setFoamStrength(
      this.foamOverride ?? Math.max(0.35, Math.min(1.2, Math.sqrt(whitecapRatio))),
    );
```

Find the per-frame `this.water.setSurf(elapsed);` call (~line 1809) and make it carry the override too:

```ts
    this.water.setSurf(elapsed, this.foamOverride ?? 1);
```

And expose it in the test API block, next to `setRainOverride`:

```ts
        /**
         * Forces foam and surf strength together, or `null` to hand both back
         * to the weather system. Zero is the "no foam at all" reference frame.
         */
        setFoamOverride: (strength: number | null) => {
          this.foamOverride = strength;
        },
```

If `window.__ocean`'s type is declared somewhere (search for `__ocean` in a `.d.ts` or a `declare global` block, including `tests/helpers.ts`), add the signature there too or `npm run typecheck` will fail on the test in Step 2.

- [ ] **Step 2: Write the measurement test**

Create `tests/foam-attribution.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { bootOcean, capture } from './lib/capture';
import { setCamera, setState } from './helpers';

/**
 * Is the white in the waterline shot foam, or is it the sky?
 *
 * At a camera 2 cm above the surface every wave face is at grazing incidence,
 * where Fresnel reflectance approaches one and the water legitimately returns a
 * pale sky. Whitecap *coverage* is already governed by Monahan and pinned by
 * `foam.spec.ts`, so the amount is unlikely to be the defect — but "unlikely"
 * is not a measurement, and the foam work is gated on this answer.
 */
test('how much of the waterline shot is foam', async ({ page }) => {
  test.setTimeout(600_000);
  await bootOcean(page);
  await setState(page, {
    quality: 'high',
    preset: 'skyPro',
    windSpeed: 5,
    peakWavelength: 20,
    cloudCoverage: 0.3,
  });
  await setCamera(page, [-46, 0.02, 44], [-76, 1, 24]);

  await page.evaluate(() => window.__ocean.resetDeterministic(63.75, 90));
  const withFoam = await capture(page);

  await page.evaluate(() => window.__ocean.setFoamOverride(0));
  await page.evaluate(() => window.__ocean.resetDeterministic(63.75, 90));
  const withoutFoam = await capture(page);

  const luma = (i: number, img: typeof withFoam) =>
    0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];

  // The lower half of the frame is water; the upper half is sky and island.
  let changed = 0;
  let total = 0;
  let sumDelta = 0;
  for (let y = Math.floor(withFoam.height / 2); y < withFoam.height; y++) {
    for (let x = 0; x < withFoam.width; x++) {
      const i = (y * withFoam.width + x) * 4;
      const delta = Math.abs(luma(i, withFoam) - luma(i, withoutFoam));
      sumDelta += delta;
      if (delta > 8) changed++;
      total++;
    }
  }

  console.log(
    `[foam-attribution] ${((100 * changed) / total).toFixed(1)}% of water pixels ` +
      `move by more than 8 levels when foam is switched off; ` +
      `mean move ${(sumDelta / total).toFixed(2)} levels`,
  );

  // Not an assertion about what is right — an assertion that the override
  // does something, so that a reading of "0%" means "the white is sky"
  // rather than "the hook is not wired".
  expect(changed / total).toBeGreaterThan(0);
});
```

Add `foam-attribution` to the `visual` project's `testMatch` and to `chromium-webgpu`'s `testIgnore` in `playwright.config.ts`, since it captures at shot resolution:

```ts
      testIgnore: /(visual|gallery|gallery-jitter|isolation|foam|foam-attribution)\.spec\.ts/,
```
```ts
      testMatch: /(visual|gallery|gallery-jitter|isolation|foam|foam-attribution)\.spec\.ts/,
```

- [ ] **Step 3: Run it and record the answer**

```bash
npx playwright test --project=visual tests/foam-attribution.spec.ts
```

Record the printed percentage and mean in `docs/superpowers/plans/2026-08-05-waterline-measurements.md`.

- [ ] **Step 4: Act on the answer, and only on the answer**

- **If under ~10% of water pixels move**: the white is Fresnel sky reflection. **Make no foam change.** Write that conclusion into the measurements file and into the spec's section 3, replacing the conditional with the finding. This is a legitimate outcome, not a failure to find work.

- **If a large fraction moves**: it is foam, and the defect is placement. `crestBias` at `OceanMaterial.ts:1434` reads `worldPos.y`, the *displaced* elevation, which Tasks 3 and 5 have made smoother and rounder — so foam that was keyed to spiky geometry will now sit lower on the wave than it should. Re-key it to the shading-detail surface by using the wave field's own elevation rather than the mesh's. Add a step here with the actual edit before making it, and re-run `tests/foam.spec.ts` afterwards, since Monahan coverage must survive.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts tests/foam-attribution.spec.ts playwright.config.ts docs/superpowers/plans/2026-08-05-waterline-measurements.md
git commit -m "Ask the frame whether its white is foam or sky"
```

---

### Task 7: Confirm the physics still agrees with the picture

The drawn surface is now band-limited while the CPU `Sampler` still reads the field at full detail, so the hull floats on a slightly different surface than the one drawn. The spec predicts centimetres near the camera. This checks that prediction rather than assuming it.

**Files:**
- Modify: `docs/superpowers/plans/2026-08-05-waterline-measurements.md`

- [ ] **Step 1: Run the buoyancy and ocean assertions**

```bash
npx playwright test --project=chromium-webgpu tests/ocean.spec.ts
```

Expected: PASS, including "a moderate sea leaves the hull on its designed waterline".

- [ ] **Step 2: If the hull assertion fails, do not retune it**

The assertion pins a physical claim — the hull sits on its design waterline — and the band-limit does not change the field the buoyancy solver reads. A failure here means the drawn surface and the sampled surface have diverged enough to matter, and the honest response is to record the magnitude in the measurements file and stop for a decision, not to move the tolerance.

- [ ] **Step 3: Run the rest of the functional suite**

```bash
npx playwright test --project=chromium-webgpu
```

Expected: PASS. Record any failure in the measurements file with its full message.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-08-05-waterline-measurements.md
git commit -m "Check the hull still floats on the sea we are drawing"
```

---

### Task 8: Regenerate the baselines and the noise floors

**Files:**
- Modify: `tests/baselines/**` (regenerated)
- Modify: `tests/lib/shots.ts` (`MEASURED_NOISE_FLOOR`, ~line 650)
- Modify: `tests/gallery-jitter.spec.ts` (`SHIMMER_CEILING` / `TEMPORAL_CEILING`, only if justified — see below)
- Delete: `docs/superpowers/plans/waterline-after-bandlimit.png` if Task 4 left it

- [ ] **Step 1: Re-measure the noise floors**

```bash
MEASURE_NOISE=1 npx playwright test --project=visual tests/visual.spec.ts
```

Paste the printed block into `MEASURED_NOISE_FLOOR` in `tests/lib/shots.ts`, as the header there instructs.

- [ ] **Step 2: Regenerate the baselines**

```bash
UPDATE_BASELINES=1 npx playwright test --project=visual tests/visual.spec.ts
```

- [ ] **Step 3: Verify they now hold**

```bash
npx playwright test --project=visual
```

Expected: PASS across `visual`, `gallery-jitter`, `isolation`, `foam` and `foam-attribution`.

- [ ] **Step 4: Only if `gallery-jitter` fails, and only with a reason**

`SHIMMER_CEILING` and `TEMPORAL_CEILING` are measured constants with a long recorded history of *not* being moved to make a change pass — read the header at `tests/gallery-jitter.spec.ts:69-112` before touching either.

If a ceiling now fails, the expected direction of this work is **downward**, so a rise is a regression to explain, not a number to update. If a ceiling can be *lowered* because the far field is genuinely quieter, lower it and record the before/after figures in the comment, in the style the existing header uses.

- [ ] **Step 5: Regenerate the gallery**

```bash
CAPTURE_GALLERY=1 npx playwright test --project=visual tests/gallery.spec.ts
```

This rewrites `docs/images/**`, which the README shows. Check `docs/images/waves.png` and `docs/images/shore.png` by eye before committing.

- [ ] **Step 6: Commit**

```bash
git add tests/baselines tests/lib/shots.ts tests/gallery-jitter.spec.ts docs/images
git rm --cached -f --ignore-unmatch docs/superpowers/plans/waterline-after-bandlimit.png
git commit -m "Regenerate the baselines against a sea that is no longer faceted"
```

---

### Task 9: Independent verification with Codex

An outside reader with no stake in the design, run against the working tree. `codex` is at version 0.146.0 on this machine.

**Files:**
- Create: `docs/superpowers/plans/2026-08-05-waterline-codex-review.md`

- [ ] **Step 1: Ask Codex to attack the change**

```bash
git diff main...HEAD > /tmp/waterline.diff
codex exec --skip-git-repo-check "Read docs/superpowers/specs/2026-08-05-waterline-faceting-design.md, then review the diff of this branch against main. This is a WebGPU/TSL ocean renderer. Focus on four things and be adversarial about each: (1) is the mip-level formula in the vertex stage of src/ocean/OceanMaterial.ts correct - a mip of level L averages 2^L texels and a box average of width f suppresses wavelengths under 2f, so does log2(footprint/texelMetres) with footprint = 2*spacing actually retain exactly 4 vertices per wavelength; (2) does removing CASCADE_GEOMETRY_FADE_METRES leave any distance at which a cascade contributes displacement it should not, given that a mip chain clamps to its 1x1 level rather than to zero; (3) do the squared meshRings/meshSegments pairs in src/core/QualityManager.ts really hold the vertex budget while equalising the axes, and is the horizon-sag argument sound; (4) does .sample(uv).level(lod) in three r185 keep the texture rebinding in OceanMaterial.setCascades working. Cite file:line. Say plainly if a claim in the spec is wrong."
```

- [ ] **Step 2: Record the review verbatim**

Write Codex's output into `docs/superpowers/plans/2026-08-05-waterline-codex-review.md` under a heading giving the date and the command used.

- [ ] **Step 3: Triage each finding**

For each point Codex raises, record one of three verdicts in the same file, with reasoning:
- **Correct — fixed**, with the commit that fixes it.
- **Correct — accepted**, where it is a real limit being kept deliberately (say why).
- **Wrong**, with the evidence that it is wrong.

Do not implement a suggestion because it was suggested. Use `superpowers:receiving-code-review` here: verify each claim against the code before acting on it. Codex has not read the measurements and does not know which constants are load-bearing.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-08-05-waterline-codex-review.md
git commit -m "Have an outside reader try to break the band-limit argument"
```

---

## Done when

- `npm run typecheck` clean.
- `npx playwright test` green on both projects.
- The waterline capture shows curved crests and no pyramids, and `docs/superpowers/plans/2026-08-05-waterline-measurements.md` says so with figures.
- Near-field `detail` in `gallery-jitter` is above 0.4 without `DETAIL_FLOOR` having been touched.
- Every Codex finding has a recorded verdict.
