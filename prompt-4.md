You are responsible for completing the following task end to end.

<task>
Outcome:
Bring `web-ocean-3d` to a AAA-quality, performant, optimised interactive scene of
the standard modern games set. Every system already exists and is verified; this
pass closes the gap between "every system works" and "the scene is good", and
clears the limitations that are worth clearing.

**A. Explicitly requested defects and additions**

1. **The default ocean bed is unpleasant.** Broadband hiss rather than water.
   Reduce and reshape it so a long session is comfortable — surf should breathe,
   not sizzle. *(Done in `183a58c`; verify it survived.)*
2. **The water surface is visibly jittery at High and above.** Sampling the
   derivative field at the undisplaced coordinate halved Medium (3.14 → 1.64 mean
   frame-to-frame |dL|) and did nothing for the three-cascade tiers (High 9.06 →
   9.78). The remaining term arrives with the third cascade. **The metric is the
   problem: a temporal difference cannot separate shimmer from genuine motion,
   because two-metre waves legitimately change the image in 1/60 s.** Build a
   spatial-frequency or same-frame-repeat metric first, then fix what it shows.
3. **The ship's wake is weak.** The Kelvin elevation channel is bound and working,
   but from the chase camera at speed the arms, the turbulent band astern and the
   bow break are not legible.
4. **Add a fourth camera mode: Cinematic.** A looping authored flight carrying
   ship and camera through the scene — open water, the island, a low pass at the
   waterline, a dive under, the reef. A real mode beside Orbit / Fly / Boat,
   keyboard-selectable, releasing cleanly, not fighting the director or the ship
   controller.
5. **The scene dressing is fetched but unplaced.** Twenty CC0 models in
   `public/models/dressing/` are committed and nothing loads them. Place them:
   island planting and rock, the pirate cove, the underwater find.

**B. Limitations to clear**

These are in `README.md` under Known limitations. They are work, not disclosure.
Ordered by what they cost the image:

6. **No temporal antialiasing or reconstruction.** Named in the README as the
   largest single thing between this and a shipping image: it stabilises the
   glitter and lets every march trade samples for frames. Two real obstacles,
   both solvable and neither a reason to skip it — the ocean's custom
   `positionNode` makes three report the wave surface as static, so the displaced
   position must carry its previous frame to produce correct motion vectors; and
   history accumulation conflicts with deterministic capture, so the harness needs
   a fixed jitter sequence reset by `resetDeterministic` and captures taken after
   a counted convergence. Solving 6 is the most likely route to solving 2.
7. **`resetDeterministic` does not isolate a shot from its predecessor.** The boat
   shot after the storm has visibly heavier foam than the boat shot first. The
   rain rate is now pushed in before anything rewinds, which fixed the lens and
   hull wetness; the foam path still carries something. This makes every baseline
   a function of test order and is a harness defect, not a renderer property.
8. **Foam reads as broad ribboning**, not sparse multiscale bubbles and streaks.
   Monahan's law drives generation but nothing measures the rendered coverage
   against it.
9. **Refraction is a normal-driven UV offset, not a solved refracted ray** — and
   the same is true of the underside's total internal reflection.
10. **Screen-space reflection is full-resolution, single-ray, non-temporal.** No
    prefiltered probe, no stochastic sampling with a temporal resolve.
11. **Per-tier shadow and reflection resolution are fixed at startup.** That was a
    workaround for the resource-lifetime bug; with the drain in place it should be
    removed and per-tier resolution proven by a cycling test.
12. **Underwater sun occlusion covers the hull only.** A diver under a barrel gets
    full shafts.
13. **Cloud shadow is one sample, and the clouds are a procedural slab** — no
    weather map, no multiple-scattering approximation, no temporal reprojection.
14. **Rain wetting is uniform over an object** rather than driven by the world
    normal, so nothing wets from above, runs down, or pools.

Repository or workspace:
`D:\Github\web-ocean-3d`

References:
- `prompt.md`, `prompt-2.md`, `prompt-3.md` — the standing specification. Where
  they conflict with this file, this file wins.
- `README.md` § Known limitations — the source of section B.
- `docs/CLAIMS_AUDIT.md` §9–§12 — the defect classes this codebase actually
  produces. Read before assuming a system works because it exists.
- `docs/VERIFICATION.md`, `docs/PERFORMANCE.md` — the harnesses, and what they do
  and do not establish.
- `tests/baselines/*.png` — current rendered output. This is what is being judged.

Constraints:
- Three.js r0.185 WebGPU + TSL, WebGL2 fallback from the same node graph. No
  compute, no storage textures.
