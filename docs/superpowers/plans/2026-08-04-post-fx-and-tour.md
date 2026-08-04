# Post FX and Cinematic Tour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lens flare, depth of field, bloom and colour grading to the post chain; re-author the cinematic tour so it visits night, weather and the surf; and regenerate every screenshot against the result.

**Architecture:** Four new TSL stages slot into the existing `RenderPipeline.outputNode` chain between `VolumetricFog` and `LensRain`, operating on linear HDR because `outputColorTransform` applies ACES afterward. The cinematic flight grows a `CinematicEnvironment` — periodic, closed-form functions of the same loop clock that already drives its pose — so determinism is preserved. The visual harness learns to capture in cinematic mode, which the new tour beats require.

**Tech Stack:** TypeScript strict, Three.js r185 WebGPU/TSL, Vite 6, Playwright.

Spec: `docs/superpowers/specs/2026-08-04-post-fx-and-tour-design.md`.

## Global Constraints

- **No allocation in frame paths.** `update()` and every per-frame setter uses hoisted scratch (`_keyDirection` etc. at the top of `main.ts`). Follow the existing pattern exactly.
- **Determinism is load-bearing.** Anything with a clock gets a `resetClock(time)` and is called from `resetDeterministic`. Anything the cinematic drives is a closed-form function of the loop clock — never an accumulator, never a filter against the previous frame.
- **No shader compiles during gameplay.** New node graphs are built once at startup inside `start()`, before `prewarm()`. Tier changes move uniforms only; they never rebuild a node graph.
- **The node graph is built once.** A preset change writes uniforms. It never re-`build()`s a pass.
- **WebGL2 policy:** a coherent simpler image beats a broken richer one. Each new stage gets its own explicit `backend === 'webgl'` gate in `applyQuality`, mirroring `refraction` (`src/main.ts:955`) and `lensRainQuality` (`:964`).
- **Every new node that owns a render target is disposed from `App.dispose()`.** `RenderPipeline.dispose()` does not traverse the node graph.
- **Commit after every task.** Commit messages follow the repo's voice: prose, lowercase-after-first-word subject, explaining *why*, no `feat:`/`fix:` prefixes.
- **Verify before claiming.** `npm run typecheck` must pass before any commit. Rendering claims need a rendered frame, not an argument.

---

### Task 1: The chain, and the colour grade in it

Rewires the post chain once, with `ColorGrade` as its first new occupant. Every later task slots into the shape this establishes.

**Files:**
- Create: `src/post/ColorGrade.ts`
- Modify: `src/presets/index.ts` (add `Preset.grade`, identity on all nine for now)
- Modify: `src/main.ts:400-456` (chain), `applyPreset` (push grade), `dispose`
- Test: `tests/ocean.spec.ts`

**Interfaces:**
- Produces: `class ColorGrade { build(sceneColor: unknown): unknown; setParams(p: Partial<ColorGradeParams>): void; dispose(): void }`
- Produces: `interface ColorGradeParams { slope: THREE.Color; offset: THREE.Color; power: THREE.Color; saturation: number }`
- Produces: `Preset.grade: ColorGradeParams`
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

In `tests/ocean.spec.ts`, alongside the existing preset tests:

```ts
test('the colour grade changes the frame and identity leaves it alone', async ({ page }) => {
  await bootOcean(page);
  await setState(page, { preset: 'skyPro', quality: 'high', cameraMode: 'orbit' });
  await page.evaluate(() => window.__ocean.setCamera(-42, 21, 63, 0, 3, 0));
  await page.evaluate(() => window.__ocean.resetDeterministic(12, 90));

  const identity = await page.evaluate(async () => {
    window.__ocean.setGrade({ slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1 });
    await window.__ocean.step(1 / 60, 2);
    const { data } = await window.__ocean.capturePixels();
    return Array.from(data.slice(0, 2048));
  });

  const graded = await page.evaluate(async () => {
    window.__ocean.setGrade({ slope: [1.2, 1, 0.8], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1 });
    await window.__ocean.step(1 / 60, 2);
    const { data } = await window.__ocean.capturePixels();
    return Array.from(data.slice(0, 2048));
  });

  // A warm slope must move the frame, and must move it warmer.
  expect(identity).not.toEqual(graded);
  const meanR = (a: number[]) => a.filter((_, i) => i % 4 === 0).reduce((s, v) => s + v, 0);
  const meanB = (a: number[]) => a.filter((_, i) => i % 4 === 2).reduce((s, v) => s + v, 0);
  expect(meanR(graded) / meanB(graded)).toBeGreaterThan(meanR(identity) / meanB(identity));
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx playwright test --project=chromium-webgpu -g "colour grade"
```

Expected: FAIL — `window.__ocean.setGrade is not a function`.

- [ ] **Step 3: Write `src/post/ColorGrade.ts`**

ASC CDL plus saturation, applied in linear before ACES. Follow the file shape of `src/post/LensRain.ts`: a params interface, a `DEFAULT_*` const, uniforms as private readonly fields, a `build()` that returns a node, and setters that write uniforms.

```ts
import * as THREE from 'three/webgpu';
import { Fn, vec3, vec4, uniform, dot, mix, max, pow } from 'three/tsl';

export interface ColorGradeParams {
  slope: THREE.Color;
  offset: THREE.Color;
  power: THREE.Color;
  saturation: number;
}

export const IDENTITY_GRADE: ColorGradeParams = {
  slope: new THREE.Color(1, 1, 1),
  offset: new THREE.Color(0, 0, 0),
  power: new THREE.Color(1, 1, 1),
  saturation: 1,
};

/** Rec.709 luma, which is what the renderer's primaries actually are. */
const LUMA = /*@__PURE__*/ vec3(0.2126, 0.7152, 0.0722);

export class ColorGrade {
  private readonly uSlope = uniform(new THREE.Color(1, 1, 1));
  private readonly uOffset = uniform(new THREE.Color(0, 0, 0));
  private readonly uPower = uniform(new THREE.Color(1, 1, 1));
  private readonly uSaturation = uniform(1);

  build(sceneColor: unknown): unknown {
    const src: any = sceneColor;
    if (src === null || src === undefined) {
      throw new Error('ColorGrade.build: sceneColor is required.');
    }
    return Fn(() => {
      const c = vec4(src).toVar('gradeSrc');
      // ASC CDL. `max(0)` before `pow` because a negative base with a
      // fractional exponent is a NaN, and the fog and the flare can both push a
      // channel very slightly negative in linear space.
      const cdl = pow(max(c.rgb.mul(this.uSlope).add(this.uOffset), vec3(0)), this.uPower)
        .toVar('gradeCdl');
      const luma = dot(cdl, LUMA).toVar('gradeLuma');
      return vec4(mix(vec3(luma), cdl, this.uSaturation), c.a);
    })();
  }

  setParams(params: Partial<ColorGradeParams>): void {
    if (params.slope) this.uSlope.value.copy(params.slope);
    if (params.offset) this.uOffset.value.copy(params.offset);
    if (params.power) this.uPower.value.copy(params.power);
    if (params.saturation !== undefined) this.uSaturation.value = params.saturation;
  }

  /** Owns no render targets; present so the chain's teardown is uniform. */
  dispose(): void {}
}
```

