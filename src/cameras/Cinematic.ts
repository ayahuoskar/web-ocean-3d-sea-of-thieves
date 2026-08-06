import * as THREE from 'three';
import { ISLAND } from '../scene/Seafloor';

/**
 * A looping authored flight that shows the scene off — and sails the ship while
 * it does it.
 *
 * Four decisions carry the whole thing.
 *
 * **The hull is driven, not moved.** Every beat emits a throttle and a rudder
 * through the same `ShipController.setInput` the keyboard and the touch stick
 * use. Nothing here writes the ship's transform. That is not tidiness: the hull
 * climbing a swell, losing way in the turn and laying a wake whose wavelength
 * follows its speed are all consequences of the solver integrating those two
 * numbers, and a cinematic that teleported the hull along a curve would show a
 * decal sliding over water instead of a ship sailing through it.
 *
 * **Every output is a closed-form function of one clock.** `update` advances a
 * scalar and then *samples*; nothing is integrated, filtered or damped against a
 * previous frame, and nothing reads the live hull. `resetClock(t)` therefore
 * lands on exactly the pose and exactly the ship input that time maps to,
 * whatever ran before it. The visual harness rewinds the clock between captures,
 * and a rig with any per-frame memory in it — a smoothing filter, a chase lag, a
 * "where was I last frame" — makes every screenshot depend on the order the
 * tests happened to run in.
 *
 * **The loop is continuous because the curve is cyclic and C¹ in time, not
 * because the endpoints happen to match.** Camera positions and look-at points
 * are knots on a non-uniform cardinal spline whose knot array is treated as a
 * ring: knot `n-1` blends into knot `0` with the same Hermite arithmetic as any
 * other pair. Tangents are finite differences taken *per second* rather than per
 * knot interval (see `buildTrack`), so the velocity leaving a knot equals the
 * velocity entering it even where the two beats either side have wildly
 * different durations. Position, look direction and speed are therefore all
 * continuous at the wrap by construction — there is no seam to line up by hand,
 * and no way to introduce one by editing a duration. Matching endpoints alone
 * would give a position match and a visible *cut in the motion*, which is the
 * exact failure this is built to avoid.
 *
 * **The hull's circuit closes for a different reason, and it is worth stating.**
 * The ship is asked to hold one constant turn radius for the whole loop while
 * its speed varies. For a constant-radius path the per-beat displacements
 * telescope, so the circuit closes exactly whenever the heading closes — and the
 * radius is *derived* as `totalArcLength / 2π`, which is precisely the condition
 * that makes the heading close. Editing a duration or a throttle re-derives the
 * radius and the circuit still closes. Author a rudder by hand instead and the
 * ship spirals a few hundred metres further out on every lap until it is over
 * deep water with nothing to look at.
 *
 * Known limitation, stated rather than hidden: the framing assumes the hull
 * starts near the origin on an easterly heading, which is where it spawns and
 * where it stays unless someone has been driving it in Boat mode first. The
 * flight cannot read the live hull without giving up determinism, so a ship
 * parked half a kilometre away will be off-centre in the beats that frame it.
 * The shots that care are all wide enough that ±100 m of hull error keeps it in
 * frame, and the open-loop rudder puts *any* hull into the same circuit shape
 * around wherever it happens to be.
 */

// ---------------------------------------------------------------- hull mirrors

/**
 * Terminal speed at full ahead, m/s: `sqrt(MAX_THRUST / DRAG_LONGITUDINAL)` from
 * `ShipController`.
 *
 * Mirrored rather than imported because those constants are private to the
 * controller and this module has no business widening its API. If the hull is
 * ever re-tuned and this is not, the circuit below simply closes at the wrong
 * radius — the ship wanders wider or tighter than the shots expect. The camera
 * path is authored in world space and is not affected at all, which is why a
 * stale mirror here is a framing annoyance rather than a broken mode.
 */
const HULL_TOP_SPEED = 9.64;

/**
 * Steady yaw rate per unit of rudder at full rudder authority, rad/s:
 * `RUDDER_TORQUE / YAW_DAMPING` from `ShipController`.
 *
 * The controller's yaw is a first-order system — rudder torque against damping
 * proportional to yaw rate — so a held rudder settles at exactly this rate times
 * the rudder. That is what makes a target turn radius invertible into a rudder
 * order at all.
 */
const HULL_YAW_RATE_PER_RUDDER = 0.214;

/**
 * Speed, m/s, at which the rudder reaches full authority — `ShipController`'s
 * `RUDDER_REFERENCE_SPEED`.
 *
 * Below it a rudder order buys proportionally less turn, because a rudder is a
 * foil. Every beat here runs well above it, so the correction is a no-op in
 * practice; it is applied anyway so that dropping a throttle to a crawl in some
 * future edit does not silently open the circuit out.
 */
const HULL_RUDDER_REFERENCE_SPEED = 5.5;

// ------------------------------------------------------------------- authoring