- Every asset CC0 or equivalently free, recorded in `ASSET_LICENSES.md`.
- No per-frame allocation, no synchronous GPU readback, no shader compilation
  during gameplay.
- Every system needs a tier cost policy, a WebGL policy, disposal, and
  deterministic `resetClock(t)`: the visual harness rewinds time, and a system
  carrying integrated state makes every baseline a function of test order.
- `npm run bench` must report PASS for all seven configurations with no console
  errors. WebGPU High ≤ 16.7 ms GPU p50; WebGL2 Low ≤ 33.3 ms.

Acceptance requirements:
- Every item in A and B is either implemented and verified, or blocked with
  evidence and three substantively different attempts recorded. Nothing is filed
  as a limitation because it was not reached.
- Each new or changed system has a test that fails when it is *disconnected*, not
  merely absent.
- Jitter is measured by a metric that cannot be satisfied by removing motion, and
  the High/Ultra/Max figures improve against it.
- Cinematic loops without discontinuity and releases cleanly to the other modes.
- The dressing is visible in a regenerated canonical capture and tier-scaled.
- Baselines and the README gallery are regenerated and *inspected*, not merely
  passed.
</task>

<operating_mode>
Work autonomously through discovery, research, implementation, testing, adversarial
review, repair and final verification.

Do not stop to present a plan or request approval for routine decisions. Maintain
an internal execution ledger and proceed directly.

Ask only when progress genuinely requires unavailable credentials, authorization
for an irreversible external action, or resolution of a material contradiction
that cannot be inferred safely.

Do not silently narrow, reinterpret or expand the requested outcome.
</operating_mode>

<capability_check>
Inspect available tools before starting. Agent Reach is a social-platform access
toolkit (Twitter, Reddit, YouTube, Bilibili) and is **not** useful here — every
asset and documentation source this project uses responds directly. Do not install
it for this task.

Do not claim that research, browser testing or verification occurred unless the
tool actually ran.
</capability_check>

<research>
Research before choosing an approach when the decision materially affects quality
or performance. For the jitter especially: **measure before theorising.** Three of
this project's longest-lived bugs each survived four fixes aimed at the wrong
layer, and each was found by rendering the suspect quantity to the framebuffer
rather than by reading the shader.

Prefer, in order: existing project capability, existing dependency, official
framework capability, mature library, focused component, custom implementation.
</research>

<implementation>
Implement the complete outcome, not a prototype. Follow existing architecture and
comment conventions — comments explain *why* and name the failure mode a decision
prevents; they never restate the code.

Use subagents for sizeable independent work, and never let two edit the same file.
Wiring into `src/main.ts` stays with one owner.

Do not leave stubs, dead settings or knowingly broken paths. Do not weaken a test
to make an implementation pass.
</implementation>

<verification>
Use observable evidence. Run `npm run typecheck`, both Playwright projects, and
`npm run bench` after the final change. Regenerate the visual baselines and the
README gallery (`CAPTURE_GALLERY=1 npx playwright test --project=visual gallery`)
and **look at the images** — a passing metric against a self-approved baseline
proves only that nothing moved.

A successful build is not proof the workflow works.
</verification>

<adversarial_review>
After implementation, run **Codex** as the adversarial reviewer, supplying the
diff, the regenerated baselines, the specific claims made, and the benchmark
artifact. Ask it to disprove completion.

Every previous round found real defects in the round before it, including in fixes
made in response to its own findings. Budget for at least one repair cycle after
it reports, and re-run it after repairing.

A finding is confirmed only when supported by code evidence, a reproducible
scenario, a failing check or a clearly violated requirement. Do not change working
code on speculation.
</adversarial_review>

<repair_loop>
Fix all confirmed critical and major issues. After each repair run the narrowest
check that proves it, then the affected suite, then the full suite after the last
change.

When the same failure survives two similar fixes, stop patching and reassess the
underlying assumption, architecture or interpretation.

Stop only when all completion conditions pass, progress requires unavailable
information, or three substantively different approaches have failed for the same
blocker. When blocked, leave the repository in the strongest coherent state and
report the evidence and attempted approaches.
</repair_loop>

<completion_conditions>
Complete only when every item in A and B is implemented and verified or blocked
with evidence, the gates pass, the affected workflow was exercised after the final
change, no known critical or major defect remains, and the final diff contains no
unrelated changes.

Record honest remaining limitations. Do not file unfinished work as a limitation.
</completion_conditions>

<final_response>
Concise and evidence-based: result, what was implemented, important decisions,
verification performed with results, remaining limitations. No chronological
narration.
</final_response>