- [ ] **Step 4: Add `Preset.grade`, identity everywhere**

In `src/presets/index.ts`, add to the `Preset` interface:

```ts
  /**
   * Global colour grade, applied in linear before ACES. See `src/post/ColorGrade.ts`.
   * Identity here means "this preset is already the colour it wants to be".
   */
  grade: ColorGradeParams;
```

Give all nine presets `grade: { ...IDENTITY_GRADE }` for now. Task 5 replaces them with tuned values; keeping them identity here means Task 1's only visible change is the plumbing, which is what makes its test meaningful.

- [ ] **Step 5: Rewire the chain in `main.ts`**

Add the field, build it after `this.lensRain`, and extend the `outputNode` assignment. The `rtt` around `graded` already exists; the grade goes *inside* it so the lens rain still refracts the finished image:

```ts
    this.colorGrade = new ColorGrade();

    // Grade before the lens, after everything that makes light.
    //
    // Inside the `rtt`, so LensRain still refracts the finished image exactly as
    // its own comment requires. In linear, before ACES — `outputColorTransform`
    // applies the tone curve after `outputNode`, so this shapes what ACES then
    // compresses rather than fighting the compression afterwards.
    this.post.outputNode = this.lensRain.build(
      rtt(this.colorGrade.build(graded) as THREE.Node),
    ) as THREE.Node;
```

In `applyPreset`, push the grade with the rest of the preset's look, next to `this.renderer.toneMappingExposure = preset.toneMappingExposure;`:

```ts
    // With the exposure, not instead of it: exposure sets where the scene sits
    // on the tone curve, the grade sets what colour it is when it gets there.
    this.colorGrade.setParams(preset.grade);
```

In `dispose`, add `this.colorGrade.dispose();` alongside the other passes.

- [ ] **Step 6: Add the `setGrade` test hook**

In `exposeTestHooks`, next to `setRainOverride`:

```ts
        /** Test-only grade override, so a test can prove the pass is wired. */
        setGrade: (g: {
          slope: [number, number, number];
          offset: [number, number, number];
          power: [number, number, number];
          saturation: number;
        }) =>
          this.colorGrade.setParams({
            slope: new THREE.Color(...g.slope),
            offset: new THREE.Color(...g.offset),
            power: new THREE.Color(...g.power),
            saturation: g.saturation,
          }),
```

Declare it on `OceanHooks` in `tests/lib/capture.ts`.

- [ ] **Step 7: Run the test and the typechecker**

```bash
npm run typecheck
npx playwright test --project=chromium-webgpu -g "colour grade"
```

Expected: both PASS.

- [ ] **Step 8: Commit**

```bash
git add src/post/ColorGrade.ts src/presets/index.ts src/main.ts tests/
git commit -m "Put a grade in the chain, and nothing in it yet"
```

---

### Task 2: Bloom

**Files:**
- Create: `src/post/Bloom.ts`
- Modify: `src/core/QualityManager.ts` (`bloom` field, five tiers), `src/main.ts`
- Test: `tests/ocean.spec.ts`

**Interfaces:**
- Produces: `class SceneBloom { build(sceneColor: unknown): unknown; setEnabled(on: boolean): void; setParams(p: { strength?: number; radius?: number; threshold?: number }): void; dispose(): void }`
- Produces: `QualitySettings.bloom: 0 | 1`
- Consumes: the chain shape from Task 1.

- [ ] **Step 1: Write the failing test**

```ts
test('bloom lifts the sun glitter and Low does not pay for it', async ({ page }) => {
  await bootOcean(page);
  await setState(page, { preset: 'sunset', quality: 'high', cameraMode: 'orbit' });
  await page.evaluate(() => window.__ocean.setCamera(58, 7, 9, 0, 4, 0));
  await page.evaluate(() => window.__ocean.resetDeterministic(31.25, 90));

  const meanOf = async () =>
    page.evaluate(async () => {
      await window.__ocean.step(1 / 60, 2);
      const { data } = await window.__ocean.capturePixels();
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
      return sum / (data.length / 4);
    });

  const on = await meanOf();
  await page.evaluate(() => window.__ocean.setBloomEnabled(false));
  const off = await meanOf();

  // Bloom is additive and cannot darken a frame.
  expect(on).toBeGreaterThan(off);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx playwright test --project=chromium-webgpu -g "bloom lifts"
```

Expected: FAIL — `setBloomEnabled is not a function`.

- [ ] **Step 3: Write `src/post/Bloom.ts`**

A thin wrapper. Its job is the tier plumbing and to record why this one stage is bought rather than built.

```ts
import * as THREE from 'three/webgpu';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { uniform } from 'three/tsl';

/**
 * Bought, not built — the only stage in `src/post/` that is.
 *
 * `BloomNode` is a five-level mip pyramid with separable Gaussians and a
 * smooth luminance high-pass, and it resizes itself from the drawing buffer on
 * every render. Reimplementing that would take several hundred lines to arrive
 * at the same image. The other three stages are hand-written because each needs
 * something the stock node cannot express — a thin-lens CoC, a sun anchor, a
 * per-preset CDL. This one needs nothing the stock node does not already do.
 *
 * The threshold is near 1.0 and that is meaningful rather than arbitrary: the
 * post chain runs in linear HDR, because `RenderPipeline.outputColorTransform`
 * applies ACES *after* `outputNode`. So this selects light that genuinely
 * exceeded the sensor, not light that merely looks bright once tone mapped.
 */
export class SceneBloom {
  private readonly uStrength = uniform(0.08);
  private node: any = null;
  private enabled = true;

  /** Returns `sceneColor + bloom(sceneColor)`. */
  build(sceneColor: unknown): unknown {
    const src: any = sceneColor;
    if (src === null || src === undefined) throw new Error('SceneBloom.build: sceneColor is required.');
    // Strength is a uniform so the tier and the enable can move it without
    // rebuilding the graph; radius and threshold are construction-time because
    // nothing needs to move them at runtime.
    this.node = bloom(src, this.uStrength, 0.55, 0.9);
    return src.add(this.node);
  }

  /**
   * `0` strength rather than removing the node.
   *
   * The pyramid still runs, which is the honest cost of a graph that is built
   * once — but the frame is unchanged, and a tier change cannot recompile a
   * shader. See the note on `applyQuality`.
   */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.uStrength.value = on ? this.strength : 0;
  }

  private strength = 0.08;

  setParams(params: { strength?: number }): void {
    if (params.strength !== undefined) {
      this.strength = params.strength;
      if (this.enabled) this.uStrength.value = params.strength;
    }
  }

  dispose(): void {
    this.node?.dispose?.();
    this.node = null;
  }
}
```

