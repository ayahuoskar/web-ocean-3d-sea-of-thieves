/**
 * What the ocean mesh can and cannot resolve.
 *
 * Kept apart from `OceanMesh` and from `OceanMaterial` because three consumers
 * have to agree on it exactly — the grid that is built, the quality tiers that
 * size it, and the vertex stage that decides how much of the wave field to
 * displace by — and because it is pure arithmetic that deserves to be tested
 * without standing up a GPU to do it.
 *
 * The whole module rests on one number: how wide, in vertex spacings, to make
 * the low-pass filter applied to the wave field before geometry is displaced by
 * it.
 *
 * Two, and the reason is the mesh's Nyquist wavelength.
 *
 * A grid of spacing `s` cannot represent anything shorter than `2s`; content
 * below that does not merely lose detail, it aliases, landing each triangle on
 * an unrelated phase and spiking isolated vertices into pyramids. A box average
 * of width `f` has amplitude response `sinc(pi*f/lambda)`, whose **first null is
 * at `lambda = f`** — so a footprint of exactly `2s` puts the filter's null
 * exactly on the wavelength the mesh cannot represent.
 *
 * The consequences, all of them measured rather than asserted:
 *
 *   lambda = 2s (Nyquist)     0.000   nulled exactly
 *   worst sidelobe below 2s   0.217   at lambda = 1.40s
 *   lambda = 4s               0.637
 *   lambda = 8s               0.900
 *
 * So this is not a brick wall and must not be described as one. It is a filter
 * that nulls the aliasing wavelength, holds everything else the mesh cannot
 * carry under 22%, and passes most of what it can. An earlier version of this
 * comment claimed a box of width `f` "suppresses wavelengths below `2f`", which
 * put the cutoff at twice the wavelength where it really sits and would have
 * justified any factor at all.
 *
 * **The table above is the one-dimensional ideal, and the GPU's filter is
 * neither.** Two further caveats, both from an independent review, and both
 * reasons to read `2` as very well motivated rather than as exact:
 *
 * - A mip is a *separable 2D* kernel, so the null lands on the Nyquist
 *   wavelength only for waves running along a texture axis. A wave crossing at
 *   45 degrees presents `sqrt(2)` times its wavelength to each axis, and at
 *   Nyquist retains `sinc(pi/sqrt(2))^2` — about **12.8%**, not zero.
 * - A fractional level blends two mip levels, so the effective kernel is a mix
 *   of two box widths rather than one.
 *
 * Neither changes the choice. 12.8% of an unresolvable wave is a long way from
 * the 100% the vertex stage was passing before any of this, and no other
 * footprint has a better claim. What they change is that "annihilates Nyquist
 * exactly" is a statement about the model in this file, not about the shader.
 */
export const FOOTPRINT_SPACINGS = 2;

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
 * Radial spacing is `exp(L/R) - 1` for `L = ln(outer/inner)` and angular is
 * `2*pi/S`. Both are monotone in opposite directions as rings are traded for
 * segments, so the max of the two is smallest near where they meet, and
 * `S = 2*pi*R/L` with `R*S = budget` gives `R = sqrt(budget * L / 2*pi)`.
 *
 * That closed form is a *seed at best*, and it was originally used as the
 * answer. It solves `L/R = 2*pi/S`, which is only the first-order approximation
 * to the radial spacing; the true `exp(L/R) - 1` is about 1% larger at these
 * ring counts, so the radial axis is worse than the closed form believes and the
 * optimum sits a few rings further along. Its answer lands 0.7% off the best
 * pair and leaves the two axes a full percent apart — which is exactly the state
 * this function exists to remove.
 *
 * A window around the seed was tried next and is also wrong. There is no bound
 * tying the discrete optimum to any fixed fraction of it: at `budget = 50` and
 * `L = 10` the seed is 8.9 and the optimum is `R = 11`, outside a ±10% window,
 * which returns `R = 10` at a 9% worse spacing. That the five budgets this
 * project actually uses happen to fall inside such a window is luck, not a
 * property, and a function whose contract holds by luck is one that breaks the
 * day a tier is retuned.
 *
 * So the feasible range is searched exhaustively. It is bounded — `S >= 3` caps
 * `R` at `budget/3` — and this runs at most once per quality tier per session,
 * so the few hundred thousand comparisons at the largest tier are not worth
 * trading for a bound that needs a proof.
 *
 * Degenerate budgets are rejected rather than silently mis-served: below 6 there
 * is no pair satisfying `R >= 2, S >= 3` at all, and a non-finite budget would
 * make the loop bound non-finite too. Both would otherwise return the initial
 * `2 x 3` — which exceeds the budget it was given, quietly.
 *
 * `floor` on the segment count is what keeps `R*S` inside the budget. Note that
 * `R*S` is a *surrogate* for cost rather than the mesh's true size: the grid
 * builds `(R+1)*S + 1` vertices and `S*(2R+1)` triangles. Holding the surrogate
 * fixed while trading segments for rings lowers both, by 0.1% to 0.5% across the
 * tiers — so the squared pairs are marginally cheaper than the ones they
 * replace, not equal to them.
 */
