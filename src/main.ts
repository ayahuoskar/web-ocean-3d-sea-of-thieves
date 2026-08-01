import * as THREE from 'three/webgpu';
import { pass, positionWorld } from 'three/tsl';
import { createRenderer, clampPixelRatio, type Backend } from './core/Renderer';
import { Caustics, UnderwaterParticles, UnderwaterPass } from './underwater';
import { AssetLoader, Props, Seafloor, Ship } from './scene';
import { BuoyancySystem, BuoyantBody, Wake, createRadialProbes } from './physics';
import { Loop } from './core/Loop';
import { AdaptiveQuality, QUALITY_TIERS, type QualityTier } from './core/QualityManager';
import { OceanSimulation } from './ocean/OceanSimulation';
import { OceanMesh } from './ocean/OceanMesh';
import { OceanMaterial } from './ocean/OceanMaterial';
import { OceanSampler } from './ocean/Sampler';
import { DEFAULT_SPECTRUM } from './ocean/Spectrum';
import { Atmosphere, Clouds, Weather } from './sky';
import { CameraDirector } from './cameras/CameraDirector';
import { getPreset } from './presets';
import { Panel } from './ui/Panel';
import { Hud } from './ui/Hud';
import { DEFAULT_UI_STATE, type UiState } from './ui/types';

/** Scratch for the test-hook camera pin; the hook must not allocate either. */
const _pinPosition = new THREE.Vector3();
const _pinTarget = new THREE.Vector3();

const boot = {
  root: document.getElementById('boot'),
  bar: document.getElementById('boot-bar'),
  status: document.getElementById('boot-status'),
  set(progress: number, message: string) {
    if (this.bar) (this.bar as HTMLElement).style.width = `${Math.round(progress * 100)}%`;
    if (this.status) this.status.textContent = message;
  },
  hide() {
    this.root?.classList.add('boot--hidden');
  },
  fail(message: string) {
    if (this.status) {
      this.status.textContent = message;
      this.status.classList.add('boot__status--error');
    }
  },
};

class App {
  private readonly canvas: HTMLCanvasElement;
  private readonly uiRoot: HTMLElement;

  private renderer!: THREE.WebGPURenderer;
  private backend!: Backend;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private director!: CameraDirector;

  private simulation!: OceanSimulation;
  private water!: OceanMaterial;
  private oceanMesh!: OceanMesh;
  private sampler!: OceanSampler;

  private atmosphere!: Atmosphere;
  private clouds!: Clouds;
  private weather!: Weather;

  private post!: THREE.RenderPipeline;
  private underwater!: UnderwaterPass;
  private particles!: UnderwaterParticles;
  private caustics!: Caustics;

  private assets!: AssetLoader;
  private seafloor!: Seafloor;
  private ship: Ship | null = null;
  private props: Props | null = null;
  private buoyancy!: BuoyancySystem;
  private wake!: Wake;
  private shipBody: BuoyantBody | null = null;

  /** Scratch — the frame path must not allocate. */
  private readonly previousShipPosition = new THREE.Vector3();
  private readonly chaseTarget = { position: new THREE.Vector3(), heading: 0 };

  private panel!: Panel;
  private hud!: Hud;
  private loop!: Loop;
  private adaptive!: AdaptiveQuality;

