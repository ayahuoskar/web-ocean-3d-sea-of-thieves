import * as THREE from 'three/webgpu';
import { pass, positionWorld } from 'three/tsl';
import { createRenderer, clampPixelRatio, type Backend } from './core/Renderer';
import { Caustics, UnderwaterParticles, UnderwaterPass } from './underwater';
import { AssetLoader, Props, Seafloor, Ship } from './scene';
import {
  BuoyancySystem,
  BuoyantBody,
  ShipController,
  Wake,
  createRadialProbes,
  type ShipControlState,
} from './physics';
import { Loop } from './core/Loop';
import { AdaptiveQuality, QUALITY_TIERS, type QualityTier } from './core/QualityManager';
import { OceanSimulation } from './ocean/OceanSimulation';
import { OceanMesh } from './ocean/OceanMesh';
import { OceanMaterial } from './ocean/OceanMaterial';
import { Reflections } from './ocean/Reflections';
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
/** Scratch for the water's key-light direction, read every frame. */
const _keyDirection = new THREE.Vector3();

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
  /** Planar reflection. Null on the WebGL2 path, which keeps the analytic sky. */
  private reflections: Reflections | null = null;
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
  private shipControls: ShipController | null = null;

  /** Scratch for the exposed controller state; reading it must not allocate. */
  private readonly shipStateOut: ShipControlState = {
    throttle: 0,
    rudder: 0,
    speed: 0,
    forwardSpeed: 0,
    heading: 0,
  };

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
  /** Test-only rain rate override; null means the weather system decides. */
  private rainOverride: number | null = null;

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

    // The foam buffer must exist before the water material too, and for the same
    // reason as the seafloor: the surface samples it, and that binding is baked
    // into the node graph. It used to be created during the async asset load,
    // which is why nothing could ever sample it — by the time it existed the
    // shader had already been built without it. It owns no assets, so there is
    // nothing to wait for.
    this.buoyancy = new BuoyancySystem();
    this.wake = new Wake({
      derivativeTextures: this.simulation.derivativeTextures,
      tileSizes: this.simulation.tileSizes,
    });
    this.scene.add(this.wake.debugObject);

    // Planar reflection, on WebGPU only. Whether it exists is baked into the
    // surface's node graph, so it is decided here, once, from the backend — and
    // the WebGL2 path keeps the analytic sky reflection it always had, which is
    // a coherent simpler image rather than a broken richer one.
    if (this.backend === 'webgpu') {
      this.reflections = new Reflections(QUALITY_TIERS[this.state.quality].reflectionScale);
      this.scene.add(this.reflections.plane);
    }

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
      // Must be the depth *texture* node: the pass linearises it to find where
      // the scene stops, which is what bounds the shaft march and gives the
      // shafts their occlusion for free.
      scenePass.getTextureNode('depth'),
      // The shafts are an integral of this field along the view ray, so passing
      // it here is what makes them and the seafloor pattern the same light.
      (worldPosition) => this.caustics.intensityNode(worldPosition),
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
   * The returned buffer is RGBA8, **top-down** — row 0 is the top of the image,
   * ready to hand to a PNG encoder without flipping. That is the WebGPU
   * backend's readback order, and it is worth stating because the opposite is
   * the reasonable guess: render-target space is conventionally bottom-up, and
   * assuming so here produces an ocean above a sky.
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
    // Exactly one render, and that matters.
    //
    // This used to render twice and discard the first, to let the wave textures'
    // generated mip chains settle. That became actively wrong once the surface
    // started sampling the framebuffer for refraction: the second render's
    // backdrop can contain the first render's output, so the image feeds back
    // into itself and two consecutive captures of an unchanged world no longer
    // agree — which is precisely the property the whole visual harness rests on.
    //
    // Settling is the caller's job instead, and the harness already does it by
    // discarding warm-up captures before the one it keeps.
    await this.post.renderAsync();
    this.renderer.setRenderTarget(previous);

    const raw = (await this.renderer.readRenderTargetPixelsAsync(
      this.captureTarget,
      0,
      0,
      width,
      height,
    )) as ArrayBufferView;

    // Copied to an exactly-sized buffer, honouring the view's offset and length.
    //
    // Not `new Uint8Array(raw.buffer)`: the readback allocation is pooled and can
    // be larger than the image, so taking the whole backing store appends stale
    // bytes from a previous read. The pixels are identical either way, but the
    // trailing garbage is not, and it made two captures of an unchanged frame
    // compare unequal — a false regression in every byte-exact check.
    const view = new Uint8Array(raw.buffer, raw.byteOffset, width * height * 4);
    return { width, height, data: new Uint8Array(view) };
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
        // A hull, not a barrel: it resists heave and is shaped not to resist
        // surge. Its longitudinal and lateral resistance comes from
        // `ShipController`, which knows which way the bow is pointing and can
        // make the two differ by the order of magnitude a keel actually does.
        // Nearly none. What remains is the genuine coupling to the water's own
        // orbital motion — a hull does get shoved about by a passing swell — but
        // the resistance to being *driven* belongs to the controller. Even a
        // tenth of the probe damping was around 83 kN at cruising speed, which is
        // most of the engine.
        horizontalDamping: 0.03,
        horizontalDrag: 0,
      });
      this.buoyancy.add(this.shipBody);

      // The controller exists from load but stays inert until Boat mode selects
      // it, so W/S and A/D cannot steer a ship the viewer is not driving.
      this.shipControls = new ShipController(this.shipBody);
      this.shipControls.setEnabled(this.state.cameraMode === 'boat');

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
      case 'timeOfDay':
        // Through `applyPreset`, not straight to the atmosphere: moving the sun
        // changes the environment capture, the ambient fill and the water's sky
        // colours, and routing it through one place is what keeps those in step.
        this.applyPreset();
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
        // Selecting Boat selects the *ship*, not just a camera. Any other mode
        // releases it, so Orbit and Fly keep their own keys and a hull cannot be
        // left under power while the viewer is somewhere else.
        this.shipControls?.setEnabled(this.state.cameraMode === 'boat');
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
      foam: { texture: this.wake.texture, extent: this.wake.extent },
      reflectionNode: this.reflections?.node ?? null,
    });
  }

  private applyQuality(tier: QualityTier): void {
    const quality = QUALITY_TIERS[tier];
    this.simulation.resize(quality.fftSize, quality.cascades);
    this.sampler.rebuild();

    // The wave textures are recreated by `resize`, so the material's bindings are
    // stale — re-point them.
    //
    // Rebuilding the material instead, as this used to, was wrong in three ways.
    // Every input had to be re-supplied and one silently was not, which is how
    // `floorDepthNode` went missing after any tier change. The node graph
    // recompiled mid-session, which is exactly the in-gameplay shader compile the
    // performance work is meant to avoid. And once the surface began sampling the
    // framebuffer for refraction, each rebuild leaked the backdrop texture that
    // came with it — measured at forty textures over eight tier changes, which
    // the leak test caught.
    this.water.setCascades(
      this.simulation.displacementTextures,
      this.simulation.derivativeTextures,
      this.simulation.tileSizes,
    );
    // The foam buffer reads the same fields to find breaking crests.
    this.wake.setCascades(this.simulation.derivativeTextures, this.simulation.tileSizes);

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

    // WebGL2 gets the analytic path regardless of tier. The backdrop and depth
    // reads are the least portable part of the surface, and a fallback that
    // renders a coherent simpler image beats one that renders a broken richer
    // one — which is the whole point of having a declared fallback policy.
    this.water.setRefraction(this.backend === 'webgl' ? 0 : quality.refraction);
    this.water.setDepthRange(this.camera.far - this.camera.near);
    this.water.setReflection(quality.reflection);
    this.reflections?.setQuality(quality.reflectionScale);

    this.applyPreset();
  }

  /**
   * Sun elevation, azimuth and night blend for a clock time.
   *
   * A simple diurnal arc rather than a real ephemeris: no latitude, no season,
   * no equation of time. Those would change where the sun is by degrees, and
   * what this control exists for is to let someone drag from dawn to dusk and
   * watch the water follow — a model that answers that convincingly is worth
   * more here than one that is astronomically correct and looks the same.
   *
   * Elevation peaks at noon and goes negative at night; azimuth sweeps a full
   * turn so the light comes from the east in the morning and the west in the
   * evening. `nightIntensity` ramps once the sun is below the horizon, which is
   * what brings up the stars and the moon.
   */
  private sunFromClock(hours: number): {
    sunElevation: number;
    sunAzimuth: number;
    nightIntensity: number;
    moonElevation: number;
    moonAzimuth: number;
  } {
    // Noon at its highest, midnight at its lowest.
    const dayPhase = ((hours - 6) / 24) * Math.PI * 2;
    const elevation = Math.sin(dayPhase) * 1.32;
    // Civil twilight is roughly the first six degrees below the horizon; the
    // night blend follows it rather than snapping at zero, so dusk is a gradual
    // handover to the moon rather than a light switch.
    const night = THREE.MathUtils.clamp(-elevation / 0.22 + 0.15, 0, 1);
    const azimuth = ((hours - 6) / 24) * Math.PI * 2 + Math.PI;

    // The moon rides opposite the sun, so dragging into night finds it already
    // up. Without this the clock inherits whatever moon the preset declared —
    // and most declare none, so night was simply black, which is a poor answer
    // for a control whose whole purpose is to be dragged into it.
    return {
      sunElevation: elevation,
      sunAzimuth: azimuth,
      nightIntensity: night,
      moonElevation: -elevation * 0.82,
      moonAzimuth: azimuth + Math.PI,
    };
  }

  private applyPreset(): void {
    const preset = getPreset(this.state.preset);

    // The preset owns the sun until the viewer takes it, and then the clock
    // does. Spread over the preset rather than replacing it, so a preset's
    // turbidity, Mie and overcast — the things that make it *that place* —
    // survive being re-timed.
    const clock = this.state.timeOfDay;
    this.atmosphere.setParams(
      clock === null ? preset.atmosphere : { ...preset.atmosphere, ...this.sunFromClock(clock) },
    );
    this.clouds.setParams({
      ...preset.clouds,
      coverage: this.state.cloudCoverage,
      steps: QUALITY_TIERS[this.state.quality].cloudSteps,
      // Driven by the same wind that raises the sea, so a storm's clouds scud
      // and its swell runs the same way. Evolution scales with it too: a squall
      // boils, a calm day drifts.
      windDirection: preset.sea.windDirection,
      windSpeed: 6 + this.state.windSpeed * 1.6,
      evolutionRate: 0.006 + this.state.windSpeed * 0.0022,
    });
    this.weather.setKind(preset.weather.kind);
    this.weather.setIntensity(preset.weather.intensity);

    // Rain leans with the wind that is driving the sea. Reading the shear off
    // the same wind speed and direction the spectrum uses is what stops a storm
    // from having waves running one way and rain slanting another — the two
    // being visibly independent is a strong tell that the weather is a costume.
    const windAngle = preset.sea.windDirection;
    const lean = Math.min(0.55, this.state.windSpeed * 0.022);
    this.weather.setShear(Math.cos(windAngle) * lean, Math.sin(windAngle) * lean);

    this.simulation.updateSpectrum({
      ...preset.sea,
      windSpeed: this.state.windSpeed,
      peakWavelength: this.state.peakWavelength,
    });

    this.water.setAppearance(preset.water);
    // Sky and horizon come from the atmosphere, not from preset constants.
    //
    // The first argument used to be the *sun* colour, which is not the sky by
    // any reading, and the other two were a single authored fog colour. So the
    // water's reflection and its aerial perspective were describing a different
    // sky from the one being drawn behind it, and where they disagreed the
    // horizon showed a hard step. Both now derive from the state that lights the
    // scene, so a preset cannot pull them apart. `fog.color` survives as the
    // aerial-perspective tint, which is genuinely an authored choice.
    this.water.setSky(
      this.atmosphere.zenithColor,
      this.atmosphere.horizonColor,
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

    // The key light, whichever body is providing it, at its actual strength.
    //
    // This used to be the sun direction, the sun colour and a hardcoded
    // intensity of 6 — so the water was lit as though by a noon sun at every
    // hour, and its subsurface scattering glowed green under the hull at half
    // past nine at night. It also went on taking its direction from a sun that
    // was below the horizon while the moon was the only thing actually casting.
    const key = this.atmosphere.sunLight;
    _keyDirection.copy(key.position).normalize();
    // 3.4 is the sun's full-daylight intensity in `Atmosphere`, so this is
    // "how close to full daylight is it" rather than an arbitrary scale.
    this.water.setSun(_keyDirection, key.color, key.intensity * 1.8, key.intensity / 3.4);
    // The sun moves and the sky follows it, so these have to be refreshed every
    // frame rather than only when a preset is applied.
    this.water.setSky(
      this.atmosphere.zenithColor,
      this.atmosphere.horizonColor,
      getPreset(this.state.preset).fog.color,
      getPreset(this.state.preset).fog.density,
    );

    // Rain reaches the water. Only rain does — snow settles far too slowly to
    // punch a ring into a surface, and driving this from `weather.intensity`
    // alone would have the Arctic preset stippling the sea with snowflakes.
    const raining =
      this.rainOverride ??
      (this.weather.getKind() === 'rain' ? this.weather.getIntensity() : 0);
    this.water.setRain(raining, elapsed);
    // Agitation: heavy rain whitens a sea surface on its own, independently of
    // whether the waves are steep enough to break.
    this.wake.setRainAgitation(raining);

    this.simulation.update(elapsed);
    // Deterministic stepping owns the readback and awaits it; kicking off a
    // second, unawaited one here would put the race straight back.
    if (!this.deterministic) this.sampler.update();

    this.oceanMesh.recenter(this.camera.position);
    this.water.setWorldOffset(this.oceanMesh.mesh.position.x, this.oceanMesh.mesh.position.z);
    this.water.setFoamCenter(this.wake.centerX, this.wake.centerZ);

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
    // Re-bake around the viewer. Must run outside an active render target, so it
    // sits here in the update rather than inside the post chain.
    this.caustics.bake(this.renderer, this.camera.position.x, this.camera.position.z);

    this.updateSceneContent(dt);

    this.hud.setFps(this.loop.stats.fps);

    // Adaptive quality answers sustained *real-time* frame pressure, so it has
    // no business running while the clock is detached. `Loop.step` deliberately
    // does not write `stats.fps` — there is no wall-clock rate to report when
    // frames are being issued on demand — so the value here would be whatever
    // the live loop last saw. A capture taken after a heavy moment would then
    // inherit that reading and downgrade the tier partway through, quietly
    // changing the thing being measured.
    if (!this.loop.isPaused) {
      this.adaptive.update(dt, this.loop.stats.fps, this.state.quality, elapsed);
    }
  };

  /** Physics, wake and chase camera. No-ops cleanly until the models land. */
  private updateSceneContent(dt: number): void {
    // Safe before the sampler's first readback resolves: it reports height 0 and
    // bodies simply settle to flat water rather than producing NaN.
    this.buoyancy.update(dt, this.sampler);

    const ship = this.ship;
    if (ship) {
      // Before the solver: the controller resolves intent into the force the
      // solver then integrates. Running it afterwards would apply this frame's
      // thrust to next frame's pose.
      this.shipControls?.update(dt);
      ship.update(dt);

      const position = ship.object.position;
      // Speed along the bow, from the body, rather than frame-to-frame distance.
      // Distance travelled cannot tell ahead from astern and counts the hull's
      // heave on a swell as forward motion, so a ship sitting still in a seaway
      // laid down a wake.
      const state = this.shipControls?.getState(this.shipStateOut) ?? null;
      const speed = state ? Math.abs(state.forwardSpeed) : 0;
      this.previousShipPosition.copy(position);

      this.wake.emit(position.x, position.z, ship.heading, speed, ship.hullBeam);

      this.chaseTarget.position.copy(position);
      this.chaseTarget.heading = ship.heading;
      this.director.setChaseTarget(this.chaseTarget);
    }

    // Centred on the viewer, not on the hull.
    //
    // It was the hull's while it only held the wake. Now that breaking crests
    // deposit into the same buffer it has to cover what is being *looked at*,
    // or the whitecaps stop at an invisible circle a few hundred metres from a
    // ship that may not even be on screen. The wake still deposits at the hull's
    // world position and simply falls out of the footprint when the camera
    // leaves it behind, which is the correct trade: foam you can see beats foam
    // you cannot.
    this.wake.setCenter(this.camera.position.x, this.camera.position.z);

    // Outside the `ship` branch: the foam has to keep decaying whether or not
    // anything is depositing into it, or a wake left by a ship that has since
    // been disposed would hang on the water forever.
    //
    // Must run outside an active render target; it saves and restores its own.
    this.wake.update(dt, this.renderer);
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
        wake: this.wake,
        water: this.water,
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
          this.shipControls?.setInput(0, 0);
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
        /** Live ship controller state — throttle, rudder, speed, heading. */
        shipState: () =>
          this.shipControls ? { ...this.shipControls.getState(this.shipStateOut) } : null,
        shipControlsEnabled: () => this.shipControls?.isEnabled ?? false,
        /** Direct throttle/rudder input, bypassing the keyboard. */
        setShipInput: (throttle: number, rudder: number) =>
          this.shipControls?.setInput(throttle, rudder),
        /**
         * Forces the rain rate the surface sees, independently of the preset's
         * weather. Lets a test vary one input while holding the sea state,
         * lighting and camera fixed, which comparing two presets could not.
         * `null` returns control to the weather system.
         */
        setRainOverride: (intensity: number | null) => {
          this.rainOverride = intensity;
        },
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
    this.shipControls?.dispose();
    this.buoyancy?.dispose();
    this.wake?.dispose();
    this.ship?.dispose();
    this.props?.dispose();
    this.seafloor?.dispose();
    this.reflections?.dispose();
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
