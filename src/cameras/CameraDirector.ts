import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CameraMode } from '../ui/types';

export interface CameraTarget {
  /** World position the boat camera chases. */
  position: THREE.Vector3;
  /** Heading in radians for the chase camera to sit behind. */
  heading: number;
}

export interface CameraDirectorOptions {
  camera: THREE.PerspectiveCamera;
  domElement: HTMLElement;
  /** Queries wave height so the camera never sinks through a crest. */
  surfaceHeight: (x: number, z: number) => number;
}

const FLY_SPEED = 22;
const FLY_BOOST = 5;
const FLY_DAMPING = 6;
const MOUSE_SENSITIVITY = 0.0022;

/**
 * Owns the camera across three modes and, critically, owns the transitions
 * between them — cutting instantly between an orbit rig and a chase rig is the
 * single most jarring thing a demo like this can do, so every switch is a timed
 * ease from the current pose to the new one.
 */
export class CameraDirector {
  readonly camera: THREE.PerspectiveCamera;
  readonly orbit: OrbitControls;

  private mode: CameraMode = 'orbit';
  private readonly domElement: HTMLElement;
  private readonly surfaceHeight: (x: number, z: number) => number;

  // Fly state
  private readonly keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private pointerLocked = false;
  private readonly flyVelocity = new THREE.Vector3();

  // Chase state
  private target: CameraTarget | null = null;

  // Transition state
  private transition = 0;
  private readonly fromPosition = new THREE.Vector3();
  private readonly fromQuaternion = new THREE.Quaternion();
  private static readonly TRANSITION_SECONDS = 0.85;

  // Scratch — the update path must not allocate.
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpVec2 = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly desiredPosition = new THREE.Vector3();
  private readonly desiredQuaternion = new THREE.Quaternion();

  private readonly abort = new AbortController();

  constructor(options: CameraDirectorOptions) {
    this.camera = options.camera;
    this.domElement = options.domElement;
    this.surfaceHeight = options.surfaceHeight;

    this.orbit = new OrbitControls(this.camera, this.domElement);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.06;
    this.orbit.minDistance = 3;
    this.orbit.maxDistance = 1200;
    this.orbit.target.set(0, 2, 0);
    // Allow going below the surface — the underwater view is a headline feature.
    this.orbit.maxPolarAngle = Math.PI;

    const { signal } = this.abort;
    window.addEventListener('keydown', this.onKeyDown, { signal });
    window.addEventListener('keyup', this.onKeyUp, { signal });
    this.domElement.addEventListener('mousedown', this.onMouseDown, { signal });
    document.addEventListener('pointerlockchange', this.onPointerLockChange, { signal });
    document.addEventListener('mousemove', this.onMouseMove, { signal });
  }

  get currentMode(): CameraMode {
    return this.mode;
  }

  setChaseTarget(target: CameraTarget | null): void {
    this.target = target;
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;

    // Capture the current pose so the new rig can be eased into rather than cut to.
    this.fromPosition.copy(this.camera.position);
    this.fromQuaternion.copy(this.camera.quaternion);
    this.transition = 1;

    if (this.mode === 'fly') this.exitPointerLock();
    this.mode = mode;

    if (mode === 'orbit') {
      // Re-seat the orbit target ahead of the camera so the first drag does not
      // whip the view around to a stale pivot.
      this.camera.getWorldDirection(this.tmpVec);
      this.orbit.target.copy(this.camera.position).addScaledVector(this.tmpVec, 40);
      this.orbit.update();
    }

    if (mode === 'fly') {
      this.tmpEuler.setFromQuaternion(this.camera.quaternion);
      this.yaw = this.tmpEuler.y;
      this.pitch = this.tmpEuler.x;
      this.flyVelocity.set(0, 0, 0);
    }

    this.orbit.enabled = mode === 'orbit';
  }