/**
 * How hard the spline pulls toward its finite-difference tangents.
 *
 * 1.0 is Catmull–Rom: the camera passes each knot at the full average speed of
 * its neighbours, which is smooth but metronomic — a spline follower. Below 1
 * the curve slows into each knot and accelerates out of it, which is what a
 * camera operator settling on a mark and then moving off it actually does. It
 * stays exactly C¹ at any value, so this is a feel control and nothing else; at
 * 0 it would degenerate to straight lines with corners at every knot.
 */
const TENSION = 0.7;

/**
 * Height above the waterline that `'ship'` look targets aim at, metres.
 *
 * The hull is 27 m long and its origin sits at the design waterline, so aiming
 * at y = 0 puts the ship's *feet* in the centre of frame and crops the rig. A
 * few metres up centres the hull instead.
 */
const SHIP_LOOK_HEIGHT = 5;

/** A key's look-at: an explicit world point, or the nominal hull at that time. */
type LookTarget = readonly [number, number, number] | 'ship';

interface Key {
  /** Where in the beat this key lands, 0..1. The first key of a beat must be 0. */
  at: number;
  /** Camera position, world metres. */
  eye: readonly [number, number, number];
  look: LookTarget;
}

interface Beat {
  /** Stable identifier. Surfaced by `beatName` for a HUD or a capture label. */
  name: string;
  /** Seconds. Also sets how much of the hull's circuit this beat covers. */
  duration: number;
  /**
   * Engine order, 0..1 ahead.
   *
   * Constant across the beat, and deliberately stepped at the boundary rather
   * than ramped: `ShipController` already spools the throttle over 0.7 s and the
   * rudder over 2.2 s, so a step here *is* a telegraph order and arrives at the
   * solver as a smooth change. Smoothing it a second time on this side would
   * only make the hull sluggish for no visible gain.
   */
  throttle: number;
  keys: readonly Key[];
}

/** World point the island beats aim at. Mirrors the landmass `Seafloor` builds. */
const ISLAND_LOOK: readonly [number, number, number] = [ISLAND.x, 70, ISLAND.z];

/**
 * How close any camera key is allowed to come to the island's centre, metres.
 *
 * Not enforced in code — a clamp would put a corner in the curve, which is the
 * one thing it must never develop — but asserted by `tests/cinematic.spec.ts`,
 * which is the right place for a bound that is about art direction rather than
 * about arithmetic. The mean shore radius is 500 m, so this stands the flight
 * off by half a kilometre of water: the island reads as a landmass being
 * *approached* rather than as terrain being flown over, and the canopy cards,
 * the beach and the shore break stay at the range they are built to work at.
 *
 * The previous flight came to 413 m — eighty-seven metres *inland* of the mean
 * shore — and that is what this constant exists to stop happening again.
 */
export const ISLAND_STAND_OFF = 950;

/**
 * The tour's day, as a *phase warp* on a full twenty-four hours per lap.
 *
 * The obvious construction is a sine of the loop clock about noon, and the
 * previous flight used one with a swing of 4.2 hours — which is why it only ever
 * saw 08:18 to 16:42 and never reached sunset, let alone night. Widening that
 * sine does not fix it: centred on noon, a swing large enough to reach darkness
 * at the trough puts the *crest* past midnight as well, so the tour would pass
 * through night twice and midday never.
 *
 * The right shape is a full day per lap. `hours` is then an angle rather than a
 * quantity — `sunFromClock` reads it only through trigonometry, so hour 24 and
 * hour 0 are the same sun — and a linear ramp through all twenty-four is
 * therefore already seamless, in value and in derivative. The earlier worry that
 * a ramp puts a cut at the loop point is true only of a ramp covering *part* of
 * a day.
 *
 * A linear ramp is still not enough, because the beats do not want equal shares
 * of it: the island leg needs the sun well up, the squall needs real darkness,
 * and the reef needs enough light to see coral by — and at sixty seconds a
 * uniform day gives each of them about eight. So the ramp is warped:
 *
 *     g(x) = x + (a / 2π) · sin(2π (x − p))
 *
 * which advances by exactly one day per lap for any `a` and `p`, is smooth
 * everywhere, and has rate `1 + a·cos(2π(x − p))` — fastest at `p`, slowest half
 * a lap away. At `a = 0.9` the sun runs nearly twice as fast at one end of the
 * lap and almost stands still at the other, so the flight lingers in afternoon
 * light on the island and hurries through the small hours.
 *
 * The three numbers are not taste. They were searched against the light each
 * beat actually needs — sun elevation above 0.55 for the hull and the outbound,
 * above 0.35 across the island leg, below −0.15 for the whole squall, and back
 * above 0.2 by the time the dive surfaces — and these are the values that
 * satisfy all four at once with the most margin to spare. Re-searching is the
 * right move if a duration changes; guessing at them is not, because the
 * constraints conflict and the feasible region is small.
 *
 * The resulting schedule: late morning on the water, noon over the run out,
 * early afternoon on the island, sunset on the way back, a squall and a night
 * watch in genuine darkness, and a dive that begins before dawn and surfaces
 * into morning light. `HOUR_WARP_AMOUNT` is unchanged from the 166-second lap —
 * only where the warp is centred and what hour the lap opens on had to move.
 */
