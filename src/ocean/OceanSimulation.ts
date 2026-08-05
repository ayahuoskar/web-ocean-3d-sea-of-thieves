import * as THREE from 'three/webgpu';
import { Fn, float, int, ivec2, select, texture, textureLoad, uniform, uv, vec2, vec4 } from 'three/tsl';
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
  /**
   * One ping-pong of double-width targets: pair A in `x < size`, pair B beyond.
   *
   * It was two independent ping-pongs stepped by two sets of passes. They are
   * transformed identically at identical size, so that paid the per-pass cost
   * twice for one pass of work — and a pass here costs ~53 microseconds however
   * little it draws. See `butterflyPassNode`.
   */
  pair: PingPong;
  /** RGBA: xyz = displacement, w = foam/folding mask. */
  displacement: THREE.RenderTarget;
  /** RG = surface slope, B = Jacobian, A = |slope|^2 for variance recovery. */
  derivatives: THREE.RenderTarget;
  evolve: THREE.NodeMaterial;
  butterfly: THREE.NodeMaterial[];
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

  /**
   * Texels per side of every cascade's output.
   *
   * Published because a tile size alone does not say how finely the field is
   * sampled, and the surface needs metres per texel to choose a mip level to
   * displace geometry from. See `ocean/meshSampling`.
   */
  get resolution(): number {
    return this.size;
  }

  /** Longest wavelength each cascade carries, metres. See `cascadeReach`. */
  get maxWavelengths(): number[] {
    return this.cascades.map((c) => c.config.maxWavelength);
  }

  /**
   * Everything the surface needs to know about the cascade set, as one object.
   *
   * The surface takes this both when its graph is built and again after a tier
   * change re-points it. Handing over one object rather than a list of
   * positional arguments is what stops the two sites drifting — the graph was
   * once built from inputs one of which the re-point silently never supplied.
   */
  get fields(): {
    displacementTextures: THREE.Texture[];
    derivativeTextures: THREE.Texture[];
    tileSizes: number[];
    maxWavelengths: number[];
    resolution: number;
  } {
    return {
      displacementTextures: this.displacementTextures,
      derivativeTextures: this.derivativeTextures,
      tileSizes: this.tileSizes,
      maxWavelengths: this.maxWavelengths,
      resolution: this.resolution,
    };
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
      this.runPass(cascade.evolve, cascade.pair.read);
      this.runFFT(cascade.pair, cascade.butterfly);

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

    const pair = makePingPong(size);

    return {
      config,
      h0,
      pair,
      displacement: makeOutputTarget(size),
      derivatives: makeOutputTarget(size),
      evolve: this.createEvolveMaterial(h0, config),
      butterfly: this.createButterflyMaterials(pair),
      assembleDisplacement: this.createAssembleMaterial(pair, config, 'displacement'),
      assembleDerivatives: this.createAssembleMaterial(pair, config, 'derivatives'),
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

  /**
   * Evolves `h0(k)` to `h(k, t)` and derives all four packed spectra in one pass
   * across the whole double-width target.
   *
   * It was two passes, one per pair, and everything up to and including `h`
   * itself was computed identically in both — the dispersion, the trig, the
   * mirrored-conjugate combination. This computes `h` once per texel and selects
   * which pair's derived spectra to emit from the texel's half.
   *
   * Both halves' arithmetic is evaluated and one is discarded, which is the
   * honest cost of the fold: a `select` is not a branch. It buys a pass, and a
   * pass is ~53 microseconds against a few dozen ALU operations on 65 000
   * texels, so the trade is not close.
   */
  private createEvolveMaterial(
    h0: THREE.DataTexture,
    config: CascadeConfig,
  ): THREE.NodeMaterial {
    const size = this.size;
    const deltaK = (2 * Math.PI) / config.tileSize;
    const time = this.uTime;

    const material = new THREE.NodeMaterial();
    material.depthTest = false;
    material.depthWrite = false;

    material.fragmentNode = Fn(() => {
      const coord = ivec2(
        float(size * 2).mul(uv().x).floor().toInt(),
        float(size).mul(uv().y).floor().toInt(),
      ).toVar();

      // Which half, and the wavenumber coordinate within it. `h0` is one
      // transform wide, so it is always read at the local x.
      const inB = coord.x.greaterThanEqual(int(size));
      const localX = coord.x.sub(select(inB, int(size), int(0))).toVar();

      const half = float(size * 0.5);
      const kx = float(localX).sub(half).mul(deltaK).toVar();
      const kz = float(coord.y).sub(half).mul(deltaK).toVar();
      const kLen = vec2(kx, kz).length().max(1e-6).toVar();

      const spectrum = textureLoad(h0, ivec2(localX, coord.y)).toVar();
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

      // --- pair A ---------------------------------------------------------
      // c0 = h + i * spectrum(dDx/dz), where dDx/dz has spectrum (kx kz / |k|) h
      const aDxdz = h.mul(nx).mul(nz).mul(kLen).toVar();
      const aC0 = vec2(h.x.sub(aDxdz.y), h.y.add(aDxdz.x)).toVar();
      // Dx has spectrum -i (kx/|k|) h, Dz has spectrum -i (kz/|k|) h
      const aDx = iH.mul(nx).negate().toVar();
      const aDz = iH.mul(nz).negate().toVar();
      const aC1 = vec2(aDx.x.sub(aDz.y), aDx.y.add(aDz.x)).toVar();

      // --- pair B ---------------------------------------------------------
      // c0 = dDy/dx + i dDy/dz, both with spectrum i k h
      const slopeX = iH.mul(kx).toVar();
      const slopeZ = iH.mul(kz).toVar();
      const bC0 = vec2(slopeX.x.sub(slopeZ.y), slopeX.y.add(slopeZ.x)).toVar();

      // c1 = dDx/dx + i dDz/dz, with spectra (kx^2/|k|) h and (kz^2/|k|) h
      const ddxdx = h.mul(kx.mul(kx).div(kLen)).toVar();
      const ddzdz = h.mul(kz.mul(kz).div(kLen)).toVar();
      const bC1 = vec2(ddxdx.x.sub(ddzdz.y), ddxdx.y.add(ddzdz.x)).toVar();

      return select(
        inB,
        vec4(bC0.x, bC0.y, bC1.x, bC1.y),
        vec4(aC0.x, aC0.y, aC1.x, aC1.y),
      );
    })();

    return material;
  }

  private createAssembleMaterial(
    pair: PingPong,
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

      // Pair B sits one transform-width to the right in the same texture.
      const a = textureLoad(pair.read.texture, coord).mul(parity).toVar();
      const b = textureLoad(pair.read.texture, ivec2(coord.x.add(int(size)), coord.y))
        .mul(parity)
        .toVar();

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
      cascade.pair.read.dispose();
      cascade.pair.write.dispose();
      cascade.displacement.dispose();
      cascade.derivatives.dispose();
      cascade.evolve.dispose();
      cascade.assembleDisplacement.dispose();
      cascade.assembleDerivatives.dispose();
      for (const m of cascade.butterfly) m.dispose();
    }
    this.cascades.length = 0;
  }
}

