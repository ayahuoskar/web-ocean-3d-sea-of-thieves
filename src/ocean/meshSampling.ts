/**
 * What the ocean mesh can and cannot resolve.
 *
 * Kept apart from `OceanMesh` and from `OceanMaterial` because three consumers
 * have to agree on it exactly — the grid that is built, the quality tiers that
 * size it, and the vertex stage that decides how much of the wave field to
 * displace by — and because it is pure arithmetic that deserves to be tested
 * without standing up a GPU to do it.
 *
 * The whole module rests on one number. A displaced grid stops reading as a
 * surface and starts reading as facets when it carries fewer than about four
 * vertices per wavelength: at two it is at Nyquist and every triangle lands on
 * a different phase, which is what spikes isolated vertices into pyramids. Four
 * is the point where a crest is a curve rather than a corner.
 */
export const SAMPLES_PER_WAVELENGTH = 4;

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
 * That closed form is a *seed*, not the answer, and the difference is not
 * academic. It solves `L/R = 2*pi/S`, which is the first-order approximation to
 * the radial spacing; the true `exp(L/R) - 1` is about 1% larger at these ring
 * counts, so the radial axis is slightly worse than the closed form believes and
 * the optimum sits at a few more rings than it returns. Rounding the seed and
 * deriving segments from it lands 0.7% off the best pair and — because the error
 * is on the axis that governs — leaves the two axes a full percent apart, which
 * is exactly the state this function exists to remove.
 *
 * So the seed is searched around instead, over a range wide enough to contain
 * the optimum and narrow enough to be free. `floor` on the segment count is what
 * guarantees the budget is never exceeded.
 */
export function squareGrid(
  vertexBudget: number,
  innerRadius: number,
  outerRadius: number,
): { radialSegments: number; angularSegments: number } {
  const l = Math.log(outerRadius / innerRadius);
  const seed = Math.sqrt((vertexBudget * l) / (Math.PI * 2));

  let radialSegments = Math.max(2, Math.round(seed));
  let angularSegments = Math.max(3, Math.floor(vertexBudget / radialSegments));
  let best = Infinity;

  for (let r = Math.max(2, Math.round(seed * 0.9)); r <= Math.round(seed * 1.1); r++) {
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
 * The shortest wavelength the mesh can carry at this distance, metres.
 */
export function resolvedWavelength(
  distanceMetres: number,
  spacingPerMetre: number,
): number {
  return SAMPLES_PER_WAVELENGTH * distanceMetres * spacingPerMetre;
}

/**
 * The mip level to displace geometry from, for a field of this texel size.
 *
 * A mip of level L is an average over `2^L` texels, so its footprint is
 * `2^L * texelMetres` metres; a box average of width `f` suppresses wavelengths
 * below `2f`. Wanting everything under `SAMPLES_PER_WAVELENGTH * spacing` gone
 * therefore means a footprint of half that, and the level follows by logarithm.
 *
 * Clamped at zero rather than allowed to go negative. Near the camera the
 * spacing is millimetres and the field is already over-sampled; there is no
 * sharper level than the one that exists, and asking for one is a request the
 * sampler would have to invent an answer to.
 *
 * **This function is the specification and the vertex stage is a copy of it.**
 * `OceanMaterial`'s displacement loop computes the same three lines in TSL,
 * because a node graph cannot be evaluated in a unit test and this can. They
 * share the one constant that carries physical meaning; if the shapes ever
 * diverge, this one is right.
 */
export function geometryLod(
  distanceMetres: number,
  spacingPerMetre: number,
  texelMetres: number,
): number {
  const footprint = (SAMPLES_PER_WAVELENGTH / 2) * distanceMetres * spacingPerMetre;
  return Math.max(0, Math.log2(Math.max(footprint / texelMetres, 1)));
}
