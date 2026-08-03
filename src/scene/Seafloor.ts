import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  mix,
  normalMap,
  normalize,
  positionWorld,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
// Aliased because this module needs a CPU twin of the same ramp under the
// unqualified name; see `smoothstepDown` below.
import { smoothstepDown as smoothstepDownNode } from '../core/tslMath';
import { SEEDS, mulberry32 } from '../core/random';

/**
 * Sandy seafloor.
 *
 * The heightfield is the one piece of geometry in this project that must exist
 * simultaneously on the CPU and the GPU: buoyancy and camera collision query it
 * per frame, the water surface reads it to decide how much of the shallow
 * turquoise to let through, and the floor mesh itself is displaced by it. If
 * those three disagree, the ship's shadow lands on water that is a different
 * colour from the sand underneath it.
 *
 * So the noise is deliberately *not* an analytic hash. `sin(dot(p, k)) * 43758`
 * hashes are chaotic by construction: a float32 GPU and a float64 CPU evaluate
 * them to completely different values, and the two representations of the floor
 * drift apart. Instead a single 256² byte texture of random values is generated
 * once and sampled with hand-written bilinear interpolation on both sides.
 * Unsigned-byte texels decode to exactly `n / 255` on every backend, so the two
 * evaluations agree to float32 rounding.
 *
 * Layout the field produces:
 *   - a shallow plateau (~17 m) around the origin, where the play area sits and
 *     the seafloor is meant to read through the water;
 *   - a shelf break falling to ~88 m in open water;
 *   - a second rise around the island, which breaks the surface.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;

// ---------------------------------------------------------------- noise source

const NOISE_SIZE = 256;
const NOISE_MASK = NOISE_SIZE - 1;

const NOISE_BYTES = (() => {
  // Deterministic PRNG — the floor must be identical on every run and machine.
  const random = mulberry32(SEEDS.seafloorNoise);
  const bytes = new Uint8Array(NOISE_SIZE * NOISE_SIZE * 4);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (random() * 256) | 0;
  return bytes;
})();

function createNoiseTexture(): THREE.DataTexture {
  const map = new THREE.DataTexture(
    NOISE_BYTES,
    NOISE_SIZE,
    NOISE_SIZE,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  // Nearest + repeat means uv = (i + 0.5) / N lands exactly on texel i for any
  // integer i, positive or negative — which is what makes the hand-rolled
  // bilinear filter below reproducible against the CPU path.
  map.minFilter = THREE.NearestFilter;
  map.magFilter = THREE.NearestFilter;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.generateMipmaps = false;
  map.colorSpace = THREE.NoColorSpace;
  map.needsUpdate = true;
  return map;
}

function noiseTexel(ix: number, iy: number): number {
  const x = ix & NOISE_MASK;
  const y = iy & NOISE_MASK;
  return NOISE_BYTES[(y * NOISE_SIZE + x) * 4] / 255;
}

function valueNoise(px: number, py: number): number {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const fx = px - ix;
  const fy = py - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);

  const a = noiseTexel(ix, iy);
  const b = noiseTexel(ix + 1, iy);
  const c = noiseTexel(ix, iy + 1);
  const d = noiseTexel(ix + 1, iy + 1);

  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}

// FBM parameters. Shared verbatim by the CPU and TSL implementations; the
// rotation between octaves is what stops the sum from looking grid-aligned.
const OCTAVES = 4;
const LACUNARITY = 2.13;
const GAIN = 0.5;
const ROT = [0.8, 0.6, -0.6, 0.8] as const;
const OCTAVE_OFFSET = [17.3, 9.1] as const;
const FBM_NORM = (() => {
  let sum = 0;
  for (let o = 0, a = 1; o < OCTAVES; o++, a *= GAIN) sum += a;
  return sum;
})();

function fbm(x: number, y: number): number {
  let qx = x;
  let qy = y;
  let amplitude = 1;
  let sum = 0;
  for (let o = 0; o < OCTAVES; o++) {
    sum += valueNoise(qx, qy) * amplitude;
    const rx = qx * ROT[0] + qy * ROT[1];
    const ry = qx * ROT[2] + qy * ROT[3];
    qx = rx * LACUNARITY + OCTAVE_OFFSET[0];
    qy = ry * LACUNARITY + OCTAVE_OFFSET[1];
    amplitude *= GAIN;
  }
  return sum / FBM_NORM;
}

// ------------------------------------------------------------- floor structure

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * CPU twin of `tslMath.smoothstepDown`, argument for argument.
 *
 * Every descending ramp in the heightfield now goes through this on the CPU and
 * through the node version on the GPU, so the two implementations can be read
 * against each other as the same three arguments in the same order. The shape
 * this replaced spelled the same ramp two different ways — `smoothstep(outer,
 * inner, x)` on the CPU against `smoothstepDown(x, inner, outer)` in TSL — and a
 * mirrored pair like that is precisely what survives a careless edit to one side
 * while looking correct in review.
 */
function smoothstepDown(x: number, inner: number, outer: number): number {
  return 1 - smoothstep(inner, outer, x);
}

/**
 * Directions on the island are unit vectors, never angles.
 *
 * Every directional term below is a dot product against one of these, which
 * keeps `atan2` out of the heightfield entirely. That matters twice: TSL has
 * moved its spelling of `atan2` across recent revisions, and the branch cut at
 * +/-pi would draw a seam straight across the island on whichever bearing it
 * happened to land. Harmonics of the bearing come back out of the dot product
 * through the Chebyshev identities (cos 2t = 2c^2 - 1, cos 3t = 4c^3 - 3c),
 * which are polynomials, and so agree between a float64 CPU and a float32 GPU
 * to the last rounding — the same reason the noise is a texture and not a hash.
 */
interface Dir {
  readonly x: number;
  readonly z: number;
}

/** A direction plus the angular reach of the feature that sits on it. */
interface Sector extends Dir {
  /** cos of the half-width: the mask is a smoothstep in cosine, not in angle. */
  readonly edge: number;
}

/** Bearing convention matches the scatter code in `Props`: x = cos, z = sin. */
function dir(bearing: number): Dir {
  return { x: Math.cos(bearing), z: Math.sin(bearing) };
}