const HOUR_WARP_AMOUNT = 0.9;
const HOUR_WARP_PHASE = 0.71;
/** Hour of the day at the top of the lap. */
const HOUR_AT_ORIGIN = 6.8;

/**
 * Peak rain rate in the squall, and the shape of its arrival.
 *
 * A raised cosine rather than a ramp or a clamp: it reaches zero *with zero
 * derivative* at both ends, so the weather arrives and leaves without a corner
 * in it. A clamped linear ramp would be continuous and not C¹, and the kink
 * would show as the rain rate visibly changing gear — the same class of defect
 * the camera curve is built to avoid, applied to the sky instead.
 *
 * Centred on the squall beat's opening and wider than the beat, so the weather
 * is already making up through the second half of `return` and has not quite
 * cleared as the dive goes under. Weather that starts exactly when a shot starts
 * reads as a switch being thrown.
 *
 * The half-width is bounded from above by something other than taste: rain has
 * to be a *change*, so the lap must be dry for most of itself. Nine seconds
 * either side is eighteen of sixty — thirty per cent wet — which
 * `tests/cinematic.spec.ts` holds to a 40% ceiling.
 */
const RAIN_PEAK = 0.85;
const RAIN_CENTRE_SECONDS = 40;
const RAIN_HALF_WIDTH_SECONDS = 9;

/**
 * The flight.
 *
 * **Shape.** One closed circuit, sixty seconds, traversed in a single direction.
 * A closed loop has exactly two places where the travel direction reverses, and
 * both are placed on purpose rather than left to fall where the knots happen to
 * run out: one is the wide arc across the island's face in `landfall`, the other
 * is the sweep around the hull in `open-water`. Everything between them is two
 * near-parallel legs — out on the north side, back down the middle over the reef
 * — so no beat has to double back inside itself.
 *
 * **Why the whole tour fits in a kilometre of water.** The island is 1.39 km
 * away and the previous flight went *to* it, which cost 2.8 km of transit and is
 * why that lap needed 166 seconds. Standing off it instead — `ISLAND_STAND_OFF`,
 * half a kilometre of water off the beach — puts the far end of the circuit only
 * ~440 m from the play area, because the stand-off point is measured from the
 * island's centre and the island is 500 m in radius. The landmass still fills
 * some fifty degrees of frame there. Nearly all of the old lap's length was
 * spent closing a gap that did not need closing.
 *
 * **What the numbers were chosen against.** Not by eye. The curve is sampled at
 * 60 Hz over the lap and scored for the things that read as a *cut* — speed,
 * acceleration, the angular rate of the view, and how far ahead the camera is
 * looking. That last one is the one worth naming, because it is the mechanism
 * behind every whip the previous flight had: when the look point comes close to
 * the eye, the view direction becomes hypersensitive to it, and a look point
 * that drifts *through* the camera swings the frame through 180° in a few
 * frames. The old `ascent` beat closed to 9 m and span at 297°/s. Every look
 * target here stays at least 59 m ahead, and the worst view rate on the lap is
 * 39°/s — a deliberate pan, which is what a camera operator does, rather than a
 * whip, which is what a spline does when nobody checked.
 *
 *     metric                previous (166 s)   this flight
 *     peak speed              300 m/s            47 m/s
 *     peak acceleration       422 m/s²           35 m/s²
 *     peak view rate          297 °/s            39 °/s
 *     closest look point        9 m              59 m
 *     closest island approach  87 m *inland*     584 m off the beach
 *
 * `tests/cinematic.spec.ts` asserts all five, an order of magnitude loose, so
 * they catch a knot edited into a lurch rather than policing the last per cent.
 *
 * **Geometry worth knowing while reading the numbers.** The hull spawns at the
 * origin heading +X and holds one constant turn to port; the shallow plateau
 * runs to 320 m with the reef scattered between 26 m and 260 m over sand at
 * about −17 m; the island sits 1.39 km away on a bearing of roughly
 * (−0.83, −0.56). The underwater keys hold −7 to −10 m over a floor near −16.5
 * in the reef band. That clearance is authored rather than clamped against
 * `seafloorHeight`, for the same reason nothing else here is clamped: a clamp is
 * a non-smooth term, and it would appear as a kick in the motion at exactly the
 * moments the shot is closest to the ground.
 */
