# Follow-up pass: AAA ocean visuals, storms, and ship control

Continue from the current repository and the work produced from `prompt.md`. Do not rebuild the project or replace working systems unnecessarily. First inspect the live experience, source, tests, screenshots, quality tiers, and performance documentation; verify every existing claim because some configured features are placeholders or only partially connected.

Bring the experience to a substantially higher, AAA-quality visual and interaction standard while preserving the Three.js WebGPU/TSL architecture, WebGL2 fallback, deterministic behaviour, responsive UI, and performance targets.

This prompt's quality and completion gates supersede `prompt.md`'s requirement to closely match threejswaterpro.com. Preserve the original provenance/licensing rules and the development discipline restated below, but optimize for the strongest verified result in this codebase rather than fidelity to that site.

These are optional visual references, not required dependencies:

- Crest Water 5: https://assetstore.unity.com/packages/tools/particles-effects/crest-water-5-oceans-rivers-lakes-268614
- Fluid Flux: https://www.fab.com/listings/196c70cd-1283-4249-bf6b-c3019d1cbe11
- Rain Drops — Wet Surface VFX: https://www.fab.com/listings/5ed72ea5-9036-45da-84d2-dbb2eb64ba2b
- RaindropFX Pro: https://assetstore.unity.com/packages/vfx/shaders/fullscreen-camera-effects/raindropfx-pro-urp-1-8-310039

Do not block on scraping or accessing these JS-heavy pages; the requirements below are the specification. Research current official Three.js/WebGPU/TSL documentation and published rendering techniques before choosing an approach.

## Blocking foundations

Complete Tasks 0 and 1 before feature work. If hardware or browser APIs prevent a trustworthy measurement, finish the harness, record the result as **UNVERIFIED** with evidence and exact reproduction commands, then continue. Never infer a pass or stall indefinitely.

### Task 0 — Claims and wiring audit

Create `docs/CLAIMS_AUDIT.md`: a table mapping every advertised feature, UI control, quality setting, README/spec claim, and screenshot to its implementation path, test evidence, actual status, and action.

Treat these repository findings as hypotheses to re-verify:

- `ssrEnabled`, `bloomEnabled`, `causticsEnabled`, `fishCount`, and `renderScale` have no consumers; `shadowMapSize` acts only as an on/off switch while the light remains hardcoded to 2048; underwater particle count is applied only at construction.
- Boat mode advertises W/S and A/D controls but is currently only a chase camera.
- `Wake` already computes a world-anchored foam texture, but that texture is not sampled by `OceanMaterial`; bind and validate this existing work instead of rewriting it.
- Ocean reflection is an analytic sky approximation, and rain is an uncoupled camera-following overlay.
- Architecture and feature documentation may name modules or behaviour that do not exist.

For each discrepancy, either fully implement and verify it or remove the dead setting/claim/UI in the same task. Do not build unrelated systems merely to justify stale flags: delete `fishCount`, `renderScale`, or similar settings if they do not serve this prompt.

### Task 1 — Trustworthy verification harness

Build both parts before judging visual or performance work:

**Performance harness**

- Add a reproducible headed, focused-browser benchmark path outside throttled headless Playwright. Keep Playwright for functional tests, not as the source of GPU performance truth.
- Use WebGPU timestamp queries or the strongest available GPU timing facility; record availability. Capture hardware, driver, OS, browser/build, backend, resolution, DPR, tier, CPU time, GPU time, frame-time percentiles, FPS, draw calls, triangles, and resource counts.
- Detect rAF throttling, software rendering, missing adapters, unsupported timestamps, and unfocused/vsync-limited runs. Such runs are **UNVERIFIED**, never passes.
- Document one command that reproduces the benchmark and retain machine-readable results. When trustworthy GPU timing is unavailable, report what was measured, why the budget is unverified, and the exact remaining manual verification.

**Deterministic visual harness**

- Add seeded randomness for weather and underwater effects, fixed/frozen simulation time with deterministic stepping, resettable wake/weather state, asset-ready and shader-ready signals, and exact camera/state pinning for every mode—not only Orbit.
- Define and check in approved baselines for canonical shots: clear-day wide, near-water detail, sunset, storm, Boat/chase while moving, waterline split, and underwater.
- Capture the rendered scene through a deterministic offscreen/readback path where supported, or a controlled compositor path when direct readback is not reliable. Exclude transient UI unless the shot tests UI.
- Produce full-resolution actual/baseline/diff artifacts and a numeric perceptual metric with documented thresholds. Do not use average colour or require pixel-exact equality across different GPU/browser stacks; compare on a recorded equivalent stack and retain human review for artifacts metrics miss.