function sector(bearing: number, halfWidth: number): Sector {
  return { x: Math.cos(bearing), z: Math.sin(bearing), edge: Math.cos(halfWidth) };
}

/** 1 on the sector's bearing, 0 past its half-width. `u` must be a unit bearing. */
function sectorMask(ux: number, uz: number, s: Sector): number {
  return smoothstep(s.edge, 1, ux * s.x + uz * s.z);
}

/** Rocky island the props dress and the distant silhouette comes from. */
export const ISLAND = {
  x: -1150,
  z: -780,
  /**
   * Mean shoreline radius. The coast itself runs from about 0.70x this at the
   * head of the bay to 1.25x at the tip of the headland, so this is the number
   * to scale placement by and not a number to trust as a coastline — ask
   * `seafloorHeight` where the water is.
   */
  radius: 500,
  /**
   * Height of the summit above mean sea level, before props and before relief.
   *
   * 150 m over a 1 km island, and the number is framing rather than geology.
   * At the 72 m it was, the island had a width-to-height ratio of 14:1 — which
   * is honest for a real Pacific island and *unreadable* at the distance anyone
   * sees this one from. Photographed from 900 m off the beach it was a green
   * bank on the horizon sixty pixels tall: no summit, no profile, nothing for
   * the eye to land on. The whole planting scheme was invisible at the range it
   * was authored for.
   *
   * At 150 the profile is about 7:1, the island is a shape against the sky, and
   * — because everything below plants in absolute metres and the summit rock
   * band is a *fraction* of this constant — the extra height arrives as bare
   * rock above the treeline rather than as more hillside. That silhouette
   * (green flanks, pale crown) is what a tropical high island actually reads
   * as, and it is what the reference frame in `docs/ref/` shows.
   */
  peak: 150,
} as const;

/**
 * Where the beach stops and the growth starts, metres above mean sea level.
 *
 * Not a hard line — the ramp between them is a treeline, and the sand mottling
 * runs across it so the boundary is broken rather than a contour. Below
 * `BEACH_TOP_METRES` is bare sand because that is what the swash and the wind
 * keep clear.
 */
const BEACH_TOP_METRES = 3.5;
const VEGETATION_FULL_METRES = 16;

/**
 * How completely the growth covers the ground it reaches.
 *
 * Deliberately short of 1. Even closed canopy shows sand and rock through it
 * from above, and leaving a fraction of the substrate visible is what stops the
 * interior reading as painted felt.
 *
 * This is a weight on *albedo*, though, not a percentage of visible ground, and
 * the two are only the same number when the two albedos are close. They are
 * not: the substrate is four times the canopy's luminance, so at the 0.86 this
 * was, a seventh of the mix carried half the brightness and the vegetated
 * slopes came out khaki rather than green — the substrate was showing through
 * as *value* even where it was invisible as texture. 0.93 with a darker
 * `dryInland` gets the same broken-up read without bleaching the hue.
 */
const VEGETATION_COVER = 0.93;

const DEEP_Y = -88;
const PLATEAU_Y = -17;
const PLATEAU_RADIUS = 320;
const SHELF_RADIUS = 1250;
const RELIEF = 11;
/** World metres per noise cell of the coarsest octave. */
const FEATURE_SCALE = 1 / 240;

/**
 * Island shape.
 *
 * What this replaced was `peak * smoothstep(radius, radius * 0.18, dIsland)`:
 * one radially symmetric dome. That is why the shoreline was a circle, why the
 * cliff props could get away with assuming the shore ran tangent to one, and why
 * sailing around the island showed the same silhouette from every bearing. The
 * replacement is a sum of named terms, each doing one thing a reader can point
 * at. Deliberately not another noise call: noise with enough amplitude to move a
 * coastline this far is indistinguishable from static at this scale, and it
 * leaves nothing to aim a set piece at.
 *
 * Everything vertical is expressed against `t` — distance from the island centre
 * over the shoreline radius *on that bearing*. So `t = 1` is the waterline
 * everywhere by construction, and the bay, the headland and the lobes deform the
 * whole island rather than only its outline.
 */

// Shoreline radius, as a multiple of `ISLAND.radius`. Three harmonics of the
// bearing, each about its own axis, so the outline repeats on no obvious period.
/** cos 2t: the island is an ellipse before it is anything else. */
const ELONGATION = 0.12;
const ELONGATION_AXIS = dir(1.95);
/** cos 3t: three broad lobes, which is what stops it reading as an ellipse. */
const LOBES = 0.075;
const LOBE_AXIS = dir(2.6);
/** cos t: sand accretes on the downwind face, the upwind face is cut back. */
const DRIFT = 0.07;
const DRIFT_AXIS = dir(0.9);
/** Floor under the summed fraction; a term deep enough to invert it sends `t` to infinity. */
const SHORE_FLOOR = 0.35;

/**
 * The bay, cut into the windward shore — `Spectrum` blows toward pi/4 by
 * default, so this is the face that takes the swell.
 *
 * It cuts the shore *radius* rather than the height, which is what makes it a
 * bay a ship can enter instead of a dent in a hillside: the whole vertical
 * profile moves inward with the coast, so the bay gets its own beach at its head
 * and deepens toward its mouth for free.
 */
const BAY = sector(2.3, 0.44);
const BAY_CUT = 0.42;

/**
 * The headland: the opposite move. Radius pushed out, and a ridge raised along
 * the same bearing so the point ends in a bluff instead of tapering away to
 * nothing. It forms the far arm of the cove from the spit; between them they are
 * what encloses the lagoon.
 *
 * The ridge is windowed at both ends in `t`. The toe is not optional: a lift
 * that only faded outward is still at full height at the island centre, where it
 * stacks on the crest and puts the summit twenty-six metres above the value
 * `ISLAND.peak` promises.
 */
const HEADLAND = sector(1.45, 0.42);
const HEADLAND_REACH = 0.2;
const HEADLAND_LIFT = 26;
const HEADLAND_TOE = 0.42;
const HEADLAND_CROWN = 0.7;
const HEADLAND_BROW = 0.9;
const HEADLAND_FALL = 1.06;