- [ ] **Step 4: Add the tier field**

In `src/core/QualityManager.ts`, add to `QualitySettings`:

```ts
  /**
   * Whether the bloom pyramid contributes, 0 or 1.
   *
   * Not a strength: how strong bloom is belongs to the look, not to the tier,
   * for the same reason `toneMappingExposure` is a preset field. What the tier
   * decides is whether a scene can afford five downsample-and-blur passes.
   */
  bloom: 0 | 1;
```

Values: `low: 0`, `medium: 1`, `high: 1`, `ultra: 1`, `max: 1`.

- [ ] **Step 5: Wire it into `main.ts`**

Build it before the grade, so bloom lands before grading:

```ts
    this.bloom = new SceneBloom();
    ...
    const bloomed = this.bloom.build(rtt(graded as THREE.Node));
    this.post.outputNode = this.lensRain.build(
      rtt(this.colorGrade.build(bloomed) as THREE.Node),
    ) as THREE.Node;
```

In `applyQuality`, with the explicit backend gate the WebGL2 policy requires:

```ts
    // WebGL2 keeps the pyramid — it is ordinary texture sampling and nothing in
    // it is backend-specific. Stated rather than assumed: verified with
    // `?webgl=1` in `tests/isolation.spec.ts`.
    this.bloom.setEnabled(quality.bloom === 1);
```

Add `this.bloom.dispose();` to `dispose()`, and a `setBloomEnabled` test hook.

- [ ] **Step 6: Run the test**

```bash
npm run typecheck && npx playwright test --project=chromium-webgpu -g "bloom lifts"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A src tests
git commit -m "Let the sun exceed the sensor"
```

---

### Task 3: Depth of field

**Files:**
- Create: `src/post/DepthOfField.ts`
- Modify: `src/cameras/CameraDirector.ts` (`focusDistance()`), `src/core/QualityManager.ts` (`dofSamples`), `src/main.ts`
- Test: `tests/ocean.spec.ts`

**Interfaces:**
- Produces: `class DepthOfField { build(sceneColor: unknown, sceneDepth: unknown): unknown; setCamera(c: THREE.PerspectiveCamera): void; setFocusDistance(m: number): void; setAperture(fNumber: number): void; setSamples(n: number): void; dispose(): void }`
- Produces: `CameraDirector.focusDistance(): number`
- Produces: `QualitySettings.dofSamples: number`
- Consumes: the chain shape from Tasks 1–2.

- [ ] **Step 1: Write the failing test**

Two assertions: zero taps is bit-exact, and a real aperture blurs the far field while the focal plane stays sharp.

```ts
test('depth of field is a pass-through at zero taps and blurs off the focal plane', async ({ page }) => {
  await bootOcean(page);
  await setState(page, { preset: 'skyPro', quality: 'high', cameraMode: 'orbit' });
  await page.evaluate(() => window.__ocean.setCamera(-42, 21, 63, 0, 3, 0));
  await page.evaluate(() => window.__ocean.resetDeterministic(12, 90));

  const grab = async () =>
    page.evaluate(async () => {
      await window.__ocean.step(1 / 60, 2);
      const { data } = await window.__ocean.capturePixels();
      return Array.from(data.slice(0, 65536));
    });

  await page.evaluate(() => window.__ocean.setDof(0, 8));
  const noTaps = await grab();
  await page.evaluate(() => window.__ocean.setDof(0, 8));
  const noTapsAgain = await grab();
  expect(noTaps).toEqual(noTapsAgain);

  // A wide aperture must change the frame.
  await page.evaluate(() => window.__ocean.setDof(24, 1.4));
  const wide = await grab();
  expect(wide).not.toEqual(noTaps);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx playwright test --project=chromium-webgpu -g "depth of field is a pass-through"
```

Expected: FAIL — `setDof is not a function`.

- [ ] **Step 3: Add `CameraDirector.focusDistance()`**

```ts
  /**
   * Distance from the eye to whatever this mode is looking at, metres.
   *
   * Per mode, because "what the shot is about" is a different question in each
   * one — and the answer has to be closed-form in Cinematic, where a capture
   * must reproduce exactly. Orbit and Cinematic both have an explicit look
   * point; the chase rig has the hull; Fly has neither, so it takes the view
   * ray's meeting with the sea, which is what a viewer flying over water is
   * almost always looking at.
   */
  focusDistance(): number {
    switch (this.mode) {
      case 'orbit':
        return Math.max(1, this.camera.position.distanceTo(this.orbit.target));
      case 'cinematic':
        return Math.max(1, this.camera.position.distanceTo(this.cinematicPose.target));
      case 'boat':
        return this.target
          ? Math.max(1, this.camera.position.distanceTo(this.target.position))
          : DEFAULT_FOCUS_DISTANCE;
      case 'fly': {
        // Where the view ray meets the sea. Falls back to a default looking up
        // or along the horizon, where there is nothing to focus on.
        this.camera.getWorldDirection(this.tmpVec);
        if (this.tmpVec.y > -0.02) return DEFAULT_FOCUS_DISTANCE;
        const surface = this.surfaceHeight(this.camera.position.x, this.camera.position.z);
        const drop = this.camera.position.y - surface;
        if (drop <= 0) return DEFAULT_FOCUS_DISTANCE;
        return THREE.MathUtils.clamp(drop / -this.tmpVec.y, 1, 4000);
      }
    }
  }
```

With `const DEFAULT_FOCUS_DISTANCE = 120;` beside the other module constants, commented as "far enough that a wide lens is effectively focused at infinity, which is the right default when nothing says otherwise."

- [ ] **Step 4: Write `src/post/DepthOfField.ts`**

The load-bearing parts, in order.

**CoC, from the thin-lens equation.** Computed on the CPU into uniforms wherever it does not depend on the pixel, so the shader does the least work possible:

```ts
  /** Full-frame sensor height, metres. Sets the scale CoC is measured in. */
  private static readonly SENSOR_HEIGHT = 0.024;

  setCamera(camera: THREE.PerspectiveCamera): void { this.camera = camera; }

  /** Called every frame from `main.update`. Writes uniforms; allocates nothing. */
  update(): void {
    const fovY = THREE.MathUtils.degToRad(this.camera.fov);
    // Focal length that produces this field of view on a full-frame sensor.
    // Derived rather than authored so the CoC stays correct if the FOV moves.
    const f = (DepthOfField.SENSOR_HEIGHT / 2) / Math.tan(fovY / 2);
    this.uFocal.value = f;
    this.uAperture.value = f / this.fNumber;
    // Guarded above `f`: a lens cannot focus closer than its own focal length,
    // and `focus - f` is the denominator.
    this.uFocus.value = Math.max(f * 1.001, this.focusDistance);
    this.uPixelsPerMetre.value = this.frameHeightPx / DepthOfField.SENSOR_HEIGHT;
  }
```

In the shader, per pixel:

