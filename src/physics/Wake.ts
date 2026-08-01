import * as THREE from 'three/webgpu';
import { Fn, float, mix, texture, uniform, uv, vec2, vec4 } from 'three/tsl';

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

/**
 * Foam deposited per second at reference speed.
 *
 * As with the breaking-crest rate, what matters is `DEPOSIT_RATE * DECAY_TAU`,
 * the coverage a continuously-emitting hull settles at. At 1.9 that product was
 * 3.2 before the intensity multiplier and the stern term were even applied, so
 * the whole wedge clamped to solid white and the wake read as a sheet of paper
 * being dragged behind the ship. 0.4 leaves the turbulent band astern near white
 * and lets the arms fall away from it.
 */
const DEPOSIT_RATE = 0.4;

/** Speed, in m/s, at which foam generation saturates. */
const REFERENCE_SPEED = 7;

/** tan(19.47 deg) — the Kelvin wedge half-angle. */
const KELVIN_SLOPE = 0.3536;

/** Cascade slots the accumulate pass is built with. Matches `OceanMaterial`. */
const WAKE_CASCADES = 3;

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
  /** Frame step, seconds, so deposits are a rate rather than a per-frame amount. */
  private readonly uStep = uniform(1 / 60);
  /**
   * Jacobian below which the surface counts as breaking.
   *
   * Low, because folding is rare: the measured sea state carries a mean Jacobian
   * of 0.86/0.95/0.98 per cascade and only about 0.1% of the surface is actually
   * folded at any instant, against a few percent whitecap coverage. A threshold
   * loose enough to catch "nearly folding" catches most of the ocean.
   */
  private readonly uBreakThreshold = uniform(0.14);
  /**
   * Foam deposited per second by fully-broken water.
   *
   * The value that matters is `rate * DECAY_TAU`, which is the coverage this
   * settles at under continuous breaking — an equilibrium, not a per-frame
   * amount. At 2.6 that product was 4.4 and clamped to 1, so anything that broke
   * even weakly saturated to solid white within a frame or two. 0.5 settles just
   * under a fully-white 1 for water that is breaking hard and continuously, and
   * proportionally less for everything else.
   */
  private readonly uBreakRate = uniform(0.5);
  /** Rain rate, 0..1. */
  private readonly uRainAgitation = uniform(0);
  /** Foam per second deposited by rain at full intensity. */
  private readonly uRainRate = uniform(0.22);

  /**
   * Wave derivative bindings for the breaking-crest term.
   *
   * Built once for the maximum cascade count and re-pointed by `setCascades`,
   * for the same reason `OceanMaterial` does it: a tier change recreates the
   * simulation's targets, and rebuilding this material to follow them would
   * recompile a shader mid-session and leak what it replaced.
   */
  private readonly derivativeNodes: any[] = [];
  private readonly uTileSizes: any[] = [];
  private readonly uCascadeWeights: any[] = [];
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

  /**
   * @param waves Derivative fields and tile sizes, for the breaking-crest term.
   *
   * 1024 rather than 512 by default: the buffer now carries whitecaps as well as
   * the wake, and whitecap edges are decimetre features. Over a 420 m footprint
   * 512 is 0.82 m per texel, which turns a crest streak into a smear.
   */
  constructor(
    waves: { derivativeTextures: THREE.Texture[]; tileSizes: number[] },
    resolution = 1024,
    extent = 420,
  ) {
    this.resolution = resolution;
    this.extent = extent;

    for (let i = 0; i < WAKE_CASCADES; i++) {
      const source = Math.min(i, waves.derivativeTextures.length - 1);
      this.derivativeNodes.push(texture(waves.derivativeTextures[source]) as any);
      this.uTileSizes.push(uniform(waves.tileSizes[source]));
      this.uCascadeWeights.push(uniform(i < waves.derivativeTextures.length ? 1 : 0));
    }

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

  /** Re-points the wave bindings after a tier change. See `derivativeNodes`. */
  setCascades(derivativeTextures: THREE.Texture[], tileSizes: number[]): void {
    const active = Math.min(derivativeTextures.length, WAKE_CASCADES);
    for (let i = 0; i < WAKE_CASCADES; i++) {
      const source = Math.min(i, active - 1);
      this.derivativeNodes[i].value = derivativeTextures[source];
      this.uTileSizes[i].value = tileSizes[source];
      this.uCascadeWeights[i].value = i < active ? 1 : 0;
    }
  }

  /** Rain rate, 0..1, driving the agitation term. */
  setRainAgitation(intensity: number): void {
    this.uRainAgitation.value = Math.max(0, Math.min(1, intensity));
  }

  /** Tunes how readily the surface is treated as breaking, and how fast it foams. */
  setBreaking(threshold: number, rate: number): void {
    this.uBreakThreshold.value = threshold;
    this.uBreakRate.value = Math.max(0, rate);
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
    this.uStep.value = step;
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

      // --- breaking crests ----------------------------------------------------
      //
      // Whitecaps deposit into the same buffer as the wake, and for the same
      // reason they belong in a buffer at all: foam is *history*. Air entrained
      // by a wave that broke two seconds ago is still on the water, drifting and
      // dissolving, long after the wave itself has moved on.
      //
      // Evaluating the fold per fragment each frame — which is what the surface
      // used to do — cannot express that. It can only ever show where the water
      // is folding *now*, so foam appears and vanishes with the wave instead of
      // being left behind by it, and to read as continuous at all it has to be
      // spread far more widely than real whitecaps are. That is why the near
      // field was a third white.
      //
      // Here the same fold drives a *rate*, and persistence and dissipation are
      // left to the accumulation. Coverage can then be sparse and still read as
      // foam, because what the eye integrates is the trail, not the instant.
      const fold = float(1).toVar();
      for (let i = 0; i < WAKE_CASCADES; i++) {
        const d = this.derivativeNodes[i].sample(world.div(this.uTileSizes[i])).toVar();
        // Unused cascades are weighted to 1 — the neutral value for a running
        // minimum — rather than to 0, which would read as maximal folding
        // everywhere and paint the whole ocean white.
        fold.assign(fold.min(mix(float(1), d.z, this.uCascadeWeights[i])));
      }
      // Only genuinely folding water breaks. The threshold is deliberately
      // tighter than the old per-frame mask could afford to be.
      const breaking = fold.smoothstep(this.uBreakThreshold, this.uBreakThreshold.sub(0.22));
      deposit.addAssign(breaking.mul(this.uBreakRate).mul(this.uStep));

      // Rain agitation. Heavy rain aerates a surface on its own — it goes white
      // in a downpour whether or not the waves are steep enough to break — so
      // this is a separate, unconditional contribution rather than a bias on the
      // fold threshold. Broken up so it reads as a stipple rather than a wash.
      const stipple = rainStipple(world.mul(0.55)).toVar();
      deposit.addAssign(
        this.uRainAgitation.mul(stipple.mul(0.7).add(0.3)).mul(this.uRainRate).mul(this.uStep),
      );

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

/**
 * Cheap world-space stipple for the rain agitation term.
 *
 * A plain hash rather than interpolated noise: rain-aerated water is a spray of
 * discrete bright specks, and the hard edges a hash produces are closer to that
 * than a smooth field would be. It is also evaluated once per texel of the foam
 * buffer rather than per screen pixel, so it can afford to be blunt.
 */
const rainStipple = /*@__PURE__*/ Fn(([p]: [any]) => {
  const h = vec2(p.dot(vec2(127.1, 311.7)), p.dot(vec2(269.5, 183.3))).toVar();
  return h.sin().mul(43758.5453).fract().x;
});

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