const BEATS: readonly Beat[] = [
  {
    // The hull at full ahead, with the camera sweeping round its quarter.
    //
    // This beat is also the loop's turning region — the camera arrives from the
    // south-west at the end of `reef-run` and leaves heading south-west again on
    // `outbound`, so something has to come about, and an arc around the subject
    // is the one move that makes a reversal read as a choice. The hull is held
    // in frame throughout, which keeps the view rate down while the *travel*
    // direction changes by 180°: the look point is barely moving, so the pan is
    // 13°/s where the eye is turning far faster than that.
    name: 'open-water',
    duration: 8,
    throttle: 1.0,
    keys: [
      { at: 0.0, eye: [46, 11, -46], look: 'ship' },
      { at: 0.5, eye: [104, 13, -4], look: 'ship' },
    ],
  },
  {
    // Climb away from the hull and run for the island.
    //
    // The frame changes hands here, and the handover is staged rather than cut:
    // the first key is still on the hull, the second aims at a point a third of
    // the way out, and only the third takes the island itself. Aiming straight
    // from a subject 60 m away to one 1.4 km away is what put a 55°/s swing in
    // the first cut of this beat — the look point has to travel the whole
    // distance between them, and the closer of the two decides how fast that
    // reads.
    name: 'outbound',
    duration: 14,
    throttle: 0.8,
    keys: [
      { at: 0.0, eye: [118, 16, 58], look: 'ship' },
      { at: 0.29, eye: [34, 32, 6], look: [-380, 28, -280] },
      { at: 0.57, eye: [-78, 60, -64], look: ISLAND_LOOK },
      // 0.78 rather than the 0.86 this sat at first. The tail of a beat is a
      // span like any other, and leaving 2 s of it to cover the distance into
      // the next beat's opening key put 81 m/s² through the join — the same
      // short-span-long-chord mistake that gave the previous flight its 300 m/s
      // lurch, in miniature. Evening the spans took it to 35.
      { at: 0.78, eye: [-172, 90, -126], look: [ISLAND.x, 66, ISLAND.z] },
    ],
  },
  {
    // Across the island's face, held at half a kilometre off the beach.
    //
    // The wide turn at the far end of the circuit, and the beat that shows the
    // landmass: 1084 m from its centre throughout, where the island subtends
    // about fifty degrees and its whole silhouette — headland, bay, canopy band,
    // bare summit — is inside one frame. Flying *along* it rather than at it is
    // what gives the parallax that separates the headland from the hill behind
    // it; a beat that only closed the distance would show the same picture
    // getting bigger.
    //
    // 82 to 104 m of altitude, under the 150 m summit, so the crown stays above
    // the lens where it belongs.
    name: 'landfall',
    duration: 10,
    throttle: 0.55,
    keys: [
      { at: 0.0, eye: [-248, 104, -176], look: ISLAND_LOOK },
      { at: 0.4, eye: [-282, 100, -84], look: [-1120, 52, -700] },
      { at: 0.8, eye: [-286, 92, 14], look: [-1080, 46, -620] },
    ],
  },
  {
    // Back toward the plateau, descending, with the weather making up behind.
    //
    // The slowest beat on the lap by some way — 13 m/s against a median of 22 —
    // and that is deliberate: it sits between the two widest turns, so the
    // lateral acceleration it would otherwise carry is exactly where a viewer
    // would feel the circuit as a circuit rather than as a flight.
    name: 'return',
    duration: 8,
    throttle: 0.55,
    keys: [
      { at: 0.0, eye: [-272, 82, 58], look: [-1040, 40, -560] },
      { at: 0.5, eye: [-236, 60, 116], look: [-620, 22, -320] },
    ],
  },
  {
    // Weather, over open water, after dark — and the night watch, in one beat.
    //
    // The previous flight spent twenty seconds on the squall and fourteen more
    // on a separate night beat. At sixty seconds there is no room for both, and
    // they want the same conditions anyway: the tour's day has the sun below the
    // horizon across this whole stretch, so the second key frames the hull under
    // rain at 01:00 and covers what the night watch used to. Moon glitter, the
    // star field, a wet hull and rain on the lens are all in the same shot.
    //
    // Low and level. A squall read from above is a grey frame; read from twenty
    // metres with the swell running past the lens it is weather.
    name: 'squall',
    duration: 8,
    throttle: 0.35,
    keys: [
      { at: 0.0, eye: [-198, 42, 110], look: [-300, 14, -140] },
      { at: 0.5, eye: [-186, 24, 32], look: 'ship' },
    ],
  },
  {
    // Down through the surface, along the reef, and up onto the opening mark.
    //
    // The route is a line drawn between the places the reef actually is, not a
    // shape chosen for the camera: `reefPatches` puts a patch at (−97, −102) and
    // this runs *past* it, roughly level with the fish, which mill some three
    // metres off a floor near −16.5.
    //
    // Past it, not over it, and the distinction is the whole shot. The first cut
    // of this beat put a key at (−88, −98) — eleven metres from the patch, which
    // sounded like the right answer and photographed open sand, because the
    // coral was directly beneath the lens while the look target was eighty
    // metres ahead. A camera *on* a subject cannot frame it. The keys now pass
    // some thirty metres to seaward with the look leading along the run, so the
    // patch comes up in the middle of frame and goes by.
    //
    // It is also routed *clear of the hull*. The ship closes its own circuit at
    // the end of the lap, which brings it back through the origin on very nearly
    // this heading — the first cut of this beat ran straight down the hull's
    // track and passed 22 m from it, which collapsed the look reach and put a
    // 783°/s whip in the ascent. Offsetting the run to seaward keeps 80 m of
    // water between them.
    //
    // The last key hands the frame back to the hull while the camera is still
    // rising and moving away from it — a pull-back rather than a turn — so the
    // wrap arrives on the same composition `open-water` opens on. The spline
    // makes the loop continuous; this is what makes it unwatchable as an edit.
    name: 'reef-run',
    duration: 12,
    throttle: 0.25,
    keys: [
      { at: 0.0, eye: [-196, 8, -40], look: [-160, -6, -92] },
      { at: 0.25, eye: [-158, -9, -86], look: [-92, -14, -104] },
      { at: 0.5, eye: [-100, -11, -104], look: [-24, -13, -88] },
      { at: 0.75, eye: [-14, -7, -84], look: 'ship' },
    ],
  },
];

