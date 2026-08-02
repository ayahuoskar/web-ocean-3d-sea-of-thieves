import * as THREE from 'three/webgpu';
import {
  Fn,
  attribute,
  cameraPosition,
  cos,
  faceDirection,
  float,
  mix,
  normalGeometry,
  positionGeometry,
  positionWorld,
  select,
  sin,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import { mulberry32 } from '../core/random';
import { seafloorHeight } from './Seafloor';

/**
 * Schools of reef fish over the shallow plateau.
 *
 * **Why the geometry is procedural rather than a downloaded asset.** A rigged
 * glTF fish under a licence this project can verify was not obtainable, and for
 * a school at this scale it would have been the wrong technique anyway: a rig
 * means either one skinned draw call per fish or a bone-texture animation
 * system, to carry a mesh that is never seen closer than a few metres through
 * turbid water. Fish swim by passing a travelling wave down the body, which is
 * a closed-form displacement — so the whole animation is four lines of vertex
 * arithmetic on a hand-built silhouette, and the entire population is one
 * `InstancedMesh` and one draw call.
 *
 * Three ideas carry the module.
 *
 * **The body wave is the animation.** A carangiform swimmer's lateral
 * displacement is `a(s) sin(omega t - k s)` along the body axis `s`, with the
 * amplitude envelope `a` growing toward the tail — the nose barely moves and
 * the caudal fin sweeps about a tenth of a body length either side. That is
 * evaluated per vertex, and the normal is corrected by the analytic slope of
 * the same expression, so the body genuinely undulates instead of shearing
 * flat. Per-fish phase offsets desynchronise the school.
 *
 * **The school frame is CPU-side; everything inside it is GPU-side.** Each
 * school's circuit is a closed-form sum of sinusoids, so the CPU can evaluate
 * its centre, heading and bank for any `t` in a handful of trig calls — and,
 * crucially, can call `seafloorHeight` there. The floor clamp therefore uses
 * the *real* heightfield rather than a shader approximation of it, and only
 * two `vec4`s per school ever reach the GPU. Individual fish are placed as
 * offsets in that frame, weaving on their own phases, so the school has volume
 * and is not a rigid formation.
 *
 * **Nothing accumulates.** Every visible quantity is a pure function of the
 * clock: `resetClock(t)` and `update()`-ing to `t` produce a bit-identical
 * frame, which is what the visual regression harness requires. There is not a
 * single integrated velocity or remembered position anywhere in the file.
 *
 * That last point is also why the two GPU clocks are *phases* rather than
 * seconds. The other animated systems in this project push wrapped seconds into
 * a float32 uniform and take a discontinuity once an hour; here the CPU keeps
 * the clock in float64 and hands the shader `omega t mod 2pi`, with every
 * shader-side frequency an integer multiple of the fundamental. The wrap is
 * then exactly invisible — a sine does not care which turn it is on — and the
 * phase never grows large enough for `sin` to lose precision to range
 * reduction.
 *
 * Known limitation: the floor clamp is against the sand, not against the reef
 * outcrops `Props` scatters on it. A school can pass through a tall boulder.
 * Fixing that needs the prop transforms, which live in another module and would
 * couple the two for a collision the camera almost never sees side-on.
 */

/**
 * TSL node objects are structurally dynamic and the generated typings cannot
 * express a uniform whose component type is only known at construction, nor the
 * per-component expressions built out of `attribute()`. Node-typed values are
 * therefore `any` by design — the class's public API stays typed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;

/**
 * `vec3` under a loose signature. Composing per-component expressions out of
 * `attribute()` values produces `any`, which the overloaded TSL typings then
 * resolve to the wrong constructor; the runtime behaviour is unaffected.
 */
const vec3n = vec3 as unknown as (x: unknown, y: unknown, z: unknown) => Node;

/**
 * Local seed. `core/random` owns the shared `SEEDS` table and this module may
 * not edit it, so the constant lives here — a literal, for the same reason the
 * shared ones are: a baseline capture is only comparable to a later run if it
 * never drifts, and a drift has to be visible in a diff.
 */
const FISH_SEED = 0x5f15c4;

/** Instance buffer capacity. `setCount` draws a prefix of it — see `setCount`. */
const MAX_FISH = 480;

/**
 * Independent schools.
 *
 * More than one because a single shoal is off camera most of the time: the
 * circuit takes ten minutes and the viewer is usually near the origin looking
 * one way. Four covers the reef well enough that something is nearly always in
 * frame, and it is a compile-time constant so the per-school uniforms can be
 * chosen with a `select` chain instead of a dynamically indexed array — the
 * latter is legal on both backends but is the kind of thing WebGL2 drivers have
 * historically been bad at, for no gain at four entries.
 */
const SCHOOLS = 4;

// ------------------------------------------------------------------ the circuit

/**
 * Radial band the school centres wander in, metres from the origin.
 *
 * `Props` scatters the reef between 26 m and 260 m, and the base radii and
 * wander amplitudes below are chosen so `r(t)` stays inside 29..232 m without
 * ever needing a clamp. That matters more than it sounds: a clamp on `r` would
 * put a corner in the path, and the heading and bank are read from finite
 * differences of it, so a corner would be a visible flick of the whole school.
 *
 * The four base radii are *stratified* over the band — one per quarter, jittered
 * inside it — rather than drawn independently. Four independent draws from this
 * range land within 40 m of each other about a fifth of the time, and the seed
 * this module shipped with was one of those: every school ended up beyond 165 m,
 * where a 0.45 m fish through this water is a smudge. Stratifying makes the
 * coverage a property of the layout instead of a property of the seed.
 */
const RADIUS_MIN = 55;
const RADIUS_MAX = 200;

/** Cruise speed range, m/s. The angular rate is derived from it, not chosen. */
const CRUISE_MIN = 0.9;
const CRUISE_MAX = 1.4;

/** Radial wander: two out-of-phase terms, so the circuit is not a circle. */
const WANDER_R1 = 22;
const WANDER_W1 = 0.011;
const WANDER_R2 = 9;
const WANDER_W2 = 0.028;

/** Preferred depth below mean sea level, metres, before the floor clamp. */
const DEPTH_MIN = 6.5;
const DEPTH_MAX = 10.5;
const DEPTH_SWING = 2.8;

/**
 * School envelope, metres. Length runs along the heading, width across it.
 *
 * A tension, resolved toward the tighter shoal: a wide school is in frame more
 * often, a tight one actually looks like a school. At 34 x 18 m a full-tier
 * shoal of 120 sits about three metres apart — loose for a reef fish, but this
 * is a school crossing open water between outcrops rather than one balled up
 * against a predator, and the four separate circuits already buy back the
 * coverage a wider envelope would have.
 */
const SCHOOL_LENGTH = 34;
const SCHOOL_WIDTH = 18;
const SCHOOL_HALF_HEIGHT = 3.0;

/**
 * Half-size of the square the floor is probed over, metres.
 *
 * Covers the school envelope at any heading: the corner of the 34 x 18 m box
 * plus the weave amplitudes sits at 22.5 m from the centre, whichever way it is
 * rotated. Probed on a 3x3 grid rather than densely — measured against a 3 m
 * scan of the same square over the whole radial band, the grid underestimates
 * the true maximum by at most 0.33 m, which `FLOOR_CLEARANCE` absorbs several
 * times over.
 */
const FOOTPRINT = 23;

/**
 * Metres of water kept between the lowest fish and the sand.
 *
 * The floor under the reef band tops out at -14.7 m, so this leaves the school
 * at least 2 m of clearance in the worst place on the circuit and several times
 * that in the typical one. It is not a safety epsilon — it is the height a
 * school of fish visibly holds off the bottom.
 */
const FLOOR_CLEARANCE = 2.5;

/**
 * Metres kept between the highest fish and mean sea level.
 *
 * Against the *displaced* surface, not the mean plane: a trough of a metre or
 * two passes overhead in any real sea state, and a fish that breaches reads as
 * a bug instantly. Three metres survives the swell this project generates.
 */
const SURFACE_CLEARANCE = 3.0;

/**
 * Central-difference half-step for heading and bank, seconds.
 *
 * A quarter second is about half a metre of travel at cruise, which is a
 * well-conditioned baseline for `atan2`. Much shorter and the floor clamp's own
 * steps start to dominate the vertical component of the heading; much longer
 * and the bank lags the turn it is supposed to be anticipating.
 */
const DERIV_H = 0.25;

/**
 * Turn rate to roll, seconds, and the cap on the result.
 *
 * Not the coordinated-turn relation. `tan(roll) = v * omega / g` is the right
 * answer for something held up by a wing, and for a school circling at a
 * hundredth of a radian per second it evaluates to a fifth of a degree —
 * invisible. A neutrally buoyant fish is not fighting gravity at all; it rolls
 * because rolling is how it points its thrust, and it rolls hard. Ten seconds
 * puts the widest turn on the circuit a little past ten degrees and the typical
 * one at three or four, which is the "slightly" this is meant to read as. The
 * cap is there for the degenerate case, not for the circuit.
 */
const BANK_SECONDS = 10.0;
const BANK_MAX = 0.32;

/**
 * Ceiling on the school's climb angle, as a slope.
 *
 * The depth wander and the floor clamp together never produce more than a few
 * degrees, so this only exists to keep the shader's horizontal frame —
 * `normalize(forward.xz)` — away from a degenerate zero-length vector if the
 * heightfield ever handed the clamp a step.
 */
const PITCH_MAX = 0.25;

// ------------------------------------------------------------------- the weave

/**
 * Fundamental of the individual weave, rad/s. About a minute per cycle.
 *
 * Every other weave frequency in the shader is an integer multiple of this one,
 * which is what lets the phase uniform wrap at 2pi with no discontinuity. Fish
 * do not really share a fundamental; the seeded phase offsets hide it
 * completely, and the alternative — independent rates — is what forces the
 * float32 clock this module exists to avoid.
 */
const WEAVE_OMEGA = 0.11;

/** Weave amplitudes within the school frame, metres. */
const WEAVE_ALONG = 2.5;
const WEAVE_LATERAL = 2.2;

/**
 * Yaw the weave induces, radians.
 *
 * A fish points where it is going. The lateral weave peaks at about 0.24 m/s
 * against a ~1.2 m/s cruise, so the heading offset is around a tenth of a
 * radian, and it is in quadrature with the offset itself because it is the
 * offset's derivative — which is why it reads as swimming rather than as
 * sliding sideways.
 */
const WEAVE_YAW = 0.2;

/** Roll the weave induces, radians. In antiphase with the lateral offset. */
const WEAVE_ROLL = 0.16;

// -------------------------------------------------------------------- the body

/**
 * Tail beat, Hz.
 *
 * Not decorative. Fish cover roughly two thirds of a body length per beat, so a
 * 0.42 m fish cruising at 1.2 m/s — which is what the circuit above implies —
 * beats a little over four times a second. 3.4 Hz is a shade under that, chosen
 * because the honest figure flickers at distance where the tail is a couple of
 * pixels wide and reads as aliasing rather than as swimming.
 */
const BEAT_HZ = 3.4;

/** Body wavelength as a fraction of body length; carangiform swimmers run near 1. */
const WAVE_LENGTH = 1.1;
const WAVE_K = (Math.PI * 2) / WAVE_LENGTH;

/**
 * Lateral amplitude at the tail base, in body lengths.
 *
 * The envelope is `AMP * s^2` with `s` running 0 at the nose to 1 at the tail
 * base and ~1.19 at the caudal tips, so the tips sweep about 0.12 L either
 * side. Measured carangiform envelopes are close to quadratic and land at
 * 0.1 L at the peduncle; the quadratic is the cheap version of the same curve
 * and gets the important part right, which is that the head is almost still.
 */
const WAVE_AMP = 0.085;

/** Nominal body length, metres, before per-fish and per-school variation. */
const FISH_LENGTH = 0.42;

/**
 * Body silhouette: half-height and half-width at stations along the body.
 *
 * `u` runs 0 at the nose to 1 at the tail, and the two apexes are implicit — the
 * rings below are lofted between a nose point and a peduncle point. Taller than
 * wide by roughly two to one, because a reef fish is laterally compressed and
 * that compression is most of what makes the silhouette legible.
 */
const BODY_STATIONS: ReadonlyArray<{ u: number; halfHeight: number; halfWidth: number }> = [
  { u: 0.1, halfHeight: 0.062, halfWidth: 0.034 },
  { u: 0.24, halfHeight: 0.108, halfWidth: 0.055 },
  { u: 0.4, halfHeight: 0.118, halfWidth: 0.058 },
  { u: 0.56, halfHeight: 0.1, halfWidth: 0.046 },
  { u: 0.74, halfHeight: 0.07, halfWidth: 0.03 },
  { u: 0.9, halfHeight: 0.042, halfWidth: 0.016 },
];

/** Vertices per body ring. Six is enough at the sizes this is ever seen at. */
const RING = 6;

// ------------------------------------------------------------------- the colour

/** Dorsal, mid-flank and ventral tones. Counter-shading — see `buildMaterial`. */
const BACK_COLOR = new THREE.Color(0.055, 0.085, 0.1);
const FLANK_COLOR = new THREE.Color(0.42, 0.5, 0.53);
const BELLY_COLOR = new THREE.Color(0.8, 0.83, 0.8);

/** Skylight the fish sit in, and the direct sun on top of it. */
const AMBIENT_COLOR = new THREE.Color(0.24, 0.34, 0.38);
const SUN_COLOR = new THREE.Color(0.9, 0.88, 0.78);
const SUN_STRENGTH = 0.85;

/** Strength of the flank sheen. Small: it is a hint of colour, not a coating. */
const SHEEN = 0.07;

// ----------------------------------------------------------------- path records

/** One school's circuit. Every field is a constant of a closed-form path. */
interface SchoolPath {
  theta0: number;
  omega: number;
  radius: number;
  r1Phase: number;
  r2Phase: number;
  depth: number;
  depthRate: number;
  depthPhase: number;
}

export interface FishSchoolOptions {
  /** Overrides the seeded circuits and scatter; useful for A/B-ing a layout. */
  seed?: number;
}

/**
 * A population of reef fish in `SCHOOLS` independent shoals.
 *
 * Add `object` to the scene. It carries an identity transform and the vertex
 * stage emits world coordinates directly, so it must be parented to something
 * untransformed — the scene root — exactly as `UnderwaterParticles` is.
 */
export class FishSchool {
  readonly object: THREE.Object3D;

  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly mesh: THREE.InstancedMesh;
  private readonly paths: SchoolPath[] = [];

  private count: number;
  private wantVisible = true;
  private disposed = false;

  /**
   * Seconds, in float64, never wrapped.
   *
   * The GPU only ever sees phases derived from this, so there is no float32
   * range to protect and no reason to introduce a wrap discontinuity. `update`
   * advances it and `resetClock` sets it; nothing else reads or writes it.
   */
  private time = 0;

  // --- uniforms -------------------------------------------------------------
  /** Weave phase, radians in [0, 2pi). See `WEAVE_OMEGA`. */
  private readonly uWeave = uniform(0);
  /** Tail-beat phase, radians in [0, 2pi). */
  private readonly uBeat = uniform(0);
  /** Per school: xyz = centre, w = vertical half-extent the clamp allows. */
  private readonly uAnchors: Node[] = [];
  /** Per school: xyz = unit heading, w = bank angle. */
  private readonly uHeadings: Node[] = [];
  private readonly uSunDir = uniform(new THREE.Vector3(0.35, 0.62, 0.7).normalize());
  private readonly uSunColor = uniform(new THREE.Color(SUN_COLOR));
  private readonly uAmbient = uniform(new THREE.Color(AMBIENT_COLOR));
  private readonly uBack = uniform(new THREE.Color(BACK_COLOR));
  private readonly uFlank = uniform(new THREE.Color(FLANK_COLOR));
  private readonly uBelly = uniform(new THREE.Color(BELLY_COLOR));
  private readonly uSheen = uniform(SHEEN);

  // Scratch for the per-frame anchor solve. Reused — never reallocated.
  private readonly here = new THREE.Vector3();
  private readonly before = new THREE.Vector3();
  private readonly after = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();

  constructor(count: number, options: FishSchoolOptions = {}) {
    this.count = Math.max(0, Math.min(MAX_FISH, Math.floor(count)));

    const random = mulberry32(options.seed ?? FISH_SEED);

    // Per-school size class, drawn before the paths so both stay stable if
    // either gains a parameter later.
    const schoolScale: number[] = [];
    for (let k = 0; k < SCHOOLS; k++) schoolScale.push(0.8 + random() * 0.55);
    for (let k = 0; k < SCHOOLS; k++) this.paths.push(buildPath(k, random));

    for (let k = 0; k < SCHOOLS; k++) {
      this.uAnchors.push(uniform(new THREE.Vector4(0, -8, 0, SCHOOL_HALF_HEIGHT)));
      this.uHeadings.push(uniform(new THREE.Vector4(1, 0, 0, 0)));
    }

    this.geometry = buildFishGeometry();
    attachInstanceAttributes(this.geometry, schoolScale, options.seed ?? FISH_SEED);

    this.material = this.buildMaterial();

    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, MAX_FISH);
    this.mesh.name = 'fish';
    this.mesh.count = this.count;
    // The vertex stage writes world positions, so the instance matrix is dead
    // code — but `InstancedMesh` allocates it zero-filled, and an identity fill
    // costs one loop at startup and removes a whole category of "why is
    // everything at the origin" from anyone who later reads the buffer.
    identityInstanceMatrix(this.mesh.instanceMatrix);
    // Shadows off deliberately: a 0.4 m fish under ten metres of water casts
    // nothing the eye can find, and it would double the vertex cost of the
    // whole population to render the depth pass.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // The population spans a 500 m circle and moves; a bound derived from the
    // geometry would be meaningless, and there is only one draw call to save.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();

    this.object = new THREE.Object3D();
    this.object.name = 'fish-schools';
    this.object.frustumCulled = false;
    this.object.matrixAutoUpdate = false;
    this.object.updateMatrix();
    this.object.add(this.mesh);
    this.object.visible = this.count > 0;

    this.refresh();
  }

  getCount(): number {
    return this.count;
  }

  /**
   * Population for the current quality tier.
   *
   * Free, unlike the equivalent on the particle systems: the instance buffers
   * are built once at `MAX_FISH` and this only moves the draw's instance count.
   * That also makes a tier change *re-scale* the population rather than
   * reshuffle it — fish `i` keeps its school, size, offset and phase whatever
   * the count is, so dropping a tier thins the schools instead of replacing
   * them with different ones.
   */
  setCount(count: number): void {
    const next = Math.max(0, Math.min(MAX_FISH, Math.floor(count)));
    if (next === this.count) return;
    this.count = next;
    this.mesh.count = next;
    this.object.visible = this.wantVisible && next > 0;
  }

  setVisible(v: boolean): void {
    this.wantVisible = v;
    this.object.visible = v && this.count > 0;
  }

  /** `dir` points *toward* the sun and need not be normalised. */
  setSunDirection(dir: THREE.Vector3): void {
    const sun = this.uSunDir.value as THREE.Vector3;
    sun.copy(dir);
    if (sun.lengthSq() < 1e-8) sun.set(0, 1, 0);
    sun.normalize();
  }

  /**
   * Advances the clock and re-solves the four school frames.
   *
   * Runs whether or not the schools are visible, and that is deliberate: making
   * the clock depend on visibility would make the pose depend on the history of
   * `setVisible` calls, which is exactly the class of hidden state
   * `resetClock` exists to rule out. The cost is 108 heightfield evaluations —
   * four schools, three time samples, nine probes — which is well under a
   * hundredth of a millisecond.
   */
  update(dt: number): void {
    if (this.disposed) return;
    this.time += dt;
    this.refresh();
  }

  /** Jumps the clock, for reproducible captures. Identical to updating to `time`. */
  resetClock(time = 0): void {
    if (this.disposed) return;
    this.time = time;
    this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.remove(this.mesh);
    this.object.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }

  // ------------------------------------------------------------------ internals

  /**
   * Pushes the current pose into the uniforms.
   *
   * Heading and bank come from a central difference of the path rather than
   * from its analytic derivative, because the path the fish actually follow is
   * the *clamped* one — differencing the unclamped circuit would have the
   * school pointing along a heading it is not travelling wherever the floor
   * pushed it up.
   */
  private refresh(): void {
    const t = this.time;

    // Phases, reduced in float64 so the shader never sees a large argument.
    this.uWeave.value = wrapTau(t * WEAVE_OMEGA);
    this.uBeat.value = wrapTau(t * BEAT_HZ * Math.PI * 2);

    for (let k = 0; k < SCHOOLS; k++) {
      const path = this.paths[k];
      const half = solveAnchor(path, t, this.here);
      solveAnchor(path, t - DERIV_H, this.before);
      solveAnchor(path, t + DERIV_H, this.after);

      const f = this.forward.copy(this.after).sub(this.before);
      const run = Math.hypot(f.x, f.z);
      if (run < 1e-6) {
        f.set(1, 0, 0);
      } else {
        f.y = clampNumber(f.y, -PITCH_MAX * run, PITCH_MAX * run);
        f.normalize();
      }

      // Two headings a half-step apart give the turn rate the bank follows.
      const h0 = Math.atan2(this.here.z - this.before.z, this.here.x - this.before.x);
      const h1 = Math.atan2(this.after.z - this.here.z, this.after.x - this.here.x);
      const turn = wrapPi(h1 - h0) / DERIV_H;
      const bank = clampNumber(turn * BANK_SECONDS, -BANK_MAX, BANK_MAX);

      (this.uAnchors[k].value as THREE.Vector4).set(this.here.x, this.here.y, this.here.z, half);
      (this.uHeadings[k].value as THREE.Vector4).set(f.x, f.y, f.z, bank);
    }
  }

  private buildMaterial(): THREE.MeshBasicNodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial();
    material.name = 'fish-body';
    // The fins are single-sided sheets in the body's midplane. Without
    // `DoubleSide` a fish's tail blinks out every time the beat carries it past
    // edge-on, which at 3.4 Hz is a strobe rather than a glitch.
    material.side = THREE.DoubleSide;
    material.fog = false;

    const seed: Node = attribute('fishSeed', 'vec4');
    const trait: Node = attribute('fishTrait', 'vec4');
    const flank: Node = attribute('fishFlank', 'float');
    const p: Node = positionGeometry;
    const n: Node = normalGeometry;

    const anchor = pickPerSchool(this.uAnchors, trait.x);
    const heading = pickPerSchool(this.uHeadings, trait.x);

    // --- the school's horizontal frame -------------------------------------
    //
    // Offsets are laid out in the horizontal plane and along world up, not in
    // the school's tilted frame. That is what makes the vertical envelope the
    // CPU solved for *exact*: a pitched frame would convert some of the 17 m
    // along-axis offset into height, and the floor clearance would quietly
    // become a function of the climb angle.
    const f: Node = heading.xyz;
    const fh = vec3n(f.x, 0, f.z).normalize();
    const rh = vec3n(fh.z.negate(), 0, fh.x);

    // --- the individual's weave --------------------------------------------
    const phase = trait.w.mul(Math.PI * 2);
    const w: Node = this.uWeave;
    const weave = w.add(phase);
    const sLat = sin(weave);
    const cLat = cos(weave);
    const sVert = sin(w.mul(2).add(phase.mul(1.7)));
    const sAlong = sin(w.mul(3).add(phase.mul(2.3)));

    const along = seed.x.sub(0.5).mul(SCHOOL_LENGTH).add(sAlong.mul(WEAVE_ALONG));
    const lateral = seed.y.sub(0.5).mul(SCHOOL_WIDTH).add(sLat.mul(WEAVE_LATERAL));
    // Scaled by the clamp's own half-extent and bounded by construction: the
    // fixed and weaving parts sum to at most one, so no fish can leave the band
    // the CPU proved clear of the sand and the surface.
    const vertical = anchor.w.mul(seed.z.sub(0.5).mul(1.52).add(sVert.mul(0.24)));

    const centre = anchor.xyz
      .add(fh.mul(along))
      .add(rh.mul(lateral))
      .add(vec3n(0, vertical, 0));

    // --- the individual's frame --------------------------------------------
    // Yaw leads the weave by a quarter cycle because it is the weave's
    // derivative; roll trails it by half, because a fish rolls into the turn
    // and the turn is sharpest where the lateral offset is at its extreme.
    const yaw = cLat.mul(WEAVE_YAW);
    const bank = heading.w.sub(sLat.mul(WEAVE_ROLL));

    const axisF = f.add(rh.mul(yaw)).normalize();
    const axisR0 = axisF.cross(vec3(0, 1, 0)).normalize();
    const axisU0 = axisR0.cross(axisF);
    const cb = cos(bank);
    const sb = sin(bank);
    const axisR = axisR0.mul(cb).add(axisU0.mul(sb));
    const axisU = axisU0.mul(cb).sub(axisR0.mul(sb));

    // --- the travelling body wave ------------------------------------------
    // `s` is the body axis: 0 at the nose, 1 at the peduncle, ~1.19 at the
    // caudal tips, which is why the tail sweeps hardest without needing a
    // separate term for the fin.
    const s = float(0.5).sub(p.x);
    const beat = this.uBeat.add(seed.w.mul(Math.PI * 2)).sub(s.mul(WAVE_K));
    const amp = s.mul(s).mul(WAVE_AMP);
    const swing = sin(beat).mul(amp);

    // d(swing)/dx of `amp(s) sin(phi - k s)` with s = 0.5 - x. Both terms kept:
    // dropping the envelope's contribution leaves the tail's normal lagging its
    // own silhouette by a noticeable amount at the extremes of the beat.
    const slope = amp.mul(WAVE_K).mul(cos(beat)).sub(s.mul(2 * WAVE_AMP).mul(sin(beat)));

    // Inverse transpose of the shear this displacement is: for `z += g(x)` the
    // normal maps as `(nx - g' nz, ny, nz)`. Two operations, and without it a
    // swimming fish is lit as though it were rigid.
    const localN = vec3n(n.x.sub(slope.mul(n.z)), n.y, n.z).normalize();

    const size = trait.y;
    const world = centre
      .add(axisF.mul(p.x.mul(size)))
      .add(axisU.mul(p.y.mul(size)))
      .add(axisR.mul(p.z.add(swing).mul(size)));

    const worldNormal = axisF
      .mul(localN.x)
      .add(axisU.mul(localN.y))
      .add(axisR.mul(localN.z));

    material.positionNode = world;

    const vNormal: Node = varying(worldNormal, 'fishNormal');

    material.colorNode = Fn(() => {
      // `faceDirection` rather than a two-sided lighting hack: the fins are
      // genuinely seen from both faces and their normal is genuinely flipped.
      const normal = vNormal.normalize().mul(faceDirection).toVar();
      const view = cameraPosition.sub(positionWorld).normalize().toVar();

      const key = normal.dot(this.uSunDir).clamp(0, 1).toVar();
      // Skylight arrives from above and is what fills the shaded side; a
      // constant ambient would flatten the body into a cut-out.
      const sky = normal.y.mul(0.5).add(0.5).toVar();

      // --- counter-shading ---------------------------------------------------
      //
      // Dark back, silver flank, pale belly. This is not stylisation: pelagic
      // fish are pigmented exactly this way so that the shadow cast by their own
      // body is cancelled by the gradient, and it is the single strongest cue
      // that a small dark shape in blue water is a fish. It also happens to be
      // the thing that still reads at fifty metres through this project's water,
      // where a PBR treatment would resolve to one flat tone.
      //
      // Driven by a baked body coordinate, not by the normal: the pigment
      // gradient runs over the flank, which on a laterally compressed fish is
      // almost entirely surface whose normal points sideways.
      const t = flank.mul(0.5).add(0.5).toVar();
      const base = mix(this.uBelly, this.uFlank, t.smoothstep(0.0, 0.45)).toVar();
      base.assign(mix(base, this.uBack, t.smoothstep(0.52, 0.95)));
      // A degree of per-fish tint, so a school is not one repeated animal.
      base.mulAssign(mix(vec3(0.93, 0.99, 1.04), vec3(1.07, 1.0, 0.93), trait.w));

      const light = this.uAmbient
        .mul(sky.mul(0.65).add(0.35))
        .add(this.uSunColor.mul(key).mul(SUN_STRENGTH));

      // --- flank sheen -------------------------------------------------------
      //
      // A cosine palette over a view-dependent term: three cosines, no texture,
      // no thin-film integral. It is not a physical iridescence model and does
      // not claim to be — what it reproduces is the one behaviour that matters
      // at this distance, which is that the colour of the band slides as the
      // fish turns rather than staying painted on.
      //
      // Masked to the lateral line and multiplied by the key light, so it can
      // only ever brighten a lit flank and never haloes the silhouette.
      const fresnel = float(1).sub(normal.dot(view).abs()).toVar();
      const band = fresnel.mul(2.4).add(float(0.5).sub(p.x).mul(1.7)).add(trait.w);
      const iri = cos(vec3(band).add(vec3(0, 0.31, 0.62)).mul(Math.PI * 2)).mul(0.5).add(0.5);
      const sheen = iri
        .mul(this.uSheen)
        .mul(float(1).sub(flank.mul(flank)))
        .mul(fresnel)
        .mul(key.mul(0.7).add(0.3));

      return vec4(base.mul(light).add(sheen), 1);
    })();

    return material;
  }
}

