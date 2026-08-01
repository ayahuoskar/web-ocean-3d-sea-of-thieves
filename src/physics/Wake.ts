import * as THREE from 'three/webgpu';
import { Fn, float, texture, uniform, uv, vec2, vec4 } from 'three/tsl';

/**
 * World-anchored wake foam buffer.
 *
 * A single R-channel texture covers a square of ocean centred on (usually) the
 * ship. Every frame it is decayed toward zero, resampled to compensate for the
 * centre having moved, and has fresh foam stamped into it wherever something is
 * moving. The water shader reads it as a mask.
 *
 * Two decisions worth spelling out:
 *
 * **The texture scrolls, the world does not.** Anchoring the buffer to the
 * camera or the ship and letting the foam ride along with it would make the
 * wake follow the hull like a decal — the one thing a wake must never do. So the
 * buffer's centre is a world coordinate, and when it changes the previous
 * contents are resampled by exactly the offset, in the opposite direction.
 * Anything shifted off the edge is gone, which is correct: it is out of the
 * region the shader can sample anyway.
 *
 * **The full Kelvin V is stamped every frame, not accumulated from a point.**
 * Depositing a dot at the hull and letting motion draw the trail gives a
 * straight line, not a wake. Real ship wakes are a fixed pattern in the hull's
 * frame — two arms at the Kelvin half-angle of ~19.5 degrees plus the turbulent
 * band astern — so that pattern is what gets deposited. Accumulation and decay
 * then do what they are actually good at: persistence, and the smearing that
 * makes a turning wake curve.
 *
 * Runs as two fullscreen fragment passes per frame. No compute, no storage
 * textures — this has to work on the WebGL2 backend unchanged.
 */

/** Emissions coalesced into one pass. One hull plus a few props is plenty. */
const MAX_EMITTERS = 4;

/** Exponential decay time constant. Foam is ~5% of peak after 5 s. */
const DECAY_TAU = 1.7;

/** Foam deposited per second at reference speed. */
const DEPOSIT_RATE = 1.9;

/** Speed, in m/s, at which foam generation saturates. */
const REFERENCE_SPEED = 7;

/** tan(19.47 deg) — the Kelvin wedge half-angle. */
const KELVIN_SLOPE = 0.3536;

/**
 * TSL node objects are structurally dynamic; the generated types cannot express
 * a uniform whose component type is only known at construction. Node-typed
 * fields are therefore `any` by design — the class's public API stays typed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
interface EmitterUniforms {
  /** vec2 world position. */
  position: any;
  /** vec2 unit heading. */
  direction: any;
  /** vec3: x = deposit amount, y = hull width, z = arm length. */
  params: any;
}

export class Wake {
  /** Foam accumulation texture. Stable reference — safe to bind once. */
  readonly texture: THREE.Texture;

  /** World-space size of the square the texture covers. */
  readonly extent: number;

  /** Add to the scene to make `setDebugVisible` do anything. */
  readonly debugObject: THREE.Object3D;

  /** Texture resolution per side. */
  readonly resolution: number;

  private readonly buffers: [THREE.RenderTarget, THREE.RenderTarget];
  private readonly output: THREE.RenderTarget;
  private readonly quad = new THREE.QuadMesh();

  private readonly accumulate: [THREE.NodeMaterial, THREE.NodeMaterial];
  private readonly copy: [THREE.NodeMaterial, THREE.NodeMaterial];
  private index = 0;

  private readonly uScroll = uniform(new THREE.Vector2());
  private readonly uDecay = uniform(1);
  private readonly uCenter = uniform(new THREE.Vector2());
  private readonly emitters: EmitterUniforms[] = [];

  /** Pending emissions: [x, z, heading, speed, width] per slot. */
  private readonly queue = new Float32Array(MAX_EMITTERS * 5);
  private queued = 0;

  private centerX_ = 0;
  private centerZ_ = 0;
  private appliedX = 0;
  private appliedZ = 0;

  private readonly debugMesh: THREE.Mesh;
  private readonly debugGeometry: THREE.PlaneGeometry;
  private readonly debugMaterial: THREE.MeshBasicNodeMaterial;
  private disposed = false;