/**
 * The apron carries the floor from shelf depth up to the waterline and owns the
 * beach gradient. `SHORE_LIFT` is solved, not tuned: it is exactly the lift that
 * puts sea level at `t = 1`, so widening the apron to soften the beach cannot
 * silently drag the coastline in or out.
 */
const APRON_IN = 0.78;
const APRON_OUT = 1.34;
const SHORE_LIFT = -PLATEAU_Y / smoothstepDown(1, APRON_IN, APRON_OUT);

/**
 * The summit sits inland of the island centre, upwind of it. Without that offset
 * every contour is a scaled copy of the shoreline and the island reads as a
 * shape stamped out of a cone however irregular its outline is.
 *
 * `CREST_SPAN` measures the crest against the *local* shore radius, so the crest
 * has died out before the beach on every bearing including the short one at the
 * head of the bay; a crest measured in metres would push land back into it.
 * `CREST_LIFT` is solved like `SHORE_LIFT`: plateau plus apron plus crest is
 * exactly `ISLAND.peak`, so that constant means what its name says.
 */
const CREST_IN = 0;
const CREST_OUT = 0.94;
const CREST_SPAN = 0.9;
const CREST_LIFT = ISLAND.peak - PLATEAU_Y - SHORE_LIFT;
const SUMMIT_DRIFT = 0.16;
const SUMMIT_OFFSET: Dir = {
  x: Math.cos(3.9) * ISLAND.radius * SUMMIT_DRIFT,
  z: Math.sin(3.9) * ISLAND.radius * SUMMIT_DRIFT,
};

/**
 * How far the island keeps its own shelf before the floor is allowed to fall to
 * `DEEP_Y`. The inner edge is past `t = 1` deliberately: the apron's arithmetic
 * assumes the floor under the beach is exactly `PLATEAU_Y`, and a skirt that had
 * already begun to fall there would pull the waterline in by a few metres, by an
 * amount that varied with bearing.
 */
const SKIRT_IN = 1.06;
const SKIRT_OUT = 1.95;

/**
 * The spit: a recurved bar running out from the shore beside the cove.
 *
 * Two masks off one axis. The wide one lifts the *shelf* under the bar; the
 * narrow one puts the bar on top of it. Without the shelf the bar would be a
 * wall standing off fifty metres of water, because the gap between the island's
 * skirt and the origin plateau is the deepest water anywhere near the island.
 *
 * `SPIT_CURVE` hooks the axis toward the lagoon as it runs — the shape longshore
 * drift actually builds, and the cheapest way to stop a straight extrusion from
 * looking like one.
 */
const SPIT = dir(-0.1);
const SPIT_CURVE = 0.095 / ISLAND.radius;
const SPIT_ROOT = 470;
const SPIT_RISE = 90;
const SPIT_TIP = 980;
const SPIT_TAPER = 260;
const SPIT_CORE = 22;
const SPIT_EDGE = 62;
const SPIT_SHOAL_CORE = 70;
const SPIT_SHOAL_EDGE = 180;
const SPIT_LIFT = 21;

/**
 * The lagoon: the water between the beach and the bar, on the lee shore.
 *
 * `Props` puts the pirate cove on this bearing, so the sector has to stay
 * navigable and gently shelving. Hence a *floor* rather than a barrier: applied
 * last and as a maximum, it can only ever raise the seabed toward `LAGOON_Y`.
 * The beach and the spit crest are already above it and pass through untouched,
 * which is also why the order of these last two terms is not free.
 */
const LAGOON = sector(0.68, 0.52);
const LAGOON_IN = 0.98;
const LAGOON_FULL = 1.16;
const LAGOON_EDGE = 1.4;
const LAGOON_OUT = 1.62;
const LAGOON_Y = -5.5;

/**
 * Shoreline radius on the bearing `(ux, uz)`, as a multiple of `ISLAND.radius`.
 */
function shoreFraction(ux: number, uz: number): number {
  const e = ux * ELONGATION_AXIS.x + uz * ELONGATION_AXIS.z;
  const l = ux * LOBE_AXIS.x + uz * LOBE_AXIS.z;
  const d = ux * DRIFT_AXIS.x + uz * DRIFT_AXIS.z;

  const elongation = ELONGATION * (e * e * 2 - 1);
  const lobes = LOBES * (l * l * l * 4 - l * 3);
  const drift = DRIFT * d;
  const bay = BAY_CUT * sectorMask(ux, uz, BAY);
  const headland = HEADLAND_REACH * sectorMask(ux, uz, HEADLAND);

  return Math.max(1 + elongation + lobes + drift - bay + headland, SHORE_FLOOR);
}

/**
 * Floor elevation in world metres (negative below sea level).
 *
 * Exported so `Props` can seat rocks and cliffs on the same surface the mesh is
 * built from, without either side owning the other. Called per frame from
 * buoyancy and per candidate from the placement loops, so it allocates nothing:
 * every direction it needs is a module constant read component-wise.
 */
