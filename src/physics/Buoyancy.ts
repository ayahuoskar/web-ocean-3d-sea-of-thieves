import * as THREE from 'three/webgpu';
import type { OceanSampler } from '../ocean/Sampler';

/**
 * Probe-based rigid-body flotation.
 *
 * Each body carries a handful of points fixed in its own frame. Every substep,
 * each probe is transformed to world space, the wave height directly above and
 * below it is queried, and a vertical force proportional to how deeply it is
 * submerged is applied *at that point*. Summing those forces gives heave;
 * summing r x F gives pitch and roll for free. That coupling is the whole point
 * of the method: a crest arriving at the bow lifts only the bow probe, so the
 * hull noses up before it rises — which is what makes floating look right, and
 * what a single-point height-follow can never do.
 *
 * Numerical design notes:
 *
 *  - **Stiffness is derived, not tuned.** The submerged fraction at rest is
 *    `1 / buoyancyStrength`, so the restoring force is exactly the body's weight
 *    when the probe plane sits on the water. That fixes the natural frequency at
 *    `sqrt(buoyancyStrength * g / probeDepth)` regardless of mass, and lets the
 *    damping coefficients be expressed as dimensionless ratios of critical.
 *  - **Damping uses relative velocity.** Water is not stationary; a probe moving
 *    up at the same rate as the surface under it should feel no drag at all.
 *    The surface's vertical velocity is differentiated per probe across frames.
 *  - **Buoyancy does not stop growing when the probe plane goes under.** See
 *    `reserveBuoyancy`. The probes sit on the waterline, so once they are
 *    `probeDepth` under there is nothing left for the ramp to say — but the body
 *    still has all its volume *above* that plane left to displace, and that
 *    reserve is what actually rights a hull that has been driven under.
 *  - **Semi-implicit Euler, substepped.** Velocity is updated before position,
 *    which is unconditionally stable for a spring-damper at these frequencies,
 *    and the substep is capped so a 200 ms browser stall cannot fling the ship
 *    into orbit.
 *  - **The sampler may not be ready.** `OceanSampler.height()` returns 0 until
 *    the first GPU readback lands, so the body simply settles on a flat sea and
 *    picks up the waves when they arrive. Nothing divides by a sampled value.
 */

const GRAVITY = 9.81;

/** Shared scratch for the heading accessor; reading a pose must not allocate. */
const _scratchForward = /*@__PURE__*/ new THREE.Vector3();

/** Physics substep. 120 Hz keeps the integrator well inside stability. */
const FIXED_STEP = 1 / 120;

/** Hard cap on substeps per frame, so a long stall degrades rather than explodes. */
const MAX_SUBSTEPS = 8;

export interface BuoyantBodyOptions {
  object: THREE.Object3D;
  /** Probe positions in the object's local space. */
  probePoints: THREE.Vector3[];
  mass: number;
  /**
   * Ratio of buoyant force at full submersion to weight. Must be > 1 or the
   * body sinks; 2.2 puts the resting waterline at 45% of `probeDepth`.
   */
  buoyancyStrength?: number;
  /**
   * Buoyant force once the body is *completely* under, as a multiple of weight.
   * Must be >= `buoyancyStrength`; equal to it restores the old hard ceiling.
   *
   * `buoyancyStrength` is the force when the **probe plane** is fully immersed,
   * and the probes lie on the waterline — so that is the force at roughly the
   * design draft, not the force at full immersion. A hull has most of its volume
   * *above* the waterline (this ship floats at 31% of its depth), and displacing
   * that volume is what stops a boat that has been driven under from staying
   * under. Clamping the ramp at `buoyancyStrength` threw all of it away: past
   * about 1.7 m of immersion the restoring force stopped growing while the
   * wave-following damper below did not, and in a steep sea the surface's own
   * vertical velocity is fast enough for that damper to exceed the frozen
   * buoyancy — a net *downward* force on a fully submerged hull, measured at up
   * to 1.4x weight against a ceiling of 2.2x. Nothing then brings the hull back
   * before the next crest arrives.
   *
   * The default doubles it. That is deliberately conservative: for this hull the
   * true ratio of hull volume to displaced volume is nearer 4, and for a sealed
   * barrel it is an order of magnitude. It is enough to make deep immersion
   * self-correcting without turning the body into a cork.
   */
  reserveBuoyancy?: number;
  /** Vertical damping as a fraction of critical. 0.3–0.5 reads like a hull. */
  linearDamping?: number;
  /** Extra rotational damping as a fraction of critical, on top of the probes'. */
  angularDamping?: number;
  /**
   * Depth over which a probe goes from just-touching to fully submerged, in
   * metres. Defaults to a fraction of the probe footprint. This is the hull's
   * effective draft and sets the response stiffness.
   */
  probeDepth?: number;
  /** Horizontal drag coefficient, per second. Keeps the hull from sliding. */
  horizontalDrag?: number;
  /**
   * Fraction of the probe damping that acts horizontally, 0..1.
   *
   * 1 for a buoy or a barrel, which are as blunt sideways as they are vertically
   * and should be dragged along by the water. Much lower for a hull, which is
   * shaped precisely so that it does not resist moving forward — see the note in
   * `substep`. A driven body wants a small value here and its own, direction-aware
   * resistance applied externally.
   */
  horizontalDamping?: number;
  /** Ceiling on |velocity|, m/s. */
  maxSpeed?: number;
  /** Ceiling on |angular velocity|, rad/s. */
  maxAngularSpeed?: number;
}

