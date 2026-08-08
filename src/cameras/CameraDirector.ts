import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CameraMode } from '../ui/types';
import { type CinematicEnvironment, CinematicDirector, type CinematicShipInput } from './Cinematic';

export type DirectorMode = CameraMode | 'cinematic';
export type BoatView = 'deck' | 'chase';

export interface CameraTarget {
  position: THREE.Vector3;
  heading: number;
}

export interface CameraDirectorOptions {
  camera: THREE.PerspectiveCamera;
  domElement: HTMLElement;
  surfaceHeight: (x: number, z: number) => number;
}

const DEFAULT_FOCUS_DISTANCE = 400;

const CHASE_DISTANCE = 34;
const CHASE_HEIGHT = 14;
const CHASE_DISTANCE_MIN = 12;
const CHASE_DISTANCE_MAX = 120;
const CHASE_SENSITIVITY = 0.0052;
const CHASE_PITCH_MIN = -0.5;
const CHASE_PITCH_MAX = 1.15;
const CHASE_RECENTRE_TAU = 2.2;

const DECK_EYE_FORWARD = -4.6;
const DECK_EYE_HEIGHT = 4.35;
const DECK_SAMPLE_FORWARD = 10.8;
const DECK_SAMPLE_SIDE = 3.6;
const DECK_LOOK_DISTANCE = 120;
const DECK_MOUSE_SENSITIVITY = 0.0031;
const DECK_PITCH_MIN = -1.15;
const DECK_PITCH_MAX = 0.82;
const DECK_STABILIZATION_DEFAULT = 0.55;
const DECK_STABILIZATION_STEP = 0.05;
const DECK_MIN_WATER_CLEARANCE = 0.8;
const DECK_ROTATION_RESPONSE = 18;

const FLY_SPEED = 22;
const FLY_SPEED_MIN = 1.5;
const FLY_SPEED_MAX = 600;
const FLY_SPEED_STEP = 1.18;
const FLY_BOOST = 5;
const FLY_DAMPING = 6;
const MOUSE_SENSITIVITY = 0.0022;

/**
 * Owns all camera rigs and the transitions between them.
 *
 * Boat mode contains two views. Deck is the Ocean Feel Lab view: the eye stays
 * attached to the hull while pitch/roll are estimated from four ocean samples,
 * mirroring the idea behind the ship's buoyancy probes. A stabilization blend
 * then decides how much of that raw hull attitude reaches the player's head.
 * Chase preserves the original third-person follow camera.
 */
export class CameraDirector {
  readonly camera: THREE.PerspectiveCamera;
  readonly orbit: OrbitControls;

  private mode: DirectorMode = 'orbit';
  private readonly domElement: HTMLElement;
  private readonly surfaceHeight: (x: number, z: number) => number;

  private readonly keys = new Set<string>();
  private pointerLocked = false;

  private flySpeed = FLY_SPEED;
  private yaw = 0;
  private pitch = 0;
  private readonly flyVelocity = new THREE.Vector3();

  private target: CameraTarget | null = null;
  private boatView: BoatView = 'deck';
  private boatDragging = false;

  private chaseYaw = 0;
  private chasePitch = 0;
  private chaseDistance = CHASE_DISTANCE;

  private deckLookYaw = 0;
  private deckLookPitch = 0;
  private deckStabilization = DECK_STABILIZATION_DEFAULT;
  private deckWavePitch = 0;
  private deckWaveRoll = 0;
  private labHudAccumulator = 0;
  private readonly labHud: HTMLDivElement;

  private readonly cinematic = new CinematicDirector();
  private readonly cinematicPose = {
    position: new THREE.Vector3(),
    target: new THREE.Vector3(),
  };
  private readonly shipOrders: CinematicShipInput = { throttle: 0, rudder: 0 };

  private transition = 0;
  private readonly fromPosition = new THREE.Vector3();
  private readonly fromQuaternion = new THREE.Quaternion();
  private static readonly TRANSITION_SECONDS = 0.85;

  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpVec2 = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly desiredPosition = new THREE.Vector3();
  private readonly desiredQuaternion = new THREE.Quaternion();

  private readonly deckForward = new THREE.Vector3();
  private readonly deckRight = new THREE.Vector3();
  private readonly deckSurfaceForward = new THREE.Vector3();
  private readonly deckSurfaceRight = new THREE.Vector3();
  private readonly deckShipUp = new THREE.Vector3();
  private readonly deckCameraUp = new THREE.Vector3();
  private readonly deckLookDirection = new THREE.Vector3();
  private readonly deckLookTarget = new THREE.Vector3();

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
    this.orbit.maxPolarAngle = Math.PI;