export function seafloorHeight(x: number, z: number): number {
  const n = fbm(x * FEATURE_SCALE, z * FEATURE_SCALE);

  const rOrigin = Math.sqrt(x * x + z * z);

  const dx = x - ISLAND.x;
  const dz = z - ISLAND.z;
  const dIsland = Math.sqrt(dx * dx + dz * dz);
  // Guarded so the bearing is finite at the centre. Every directional term reads
  // it, and one NaN there would spread across the whole summit.
  const inv = 1 / Math.max(dIsland, 1);
  const ux = dx * inv;
  const uz = dz * inv;

  const shore = ISLAND.radius * shoreFraction(ux, uz);
  const t = dIsland / shore;

  // Crest measured from the offset summit, in its own normalised frame.
  const sx = dx - SUMMIT_OFFSET.x;
  const sz = dz - SUMMIT_OFFSET.z;
  const tCrest = Math.sqrt(sx * sx + sz * sz) / (shore * CREST_SPAN);

  // Spit, in along/across metres about its own axis; `across` is measured
  // against the hooked centreline rather than a straight one.
  const along = dx * SPIT.x + dz * SPIT.z;
  const across = dz * SPIT.x - dx * SPIT.z;
  const offset = Math.abs(across - along * along * SPIT_CURVE);
  const run =
    smoothstep(SPIT_ROOT, SPIT_ROOT + SPIT_RISE, along) *
    smoothstepDown(along, SPIT_TIP - SPIT_TAPER, SPIT_TIP);
  const shoal = run * smoothstepDown(offset, SPIT_SHOAL_CORE, SPIT_SHOAL_EDGE);
  const crest = run * smoothstepDown(offset, SPIT_CORE, SPIT_EDGE);

  const shallowOrigin = smoothstepDown(rOrigin, PLATEAU_RADIUS, SHELF_RADIUS);
  const shallowIsland = smoothstepDown(t, SKIRT_IN, SKIRT_OUT);
  const shallowness = Math.max(Math.max(shallowOrigin, shallowIsland), shoal);

  let y = DEEP_Y + (PLATEAU_Y - DEEP_Y) * shallowness;
  y += (n - 0.5) * RELIEF * (0.35 + 0.65 * shallowness);
  y += SHORE_LIFT * smoothstepDown(t, APRON_IN, APRON_OUT);
  y += CREST_LIFT * smoothstepDown(tCrest, CREST_IN, CREST_OUT);
  y +=
    HEADLAND_LIFT *
    sectorMask(ux, uz, HEADLAND) *
    smoothstep(HEADLAND_TOE, HEADLAND_CROWN, t) *
    smoothstepDown(t, HEADLAND_BROW, HEADLAND_FALL);
  y += SPIT_LIFT * crest;

  const lagoon =
    sectorMask(ux, uz, LAGOON) *
    smoothstep(LAGOON_IN, LAGOON_FULL, t) *
    smoothstepDown(t, LAGOON_EDGE, LAGOON_OUT);
  // Read `y` into `fill` before touching it. The TSL twin needs the same split
  // so the value the lagoon is filling against is unambiguously the pre-lagoon
  // floor rather than whatever a compound assignment decides to evaluate first.
  const fill = Math.max(LAGOON_Y - y, 0);
  y += lagoon * fill;
  return y;
}

/** Positive metres of water above the floor at (x, z); 0 where the floor is dry. */
export function seafloorDepth(x: number, z: number): number {
  return Math.max(0, -seafloorHeight(x, z));
}

// ------------------------------------------------------------------- the reef

/**
 * Where the reef gathers, in world XZ.
 *
 * This lives here, with the heightfield, rather than in `Props` — which is the
 * only module that *builds* anything out of it — because it is a fact about the
 * world and two modules need to agree on it. `Props` grows the coral and the
 * rock on these centres and `Fish` stations its resident schools over them, and
 * the point of the whole exercise is that those are the same places: a diver who
 * finds coral finds fish, and a diver who follows fish arrives at coral. Two
 * independent scatters over the same annulus produce neither.
 *
 * A uniform scatter was the problem this replaces. The plateau's reef band is
 * about 210,000 m² and underwater visibility here runs to a few tens of metres,
 * so any even spread — at any instance count a frame can afford — is invisible
 * on average and the seabed reads as an empty plain. Gathering it into a handful
 * of patches with open sand between them is both what a reef actually looks like
 * and the only arrangement that puts something in front of the camera.
 *
 * Stratified by bearing, one patch per sector, for the same reason the fish
 * radii are: seven free angles leave a third of the compass empty about half the
 * time, and a viewer who swims the wrong way finds the plain again. Radii are
 * square-rooted so the patches spread evenly by area, and inset by the patch
 * radius so none hangs off the plateau into the drop.
 *
 * Memoised: it is a pure function of module constants, and both callers want the
 * same list rather than two draws from the same distribution.
 */
export const REEF_BAND = {
  /** Clear of the spawn point, and inside the shallow plateau. */
  inner: 26,
  outer: 260,
  patches: 7,
  patchRadius: 15,
} as const;

const REEF_PATCH_SEED = 0x8f2c11;

let reefPatchCache: readonly { x: number; z: number }[] | null = null;

export function reefPatches(): readonly { x: number; z: number }[] {
  if (reefPatchCache) return reefPatchCache;

  const random = mulberry32(REEF_PATCH_SEED);
  const inner = REEF_BAND.inner + REEF_BAND.patchRadius;
  const outer = REEF_BAND.outer - REEF_BAND.patchRadius;
  const out: { x: number; z: number }[] = [];

  for (let i = 0; i < REEF_BAND.patches; i++) {
    const angle = ((i + 0.15 + random() * 0.7) / REEF_BAND.patches) * Math.PI * 2;
    const radius = inner + Math.sqrt(random()) * (outer - inner);
    out.push({ x: Math.cos(angle) * radius, z: Math.sin(angle) * radius });
  }

  // The nearest patch is pulled in to the inner edge of the band. Without it the
  // closest reef to the spawn point is wherever the seed happened to put one —
  // 90 m on this seed — and the first thing a viewer does when they dive at the
  // origin is swim across sand looking for the thing the scene is about.
  let nearest = 0;
  for (let i = 1; i < out.length; i++) {
    if (Math.hypot(out[i].x, out[i].z) < Math.hypot(out[nearest].x, out[nearest].z)) nearest = i;
  }
  const bearing = Math.atan2(out[nearest].z, out[nearest].x);
  const close = REEF_BAND.inner + REEF_BAND.patchRadius * 1.2;
  out[nearest] = { x: Math.cos(bearing) * close, z: Math.sin(bearing) * close };

  reefPatchCache = out;
  return out;
}

/**
 * The two world periods the sand normal is sampled at, metres.
 *
 * 13 and 47 are coprime enough that the pair does not visibly repeat inside the
 * few hundred metres a viewer can resolve detail over: the beat is at their
 * least common multiple, 611 m, by which distance the map is a mip average.
 * Neither is a round number for that reason — 12 and 48 would beat at 48.
 */
const SAND_DETAIL_NEAR = 13;
const SAND_DETAIL_FAR = 47;

// --------------------------------------------------------------- sand detail

