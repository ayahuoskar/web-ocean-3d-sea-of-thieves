import * as THREE from 'three/webgpu';
import { Fn, float, ivec2, texture, textureLoad, uniform, uv, vec2, vec4 } from 'three/tsl';
import { butterflyPassNode, cMul, createFFTResources, type FFTResources } from './FFT';
import {
  CASCADES,
  createSpectrumTexture,
  generateInitialSpectrum,
  GRAVITY,
  type CascadeConfig,
  type SpectrumParams,
} from './Spectrum';

/**
 * Spectral ocean surface.
 *
 * Per cascade and per frame:
 *   1. evolve   h0(k) -> h(k, t) and derive four packed complex spectra
 *   2. IFFT     log2(N) horizontal + log2(N) vertical butterfly passes, x2 pairs
 *   3. assemble unpack into a displacement texture and a derivative texture
 *
 * Field packing across the two complex slots of two RGBA ping-pong pairs
 * (8 real fields, all used):
 *
 *   A.c0 -> real: Dy (height)          imag: dDx/dz
 *   A.c1 -> real: Dx                   imag: Dz
 *   B.c0 -> real: dDy/dx               imag: dDy/dz
 *   B.c1 -> real: dDx/dx               imag: dDz/dz
 *
 * Packing two real fields into one complex transform halves the pass count: an
 * IFFT of (P + iQ) for real P and Q returns P in the real component and Q in the
 * imaginary one. The cross term dDx/dz is carried so the foam mask can use a
 * true Jacobian rather than the usual diagonal-only approximation, which
 * under-reports folding on obliquely travelling crests.
 */

interface PingPong {
  read: THREE.RenderTarget;
  write: THREE.RenderTarget;
}

interface Cascade {
  config: CascadeConfig;
  h0: THREE.DataTexture;
  pairA: PingPong;
  pairB: PingPong;
  /** RGBA: xyz = displacement, w = foam/folding mask. */
  displacement: THREE.RenderTarget;
  /** RG = surface slope, B = Jacobian, A = |slope|^2 for variance recovery. */
  derivatives: THREE.RenderTarget;
  evolveA: THREE.NodeMaterial;
  evolveB: THREE.NodeMaterial;
  butterflyA: THREE.NodeMaterial[];
  butterflyB: THREE.NodeMaterial[];
  assembleDisplacement: THREE.NodeMaterial;
  assembleDerivatives: THREE.NodeMaterial;
}

/**
 * Height-field binding slots, fixed so a tier change re-points rather than
 * rebuilds. Matches `MAX_CASCADES` in `OceanMaterial`.
 */
const HEIGHT_SLOTS = 3;

export interface OceanSimulationOptions {
  size: 128 | 256 | 512;
  cascadeCount: 1 | 2 | 3;
  params: SpectrumParams;
}

export class OceanSimulation {
  private readonly renderer: THREE.WebGPURenderer;
  private readonly quad = new THREE.QuadMesh();
  private readonly cascades: Cascade[] = [];
  private fft: FFTResources;

  private readonly uTime = uniform(0);
  private readonly uStage = uniform(0);
  private readonly uChoppiness = uniform(1.05);

  private size: OceanSimulationOptions['size'];
  private cascadeCount: OceanSimulationOptions['cascadeCount'];
  private params: SpectrumParams;
  private disposed = false;

  constructor(renderer: THREE.WebGPURenderer, options: OceanSimulationOptions) {
    this.renderer = renderer;
    this.size = options.size;
    this.cascadeCount = options.cascadeCount;
    this.params = { ...options.params };
    this.fft = createFFTResources(this.size);
    this.build();
  }

  // ---------------------------------------------------------------- public API

