# Third pass: correctness, coupling, and an adversarial quality bar

Runs alongside and after `prompt-2.md`. Same repository, same architecture, same
provenance rules. This prompt records what the second pass actually ran into, so
that everything below is verified rather than rediscovered.

Where this conflicts with `prompt-2.md`, this wins.

---

## 1. Research, and what it is worth

Study published technique before implementing. Prefer directly observed behaviour
over archived copies; exhaust authorised access routes before accepting a block;
ask for at most one human step if a verification gate is genuinely unavoidable.
Reproduce behaviour, never copy proprietary source.

Shadertoy references, **already checked** — do not repeat this search:

| Reference | Verdict |
|---|---|
| `lt3GWj` "Seascape" (TDM) | The only substantially relevant one. **CC BY-NC-SA 3.0 — cannot enter this tree.** Implement from technique only. |
| `MdGfzh` (hughsk) | Relevant to refraction. |
| `4dSBDt`, `4ljXWh`, `Nt3XDM`, `MdlyD8` | Not water or atmosphere shaders at all (hologram, flipbook, boids, a city). Ignore. |
| the rest | Marginal. |

Live Shadertoy is behind a Cloudflare challenge that CDP, curl and reader proxies
do not clear; archive.org served in a same-origin iframe does work. Budget the
time accordingly — the literature is a better investment than the scrape.

---

## 2. Defects to verify, not assume

Every item below was found by measurement or by an independent review, and every
one passed typecheck, existing tests, and casual inspection first. Check each
explicitly.

**Coordinate and sign errors — the expensive class.**

- Screen uv runs **top-down** on both backends; NDC y runs **bottom-up**. Any
  post pass reconstructing a world ray from `uv.y * 2 - 1` has every ray's
  vertical component inverted. This does not look like a broken ray, it looks
  like fog: the sky integrates the whole height-fog column and the water gets
  none. The tell is that it does not respond to density.
- The same handedness decides which way lens-rain droplets fall.
- Reversed-edge `smoothstep(high, low, x)` is **undefined** in WGSL and GLSL. Use
  a helper with ascending edges. Check the helper itself — writing it backwards
  yields a constant zero, not a visibly wrong ramp.
- Depth buffers measure along the camera's forward axis. Beer–Lambert wants path
  length: divide by the ray's axial cosine, or absorption weakens toward the frame
  edges and varies with field of view.

**Unwired features that look wired.**

- Settings and setters that nothing calls (`setBreaking`, `setFoamStrength`).
- UI controls placed by array index — inserting one silently drops the last.
- Materials adopted by flag test (`isMeshStandardMaterial`) when the loader
  converts everything to node materials: adopts nothing, effect is inert.
- A camera clamp that excludes a band around the surface is a wall, not a guard:
  approaching from either side snaps the camera back, so diving is impossible.

**Physics and shading.**

- A "GGX" term that is only the normal distribution function is not a
  reflectance. Its peak scales as `1/(pi·a2)` — near 10 000 at water's roughness.
  Include Smith visibility and Fresnel on the half-vector.
- Anisotropy: `uSlopeAnisotropy` is a ratio of slope *variances*, and variance
  goes as alpha squared. Scale alpha by `R^(1/4)`, not `sqrt(R)`.
- A Gram-Schmidt tangent frame needs a fallback axis chosen *before* projecting;
  blending two unnormalised projections can cancel to a NaN frame.
- Pairing an anisotropic NDF with an isotropic Smith term is an unmatched BRDF.
- Specular-AA constants from the literature assume ordinary roughness. Water's
  `alpha^2` is 3.2e-5; the usual 0.18 ceiling replaces the lobe rather than
  filtering it.
- Empirical laws must drive the quantity they describe. Monahan's
  `W = 3.84e-6·U^3.41` is about foam *generation*, not the opacity of an existing
  deposit.
- Cloud shadow attenuates over the sun path's length through the slab, not its
  vertical thickness.
- An accumulation buffer's foam channel should advect with the surface drift; a
  phase/elevation channel should not, and needs its own footprint mask.
- `viewportSafeUV` clamps a coordinate on screen, so an off-screen test must run
  on the raw uv, before it.

**GPU resource lifetime.** A quality-tier change destroys resources a submitted
command buffer may still reference — WebGPU says so: *"Destroyed texture used in
a submit"*. Three creates a light's shadow node lazily in `setup()`, so the crash
surfaces there and four different shadow-state "fixes" will each remove one
trigger and reveal the next. The actual requirement:

1. pause the loop, then **join the frame already inside `renderAsync`** — a
   boolean flag is not a join;
2. await the device queue fence;
3. apply, and compile the new pipelines while still paused;
4. drain again before resuming.

Nothing may submit a scene render inside that window — including an environment
cube capture triggered by a preset applied in the same `setState` call.

---

## 3. Additional required work

Beyond `prompt-2.md`'s feature list:

- **Volumetric height fog** with a live density control, and **per-preset**
  extinction. One global constant makes every preset a white-out.
- **Day/night slider** driving sun elevation, azimuth, moon, stars and the key
  light. Verify the control is actually built and reachable.