  /**
   * Places the camera exactly, in whatever mode is active, and synchronises that
   * mode's internal state so the next `update()` does not immediately undo it.
   *
   * A plain `camera.position.set` is not enough for any mode but Orbit: Fly
   * integrates from its own yaw/pitch and would snap back on the next frame, and
   * the chase rig damps toward a pose derived from the ship. Each mode therefore
   * needs its state re-derived from the requested pose, which is what this does.
   *
   * Also cancels any in-flight mode transition — a capture taken mid-ease is not
   * reproducible.
   */
  pin(position: THREE.Vector3, target: THREE.Vector3): void {
    this.transition = 0;

    this.camera.position.copy(position);
    this.tmpQuat.setFromRotationMatrix(lookAtMatrix(position, target, UP));
    this.camera.quaternion.copy(this.tmpQuat);
    this.camera.updateMatrixWorld(true);

    this.desiredPosition.copy(position);
    this.desiredQuaternion.copy(this.tmpQuat);

    switch (this.mode) {
      case 'orbit':
        this.orbit.target.copy(target);
        this.orbit.update();
        break;
      case 'fly':
        // Re-derive the integrator's yaw/pitch from the pose it must hold.
        this.tmpEuler.setFromQuaternion(this.tmpQuat);
        this.yaw = this.tmpEuler.y;
        this.pitch = this.tmpEuler.x;
        this.flyVelocity.set(0, 0, 0);
        break;
      case 'boat':
        // Nothing to seed: the chase pose is derived from the target each frame.
        // `snapToTarget` is the deterministic entry point for this mode.
        break;
    }
  }

  /**
   * Places the chase camera at its ideal pose for the current target with no
   * damping, so a capture does not depend on how many frames the rig has had to
   * converge.
   */
  snapToTarget(): void {
    if (this.mode !== 'boat' || !this.target) return;
    this.transition = 0;
    this.updateChase(0);
    this.camera.position.copy(this.desiredPosition);
    this.camera.quaternion.copy(this.desiredQuaternion);
    this.camera.updateMatrixWorld(true);
  }

  update(dt: number): void {
    switch (this.mode) {
      case 'orbit':
        this.updateOrbit();
        break;
      case 'fly':
        this.updateFly(dt);
        break;
      case 'boat':
        this.updateChase(dt);
        break;
    }

    if (this.transition > 0) {
      this.transition = Math.max(0, this.transition - dt / CameraDirector.TRANSITION_SECONDS);
      const t = easeInOutCubic(1 - this.transition);
      this.camera.position.lerpVectors(this.fromPosition, this.desiredPosition, t);
      this.camera.quaternion.slerpQuaternions(this.fromQuaternion, this.desiredQuaternion, t);
    }

    this.avoidSurfacePenetration();
  }

  private updateOrbit(): void {
    this.orbit.update();
    this.desiredPosition.copy(this.camera.position);
    this.desiredQuaternion.copy(this.camera.quaternion);
  }

  private updateFly(dt: number): void {
    this.tmpEuler.set(this.pitch, this.yaw, 0, 'YXZ');
    this.desiredQuaternion.setFromEuler(this.tmpEuler);

    const forward = this.tmpVec.set(0, 0, -1).applyQuaternion(this.desiredQuaternion);
    const right = this.tmpVec2.set(1, 0, 0).applyQuaternion(this.desiredQuaternion);

    const boost = this.keys.has('shiftleft') || this.keys.has('shiftright') ? FLY_BOOST : 1;
    const speed = FLY_SPEED * boost;

    // Accelerate toward the requested direction, then damp — instant velocity
    // changes make a flying camera feel like a cursor rather than a body.
    if (this.keys.has('keyw')) this.flyVelocity.addScaledVector(forward, speed * dt);
    if (this.keys.has('keys')) this.flyVelocity.addScaledVector(forward, -speed * dt);
    if (this.keys.has('keyd')) this.flyVelocity.addScaledVector(right, speed * dt);
    if (this.keys.has('keya')) this.flyVelocity.addScaledVector(right, -speed * dt);
    if (this.keys.has('space')) this.flyVelocity.y += speed * dt;
    if (this.keys.has('controlleft')) this.flyVelocity.y -= speed * dt;

    this.flyVelocity.multiplyScalar(Math.max(0, 1 - FLY_DAMPING * dt));

    this.desiredPosition.copy(this.camera.position).addScaledVector(this.flyVelocity, dt);

    if (this.transition === 0) {
      this.camera.position.copy(this.desiredPosition);
      this.camera.quaternion.copy(this.desiredQuaternion);
    }
  }