```
d      = linearised view distance at this pixel        (from sceneDepth)
coc    = A * f * |d - focus| / (d * (focus - f))       metres on the sensor
r_px   = clamp(coc * pixelsPerMetre * 0.5, 0, maxRadius)
```

Use `perspectiveDepthToViewZ(depthNode.sample(uv).r, uNear, uFar).negate()` for `d`, exactly as `UnderwaterPass` does (`src/underwater/UnderwaterPass.ts:317`).

**The gather.** A golden-angle spiral, `uSamples` taps, radius `r_px` converted to uv by the frame size. Each tap is rejected unless its *own* CoC reaches the centre pixel:

```
for i in 0..samples:
    theta = i * 2.39996323          // golden angle
    rho   = sqrt((i + 0.5) / samples) * r_px
    tapUv = uv + vec2(cos(theta), sin(theta)) * rho * texel
    tapD  = viewDistance(tapUv)
    tapR  = cocRadius(tapD)
    # A sharp background tap must not be smeared over by a blurred foreground,
    # and a blurred foreground tap must reach here to contribute. This one
    # comparison is the whole difference between a DOF that looks like a lens
    # and one that looks like a blur filter at every silhouette.
    w     = step(rho, max(tapR, 1.0))
    accum += sampleColor(tapUv) * w; weight += w
return accum / max(weight, 1e-4)
```

**The zero-tap branch.** `If(this.uSamples.greaterThan(0.5), ...)` around the whole gather, returning `src` untouched otherwise — a uniform-coherent branch, the same construction `UnderwaterPass.build` uses for `uSubmersion` (`src/underwater/UnderwaterPass.ts:325`). That is what makes `dofSamples: 0` bit-exact rather than merely cheap.

- [ ] **Step 5: Add the tier field**

```ts
  /**
   * Taps in the depth-of-field gather. 0 is a bit-exact pass-through, guarded
   * by a uniform-coherent branch rather than by a zero radius.
   */
  dofSamples: number;
```

Values: `low: 0`, `medium: 8`, `high: 16`, `ultra: 24`, `max: 32`.

- [ ] **Step 6: Wire into `main.ts`**

The DOF goes between the fog and the bloom, and needs the `rtt` that already exists:

```ts
    const focused = this.dof.build(rtt(graded as THREE.Node), sceneDepth);
    const bloomed = this.bloom.build(rtt(focused as THREE.Node));
```

`this.dof.setCamera(this.camera)` at construction, for the reason `UnderwaterPass` and `VolumetricFog` both document: a post pass draws with the post-processor's own orthographic quad camera, so the scene camera must be handed over explicitly.

Per frame in `update`, after `this.director.update(dt)`:

```ts
    // The shot's subject, whatever mode is choosing it. See `focusDistance`.
    this.dof.setFocusDistance(this.director.focusDistance());
    this.dof.update();
```

In `applyQuality`, with the backend gate:

```ts
    this.dof.setSamples(this.backend === 'webgl' ? 0 : quality.dofSamples);
```

WebGL2 gets no DOF: the gather's per-tap depth reads are the least portable part of it, and the fallback policy prefers a coherent simpler image.

Add `this.dof.dispose()` and a `setDof(samples, fNumber)` test hook.

- [ ] **Step 7: Run the test**

```bash
npm run typecheck && npx playwright test --project=chromium-webgpu -g "depth of field"
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A src tests
git commit -m "Give the camera a lens instead of a pinhole"
```

---

### Task 4: Lens flare

**Files:**
- Create: `src/post/LensFlare.ts`
- Modify: `src/core/QualityManager.ts` (`lensFlare`), `src/main.ts`
- Test: `tests/ocean.spec.ts`

**Interfaces:**
- Produces: `class LensFlare { build(sceneColor: unknown, sceneDepth: unknown): unknown; setCamera(c: THREE.PerspectiveCamera): void; setSource(direction: THREE.Vector3, color: THREE.Color, intensity: number): void; setSubmersion(v: number): void; setEnabled(on: boolean): void; dispose(): void }`
- Produces: `QualitySettings.lensFlare: 0 | 1`
- Consumes: the chain from Tasks 1–3.

- [ ] **Step 1: Write the failing test**

The three properties that make it a *lens flare* rather than a sprite: it dies under water, it dies when the sun is occluded, and it follows the moon at night.

```ts
test('the flare is above water, occluded by land, and follows the moon at night', async ({ page }) => {
  await bootOcean(page);
  await setState(page, { preset: 'skyPro', quality: 'high', cameraMode: 'orbit' });

  const meanOf = async () =>
    page.evaluate(async () => {
      await window.__ocean.step(1 / 60, 2);
      const { data } = await window.__ocean.capturePixels();
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
      return sum / (data.length / 4);
    });

  // Looking up-sun above water, flare on then off.
  await page.evaluate(() => window.__ocean.setCamera(58, 7, 9, 0, 4, 0));
  await page.evaluate(() => window.__ocean.resetDeterministic(31.25, 90));
  await setState(page, { preset: 'sunset' });
  await page.evaluate(() => window.__ocean.resetDeterministic(31.25, 90));
  const flareOn = await meanOf();
  await page.evaluate(() => window.__ocean.setFlareEnabled(false));
  const flareOff = await meanOf();
  expect(flareOn).toBeGreaterThan(flareOff);

  // Submerged: the same camera under water must not differ with the flare on.
  await page.evaluate(() => window.__ocean.setFlareEnabled(true));
  await page.evaluate(() => window.__ocean.setCamera(-16, -7, 16, -6, 2, 2));
  await page.evaluate(() => window.__ocean.resetDeterministic(72.5, 90));
  const underOn = await meanOf();
  await page.evaluate(() => window.__ocean.setFlareEnabled(false));
  const underOff = await meanOf();
  expect(Math.abs(underOn - underOff)).toBeLessThan(0.01);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx playwright test --project=chromium-webgpu -g "the flare is above water"
```

Expected: FAIL — `setFlareEnabled is not a function`.

- [ ] **Step 3: Write `src/post/LensFlare.ts`**

**Anchor, on the CPU.** Project the source direction to screen uv once per frame into a uniform. No readback, no per-pixel projection:

```ts
  /** Scratch — this runs every frame and must not allocate. */
  private readonly _world = new THREE.Vector3();

  setSource(direction: THREE.Vector3, color: THREE.Color, intensity: number): void {
    // A direction, not a position: the source is at infinity. Projected from a
    // point one unit along it, offset by the camera, which is the same thing
    // for a perspective projection and avoids a division by a huge w.
    this._world.copy(direction).multiplyScalar(1e4).add(this.camera.position);
    this._world.project(this.camera);
    // `project` returns NDC, which runs bottom-up; screen uv here runs top-down,
    // the same way it does everywhere else in this project. This is the same
    // asymmetry `ScreenSpaceReflection.clipToScreenUV` documents and that
    // `LensRain.setGravity` was once wrong about.
    this.uSourceUv.value.set(this._world.x * 0.5 + 0.5, 1 - (this._world.y * 0.5 + 0.5));
    // Behind the camera projects to a valid-looking uv with z > 1. Without this
    // the sun throws a flare from directly behind the viewer.
    this.uSourceFront.value = this._world.z < 1 ? 1 : 0;
    this.uSourceColor.value.copy(color);
    this.uSourceIntensity.value = intensity;
  }
```