- **Per-pixel waterline.** Integrate the medium over the segment of *each eye ray*
  below the surface, with the surface taken from the wave field where the ray
  meets it. A whole-frame cross-fade cannot show air and water in one image.
- **Snell's window and total internal reflection** on the surface underside.
- **Cloud shadows on the water**, from the same density field the clouds are drawn
  from.
- **Sun occlusion for underwater shafts.** Whatever floats above a diver must
  shade them. Start with the hull in its own frame; a general test against the
  scene's shadow information is the target.
- **Ship wake that deforms the water**, not only foams it: Kelvin transverse and
  divergent systems plus a bow wave and shoulder trough, with `k = g/V²` so crests
  lengthen with speed.
- **Rain wetting** on hull and props, with asymmetric wet/dry time constants.
- **Touch controls** for Boat mode, gated on a coarse pointer and Boat mode only.
- Clouds must drift and evolve with the wind, without moiré in storm.
- Rain speed, ocean ripple density and lens-droplet motion must agree.
- Night must not render objects black: ambient, fill and rim response.
- Underwater and surface scenes need enough dressing not to read as empty.
- UI: no "View documentation" button; "View source" links the repository.

---

## 4. Quality bar

Judge from rendered results, then have them judged again. Use Codex — or an
equivalent independent reviewer — as an adversarial specialist, and run it
**repeatedly**: each round found real bugs in the previous round's fixes. Give it
the baselines, the claims, and permission to disagree.

Expect it to reject the following, correctly:

- claims stronger than the code ("full Kelvin V", "Smith masking", "exact",
  a technique attributed to the wrong paper);
- numbers with no source behind them, or that contradict the checked artifact;
- a claims audit that treats "wired and tested" as "working at the claimed
  fidelity";
- tests that cannot fail — a p95 threshold for a 2%-of-frame regression, a leak
  budget of one texture per transition across eight transitions, a "still renders"
  test that never reads a frame, a reflection test satisfied by the planar layer
  alone.

Every effect needs a test that fails when it is *disconnected*, not merely absent.
A test asserting "the wake changed the water" passes on foam alone; isolate the
channel under test.

The benchmark must gate on GPU sample count and console errors, not only CPU
samples — that gate is what surfaces resource-lifetime bugs the eye misses.

Iterate with the reviewer until it agrees the result is AAA, or until the only
objections left are ones you have deliberately declined *and defended with
evidence*. An objection you simply have not got to is not a closed objection.

---

## 5. Required, and not yet built

The second pass ended with these outstanding. They are the work, not a disclosure
list. Each names the obstacle that stopped it, so the next pass starts past it.

**Exposure discipline.** The reviewer's top image complaint: large regions of sky
and water clip to near-white across the daylight shots, burying material detail.
Make it measurable — the fraction of pixels within a threshold of full white, per
canonical shot — and gate on it, so "fixed" is a number rather than an opinion.

**Temporal antialiasing and reconstruction.** The single largest missing
technique: it stabilises the glitter and lets every march trade samples for
frames. Two real obstacles, both solvable:

- the ocean's custom `positionNode` means three's velocity node reports the wave
  surface as static, so the displaced position must carry its previous frame to
  produce correct motion vectors;
- history accumulation conflicts with deterministic capture. Fix the harness
  rather than skipping the technique: a fixed jitter sequence reset by
  `resetDeterministic`, and captures taken after a counted convergence.

**Screen-space reflection worth the name.** Half-resolution hierarchical-depth
trace, roughness-driven lobe, temporal resolve. The current one is
full-resolution, single-ray and non-temporal, which is an architectural ceiling on
contact reflections however well it is tuned.

**Refraction as a solved ray.** Snell at the interface, marched against the depth
buffer — not a normal-driven uv offset. The same applies to the underside's total
internal reflection, which is currently one offset lookup with no depth test.

**Clouds with structure.** Weather map, multi-scale density, a multiple-scattering
approximation, temporal reprojection, and a cloud shadow that is an integral
rather than one sample. Note that below roughly 14 degrees of sun elevation the
current single sample stops reaching the slab and the shadow vanishes.

**Foam that reads as foam.** Sparse multiscale bubbles and streaks rather than
broad ribboning: advection along the surface flow, bubble-size evolution, drainage
from crest to trough.

**Per-tier shadow and reflection resolution, restored.** Both are currently
written once at startup. That was a workaround for the resource-lifetime bug in
§2; with the drain in place the workaround should be removed and per-tier
resolution proven by a cycling test.

**World-normal rain wetting.** Wetting from above, running down, pooling — rather
than a uniform multiplier over the whole object.

---

## 6. Reporting

Commit at milestones with messages that say what was wrong and why the fix is
right. Update `README.md`, `docs/SPEC.md`, `docs/PERFORMANCE.md`,
`docs/VERIFICATION.md`, `docs/CLAIMS_AUDIT.md` and `ASSET_LICENSES.md` in the same
pass — stale documentation is a defect, and a claims audit that describes an
earlier build is worse than none.

Do not claim an effect or a performance result that was not measured. Honesty
about what was measured is required; it is not a substitute for building the
thing, and a limitation is a defect with a date on it, not a feature of the
design.