// --------------------------------------------------------------------- the path

function buildPath(index: number, random: () => number): SchoolPath {
  // One school per quarter of the radial band, jittered within it. See RADIUS_MIN.
  const slice = (RADIUS_MAX - RADIUS_MIN) / SCHOOLS;
  const radius = RADIUS_MIN + (index + 0.15 + random() * 0.7) * slice;
  const cruise = CRUISE_MIN + random() * (CRUISE_MAX - CRUISE_MIN);
  // Angular rate derived from a cruise speed rather than chosen directly, so a
  // school on the outer edge of the band does not lap one on the inner edge at
  // four times the tail-beat-implied speed.
  const direction = random() < 0.5 ? -1 : 1;

  return {
    theta0: random() * Math.PI * 2,
    omega: (direction * cruise) / radius,
    radius,
    r1Phase: random() * Math.PI * 2,
    r2Phase: random() * Math.PI * 2,
    depth: DEPTH_MIN + random() * (DEPTH_MAX - DEPTH_MIN),
    depthRate: 0.012 + random() * 0.018,
    depthPhase: random() * Math.PI * 2,
  };
}

/**
 * The school centre at time `t`, and the vertical half-extent its members may
 * occupy around it.
 *
 * The band is solved rather than assumed. `bottom` is the highest floor found
 * under the school's footprint plus a clearance, `top` is the surface less its
 * own; the half-extent is whatever fits inside, and the centre is then placed
 * so that the whole envelope does. That ordering matters in the degenerate case
 * where the two limits cross — the band collapses to a single depth *under the
 * surface* rather than resolving in favour of the floor, because a fish in the
 * sand is a curiosity and a fish in the air is a bug report.
 */