// ------------------------------------------------------------ derived timeline

/** Seconds for one lap of the flight and one lap of the hull's circuit. */
export const CINEMATIC_LOOP_SECONDS = BEATS.reduce((sum, beat) => sum + beat.duration, 0);

/** Absolute loop time each beat starts at. */
const BEAT_START = (() => {
  const starts = new Float64Array(BEATS.length);
  let t = 0;
  for (let i = 0; i < BEATS.length; i++) {
    starts[i] = t;
    t += BEATS[i].duration;
  }
  return starts;
})();

/**
 * Nominal speed through the water for each beat, m/s.
 *
 * Terminal speed under quadratic drag goes as the square root of thrust, so a
 * throttle of `T` settles at `HULL_TOP_SPEED * sqrt(T)`. Nominal because the
 * real hull spends a few seconds spooling onto it and loses a little to the
 * keel in a turn; the difference shows up as the ship sitting slightly inside
 * its authored circuit, never as it leaving.
 */
const BEAT_SPEED = (() => {
  const speeds = new Float64Array(BEATS.length);
  for (let i = 0; i < BEATS.length; i++) {
    speeds[i] = HULL_TOP_SPEED * Math.sqrt(Math.max(0, BEATS[i].throttle));
  }
  return speeds;
})();

/** Distance the hull has run by the start of each beat, metres. */
const BEAT_START_ARC = (() => {
  const arcs = new Float64Array(BEATS.length);
  let s = 0;
  for (let i = 0; i < BEATS.length; i++) {
    arcs[i] = s;
    s += BEAT_SPEED[i] * BEATS[i].duration;
  }
  return arcs;
})();

/** Total distance run in one lap, metres. */
const TOTAL_ARC =
  BEAT_START_ARC[BEATS.length - 1] + BEAT_SPEED[BEATS.length - 1] * BEATS[BEATS.length - 1].duration;

/**
 * Radius of the hull's circuit, metres.
 *
 * Not a tuning knob — it is the radius at which one lap of arc is exactly one
 * revolution, which is the whole reason the circuit closes. At the durations and
 * throttles above it comes out at 68 m, and the lap reaches 137 m from the
 * origin at its far point: well inside the shallow plateau's 320 m edge, so the
 * hull stays over turquoise water with the reef under it for the entire flight.
 *
 * It shrank from 161 m when the lap went from 166 s to 60. That is arithmetic
 * rather than a choice — a hull doing 7 m/s can only enclose so much water in a
 * minute — and it is worth knowing that it *cannot* be opened back out: at full
 * throttle throughout, a 60 s circuit tops out near 92 m. What it costs is that
 * the ship is visibly under helm rather than making a lazy sweep. 137 m of
 * tactical diameter is five hull lengths, which is what a 27 m vessel actually
 * turns in, so it reads as a ship being handled and not as one doing donuts.
 *
 * The rudder orders it implies are checked, not assumed: `BEAT_RUDDER` clamps at
 * 1, and a clamp there would quietly stop the circuit closing. The tightest beat
 * asks for 0.66.
 */
const TRACK_RADIUS = TOTAL_ARC / (2 * Math.PI);

/**
 * Rudder order for each beat, negative for port.
 *
 * Inverted out of the turn the beat has to make rather than authored: holding a
 * fixed radius while the speed changes needs the rudder to change with it, since
 * yaw rate is `speed / radius` and the controller delivers yaw rate
 * proportional to rudder. Port throughout, which curls the hull toward −Z and
 * therefore toward the island's half of the world.
 */
const BEAT_RUDDER = (() => {
  const rudders = new Float64Array(BEATS.length);
  for (let i = 0; i < BEATS.length; i++) {
    const speed = BEAT_SPEED[i];
    const yawRate = speed / TRACK_RADIUS;
    // A rudder is a foil: below the reference speed it delivers proportionally
    // less moment, so the order has to be correspondingly larger.
    const authority = Math.min(1, speed / HULL_RUDDER_REFERENCE_SPEED);
    const order = yawRate / (HULL_YAW_RATE_PER_RUDDER * Math.max(1e-3, authority));
    rudders[i] = -Math.min(1, order);
  }
  return rudders;
})();

/** Index of the beat containing `time`. `time` must already be wrapped. */
function beatAt(time: number): number {
  let i = BEATS.length - 1;
  while (i > 0 && BEAT_START[i] > time) i--;
  return i;
}