export function squareGrid(
  vertexBudget: number,
  innerRadius: number,
  outerRadius: number,
): { radialSegments: number; angularSegments: number } {
  if (!Number.isFinite(vertexBudget) || vertexBudget < 6) {
    throw new RangeError(
      `squareGrid needs a finite vertex budget of at least 6, got ${vertexBudget}`,
    );
  }
  const l = Math.log(outerRadius / innerRadius);

  let radialSegments = 2;
  let angularSegments = 3;
  let best = Infinity;

  for (let r = 2; r <= Math.floor(vertexBudget / 3); r++) {
    const s = Math.floor(vertexBudget / r);
    if (s < 3) continue;
    const worst = Math.max(Math.exp(l / r) - 1, (Math.PI * 2) / s);
    if (worst < best) {
      best = worst;
      radialSegments = r;
      angularSegments = s;
    }
  }

  return { radialSegments, angularSegments };
}

/**
 * Width of the low-pass footprint at this distance, metres.
 *
 * Also, by `FOOTPRINT_SPACINGS = 2`, the wavelength the filter nulls — which is
 * the mesh's own Nyquist wavelength at that distance. Waves at twice this
 * survive at 64%.
 */
export function filterFootprint(
  distanceMetres: number,
  spacingPerMetre: number,
): number {
  return FOOTPRINT_SPACINGS * distanceMetres * spacingPerMetre;
}

/**
 * Amplitude response of the footprint at a given wavelength, for tests and for
 * anyone re-deriving the constants.
 *
 * `sinc(pi*f/lambda)`, the transform of a box of width `f`. Signed: the
 * sidelobes past the first null are inversions, which is why a cascade left
 * running past its band edge does not merely fade, it comes back wrong.
 */
export function boxResponse(footprintMetres: number, wavelengthMetres: number): number {
  const x = (Math.PI * footprintMetres) / wavelengthMetres;
  return x === 0 ? 1 : Math.sin(x) / x;
}

/**
 * The mip level to displace geometry from, for a field of this texel size.
 *
 * A mip of level L averages `2^L` texels, so its footprint is
 * `2^L * texelMetres`; solving that for the footprint this distance wants gives
 * the level by logarithm.
 *
 * Clamped at zero rather than allowed to go negative. Near the camera the
 * spacing is millimetres and the field is already over-sampled; there is no
 * sharper level than the one that exists, and asking for one is a request the
 * sampler would have to invent an answer to.
 *
 * **This function is the specification and the vertex stage is a copy of it.**
 * `OceanMaterial`'s displacement loop computes the same lines in TSL, because a
 * node graph cannot be evaluated in a unit test and this can. They share the one
 * constant that carries physical meaning; if the shapes ever diverge, this one
 * is right.
 */
export function geometryLod(
  distanceMetres: number,
  spacingPerMetre: number,
  texelMetres: number,
): number {
  const footprint = filterFootprint(distanceMetres, spacingPerMetre);
  return Math.max(0, Math.log2(Math.max(footprint / texelMetres, 1)));
}

/**
 * How much of a cascade still reaches the geometry, 0..1.
 *
 * **This is the term whose absence an outside review caught, and the reasoning
 * that omitted it is worth recording because it was so nearly right.**
 *
 * The argument for deleting the old fixed-metre fade table was that a cascade
 * puts itself out: run the level far enough and the sampler clamps to the 1x1
 * mip, which is the mean of a field whose DC amplitude `Spectrum` sets to zero.
 * All of that is true. What it misses is *where* that happens. The 1x1 level of
 * the ripple cascade is reached at 213 m, not at the ~40 m where its longest
 * wave stops being resolvable — so between those two distances the cascade goes
 * on contributing, and what it contributes is sidelobe: 38% of that wave at
 * 55 m, and -18% at 100 m, sign-inverted, on a mesh that cannot resolve it.
 * The old table ended at 55 m for a reason.
 *
 * Those figures were measured when the ripple cascade topped out at 6 m; its
 * band now ends at 3 m, so the crossover sits nearer than they say. They are
 * left as they were measured rather than rewritten to numbers nobody has
 * checked — the derivation below reads `maxWavelength` from the cascade config,
 * so the *behaviour* tracked the change even though this paragraph did not.
 *
 * So the fade comes back, derived rather than tuned — though **the derivation
 * below is the second one written here**, because a review pointed out that the
 * first did not hold.
 *
 * The interval is best read in samples per wavelength rather than in filter
 * response, and then it is the same criterion `FOOTPRINT_SPACINGS` uses. Since
 * the footprint is `2s` by construction, `footprint = 0.5 * maxWavelength` means
 * the band's longest wave spans **four vertex spacings**, and
 * `footprint = maxWavelength` means it spans **two** — Nyquist. So the cascade
 * fades out exactly as its best-resolved component walks from the point where a
 * crest is still a curve to the point where the mesh cannot represent it at all.
 *
 * What the first version claimed instead was that this interval is where the
 * band's longest wave goes from 64% response to nulled, and that cutting there
 * is "the boundary the physics draws". The first half is arithmetically true and
 * the second does not follow: the mip is already attenuating that wave, so
 * multiplying by this ramp attenuates it twice — at three quarters of the way
 * along, an ideal box leaves 30% and this ramp takes it to 15%. That is
 * deliberate, because a cascade whose best content is below four samples per
 * wavelength should be leaving, but it is a choice about where to stop trusting
 * a band and not a boundary handed down by the filter.
 *
 * It lands close to the table it replaces — for High as previously proportioned,
 * ripple 40-80 m against a tuned 18-55, chop 160-320 against 110-300 — while
 * being a function of the mesh density the table could not see.
 */
export function cascadeReach(
  footprintMetres: number,
  maxWavelengthMetres: number,
): number {
  const t = footprintMetres / maxWavelengthMetres;
  const u = Math.min(1, Math.max(0, (t - 0.5) / 0.5));
  return 1 - u * u * (3 - 2 * u);
}
