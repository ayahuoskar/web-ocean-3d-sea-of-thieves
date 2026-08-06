import * as THREE from 'three/webgpu';
import {
  Fn,
  attribute,
  cameraPosition,
  float,
  positionGeometry,
  smoothstep,
  uniform,
  uniformArray,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { smoothstepDown } from '../core/tslMath';

/**
 * Airborne spray thrown by a hull working in a seaway.
 *
 * The project already had the two *other* things water does to a moving ship —
 * the wake it leaves (`physics/Wake`) and the wet it puts on the deck
 * (`scene/Wetness`) — and nothing at all for the part that leaves the water
 * altogether. A hull driving into a head sea with a clean wake and dry air over
 * the bow is one of those absences that is hard to name and impossible to
 * un-see once named: the sea and the ship are plainly interacting below the
 * waterline and plainly ignoring each other above it.
 *
 * **The whole system is an event table.** Nothing here integrates a particle.
 * A handful of probes ride the hull; when one of them punches down through the
 * surface faster than `IMPACT_SPEED`, that writes a single record — where, when,
 * how hard — into a small ring. Every particle is then a closed-form ballistic
 * trajectory off one of those records, evaluated in the vertex stage:
 *
 *     p(t) = p0 + v0 (t - t0) + 1/2 g (t - t0)^2
 *
 * which is the correct physics for a droplet big enough to see and small enough
 * to ignore drag on, and which costs one multiply-add per component.
 *
 * **Why closed form rather than an integrator.** The same reason `Birds` runs on
 * closed circuits and `Particles` runs on hashes: `resetClock(t)` has to land on
 * the exact state for time `t`, because the entire visual harness rests on a
 * capture being a function of the clock rather than of how many frames preceded
 * it. An integrated particle pool cannot offer that at any price — it would have
 * to be re-simulated from the beginning of time. An event table can, because the
 * only state is the table itself, and the table is small enough to clear and
 * refill from a deterministic settle.
 *
 * The emission side is state, and it is the minimum possible amount of it: one
 * previous signed height per probe, plus the ring's write cursor. Both are
 * cleared by `resetClock`, and both are refilled by the settle steps that
 * `resetDeterministic` already runs — the same mechanism that refills the foam
 * buffer, and for the same reason.
 *
 * **No compute, no storage, no per-frame upload of positions.** The CPU writes
 * at most one event per probe per frame into two small uniform arrays. The
 * vertex stage reads them. This compiles on the WebGL2 fallback unchanged.
 *
 * ---
 *
 * **PARKED: this system emits correctly and draws nothing.** The emission side,
 * the event table, the mesh and the material are all verified working at
 * runtime; not one pixel is rasterised. The diagnosis, the four fixes that did
 * not resolve it, and the architecture change that follows from what is left are
 * written up on the test — see `tests/spray.spec.ts`, which is `fixme` rather
 * than skipped precisely so it starts passing when this does.
 *
 * It is left wired up and at its designed tier strengths rather than switched
 * off. It is inert either way, it costs 960 degenerate quads that the rasteriser
 * discards before they reach a fragment, and leaving it connected means the fix
 * is one file rather than one file plus a re-tuning.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * How many impacts are in flight at once.
 *
 * A ring, so the oldest is overwritten. 24 against a 1.1 s life and a hull that
 * can slam roughly twice a second per probe is about three times what is needed
 * — the headroom is there because overwriting a *live* event is the one artefact
 * this design can produce, and it looks like a sheet of spray vanishing.
 */
const EVENTS = 24;

/**
 * Droplets per impact.
 *
 * The instance count is `EVENTS * PER_EVENT` and every one of them is drawn
 * every frame whether or not its event is live — a dead particle collapses to a
 * degenerate triangle in the vertex stage, which the rasteriser discards before
 * it costs a fragment. That is deliberately cheaper than the alternative: a
 * varying instance count means a buffer write and a draw-call change every time
 * a wave hits, and 576 degenerate triangles are worth less than one of those.
 */
const PER_EVENT = 40;

/** Seconds a sheet of spray stays in the air. */
const LIFETIME = 1.1;

/**
 * Downward speed through the surface at which a probe counts as slamming, m/s.
 *
 * Below this a hull is *rising and falling with* the sea, which throws nothing —
 * the water and the hull are moving together and there is no impact. Above it
 * the hull is arriving somewhere the water already is. 1.6 m/s is about what a
 * 27 m hull reaches pitching in a 2 m sea, which is the point at which a real
 * one starts to throw water.
 */
const IMPACT_SPEED = 1.6;

/** Gravity, m/s^2. Positive down; the trajectory subtracts it. */
const GRAVITY = 9.81;

/**
 * Metres a droplet quad spans at full size.
 *
 * Spray is not resolvable as droplets at any distance this scene is viewed
 * from — what the eye sees is the sheet, so these are deliberately large and
 * soft rather than numerous and small. Twelve hundred small ones would cost more
 * and read as static.
 */
const DROP_SIZE = 0.26;

/** World-space distance past which spray is not drawn at all, metres. */
const DRAW_RANGE = 260;

export interface SprayProbe {
  /** Attachment point in the object's local frame. */
  offset: THREE.Vector3;
  /**
   * How much water this point throws relative to the others, 0..1.
   *
   * The forefoot throws most of it, the quarters almost none — a hull does not
   * slam evenly along its length, and probes weighted alike put as much water
   * over the transom as over the bow.
   */
  weight: number;
}

export interface SprayOptions {
  /** Tint. Spray is white water, so this is close to white and not quite. */
  color?: THREE.Color;
}

interface ProbeState {
  /** Signed height above the surface on the previous step, metres. */
  previousHeight: number;
  /** True once `previousHeight` means anything. */
  primed: boolean;
}

/**
 * A deterministic hash in [0,1) from two integers.
 *
 * Used on the CPU only, to give each event a heading jitter that survives a
 * rewind. The GPU side hashes the instance index instead, which needs no state
 * at all.
 */
function hash2(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x165667b1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x27d4eb2f);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

export class Spray {
  readonly mesh: THREE.Mesh;

  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly geometry: THREE.InstancedBufferGeometry;

  /** xyz = impact point, w = emission time. */
  private readonly uOrigin = uniformArray(
    Array.from({ length: EVENTS }, () => new THREE.Vector4(0, 0, 0, -1000)),
  );
  /** xyz = launch velocity, w = strength 0..1. */
  private readonly uLaunch = uniformArray(
    Array.from({ length: EVENTS }, () => new THREE.Vector4()),
  );
  private readonly uClock = uniform(0);
  private readonly uColor = uniform(new THREE.Color(0xeaf4ff));
  /** Master scale on how much is thrown, from the quality tier and the sea. */
  private readonly uStrength = uniform(1);

  private readonly probes: SprayProbe[] = [];
  private readonly probeState: ProbeState[] = [];
  private cursor = 0;
  private clock = 0;
  private eventSerial = 0;
  private disposed = false;

  constructor(options: SprayOptions = {}) {
    if (options.color) this.uColor.value.copy(options.color);

    this.geometry = buildGeometry();
    this.material = new THREE.MeshBasicNodeMaterial();
    this.material.transparent = true;
    this.material.depthWrite = false;
    this.material.side = THREE.DoubleSide;
    // Aerial perspective reaches this through the volumetric pass from scene
    // depth, like everything else in the scene; vertex fog would double it.
    this.material.fog = false;

    // Two independent graphs rather than shared `.toVar()` locals, for the
    // reason `Birds` records: a TSL variable belongs to the flow it was declared
    // in, and a varying opens its own vertex-stage flow.
    // Wrapped in its own `Fn`, and that is not a formality. `buildVertex` builds
    // a dozen `.toVar()` locals, and a TSL variable belongs to the flow it was
    // declared in — built outside one, the varying ends up referencing
    // declarations that were never emitted, and the whole system renders
    // nothing at all while compiling and running perfectly happily. Which is
    // exactly what it did: 960 live instances, four impacts in the table, and
    // zero changed pixels.
    const shading: any = varying(
      Fn(() => this.buildVertex().shading)() as any,
    );
    this.material.positionNode = Fn(() => this.buildVertex().world)() as any;
    this.material.colorNode = Fn(() => {
      // The droplet's shape, and without it every one of these is a flat square
      // of constant colour — which is exactly what it looked like: white blocks
      // hanging in the air rather than water.
      //
      // `shading.zw` carries the quad's own local coordinate, which runs to
      // +/-0.5 at the edges. Two falloffs off its radius rather than one: a wide
      // soft shoulder that takes the quad to nothing well inside its corners, so
      // there is no square to see, and a tighter core that keeps a bright centre
      // so the droplet still reads as dense water instead of as a smudge. A
      // single smoothstep gives one or the other and not both.
      const radius = vec2(shading.z, shading.w).length().toVar('sprayRadius');
      const shoulder = smoothstepDown(radius, 0.06, 0.5).toVar('spraySoft');
      const core = smoothstepDown(radius, 0.02, 0.34).toVar('sprayCore');
      const alpha = shading.y.mul(shoulder.mul(0.55).add(core.mul(0.45))).toVar('sprayAlpha');
      // The core is brighter as well as more opaque, which is what gives a sheet
      // of these the curdled look of real spray rather than a uniform haze.
      const tint = (this.uColor as any).mul(shading.x.mul(core.mul(0.35).add(0.75)));
      return vec4(tint, alpha) as any;
    })() as any;

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'spray';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
  }

  /**
   * Attaches probes to an object. Replaces any previous set.
   *
   * The object's world matrix is read at update time, so the caller does not
   * have to keep the probes in sync with it — only to have updated the matrix
   * before calling `update`, which the ship's own controller already does.
   */
  setProbes(probes: SprayProbe[]): void {
    this.probes.length = 0;
    this.probeState.length = 0;
    for (const probe of probes) {
      this.probes.push({ offset: probe.offset.clone(), weight: probe.weight });
      this.probeState.push({ previousHeight: 0, primed: false });
    }
  }

  /** Master scale on the whole system. 0 draws nothing. */
  setStrength(strength: number): void {
    this.uStrength.value = Math.max(0, strength);
  }

  /**
   * Impacts whose particles are still airborne at the current clock.
   *
   * Exposed for the test, which needs to distinguish "the hull is not slamming"
   * from "the hull is slamming and nothing is being drawn" — two failures that
   * look identical in a screenshot.
   */
  liveEvents(): number {
    let live = 0;
    for (let i = 0; i < EVENTS; i++) {
      const origin = (this.uOrigin.array as THREE.Vector4[])[i];
      const age = this.clock - origin.w;
      if (age >= 0 && age <= LIFETIME) live++;
    }
    return live;
  }

  /**
   * Advances the clock and tests every probe for an impact.
   *
   * @param dt            Seconds since the last call. Only used to turn a height
   *                      change into a speed; the trajectories are absolute.
   * @param elapsed       The simulation clock, the same one the sea runs on.
   * @param object        The hull the probes are attached to.
   * @param surfaceHeight Wave elevation at a world XZ.
   */
  update(
    dt: number,
    elapsed: number,
    object: THREE.Object3D | null,
    surfaceHeight: (x: number, z: number) => number,
  ): void {
    if (this.disposed) return;
    this.clock = elapsed;
    this.uClock.value = elapsed;

    if (object === null || this.probes.length === 0 || dt <= 0) return;
    if (this.uStrength.value <= 0) return;

    for (let i = 0; i < this.probes.length; i++) {
      const probe = this.probes[i];
      const state = this.probeState[i];

      _probeWorld.copy(probe.offset).applyMatrix4(object.matrixWorld);
      const height = _probeWorld.y - surfaceHeight(_probeWorld.x, _probeWorld.z);

      if (!state.primed) {
        state.previousHeight = height;
        state.primed = true;
        continue;
      }

      // Downward crossing only. A probe coming *up* through the surface lifts a
      // sheet too, but it lifts it slowly and what it makes is foam rather than
      // spray — the wake buffer already has that, and adding it here would put
      // droplets over the transom of a hull that is merely rising on a swell.
      const crossed = state.previousHeight > 0 && height <= 0;
      const speed = (state.previousHeight - height) / dt;
      state.previousHeight = height;
      if (!crossed || speed < IMPACT_SPEED) continue;

      this.emit(_probeWorld, speed, probe, object);
    }
  }

  /**
   * Clears every event and unprimes every probe.
   *
   * The unpriming matters as much as the clearing. A probe whose remembered
   * height is from before the rewind would compute its crossing speed across the
   * discontinuity, and a rewind of a hundred seconds would read as an impact at
   * several metres a second — so the first step after a reset deliberately
   * observes and emits nothing.
   */
  resetClock(elapsed: number): void {
    this.clock = elapsed;
    this.uClock.value = elapsed;
    this.cursor = 0;
    this.eventSerial = 0;
    for (let i = 0; i < EVENTS; i++) {
      // A time far enough in the past that the age test rejects it whatever the
      // clock is; the strength is zeroed too, so neither test is load bearing
      // on its own.
      (this.uOrigin.array as THREE.Vector4[])[i].set(0, 0, 0, -1000);
      (this.uLaunch.array as THREE.Vector4[])[i].set(0, 0, 0, 0);
    }
    for (const state of this.probeState) {
      state.previousHeight = 0;
      state.primed = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.geometry.dispose();
    this.material.dispose();
  }

  // ------------------------------------------------------------------ internals

  private emit(
    at: THREE.Vector3,
    speed: number,
    probe: SprayProbe,
    object: THREE.Object3D,
  ): void {
    const slot = this.cursor % EVENTS;
    this.cursor++;
    const serial = this.eventSerial++;

    // Spray leaves an impact mostly upward and mostly *away from the hull* — the
    // hull is wedging water aside, so the sheet goes where the hull is not.
    //
    // The probe's own offset is that direction, which is why it is read rather
    // than the velocity: a bow probe sits on the centreline ahead of everything
    // and throws forward, a shoulder probe sits outboard and throws out on its
    // own side, and both fall out of normalising the offset in the hull's frame
    // and rotating it into the world. Taking a *world* displacement instead
    // would depend on where the object's origin happens to be.
    _side.set(probe.offset.x, 0, probe.offset.z);
    if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0);
    _outboard.copy(_side).normalize().applyQuaternion(object.quaternion).setY(0);
    if (_outboard.lengthSq() < 1e-6) _outboard.set(1, 0, 0);
    _outboard.normalize();

    // Launch speed scales with the square root of impact speed rather than with
    // it: the energy goes as v^2 and the height a droplet reaches goes as the
    // energy, so the *speed* it leaves at goes as the square root. A linear law
    // made a hard slam throw water absurdly high.
    const launch = Math.sqrt(speed) * 2.6;
    const jitter = hash2(serial, 7) - 0.5;

    _launch
      .copy(_outboard)
      .multiplyScalar(launch * (0.55 + 0.25 * jitter))
      .setY(launch * (0.9 + 0.2 * hash2(serial, 11)));

    (this.uOrigin.array as THREE.Vector4[])[slot].set(at.x, at.y, at.z, this.clock);
    (this.uLaunch.array as THREE.Vector4[])[slot].set(
      _launch.x,
      _launch.y,
      _launch.z,
      Math.min(1, (speed / 6) * probe.weight),
    );
  }

  /**
   * The whole particle, in the vertex stage.
   *
   * Returns the world position and the two shading terms as one call so the
   * position graph and the colour graph can each build their own copy — see the
   * note in `Birds` about TSL variables belonging to the flow that declared them.
   */
  private buildVertex(): { world: any; shading: any } {
    const event: any = attribute('sprayEvent', 'vec4');
    const seed: any = attribute('spraySeed', 'vec4');

    const origin: any = (this.uOrigin.element(event.x.toInt()) as any).toVar('sprayOrigin');
    const launch: any = (this.uLaunch.element(event.x.toInt()) as any).toVar('sprayLaunch');

    const age = this.uClock.sub(origin.w).toVar('sprayAge');
    // Normalised life. Outside [0,1] every term below collapses, which is what
    // retires a dead particle without a buffer write.
    const life = age.div(LIFETIME).toVar('sprayLife');
    const alive = life
      .greaterThanEqual(0)
      .and(life.lessThanEqual(1))
      .select(float(1), float(0))
      .toVar('sprayAlive');

    // Per-droplet spread. A cone about the launch vector, widened by the seed,
    // so one impact reads as a sheet rather than as a single arc.
    const spread: any = vec3(
      seed.x.sub(0.5).mul(2.4),
      seed.y.mul(1.5),
      seed.z.sub(0.5).mul(2.4),
    ).toVar('spraySpread');
    const velocity = launch.xyz.add(spread.mul(launch.w.mul(0.5).add(0.3))).toVar('sprayVel');

    // p = p0 + v t - 1/2 g t^2. Droplets this size have a terminal velocity well
    // above anything they reach in 1.1 s, so drag is left out rather than
    // approximated.
    const centre = origin.xyz
      .add(velocity.mul(age))
      .sub(vec3(0, GRAVITY * 0.5, 0).mul(age).mul(age))
      .toVar('sprayCentre');

    // Camera-facing quad. Built from the view basis rather than from a billboard
    // matrix so nothing has to be uploaded per frame.
    const toCamera = cameraPosition.sub(centre).toVar('sprayToCam');
    const distance = toCamera.length().toVar('sprayDist');
    const forward = toCamera.div(distance.max(1e-3)).toVar('sprayFwd');
    // `right` is world up crossed with the view direction, which degenerates
    // when a droplet is directly above or below the eye — and a bow throwing
    // water over a camera on the foredeck is exactly that case, so the guard is
    // not theoretical. Falling back to world X keeps the quad valid; which way
    // it faces at that instant does not matter, because a billboard seen exactly
    // edge-on has no preferred orientation to get wrong.
    const rightRaw = vec3(forward.z, 0, forward.x.negate()).toVar('sprayRightRaw');
    const rightLen = rightRaw.length().toVar('sprayRightLen');
    const right = rightLen
      .greaterThan(1e-4)
      .select(rightRaw.div(rightLen), vec3(1, 0, 0))
      .toVar('sprayRight');
    const up = right.cross(forward).toVar('sprayUp');

    // Grows for its whole life, quickly at first and then steadily. A sheet of
    // water torn off a bow does not hold together: it disperses, and the way
    // that reads is each fragment covering more and more while carrying less
    // and less. Holding the size constant and fading the alpha — which is what
    // this did first — makes the sheet dissolve in place instead of spreading,
    // and that is a large part of why it looked like objects rather than water.
    const grow = smoothstep(0, 0.18, life)
      .mul(life.mul(0.9).add(0.55))
      .toVar('sprayGrow');
    const size: any = float(DROP_SIZE)
      .mul(seed.w.mul(0.9).add(0.45))
      .mul(grow)
      .mul(alive)
      .mul(this.uStrength)
      .toVar('spraySize');

    const world = centre
      .add(right.mul(positionGeometry.x.mul(size)))
      .add(up.mul(positionGeometry.y.mul(size)))
      .toVar('sprayWorld');

    // Fades out over the back half of its life, and out again with distance —
    // past `DRAW_RANGE` a droplet is well under a pixel and all it can
    // contribute is noise.
    const fade = smoothstepDown(life, 0.45, 1).toVar('sprayFade');
    const range = smoothstepDown(distance, DRAW_RANGE * 0.55, DRAW_RANGE).toVar('sprayRange');
    const opacity = fade
      .mul(range)
      .mul(alive)
      .mul(launch.w)
      .mul(this.uStrength.min(1))
      .toVar('sprayOpacity');

    // Brightness: fresh spray is dense white water and thins as it disperses.
    const brightness = float(0.7).add(fade.mul(0.5)).toVar('sprayBright');

    // zw carries the quad's own corner coordinate through to the fragment stage,
    // which is what lets the droplet have a shape. Free: the varying is a vec4
    // either way and these two components were padding.
    const shading: any = vec4(
      brightness as any,
      opacity as any,
      positionGeometry.x as any,
      positionGeometry.y as any,
    );
    return { world, shading };
  }
}

/** Scratch, module scope so `update` allocates nothing per frame. */
const _probeWorld = new THREE.Vector3();
const _side = new THREE.Vector3();
const _outboard = new THREE.Vector3();
const _launch = new THREE.Vector3();

function buildGeometry(): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  // A unit quad centred on the origin; the vertex stage supplies every transform.
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);

  const count = EVENTS * PER_EVENT;
  const event = new Float32Array(count * 4);
  const seed = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    event[i * 4] = Math.floor(i / PER_EVENT);
    const sub = i % PER_EVENT;
    seed[i * 4] = hash2(i, 1);
    seed[i * 4 + 1] = hash2(i, 2);
    seed[i * 4 + 2] = hash2(i, 3);
    seed[i * 4 + 3] = hash2(sub, 4);
  }
  geometry.setAttribute('sprayEvent', new THREE.InstancedBufferAttribute(event, 4));
  geometry.setAttribute('spraySeed', new THREE.InstancedBufferAttribute(seed, 4));
  geometry.instanceCount = count;
  // Placed entirely in the vertex stage, so a bound computed from the geometry
  // would describe a unit quad at the origin and cull the whole system.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Number.POSITIVE_INFINITY);
  return geometry;
}