  /** Displacement textures, one per active cascade, for the surface material. */
  /**
   * Surface elevation at a world XZ, as a TSL function.
   *
   * The same displacement fields the ocean mesh is built from, summed over the
   * cascades — so a consumer asking "where is the water here" gets the answer the
   * viewer can see rather than a plane at sea level.
   *
   * Deliberately vertical-only. The horizontal (choppy) components displace a
   * vertex sideways as well as up, so the true surface is not a heightfield and
   * inverting it needs iteration. For finding where an eye ray crosses the
   * surface, the vertical term carries essentially all of the answer and the
   * lateral error is a fraction of a wavelength.
   *
   * Safe to bake into a node graph and keep. The bindings are fixed slots that
   * `resize` re-points, exactly as `OceanMaterial.setCascades` does — a consumer
   * that rebuilt its graph after every tier change would be recompiling a shader
   * mid-session, which is the thing the whole cascade-slot arrangement exists to
   * avoid.
   */
  heightNode(): (worldXZ: any) => any {
    this.ensureHeightBindings();
    const nodes = this.heightNodes;
    const tiles = this.heightTiles;
    const weights = this.heightWeights;
    return (worldXZ: any) => {
      let sum: any = float(0);
      for (let i = 0; i < nodes.length; i++) {
        sum = sum.add(nodes[i].sample(vec2(worldXZ).div(tiles[i])).y.mul(weights[i]));
      }
      return sum;
    };
  }

  /** Creates the fixed height-field slots on first use, and points them. */
  private ensureHeightBindings(): void {
    if (this.heightNodes.length === 0) {
      for (let i = 0; i < HEIGHT_SLOTS; i++) {
        const source = Math.min(i, this.displacementTextures.length - 1);
        this.heightNodes.push(texture(this.displacementTextures[source]) as any);
        this.heightTiles.push(uniform(this.tileSizes[source]));
        this.heightWeights.push(uniform(i < this.displacementTextures.length ? 1 : 0));
      }
      return;
    }
    this.repointHeightBindings();
  }

  /** Re-points the height slots at the current targets. Called after `resize`. */
  private repointHeightBindings(): void {
    if (this.heightNodes.length === 0) return;
    const textures = this.displacementTextures;
    const active = Math.min(textures.length, HEIGHT_SLOTS);
    for (let i = 0; i < HEIGHT_SLOTS; i++) {
      const source = Math.min(i, active - 1);
      this.heightNodes[i].value = textures[source];
      this.heightTiles[i].value = this.tileSizes[source];
      this.heightWeights[i].value = i < active ? 1 : 0;
    }
  }

  // Fixed height-field slots, re-pointed rather than rebuilt. See `heightNode`.
  private readonly heightNodes: any[] = [];
  private readonly heightTiles: any[] = [];
  private readonly heightWeights: any[] = [];

  get displacementTextures(): THREE.Texture[] {
    return this.cascades.map((c) => c.displacement.texture);
  }

  get derivativeTextures(): THREE.Texture[] {
    return this.cascades.map((c) => c.derivatives.texture);
  }

  /** Render targets themselves, for CPU readback by the buoyancy sampler. */
  get displacementTargets(): THREE.RenderTarget[] {
    return this.cascades.map((c) => c.displacement);
  }

  get tileSizes(): number[] {
    return this.cascades.map((c) => c.config.tileSize);
  }

  get activeCascadeCount(): number {
    return this.cascades.length;
  }

  get spectrumParams(): Readonly<SpectrumParams> {
    return this.params;
  }

  setChoppiness(value: number): void {
    this.uChoppiness.value = value;
  }


  /** Re-derives h0 from new wind/wavelength. Cheap enough to call on slider input. */
  updateSpectrum(params: Partial<SpectrumParams>): void {
    this.params = { ...this.params, ...params };
    for (let i = 0; i < this.cascades.length; i++) {
      const cascade = this.cascades[i];
      const data = generateInitialSpectrum(this.size, cascade.config, this.params, 1337 + i * 977);
      (cascade.h0.image.data as Float32Array).set(data);
      cascade.h0.needsUpdate = true;
    }
  }

  /** Rebuilds all GPU resources at a new resolution / cascade count. */
  resize(
    size: OceanSimulationOptions['size'],
    cascadeCount: OceanSimulationOptions['cascadeCount'],
  ): void {
    if (size === this.size && cascadeCount === this.cascadeCount) return;
    this.releaseCascades();
    this.size = size;
    this.cascadeCount = cascadeCount;
    this.fft.butterfly.dispose();
    this.fft = createFFTResources(size);
    this.build();
    this.repointHeightBindings();
  }