/**
 * Tiling normal map for the sand, derived from the same noise field so the
 * micro-detail shares a family resemblance with the macro shape.
 */
function createSandNormalTexture(): THREE.DataTexture {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);

  // Two octaves at frequencies that divide `size`, so the result tiles exactly.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = valueNoise((x / size) * 16, (y / size) * 16);
      const b = valueNoise((x / size) * 48 + 31.7, (y / size) * 48 + 11.3);
      // Ripple ridges: sand under swell forms parallel bars, not isotropic bumps.
      //
      // The phase is dragged by the low-frequency octave rather than being a
      // clean multiple of the tile. Six bars per tile with a fixed phase is
      // exactly six bars per tile *everywhere*, and repeated across a seabed it
      // reads as corduroy with a visible seam — which is what it did. Modulating
      // the phase by `a` makes the bars wander, bifurcate and lose count, which
      // is both what real ripple fields do and what stops the eye locking onto
      // the period. The map still tiles exactly, because `a` does.
      const ripple = Math.sin((x / size) * Math.PI * 2 * 6 + a * 14) * 0.5 + 0.5;
      height[y * size + x] = a * 0.55 + b * 0.2 + ripple * 0.25;
    }
  }

  const strength = 2.6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xl = height[y * size + ((x - 1 + size) % size)];
      const xr = height[y * size + ((x + 1) % size)];
      const yd = height[((y - 1 + size) % size) * size + x];
      const yu = height[((y + 1) % size) * size + x];

      let nx = (xl - xr) * strength;
      let ny = (yd - yu) * strength;
      let nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;

      const i = (y * size + x) * 4;
      data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }

  const map = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.generateMipmaps = true;
  map.anisotropy = 8;
  map.colorSpace = THREE.NoColorSpace;
  map.needsUpdate = true;
  return map;
}

// ------------------------------------------------------------------- the class

export interface SeafloorOptions {
  /** Grid subdivisions per side. 256 gives ~15 m spacing over a 4 km extent. */
  segments?: number;
  /** Metres of sand normal-map per tile. */
  detailTiling?: number;
}

export class Seafloor {
  readonly mesh: THREE.Mesh;
  readonly extent: number;

  private readonly geometry: THREE.PlaneGeometry;
  private readonly material: THREE.MeshStandardNodeMaterial;
  private readonly noiseTexture: THREE.DataTexture;
  private readonly sandNormal: THREE.DataTexture;

  /** TSL entry points; built once, reused by every consumer. */
  private readonly nodes: NoiseNodes;

  private readonly uCausticsStrength = uniform(1);
  private causticsNode: Node = null;
  private disposed = false;

  constructor(extent: number, options: SeafloorOptions = {}) {
    this.extent = extent;
    const segments = options.segments ?? 256;
    const detailTiling = options.detailTiling ?? 7;

    this.noiseTexture = createNoiseTexture();
    this.sandNormal = createSandNormalTexture();
    // No `repeat`: the normal node below supplies its own world-space uv at two
    // scales, and a repeat set here would be applied on top of them.
    void detailTiling;

    this.nodes = buildNoiseNodes(this.noiseTexture);

    this.geometry = new THREE.PlaneGeometry(extent, extent, segments, segments);
    // Bake the flip into the attributes so the position attribute's y really is
    // world up — the displacement loop below depends on that.
    this.geometry.rotateX(-Math.PI / 2);

    const position = this.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      position.setY(i, seafloorHeight(position.getX(i), position.getZ(i)));
    }
    position.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();

    this.material = new THREE.MeshStandardNodeMaterial();
    this.material.name = 'seafloor-sand';
    this.material.roughness = 0.93;
    this.material.metalness = 0;
    /**
     * The sky is a source of light on this surface, not a mirror in it.
     *
     * `scene.environment` is the atmosphere's own cube capture, and at full
     * strength on a 0.8 km² dome it does something no amount of albedo work can
     * undo: it lays a flat blue-white fill over the whole island. Measured on the
     * hero frame, the vegetated slopes came out at sRGB (176, 183, 184) — a
     * saturation of 0.04, against 0.49 for the same slope in
     * `docs/ref/tropical-island-sea-level-v2.png`. Turning the environment off
     * entirely moved them to (164, 159, 145): still too bright, but a *colour*
     * again. The blue was the environment.
     *
     * It is not wrong that skylight is blue, and this does not pretend otherwise
     * — it is that the term arrives unoccluded. A canopy shades itself, a slope
     * shades its own hollows, and none of that exists here because the greenery
     * on the mid-slopes lives in this material's colour rather than in geometry
     * that could cast. 0.42 is the fraction of sky an averagely-enclosed patch of
     * ground actually sees, and using it is cheaper and steadier than the ambient
     * occlusion term this surface has no way to compute.
     */
    // 0.78, up from the 0.42 this was, and the two numbers describe the same
    // amount of light. 0.42 was chosen to hold back a blue-white fill from a sky
    // dome that has since been re-calibrated — `SKY_RADIANCE_SCALE` fell from
    // 0.35 to 0.16 when the grade change left it stale — so the term it was
    // fighting is already 2.2x smaller. Leaving it here would have charged the
    // island for the sky's brightness twice and taken the ambient off the
    // shaded slopes with it.
    this.material.envMapIntensity = 0.78;
    /**
     * Sand detail, sampled at two incommensurate world scales and blended.
     *
     * A single tiling map has one period, and that period is visible. This one
     * was laid down at `extent / detailTiling` repeats over a 4 km quad — with
     * the defaults, 571 repeats, which is a **7 metre** tile. Seven metres is
     * inside the range a viewer standing on the beach or swimming over the reef
     * resolves easily, so the seabed came out as a grid of identical patches,
     * and the ripple bars inside each one lined up across the seams into
     * corduroy. It is the single most obvious tell in the underwater frames.
     *
     * The fix is the standard one and it is not "make the tile bigger": that
     * trades a visible grid for a blurry one, because the texel density falls
     * with the same factor. Two samples at scales with no common multiple — 13 m
     * and 47 m here — put the beat frequency of the pair at hundreds of metres,
     * which is past where the detail is resolvable at all. The large scale also
     * costs nothing extra in memory: it is the same 256² map.
     *
     * Combined by the whiteout blend (add the tangent xy, multiply z) rather
     * than by averaging. Averaging two normals flattens both — two independent
     * bump fields average toward flat — and the result was a seabed that tiled
     * correctly and had no relief left. Whiteout keeps the slope of each.
     */
    const detail = (metres: number): Node =>
      texture(this.sandNormal, vec2(positionWorld.x, positionWorld.z).mul(1 / metres)).xyz
        .mul(2)
        .sub(1);

