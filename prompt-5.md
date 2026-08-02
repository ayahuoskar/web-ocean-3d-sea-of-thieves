You are responsible for completing the following task end to end.

<task>
Outcome:
Make the island a place worth sailing to, and close the remaining gap between
this renderer's water and a modern AAA one. Everything in section A is a defect
or absence observed in the running build — several of them are visible in a
single screenshot of the island, which is the fastest way to understand what is
being asked.

**A. Observed defects**

1. **The cliffs are a stage flat.** Six `coastal_cliff_02` slabs stand in a row,
   all turned roughly the same way, forming a straight grey wall across the
   island's back. `Props.ts:967-975` takes `facing: 'alongshore'` to mean the
   tangent to a *circle* about `ISLAND.x/z` — so the orientation assumes the
   shoreline is a circle and never consults the heightfield's actual contour.
   Tilt does sample the surface normal, but only at `slope: 0.35`, so the slabs
   stay near-vertical whatever they are standing on. Orientation must come from
   the terrain, not from an assumed shape.
2. **Nothing lives underwater near the island.** `Fish.ts` circuits are centred
   on the world origin at radius 29-232 m; the island is 1390 m away and `Fish.ts`
   does not import `ISLAND` at all. A search of `src/` for kelp, seagrass,
   seaweed, coral, algae, anemone or urchin returns one hit, and it is a comment
   about sand mottling — there is no underwater plant system of any kind.
3. **There is no surf.** The sea meets the beach at a hard line. `Wake.ts` has
   zero references to the seafloor, the island, land or shore: foam has exactly
   three sources — breaking crests from the Jacobian, the hull stamp, and rain
   agitation — and none of them is terrain. The only land-to-water coupling that
   exists is `floorDepthNode`, one-way, and it shortens the Beer-Lambert path
   rather than making anything break. A shore breaking white where the bottom
   shoals is one of the strongest cues that land and water are the same
   simulation rather than two things drawn near each other.
4. **The hull submerges completely.** `Buoyancy.ts:284-288` clamps `submersion`
   to 1, so buoyant force *saturates* once the probe plane is about 1.69 m under
   the surface; past that, extra depth buys no additional restoring force while
   gravity keeps acting on 90 tonnes. There is no minimum-freeboard term, no
   green-water model, and the probes ride the sampled surface rather than the
   deck, so nothing detects the deck going under. Confirm this is the mechanism
   before fixing it — that clamp is also what keeps the hull from being fired out
   of the water, so removing it naively trades one failure for another.
5. **No birds are audible.** Gulls are drawn and animated; the audio bed has
   eight noise beds and four one-shot voices and nothing living. `AudioSystem` is
   entirely procedural by deliberate choice — there is no sample playback to add
   to — so a gull cry has to be synthesised, in the shape of `playSplash` or
   `spawnBubble`, and budgeted against the per-tier voice count.
6. **The water is not yet AAA.** Reflection, refraction and scattering are each
   individually defensible and collectively short of the reference. Attack this
   with measurements, not adjectives.

   Scattering is the clearest case and the place to start. It is
   `authoredColour x back^3 x clamp(worldY x 0.28) x strength x lightLevel`
   (`OceanMaterial.ts:849-863`) — a constant tint gated by a backlight lobe and
   by absolute wave height saturating at 3.57 m. It does not consult
   `pathLength`, `absorption`, wave *thickness*, or the extinction coefficient,
   all of which are computed a dozen lines above it for the transmission term.
   Real subsurface scattering through a wave is light that entered elsewhere and
   travelled; it should fall off with the distance travelled and take its colour
   from the medium's extinction, not from a hex constant.
7. **The island casts no shadows.** The sun's shadow camera is a +/-260 m box
   anchored at the world origin (`Atmosphere.ts:324-333`) and never re-targeted,
   so `Props.ts:997-1002` and `:834-838` clear `castShadow`/`receiveShadow` on
   everything on the island — correctly, given the box. Fix the box, not the
   flags. A second cascade, a re-targeted camera, or a wider box are all viable;
   whichever is chosen must not cost the open-ocean frame the resolution it
   currently has near the ship.