**Occlusion, from the depth buffer.** Eight taps on a small disc around `uSourceUv`; a tap is clear when its depth reads at or beyond the far plane:

```
clear = 0
for i in 0..8:
    p = sourceUv + discOffset(i) * occlusionRadius
    clear += step(farPlane * 0.98, viewDistance(p))
visibility = clear / 8
```

Smoothed with `smoothstep` so a mast crossing the sun ramps rather than flickers.

**Gates**, multiplied together:

```
gate = (1 - submersion)                         // above water only, as asked
     * smoothstep(-0.02, 0.06, direction.y)     // dies at the horizon
     * sourceFront                              // not behind the camera
     * visibility                               // occluded by geometry
     * enabled
```

**Elements**, all additive, all in linear:
- Halo: `pow(1 - saturate(dist / haloRadius), 4)` at the source.
- Three ghosts at fractional offsets along `(centre - sourceUv)`, each with its own tint and radius.
- One anamorphic streak: a horizontally-stretched Gaussian through the source.
- A very slight full-frame veil scaled by `visibility`.

All distances computed in **aspect-corrected** uv (`vec2((u - s.x) * aspect, v - s.y)`) so ghosts stay round rather than becoming ellipses on a 16:9 frame.

**Colour.** `uSourceColor * uSourceIntensity`, supplied by the caller — see the next step for why the caller and not this class decides which body it is.

- [ ] **Step 4: Feed it the *live key light*, not `sunColor`**

This is the trap the spec calls out. In `main.update`, beside the existing `_keyDirection` computation:

```ts
    // The key light, whichever body currently is it.
    //
    // `Atmosphere` owns one directional light and retargets it to the moon once
    // the sun is down, overwriting its colour with `MOON_LIGHT_COLOR`
    // (`src/sky/Atmosphere.ts:731`). Meanwhile `atmosphere.sunColor` goes on
    // reporting the *solar* extinction colour whatever the hour. So reading the
    // pair (`sunDirection`, `sunColor`) at night would anchor the flare where
    // the sun is not and paint it warm on a blue moon. `_keyDirection` is
    // already derived from `sunLight.position` a few lines above, which follows
    // the retarget; the colour has to come from the same object.
    this.lensFlare.setSource(_keyDirection, key.color, key.intensity / 3.4);
    this.lensFlare.setSubmersion(submersion);
```

Note `submersion` is resolved further down in `update`, so this call goes *after* it, next to `this.lensRain.setSubmersion(submersion)`.

- [ ] **Step 5: Tier field and wiring**

`lensFlare: 0 | 1`, values `low: 0`, rest `1`. In `applyQuality`:

```ts
    // Kept on WebGL2: the occlusion disc is eight depth taps, which is the same
    // read the fog already does there.
    this.lensFlare.setEnabled(quality.lensFlare === 1);
```

Chain: the flare is additive and does not sample the image, so it slots between bloom and grade:

```ts
    const flared = this.lensFlare.build(bloomed, sceneDepth);
    this.post.outputNode = this.lensRain.build(
      rtt(this.colorGrade.build(flared) as THREE.Node),
    ) as THREE.Node;
```

Add `setCamera`, `dispose`, and a `setFlareEnabled` hook.

- [ ] **Step 6: Run the test**

```bash
npm run typecheck && npx playwright test --project=chromium-webgpu -g "the flare is above water"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A src tests
git commit -m "Put glass in front of the sensor"
```

---

### Task 5: Nine grades

Replaces the identity placeholders from Task 1 with tuned per-preset values, judged against rendered frames.

**Files:**
- Modify: `src/presets/index.ts`

- [ ] **Step 1: Capture a before-frame for each preset**

```bash
CAPTURE_GALLERY=1 npx playwright test --project=visual gallery
```

Look at `docs/images/` and note, per preset, what the grade should reinforce.

- [ ] **Step 2: Author the nine grades**

Each one reinforces what the preset already is; none of them invents a look the preset does not have. Direction per preset — exact numbers are set by looking at the frames, not asserted here:

- `skyPro` — near identity, a whisker of saturation. It is the reference image.
- `sunset` — warm slope, slight power lift in the blues to keep the sky from going muddy.
- `dusk` — cool offset in the shadows, mild desaturation.
- `moonlit` — cool slope, saturation below 1; night is not colourful.
- `storm` — desaturated, lifted blacks (positive offset), reduced slope. Weather is low contrast.
- `foggy` — flattened: slope below 1, offset above 0, saturation well below 1.
- `arctic` — cool, high saturation on the blues only.
- `blackFlag` — warm mid, deeper blacks.
- `seaOfThieves` — the most saturated of the nine; it is the stylised one.

- [ ] **Step 3: Verify the presets stay distinct**

```bash
npx playwright test --project=chromium-webgpu -g "preset"
```

The existing preset-distinctness test must still pass — a grade that collapsed two presets toward each other would be a regression, not a look.

- [ ] **Step 4: Commit**

```bash
git add src/presets/index.ts
git commit -m "Grade each preset toward what it already was"
```

---

### Task 6: The tour's environment

Curves and plumbing only. No new beats yet — this task must leave the existing six-beat flight looking exactly as authored, with the machinery in place under it.

**Files:**
- Modify: `src/cameras/Cinematic.ts`, `src/cameras/CameraDirector.ts`, `src/main.ts`
- Test: `tests/ocean.spec.ts`

**Interfaces:**
- Produces: `interface CinematicEnvironment { hours: number; rain: number; cloudCoverage: number; fogDensity: number; weatherKind: 'clear' | 'rain' }`
- Produces: `CinematicDirector.environment(time?: number): Readonly<CinematicEnvironment>`
- Produces: `CameraDirector.cinematicEnvironment(time?: number): Readonly<CinematicEnvironment>`
- Replaces: `CinematicDirector.timeOfDayHours` and `CameraDirector.cinematicTimeOfDay` — folded into `environment().hours`. Update `main.ts:1311`.

- [ ] **Step 1: Write the failing tests**