/**
 * Where the hull is at `time` if it flies the authored orders exactly.
 *
 * A circle of radius `TRACK_RADIUS` centred at `(0, -R)`, entered at the origin
 * on heading +X and traversed to port. Used only to resolve `'ship'` look
 * targets at build time — it is never compared against the live hull, because
 * reading the live hull is what would make a capture depend on what the physics
 * did before it.
 */
export function nominalShipXZ(time: number, out: THREE.Vector2): THREE.Vector2 {
  const beat = beatAt(time);
  const arc = BEAT_START_ARC[beat] + BEAT_SPEED[beat] * (time - BEAT_START[beat]);
  const turned = arc / TRACK_RADIUS;
  return out.set(TRACK_RADIUS * Math.sin(turned), -TRACK_RADIUS * (1 - Math.cos(turned)));
}

// ------------------------------------------------------------------ the spline

interface Track {
  count: number;
  /** Absolute loop time of each knot, ascending, starting at 0. */
  time: Float64Array;
  /** Seconds from each knot to the next, wrapping past the last. */
  span: Float64Array;
  /** Knot positions, xyz interleaved. */
  eye: Float64Array;
  look: Float64Array;
  /** Time derivatives at each knot, xyz interleaved, in metres per second. */
  eyeTangent: Float64Array;
  lookTangent: Float64Array;
  /** Beat owning each knot, so ship input and the label are a single lookup. */
  beat: Int32Array;
}

/**
 * Flattens the beats into one cyclic knot ring and precomputes its tangents.
 *
 * The tangents are the reason the loop has no seam. A uniform Catmull–Rom takes
 * `(P[i+1] - P[i-1]) / 2` per *knot interval*, which is only a velocity if every
 * interval is the same length; here they run from 4.5 s to 10 s, so that form
 * would hand the two sides of a knot different speeds and put a visible kick in
 * the motion at every beat boundary — the wrap included, where it would read as
 * a cut. Dividing by the two intervals' combined *duration* instead makes the
 * tangent a genuine metres-per-second, and Hermite's endpoint conditions then
 * guarantee the outgoing velocity at a knot equals the incoming one.
 *
 * Indices are taken modulo the ring, so the last knot's tangent looks forward
 * into the first and the first looks back into the last. The wrap is not a
 * special case anywhere in this file.
 */
function buildTrack(beats: readonly Beat[]): Track {
  let count = 0;
  for (const beat of beats) count += beat.keys.length;

  const track: Track = {
    count,
    time: new Float64Array(count),
    span: new Float64Array(count),
    eye: new Float64Array(count * 3),
    look: new Float64Array(count * 3),
    eyeTangent: new Float64Array(count * 3),
    lookTangent: new Float64Array(count * 3),
    beat: new Int32Array(count),
  };

  const shipXZ = new THREE.Vector2();
  let k = 0;
  for (let b = 0; b < beats.length; b++) {
    const beat = beats[b];
    for (const key of beat.keys) {
      const time = BEAT_START[b] + key.at * beat.duration;
      track.time[k] = time;
      track.beat[k] = b;
      track.eye[k * 3] = key.eye[0];
      track.eye[k * 3 + 1] = key.eye[1];
      track.eye[k * 3 + 2] = key.eye[2];

      if (key.look === 'ship') {
        // Resolved here rather than per frame. The nominal hull is closed-form
        // either way, but baking it keeps the runtime a pure spline evaluation —
        // and mixing a live term into two of the knots would break exactly the
        // C¹ property the rest of this function exists to establish. The cost is
        // that the aim point follows the chord between knots rather than the
        // hull's arc, which at ~10 s spacing on a 160 m circle is about 6 m of
        // lead against a subject a hundred metres away.
        nominalShipXZ(time, shipXZ);
        track.look[k * 3] = shipXZ.x;
        track.look[k * 3 + 1] = SHIP_LOOK_HEIGHT;
        track.look[k * 3 + 2] = shipXZ.y;
      } else {
        track.look[k * 3] = key.look[0];
        track.look[k * 3 + 1] = key.look[1];
        track.look[k * 3 + 2] = key.look[2];
      }
      k++;
    }
  }

  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    // The final span runs off the end of the lap and back onto knot 0, which is
    // the only place the ring's closure appears as arithmetic.
    track.span[i] = next === 0 ? CINEMATIC_LOOP_SECONDS - track.time[i] : track.time[next] - track.time[i];
  }

  for (let i = 0; i < count; i++) {
    const previous = (i - 1 + count) % count;
    const next = (i + 1) % count;
    const window = track.span[previous] + track.span[i];
    for (let c = 0; c < 3; c++) {
      track.eyeTangent[i * 3 + c] =
        (TENSION * (track.eye[next * 3 + c] - track.eye[previous * 3 + c])) / window;
      track.lookTangent[i * 3 + c] =
        (TENSION * (track.look[next * 3 + c] - track.look[previous * 3 + c])) / window;
    }
  }

  return track;
}