export class BuoyantBody {
  readonly object: THREE.Object3D;
  readonly velocity = new THREE.Vector3();
  readonly angularVelocity = new THREE.Vector3();

  private readonly probesLocal: THREE.Vector3[];
  private readonly probeWorld: THREE.Vector3[];
  /** Previous water height at each probe, for the surface-velocity estimate. */
  private readonly lastWaterY: Float32Array;
  private readonly hasLastWaterY: Uint8Array;

  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();

  /** Pose at construction, for `resetToHome`. */
  private readonly homePosition = new THREE.Vector3();
  private readonly homeQuaternion = new THREE.Quaternion();

  /**
   * Continuous force and torque from outside the solver — propulsion, steering,
   * hull resistance.
   *
   * Applied inside the substep alongside buoyancy and gravity rather than added
   * to the pose afterwards. That ordering is the whole point: thrust that is
   * integrated with the wave response produces a hull that climbs a swell and
   * loses way doing it, while a position nudged after the fact produces one that
   * slides through the water as if the waves were painted on.
   *
   * These persist between frames because they model sustained forces; a
   * controller sets them once per frame and the solver sees them in every
   * substep.
   */
  readonly externalForce = new THREE.Vector3();
  readonly externalTorque = new THREE.Vector3();

  private readonly mass: number;
  private readonly buoyancyStrength: number;
  private readonly probeDepth: number;
  private readonly restSubmersion: number;
  /**
   * How far past full probe-plane immersion the submersion term may still climb,
   * in units of `restSubmersion`-normalised submersion. Zero disables the
   * reserve entirely and reproduces the old hard clamp.
   */
  private readonly reserveSpan: number;
  private readonly naturalFrequency: number;
  private readonly linearDampingRatio: number;
  private readonly angularDampingRatio: number;
  private readonly horizontalDrag: number;
  private readonly horizontalDamping: number;
  private readonly maxSpeed: number;
  private readonly maxAngularSpeed: number;
  /** Diagonal inertia in body space, derived from the probe layout. */
  private readonly inertia = new THREE.Vector3();
  private readonly invInertia = new THREE.Vector3();

  // Scratch. `update()` runs for every body every frame and must not allocate.
  private readonly force = new THREE.Vector3();
  private readonly torque = new THREE.Vector3();
  private readonly arm = new THREE.Vector3();
  private readonly probeVelocity = new THREE.Vector3();
  private readonly relative = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly localTorque = new THREE.Vector3();
  private readonly spin = new THREE.Quaternion();
  private readonly inverseQuaternion = new THREE.Quaternion();

