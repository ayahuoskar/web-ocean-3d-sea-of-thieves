# Independent review of the waterline band-limit

`codex exec` (codex-cli 0.146.0, default model, read-only sandbox), 2026-08-05,
against the working tree at the first draft of the change. It was pointed at the
spec and the diff and asked to attack four specific claims rather than to look
around, because a general "review this" invites agreement.

Every finding below was **verified independently before being accepted** — the
arithmetic is reproduced in this document. Three of the four were right and
changed the code. None were taken on trust.

---

## 1. The square grid was not applied to production — CORRECT, now fixed

`squareGrid` existed and was tested, and `QualityManager` still carried the old
sliver pairs, so the runtime got none of it. The spec read as though it were
done.

Fair, and it was a sequencing artefact rather than a defect: applying the tier
table was a later task in the plan and the review caught the tree mid-flight. It
would have been a real defect if the change had shipped in that state, which is
exactly the sort of thing an outside reader is good for.

**Fixed** in `45cac02`: all five tiers re-proportioned, plus a test that derives
the pairs from `squareGrid` so the table cannot drift from the rule that produced
it.

## 2. "Retains exactly four vertices per wavelength" — CORRECT, the reasoning was wrong

The original comment claimed a box average of width `f` "suppresses wavelengths
below `2f`". Codex's counter: a box has amplitude response `sinc(pi*f/lambda)`,
which at `lambda = 2f` is `2/pi ~= 0.637`, not zero.

Verified directly:

```
H(f=1, lambda=2) = 0.6366        <- Codex's figure, confirmed
first null of a width-f box is at lambda = f, where H = 3.9e-17
```

So the justification put the cutoff at twice the wavelength where it actually
sits, and would have justified any factor at all. Codex also noted the test that
shipped with it was worthless — it rearranged the same asserted equation, so it
could only ever agree with itself. Both true.

**The constant survives; the reason for it did not.** Working out where the null
really falls produces a *better* argument than the one it replaces: a footprint
of two vertex spacings puts the box's first null exactly on `2s`, which is the
mesh's Nyquist wavelength — the one wavelength that must not survive. Measured:

```
lambda = 2s (Nyquist)      0.000    nulled exactly
worst sidelobe below 2s    0.217    at lambda = 1.40s
lambda = 4s                0.637
lambda = 8s                0.900
```

**Fixed** in `45cac02`: `SAMPLES_PER_WAVELENGTH` renamed to `FOOTPRINT_SPACINGS`
(it was never a sample count), the derivation rewritten, and the useless test
replaced with assertions on the actual sinc response — which a wrong factor
cannot pass.

Codex's secondary points here are also right and are recorded rather than acted
on: a fractional LOD blends two mip levels so the filter is not literally one
box, mips are stored half-float, and WebGL2 delegates mip generation to
`gl.generateMipmap`. All true; none change the choice of constant, and the spec
no longer claims a single exact box.

## 3. Deleting the distance fade — CORRECT, and this was the serious one

The claim was that a cascade extinguishes itself, because once the level runs
past the last mip the sampler clamps to the 1x1 level, which is the mean of a
zero-mean field. Codex agreed the field is genuinely zero-mean — DC amplitude is
set to zero in `Spectrum.ts`, horizontal displacement is derived linearly from
it, and the packing adds no offset — and then pointed out that this happens
*much further out* than the reasoning assumed.

Verified:

| cascade | reaches its 1x1 mip at | old fade ended at |
|---|---|---|
| ripple | 213 m | 55 m |
| chop | 1708 m | 300 m |
| swell | 6830 m | 2600 m |

And the residual in between is not negligible:

```
ripple at  55 m: footprint 4.12 m, response at its 6 m wave =  0.385
ripple at 100 m: footprint 7.50 m, response at its 6 m wave = -0.180
```

38% at 55 m, and sign-inverted past the null. So every cascade was contributing
displacement across a wide band where it previously contributed exactly zero, on
a mesh with no hope of resolving it. **The old table's far end was load-bearing
and deleting it was a regression.**

**Fixed** in `45cac02` by re-deriving the term rather than restoring the table.
`cascadeReach` cuts each cascade over the interval where the footprint crosses
its own longest wavelength — from where the band's best-surviving component is
at 64% to where it is exactly nulled, past which everything left is sidelobe.

It lands where the hand-tuned table was, which is the corroboration:

| cascade | derived fade | old tuned ramp |
|---|---|---|
| ripple | 40 - 80 m | 18 - 55 m |
| chop | 160 - 320 m | 110 - 300 m |
| swell | never inside the mesh | 900 - 2600 m |

## 4. The ±10% search window — CORRECT, and the cost claim was loose

Codex gave a counterexample to the claim that the window contains the optimum:
`budget = 50`, `L = 10`. Verified exactly as stated —

```
seed 8.92, window searches R = 8..10, best in window: R=10 S=5 worst=1.7183
true optimum over the full feasible range: R=11 S=4 worst=1.5708
```

— so the window returns a pair 9% worse. It happens not to bind for the five
budgets this project uses, but a contract that holds by luck is not a contract.
**Fixed** in `45cac02`: the feasible range is bounded by `S >= 3` and is small
enough to search exhaustively, so it does, and the unprovable claim is gone.

Codex was also right that `R*S` is not the mesh's true size — the grid builds
`(R+1)*S + 1` vertices and `S*(2R+1)` triangles — so "identical vertex and
triangle count" was wrong. Verified; the squared pairs are slightly **cheaper**:

| tier | vertices | triangles |
|---|---|---|
| low | 24769 -> 24634 (99.5%) | 49344 -> 49147 (99.6%) |
| medium | 55585 -> 55312 (99.5%) | 110880 -> 110443 (99.6%) |
| high | 129473 -> 129251 (99.8%) | 258496 -> 258225 (99.9%) |
| ultra | 221761 -> 221041 (99.7%) | 442944 -> 441720 (99.7%) |
| max | 393985 -> 393459 (99.9%) | 787200 -> 786435 (99.9%) |

Wording corrected in the spec, the plan and `QualityManager`'s own comment, and
the test now asserts `<=` on the true counts rather than on the surrogate.

## 5. Three.js node semantics — NO FINDING, and worth recording as cleared

All four sub-questions came back clean, with citations:

- **Rebinding survives the clones.** `.sample()` and `.level()` each clone and
  set `referenceNode` to the base, and the clone's `value` getter resolves
  through it — so `setCascades`' writes reach the sampled node.
- **Explicit LOD is legal in a vertex shader on both backends.** WebGPU emits
  `textureSampleLevel`, WebGL2 emits `textureLod`.
- **The `Node<int>` JSDoc on `.level()` is wrong, not the call.** `TextureNode`
  builds the level as `float`, and float is required for trilinear interpolation
  anyway.

This was the risk the plan flagged as most likely to block the change, and it
was the one thing that turned out to be fine.

---

## What this says about the process

Three of four findings were real and two were substantive: one restored a term
whose removal was a genuine regression across the whole mid-field, and one
replaced a signal-processing argument that was simply false. Neither would have
been caught by the test suite, because in both cases the tests asserted the same
wrong thing the code did.

The pattern worth carrying forward: **a test that restates the implementation's
own algebra proves nothing.** Both bad tests here had that shape. The
replacements assert against an independent model — the sinc response — which is
why they can fail.
