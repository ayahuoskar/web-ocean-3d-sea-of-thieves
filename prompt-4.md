You are responsible for completing the following task end to end.

<task>
Outcome:
Bring `web-ocean-3d` to a AAA-quality, performant, optimised interactive scene of
the standard modern games set. The renderer, physics, audio and content systems
already exist and are verified (see `prompt.md`, `prompt-2.md`, `prompt-3.md` and
`docs/CLAIMS_AUDIT.md`); this pass closes the gap between "every system works" and
"the scene is good".

Five specific defects and additions, all explicitly requested:

1. **The default ocean bed is unpleasant.** It reads as broadband hiss rather than
   water. Reduce it and reshape it so the resting state is calm and comfortable to
   listen to for a long session — surf should breathe rather than sizzle.
2. **The water surface is visibly jittery at High and above.** Worse at the higher
   tiers, which is the tell: more detail is being resolved than the sampling can
   carry. Diagnose the actual cause before changing anything — candidates include
   derivative-field mip selection, the specular filter's variance ceiling, the
   normal flattening curve, and geometry/shading LOD disagreement.
3. **The ship's wake is weak.** The Kelvin elevation channel exists and is bound,
   but the result does not read as a ship's wake at speed: the arms, the turbulent
   band astern and the bow break all need to be legible from the chase camera.
4. **Add a fourth camera mode: Cinematic.** A looping, authored flight that carries
   the ship and camera through the scene to show it off — open water, the island,
   a low pass near the waterline, a dive under, the reef. It must be a real mode
   alongside Orbit / Fly / Boat, keyboard-selectable, and it must not fight the
   existing camera director or ship controller.
5. **The scene dressing is fetched but unplaced.** Twenty CC0 models
   (`public/models/dressing/*.glb`) are committed and nothing loads them. Place
   them: island planting and rock, the pirate cove, and the underwater find.

Repository or workspace:
`D:\Github\web-ocean-3d`

References:
- `prompt.md`, `prompt-2.md`, `prompt-3.md` — the standing specification. Where
  they conflict with this file, this file wins.
- `docs/CLAIMS_AUDIT.md` §9-§12 — the defect classes this codebase actually
  produces. Read before assuming a system works because it exists.
- `docs/VERIFICATION.md`, `docs/PERFORMANCE.md` — the harnesses and what they do
  and do not establish.
- `tests/baselines/*.png` — current rendered output. This is the thing being
  judged.

Constraints:
- Three.js r0.185 WebGPU + TSL, WebGL2 fallback from the same node graph. No
  compute, no storage textures.
- Every asset CC0 or equivalently free, recorded in `ASSET_LICENSES.md`.
- No per-frame allocation, no synchronous GPU readback, no shader compilation
  during gameplay.
- Every new system needs a quality-tier cost policy, a WebGL policy, disposal, and
  deterministic `resetClock(t)` behaviour — the visual harness rewinds time and a
  system carrying integrated state makes every baseline a function of test order.
- Performance gates: WebGPU High at or under 16.7 ms GPU p50, WebGL2 Low at or
  under 33.3 ms, measured by `npm run bench`, which must report PASS for all seven
  configurations with no console errors.

Acceptance requirements:
- The resting audio bed is quiet and pleasant; the change is demonstrable as a
  measured level and spectrum difference, not an assertion.
- Surface jitter at High/Ultra/Max is reduced, with the cause named and the fix
  aimed at it rather than at the symptom.
- The wake is legible from the chase camera at speed, shown in a regenerated
  `boat-chase` capture.
- Cinematic is selectable, loops without discontinuity, releases cleanly to the
  other modes, and has a test that fails if it is disconnected.
- The dressing is visible in a canonical capture, tier-scaled, instanced where it
  repeats, and disposed correctly.
- 28+ functional and 12+ visual tests pass; `npm run bench` PASSes all seven.
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
Inspect the available tools before starting. Agent Reach is a social-platform
access toolkit (Twitter, Reddit, YouTube, Bilibili) and is **not** useful here —
every asset and documentation source this project uses responds directly. Do not
install it for this task.

Do not claim that research, browser testing or verification occurred unless the
tool actually ran.
</capability_check>

<research>
Research before choosing an approach when the decision materially affects quality
or performance. For the jitter in particular: measure before theorising. The
project has a deterministic capture harness and a headed GPU benchmark; use them
to isolate which term is unstable rather than tuning constants until it looks
better.

Prefer, in order: existing project capability, existing dependency, official
framework capability, mature library, focused component, custom implementation.
</research>

<implementation>
Implement the complete outcome, not a prototype. Follow existing architecture and
comment conventions — comments explain *why* and name the failure mode a decision
prevents; they never restate the code.

Use subagents only for sizeable, genuinely independent work, and never let two
agents edit the same file.

Do not leave stubs, placeholders or dead settings. Do not weaken a test to make an
implementation pass.
</implementation>

<verification>
Use observable evidence. Run `npm run typecheck`, both Playwright projects, and
`npm run bench` after the final change. Regenerate the visual baselines and the
README gallery (`CAPTURE_GALLERY=1 npx playwright test --project=visual gallery`)
and *look at the images* — a passing metric against a self-approved baseline
proves only that nothing moved.

A successful build is not proof the workflow works.
</verification>

<adversarial_review>
After implementation, run **Codex** as the adversarial reviewer, supplying it with:
the diff, the regenerated baselines, the specific claims made, and the benchmark
artifact. Ask it to disprove completion.

Every previous round of this has found real defects in the round before it —
including in fixes made in response to its own findings. Budget for at least one
repair cycle after it reports.

A finding is confirmed only when supported by code evidence, a reproducible
scenario, a failing check or a clearly violated requirement. Do not change working
code on speculation.
</adversarial_review>

<repair_loop>
Fix all confirmed critical and major issues. After each repair run the narrowest
check that proves it, then the affected suite, then the full suite after the last
change.

When the same failure survives two similar fixes, stop patching and reassess the
underlying assumption. Three of this project's longest-lived bugs each survived
four fixes aimed at the wrong layer.
</repair_loop>

<completion_conditions>
Complete only when every explicit requirement above is implemented and verified,
the gates pass, the affected workflow was exercised after the final change, and no
known critical or major defect remains. Record honest remaining limitations; do not
file unfinished work as a limitation.
</completion_conditions>

<final_response>
Concise and evidence-based: result, what was implemented, important decisions,
verification performed with results, remaining limitations. No chronological
narration.
</final_response>