  update(elapsed: number): void {
    if (this.disposed) return;
    this.uTime.value = elapsed;

    const previousTarget = this.renderer.getRenderTarget();

    for (const cascade of this.cascades) {
      this.runPass(cascade.evolveA, cascade.pairA.read);
      this.runPass(cascade.evolveB, cascade.pairB.read);

      this.runFFT(cascade.pairA, cascade.butterflyA);
      this.runFFT(cascade.pairB, cascade.butterflyB);

      this.runPass(cascade.assembleDisplacement, cascade.displacement);
      this.runPass(cascade.assembleDerivatives, cascade.derivatives);
    }

    this.renderer.setRenderTarget(previousTarget);
  }

  dispose(): void {
    this.disposed = true;
    this.releaseCascades();
    this.fft.butterfly.dispose();
    this.quad.geometry.dispose();
  }

  // ------------------------------------------------------------------ internals

  private runPass(material: THREE.NodeMaterial, target: THREE.RenderTarget): void {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }

  /**
   * Runs 2*stages butterfly passes, swapping the ping-pong after each. Because
   * the count is always even the pair ends the frame in the orientation it
   * started in, which is what lets the stage materials bind their source texture
   * once at build time (even stages read `read`, odd stages read `write`) and
   * lets the assemble pass bind `read` permanently.
   */
  private runFFT(pair: PingPong, materials: THREE.NodeMaterial[]): void {
    for (let stage = 0; stage < materials.length; stage++) {
      this.uStage.value = stage % this.fft.stages;
      this.runPass(materials[stage], pair.write);
      const swap = pair.read;
      pair.read = pair.write;
      pair.write = swap;
    }
  }

  private build(): void {
    const configs = CASCADES.slice(0, this.cascadeCount);
    for (let i = 0; i < configs.length; i++) {
      this.cascades.push(this.buildCascade(configs[i], i));
    }
  }

  private buildCascade(config: CascadeConfig, index: number): Cascade {
    const size = this.size;
    const h0 = createSpectrumTexture(
      size,
      generateInitialSpectrum(size, config, this.params, 1337 + index * 977),
    );

    const pairA = makePingPong(size);
    const pairB = makePingPong(size);

    return {
      config,
      h0,
      pairA,
      pairB,
      displacement: makeOutputTarget(size),
      derivatives: makeOutputTarget(size),
      evolveA: this.createEvolveMaterial(h0, config, 'A'),
      evolveB: this.createEvolveMaterial(h0, config, 'B'),
      butterflyA: this.createButterflyMaterials(pairA),
      butterflyB: this.createButterflyMaterials(pairB),
      assembleDisplacement: this.createAssembleMaterial(pairA, pairB, config, 'displacement'),
      assembleDerivatives: this.createAssembleMaterial(pairA, pairB, config, 'derivatives'),
    };
  }

  /**
   * One material per butterfly stage, built once — node graph construction is
   * expensive and must never happen inside the frame loop.
   */
  private createButterflyMaterials(pair: PingPong): THREE.NodeMaterial[] {
    const materials: THREE.NodeMaterial[] = [];
    const total = this.fft.stages * 2;

    for (let i = 0; i < total; i++) {
      const direction: 0 | 1 = i < this.fft.stages ? 0 : 1;
      const source = i % 2 === 0 ? pair.read.texture : pair.write.texture;
      const material = new THREE.NodeMaterial();
      material.fragmentNode = butterflyPassNode(this.fft, source, this.uStage, direction);
      material.depthTest = false;
      material.depthWrite = false;
      materials.push(material);
    }
    return materials;
  }

