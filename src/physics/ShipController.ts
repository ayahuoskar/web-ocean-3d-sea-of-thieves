import * as THREE from 'three/webgpu';
import type { BuoyantBody } from './Buoyancy';

const THROTTLE_RATE = 0.7;
const RUDDER_RATE = 2.2;
const RUDDER_RETURN = 1.6;
const MAX_THRUST = 130_000;
const REVERSE_FRACTION = 0.45;
const DRAG_LONGITUDINAL = 1_400;
const DRAG_LATERAL = 16_000;
const RUDDER_TORQUE = 1_200_000;
const RUDDER_REFERENCE_SPEED = 5.5;
const YAW_DAMPING = 5_600_000;
const SHOAL_DEPTH = 7;
const SHOAL_HARD_DEPTH = 3.6;
const SHOAL_FORCE = 5_600_000;
const SHOAL_PROBE = 12;

export interface ShipControlState {
  throttle: number;
  rudder: number;
  speed: number;
  forwardSpeed: number;
  heading: number;
}

/**
 * Propulsion/helm controller for the hero ship.
 *
 * Ocean Feel Lab v0.2 deliberately reserves WASD for walking the deck. The helm
 * now uses arrow keys (and I/J/K/L as an alternative) while touch/direct input
 * remains unchanged. Keeping movement and ship control on separate key sets is
 * what makes it possible to walk around while the ship is still sailing.
 */
export class ShipController {
  private readonly body: BuoyantBody;
  private readonly floorHeight: ((x: number, z: number) => number) | null;

  private throttleInput = 0;
  private rudderInput = 0;
  private throttle = 0;
  private rudder = 0;
  private enabled = false;
  private keyboard = true;

  private readonly keys = new Set<string>();
  private readonly abort = new AbortController();

  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly force = new THREE.Vector3();
  private readonly torque = new THREE.Vector3();

  constructor(body: BuoyantBody, floorHeight: ((x: number, z: number) => number) | null = null) {
    this.body = body;
    this.floorHeight = floorHeight;

    const { signal } = this.abort;
    window.addEventListener('keydown', this.onKeyDown, { signal });
    window.addEventListener('keyup', this.onKeyUp, { signal });
    window.addEventListener('blur', this.releaseKeys, { signal });
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.releaseKeys();
      this.throttle = 0;
      this.rudder = 0;
      this.body.externalForce.set(0, 0, 0);
      this.body.externalTorque.set(0, 0, 0);
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setKeyboardEnabled(enabled: boolean): void {
    if (this.keyboard === enabled) return;
    this.keyboard = enabled;
    if (!enabled) this.releaseKeys();
  }

  setInput(throttle: number, rudder: number): void {
    this.throttleInput = clamp(throttle, -1, 1);
    this.rudderInput = clamp(rudder, -1, 1);
  }

  resetInput(): void {
    this.releaseKeys();
    this.throttleInput = 0;
    this.rudderInput = 0;
    this.throttle = 0;
    this.rudder = 0;
    this.body.externalForce.set(0, 0, 0);
    this.body.externalTorque.set(0, 0, 0);
  }

  update(dt: number): void {
    if (!this.enabled || !(dt > 0)) return;

    const keyThrottle = this.keyboard
      ? (hasAny(this.keys, 'arrowup', 'keyi') ? 1 : 0) -
        (hasAny(this.keys, 'arrowdown', 'keyk') ? 1 : 0)
      : 0;
    const keyRudder = this.keyboard
      ? (hasAny(this.keys, 'arrowright', 'keyl') ? 1 : 0) -
        (hasAny(this.keys, 'arrowleft', 'keyj') ? 1 : 0)
      : 0;

    const wantThrottle = keyThrottle !== 0 ? keyThrottle : this.throttleInput;
    const wantRudder = keyRudder !== 0 ? keyRudder : this.rudderInput;

    this.throttle = approach(this.throttle, wantThrottle, THROTTLE_RATE * dt);
    this.rudder =
      wantRudder === 0
        ? approach(this.rudder, 0, RUDDER_RETURN * dt)
        : approach(this.rudder, wantRudder, RUDDER_RATE * dt);

    this.body.forward(this.forward);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-6) this.forward.set(1, 0, 0);
    this.forward.normalize();
    this.right.set(-this.forward.z, 0, this.forward.x);

    const velocity = this.body.velocity;
    const alongSpeed = velocity.dot(this.forward);
    const acrossSpeed = velocity.dot(this.right);

    const ahead = this.throttle >= 0 ? 1 : REVERSE_FRACTION;
    const thrust = this.throttle * MAX_THRUST * ahead;
    const dragAlong = -Math.sign(alongSpeed) * DRAG_LONGITUDINAL * alongSpeed * alongSpeed;
    const dragAcross = -Math.sign(acrossSpeed) * DRAG_LATERAL * acrossSpeed * acrossSpeed;

    this.force.set(0, 0, 0);
    this.force.addScaledVector(this.forward, thrust + dragAlong);
    this.force.addScaledVector(this.right, dragAcross);
    this.body.externalForce.copy(this.force);

    const flow = Math.min(1, Math.abs(alongSpeed) / RUDDER_REFERENCE_SPEED);
    const direction = alongSpeed >= 0 ? 1 : -1;
    const steer = -this.rudder * RUDDER_TORQUE * flow * direction;
    const damping = -this.body.angularVelocity.y * YAW_DAMPING;

    this.torque.set(0, steer + damping, 0);
    this.body.externalTorque.copy(this.torque);

    this.applyShoal();
  }