8. **The planting is wrong and sparse.** The only tree-form models are
   `island_tree_01` (temperate) and `pachira_aquatica_01`, nine of each, on a
   dome that renders as blown-out white with no sand colour at all. It should be
   lush and tropical, with a real beach: sand that looks like sand, dense canopy,
   understorey, and a gradient from waterline to interior.
9. **The island is too small and undesigned.** `ISLAND.radius` 260, `peak` 30,
   and the rise is a single `smoothstep` in `dIsland` — literally a radially
   symmetric dome, which is why the shoreline is a circle and why the cliffs'
   circular-tangent assumption was not obviously wrong. Enlarge it and give it a
   shape that rewards sailing around: bays, headlands, a spit, a lagoon. The
   heightfield exists twice, once on the CPU (`Seafloor.ts:150-166`) and once in
   TSL (`:449-464`), and they must stay in agreement — buoyancy, prop placement
   and the water's depth term all read one or the other.
10. **Add pirate remains.** A skeleton, a sword, bottles, and comparable
    detritus, placed as a scene tells a story — not scattered uniformly.

Repository or workspace:
`D:\Github\web-ocean-3d`

References:
- `prompt.md`, `prompt-2.md`, `prompt-3.md`, `prompt-4.md` — the standing
  specification. Where they conflict with this file, this file wins.
- `src/scene/Seafloor.ts` — `ISLAND` is at (-1150, -780), radius 260, peak 30.
  The heightfield is shared between a CPU function and a TSL one and they must
  stay in agreement; read the comment before touching either.
- `src/scene/Props.ts` — all placement. `src/scene/Fish.ts`, `src/scene/Birds.ts`
  — the existing GPU-instanced life, and the pattern any new instanced system
  should follow.
- `src/physics/Wake.ts` — the world-anchored foam buffer, its deposit and decay.
- `src/audio/` — `NoiseBed`, `ParamTarget`, the procedural bed.
- Poly Haven's API (`https://api.polyhaven.com/assets?t=models`) is the CC0 source
  already in use. Its `smugglers_cove` collection contains material this scene
  has not taken: `coast_line_01`, `coast_line_02`, `coast_land_rocks_02/03/04`,
  `coastal_cliff_01`, `coastal_cliff_04`, `coast_rocks_02`, `coast_rocks_05`,
  `modular_fort_01`, `wooden_bucket_01/02`. For section A10 it also has
  `antique_estoc`, `ornate_medieval_dagger`, `machete`, `kite_shield` and
  `jug_01`. It has **no palms and no skeleton** — those need another CC0 source
  or a procedural answer, and either is acceptable.
- `docs/CLAIMS_AUDIT.md` §9–§12 — the defect classes this codebase produces.
  Read before assuming a system works because it exists.

Constraints:
- Three.js r0.185 WebGPU + TSL, WebGL2 fallback from the same node graph. No
  compute, no storage textures.
- Every asset CC0 or equivalently free, recorded in `ASSET_LICENSES.md`. Nothing
  from a commercial product. Do not bypass authentication, bot protection,
  paywalls or access controls.
- No per-frame allocation, no synchronous GPU readback, no shader compilation
  during gameplay.
- Every system needs a tier cost policy, a WebGL policy, disposal, and
  deterministic `resetClock(t)`: the visual harness rewinds time, and a system
  carrying integrated state makes every baseline a function of test order.
- `npm run bench` must report PASS for all seven configurations. WebGPU High
  ≤ 16.7 ms GPU p50; WebGL2 Low ≤ 33.3 ms. The island is 1.4 km from the play
  area and must not cost the open-ocean frame anything it does not already cost.
- Committed asset payload is currently ~24 MB. Growing it is acceptable; tripling
  it is not. Decimate through `scripts/optimize-assets.mjs` as the existing
  dressing does.

Acceptance requirements:
- Every item in A is implemented and verified, or blocked with evidence and three
  substantively different attempts recorded. Nothing is filed as a limitation
  because it was not reached.