  private updateChase(dt: number): void {
    if (!this.target) {
      this.desiredPosition.copy(this.camera.position);
      this.desiredQuaternion.copy(this.camera.quaternion);
      return;
    }

    // Sit behind and above the target, looking slightly down at it.
    const back = this.tmpVec.set(Math.sin(this.target.heading), 0, Math.cos(this.target.heading));
    this.desiredPosition
      .copy(this.target.position)
      .addScaledVector(back, -34)
      .add(this.tmpVec2.set(0, 14, 0));

    this.tmpVec2.copy(this.target.position).y += 4;
    this.tmpQuat.setFromRotationMatrix(
      lookAtMatrix(this.desiredPosition, this.tmpVec2, UP),
    );
    this.desiredQuaternion.copy(this.tmpQuat);

    if (this.transition === 0) {
      // Critically damped follow so the camera lags the boat a little in chop
      // without ever overshooting into a wobble.
      const lag = 1 - Math.exp(-4 * dt);
      this.camera.position.lerp(this.desiredPosition, lag);
      this.camera.quaternion.slerp(this.desiredQuaternion, lag);
    }
  }

  /**
   * Keeps the camera from clipping through the surface from below, which would
   * flip the underwater state on and off every frame at a crest.
   */
  private avoidSurfacePenetration(): void {
    const surface = this.surfaceHeight(this.camera.position.x, this.camera.position.z);
    const margin = 0.35;
    const distance = this.camera.position.y - surface;
    if (Math.abs(distance) < margin) {
      this.camera.position.y = surface + (distance >= 0 ? margin : -margin);
    }
  }

  /** How submerged the camera is, 0..1, with a soft band around the surface. */
  submersion(): number {
    const surface = this.surfaceHeight(this.camera.position.x, this.camera.position.z);
    const depth = surface - this.camera.position.y;
    return THREE.MathUtils.clamp(depth / 0.7 + 0.5, 0, 1);
  }

  dispose(): void {
    this.abort.abort();
    this.orbit.dispose();
    this.exitPointerLock();
  }

  // ------------------------------------------------------------------ input

  private onKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return;
    this.keys.add(event.code.toLowerCase());
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code.toLowerCase());
  };

  private onMouseDown = (): void => {
    if (this.mode === 'fly' && !this.pointerLocked) {
      void this.domElement.requestPointerLock?.();
    }
  };

  private onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.domElement;
  };

  private onMouseMove = (event: MouseEvent): void => {
    if (this.mode !== 'fly' || !this.pointerLocked) return;
    this.yaw -= event.movementX * MOUSE_SENSITIVITY;
    this.pitch -= event.movementY * MOUSE_SENSITIVITY;
    // Stop just short of vertical; passing it would flip the horizon.
    const limit = Math.PI / 2 - 0.01;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -limit, limit);
  };

  private exitPointerLock(): void {
    if (document.pointerLockElement === this.domElement) document.exitPointerLock();
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const scratchMatrix = new THREE.Matrix4();

function lookAtMatrix(eye: THREE.Vector3, target: THREE.Vector3, up: THREE.Vector3): THREE.Matrix4 {
  return scratchMatrix.lookAt(eye, target, up);
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}