```ts
test('the tour reaches night and rains, and its environment closes on the loop', async ({ page }) => {
  await bootOcean(page);
  const samples = await page.evaluate((loop) => {
    const out: Array<{ t: number; hours: number; rain: number; kind: string }> = [];
    for (let t = 0; t < loop; t += 0.25) {
      const e = window.__ocean.director.cinematicEnvironment(t);
      out.push({ t, hours: e.hours, rain: e.rain, kind: e.weatherKind });
    }
    return out;
  }, CINEMATIC_LOOP_SECONDS);

  // It actually goes to night: an hour outside civil daylight somewhere.
  expect(samples.some((s) => s.hours < 5 || s.hours > 20)).toBe(true);
  // It actually rains, and declares the kind that makes rain visible at all.
  expect(samples.some((s) => s.rain > 0.3 && s.kind === 'rain')).toBe(true);
  // And it is dry somewhere, or it is not a *change*.
  expect(samples.some((s) => s.rain < 0.01)).toBe(true);

  // Continuous at the wrap, to the same standard the pose is held to.
  const step = (a: number, b: number) => Math.abs(a - b);
  const first = samples[0];
  const last = samples[samples.length - 1];
  expect(step(first.hours, last.hours)).toBeLessThan(0.5);
  expect(step(first.rain, last.rain)).toBeLessThan(0.05);
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx playwright test --project=chromium-webgpu -g "the tour reaches night"
```

Expected: FAIL — `cinematicEnvironment is not a function`.

- [ ] **Step 3: Write the curves in `Cinematic.ts`**

Replace `timeOfDayHours` with `environment(time)`. Every field is periodic in the loop clock, closed-form, and C¹ at the wrap. `hours` stops being a single sine — a sine has to choose between reaching night and dwelling in day, and it puts its extreme wherever the phase lands:

```ts
/**
 * The tour's hour of the day.
 *
 * Two harmonics rather than one, and that is the whole point. A single sine
 * that reaches night spends almost no time there and almost no time at noon
 * either — it sweeps through both. Adding a second harmonic flattens the curve
 * near its extremes and steepens it in between, so the tour *dwells* in
 * daylight through the island beats, sweeps through sunset in one beat, dwells
 * at night for the beat authored for it, and comes back at dawn. Still
 * periodic, still C¹ at the wrap, still a pure function of the clock — which is
 * what keeps every cinematic capture reproducible.
 *
 * The phase offset is chosen so the night trough lands on `night-watch` and not,
 * as a naive sine would put it, in the middle of the underwater run — where
 * night means a black frame.
 */
function tourHours(phase: number): number {
  const a = Math.sin(phase - NIGHT_PHASE);
  const b = Math.sin(2 * (phase - NIGHT_PHASE));
  return TOUR_NOON_HOURS + (a * 0.86 + b * 0.14) * TOUR_HOUR_SWING;
}
```

`TOUR_HOUR_SWING` rises from 4.2 to a value that carries the trough below dawn — verify with the test in Step 1 rather than by arithmetic here.

`rain` is a raised-cosine bump centred on the squall beat's midpoint, zero-valued and zero-derivative outside it, so it is C¹ without a clamp. `weatherKind` is `'rain'` wherever `rain > 0` — and this is not cosmetic:

```ts
  /**
   * `Weather` refuses to draw anything while its kind is 'clear', whatever the
   * intensity (`Weather.applyVisibility`), and `main.update` computes the
   * `raining` scalar that drives the lens beads, the surface ring stipple, the
   * foam agitation and the hull wetting as
   * `kind === 'rain' ? intensity : 0` (`src/main.ts:1407`). Every clear preset
   * declares 'clear'. So a squall that set only the intensity would produce no
   * weather at all, anywhere, and would look exactly like a bug in the curves.
   */
```

- [ ] **Step 4: Apply it in `main.update`**

Replace the existing `cinematicTimeOfDay` block (`src/main.ts:1310-1312`):

```ts
    if (this.state.cameraMode === 'cinematic') {
      const env = this.director.cinematicEnvironment();
      this.atmosphere.setParams(this.sunFromClock(env.hours));
      this.clouds.setParams({ coverage: env.cloudCoverage });
      this.weather.setKind(env.weatherKind);
      this.weather.setIntensity(env.rain);
      this.cinematicFog = env.fogDensity;
      this.refreshTourEnvironment();
    }
```

`refreshTourEnvironment` is the throttled cube re-capture:

```ts
  /**
   * Re-captures the environment cube while the tour moves the sun.
   *
   * The tour drives `Atmosphere.setParams` straight, sixty times a second, and
   * never touched the cube — which was invisible while the flight only swept
   * 08:18 to 16:42, and is badly wrong the moment it reaches night: every PBR
   * surface in the scene would still be lit by the last captured daylight sky
   * while the visible sky is black.
   *
   * Not every frame. `updateEnvironment` renders six cube faces and then rebuilds
   * the PMREM chain, which is milliseconds. Gated on the sun having actually
   * moved, so the cost is paid a handful of times per lap instead of 60 times a
   * second — and the threshold is on elevation rather than on a timer so a fast
   * sweep through sunset gets more updates than a slow dwell at noon.
   */
  private refreshTourEnvironment(force = false): void {
    const elevation = this.atmosphere.sunDirection.y;
    if (!force && Math.abs(elevation - this.lastEnvElevation) < TOUR_ENV_ELEVATION_STEP) return;
    this.lastEnvElevation = elevation;
    this.atmosphere.updateEnvironment(this.renderer, this.scene);
  }
```

The fog density needs a per-frame term. `this.fog.setParams({ density: ... })` already multiplies `preset.fog.volumetric` by the slider ratio; add the tour's own multiplier to that expression rather than a second call.

- [ ] **Step 5: Put the environment back on the way out**

`onStateChange`'s `cameraMode` case currently calls `applyPreset(false)` when leaving cinematic (`src/main.ts:835`). The `false` suppresses the cube capture — correct while the tour never changed it, wrong now:

```ts
        // `true`, not `false`, and only on the way out of the tour.
        //
        // The flight now moves the environment cube as well as the sun (see
        // `refreshTourEnvironment`). Leaving it at night with `false` would
        // restore the preset's daylight sky to the *dome* and leave the night
        // IBL bound to every PBR surface, with nothing that would ever clear it.
        if (this.state.cameraMode !== 'cinematic') this.applyPreset(wasCinematic);
```

- [ ] **Step 6: Fix the reset ordering**

`resetDeterministic` seeds rain, lens coverage, foam agitation and wetness from `rainOverride ?? preset.weather.intensity` *before* rewinding, then resets the cinematic clock afterwards (`src/main.ts:1807`, `:1831`). With a tour that owns the weather, that seeds a night or squall capture from the preset. Move `this.director.resetCinematic(start)` above the seed, and take the seed from the tour when the tour is driving:

```ts
          // The cinematic clock first, because what the world should look like
          // at `start` is now a question only the flight can answer. Seeding
          // from the preset while the tour owns the weather would settle a
          // squall capture bone dry — and wetness has a 26 s time constant, so
          // no number of settle steps recovers it.
          this.director.resetCinematic(start);
          const tour =
            this.state.cameraMode === 'cinematic'
              ? this.director.cinematicEnvironment(start)
              : null;
          const resetRain =
            this.rainOverride ?? tour?.rain ?? getPreset(this.state.preset).weather.intensity;
          if (tour) this.weather.setKind(tour.weatherKind);
```

Also force the environment capture on reset — `this.refreshTourEnvironment(true)` — so the IBL is right on the first settled frame rather than at some later threshold crossing, and reset the flare's smoothed visibility to its instantaneous value.