  constructor(resolution = 512, extent = 420) {
    this.resolution = resolution;
    this.extent = extent;

    this.buffers = [makeTarget(resolution), makeTarget(resolution)];
    this.output = makeTarget(resolution);
    this.texture = this.output.texture;

    for (let i = 0; i < MAX_EMITTERS; i++) {
      this.emitters.push({
        position: uniform(new THREE.Vector2()),
        direction: uniform(new THREE.Vector2(1, 0)),
        params: uniform(new THREE.Vector3()),
      });
    }

    this.accumulate = [
      this.createAccumulateMaterial(this.buffers[0].texture),
      this.createAccumulateMaterial(this.buffers[1].texture),
    ];
    this.copy = [
      createCopyMaterial(this.buffers[0].texture),
      createCopyMaterial(this.buffers[1].texture),
    ];

    this.debugGeometry = new THREE.PlaneGeometry(extent, extent);
    this.debugGeometry.rotateX(-Math.PI / 2);
    this.debugMaterial = new THREE.MeshBasicNodeMaterial();
    this.debugMaterial.transparent = true;
    this.debugMaterial.depthWrite = false;
    this.debugMaterial.toneMapped = false;
    this.debugMaterial.colorNode = Fn(() => {
      const foam = texture(this.texture, uv()).r.clamp(0, 1).toVar();
      // Magenta grid tint so the debug overlay can never be mistaken for foam.
      return vec4(foam.mul(1.0), foam.mul(0.25), foam.mul(0.7), foam.mul(0.85).add(0.06));
    })();

    this.debugMesh = new THREE.Mesh(this.debugGeometry, this.debugMaterial);
    this.debugMesh.name = 'wake-debug';
    this.debugMesh.frustumCulled = false;
    this.debugMesh.renderOrder = 20;

    this.debugObject = new THREE.Group();
    this.debugObject.name = 'wake-probes';
    this.debugObject.visible = false;
    this.debugObject.add(this.debugMesh);
    this.debugMesh.position.y = 3;
  }

  /** Recentres the world footprint. Contents are resampled on the next update. */
  setCenter(x: number, z: number): void {
    this.centerX_ = x;
    this.centerZ_ = z;
  }

  /** Current world centre. Scalars, not a vector, so reading it per frame is free. */
  get centerX(): number {
    return this.centerX_;
  }

  get centerZ(): number {
    return this.centerZ_;
  }

  /**
   * Queues a wake deposit.
   *
   * `headingRadians` is `atan2(forward.z, forward.x)` — the direction the hull
   * is pointing, which is also what `Ship.heading` returns. `width` is the beam;
   * the wedge is built outward from it.
   */
  emit(x: number, z: number, headingRadians: number, speed: number, width: number): void {
    if (this.queued >= MAX_EMITTERS) return;
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(headingRadians)) return;
    if (!(speed > 0.05)) return;