  private applyShoal(): void {
    if (!this.floorHeight) return;

    const { x, z } = this.body.object.position;
    const floor = this.floorHeight(x, z);
    const depth = -floor;
    if (depth >= SHOAL_DEPTH) return;

    const strength = Math.min(
      1,
      Math.max(0, (SHOAL_DEPTH - depth) / (SHOAL_DEPTH - SHOAL_HARD_DEPTH)),
    );

    const dx = this.floorHeight(x + SHOAL_PROBE, z) - this.floorHeight(x - SHOAL_PROBE, z);
    const dz = this.floorHeight(x, z + SHOAL_PROBE) - this.floorHeight(x, z - SHOAL_PROBE);
    const length = Math.hypot(dx, dz);

    if (length < 1e-4) {
      const speed = this.body.velocity.length();
      if (speed > 1e-3) {
        this.force.copy(this.body.velocity).multiplyScalar((-SHOAL_FORCE * strength) / speed);
        this.force.y = 0;
        this.body.externalForce.add(this.force);
      }
    } else {
      this.force.set(-dx / length, 0, -dz / length).multiplyScalar(SHOAL_FORCE * strength);
      this.body.externalForce.add(this.force);
    }

    this.body.externalForce.addScaledVector(
      this.forward,
      -Math.max(0, this.throttle) * MAX_THRUST * strength,
    );
  }

  getState(out: ShipControlState): ShipControlState {
    this.body.forward(this.forward);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-6) this.forward.set(1, 0, 0);
    this.forward.normalize();

    out.throttle = this.throttle;
    out.rudder = this.rudder;
    out.speed = this.body.velocity.length();
    out.forwardSpeed = this.body.velocity.dot(this.forward);
    out.heading = Math.atan2(this.forward.z, this.forward.x);
    return out;
  }

  dispose(): void {
    this.abort.abort();
    this.keys.clear();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled || isTypingTarget(event.target)) return;
    const code = event.code.toLowerCase();
    if (!STEERING_KEYS.has(code)) return;
    event.preventDefault();
    this.keys.add(code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code.toLowerCase());
  };

  private readonly releaseKeys = (): void => {
    this.keys.clear();
  };
}

const STEERING_KEYS = new Set([
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'keyi',
  'keyj',
  'keyk',
  'keyl',
]);

function hasAny(keys: Set<string>, a: string, b: string): boolean {
  return keys.has(a) || keys.has(b);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function approach(current: number, target: number, step: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= step) return target;
  return current + Math.sign(delta) * step;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}