- Each new or changed system has a test that fails when it is *disconnected*, not
  merely absent.
- **Item 6 is measured, not asserted.** Pick the specific claims — how far the
  scattering term departs from a depth-dependent transmission, what the
  reflection does at grazing angles against Fresnel, whether refraction bends by
  Snell — and produce a number for each before and after. "Looks better" is not
  a result.
- **Item 4 is reproduced before it is fixed.** Build the failing case — a sea
  state and a heading that puts the hull under — and keep it as a test.
- Items 1, 3, 7, 8, 9 and 10 are judged by **looking at rendered frames**, from
  several angles including from the water and from a ship approaching. Capture
  them, inspect them, and iterate on what you see. A metric cannot tell you the
  cliffs are facing the wrong way; a screenshot can, and did.
- Baselines and the README gallery are regenerated and inspected. The gallery
  should gain an island image if the island is worth showing.
</task>

<operating_mode>
Work autonomously through discovery, research, implementation, testing,
adversarial review, repair and final verification.

Do not stop to present a plan or request approval for routine decisions. Maintain
an internal execution ledger and proceed directly.

Ask only when progress genuinely requires unavailable credentials, authorization
for an irreversible external action, or resolution of a material contradiction
that cannot be inferred safely.

Do not silently narrow, reinterpret or expand the requested outcome.
</operating_mode>

<capability_check>
Inspect available tools before starting. Agent Reach is a social-platform access
toolkit and is not useful here — Poly Haven's API and the other asset sources
respond directly. Do not install it for this task.

Codex is available as `codex exec` and is the adversarial reviewer. Its Windows
sandbox is broken on this machine and it will report being unable to read any
file; run it with `--sandbox danger-full-access --skip-git-repo-check`.

Do not claim that research, browser testing or verification occurred unless the
tool actually ran.
</capability_check>

<research>
Research before choosing an approach when the decision materially affects quality
or performance.

For the water especially: this project's longest-lived bugs each survived several
fixes aimed at the wrong layer, and each was found by rendering the suspect
quantity to the framebuffer rather than by reading the shader. Measure first.

Prefer, in order: existing project capability, existing dependency, official
framework capability, mature library, focused component, custom implementation.
Underwater growth and shore surf are both more likely to be procedural systems in
the shape of `Fish`/`Birds` than they are to be asset fetches — but check.
</research>

<implementation>
Implement the complete outcome, not a prototype. Follow existing architecture and
comment conventions — comments explain *why* and name the failure mode a decision
prevents; they never restate the code.

Use subagents for sizeable independent work, and never let two edit the same
file. Wiring into `src/main.ts` stays with one owner.

Do not leave stubs, dead settings or knowingly broken paths. Do not weaken a test
to make an implementation pass.
</implementation>

<verification>
Use observable evidence. Run `npm run typecheck`, both Playwright projects, and
`npm run bench` after the final change. Regenerate the visual baselines and the
README gallery and **look at the images** — a passing metric against a
self-approved baseline proves only that nothing moved.

A successful build is not proof the workflow works.
</verification>

<adversarial_review>
After implementation, run **Codex** as the adversarial reviewer, supplying the
diff, the regenerated frames, the specific claims made, and the benchmark
artifact. Ask it to disprove completion.

Every previous round found real defects in the round before it, including in
fixes made in response to its own findings, and including several defects that
were in the *tests* rather than the code. Budget for at least one repair cycle
after it reports, and re-run it after repairing.

A finding is confirmed only when supported by code evidence, a reproducible
scenario, a failing check or a clearly violated requirement. Do not change
working code on speculation.
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
Complete only when every item in A is implemented and verified or blocked with
evidence, the gates pass, the affected workflow was exercised after the final
change, no known critical or major defect remains, and the final diff contains no
unrelated changes.

Record honest remaining limitations. Do not file unfinished work as a limitation.
</completion_conditions>

<final_response>
Concise and evidence-based: result, what was implemented, important decisions,
verification performed with results, remaining limitations. No chronological
narration.
</final_response>