const TRACK = buildTrack(BEATS);

/** Cubic Hermite on one component. `span` converts the tangents out of per-second. */
function hermite(p0: number, m0: number, p1: number, m1: number, span: number, s: number): number {
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  return h00 * p0 + h10 * span * m0 + h01 * p1 + h11 * span * m1;
}

function sampleCurve(
  points: Float64Array,
  tangents: Float64Array,
  index: number,
  next: number,
  span: number,
  s: number,
  out: THREE.Vector3,
): void {
  out.set(
    hermite(points[index * 3], tangents[index * 3], points[next * 3], tangents[next * 3], span, s),
    hermite(
      points[index * 3 + 1],
      tangents[index * 3 + 1],
      points[next * 3 + 1],
      tangents[next * 3 + 1],
      span,
      s,
    ),
    hermite(
      points[index * 3 + 2],
      tangents[index * 3 + 2],
      points[next * 3 + 2],
      tangents[next * 3 + 2],
      span,
      s,
    ),
  );
}

// -------------------------------------------------------------------- the mode

/** Camera pose the flight wants this frame. */
export interface CinematicPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

/** What the flight is asking of the hull this frame. Same units as `setInput`. */
export interface CinematicShipInput {
  /** −1 (full astern) … 1 (full ahead). */
  throttle: number;
  /** −1 (hard to port) … 1 (hard to starboard). */
  rudder: number;
}

/** Beat names and durations, in order. For a HUD, a scrubber or a capture list. */
export const CINEMATIC_BEATS: ReadonlyArray<{ readonly name: string; readonly duration: number }> =
  BEATS.map((beat) => ({ name: beat.name, duration: beat.duration }));

/**
 * Everything about the world, other than the camera and the hull, that the tour
 * owns while it is running.
 *
 * Every field is a pure, periodic, closed-form function of the loop clock — the
 * same rule the pose and the ship orders already follow, and for the same
 * reason. `resetClock(t)` has to reproduce a frame *exactly*, lighting and
 * weather included, or every cinematic baseline becomes a function of how many
 * frames happened to run before the capture.
 */
export interface CinematicEnvironment {
  /** Hour of the day, 0..24. */
  hours: number;
  /** Rain rate, 0..1. */
  rain: number;
  /** Cloud coverage, 0..1. */
  cloudCoverage: number;
  /** Multiplier on the preset's volumetric fog density. */
  fogDensity: number;
  /**
   * Which weather to draw, and this is not cosmetic.
   *
   * `Weather` refuses to draw anything at all while its kind is `'clear'`,
   * whatever the intensity, and `main.update` computes the `raining` scalar that
   * drives the lens beads, the surface ring stipple, the whitecap agitation and
   * the hull wetting as `kind === 'rain' ? intensity : 0`. Every clear preset
   * declares `'clear'`. So a squall that set only the intensity would produce no
   * weather anywhere — and would look exactly like a bug in the curves rather
   * than a missing field.
   */
  weatherKind: 'clear' | 'rain';
}

/** Warped day phase. See `HOUR_WARP_AMOUNT` for what the warp is for. */
function tourHours(time: number): number {
  const x = time / CINEMATIC_LOOP_SECONDS;
  const warped =
    x + (HOUR_WARP_AMOUNT / (Math.PI * 2)) * Math.sin(Math.PI * 2 * (x - HOUR_WARP_PHASE));
  const hours = (warped * 24 + HOUR_AT_ORIGIN) % 24;
  return hours < 0 ? hours + 24 : hours;
}

/**
 * Rain rate at a loop time.
 *
 * A raised cosine, and the shape is the point: it reaches zero *with zero
 * derivative* at both ends, so the weather makes up and clears without a corner
 * in it. A clamped linear ramp would be continuous and not C¹, and that kink
 * reads as the rain visibly changing gear — the same class of defect the camera
 * spline is built to avoid, moved to the sky.
 *
 * The distance to the centre is measured *around the loop*, so a squall that
 * straddled the wrap would still be one squall.
 */
function tourRain(time: number): number {
  let d = Math.abs(time - RAIN_CENTRE_SECONDS);
  if (d > CINEMATIC_LOOP_SECONDS / 2) d = CINEMATIC_LOOP_SECONDS - d;
  if (d >= RAIN_HALF_WIDTH_SECONDS) return 0;
  return RAIN_PEAK * 0.5 * (1 + Math.cos((Math.PI * d) / RAIN_HALF_WIDTH_SECONDS));
}

export class CinematicDirector {
  private enabled = false;
  private clock = 0;

  /**
   * Returned by `update` rather than allocated per frame. The caller is expected
   * to read it immediately and not retain it.
   */
  private readonly input: CinematicShipInput = { throttle: 0, rudder: 0 };

  /**
   * Returned by `environment` rather than allocated per call, for the same
   * reason `input` is: this is read every frame and the frame path must not
   * allocate. Callers are expected to read it immediately and not retain it.
   */
  private readonly env: CinematicEnvironment = {
    hours: 12,
    rain: 0,
    cloudCoverage: 0.3,
    fogDensity: 1,
    weatherKind: 'clear',
  };

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Position on the loop, seconds. Always in `[0, CINEMATIC_LOOP_SECONDS)`. */
  get time(): number {
    return this.clock;
  }