  constructor(options: BuoyantBodyOptions) {
    this.object = options.object;
    this.mass = Math.max(1e-3, options.mass);

    if (options.probePoints.length === 0) {
      throw new Error('BuoyantBody needs at least one probe point');
    }

    // Probes are given in local space, but the object may be scaled; bake the
    // scale in once so the per-substep transform is a pure rotate-and-add.
    const scale = this.object.scale;
    this.probesLocal = options.probePoints.map((p) =>
      new THREE.Vector3(p.x * scale.x, p.y * scale.y, p.z * scale.z),
    );
    this.probeWorld = this.probesLocal.map(() => new THREE.Vector3());
    this.lastWaterY = new Float32Array(this.probesLocal.length);
    this.hasLastWaterY = new Uint8Array(this.probesLocal.length);

    this.buoyancyStrength = Math.max(1.05, options.buoyancyStrength ?? 2.2);
    this.restSubmersion = 1 / this.buoyancyStrength;

    // Held as a span rather than a ratio because that is the form the curve in
    // `substep` needs, and because it makes "no reserve" exactly zero.
    const reserveBuoyancy = Math.max(
      this.buoyancyStrength,
      options.reserveBuoyancy ?? this.buoyancyStrength * 2,
    );
    this.reserveSpan = reserveBuoyancy / this.buoyancyStrength - 1;

    const extent = probeExtent(this.probesLocal, this.tmp);
    this.probeDepth = Math.max(
      0.25,
      options.probeDepth ?? Math.max(0.6, Math.max(extent.x, extent.z) * 0.14),
    );

    this.naturalFrequency = Math.sqrt((this.buoyancyStrength * GRAVITY) / this.probeDepth);
    this.linearDampingRatio = options.linearDamping ?? 0.38;
    this.angularDampingRatio = options.angularDamping ?? 0.5;
    this.horizontalDrag = options.horizontalDrag ?? 0.55;
    this.horizontalDamping = clamp(options.horizontalDamping ?? 1, 0, 1);
    this.maxSpeed = options.maxSpeed ?? 24;
    this.maxAngularSpeed = options.maxAngularSpeed ?? 2.5;

    // Solid-box inertia over the probe footprint. The probes bound the wetted
    // volume, which is what actually resists rotation in the water.
    const ex = Math.max(0.4, extent.x);
    const ey = Math.max(0.4, this.probeDepth * 2);
    const ez = Math.max(0.4, extent.z);
    const k = this.mass / 12;
    this.inertia.set(k * (ey * ey + ez * ez), k * (ex * ex + ez * ez), k * (ex * ex + ey * ey));
    this.invInertia.set(1 / this.inertia.x, 1 / this.inertia.y, 1 / this.inertia.z);

    this.position.copy(this.object.position);
    this.quaternion.copy(this.object.quaternion);
    this.homePosition.copy(this.position);
    this.homeQuaternion.copy(this.quaternion);
  }

  /** Teleports the body, clearing momentum. */
  reset(position?: THREE.Vector3, quaternion?: THREE.Quaternion): void {
    if (position) this.position.copy(position);
    if (quaternion) this.quaternion.copy(quaternion);
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.hasLastWaterY.fill(0);
    this.writeTransform();
  }

  /**
   * Returns the body to the pose it was constructed at, clearing momentum.
   *
   * Without this a deterministic capture inherits wherever the hull drifted to
   * during the preceding session, which is the single largest source of
   * irreproducibility in a scene full of floating objects.
   */
  resetToHome(): void {
    this.externalForce.set(0, 0, 0);
    this.externalTorque.set(0, 0, 0);
    this.reset(this.homePosition, this.homeQuaternion);
  }