function solveAnchor(path: SchoolPath, t: number, out: THREE.Vector3): number {
  const theta = path.theta0 + path.omega * t;
  const r =
    path.radius +
    WANDER_R1 * Math.sin(WANDER_W1 * t + path.r1Phase) +
    WANDER_R2 * Math.sin(WANDER_W2 * t + path.r2Phase);

  const x = Math.cos(theta) * r;
  const z = Math.sin(theta) * r;
  const wanted = -(path.depth + DEPTH_SWING * Math.sin(path.depthRate * t + path.depthPhase));

  let floorMax = Number.NEGATIVE_INFINITY;
  for (let ix = -1; ix <= 1; ix++) {
    for (let iz = -1; iz <= 1; iz++) {
      const h = seafloorHeight(x + ix * FOOTPRINT, z + iz * FOOTPRINT);
      if (h > floorMax) floorMax = h;
    }
  }

  const top = -SURFACE_CLEARANCE;
  let bottom = floorMax + FLOOR_CLEARANCE;
  if (bottom > top) bottom = top;

  const half = Math.min(SCHOOL_HALF_HEIGHT, (top - bottom) * 0.5);
  out.set(x, clampNumber(wanted, bottom + half, top - half), z);
  return half;
}

// ----------------------------------------------------------------- the geometry