  /** Name of the beat playing at the current clock. */
  get beatName(): string {
    return BEATS[beatAt(this.clock)].name;
  }

  /**
   * The world the tour wants this frame, other than the camera and the hull.
   *
   * A pure function of the loop clock and nothing else, which is what keeps it
   * inside the same guarantee the rest of this class carries: `resetClock(t)`
   * followed by a capture reproduces the frame exactly, lighting and weather
   * included. An accumulator here — "advance the weather a little each frame" —
   * would have been simpler to write and would have made every cinematic
   * baseline depend on how many frames had been rendered before it.
   *
   * @param time Loop position to sample. Defaults to the live clock. The
   *   explicit form is what lets a deterministic reset ask "what should the
   *   world look like at the moment I am about to rewind to" *before* seeding
   *   the accumulating effects — see `resetDeterministic`.
   */
  environment(time: number = this.clock): Readonly<CinematicEnvironment> {
    const t = wrapTime(time);
    const rain = tourRain(t);
    const env = this.env;
    env.hours = tourHours(t);
    env.rain = rain;
    // Cloud builds with the rain and does not entirely clear afterwards, which
    // is what stops the squall reading as a rain layer switched on under an
    // otherwise blue sky.
    env.cloudCoverage = 0.3 + rain * 0.62;
    // Rain thickens the air between the viewer and everything else. Multiplier
    // rather than an absolute, so a preset's own medium still decides what a
    // squall over *this* place looks like.
    env.fogDensity = 1 + rain * 1.7;
    env.weatherKind = rain > 0.001 ? 'rain' : 'clear';
    return env;
  }

  /**
   * Starts or stops the flight.
   *
   * Enabling rewinds to the opening beat. A cinematic that resumed wherever it
   * was last left would drop the viewer into the middle of the underwater run
   * with no idea what they were looking at; the flight is authored to open on
   * the ship at speed, and that is the only sensible entry point. Use
   * `resetClock` immediately after if some other time is wanted.
   *
   * Disabling zeroes the ship input on the spot. `ShipController.setEnabled`
   * clears its *spooled* throttle and rudder but not the last value handed to
   * `setInput`, so a stale order left here would be picked straight back up the
   * next time the hull is put under manual control — a ship that starts driving
   * itself the moment Boat mode is selected.
   */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    this.input.throttle = 0;
    this.input.rudder = 0;
    if (on) this.clock = 0;
  }

  /**
   * Jumps to `time` on the loop.
   *
   * The deterministic entry point: the very next `update(0, …)` reports exactly
   * the pose and the ship order that belong to that time, with no settling and
   * no dependence on what the flight was doing beforehand.
   */
  resetClock(time = 0): void {
    this.clock = wrapTime(time);
  }

  /**
   * Advances the clock and samples it.
   *
   * Advance-then-sample, so `resetClock(t)` followed by `update(0, …)` reports
   * the pose at exactly `t` — which is the sequence a capture harness runs, and
   * the reason the ordering is spelled out rather than left to taste.
   *
   * Returns the hull's orders for this frame; the caller forwards them to
   * `ShipController.setInput`. When disabled the orders are zero and `out` is
   * left untouched, so a caller that keeps forwarding after the mode ends
   * releases the hull rather than freezing it under power.
   */
  update(dt: number, out: CinematicPose): CinematicShipInput {
    if (!this.enabled) {
      this.input.throttle = 0;
      this.input.rudder = 0;
      return this.input;
    }

    this.clock = wrapTime(this.clock + (Number.isFinite(dt) ? dt : 0));

    let index = TRACK.count - 1;
    while (index > 0 && TRACK.time[index] > this.clock) index--;
    const next = (index + 1) % TRACK.count;
    const span = TRACK.span[index];
    const s = span > 0 ? Math.min(1, Math.max(0, (this.clock - TRACK.time[index]) / span)) : 0;

    sampleCurve(TRACK.eye, TRACK.eyeTangent, index, next, span, s, out.position);
    sampleCurve(TRACK.look, TRACK.lookTangent, index, next, span, s, out.target);

    const beat = TRACK.beat[index];
    this.input.throttle = BEATS[beat].throttle;
    this.input.rudder = BEAT_RUDDER[beat];
    return this.input;
  }
}

/**
 * Folds any time onto the loop.
 *
 * Handles negatives, because `resetClock(-2)` meaning "two seconds before the
 * loop point" is a reasonable thing for a harness to ask and JavaScript's `%`
 * would answer with a negative index into the knot ring.
 */
function wrapTime(time: number): number {
  if (!Number.isFinite(time)) return 0;
  const wrapped = time % CINEMATIC_LOOP_SECONDS;
  return wrapped < 0 ? wrapped + CINEMATIC_LOOP_SECONDS : wrapped;
}