  /** World-space forward direction of the body's local +X axis. */
  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(1, 0, 0).applyQuaternion(this.quaternion);
  }

  /** Heading in radians, `atan2(forward.z, forward.x)` — the wake's convention. */
  get heading(): number {
    this.forward(_scratchForward);
    return Math.atan2(_scratchForward.z, _scratchForward.x);
  }

  update(dt: number, sampler: OceanSampler): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;

    // Long frames are split into fixed substeps; anything beyond the cap is
    // dropped rather than simulated, which is the standard trade — slow motion
    // beats instability.
    const total = Math.min(dt, FIXED_STEP * MAX_SUBSTEPS);
    const steps = Math.max(1, Math.min(MAX_SUBSTEPS, Math.ceil(total / FIXED_STEP)));
    const step = total / steps;

    for (let i = 0; i < steps; i++) this.substep(step, sampler);

    if (!this.isFinite()) this.recover();
    this.writeTransform();
  }

  // ------------------------------------------------------------------ internals

  private substep(dt: number, sampler: OceanSampler): void {
    const count = this.probesLocal.length;

    // Force at full submersion, per probe, such that the sum at the resting
    // submersion is exactly the body's weight.
    const perProbeMax = (this.buoyancyStrength * this.mass * GRAVITY) / count;
    // Critical damping for the derived spring, split across the probes.
    const damping = (2 * this.linearDampingRatio * this.mass * this.naturalFrequency) / count;

    this.force.set(0, -this.mass * GRAVITY, 0);
    this.torque.set(0, 0, 0);

    // Propulsion, steering and hull resistance enter here, with gravity and
    // before buoyancy — so they are integrated by the same solver rather than
    // applied to the result of it.
    this.force.add(this.externalForce);
    this.torque.add(this.externalTorque);

    let submergedProbes = 0;

    for (let i = 0; i < count; i++) {
      const world = this.probeWorld[i].copy(this.probesLocal[i]).applyQuaternion(this.quaternion);
      this.arm.copy(world);
      world.add(this.position);

      const waterY = safeHeight(sampler, world.x, world.z);

      // Vertical velocity of the surface itself. Without it, a body riding a
      // swell feels a permanent phantom drag proportional to the wave's own
      // motion and sits visibly low on the face of every wave.
      let waterVelocityY = 0;
      if (this.hasLastWaterY[i] === 1) {
        waterVelocityY = clamp((waterY - this.lastWaterY[i]) / dt, -12, 12);
      }
      this.lastWaterY[i] = waterY;
      this.hasLastWaterY[i] = 1;

      // Displaced volume, normalised so that 1 means "the probe plane is
      // `probeDepth` under". The ramp below 1 is the waterplane: linear in
      // immersion, and the whole basis of the derived stiffness and of the
      // damping ratios, so it is left exactly as it was.
      //
      // Above 1 the body is displacing volume the probe plane cannot see, and
      // the curve continues into `reserveSpan` — saturating exponentially,
      // because a hull runs out of hull. Two properties matter and neither is
      // free: the join at 1 is C1 (the exponential's initial slope is exactly
      // the ramp's, so there is no step in stiffness for the solver to ring on),
      // and the whole thing is bounded, so a probe that ends up a hundred metres
      // under still produces a finite force. A clamp at 1 with a stiffer ramp
      // above it was tried instead and excited a roll oscillation to 66 degrees
      // — the discontinuity in stiffness, not the extra force, is what does it.
      const immersion = this.restSubmersion + (waterY - world.y) / this.probeDepth;
      let submersion: number;
      if (immersion <= 1) {
        submersion = immersion > 0 ? immersion : 0;
      } else if (this.reserveSpan > 0) {
        submersion =
          1 + this.reserveSpan * (1 - Math.exp(-(immersion - 1) / this.reserveSpan));
      } else {
        submersion = 1;
      }
      if (submersion > 0) submergedProbes++;

      // v_probe = v + omega x r
      this.probeVelocity.copy(this.angularVelocity).cross(this.arm).add(this.velocity);
      this.relative.copy(this.probeVelocity);
      this.relative.y -= waterVelocityY;

      // Buoyancy, then damping proportional to how wet the probe is.
      //
      // The damping is anisotropic. It is derived from the vertical spring — it
      // exists to stop the hull oscillating on the swell — and applying that same
      // coefficient to horizontal motion makes the water behave like treacle: at
      // the ship's mass and probe layout it worked out to roughly 180 kN per m/s
      // of surge, four times the intended hull drag, which capped the ship at a
      // third of its designed speed and brought a 90-tonne vessel to a dead stop
      // in fifteen seconds of coasting. A hull is shaped to resist heave and to
      // *not* resist surge, and `horizontalDamping` is where that asymmetry
      // lives; the longitudinal and lateral resistance that should oppose surge
      // is the controller's to apply, where it can be told about the hull's
      // heading.
      this.tmp.set(0, perProbeMax * submersion, 0);
      const dampScale = -damping * submersion;
      this.tmp.x += this.relative.x * dampScale * this.horizontalDamping;
      this.tmp.y += this.relative.y * dampScale;
      this.tmp.z += this.relative.z * dampScale * this.horizontalDamping;

      this.force.add(this.tmp);
      this.torque.add(this.tmp.cross(this.arm).negate());
    }

    // Horizontal drag, scaled by how much of the body is in the water.
    const wetness = submergedProbes / count;
    const drag = this.horizontalDrag * wetness * this.mass;
    this.force.x -= this.velocity.x * drag;
    this.force.z -= this.velocity.z * drag;

    // Hard clamp before integration: a pathological sampler reading can only
    // ever produce a bounded acceleration.
    const forceCap = this.mass * GRAVITY * 12;
    if (this.force.lengthSq() > forceCap * forceCap) this.force.setLength(forceCap);

    // --- integrate (semi-implicit) -------------------------------------------
    this.velocity.addScaledVector(this.force, dt / this.mass);
    if (this.velocity.lengthSq() > this.maxSpeed * this.maxSpeed) {
      this.velocity.setLength(this.maxSpeed);
    }
    this.position.addScaledVector(this.velocity, dt);

    // Torque is accumulated in world space; the inertia tensor is diagonal in
    // body space, so rotate in, divide, rotate back.
    this.inverseQuaternion.copy(this.quaternion).invert();
    this.localTorque.copy(this.torque).applyQuaternion(this.inverseQuaternion);
    this.localTorque.x *= this.invInertia.x;
    this.localTorque.y *= this.invInertia.y;
    this.localTorque.z *= this.invInertia.z;
    this.localTorque.applyQuaternion(this.quaternion);

    this.angularVelocity.addScaledVector(this.localTorque, dt);

    // The probe damping above already produces most of the rotational damping;
    // this is the residual yaw axis (no probe resists yaw) plus a safety margin.
    const angularDecay = Math.exp(-this.angularDampingRatio * this.naturalFrequency * dt);
    this.angularVelocity.multiplyScalar(angularDecay);
    if (this.angularVelocity.lengthSq() > this.maxAngularSpeed * this.maxAngularSpeed) {
      this.angularVelocity.setLength(this.maxAngularSpeed);
    }

    // q' = q + 0.5 * omega * q * dt
    this.spin.set(
      this.angularVelocity.x,
      this.angularVelocity.y,
      this.angularVelocity.z,
      0,
    );
    this.spin.multiply(this.quaternion);
    this.quaternion.x += this.spin.x * 0.5 * dt;
    this.quaternion.y += this.spin.y * 0.5 * dt;
    this.quaternion.z += this.spin.z * 0.5 * dt;
    this.quaternion.w += this.spin.w * 0.5 * dt;
    this.quaternion.normalize();
  }

  private isFinite(): boolean {
    return (
      Number.isFinite(this.position.x) &&
      Number.isFinite(this.position.y) &&
      Number.isFinite(this.position.z) &&
      Number.isFinite(this.quaternion.x) &&
      Number.isFinite(this.quaternion.w)
    );
  }

  private recover(): void {
    this.position.set(
      Number.isFinite(this.position.x) ? this.position.x : 0,
      0,
      Number.isFinite(this.position.z) ? this.position.z : 0,
    );
    this.quaternion.identity();
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.hasLastWaterY.fill(0);
  }

  private writeTransform(): void {
    this.object.position.copy(this.position);
    this.object.quaternion.copy(this.quaternion);
  }
}