function makeTarget(
  size: number,
  filter: THREE.MagnificationTextureFilter,
  wrap: THREE.Wrapping,
): THREE.RenderTarget {
  return new THREE.RenderTarget(size * 2, size, {
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
 * Measured, on the far-field band under the horizon at High (mean |laplacian|,
 * `tests/gallery-jitter.spec.ts`): anisotropy 16 -> 6.80, 4 -> 6.28, 2 -> 5.01,
 * 1 -> 3.52. Monotonic, and the wrong way round from the usual expectation.
 *
 * The reason is not that anisotropic filtering under-samples. It does not: the
 * reference algorithm takes N = min(ceil(Pmax/Pmin), maxAniso) samples at
 * LOD = log2(Pmax/N), so a tap budget too small for the footprint is compensated
 * by choosing a coarser level, and the footprint is covered either way.
 *
 * The reason is that this is a *slope* field feeding a nonlinear shading model,
 * and filtering does not commute with it. Anisotropic filtering delivers a
 * better estimate of the mean slope over the footprint — and the mean slope is
 * the wrong thing to shade. Specular response is a sharply nonlinear function of
 * slope, so the correct answer is the mean of the shaded facets, not the shading
 * of the mean facet, and a higher tap count buys accuracy in exactly the
 * quantity that is not wanted. What it costs is the four levels of extra
 * sharpness it takes in exchange, which is retained slope variance the shading
 * then turns into noise.
 *
 * Dropping to 1 makes the hardware choose the major-axis level, which carries
 * less of that variance. It is a real trade and not a free win — detail along
 * the well-resolved minor axis goes with it — and it is the right side of the
 * trade for water seen from near its own surface, where the footprint is a
 * fraction of a metre across and tens of metres long. The alpha channel below
 * addresses the same mismatch from the other end, by carrying the variance
 * forward instead of discarding it.
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

/**
 * A ping-pong of double-width targets. Pair A occupies `x < size`, pair B the
 * rest; both are `size` tall. Total memory is unchanged — two targets of
 * `2*size x size` against the four `size x size` this replaces.
 */
function makePingPong(size: number): PingPong {
  return {
    read: makeTarget(size, THREE.NearestFilter, THREE.ClampToEdgeWrapping),
    write: makeTarget(size, THREE.NearestFilter, THREE.ClampToEdgeWrapping),
  };
}

export type { Cascade };