    this.material.normalNode = Fn(() => {
      const near = detail(SAND_DETAIL_NEAR).toVar();
      const far = detail(SAND_DETAIL_FAR).toVar();
      const blended = normalize(
        vec3(near.x.add(far.x), near.y.add(far.y), near.z.mul(far.z)),
      ).toVar();
      // Re-encoded to [0,1] because `normalMap` decodes: it is the tangent-space
      // entry point and expects a sampled texel, not a decoded normal.
      return normalMap(vec4(blended.mul(0.5).add(0.5), 1), vec2(0.75, 0.75));
    })();

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'seafloor';
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    // The floor is a single 4 km quad centred on the world; culling it against
    // its own bounding sphere is pure overhead and it is never off screen.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();

    this.rebuildColorNode();
  }

  /** Signed depth below y = 0; positive means that much water above the floor. */
  depthAt(x: number, z: number): number {
    return -seafloorHeight(x, z);
  }

  /**
   * Floor depth as a TSL node, for the water shader's shallow-water tint.
   * `worldPosition` must be a vec3 node; only xz is read.
   */
  depthNode(worldPosition: unknown): unknown {
    const wp = worldPosition as Node;
    return this.nodes.height(vec2(wp.x, wp.z)).negate();
  }

  /** Floor elevation as a TSL node (negative below sea level). */
  heightNode(worldPosition: unknown): unknown {
    const wp = worldPosition as Node;
    return this.nodes.height(vec2(wp.x, wp.z));
  }

  /**
   * Injects the caustics projection. Expected to be centred near 1.0 — it
   * multiplies the sand's lit colour, so 1.0 means "no caustics here".
   * Triggers one shader rebuild; call it at setup, not per frame.
   */
  setCaustics(node: unknown): void {
    this.causticsNode = (node ?? null) as Node;
    this.rebuildColorNode();
  }

  /** Scales the injected caustics without a rebuild. */
  setCausticsStrength(value: number): void {
    this.uCausticsStrength.value = value;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.geometry.dispose();
    this.material.dispose();
    this.noiseTexture.dispose();
    this.sandNormal.dispose();
  }

  // ------------------------------------------------------------------ internals

  private rebuildColorNode(): void {
    const caustics = this.causticsNode;
    const strength = this.uCausticsStrength;
    const valueNoise = this.nodes.valueNoise;

    this.material.colorNode = Fn(() => {
      const wp = positionWorld.toVar();
      const depth = wp.y.negate().toVar();

      // Albedos are dim on purpose. The previous dry sand was 0.74 linear, and
      // once the mottling's 1.16 ceiling and a clear-sky IBL were through with
      // it the whole island clipped to white: no grain, no shading, no beach.
      // Quartz beach sand reflects around 0.35-0.45 diffuse — but that figure is
      // the *albedo*, and what a viewer sees is the albedo times the irradiance,
      // which here is a 3.4-intensity key plus a hemisphere fill. Measured off
      // the rendered frame, an albedo of 0.52 put the island at RGB 228,228,228:
      // not clipped, but a neutral near-white with no grain and no colour, which
      // reads as snow. These land it near 195 and keep the warm ratio a quartz
      // beach actually has, so the normal map, the caustics and the swash band
      // all have somewhere to go.
      // Pale warm stone, and brighter than the soil below it rather than darker:
      // this is the crown, and in the reference frame it is the lightest thing
      // on the island after the beach — sRGB (167, 152, 131) against the
      // canopy's (54, 62, 41).
      const dryRock = vec3(0.26, 0.235, 0.2);
      // Soil under a closed canopy, not open ground. It used to be 0.24 — nearly
      // as bright as the beach — and since `VEGETATION_COVER` lets a fraction of
      // it through everywhere, that one constant was contributing about half the
      // luminance of every vegetated slope on the island and taking the hue with
      // it. A shaded forest floor is dark and warm.
      const dryInland = vec3(0.15, 0.125, 0.082);
      const beachSand = vec3(0.30, 0.26, 0.18);
      const wetSand = vec3(0.15, 0.13, 0.10);
      const shallowSand = vec3(0.42, 0.4, 0.3);
      const deepSilt = vec3(0.1, 0.15, 0.17);

      // Tight, because this is the beach edge. The 7.5 m ramp this replaced
      // spanned the entire intertidal slope, so there was no elevation at which
      // the floor was unambiguously sand rather than seabed.
      const aboveWater = wp.y.smoothstep(-0.8, 1.6).toVar();
      const submerged = mix(deepSilt, shallowSand, smoothstepDownNode(depth, 4, 70)).toVar();
      // Inland is warmer and darker: the same sand, dry and dusted with what
      // grows on it. The rock term takes over near the summit, which is why its
      // edges are a fraction of `ISLAND.peak` rather than the old fixed metres.
      const exposed = mix(beachSand, dryInland, wp.y.smoothstep(2, 15)).toVar();

      // The island is vegetated in the *ground*, not only in the instances.
      //
      // This is the difference between an island and a sandbank, and geometry
      // cannot supply it. Reading as lush needs canopy over most of the
      // interior; the interior is three quarters of a square kilometre, and a
      // tree here is thirty thousand triangles. Even at two hundred trees — more
      // than doubling what the dressing carries — that is one per six thousand
      // square metres, which an aerial capture showed for exactly what it is: a
      // white dome with objects sprinkled on it.
      //
      // So the biome lives in the terrain colour and the models are the hero
      // layer standing in it, which is how open-world terrain has always worked.
      // The band starts above the swash and stops below the summit rock, and the
      // mottling below breaks its edge up so it is a treeline rather than a
      // contour.
      //
      // Measured against `docs/ref/tropical-island-sea-level-v2.png` rather
      // than chosen. Sampled over the canopy the reference sits at sRGB
      // (54, 62, 41) and (61, 71, 48): green ahead of red by about eight
      // levels, blue at three quarters of red. What stood here was
      // (0.075, 0.115, 0.05), whose hue is not far off — but the same frame
      // from this renderer measured (176, 183, 184), a saturation of 0.04
      // against the reference's 0.49. Which is not a green hill. It is a grey
      // one.
      //
      // The hue is therefore barely touched and the *value* is more than
      // halved. A sunlit broadleaf canopy is dark — in the reference it is a
      // third of the beach it grows behind, and here it was nine tenths of it,
      // which is why the island read as chalk with shrubs on. The blue is
      // lifted a little relative to what it was, because at a kilometre the
      // sky IBL puts a blue-white fill over everything and a band with no blue
      // in it turns grey rather than staying green.
      const canopy = vec3(0.03, 0.043, 0.024);
      const scrub = vec3(0.062, 0.074, 0.036);
      const growth = mix(scrub, canopy, wp.y.smoothstep(9, 60)).toVar();
      const vegetated = mix(
        exposed,
        growth,
        wp.y.smoothstep(BEACH_TOP_METRES, VEGETATION_FULL_METRES).mul(VEGETATION_COVER),
      ).toVar();

      // The treeline, and it is high on purpose.
      //
      // At 0.42 the bare rock started 63 m up a 150 m island, so two thirds of
      // the dome came out pale stone and the whole planting scheme sat in a ring
      // round the bottom of it: a bald hill with a hedge. What a tropical high
      // island looks like is the other way round — the reference frame is
      // continuous dark canopy over the lower two thirds with a pale crown above
      // it — and bare rock only appears where the slope gets too steep and too
      // thin to hold anything.
      //
      // 0.72 to 0.95, and the numbers are read off the frame rather than off
      // the contour, because on a dome those are not the same thing. Elevation
      // 0.58 of the peak sounds like the lower half staying green; it is not.
      // The crest falls away over 0.9 of the shore radius, so 87 m of a 150 m
      // island is still 225 m out from the summit — a cap 45% of the island's
      // radius across, which side-on is most of what the eye sees. Measured on
      // the capture, a band starting at 0.58 left two thirds of the visible dome
      // pale and the reference has pale rock over about a third of it.
      const land = mix(
        vegetated,
        dryRock,
        wp.y.smoothstep(ISLAND.peak * 0.72, ISLAND.peak * 0.95),
      ).toVar();

      const base = mix(submerged, land, aboveWater).toVar();

      // The swash band. Sand within a few metres of mean sea level is wet more
      // often than it is dry, and without the band the beach meets the water as
      // a join between two dry-looking materials — the strongest single tell
      // that a shoreline is a displaced grid. It straddles y = 0 because the
      // swash does.
      const swash = smoothstepDownNode(wp.y.abs(), 1, 3.4).toVar();
      const damp = mix(base, wetSand, swash).toVar();

      // Broad mottling: patches of weed and darker sediment, the dark blotches
      // visible through the shallows in the reference top-down shot.
      // Two scales, and a wider range than the 0.78-1.18 this replaced. That
      // band was too tight to survive the tone curve: with the island already
      // sitting high on the ACES shoulder, a +/-20% multiplier arrived as about
      // four levels and the beach read as a single flat value. Sand is not
      // uniform — it is shell, weed, damp patches and wind-sorted grain — and
      // the variation is most of what separates a beach from a painted dome.
      const patch = valueNoise(vec2(wp.x, wp.z).mul(1 / 26)).toVar();
      const grain = valueNoise(vec2(wp.x, wp.z).mul(1 / 5.5)).toVar();
      const mottled = damp
        .mul(patch.mul(0.52).add(0.66))
        .mul(grain.mul(0.16).add(0.92))
        .toVar();

      if (caustics === null) return vec4(mottled, 1);

      // Caustics only exist under water, and fade out as the floor gets deep
      // enough that the surface pattern has diverged into ambient light.
      const reach = smoothstepDownNode(depth, 2, 48).mul(float(1).sub(aboveWater)).toVar();
      const lit = mix(float(1), caustics, reach.mul(strength)).toVar();
      return vec4(mottled.mul(lit), 1);
    })();

    this.material.needsUpdate = true;
  }
}