  private createEvolveMaterial(
    h0: THREE.DataTexture,
    config: CascadeConfig,
    pair: 'A' | 'B',
  ): THREE.NodeMaterial {
    const size = this.size;
    const deltaK = (2 * Math.PI) / config.tileSize;
    const time = this.uTime;

    const material = new THREE.NodeMaterial();
    material.depthTest = false;
    material.depthWrite = false;

    material.fragmentNode = Fn(() => {
      const coord = ivec2(
        float(size).mul(uv().x).floor().toInt(),
        float(size).mul(uv().y).floor().toInt(),
      ).toVar();

      const half = float(size * 0.5);
      const kx = float(coord.x).sub(half).mul(deltaK).toVar();
      const kz = float(coord.y).sub(half).mul(deltaK).toVar();
      const kLen = vec2(kx, kz).length().max(1e-6).toVar();

      const spectrum = textureLoad(h0, coord).toVar();
      const h0k = vec2(spectrum.x, spectrum.y).toVar();
      // Conjugate of h0(-k); the mirrored half was baked in at generation time.
      const h0MinusKConj = vec2(spectrum.z, spectrum.w.negate()).toVar();

      // Deep-water dispersion. Omega is deliberately not quantised to a common
      // multiple, so the surface never becomes exactly periodic in time.
      const omega = float(GRAVITY).mul(kLen).sqrt().toVar();
      const phase = omega.mul(time).toVar();
      const expIwt = vec2(phase.cos(), phase.sin()).toVar();
      const expMinusIwt = vec2(phase.cos(), phase.sin().negate()).toVar();

      // h(k, t) = h0(k) e^{iwt} + conj(h0(-k)) e^{-iwt}
      const h = cMul(h0k, expIwt).add(cMul(h0MinusKConj, expMinusIwt)).toVar();

      const nx = kx.div(kLen).toVar();
      const nz = kz.div(kLen).toVar();

      // Multiplying a complex value by i is a component swap with a sign flip.
      const iH = vec2(h.y.negate(), h.x).toVar();

      if (pair === 'A') {
        // c0 = h + i * spectrum(dDx/dz), where dDx/dz has spectrum (kx kz / |k|) h
        const dxdz = h.mul(nx).mul(nz).mul(kLen).toVar();
        const c0 = vec2(h.x.sub(dxdz.y), h.y.add(dxdz.x)).toVar();
        // Dx has spectrum -i (kx/|k|) h, Dz has spectrum -i (kz/|k|) h
        const dx = iH.mul(nx).negate().toVar();
        const dz = iH.mul(nz).negate().toVar();
        const c1 = vec2(dx.x.sub(dz.y), dx.y.add(dz.x)).toVar();
        return vec4(c0.x, c0.y, c1.x, c1.y);
      }

      // c0 = dDy/dx + i dDy/dz, both with spectrum i k h
      const slopeX = iH.mul(kx).toVar();
      const slopeZ = iH.mul(kz).toVar();
      const c0 = vec2(slopeX.x.sub(slopeZ.y), slopeX.y.add(slopeZ.x)).toVar();

      // c1 = dDx/dx + i dDz/dz, with spectra (kx^2/|k|) h and (kz^2/|k|) h
      const ddxdx = h.mul(kx.mul(kx).div(kLen)).toVar();
      const ddzdz = h.mul(kz.mul(kz).div(kLen)).toVar();
      const c1 = vec2(ddxdx.x.sub(ddzdz.y), ddxdx.y.add(ddzdz.x)).toVar();
      return vec4(c0.x, c0.y, c1.x, c1.y);
    })();

    return material;
  }

  private createAssembleMaterial(
    pairA: PingPong,
    pairB: PingPong,
    config: CascadeConfig,
    output: 'displacement' | 'derivatives',
  ): THREE.NodeMaterial {
    const size = this.size;
    const choppiness = this.uChoppiness;

    const material = new THREE.NodeMaterial();
    material.depthTest = false;
    material.depthWrite = false;

    material.fragmentNode = Fn(() => {
      const coord = ivec2(
        float(size).mul(uv().x).floor().toInt(),
        float(size).mul(uv().y).floor().toInt(),
      ).toVar();

      // The spectrum is stored centred on k = 0, so the inverse transform comes
      // out with an alternating sign across the lattice. Undo it here.
      const parity = float(coord.x.add(coord.y).mod(2)).mul(-2).add(1).toVar();

      const a = textureLoad(pairA.read.texture, coord).mul(parity).toVar();
      const b = textureLoad(pairB.read.texture, coord).mul(parity).toVar();

      const lambda = choppiness.mul(config.choppiness).toVar();

      // Jacobian of the horizontal displacement map. Where it falls below 1 the
      // surface is folding onto itself — physically where whitecaps form.
      const jxx = float(1).add(b.z.mul(lambda)).toVar();
      const jzz = float(1).add(b.w.mul(lambda)).toVar();
      const jxz = a.y.mul(lambda).toVar();
      const jacobian = jxx.mul(jzz).sub(jxz.mul(jxz)).toVar();

      if (output === 'displacement') {
        // Store the raw Jacobian rather than a pre-thresholded foam value. The
        // surface material combines cascades by taking the most-folded one; a
        // pre-baked per-cascade mask can only be summed, which saturates the
        // whole surface to white as soon as two cascades fold at all.
        return vec4(a.z.mul(lambda), a.x, a.w.mul(lambda), jacobian);
      }

      // Alpha carries the second moment of the slope, and it is the whole reason
      // the distant water stopped boiling.
      //
      // Mipmapping a slope field averages the slope. That is right for the
      // *normal* and wrong for everything computed from it, because specular
      // response is not linear in slope: a footprint holding a hundred wave
      // facets averages to a mean near zero, so the shader sees a mirror, and the
      // mirror flickers as the mean wanders between frames. It is the classic
      // failure that LEAN and Toksvig mapping exist to solve, and on an ocean at
      // a hundred metres it is the single most visible artefact in the frame.
      //
      // Storing |slope|^2 lets the same hardware mip chain deliver E[s^2]
      // alongside E[s], and the variance the filtering destroyed comes back out
      // as E[s^2] - |E[s]|^2 for free. Isotropic rather than per-axis because
      // only one channel is spare, and the covariance term is worth less here
      // than the two diagonal ones. `OceanMaterial` folds it into alpha^2.
      return vec4(b.x, b.y, jacobian, b.x.mul(b.x).add(b.y.mul(b.y)));
    })();

    return material;
  }