## Execution workflow

1. Capture the deterministic baseline and create a gap matrix ordered by visible impact, dependency, and measured cost.
2. Produce a short plan of small, non-overlapping tasks. Use a fresh implementation subagent for each task; test and commit each task; run independent specification and code-quality reviews after each; use Codex as an independent architecture, shader, debugging, performance, and final-review specialist; never allow concurrent edits to overlapping files.
3. After each visual task, capture the same canonical shots, inspect the numeric diff and full-resolution images, fix the largest remaining defect, and repeat. Do not stop after merely adding named effects.
4. Gate each phase. Do not advance with half-wired work simply to cover more bullet points; fewer fully completed features are better than many partial ones.

No feature is complete until it:

- is connected to the real render/input path and visibly affects the intended result;
- has an explicit quality-tier cost, WebGL policy, lifecycle, disposal, and tier-change rebuild behaviour;
- has a behavioural or render-path test that fails if the feature is disabled or disconnected;
- has reviewed before/after canonical captures; and
- has trustworthy performance evidence, or is explicitly marked **UNVERIFIED** without claiming the budget passed.

## 1. AAA water and scene rendering

Upgrade the complete image rather than over-tuning one shader:

- Render convincing reflections of the ship, nearby objects, clouds, sky, and sun. Select the best practical combination of planar reflections, screen-space reflections, environment probes, and fallbacks per quality tier. Avoid presenting a sky-gradient approximation as scene reflection.
- Add depth-aware refraction/transmission using scene colour and depth where supported, with Fresnel, Beer–Lambert absorption, scattering, distortion, and a stable fallback. Handle partial submersion, the meniscus/waterline, the underwater surface underside, Snell-window behaviour, and total internal reflection without popping.
- Improve multiscale wave detail, normals, roughness, GGX highlights, anisotropic sun glitter, crest translucency, back-scattering, depth colour, horizon integration, and temporal stability. Eliminate shimmering, excessive white coverage, obvious tiling, banding, and clipped highlights.
- Make foam layered and persistent: breaking-crest whitecaps, aerated crest edges, wake foam, rain agitation, and shallow/shore contributions. Advect and dissipate foam over time instead of regenerating a static mask each frame.
- Improve caustics so they respond to wave motion, depth, sun direction, occlusion, and underwater geometry without visible projection swimming.
- Improve the ship and environment materials, texture filtering, contact shadows, reflection response, exposure, tone mapping, colour grading, cloud lighting, aerial perspective, and storm contrast. Retain highlight and shadow detail; avoid the current flat, overexposed, or uniformly glossy look.
- Make presets represent coherent physical conditions. Wind, spectrum, cloud cover, rain, visibility, water optics, exposure, foam, and lighting must transition together smoothly.

Use physically motivated techniques where they improve the image, but judge completion from stable rendered results rather than terminology.

## 2. Storm, rain, water interaction, and wetness

Turn rain into a coupled weather system rather than an isolated particle overlay:

- Keep wind-driven near-camera rain streaks, but add stochastic rain impacts on the ocean: small expanding ripples, normal disturbance, micro-splashes, brief crowns, and local foam/roughness response.
- Implement impacts through a shared, camera-relative, low-resolution GPU field or another bounded technique. Do not simulate every visible raindrop independently or introduce CPU readback/stalls.
- Make impact density, scale, direction, lifetime, and energy follow rain intensity, wind, camera distance, and quality tier. The field must remain stable while the camera and ocean origin move.
- Add accumulated wetness to exposed ship surfaces and suitable props. Wet areas should darken appropriately, become smoother and more reflective, receive splash variation near the waterline, and dry gradually after rain stops. Use masks and material parameters rather than duplicating materials.
- Add a quality-scaled lens/screen rain effect inspired by high-end games: static beads, newly formed droplets, moving droplets, rolling trails/leaks, refractive distortion, local blur/fogging, wind and gravity response, natural fade/drying, and smooth start/stop.
- Render lens droplets as part of scene post-processing before the HUD so UI text remains crisp. Disable or transform the effect appropriately underwater, avoid covering the entire image uniformly, and provide reduced or disabled versions on lower tiers and WebGL.
- Couple storm intensity to ocean agitation, spray, foam, clouds, visibility, lighting, and optional distant lightning only when it improves the scene coherently.

All rain and wetness effects must be temporal, physically plausible at normal viewing speed, and free of obvious repeating textures.

## 3. Selectable, steerable ship

The existing Boat mode must become the ship controller:

