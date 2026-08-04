# Fidelity gap closure — task prompt and execution ledger

Written from `task-based-prompt-template.md` against
`docs/superpowers/specs/2026-08-05-fidelity-gap-analysis.md`.

---

## Task

**Outcome.** Close every ranked gap in the fidelity analysis so the scene reads
at modern AAA quality, while staying inside the measured performance gates:
WebGPU/High GPU p50 < 16.7 ms and WebGL2/Low GPU p50 < 33.3 ms at 1600x900 DPR 1.

**Repository.** `D:\Github\web-ocean-3d` — TypeScript, Three.js r185 WebGPU/TSL,
Vite, Playwright.

**References.**

- `docs/superpowers/specs/2026-08-05-fidelity-gap-analysis.md` — the ranked gaps.
- `research/shadertoy/` — thirteen reference shaders, gitignored. **Technique
  only; no source may be copied.** CC BY-NC-SA at best, All Rights Reserved for
  `DdKyR1`.
- `docs/images/*.png` — our own gallery, the frames the gaps were read off.
- Published literature: iq's terrain/fbm/AO articles, Frostbite and Horizon Zero
  Dawn volumetric cloud course notes, Hosek–Wilkie 2012, Bruneton 2008.

**Constraints.**

- No new runtime dependencies. `three` is the only one and stays that way.
- The CPU and TSL heightfields must stay bit-comparable: buoyancy, prop
  placement, camera collision and the water's depth term all read the CPU twin
  of what the mesh is displaced by.
- Frame-exact determinism is the testing contract. Every animated quantity stays
  a closed form of a resettable clock — **no TAA**, no history buffers.
- Every added cost must be tier-gated through `QualitySettings` so Low stays on
  its WebGL2 floor.
- Licensing: reproduce behaviour from published technique, cite the reasoning in
  the module header, never transcribe reference source.

**Acceptance requirements.**

| # | Gap | Observable acceptance criterion |
|---|---|---|
| 1 | Terrain has no relief | No mesh facets legible in `surf.png`; slope detail present on the hillside at 1 km in `waves.png` |
| 2 | Nothing on land shadowed | `surf.png` shows a lit face and a shaded face on the hill; the ship and palms cast onto sand |
| 3 | Surface aliasing | `clear-day.png` mid-field has no hard-edged white blobs; foam boundaries carry a gradient |
| 4 | Cloud slab does not curve | Cloud field converges to the horizon in `clear-day.png` with no abrupt terminating band |
| 5 | No aerial perspective on land | `waves.png` island is separated from the sky by haze; hue shifts toward the sky, not toward grey |
| 6 | Underwater over-fogged | `reef.png` shows local contrast on the near sand and visible caustics |
| 7 | No contact AO on small objects | Corals in `reef.png` darken at their base |
| 8 | Cloud lighting flat | Cumulus in `clear-day.png` read as volumes: dark bases, bright tops, dense and clear regions |
| 9 | No god rays above water | Crepuscular shafts visible under a broken deck |
| 10 | Refracted seafloor bleeds | No khaki band across the mid-distance water in `waves.png` |
| 11 | Near vegetation static | Instanced trees sway; canopy carries per-instance colour variation |
| 12 | Cloud shadow only on water | Cloud shade crosses the beach and the hillside |
| 13 | Overcast monochrome | `storm.png` water keeps green-grey chroma |
| 14 | Lens rain does not blur | Backdrop soft outside drops, sharp micro-image inside them |
| 15 | Preetham fought | Horizon gradient step gone from `waves.png` |
| 16 | IBL sky-only | Env capture includes the cloud deck |
| 17 | Waves do not shoal | Swell refracts toward depth-parallel at the shore |

Plus, throughout: `npm run typecheck` clean, `npx playwright test` green,
`npm run bench` PASS on both gates.

---

## Sequencing

Follows §10 of the analysis. One commit per checkpoint; baselines regenerated
once per phase, not once per commit.

- **Phase A — the land reads as land** (gaps 1, 2, 12)
- **Phase B — the air reads as air** (gaps 4, 5, 8, 9, 13, 16)
- **Phase C — the surface holds up** (gaps 3, 10)
- **Phase D — the detail** (gaps 6, 7, 11, 14)
- **Phase E — the hard ones** (gaps 15, 17)

## Capability check (run 2026-08-05)

| Capability | Status |
|---|---|
| `npm run typecheck` | works, clean at HEAD |
| `npx playwright test --project=visual` | works; real D3D12 adapter on this machine |
| `npm run bench` | works; reference run at High is 3.09 ms against a 16.7 ms gate |
| `scripts/capture-shadertoy.mjs` | present, drives plain Chrome over CDP |
| Playwright MCP | not installed; the repo's own Playwright harness is the equivalent and is what the acceptance criteria are written against |
| Agent Reach | not installed |

**Headroom is the governing fact.** High costs 3.09 ms of a 16.7 ms budget, so
there is 13.6 ms to spend. The gaps are worth spending it on; the tier gates are
what keep Low honest.