export class BuoyancySystem {
  private readonly bodies: BuoyantBody[] = [];

  add(body: BuoyantBody): void {
    if (this.bodies.indexOf(body) === -1) this.bodies.push(body);
  }

  remove(body: BuoyantBody): void {
    const index = this.bodies.indexOf(body);
    if (index !== -1) this.bodies.splice(index, 1);
  }

  get count(): number {
    return this.bodies.length;
  }

  update(dt: number, sampler: OceanSampler): void {
    for (let i = 0; i < this.bodies.length; i++) {
      this.bodies[i].update(dt, sampler);
    }
  }

  /** Returns every body to its construction pose. See `BuoyantBody.resetToHome`. */
  resetToHome(): void {
    for (let i = 0; i < this.bodies.length; i++) this.bodies[i].resetToHome();
  }

  dispose(): void {
    this.bodies.length = 0;
  }
}

/**
 * Four probes on the equator of a sphere of `radius` — the right layout for a
 * buoy or a barrel, where there is no meaningful bow or beam.
 */
export function createRadialProbes(radius: number, count = 4): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius));
  }
  return points;
}

/**
 * `sampler.height()` is a multi-iteration fixed point over GPU-read data; it is
 * well behaved but it is not this module's to trust. One guard here is cheaper
 * than NaN propagating into a quaternion and taking the whole scene with it.
 */
function safeHeight(sampler: OceanSampler, x: number, z: number): number {
  if (!sampler.ready) return 0;
  const y = sampler.height(x, z);
  return Number.isFinite(y) ? clamp(y, -60, 60) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Full extent of the probe cloud along each axis. */
function probeExtent(probes: THREE.Vector3[], out: THREE.Vector3): THREE.Vector3 {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of probes) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return out.set(maxX - minX, 0, maxZ - minZ);
}