/**
 * One fish: 49 vertices, 77 triangles.
 *
 * A tube lofted between a nose point and a peduncle point through six elliptical
 * rings, plus a forked caudal fin and a dorsal and anal fin as flat triangles in
 * the midplane. The fins are what make the silhouette read; the rings are what
 * let the travelling wave bend something rather than shear a card.
 *
 * Authored with +x forward, +y up and the body one unit long, so the body axis
 * coordinate the wave needs is `0.5 - x` and needs no attribute of its own.
 *
 * The `fishFlank` attribute is the counter-shading coordinate: -1 on the ventral
 * line, +1 on the dorsal. It is baked rather than derived in the shader because
 * on a laterally compressed body it is a property of the *pigment*, which
 * follows the anatomy, not of the surface orientation, which does not.
 */
function buildFishGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const flanks: number[] = [];
  const indices: number[] = [];

  const push = (x: number, y: number, z: number, flank: number): number => {
    positions.push(x, y, z);
    flanks.push(flank);
    return flanks.length - 1;
  };

  const nose = push(0.5, 0, 0, 0);

  const rings: number[][] = [];
  for (const station of BODY_STATIONS) {
    const ring: number[] = [];
    const x = 0.5 - station.u;
    for (let j = 0; j < RING; j++) {
      // Offset by half a step so the ring has vertices exactly on the dorsal
      // and ventral lines, which is where the counter-shading gradient turns.
      const a = ((j + 0.5) / RING) * Math.PI * 2;
      const sy = Math.sin(a);
      ring.push(push(x, sy * station.halfHeight, Math.cos(a) * station.halfWidth, sy));
    }
    rings.push(ring);
  }

  const peduncle = push(-0.5, 0, 0, 0);

  const first = rings[0];
  for (let j = 0; j < RING; j++) indices.push(nose, first[(j + 1) % RING], first[j]);

  for (let k = 0; k + 1 < rings.length; k++) {
    const a = rings[k];
    const b = rings[k + 1];
    for (let j = 0; j < RING; j++) {
      const j2 = (j + 1) % RING;
      indices.push(a[j], a[j2], b[j2], a[j], b[j2], b[j]);
    }
  }

  const last = rings[rings.length - 1];
  for (let j = 0; j < RING; j++) indices.push(last[j], last[(j + 1) % RING], peduncle);

  // Fin vertices take their counter-shading from their height, so the tail
  // inherits the body's gradient across the fork instead of ending in a band.
  const finFlank = (y: number): number => clampNumber(y / 0.12, -1, 1);

  const tailUp = push(-0.46, 0.03, 0, finFlank(0.03));
  const tailDown = push(-0.46, -0.03, 0, finFlank(-0.03));
  const tailNotch = push(-0.6, 0, 0, 0);
  const tailTipUp = push(-0.69, 0.185, 0, finFlank(0.185));
  const tailTipDown = push(-0.69, -0.185, 0, finFlank(-0.185));
  indices.push(
    tailUp, tailTipUp, tailNotch,
    tailUp, tailNotch, tailDown,
    tailDown, tailNotch, tailTipDown,
  );

  indices.push(
    push(0.2, 0.112, 0, 1),
    push(0.1, 0.203, 0, 1),
    push(-0.12, 0.09, 0, 1),
  );

  indices.push(
    push(-0.12, -0.09, 0, -1),
    push(-0.32, -0.055, 0, -1),
    push(-0.2, -0.155, 0, -1),
  );

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('fishFlank', new THREE.Float32BufferAttribute(flanks, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  // Every vertex is relocated by the vertex stage, so a bound derived from these
  // positions describes nothing. Culling is off; this exists so anything that
  // reads the sphere gets a defensible answer rather than a null.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Number.POSITIVE_INFINITY);

  return geometry;
}

/**
 * Per-instance seeds and traits.
 *
 * Drawn from one generator in index order, so instance `i` gets the same values
 * whatever `MAX_FISH` is and — because the buffer is never rebuilt — whatever
 * the tier is. Same reasoning as `UnderwaterParticles`: a baseline capture that
 * cannot survive a reload is not a baseline.
 */
function attachInstanceAttributes(
  geometry: THREE.BufferGeometry,
  schoolScale: readonly number[],
  seed: number,
): void {
  const random = mulberry32(seed ^ 0x9e3779b9);
  const seeds = new Float32Array(MAX_FISH * 4);
  const traits = new Float32Array(MAX_FISH * 4);

  for (let i = 0; i < MAX_FISH; i++) {
    const school = i % SCHOOLS;

    seeds[i * 4 + 0] = random();
    // Lateral and vertical are pulled toward the middle of the envelope. A
    // uniform draw gives a school with a hard rectangular edge and a hollow
    // core; real shoals are densest in the centre and ragged at the margin.
    seeds[i * 4 + 1] = centreWeighted(random());
    seeds[i * 4 + 2] = centreWeighted(random());
    seeds[i * 4 + 3] = random();

    traits[i * 4 + 0] = school;
    traits[i * 4 + 1] = FISH_LENGTH * (0.78 + random() * 0.5) * schoolScale[school];
    traits[i * 4 + 2] = random();
    traits[i * 4 + 3] = random();
  }

  geometry.setAttribute('fishSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geometry.setAttribute('fishTrait', new THREE.InstancedBufferAttribute(traits, 4));
}

/** Maps a uniform draw in [0, 1) to one biased toward 0.5, preserving the range. */
function centreWeighted(u: number): number {
  const s = u * 2 - 1;
  return (Math.sign(s) * Math.pow(Math.abs(s), 1.5)) * 0.5 + 0.5;
}

function identityInstanceMatrix(matrices: THREE.InstancedBufferAttribute): void {
  const array = matrices.array as Float32Array;
  for (let i = 0; i < MAX_FISH; i++) {
    const base = i * 16;
    array[base] = 1;
    array[base + 5] = 1;
    array[base + 10] = 1;
    array[base + 15] = 1;
  }
  matrices.needsUpdate = true;
}

/**
 * Selects one of `SCHOOLS` uniforms by a float instance attribute.
 *
 * A `select` chain rather than an indexed uniform array: the count is a
 * compile-time constant, the condition is uniform across every vertex of an
 * instance, and this lowers to a handful of ternaries on both backends with no
 * dependence on how a given WebGL2 driver handles dynamic array indexing.
 */
function pickPerSchool(values: readonly Node[], index: Node): Node {
  let node = values[values.length - 1];
  for (let k = values.length - 2; k >= 0; k--) {
    node = select(index.lessThan(k + 0.5), values[k], node);
  }
  return node;
}

function clampNumber(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Reduces a phase to [0, 2pi) in float64, before it reaches a float32 uniform. */
function wrapTau(phase: number): number {
  const tau = Math.PI * 2;
  return ((phase % tau) + tau) % tau;
}

/** Shortest signed difference between two headings. */
function wrapPi(angle: number): number {
  const tau = Math.PI * 2;
  return ((((angle + Math.PI) % tau) + tau) % tau) - Math.PI;
}