// -------------------------------------------------------------- TSL heightfield

interface NoiseNodes {
  /** vec2 -> float in [0, 1]. */
  valueNoise: (p: Node) => Node;
  /** vec2 -> float in [0, 1]. */
  fbm: (p: Node) => Node;
  /** World xz (vec2) -> floor elevation in metres. */
  height: (p: Node) => Node;
}

/**
 * Builds the TSL mirror of the CPU heightfield.
 *
 * Everything is expressed as parameterised `Fn`s rather than closures over
 * caller-scope variables. A no-argument `Fn` that reads a `toVar()` declared by
 * its caller is only correct if TSL happens to inline the body; passing the
 * value in as a parameter is correct either way.
 */
function buildNoiseNodes(map: THREE.Texture): NoiseNodes {
  /**
   * Bilinear value noise matching `valueNoise()` above, texel for texel.
   *
   * Explicit LOD 0 on every fetch: the water material may call `depthNode()`
   * from its vertex stage, where implicit derivatives do not exist and an
   * unqualified sample is a WGSL validation error.
   */
  const valueNoise = Fn(([p]: [Node]) => {
    const i = p.floor().toVar();
    const f = p.sub(i).toVar();
    const u = f.mul(f).mul(f.mul(-2).add(3)).toVar();

    const base = i.add(0.5).div(NOISE_SIZE).toVar();
    const step = float(1 / NOISE_SIZE);

    const a = texture(map, base, 0).r.toVar();
    const b = texture(map, base.add(vec2(step, 0)), 0).r.toVar();
    const c = texture(map, base.add(vec2(0, step)), 0).r.toVar();
    const d = texture(map, base.add(vec2(step, step)), 0).r.toVar();

    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  });

  const fbmFn = Fn(([p]: [Node]) => {
    const q = p.toVar();
    const sum = float(0).toVar();
    let amplitude = 1;
    for (let o = 0; o < OCTAVES; o++) {
      sum.addAssign(valueNoise(q).mul(amplitude));
      const rx = q.x.mul(ROT[0]).add(q.y.mul(ROT[1])).toVar();
      const ry = q.x.mul(ROT[2]).add(q.y.mul(ROT[3])).toVar();
      q.assign(
        vec2(
          rx.mul(LACUNARITY).add(OCTAVE_OFFSET[0]),
          ry.mul(LACUNARITY).add(OCTAVE_OFFSET[1]),
        ),
      );
      amplitude *= GAIN;
    }
    return sum.mul(1 / FBM_NORM);
  });

  /**
   * `sectorMask()` above, node for node. A plain arrow rather than an `Fn`
   * because it takes everything it reads as an argument, so it inlines and the
   * scoping hazard the header describes cannot apply.
   */
  const sectorMaskNode = (u: Node, s: Sector): Node =>
    u.dot(vec2(s.x, s.z)).smoothstep(s.edge, 1);

  /** `shoreFraction()` above, term for term and in the same order. */
  const shoreFractionNode = (u: Node): Node => {
    const e = u.dot(vec2(ELONGATION_AXIS.x, ELONGATION_AXIS.z)).toVar();
    const l = u.dot(vec2(LOBE_AXIS.x, LOBE_AXIS.z)).toVar();
    const d = u.dot(vec2(DRIFT_AXIS.x, DRIFT_AXIS.z)).toVar();

    const elongation = e.mul(e).mul(2).sub(1).mul(ELONGATION).toVar();
    const lobes = l.mul(l).mul(l).mul(4).sub(l.mul(3)).mul(LOBES).toVar();
    const drift = d.mul(DRIFT).toVar();
    const bay = sectorMaskNode(u, BAY).mul(BAY_CUT).toVar();
    const headland = sectorMaskNode(u, HEADLAND).mul(HEADLAND_REACH).toVar();

    return float(1).add(elongation).add(lobes).add(drift).sub(bay).add(headland).max(SHORE_FLOOR);
  };

  /**
   * Mirrors `seafloorHeight()` exactly.
   *
   * Read the two side by side: same locals, same order, same constants, and the
   * same three arguments to every ramp. That correspondence is the only thing
   * keeping the buoyancy solver, the prop placement and the water's depth term
   * on the same surface as this mesh, so a term added to one half without the
   * other is not a cosmetic bug — it is props buried in sand and fish inside
   * rock.
   */
  const height = Fn(([p]: [Node]) => {
    const xz = p.toVar();
    const n = fbmFn(xz.mul(FEATURE_SCALE)).toVar();

    const rOrigin = xz.length().toVar();

    // `dv` is (dx, dz); its `.y` is the world z offset throughout.
    const dv = xz.sub(vec2(ISLAND.x, ISLAND.z)).toVar();
    const dIsland = dv.length().toVar();
    const inv = float(1).div(dIsland.max(1)).toVar();
    const u = dv.mul(inv).toVar();

    const shore = shoreFractionNode(u).mul(ISLAND.radius).toVar();
    const t = dIsland.div(shore).toVar();

    const sv = dv.sub(vec2(SUMMIT_OFFSET.x, SUMMIT_OFFSET.z)).toVar();
    const tCrest = sv.length().div(shore.mul(CREST_SPAN)).toVar();

    const along = dv.dot(vec2(SPIT.x, SPIT.z)).toVar();
    const across = dv.y.mul(SPIT.x).sub(dv.x.mul(SPIT.z)).toVar();
    const offset = across.sub(along.mul(along).mul(SPIT_CURVE)).abs().toVar();
    const run = along
      .smoothstep(SPIT_ROOT, SPIT_ROOT + SPIT_RISE)
      .mul(smoothstepDownNode(along, SPIT_TIP - SPIT_TAPER, SPIT_TIP))
      .toVar();
    const shoal = run.mul(smoothstepDownNode(offset, SPIT_SHOAL_CORE, SPIT_SHOAL_EDGE)).toVar();
    const crest = run.mul(smoothstepDownNode(offset, SPIT_CORE, SPIT_EDGE)).toVar();

    const shallowOrigin = smoothstepDownNode(rOrigin, PLATEAU_RADIUS, SHELF_RADIUS).toVar();
    const shallowIsland = smoothstepDownNode(t, SKIRT_IN, SKIRT_OUT).toVar();
    const shallowness = shallowOrigin.max(shallowIsland).max(shoal).toVar();

    const y = float(DEEP_Y).add(float(PLATEAU_Y - DEEP_Y).mul(shallowness)).toVar();
    y.addAssign(n.sub(0.5).mul(RELIEF).mul(shallowness.mul(0.65).add(0.35)));
    y.addAssign(smoothstepDownNode(t, APRON_IN, APRON_OUT).mul(SHORE_LIFT));
    y.addAssign(smoothstepDownNode(tCrest, CREST_IN, CREST_OUT).mul(CREST_LIFT));
    y.addAssign(
      sectorMaskNode(u, HEADLAND)
        .mul(t.smoothstep(HEADLAND_TOE, HEADLAND_CROWN))
        .mul(smoothstepDownNode(t, HEADLAND_BROW, HEADLAND_FALL))
        .mul(HEADLAND_LIFT),
    );
    y.addAssign(crest.mul(SPIT_LIFT));

    const lagoon = sectorMaskNode(u, LAGOON)
      .mul(t.smoothstep(LAGOON_IN, LAGOON_FULL))
      .mul(smoothstepDownNode(t, LAGOON_EDGE, LAGOON_OUT))
      .toVar();
    const fill = float(LAGOON_Y).sub(y).max(0).toVar();
    y.addAssign(lagoon.mul(fill));
    return y;
  });

  return {
    valueNoise: (p: Node) => valueNoise(p),
    fbm: (p: Node) => fbmFn(p),
    height: (p: Node) => height(p),
  };
}