  private releaseCascades(): void {
    for (const cascade of this.cascades) {
      cascade.h0.dispose();
      cascade.pairA.read.dispose();
      cascade.pairA.write.dispose();
      cascade.pairB.read.dispose();
      cascade.pairB.write.dispose();
      cascade.displacement.dispose();
      cascade.derivatives.dispose();
      cascade.evolveA.dispose();
      cascade.evolveB.dispose();
      cascade.assembleDisplacement.dispose();
      cascade.assembleDerivatives.dispose();
      for (const m of cascade.butterflyA) m.dispose();
      for (const m of cascade.butterflyB) m.dispose();
    }
    this.cascades.length = 0;
  }
}

function makeTarget(
  size: number,
  filter: THREE.MagnificationTextureFilter,
  wrap: THREE.Wrapping,
): THREE.RenderTarget {
  return new THREE.RenderTarget(size, size, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: filter,
    magFilter: filter,
    wrapS: wrap,
    wrapT: wrap,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
}

/**
 * Output targets are sampled at arbitrary world scale by the surface shader, so
 * a 16 m tile can span far less than a pixel at distance. Without a mip chain
 * that undersampling shows up as a shimmering speckle across the whole mid-field
 * — by far the most visible artefact on a moving ocean. Trilinear filtering over
 * generated mips lets the GPU pick the right level per pixel.
 *
 * `anisotropy = 1` is deliberate, and it is the opposite of the usual advice.
 *
 * Anisotropic filtering picks the mip from the *minor* axis of the pixel
 * footprint and then takes up to `anisotropy` taps along the major axis to cover
 * the rest. That is a good trade when the ratio is within budget. Water viewed
 * from near its own surface is the case where it is not: at a few hundred metres
 * the footprint is a fraction of a metre across and tens of metres long, a ratio
 * of order a hundred to one, so any affordable tap count leaves most of the
 * footprint unsampled — while the low mip it selected has already let the full
 * high-frequency detail back in. The result is sharper *and* noisier.
 *
 * Measured, on the far-field band under the horizon at High (mean |laplacian|,
 * `tests/gallery-jitter.spec.ts`): anisotropy 16 -> 6.80, 4 -> 6.28, 2 -> 5.01,
 * 1 -> 3.52. Monotonic, and the wrong way round from the usual expectation.
 * Dropping to 1 makes the hardware choose the major-axis mip, which is the level
 * that actually covers the footprint. The detail given up was never resolvable;
 * it was aliasing.
 */
function makeOutputTarget(size: number): THREE.RenderTarget {
  const target = new THREE.RenderTarget(size, size, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: true,
  });
  target.texture.anisotropy = 1;
  return target;
}

function makePingPong(size: number): PingPong {
  return {
    read: makeTarget(size, THREE.NearestFilter, THREE.ClampToEdgeWrapping),
    write: makeTarget(size, THREE.NearestFilter, THREE.ClampToEdgeWrapping),
  };
}

export type { Cascade };
