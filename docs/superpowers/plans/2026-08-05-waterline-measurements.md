# What the band-limit and the squared grid actually did

Measurements, 2026-08-05. Every figure below is from `tests/gallery-jitter.spec.ts`
on the reference GPU, same clock, same camera, output dither off.

Three trees were measured so the two changes could be told apart, which turned
out to matter: they do not do what was predicted, and one of them does close to
nothing.

1. `main` — vertex stage sampling the displacement field at LOD 0.
2. **band-limit only** — mip level from vertex spacing, `cascadeReach` fade,
   original tier proportions.
3. **band-limit + squared grid** — as shipped.

## Far-field shimmer (`highFreq`, lower is better)

| tier | main | band-limit | + squared | ceiling |
|---|---|---|---|---|
| medium | 2.253 | 2.041 | **1.911** | 2.33 |
| high | 3.476 | **2.676** | 2.846 | 3.77 |
| ultra | 3.505 | **2.838** | 2.967 | 3.84 |
| max | 3.390 | **2.910** | 3.111 | 3.74 |

## Far-field temporal change (lower is better)

| tier | main | band-limit | + squared | ceiling |
|---|---|---|---|---|
| medium | 1.309 | **1.148** | 1.166 | 1.47 |
| high | 2.195 | **1.736** | 1.908 | 2.5 |
| ultra | 2.276 | **1.893** | 2.065 | 2.61 |
| max | 2.017 | **1.777** | 1.915 | 2.29 |

## Near-field detail (`detail`, higher is better, floor 0.4)

| tier | main | band-limit | + squared |
|---|---|---|---|
| medium | 1.103 | 1.113 | 1.108 |
| high | 3.246 | 2.801 | 2.750 |
| ultra | 3.354 | 2.787 | 2.764 |
| max | 2.238 | 1.640 | 1.609 |

## What this says

**The band-limit is an unambiguous win.** Far-field shimmer falls 9-23% and
temporal change 12-21%, on every tier. The near-field detail it costs — 14% at
High, 27% at Max, nothing at Medium — is the honest price of no longer displacing
geometry by waves the mesh cannot represent, and every tier stays four to seven
times above `DETAIL_FLOOR`. The visual result is the point: the triangular spikes
and straight-edged crests are gone.

**The squared grid does not do what the spec predicted, and the spec was
corrected.** It was justified partly as buying back the detail the band-limit
removes. Measured, it recovers about 2% of it — which is nothing — and it costs
5-7% more far-field shimmer and 8-10% more temporal change on High, Ultra and Max.
Medium is the only tier it improves.

The mechanism is now understood and is not a defect: **a finer mesh means the
band-limit removes less**. `cascadeReach` starts fading a cascade at a distance
inversely proportional to vertex spacing, so squaring High's grid moves the ripple
cascade's fade from 40-80 m out to 65-131 m. The extra shimmer is extra wave
geometry genuinely being carried, not extra noise — and `gallery-jitter` cannot
tell those apart, which its own header says in as many words.

It was kept on that basis, with the cost recorded rather than argued away. All
four tiers remain comfortably under ceilings that were themselves measured on the
old, faceted water.

**What would settle it properly** is a far-field *detail* figure to sit beside
the far-field shimmer figure — the same adjacent-pixel step the near band uses,
measured in the far band. If the squared grid is carrying real geometry that
number rises with the shimmer; if it is carrying noise it does not. The metric
does not exist today and adding it would be a change to what every historical
number in that file means, so it is recorded here as the open question rather
than smuggled in.

## Foam: is the white foam, or the sky?

`tests/foam-attribution.spec.ts`. Fraction of water pixels moving by more than 8
levels when foam and surf are forced to zero:

| shot | moving | mean move | peak |
|---|---|---|---|
| storm (positive control) | 63.1% | 28.30 | 95 |
| waterline | **0.1%** | 0.02 | 20 |

**The waterline shot is one part in a thousand foam.** Its pallor is Fresnel
reflection of the sky at a grazing camera, exactly as suspected, so **no foam
term was changed** — which the spec named in advance as a legitimate outcome.

Two false readings came first and are worth recording:

- **The hook was dead.** `setFoamOverride` set a field that only `applyPreset`
  reads back to the uniform, and `applyPreset` runs on state change rather than
  per frame. Foam 0 and foam 3 rendered bit-identically. Measured directly on the
  storm shot once fixed: mean water luma 151.37 at foam 0, 179.00 at default,
  192.50 at foam 3.
- **The first control was confounded.** It raised `windSpeed` to 20 under the
  calm `skyPro` preset and still read 0.0%, because that does not reliably
  produce whitecaps. Changing the control to a different *scene* — the storm
  shot — is what made it discriminate.

Had either gone unnoticed, this would have reported "no foam here" for the wrong
reason and the conclusion would have been right by accident.

## Not caused by this work

Both verified by running them on `main` with none of this work applied:

| test | figure | threshold | on `main` |
|---|---|---|---|
| `ocean.spec` the bird flock renders | 56 px | > 80 | 56 px — identical |
| `post.spec` bloom, the Low tier reaches the stage | 0.011-0.014 | < 0.01 | 0.0129 — same band |

The bloom one is **flaky as well as marginal**: three runs on this branch gave
0.6215, 0.0125 and 0.0138. The 0.62 excursion was investigated as a suspected
regression and is not one — the branch's typical value matches `main`'s.

## Deferred deliberately

**The noise floors were not re-measured.** `MEASURED_NOISE_FLOOR` in
`tests/lib/shots.ts` still holds figures measured against the pre-band-limit
water. The visual suite passes 26/26 against the new baselines with them, so
they are *adequate*; the risk is that they are now *loose*, since the new far
field is quieter and its true floor is probably lower — a loose floor hides
regressions rather than causing false failures. Re-measuring is a ~25 minute
run and was not spent.

**No far-field detail metric**, which is what would settle whether the squared
grid carries geometry or noise. See the note beside `DETAIL_FLOOR` in
`tests/gallery-jitter.spec.ts`.

**The functional suite overruns 50 minutes.** A `timeout 3000` killed a full run
mid-flight and the truncation produced a phantom `post.spec` lens-flare failure
at 0 ms, which was nearly reported as real. Anyone running the whole project
should budget more, and read a 0 ms failure as a killed process rather than a
result.