    this.labHud = this.createLabHud();
    this.updateLabHud(true);

    const { signal } = this.abort;
    window.addEventListener('keydown', this.onKeyDown, { signal });
    window.addEventListener('keyup', this.onKeyUp, { signal });
    this.domElement.addEventListener('mousedown', this.onMouseDown, { signal });
    document.addEventListener('pointerlockchange', this.onPointerLockChange, { signal });
    document.addEventListener('mousemove', this.onMouseMove, { signal });
    this.domElement.addEventListener('wheel', this.onWheel, { signal, passive: false });
    window.addEventListener('mouseup', this.onMouseUp, { signal });
  }

  get currentMode(): DirectorMode {
    return this.mode;
  }

  get boatViewMode(): BoatView {
    return this.boatView;
  }

  get deckStabilizationValue(): number {
    return this.deckStabilization;
  }

  get shipInput(): Readonly<CinematicShipInput> {
    return this.shipOrders;
  }

  get cinematicBeat(): string {
    return this.cinematic.beatName;
  }

  get cinematicTime(): number {
    return this.cinematic.time;
  }

  cinematicEnvironment(time?: number): Readonly<CinematicEnvironment> {
    return this.cinematic.environment(time);
  }

  focusDistance(): number {
    switch (this.mode) {
      case 'orbit':
        return Math.max(1, this.camera.position.distanceTo(this.orbit.target));
      case 'cinematic':
        return Math.max(1, this.camera.position.distanceTo(this.cinematicPose.target));
      case 'boat':
        if (this.boatView === 'deck') return 180;
        return this.target
          ? Math.max(1, this.camera.position.distanceTo(this.target.position))
          : DEFAULT_FOCUS_DISTANCE;
      case 'fly': {
        this.camera.getWorldDirection(this.tmpVec);
        if (this.tmpVec.y > -0.02) return DEFAULT_FOCUS_DISTANCE;
        const surface = this.surfaceHeight(this.camera.position.x, this.camera.position.z);
        const drop = this.camera.position.y - surface;
        if (drop <= 0) return DEFAULT_FOCUS_DISTANCE;
        return THREE.MathUtils.clamp(drop / -this.tmpVec.y, 1, 4000);
      }
    }
  }

  setChaseTarget(target: CameraTarget | null): void {
    this.target = target;
  }

  setBoatView(view: BoatView): void {
    if (view === this.boatView) return;
    this.captureTransitionStart();
    this.boatView = view;
    this.boatDragging = false;
    this.updateLabHud(true);
  }

  setDeckStabilization(value: number): void {
    this.deckStabilization = THREE.MathUtils.clamp(value, 0, 1);
    this.updateLabHud(true);
  }

  setMode(mode: DirectorMode): void {
    if (mode === this.mode) return;

    this.captureTransitionStart();

    if (this.mode === 'fly') this.exitPointerLock();
    if (this.mode === 'cinematic') {
      this.cinematic.setEnabled(false);
      this.shipOrders.throttle = 0;
      this.shipOrders.rudder = 0;
    }

    this.mode = mode;
    this.boatDragging = false;

    if (mode === 'orbit') {
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

    if (mode === 'cinematic') this.cinematic.setEnabled(true);

    this.orbit.enabled = mode === 'orbit';
    this.updateLabHud(true);
  }

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
        this.tmpEuler.setFromQuaternion(this.tmpQuat);
        this.yaw = this.tmpEuler.y;
        this.pitch = this.tmpEuler.x;
        this.flyVelocity.set(0, 0, 0);
        break;
      case 'boat':
      case 'cinematic':
        break;
    }
  }

  snapToTarget(): void {
    if (this.mode !== 'boat' || !this.target) return;
    this.transition = 0;
    this.updateBoat(0);
    this.camera.position.copy(this.desiredPosition);
    this.camera.quaternion.copy(this.desiredQuaternion);
    this.camera.updateMatrixWorld(true);
  }

  resetCinematic(time = 0): void {
    if (this.mode !== 'cinematic') return;
    this.transition = 0;
    this.cinematic.resetClock(time);
    this.updateCinematic(0);
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
        this.updateBoat(dt);
        break;
      case 'cinematic':
        this.updateCinematic(dt);
        break;
    }

    if (this.transition > 0) {
      this.transition = Math.max(0, this.transition - dt / CameraDirector.TRANSITION_SECONDS);
      const t = easeInOutCubic(1 - this.transition);
      this.camera.position.lerpVectors(this.fromPosition, this.desiredPosition, t);
      this.camera.quaternion.slerpQuaternions(this.fromQuaternion, this.desiredQuaternion, t);
    }
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
    const speed = this.flySpeed * boost;

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

  private updateBoat(dt: number): void {
    if (this.boatView === 'deck') this.updateDeck(dt);
    else this.updateChase(dt);
  }

  private updateChase(dt: number): void {
    if (!this.target) {
      this.desiredPosition.copy(this.camera.position);
      this.desiredQuaternion.copy(this.camera.quaternion);
      return;
    }

    if (!this.boatDragging) {
      const settle = 1 - Math.exp(-dt / CHASE_RECENTRE_TAU);
      this.chaseYaw -= this.chaseYaw * settle;
      this.chasePitch -= this.chasePitch * settle;
    }

    const bearing = this.target.heading + this.chaseYaw;
    const lift = CHASE_HEIGHT / CHASE_DISTANCE + this.chasePitch;
    const planar = Math.cos(Math.atan(lift));
    const back = this.tmpVec.set(
      Math.sin(bearing) * planar,
      0,
      Math.cos(bearing) * planar,
    );

    this.desiredPosition
      .copy(this.target.position)
      .addScaledVector(back, -this.chaseDistance)
      .add(this.tmpVec2.set(0, this.chaseDistance * lift * planar, 0));

    const surface = this.surfaceHeight(this.desiredPosition.x, this.desiredPosition.z);
    if (this.desiredPosition.y < surface + 1.6) this.desiredPosition.y = surface + 1.6;

    this.tmpVec2.copy(this.target.position).y += 4;
    this.tmpQuat.setFromRotationMatrix(lookAtMatrix(this.desiredPosition, this.tmpVec2, UP));
    this.desiredQuaternion.copy(this.tmpQuat);

    if (this.transition === 0) {
      const lag = 1 - Math.exp(-4 * dt);
      this.camera.position.lerp(this.desiredPosition, lag);
      this.camera.quaternion.slerp(this.desiredQuaternion, lag);
    }

    this.labHudAccumulator += dt;
    if (this.labHudAccumulator > 0.14) {
      this.labHudAccumulator = 0;
      this.updateLabHud(false);
    }
  }

  private updateDeck(dt: number): void {
    const target = this.target;
    if (!target) {
      this.desiredPosition.copy(this.camera.position);
      this.desiredQuaternion.copy(this.camera.quaternion);
      return;
    }

    const heading = target.heading;
    const cosH = Math.cos(heading);
    const sinH = Math.sin(heading);

    this.deckForward.set(cosH, 0, sinH);
    this.deckRight.set(-sinH, 0, cosH);

    const x = target.position.x;
    const z = target.position.z;

    const frontY = this.surfaceHeight(
      x + this.deckForward.x * DECK_SAMPLE_FORWARD,
      z + this.deckForward.z * DECK_SAMPLE_FORWARD,
    );
    const backY = this.surfaceHeight(
      x - this.deckForward.x * DECK_SAMPLE_FORWARD,
      z - this.deckForward.z * DECK_SAMPLE_FORWARD,
    );
    const starboardY = this.surfaceHeight(
      x + this.deckRight.x * DECK_SAMPLE_SIDE,
      z + this.deckRight.z * DECK_SAMPLE_SIDE,
    );
    const portY = this.surfaceHeight(
      x - this.deckRight.x * DECK_SAMPLE_SIDE,
      z - this.deckRight.z * DECK_SAMPLE_SIDE,
    );

    const forwardSlope = (frontY - backY) / (DECK_SAMPLE_FORWARD * 2);
    const sideSlope = (starboardY - portY) / (DECK_SAMPLE_SIDE * 2);
    this.deckWavePitch = Math.atan(forwardSlope);
    this.deckWaveRoll = Math.atan(sideSlope);

    this.deckSurfaceForward.copy(this.deckForward).setY(forwardSlope).normalize();
    this.deckSurfaceRight.copy(this.deckRight).setY(sideSlope).normalize();
    this.deckShipUp.crossVectors(this.deckSurfaceRight, this.deckSurfaceForward).normalize();
    if (this.deckShipUp.y < 0) this.deckShipUp.multiplyScalar(-1);

    this.desiredPosition
      .copy(target.position)
      .addScaledVector(this.deckForward, DECK_EYE_FORWARD)
      .addScaledVector(UP, DECK_EYE_HEIGHT);
    this.desiredPosition.y += DECK_EYE_FORWARD * forwardSlope;

    const eyeSurface = this.surfaceHeight(this.desiredPosition.x, this.desiredPosition.z);
    this.desiredPosition.y = Math.max(
      this.desiredPosition.y,
      eyeSurface + DECK_MIN_WATER_CLEARANCE,
    );

    const viewHeading = heading + this.deckLookYaw;
    const relativeForward = Math.cos(this.deckLookYaw);
    const relativeRight = Math.sin(this.deckLookYaw);
    const viewSlope = forwardSlope * relativeForward + sideSlope * relativeRight;
    const rawHullPitch = Math.atan(viewSlope);
    const inherited = 1 - this.deckStabilization;
    const viewPitch = this.deckLookPitch + rawHullPitch * inherited;
    const cosPitch = Math.cos(viewPitch);

    this.deckLookDirection.set(
      Math.cos(viewHeading) * cosPitch,
      Math.sin(viewPitch),
      Math.sin(viewHeading) * cosPitch,
    );
    this.deckLookTarget
      .copy(this.desiredPosition)
      .addScaledVector(this.deckLookDirection, DECK_LOOK_DISTANCE);

    this.deckCameraUp.lerpVectors(UP, this.deckShipUp, inherited).normalize();

    this.tmpQuat.setFromRotationMatrix(
      lookAtMatrix(this.desiredPosition, this.deckLookTarget, this.deckCameraUp),
    );
    this.desiredQuaternion.copy(this.tmpQuat);

    if (this.transition === 0) {
      this.camera.position.copy(this.desiredPosition);
      const response = dt <= 0 ? 1 : 1 - Math.exp(-DECK_ROTATION_RESPONSE * dt);
      this.camera.quaternion.slerp(this.desiredQuaternion, response);
    }

    this.labHudAccumulator += dt;
    if (this.labHudAccumulator > 0.1) {
      this.labHudAccumulator = 0;
      this.updateLabHud(false);
    }
  }

  private updateCinematic(dt: number): void {
    const orders = this.cinematic.update(dt, this.cinematicPose);
    this.shipOrders.throttle = orders.throttle;
    this.shipOrders.rudder = orders.rudder;
    this.desiredPosition.copy(this.cinematicPose.position);
    this.tmpQuat.setFromRotationMatrix(
      lookAtMatrix(this.cinematicPose.position, this.cinematicPose.target, UP),
    );
    this.desiredQuaternion.copy(this.tmpQuat);

    if (this.transition === 0) {
      this.camera.position.copy(this.desiredPosition);
      this.camera.quaternion.copy(this.desiredQuaternion);
    }
  }

  submersion(): number {
    const surface = this.surfaceHeight(this.camera.position.x, this.camera.position.z);
    const depth = surface - this.camera.position.y;
    return THREE.MathUtils.clamp(depth / 0.7 + 0.5, 0, 1);
  }

  dispose(): void {
    this.abort.abort();
    this.orbit.dispose();
    this.exitPointerLock();
    this.cinematic.setEnabled(false);
    this.shipOrders.throttle = 0;
    this.shipOrders.rudder = 0;
    this.labHud.remove();
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return;

    if (this.mode === 'boat' && !event.repeat) {
      const code = event.code.toLowerCase();
      if (code === 'keyv') {
        this.setBoatView(this.boatView === 'deck' ? 'chase' : 'deck');
        return;
      }
      if (code === 'keyr' && this.boatView === 'deck') {
        this.deckLookYaw = 0;
        this.deckLookPitch = 0;
        this.updateLabHud(true);
        return;
      }
      if (code === 'bracketleft' && this.boatView === 'deck') {
        this.setDeckStabilization(this.deckStabilization - DECK_STABILIZATION_STEP);
        return;
      }
      if (code === 'bracketright' && this.boatView === 'deck') {
        this.setDeckStabilization(this.deckStabilization + DECK_STABILIZATION_STEP);
        return;
      }
    }

    this.keys.add(event.code.toLowerCase());
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code.toLowerCase());
  };

  private onMouseDown = (): void => {
    if (this.mode === 'fly' && !this.pointerLocked) {
      void this.domElement.requestPointerLock?.();
    }
    if (this.mode === 'boat') this.boatDragging = true;
  };

  private onMouseUp = (): void => {
    this.boatDragging = false;
  };

  private onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.domElement;
  };

  private onMouseMove = (event: MouseEvent): void => {
    if (this.mode === 'boat') {
      if (!this.boatDragging) return;

      if (this.boatView === 'deck') {
        this.deckLookYaw -= event.movementX * DECK_MOUSE_SENSITIVITY;
        this.deckLookPitch -= event.movementY * DECK_MOUSE_SENSITIVITY;
        this.deckLookPitch = THREE.MathUtils.clamp(
          this.deckLookPitch,
          DECK_PITCH_MIN,
          DECK_PITCH_MAX,
        );
      } else {
        this.chaseYaw -= event.movementX * CHASE_SENSITIVITY;
        this.chasePitch += event.movementY * CHASE_SENSITIVITY;
        this.chasePitch = THREE.MathUtils.clamp(
          this.chasePitch,
          CHASE_PITCH_MIN,
          CHASE_PITCH_MAX,
        );
      }
      return;
    }

    if (this.mode !== 'fly' || !this.pointerLocked) return;
    this.yaw -= event.movementX * MOUSE_SENSITIVITY;
    this.pitch -= event.movementY * MOUSE_SENSITIVITY;
    const limit = Math.PI / 2 - 0.01;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -limit, limit);
  };

  private onWheel = (event: WheelEvent): void => {
    if (this.mode === 'boat') {
      event.preventDefault();

      if (this.boatView === 'deck') {
        const direction = event.deltaY > 0 ? -1 : 1;
        this.setDeckStabilization(
          this.deckStabilization + direction * DECK_STABILIZATION_STEP,
        );
      } else {
        const steps = event.deltaY > 0 ? 1 : -1;
        this.chaseDistance = THREE.MathUtils.clamp(
          this.chaseDistance * Math.pow(1.14, steps),
          CHASE_DISTANCE_MIN,
          CHASE_DISTANCE_MAX,
        );
      }
      return;
    }

    if (this.mode !== 'fly') return;
    event.preventDefault();
    const steps = event.deltaY > 0 ? -1 : 1;
    this.setFlySpeed(this.flySpeed * Math.pow(FLY_SPEED_STEP, steps));
  };

  setFlySpeed(value: number): void {
    this.flySpeed = THREE.MathUtils.clamp(value, FLY_SPEED_MIN, FLY_SPEED_MAX);
  }

  get flySpeedValue(): number {
    return this.flySpeed;
  }

  private captureTransitionStart(): void {
    this.fromPosition.copy(this.camera.position);
    this.fromQuaternion.copy(this.camera.quaternion);
    this.transition = 1;
  }

  private exitPointerLock(): void {
    if (document.pointerLockElement === this.domElement) document.exitPointerLock();
  }

  private createLabHud(): HTMLDivElement {
    const hud = document.createElement('div');
    hud.setAttribute('data-ocean-feel-lab', '');
    hud.style.position = 'fixed';
    hud.style.left = '18px';
    hud.style.bottom = '18px';
    hud.style.zIndex = '30';
    hud.style.pointerEvents = 'none';
    hud.style.padding = '10px 12px';
    hud.style.border = '1px solid rgba(255,255,255,0.22)';
    hud.style.borderRadius = '9px';
    hud.style.background = 'rgba(4,18,26,0.68)';
    hud.style.backdropFilter = 'blur(8px)';
    hud.style.color = '#e9fbff';
    hud.style.font = '600 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    hud.style.letterSpacing = '0.02em';
    hud.style.whiteSpace = 'pre-line';
    document.body.append(hud);
    return hud;
  }

  private updateLabHud(force: boolean): void {
    const visible = this.mode === 'boat';
    this.labHud.style.display = visible ? 'block' : 'none';
    if (!visible && !force) return;

    if (this.boatView === 'deck') {
      const stabilization = Math.round(this.deckStabilization * 100);
      const pitch = THREE.MathUtils.radToDeg(this.deckWavePitch).toFixed(1);
      const roll = THREE.MathUtils.radToDeg(this.deckWaveRoll).toFixed(1);
      this.labHud.textContent =
        `OCEAN FEEL LAB · DECK\n` +
        `head stabilization ${stabilization}% · wave pitch ${pitch}° · roll ${roll}°\n` +
        `drag look · wheel / [ ] stabilization · R centre · V chase`;
    } else {
      this.labHud.textContent =
        `OCEAN FEEL LAB · CHASE\n` +
        `drag orbit · wheel distance · V deck`;
    }
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