- Selecting **Boat/Ship** in the HUD or pressing **3** selects the ship, enables its controller, and enters the chase camera. Leaving Boat mode releases ship input so Orbit and Fly controls cannot conflict.
- Use **W/S** for forward/reverse throttle or braking and **A/D** for rudder/steering. Show concise live control hints and expose normalized throttle, rudder, speed, and heading for testing.
- Implement acceleration, deceleration, speed-dependent steering authority, hydrodynamic drag, lateral resistance, angular damping, and sensible limits. Input should feel responsive but preserve the inertia and mass of a sailing vessel.
- Compose horizontal propulsion and yaw with the existing wave-driven heave, pitch, roll, and buoyancy rather than overwriting them. Motion must remain stable in large waves and with variable frame rate.
- Bind the existing world-anchored `Wake.texture` into ocean shading first, then drive wake displacement, stern foam, spray, and strength from actual hull speed, acceleration, and turning. The wake must follow the moving ship in world space and dissipate naturally.
- Polish the chase camera with collision/surface avoidance, look-ahead, speed-sensitive distance/FOV where useful, critically damped motion, and no clipping or nausea-inducing wave jitter.
- Support keyboard reliably and retain touch/responsive behaviour; add compact touch controls when a touch device is detected if the current UI supports mobile interaction.

## 4. Performance and scalability

Visual quality is not complete if it breaks frame pacing:

- Target WebGPU High at a stable approximately 60 FPS / 16.7 ms GPU budget at 1600×900, DPR 1 on recorded representative desktop hardware. Target WebGL2 Low at or above 30 FPS / 33.3 ms with a deliberately simplified but coherent image. These gates pass only from the trustworthy harness above; otherwise report **UNVERIFIED**.
- Measure real GPU time with timestamp queries when available and record hardware, browser, resolution, tier, CPU frame cost, GPU frame cost, frame-time percentiles, draw calls, triangles, and GPU memory/resource counts. Do not infer GPU performance from asynchronous render-call wall time.
- Assign a cost and quality-tier policy to every new effect. Prefer shared GPU fields, temporal reprojection, half/quarter-resolution buffers, bilateral upsampling, bounded ray steps, mip/LOD selection, instancing, and early-outs.
- Avoid per-frame allocations, synchronous GPU readbacks, unbounded particles, redundant fullscreen passes, duplicate scene renders, unnecessary transparent overdraw, and shader variants that compile during gameplay.
- Prewarm pipelines and materials behind the loading overlay. Dispose and rebuild all tier-dependent resources deterministically; repeated quality and preset changes must not leak.
- Preserve adaptive quality, but make it respond to sustained measured frame pressure without rapid oscillation or abrupt visual discontinuities.
- WebGL2 must degrade explicitly. Unsupported effects need tested substitutes or clean disablement, never broken shaders or silent no-ops.

## Verification and completion gates

Extend Playwright and deterministic test hooks to prove:

- Boat mode activates ship control; W/S changes signed speed, A/D changes heading, other camera modes do not steer, and buoyancy remains stable while moving.
- Ship position, heading, wake origin, chase camera, and exposed controller state stay finite across frame-rate changes and storm sea states.
- Rain intensity increases ocean impacts, lens droplets, and surface wetness; each decays after rain stops; underwater mode does not retain an inappropriate lens overlay.
- Reflections visibly contain nearby scene geometry on supported tiers; refraction, scattering, foam persistence, caustics, bloom, and every advertised quality flag produce a measurable image/render-path difference.
- Clear, sunset, storm, waterline, underwater, and moving-ship screenshots pass a reviewed visual checklist with no obvious seams, clipping, shimmer, blown highlights, flat materials, or placeholder effects.
- Both WebGPU and WebGL2 boot and render without console errors; controls, presets, transitions, resizing, and responsive layouts remain functional.
- On documented compatible hardware, performance budgets and frame-time stability are measured and met. Without such hardware or timing support, the result remains **UNVERIFIED** with evidence and reproduction steps; quality cycling must still prove it does not leak resources, and the production build and full automated suite must pass.

Update `README.md`, `docs/SPEC.md`, `docs/PERFORMANCE.md`, tests, control documentation, and `ASSET_LICENSES.md` as required. Record honest remaining limitations and measured evidence; do not claim an effect or performance result that was not verified.

Resolve routine implementation choices independently. Research alternatives, choose the strongest practical approach for this codebase, document important trade-offs briefly, and continue without asking for approval. Escalate only when blocked by missing access, credentials, hardware capabilities, or an unavoidable external dependency.