- [ ] **Step 7: Run the tests**

```bash
npm run typecheck
npx playwright test --project=chromium-webgpu -g "the tour reaches night"
npx playwright test --project=chromium-webgpu -g "cinematic"
```

Expected: all PASS, including the existing seam test.

- [ ] **Step 8: Commit**

```bash
git add -A src tests
git commit -m "Let the tour own the weather and the hour, not just the hour"
```

---

### Task 7: Nine beats

**Files:**
- Modify: `src/cameras/Cinematic.ts` (the `BEATS` array and its commentary)
- Test: `tests/ocean.spec.ts`

- [ ] **Step 1: Write the failing test — the hull must stay somewhere worth looking at**

```ts
test('the tour keeps the hull over the plateau whenever it frames it', async ({ page }) => {
  await bootOcean(page);
  // Beats whose keys look at 'ship'. If a beat is renamed, this must be updated —
  // which is the point: a beat that frames the hull is making a promise.
  const SHIP_BEATS = ['open-water', 'outbound', 'night-watch', 'ascent'];
  const worst = await page.evaluate((names) => {
    let max = 0;
    for (const { name, start, duration } of window.__ocean.director.cinematicBeats) {
      if (!names.includes(name)) continue;
      for (let t = start; t < start + duration; t += 0.5) {
        const { x, z } = window.__ocean.director.nominalShipAt(t);
        max = Math.max(max, Math.hypot(x, z));
      }
    }
    return max;
  }, SHIP_BEATS);

  // The shallow plateau runs to 320 m. Past it the ship is over deep blue water
  // with no reef under it — the tour would still loop perfectly and would simply
  // have sailed somewhere boring, which is why this is asserted rather than
  // trusted to the radius constant.
  expect(worst).toBeLessThan(320);
});
```

Add `cinematicBeats` (name/start/duration) and `nominalShipAt(t)` to the director and the test hooks; `nominalShipXZ` already exists in `Cinematic.ts` and just needs exporting.

- [ ] **Step 2: Run and watch it fail**

```bash
npx playwright test --project=chromium-webgpu -g "keeps the hull over the plateau"
```

Expected: FAIL — `cinematicBeats is not a function`.

- [ ] **Step 3: Author the nine beats**

Keep the existing six, re-timed, and insert three. Geometry to author against, from the file's own header: the ship spawns at the origin heading +X; the shallow plateau runs to 320 m; reef patches sit at (−97, −102) and (33, 31); `ISLAND` is at (−1150, −780) with a 500 m mean shore radius and a 150 m summit; the cove is on bearing 0.7 rad and the fort on 1.35 rad at 0.66 of the radius.

| Beat | Duration | Throttle | Frames |
|---|---|---|---|
| `open-water` | 14 | 1.0 | ship at speed, wake |
| `outbound` | 20 | 1.0 | crane astern, run for the island |
| `landfall` | 26 | 0.85 | cove, jetty, pinnace, fort |
| `surf-line` | 12 | 0.4 | **new** — the shore break from inside the surf zone |
| `return` | 18 | 0.9 | back to the plateau, sun going down |
| `squall` | 20 | 0.5 | **new** — rain, dark cloud, wet lens |
| `night-watch` | 13 | 0.35 | **new** — moon glitter, stars, the ship |
| `reef-run` | 26 | 0.5 | reef, coral, fish, god rays |
| `ascent` | 16 | 0.85 | up through the surface, re-acquire the hull |

Two constraints on the numbers, both of which the tests check rather than the comments promise:

- **Arc, not duration, sets the radius.** `TOTAL_ARC = Σ 9.64·√throttle · duration` and `TRACK_RADIUS = TOTAL_ARC / 2π`. The three new beats carry low throttles for exactly this reason — they are generous in time and cheap in arc. The hull's far point is `2 × TRACK_RADIUS`, not `TRACK_RADIUS` (`nominalShipXZ` puts the circle *through* the origin, centred at `(0, −R)`), which the existing comment at `Cinematic.ts:361` gets wrong by 3 m.
- **`surf-line` must clear the seafloor.** Underwater and near-shore keys are authored with clearance rather than clamped against `seafloorHeight`, because a clamp is a non-smooth term and the one thing this curve must never develop is a corner. The surf beat flies the shore at 8–14 m, not at wading height.

Update the `NIGHT_PHASE` constant from Task 6 so the hour curve's trough lands on `night-watch`'s midpoint.

- [ ] **Step 4: Run the full cinematic suite**

```bash
npm run typecheck
npx playwright test --project=chromium-webgpu -g "cinematic"
npx playwright test --project=chromium-webgpu -g "keeps the hull over the plateau"
npx playwright test --project=chromium-webgpu -g "the tour reaches night"
```

Expected: all PASS. The seam test in particular — it samples across the wrap and asserts the median step, and it is the one that catches an edit that broke C¹.

- [ ] **Step 5: Watch it**

```bash
npm run dev
```

Select Cinematic and watch one full lap. The tests prove continuity; only a human can see whether the night beat is too dark to read or the squall arrives too abruptly. Adjust durations and re-run Step 4.

- [ ] **Step 6: Commit**

```bash
git add -A src tests
git commit -m "Sail the tour through the surf, a squall and a night"
```

---

### Task 8: Teach the harness cinematic mode

The three new tour shots cannot use the pattern the existing two use.

**Files:**
- Modify: `tests/lib/shots.ts` (`CameraMode`, `Shot.cinematicTime`), `tests/lib/capture.ts` (`applyShot`)

- [ ] **Step 1: Widen the shot types**

```ts
export type CameraMode = 'orbit' | 'fly' | 'boat' | 'cinematic';
```

and on `Shot`:

```ts
  /**
   * Position on the cinematic loop, seconds. Required when `state.cameraMode` is
   * `'cinematic'`, meaningless otherwise.
   *
   * This replaces the previous arrangement, where a tour shot copied a beat's
   * key into an *orbit* camera because this type did not offer cinematic mode.
   * That worked for `cinematic-reef` and `cinematic-landfall` only because the
   * tour's light there is close to the preset's. It is useless for the beats
   * that matter most: a night beat photographed as an orbit shot under `skyPro`
   * is a *noon* frame at a night camera position, and a squall one is a clear-sky
   * frame at a squall camera position — each baselining the pose and nothing the
   * beat exists to show.
   *
   * Naming a time instead of copying coordinates also retires the "if the beat
   * moves, this must move with it" hazard those two shots' comments carry.
   */
  cinematicTime?: number;
```

- [ ] **Step 2: Drive it from `applyShot`**

`shot.camera` stays `null` for cinematic shots — the flight owns the pose, exactly as it does for the chase rig. After the `setState` block:

```ts
  if (shot.state.cameraMode === 'cinematic') {
    if (shot.cinematicTime === undefined) {
      throw new Error(`shot "${shot.id}" is cinematic but names no cinematicTime`);
    }
    await page.evaluate((t) => window.__ocean.director.resetCinematic(t), shot.cinematicTime);
  }
```