  private state: UiState = { ...DEFAULT_UI_STATE };
  private disposed = false;
  /** True once the async scene-content load has settled, whatever the outcome. */
  private sceneContentLoaded = false;
  /** True once `compileAsync` has built the initial pipeline set. */
  private shadersReady = false;
  /** Lazily created offscreen target for `capturePixels`. */
  private captureTarget: THREE.RenderTarget | null = null;
  /** True while `stepDeterministic` owns the wave-field readback. */
  private deterministic = false;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.canvas = canvas;
    this.uiRoot = uiRoot;
  }

  async start(): Promise<void> {
    boot.set(0.05, 'Initialising renderer…');
    const bootstrap = await createRenderer({
      canvas: this.canvas,
      forceWebGL: this.state.forceWebGL,
      pixelRatio: window.devicePixelRatio * this.state.pixelRatio,
    });
    this.renderer = bootstrap.renderer;
    this.backend = bootstrap.backend;
    console.info(`[ocean] renderer backend: ${this.backend}`);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      55,
      window.innerWidth / window.innerHeight,
      0.1,
      40000,
    );
    this.camera.position.set(0, 14, 46);

    const quality = QUALITY_TIERS[this.state.quality];

    boot.set(0.25, 'Building wave spectrum…');
    this.simulation = new OceanSimulation(this.renderer, {
      size: quality.fftSize,
      cascadeCount: quality.cascades,
      params: DEFAULT_SPECTRUM,
    });
    this.sampler = new OceanSampler(this.renderer, this.simulation);

    boot.set(0.4, 'Building seafloor…');
    // The seafloor must exist before the water material: the surface samples its
    // depth to shade shallows, and that binding is baked into the node graph.
    this.seafloor = new Seafloor(4000);
    this.scene.add(this.seafloor.mesh);

    boot.set(0.5, 'Compiling water shaders…');
    this.water = this.buildWaterMaterial();
    this.oceanMesh = new OceanMesh(this.water.material, {
      radialSegments: quality.meshRings,
      angularSegments: quality.meshSegments,
    });
    this.scene.add(this.oceanMesh.mesh);

    boot.set(0.7, 'Building atmosphere…');
    this.atmosphere = new Atmosphere(this.renderer);
    this.scene.add(this.atmosphere.mesh, this.atmosphere.sunLight, this.atmosphere.ambientLight);

    this.clouds = new Clouds();
    this.scene.add(this.clouds.mesh);

    this.weather = new Weather();
    this.scene.add(this.weather.object);

    boot.set(0.8, 'Building underwater pass…');
    this.underwater = new UnderwaterPass();
    // Required, not optional: a post pass is drawn with the post-processor's own
    // orthographic quad camera, so the built-in camera nodes resolve to that quad
    // rather than the scene camera. Without this the depth buffer cannot be
    // linearised and the sun cannot be projected to screen space.
    this.underwater.setCamera(this.camera);

    this.particles = new UnderwaterParticles(quality.underwaterParticles);
    this.scene.add(this.particles.object);

    this.caustics = new Caustics();
    // Rebuilds the sand shader once, so it happens here at setup and never in a
    // frame path.
    this.seafloor.setCaustics(this.caustics.intensityNode(positionWorld));

    // `RenderPipeline`, not the `PostProcessing` alias: the latter is deprecated
    // as of r183 and warns on every boot.
    this.post = new THREE.RenderPipeline(this.renderer);
    const scenePass = pass(this.scene, this.camera);
    this.post.outputNode = this.underwater.build(
      scenePass.getTextureNode(),
      // Must be the depth *texture* node: the pass re-samples it at offset
      // coordinates to mask the shafts, which a view-z node cannot support.
      scenePass.getTextureNode('depth'),
    ) as THREE.Node;

    boot.set(0.85, 'Wiring controls…');
    this.director = new CameraDirector({
      camera: this.camera,
      domElement: this.canvas,
      surfaceHeight: (x, z) => this.sampler.height(x, z),
    });

    this.buildUi();
    this.applyPreset();

    this.adaptive = new AdaptiveQuality(55, (tier) => {
      console.info(`[ocean] adaptive quality: dropping to "${tier}"`);
      this.state.quality = tier;
      this.panel.setState({ quality: tier });
      this.applyQuality(tier);
    });

    window.addEventListener('resize', this.onResize);

    // `renderAsync`, not `render`. The synchronous form queues GPU work and
    // returns immediately, so `Loop`'s `await` completed before the frame did:
    // `frameMs` was timing the submit rather than the work, and the `inFlight`
    // guard that is supposed to stop unbounded queueing never actually held
    // anything back. It also left the deterministic capture path racing a render
    // that was still in flight, which is what made repeated captures of an
    // identical world disagree.
    this.loop = new Loop(() => this.post.renderAsync());
    this.loop.add(this.update);

    // Prewarm behind the boot overlay. Every pipeline the first frame will need
    // is compiled here rather than on first draw — otherwise the frame that
    // first shows the water pays for compiling it, which is exactly the spike
    // this project previously measured at ~57 ms when scene content arrived.
    boot.set(0.95, 'Compiling pipelines…');
    await this.prewarm();

    boot.set(1, 'Ready');
    this.loop.start();
    window.setTimeout(() => boot.hide(), 350);

    this.exposeTestHooks();

    // Models load after the first frames are on screen. The ocean is the
    // headline; making the viewer wait on 26 MB of ship textures before seeing
    // anything would be the wrong trade.
    void this.loadSceneContent();
  }

  /**
   * Advances the world by `steps` increments of `dt`, awaiting a fresh wave-field
   * readback before each one.
   *
   * The interactive path fires the sampler readback and does not wait for it, so
   * buoyancy runs on data that is a frame or two old and *how* old depends on the
   * machine. That is invisible in motion and fatal to reproducibility: the hull
   * ends up somewhere slightly different every run, and so does its wake. Here we
   * pay the stall, once per step, and get the same hull position every time.
   */
  private async stepDeterministic(dt: number, steps = 1): Promise<void> {
    this.deterministic = true;
    try {
      for (let i = 0; i < steps; i++) {
        await this.sampler.readNow();
        await this.loop.step(dt, 1);
      }
    } finally {
      this.deterministic = false;
    }
  }

  /**
   * Renders the full post-processed frame into an offscreen target and reads the
   * pixels straight back.
   *
   * This is the capture path the visual harness uses, in preference to a
   * compositor screenshot. A screenshot goes through the browser's own
   * presentation path — it can arrive a frame late, it is subject to whatever
   * the compositor decides about colour management, and under automation it may
   * not arrive at all. Reading the render target is the same pixels the shader
   * wrote, on demand, with no frame-pacing dependency.
   *
   * The returned buffer is RGBA8, bottom-up (render-target origin), which the
   * harness flips when it encodes.
   */
  async capturePixels(): Promise<{ width: number; height: number; data: Uint8Array }> {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const width = Math.max(1, Math.floor(size.x));
    const height = Math.max(1, Math.floor(size.y));

    if (
      this.captureTarget === null ||
      this.captureTarget.width !== width ||
      this.captureTarget.height !== height
    ) {
      this.captureTarget?.dispose();
      this.captureTarget = new THREE.RenderTarget(width, height, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.SRGBColorSpace,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
    }

    const previous = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.captureTarget);
    // Rendered twice, and the first result discarded.
    //
    // The wave displacement and derivative targets carry generated mip chains,
    // and the surface samples them trilinearly with anisotropy — so the mid- and
    // far-field shading reads from mips built by the same frame that draws them.
    // The first render after a simulation step can therefore sample a chain that
    // is still being built, which showed up as a several-percent brightness
    // swing across everything past the near field while the foreground stayed
    // bit-identical. The second render always sees a settled chain.
    await this.post.renderAsync();
    await this.post.renderAsync();
    this.renderer.setRenderTarget(previous);

    const raw = await this.renderer.readRenderTargetPixelsAsync(
      this.captureTarget,
      0,
      0,
      width,
      height,
    );
    return { width, height, data: new Uint8Array(raw.buffer ?? raw) };
  }

  /**
   * Compiles every material in the scene against the current camera before the
   * loop starts.
   *
   * `compileAsync` walks the visible graph and builds the render pipelines
   * without drawing, so the cost lands behind the loading overlay where the user
   * is already waiting. It is best-effort: a backend that cannot honour it must
   * not stop the app from starting.
   */
  private async prewarm(): Promise<void> {
    try {
      await this.renderer.compileAsync(this.scene, this.camera);
      this.shadersReady = true;
    } catch (error) {
      console.warn('[ocean] pipeline prewarm skipped', error);
    }
  }

  private async loadSceneContent(): Promise<void> {
    this.assets = new AssetLoader();
    this.buoyancy = new BuoyancySystem();
    this.wake = new Wake();
    this.scene.add(this.wake.debugObject);

    // Settled, not `Promise.all`. The ship and the scene dressing are separate
    // features and must fail separately: one unreachable prop asset previously
    // rejected the whole batch, taking the ship, buoyancy and the wake with it
    // and leaving an empty ocean with nothing but a console error to show for it.
    const [shipResult, propsResult] = await Promise.allSettled([
      Ship.load(this.assets),
      Props.load(this.assets),
    ]);
    if (this.disposed) return;

    if (shipResult.status === 'fulfilled') {
      const ship = shipResult.value;
      this.ship = ship;
      this.scene.add(ship.object);

      this.shipBody = new BuoyantBody({
        object: ship.object,
        probePoints: ship.probePoints,
        mass: 90_000,
      });
      this.buoyancy.add(this.shipBody);

      ship.setDebugProbesVisible(this.state.buoyancyProbes);
      this.wake.setDebugVisible(this.state.wakeProbes);
      this.previousShipPosition.copy(ship.object.position);
    } else {
      console.error('[ocean] ship failed to load', shipResult.reason);
    }

    if (propsResult.status === 'fulfilled') {
      const props = propsResult.value;
      this.props = props;
      this.scene.add(props.object);

      for (const floater of props.floaters) {
        this.buoyancy.add(
          new BuoyantBody({
            object: floater.object,
            probePoints: createRadialProbes(floater.radius),
            // Rough displacement for a hollow float of this size.
            mass: 40 * floater.radius * floater.radius * floater.radius,
          }),
        );
      }
    } else {
      console.error('[ocean] scene props failed to load', propsResult.reason);
    }

    this.sceneContentLoaded = true;
  }

  private buildUi(): void {
    const callbacks = {
      onChange: <K extends keyof UiState>(key: K, value: UiState[K]) => {
        this.state[key] = value;
        this.onStateChange(key);
      },
    };
    this.panel = new Panel(this.uiRoot, this.state, callbacks);
    this.hud = new Hud(this.uiRoot, this.state.cameraMode, callbacks);
    this.hud.setBackend(this.backend);
  }

  private onStateChange(key: keyof UiState): void {
    switch (key) {
      case 'quality':
        this.applyQuality(this.state.quality);
        break;
      case 'preset':
        this.applyPreset();
        break;
      case 'windSpeed':
      case 'peakWavelength':
        this.simulation.updateSpectrum({
          windSpeed: this.state.windSpeed,
          peakWavelength: this.state.peakWavelength,
        });
        break;
      case 'cloudCoverage':
        this.clouds.setParams({ coverage: this.state.cloudCoverage });
        break;
      case 'pixelRatio':
        this.renderer.setPixelRatio(
          clampPixelRatio(window.devicePixelRatio * this.state.pixelRatio),
        );
        this.onResize();
        break;
      case 'cameraMode':
        this.director.setMode(this.state.cameraMode);
        this.hud.setCameraMode(this.state.cameraMode);
        break;
      case 'buoyancyProbes':
        this.ship?.setDebugProbesVisible(this.state.buoyancyProbes);
        break;
      case 'wakeProbes':
        this.wake?.setDebugVisible(this.state.wakeProbes);
        break;
      case 'forceWebGL':
        // Switching backend means tearing down every GPU resource and rebuilding
        // against a new device; a reload is both simpler and more reliable than
        // trying to migrate a live scene graph between backends.
        this.restartWithBackend(this.state.forceWebGL);
        break;
      default:
        break;
    }
  }

  /**
   * The one place the water surface is constructed.
   *
   * Both the initial build and every tier rebuild go through here, so a new
   * input can never be wired into one path and forgotten in the other.
   */
  private buildWaterMaterial(): OceanMaterial {
    return new OceanMaterial({
      displacementTextures: this.simulation.displacementTextures,
      derivativeTextures: this.simulation.derivativeTextures,
      tileSizes: this.simulation.tileSizes,
      floorDepthNode: (worldPosition) => this.seafloor.depthNode(worldPosition),
    });
  }

  private applyQuality(tier: QualityTier): void {
    const quality = QUALITY_TIERS[tier];
    this.simulation.resize(quality.fftSize, quality.cascades);
    this.sampler.rebuild();

    // The wave textures are recreated by `resize`, so the material's bindings are
    // stale — rebuild the surface against the new ones.
    //
    // Every input the first build received must be passed again. `floorDepthNode`
    // in particular: without it the surface silently falls back to a view-angle
    // approximation of the water column, losing the shallow turquoise and the
    // shelf-break edge for the rest of the session. That regression is invisible
    // to typecheck, so `buildWaterMaterial` is the single place both paths call.
    const previous = this.water;
    this.water = this.buildWaterMaterial();
    this.oceanMesh.mesh.material = this.water.material;
    previous.dispose();

    this.scene.remove(this.oceanMesh.mesh);
    this.oceanMesh.dispose();
    this.oceanMesh = new OceanMesh(this.water.material, {
      radialSegments: quality.meshRings,
      angularSegments: quality.meshSegments,
    });
    this.scene.add(this.oceanMesh.mesh);

    this.clouds.setParams({ steps: quality.cloudSteps });

    // Shadows: the renderer flag alone only stops the pass from running. The
    // light owns the map, so the tier's resolution has to reach it too.
    this.renderer.shadowMap.enabled = quality.shadowMapSize > 0;
    this.atmosphere.setShadowMapSize(quality.shadowMapSize);

    // Particle budget is a live setting, not a construction-time one; `setCount`
    // rebuilds the instanced geometry against the new tier.
    this.particles.setCount(quality.underwaterParticles);

    this.applyPreset();
  }

  private applyPreset(): void {
    const preset = getPreset(this.state.preset);

    this.atmosphere.setParams(preset.atmosphere);
    this.clouds.setParams({
      ...preset.clouds,
      coverage: this.state.cloudCoverage,
      steps: QUALITY_TIERS[this.state.quality].cloudSteps,
    });
    this.weather.setKind(preset.weather.kind);
    this.weather.setIntensity(preset.weather.intensity);

    this.simulation.updateSpectrum({
      ...preset.sea,
      windSpeed: this.state.windSpeed,
      peakWavelength: this.state.peakWavelength,
    });

    this.water.setAppearance(preset.water);
    this.water.setSky(
      this.atmosphere.sunColor,
      preset.fog.color,
      preset.fog.color,
      preset.fog.density,
    );

    this.renderer.toneMappingExposure = preset.toneMappingExposure;
    this.atmosphere.updateEnvironment(this.renderer, this.scene);
  }

  private update = (dt: number, elapsed: number): void => {
    this.director.update(dt);

    this.atmosphere.update(dt);
    this.clouds.setSunDirection(this.atmosphere.sunDirection);
    this.clouds.update(dt);
    this.weather.update(dt, this.camera.position);

    this.water.setSun(this.atmosphere.sunDirection, this.atmosphere.sunColor, 6);

    this.simulation.update(elapsed);
    // Deterministic stepping owns the readback and awaits it; kicking off a
    // second, unawaited one here would put the race straight back.
    if (!this.deterministic) this.sampler.update();

    this.oceanMesh.recenter(this.camera.position);
    this.water.setWorldOffset(this.oceanMesh.mesh.position.x, this.oceanMesh.mesh.position.z);

    // --- underwater state -----------------------------------------------------
    // `submersion` is a soft band around the surface rather than a boolean, so
    // crossing the waterline cross-fades instead of popping.
    const submersion = this.director.submersion();
    const surface = this.sampler.height(this.camera.position.x, this.camera.position.z);
    const preset = getPreset(this.state.preset);

    this.underwater.setParams({
      submersion,
      cameraDepth: Math.max(0, surface - this.camera.position.y),
      sunDirection: this.atmosphere.sunDirection,
      sunColor: this.atmosphere.sunColor,
      waterColor: preset.underwater.color,
      extinction: preset.underwater.extinction,
      visibility: preset.underwater.visibility,
      godRayStrength: preset.underwater.godRayStrength,
      godRaySteps: QUALITY_TIERS[this.state.quality].godRaySteps,
    });
    this.underwater.update(dt);

    // Particles only cost anything while they can actually be seen.
    this.particles.setVisible(submersion > 0.01);
    if (submersion > 0.01) this.particles.update(dt, this.camera.position);

    this.caustics.setSunDirection(this.atmosphere.sunDirection);
    this.caustics.update(dt);

    this.updateSceneContent(dt);

    this.hud.setFps(this.loop.stats.fps);
    this.adaptive.update(dt, this.loop.stats.fps, this.state.quality, elapsed);
  };

  /** Physics, wake and chase camera. No-ops cleanly until the models land. */
  private updateSceneContent(dt: number): void {
    if (!this.buoyancy) return;

    // Safe before the sampler's first readback resolves: it reports height 0 and
    // bodies simply settle to flat water rather than producing NaN.
    this.buoyancy.update(dt, this.sampler);

    const ship = this.ship;
    if (!ship) return;

    ship.update(dt);

    const position = ship.object.position;
    const speed = this.previousShipPosition.distanceTo(position) / Math.max(dt, 1e-4);
    this.previousShipPosition.copy(position);

    this.wake.setCenter(position.x, position.z);
    this.wake.emit(position.x, position.z, ship.heading, speed, ship.hullBeam);
    // Must run outside an active render target; it saves and restores its own.
    this.wake.update(dt, this.renderer);

    this.chaseTarget.position.copy(position);
    this.chaseTarget.heading = ship.heading;
    this.director.setChaseTarget(this.chaseTarget);
  }

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  };

  private restartWithBackend(forceWebGL: boolean): void {
    const url = new URL(window.location.href);
    if (forceWebGL) url.searchParams.set('webgl', '1');
    else url.searchParams.delete('webgl');
    window.location.replace(url.toString());
  }

  /** Deterministic control surface for the Playwright verification loop. */
  private exposeTestHooks(): void {
    Object.assign(window, {
      __ocean: {
        renderer: this.renderer,
        scene: this.scene,
        camera: this.camera,
        director: this.director,
        simulation: this.simulation,
        sampler: this.sampler,
        atmosphere: this.atmosphere,
        loop: this.loop,
        backend: this.backend,
        /**
         * Readiness signals. `sceneContentLoaded` settles whether or not the
         * models arrived, so a harness can distinguish "still loading" from
         * "loaded, and the ship legitimately is not there".
         */
        isReady: () =>
          this.sceneContentLoaded && this.sampler.ready && this.loop.stats.frameMs > 0,
        sceneContentLoaded: () => this.sceneContentLoaded,
        hasShip: () => this.ship !== null,
        getState: () => ({ ...this.state }),
        setState: (partial: Partial<UiState>) => {
          for (const [key, value] of Object.entries(partial)) {
            (this.state as unknown as Record<string, unknown>)[key] = value;
            this.onStateChange(key as keyof UiState);
          }
          this.panel.setState(partial);
        },
        /**
         * Places the camera exactly, for reproducible screenshots.
         *
         * Works in every mode, not just Orbit — see `CameraDirector.pin`.
         */
        setCamera: (px: number, py: number, pz: number, tx: number, ty: number, tz: number) => {
          _pinPosition.set(px, py, pz);
          _pinTarget.set(tx, ty, tz);
          this.director.pin(_pinPosition, _pinTarget);
        },

        // --- deterministic stepping ------------------------------------------
        /** Detaches the simulation from wall clock. `step` then owns the clock. */
        setPaused: (paused: boolean) => this.loop.setPaused(paused),
        isPaused: () => this.loop.isPaused,
        elapsedTime: () => this.loop.elapsedTime,
        /** Advances by exactly `steps` increments of `dt` and renders once. */
        step: (dt: number, steps = 1) => this.stepDeterministic(dt, steps),

        /**
         * Returns the world to a known state at simulation time `time`.
         *
         * Everything with a clock is rewound and every accumulation buffer is
         * cleared, so two calls with the same arguments produce the same frame
         * regardless of what the session did in between.
         */
        resetDeterministic: async (time = 0, settleSteps = 90) => {
          const settleDt = 1 / 60;
          this.loop.setPaused(true);

          // Rewind far enough that the settle run *ends* exactly at `time`.
          // Setting the clock to `time` and then stepping forward would leave the
          // world at `time + settleSteps * dt`, and the caller's chosen time is
          // the one thing that has to be exact.
          const start = time - settleSteps * settleDt;
          this.loop.setElapsed(start);

          this.weather.resetClock(start);
          this.particles.resetClock(start);
          this.underwater.resetClock(start);
          this.caustics.resetClock(start);
          this.atmosphere.resetClock(start);
          this.clouds.resetWind();
          this.wake?.reset(this.renderer);

          // Floating bodies carry position and momentum across a whole session;
          // returning them to their spawn poses is what stops a capture from
          // inheriting wherever the hull happened to have drifted.
          this.buoyancy?.resetToHome();
          this.ship?.resetClock(start);
          this.previousShipPosition.copy(this.ship?.object.position ?? this.previousShipPosition);

          // The sampler holds a readback of the *previous* wave field; drop it so
          // buoyancy re-derives from the field at `time`.
          this.sampler.rebuild();

          // Settle: the FFT is stateless in time (h(k, t) is evaluated directly),
          // but buoyancy, wake and foam all integrate, so they need real steps to
          // reach the state that simulation time implies. Stepping goes through
          // the synchronous sampler path — see `stepDeterministic`.
          await this.stepDeterministic(settleDt, settleSteps);
        },

        shadersReady: () => this.shadersReady,
        /** Exact-pixel frame capture; see `App.capturePixels`. */
        capturePixels: () => this.capturePixels(),
        dispose: () => this.dispose(),
      },
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('resize', this.onResize);
    this.loop?.stop();
    this.panel?.dispose();
    this.hud?.dispose();
    this.director?.dispose();
    this.sampler?.dispose();
    this.simulation?.dispose();
    this.oceanMesh?.dispose();
    this.water?.dispose();
    this.atmosphere?.dispose();
    this.clouds?.dispose();
    this.weather?.dispose();
    this.underwater?.dispose();
    this.particles?.dispose();
    this.caustics?.dispose();
    this.buoyancy?.dispose();
    this.wake?.dispose();
    this.ship?.dispose();
    this.props?.dispose();
    this.seafloor?.dispose();
    this.assets?.dispose();
    this.captureTarget?.dispose();
    this.renderer?.dispose();
  }
}

const canvas = document.getElementById('viewport') as HTMLCanvasElement | null;
const uiRoot = document.getElementById('ui-root');

if (!canvas || !uiRoot) {
  boot.fail('Failed to start: page markup is missing #viewport or #ui-root.');
} else {
  const app = new App(canvas, uiRoot);
  // Honour a ?webgl=1 restart requested by the Force WebGL toggle.
  if (new URL(window.location.href).searchParams.get('webgl') === '1') {
    (app as unknown as { state: UiState }).state.forceWebGL = true;
  }
  app.start().catch((error: unknown) => {
    console.error(error);
    boot.fail(
      error instanceof Error ? `Failed to start: ${error.message}` : 'Failed to start.',
    );
  });
}