    const base = this.queued * 5;
    this.queue[base] = x;
    this.queue[base + 1] = z;
    this.queue[base + 2] = headingRadians;
    this.queue[base + 3] = speed;
    this.queue[base + 4] = Math.max(0.5, width);
    this.queued++;
  }

  setDebugVisible(v: boolean): void {
    this.debugObject.visible = v;
  }

  /** Converts a world point to this buffer's uv, for the water shader. */
  uvAt(x: number, z: number, out: THREE.Vector2): THREE.Vector2 {
    return out.set((x - this.centerX_) / this.extent + 0.5, (z - this.centerZ_) / this.extent + 0.5);
  }

  update(dt: number, renderer: THREE.WebGPURenderer): void {
    if (this.disposed) return;
    const step = Math.min(Math.max(dt, 0), 0.1);

    setVec2(
      this.uScroll.value as THREE.Vector2,
      (this.centerX_ - this.appliedX) / this.extent,
      (this.centerZ_ - this.appliedZ) / this.extent,
    );
    this.uDecay.value = Math.exp(-step / DECAY_TAU);
    setVec2(this.uCenter.value as THREE.Vector2, this.centerX_, this.centerZ_);

    for (let i = 0; i < MAX_EMITTERS; i++) {
      const slot = this.emitters[i];
      const params = slot.params.value as THREE.Vector3;
      if (i >= this.queued) {
        params.set(0, 1, 1);
        continue;
      }
      const base = i * 5;
      const heading = this.queue[base + 2];
      const speed = this.queue[base + 3];
      const width = this.queue[base + 4];

      setVec2(slot.position.value as THREE.Vector2, this.queue[base], this.queue[base + 1]);
      setVec2(slot.direction.value as THREE.Vector2, Math.cos(heading), Math.sin(heading));

      const intensity = Math.min(1.4, speed / REFERENCE_SPEED);
      params.set(DEPOSIT_RATE * step * intensity, width, width * (5 + intensity * 7));
    }
    this.queued = 0;

    const previous = renderer.getRenderTarget();

    this.quad.material = this.accumulate[this.index];
    renderer.setRenderTarget(this.buffers[1 - this.index]);
    this.quad.render(renderer);
    this.index = 1 - this.index;

    // Resolve into a target whose texture reference never changes, so material
    // authors can bind `wake.texture` once at build time.
    this.quad.material = this.copy[this.index];
    renderer.setRenderTarget(this.output);
    this.quad.render(renderer);

    renderer.setRenderTarget(previous);

    this.appliedX = this.centerX_;
    this.appliedZ = this.centerZ_;
    this.debugObject.position.set(this.centerX_, 0, this.centerZ_);
  }

  /**
   * Clears the accumulation to empty water and re-anchors it at the current
   * centre.
   *
   * Foam persists for several seconds by design, so without this a capture would
   * carry in whatever the previous shot deposited. Both ping-pong buffers and the
   * resolved output are cleared, because the next `update` reads one of them.
   */
  reset(renderer: THREE.WebGPURenderer): void {
    if (this.disposed) return;

    const previousTarget = renderer.getRenderTarget();
    const previousClear = renderer.getClearColor(new THREE.Color());
    const previousAlpha = renderer.getClearAlpha();

    renderer.setClearColor(0x000000, 1);
    for (const target of [this.buffers[0], this.buffers[1], this.output]) {
      renderer.setRenderTarget(target);
      renderer.clear(true, false, false);
    }
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousClear, previousAlpha);

    // Scroll compensation is a delta against the last applied centre; leaving it
    // stale would resample the freshly cleared buffer by an arbitrary offset.
    this.appliedX = this.centerX_;
    this.appliedZ = this.centerZ_;
    this.queued = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.buffers[0].dispose();
    this.buffers[1].dispose();
    this.output.dispose();
    for (const material of this.accumulate) material.dispose();
    for (const material of this.copy) material.dispose();
    this.debugGeometry.dispose();
    this.debugMaterial.dispose();
    this.debugObject.removeFromParent();
    this.quad.geometry.dispose();
  }

  // ------------------------------------------------------------------ internals

  private createAccumulateMaterial(source: THREE.Texture): THREE.NodeMaterial {
    const extent = this.extent;
    const material = new THREE.NodeMaterial();
    material.depthTest = false;
    material.depthWrite = false;

    material.fragmentNode = Fn(() => {
      const coord = uv().toVar();
      const sourceUv = coord.add(this.uScroll).toVar();

      // Anything scrolled in from outside the previous footprint is unknown, and
      // clamp-to-edge would smear the border across the new region. Mask it.
      const edge = sourceUv.min(sourceUv.oneMinus()).toVar();
      const inside = edge.x.min(edge.y).smoothstep(0, 0.004).toVar();

      const previous = texture(source, sourceUv).r.mul(this.uDecay).mul(inside).toVar();

      const world = coord.sub(0.5).mul(extent).add(this.uCenter).toVar();
      const deposit = float(0).toVar();

      for (let i = 0; i < MAX_EMITTERS; i++) {
        const slot = this.emitters[i];
        const amount = slot.params.x;
        const width = slot.params.y;
        const armLength = slot.params.z;

        const delta = world.sub(slot.position).toVar();
        const forward = slot.direction;
        // Distance astern (positive behind the hull) and lateral offset.
        const along = delta.dot(forward).negate().toVar();
        const lateral = delta.dot(vec2(forward.y.negate(), forward.x)).abs().toVar();

        // The wedge: arms leave the hull at the Kelvin half-angle and the crest
        // line softens as it spreads.
        const arm = width.mul(0.45).add(along.mul(KELVIN_SLOPE)).toVar();
        const armWidth = width.mul(0.3).add(along.mul(0.055)).max(0.4).toVar();
        const armOffset = lateral.sub(arm).div(armWidth).toVar();
        const armFoam = armOffset.mul(armOffset).min(24).negate().exp().toVar();

        // Fade along the arms, and cut everything ahead of the bow.
        const lengthFade = float(1).sub(along.div(armLength)).clamp(0, 1).toVar();
        const behind = along.smoothstep(width.mul(-0.45), width.mul(0.35)).toVar();

        // Turbulent water directly astern — the bright churn at the transom.
        const sternOffset = delta
          .add(forward.mul(width.mul(0.75)))
          .length()
          .div(width.mul(0.85))
          .toVar();
        const sternFoam = sternOffset.mul(sternOffset).min(24).negate().exp().toVar();

        deposit.addAssign(
          armFoam.mul(lengthFade).mul(behind).mul(0.85).add(sternFoam).mul(amount),
        );
      }

      return vec4(previous.add(deposit).clamp(0, 1), 0, 0, 1);
    })();

    return material;
  }
}

function createCopyMaterial(source: THREE.Texture): THREE.NodeMaterial {
  const material = new THREE.NodeMaterial();
  material.depthTest = false;
  material.depthWrite = false;
  material.fragmentNode = Fn(() => vec4(texture(source, uv()).r, 0, 0, 1))();
  return material;
}

function makeTarget(size: number): THREE.RenderTarget {
  const target = new THREE.RenderTarget(size, size, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    // Clamped, not repeated: foam must not wrap around to the far side of the
    // world when the ship leaves the footprint.
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  return target;
}

function setVec2(target: THREE.Vector2, x: number, y: number): THREE.Vector2 {
  target.x = x;
  target.y = y;
  return target;
}