`resetDeterministic` already calls `resetCinematic(start)` — where `start` is the *simulation* clock, not the loop position. So the shot's `time` and its `cinematicTime` are two different clocks and both must be set; set the loop position **after** `resetDeterministic` returns, then step the settle frames. Update the ordering comment in `applyShot` to say so.

Guard `snapToTarget`, which is chase-only: `if (!shot.camera && shot.state.cameraMode === 'boat')`.

- [ ] **Step 3: Migrate the two existing cinematic shots**

`cinematic-reef` and `cinematic-landfall` drop their copied `camera` blocks and gain `cameraMode: 'cinematic'` plus the `cinematicTime` of the beat key they were copying. Their baselines will change — the frame is now lit by the tour rather than by the preset, which is the entire point.

- [ ] **Step 4: Verify the two migrated shots render**

```bash
npx playwright test --project=visual -g "cinematic"
```

Expected: they fail the *comparison* (the image legitimately changed) but must not error. A thrown error here means the mode plumbing is wrong; a diff means it is right.

- [ ] **Step 5: Commit**

```bash
git add tests/
git commit -m "Let a shot name a moment in the tour instead of copying its camera"
```

---

### Task 9: The new shots

**Files:**
- Modify: `tests/lib/shots.ts`, `tests/gallery.spec.ts`

- [ ] **Step 1: Probe for the ship-and-island framing**

Do not guess the camera. Read the world:

```bash
npx playwright test --project=chromium-webgpu -g "probe"
```

with a temporary test that reports `window.__ocean.scene.getObjectByName('ship').position` after a reset, and `ISLAND`. Compose from the numbers: camera on the seaward side of the hull, aimed down the bearing from the ship to the island so both land on one axis; ship in the near third; island filling the background.

- [ ] **Step 2: Probe for the reef framing**

```ts
const centres = await page.evaluate(
  () => (window.__ocean.scene.getObjectByName('fish') as any).userData.schoolCentres,
);
```

Pick a reef school, stand off it by 10–14 m — not 30, which the shot's own comment records as having framed the school and still shown nothing, because a 0.42 m fish at 30 m through 45 m-visibility water is four pixels. Aim *at* the school with coral behind it.

- [ ] **Step 3: Add the shots**

`ship-and-island` (new), `cinematic-surf`, `cinematic-squall`, `cinematic-night` (all `cameraMode: 'cinematic'` with a `cinematicTime`), and retune `reef-dive`'s camera. Each needs a `purpose` that says what it would catch, in the voice of the existing entries.

- [ ] **Step 4: Add placeholder noise-floor entries**

`thresholdsFor` throws for an unknown shot id. Add all four with zeros; Task 10 replaces them with measurements.

- [ ] **Step 5: Update the gallery map**

In `tests/gallery.spec.ts`: `canonical('ship-and-island', 'hero')`, plus entries for the new tour shots. `clear-day-wide` keeps a gallery slot — it is the reference image and currently appears in the README nowhere.

- [ ] **Step 6: Commit**

```bash
git add tests/
git commit -m "Frame the ship against the island, and stand close enough to see a fish"
```

---

### Task 10: Re-measure, regenerate, republish

**Files:**
- Modify: `tests/lib/shots.ts` (measured floor), `tests/baselines/*`, `docs/images/*`, `README.md`, `docs/VERIFICATION.md`, `docs/SPEC.md`

- [ ] **Step 1: Re-measure the noise floor**

```bash
MEASURE_NOISE=1 npx playwright test --project=visual
```

It writes `test-results/visual/noise-floor.json` and prints a block. **Paste it.** Do not widen the gate by hand — the bloom pyramid samples a neighbourhood and crest sparkle is exactly the stochastic term this floor exists to record, so it is expected to move, and the correct response to it moving is to record the new value.

- [ ] **Step 2: Regenerate the baselines**

Follow whatever `docs/VERIFICATION.md` documents as the approval step. Every one of the 12 existing baselines changes; four new ones appear.

- [ ] **Step 3: Regenerate the gallery**

```bash
CAPTURE_GALLERY=1 npx playwright test --project=visual gallery
```

This must run on the real GPU. The test already skips on a software rasteriser, which is correct and must not be worked around — a software-rasterised capture would put a picture of the fallback path on the front page.

- [ ] **Step 4: Look at every image**

Open all of `docs/images/`. The tests prove the frames are reproducible; they cannot tell you the grade is too strong or the DOF has softened the island. If anything is wrong, fix it in Task 3–5's constants and start this task again.

- [ ] **Step 5: Update the prose**

- `README.md:8` → `docs/images/hero.png`, with a caption describing the new frame. `island.png` keeps its mid-page section unchanged.
- Add gallery rows for `clear-day-wide` and the new tour shots.
- `docs/VERIFICATION.md` — the new noise-floor values and the stack they came from.
- `docs/SPEC.md:103` — the post chain is no longer "fog, god rays, colour grade"; list the four new stages.

- [ ] **Step 6: Full suite**

```bash
npm run typecheck
npm test
```

Expected: PASS. Report any failure with its output rather than around it.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Rephotograph the world through the new glass"
```

---

## Self-review

**Spec coverage.** A1 → Task 3. A2 → Task 2. A3 → Task 4. A4 → Tasks 1, 5. A5 → Tasks 2, 3, 4. A6 (no new UI, no LUT, no second profile) → not a task; it is a constraint, recorded in Global Constraints and in each task's wiring step. A7 → the backend gates in Tasks 2, 3, 4. A8 → the `dispose()` step in Tasks 1–4. B1 → Task 9. B2 → Task 9. B3 → Task 8, then Task 9. B4 → Task 10. C1 → Task 7. C2 → Task 6. C3 → Task 6 (`weatherKind`) and Task 7 (the squall's low throttle). C4 → Task 6. C4b → Task 6 Step 6. C5 → Task 7 Step 1's test. C6 → Tasks 6 and 7.

**Gap found and closed.** A7 asks for a forced-WebGL rendered-frame test; no task had one. It belongs with the stage most likely to break there — Task 3, the DOF, which is gated off on WebGL2 and therefore needs proof the *rest* of the chain still renders. Add to Task 3 Step 7:

```bash
npx playwright test --project=chromium-webgpu -g "webgl"
```

and extend the existing forced-WebGL isolation test to assert a non-black frame with the new chain in place.

**Type consistency.** `ColorGradeParams` is used identically in Tasks 1 and 5. `CinematicEnvironment` is defined in Task 6 and consumed in Tasks 6 and 7 with the same five fields. `cinematicEnvironment(time?)` is the name in Task 6's interface block, its test, and Task 6 Step 6. `setSamples` (Task 3) and `setEnabled` (Tasks 2, 4) are consistent between their interface blocks and their `applyQuality` calls. `nominalShipAt` is introduced and used only in Task 7.
