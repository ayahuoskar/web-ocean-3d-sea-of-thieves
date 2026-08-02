import * as THREE from 'three/webgpu';
import { pass, positionWorld, rtt } from 'three/tsl';
import { createRenderer, clampPixelRatio, type Backend } from './core/Renderer';
import { Caustics, UnderwaterParticles, UnderwaterPass } from './underwater';
import { AssetLoader, Props, Seafloor, Ship, SurfaceWetness } from './scene';
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
import { DEFAULT_APPEARANCE, OceanMaterial } from './ocean/OceanMaterial';
import { Reflections } from './ocean/Reflections';
import { DEFAULT_SSR_STEPS, ScreenSpaceReflection } from './ocean/ScreenSpaceReflection';
import { OceanSampler } from './ocean/Sampler';
import { DEFAULT_SPECTRUM } from './ocean/Spectrum';
import { Atmosphere, Clouds, Weather } from './sky';
import { VolumetricFog } from './post/VolumetricFog';
import { LensRain } from './post/LensRain';
import { CameraDirector } from './cameras/CameraDirector';
import { getPreset } from './presets';
import { Panel } from './ui/Panel';
import { Hud } from './ui/Hud';
import { TouchControls } from './ui/TouchControls';
import { DEFAULT_UI_STATE, type UiState } from './ui/types';

/** Scratch for the test-hook camera pin; the hook must not allocate either. */
const _pinPosition = new THREE.Vector3();
const _pinTarget = new THREE.Vector3();
/** Scratch for the water's key-light direction, read every frame. */
const _keyDirection = new THREE.Vector3();
/** Scratch for the camera forward axis, read every frame. */
const _keyDirection2 = new THREE.Vector3();

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
  /** Screen-space reflection, layered over the planar one. WebGPU only. */
  private ssr: ScreenSpaceReflection | null = null;
  private oceanMesh!: OceanMesh;
  private sampler!: OceanSampler;

  private atmosphere!: Atmosphere;
  private clouds!: Clouds;
  private weather!: Weather;

  private post!: THREE.RenderPipeline;
  private underwater!: UnderwaterPass;
  private fog!: VolumetricFog;
  private lensRain!: LensRain;
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
  /** Rain wetting for the ship and the floating props. */
  private readonly wetness = new SurfaceWetness();

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
  /** On-screen throttle/rudder. Null on devices with a fine pointer. */
  private touchControls: TouchControls | null = null;
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
      this.ssr = new ScreenSpaceReflection();
      this.ssr.setCamera(this.camera);
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
    // The volumetric march picks its caustics mip level from this, so it has to
    // be told after the field exists — see `uCausticsTexel`.
    this.underwater.setCausticsTexelSize(this.caustics.extent / this.caustics.resolution);

    // `RenderPipeline`, not the `PostProcessing` alias: the latter is deprecated
    // as of r183 and warns on every boot.
    this.post = new THREE.RenderPipeline(this.renderer);
    const scenePass = pass(this.scene, this.camera);
    // Must be the depth *texture* node: both passes linearise it to find where
    // the scene stops, which is what bounds their marches.
    const sceneDepth = scenePass.getTextureNode('depth');

    this.fog = new VolumetricFog();
    // Required: a post pass draws with the post-processor's own orthographic
    // quad camera, so the scene camera has to be handed over explicitly.
    this.fog.setCamera(this.camera);

    // Fog wraps the underwater pass, not the other way round.
    //
    // `UnderwaterPass.build` samples its colour input and reads `uvNode`, so it
    // has to consume the raw texture node; the fog accepts either that or an
    // already-composited colour. Above water the underwater pass is a bit-exact
    // pass-through, so the ordering only matters below the surface — where the
    // fog is faded out anyway, since there is no atmosphere down there.
    this.lensRain = new LensRain();

    const graded = this.fog.build(
      this.underwater.build(
        scenePass.getTextureNode(),
        sceneDepth,
        // The shafts are an integral of this field along the view ray, so
        // passing it here is what makes them and the seafloor pattern the same
        // light.
        (worldPosition) => this.caustics.intensityNode(worldPosition),
      ),
      sceneDepth,
    );

    // Lens rain comes last, and needs the graded image resolved to a texture
    // first.
    //
    // Both it and the underwater pass re-sample the image at displaced
    // coordinates, so both need a *texture* node rather than a composited colour
    // — and a composited node is exactly what each produces. They therefore
    // cannot be nested directly in either order, and putting the droplets first
    // was not merely wrong but silently fatal: the underwater pass called
    // `.sample()` on something that has no such method and the whole frame came
    // out black.
    //
    // `rtt` resolves the chain into a texture at the cost of one fullscreen
    // pass. That is the right place to spend it: droplets are lenses, and what
    // they should be refracting is the finished image — fog, grade and all — not
    // the raw scene behind it.
    //
    // All of this lives inside `outputNode`, so the droplets are part of the
    // rendered frame while the DOM HUD stays crisp on top of them.
    this.post.outputNode = this.lensRain.build(rtt(graded as THREE.Node)) as THREE.Node;

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
      this.wetness.adopt(ship.object);

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
      // Props share materials with the hull through the loader's cache;
      // `adopt` de-duplicates, so this is a no-op for anything already tracked.
      this.wetness.adopt(props.object);

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

    // Built only where it will be used. A mouse user has better controls and a
    // stick over the frame would only be in the way; constructing it anyway and
    // hiding it would leave a pointer target on the canvas for every desktop
    // viewer to discover by accident.
    if (TouchControls.isTouchDevice()) {
      this.touchControls = new TouchControls(this.uiRoot, {
        onInput: (throttle, rudder) => this.shipControls?.setInput(throttle, rudder),
      });
      this.touchControls.setVisible(this.state.cameraMode === 'boat');
    }
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
        this.touchControls?.setVisible(this.state.cameraMode === 'boat');
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
      foam: {
        texture: this.wake.texture,
        extent: this.wake.extent,
        resolution: this.wake.resolution,
      },
      reflectionNode: this.reflections?.node ?? null,
      ssrNode: this.ssr
        ? (worldPosition, worldNormal, fallback) =>
            this.ssr!.reflectionNode(worldPosition, worldNormal, fallback)
        : null,
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
    this.ssr?.setQuality(DEFAULT_SSR_STEPS[tier]);
    this.ssr?.setStrength(quality.reflection);
    this.fog.setSteps(quality.fogSteps);
    // WebGL2 gets the two-lattice floor whatever the tier, matching the rest of
    // the fallback policy.
    this.lensRain.setQuality(this.backend === 'webgl' ? 1 : quality.lensRainQuality);
    this.water.setWakeDisplacement(quality.wakeDisplacement);

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

    // --- whitecaps ----------------------------------------------------------
    //
    // Neither of these was called at all, which meant the accumulation buffer
    // ran at one fixed threshold and one fixed rate for every preset and every
    // wind speed: a glassy dusk foamed exactly as hard as a 21 m/s storm. The
    // preset's `foamThreshold` reached only the surface's instantaneous mask,
    // which since the near field went over to the buffer is the one place it no
    // longer decides anything.
    //
    // Coverage against wind follows Monahan & O'Muircheartaigh's fit to ship
    // observations, W = 3.84e-6 * U^3.41 — a very steep law, and the reason a
    // linear wind response never looks right. It gives 3.9% at 15 m/s, which is
    // what the sea state assertions measure, 0.2% at 6 m/s and 12% at 21 m/s.
    // Normalising by the 15 m/s value turns it into a multiplier on how strongly
    // the deposit reads, with the clamp keeping a calm sea faintly streaked
    // rather than surgically clean.
    const whitecapAt = (u: number) => 3.84e-6 * Math.pow(Math.max(0, u), 3.41);
    const foamThreshold = preset.water.foamThreshold ?? DEFAULT_APPEARANCE.foamThreshold;
    // The buffer's threshold is far tighter than the surface mask's. It has to
    // be: the mask asks "is this water folding *now*", which it answers for
    // every frame the crest is overhead, while the buffer asks "did it break
    // here", and then keeps the answer for a time constant afterwards. Measured
    // on cascade 0 at 15 m/s, fold < 0.14 covers 5.5% of the surface and fold < 0
    // covers 3.8%, so the buffer sees only genuinely folded water and the trail
    // it leaves supplies the rest of the coverage.
    // Monahan drives the *deposit rate*, not just the surface's read strength.
    //
    // It previously scaled only `setFoamStrength`, which changes how strongly an
    // existing deposit reads — so the empirical coverage law was decorating the
    // opacity of a foam field whose generation was a fixed constant for every
    // wind speed. The rate is what the law is about, so that is what it now
    // moves; the strength keeps a gentler share of it, because at a given
    // coverage heavier seas also entrain more air per breaking event.
    const whitecapRatio = whitecapAt(this.state.windSpeed) / whitecapAt(15);
    this.wake.setBreaking(
      foamThreshold * 0.34,
      0.55 * Math.max(0.05, Math.min(2.2, whitecapRatio)),
    );

    // The surface's own mask is re-scaled from the same number.
    //
    // The preset values (0.42 to 0.55) were authored when that mask painted the
    // whole ocean, and against the measured fold distribution they select about
    // 18% of the surface — which is what a 15 m/s clear day was rendering, and it
    // reads as a gale. Now that the near field belongs to the buffer, the mask's
    // only job is the far field beyond the buffer's 420 m square, so it is scaled
    // to select roughly what the buffer does and the two meet without a seam.
    //
    // Derived here rather than by editing the nine presets so the two thresholds
    // cannot drift apart: they describe one physical property of one sea.
    this.water.setAppearance({
      foamThreshold: foamThreshold * 0.62,
      foamSoftness: 0.42,
    });
    this.water.setFoamStrength(Math.max(0.35, Math.min(1.2, Math.sqrt(whitecapRatio))));
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
    //
    // The water's own aerial perspective is wound back as the volumetric fog
    // comes up. Both describe the same air between the viewer and the horizon,
    // and running them at full strength together fogs it twice — the surface
    // term is a cheap analytic far-field haze and the volumetric pass is the
    // better answer wherever it is active, so the analytic one yields to it
    // rather than the two being summed.
    const fogPreset = getPreset(this.state.preset).fog;
    this.water.setSky(
      this.atmosphere.zenithColor,
      this.atmosphere.horizonColor,
      fogPreset.color,
      fogPreset.density * (1 - 0.75 * this.state.fogDensity),
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
    // Wood and canvas darken and gloss in a squall, and stay damp well after it
    // passes — see `SurfaceWetness` for the asymmetric time constants.
    this.wetness.update(dt, raining);

    this.lensRain.setIntensity(raining);

    this.simulation.update(elapsed);
    // Deterministic stepping owns the readback and awaits it; kicking off a
    // second, unawaited one here would put the race straight back.
    if (!this.deterministic) this.sampler.update();

    this.oceanMesh.recenter(this.camera.position);
    this.water.setWorldOffset(this.oceanMesh.mesh.position.x, this.oceanMesh.mesh.position.z);
    // Depth-buffer distances are measured along this axis; the surface needs it
    // to convert them into distance along each pixel's own ray.
    this.water.setCameraForward(this.camera.getWorldDirection(_keyDirection2));

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

    // Rain on the lens. Placed here rather than with the other rain wiring
    // because it needs `submersion`, which is only known once the camera has
    // been resolved against the surface — the effect suppresses itself as the
    // viewer goes under, since there is no lens above water to bead on.
    this.lensRain.setSubmersion(submersion);
    // Screen-space "down" for the droplets, leaned by the wind.
    //
    // **+y is down here.** The quad's uv runs top-down, the same way screen uv
    // does everywhere else in this project — it is NDC that runs bottom-up, which
    // is the asymmetry `clipToScreenUV` in `ScreenSpaceReflection` documents and
    // that the fog and underwater passes had to be corrected for. This was set to
    // -1 on the opposite assumption and the beads ran *up* the screen.
    //
    // Set explicitly rather than left to the effect's own default, because which
    // way rain runs down a lens is exactly the kind of thing that is obvious to a
    // viewer and invisible to every test we have.
    const lean = Math.min(0.5, this.state.windSpeed * 0.018);
    this.lensRain.setGravity(Math.sin(preset.sea.windDirection) * lean, 1, 1 + lean);
    this.lensRain.update(dt);

    // Volumetric fog follows the key light, and fades out as the camera goes
    // under. There is no atmosphere below the waterline — the medium down there
    // is the underwater pass's job, and leaving both on would stack two
    // different descriptions of the same water on top of each other.
    this.fog.setParams({
      sunDirection: _keyDirection,
      sunColor: this.atmosphere.sunLight.color,
      sunIntensity: Math.max(0.05, this.atmosphere.sunLight.intensity / 3.4),
      // Extinction per metre, from the preset, scaled by the slider.
      //
      // The slider's default of 0.35 is the *neutral* point — it means "as thick
      // as this place is" — and it scales to about 2.9x at the top. That is what
      // a fog control should do: a clear day made foggy is still a clear day's
      // light, and Foggy at the same slider position is still much thicker than
      // Sea of Thieves at it.
      //
      // This used to be `slider * 0.021` with no preset term at all, which put
      // 0.0074/m under every preset — around 400 m of visibility — and rendered
      // even Clear Day as a white-out. The preset numbers now carry the medium;
      // see `Preset.fog.volumetric`.
      density:
        preset.fog.volumetric * (this.state.fogDensity / DEFAULT_UI_STATE.fogDensity) *
        (1 - submersion),
      windDirection: preset.sea.windDirection,
      windSpeed: 0.4 + this.state.windSpeed * 0.06,
    });
    this.fog.update(dt);

    // Particles only cost anything while they can actually be seen.
    this.particles.setVisible(submersion > 0.01);
    if (submersion > 0.01) this.particles.update(dt, this.camera.position);

    this.ssr?.update(dt);
    this.caustics.setSunDirection(this.atmosphere.sunDirection);
    this.caustics.update(dt);
    // Re-bake around the viewer. Must run outside an active render target, so it
    // sits here in the update rather than inside the post chain.
    this.caustics.bake(this.renderer, this.camera.position.x, this.camera.position.z);

    this.updateSceneContent(dt);

    // *After* the wake has been recentred and re-rendered, not before.
    //
    // `updateSceneContent` moves the buffer's world centre to the camera and
    // resamples the texture to match. Publishing the centre ahead of that handed
    // the surface the *previous* frame's anchor for a texture that had already
    // been re-anchored, so while the camera was moving the wake slid against the
    // hull by exactly one frame of camera travel — the one thing the whole
    // world-anchored design exists to prevent, reintroduced by an ordering.
    this.water.setFoamCenter(this.wake.centerX, this.wake.centerZ);

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
    // The controller runs *before* the solver, so this frame's throttle and
    // rudder are integrated by this frame's substeps.
    //
    // It used to sit inside the `ship` branch below, which is after
    // `buoyancy.update` — and the comment there claimed the opposite of what the
    // code did. The external force persists between frames, so the ship still
    // sailed and no test could see it; every input was simply acted on one frame
    // late. An independent review caught it by reading the call order rather
    // than the comment.
    this.shipControls?.update(dt);

    // Safe before the sampler's first readback resolves: it reports height 0 and
    // bodies simply settle to flat water rather than producing NaN.
    this.buoyancy.update(dt, this.sampler);

    const ship = this.ship;
    if (ship) {
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
        /**
         * Reflection layers, exposed so a test can isolate them.
         *
         * The two are composited, not chosen between, and the tier drives both
         * from one number — so a test that only asks "does hiding the ship change
         * the water" is satisfied by the planar layer alone and would pass with
         * the screen-space trace completely broken. Null on the WebGL2 path,
         * which has neither.
         */
        reflections: this.reflections,
        ssr: this.ssr,
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
        resetDeterministic: async (
          time = 0,
          settleSteps = 90,
          shipInput: { throttle: number; rudder: number } | null = null,
        ) => {
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
          this.fog.resetClock(start);
          this.lensRain.resetClock(start);
          this.caustics.resetClock(start);
          this.atmosphere.resetClock(start);
          this.clouds.resetWind();
          this.wake?.reset(this.renderer);

          // Floating bodies carry position and momentum across a whole session;
          // returning them to their spawn poses is what stops a capture from
          // inheriting wherever the hull happened to have drifted.
          this.buoyancy?.resetToHome();
          // Zero first, then re-apply, so a caller that passes no input always
          // gets a stationary hull regardless of what the previous shot left on
          // the throttle. A caller that *does* pass one gets it applied before
          // the settle rather than after, which is the whole point: the ship has
          // a ~6.7 s velocity time constant, so an input applied after settling
          // would photograph a hull that has not begun to move.
          this.shipControls?.setInput(0, 0);
          // Set, not settled. Wetness dries with a 26 s time constant, so a
          // capture that inherited a storm's wet hull would still be visibly damp
          // three hundred settle steps later.
          this.wetness.setWetness(this.rainOverride ?? getPreset(this.state.preset).weather.intensity);
          if (shipInput) this.shipControls?.setInput(shipInput.throttle, shipInput.rudder);
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
        /** Whether the on-screen throttle/rudder is built and showing. */
        touchControlsVisible: () => this.touchControls?.isVisible ?? false,
        /** Current rain wetting of the hull and props, 0..1. */
        surfaceWetness: () => this.wetness.value,
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
    this.touchControls?.dispose();
    this.director?.dispose();
    this.sampler?.dispose();
    this.simulation?.dispose();
    this.oceanMesh?.dispose();
    this.water?.dispose();
    this.atmosphere?.dispose();
    this.clouds?.dispose();
    this.weather?.dispose();
    this.underwater?.dispose();
    this.fog?.dispose();
    this.lensRain?.dispose();
    this.particles?.dispose();
    this.caustics?.dispose();
    this.shipControls?.dispose();
    // Restores the dry roughness and colour on materials the loader's cache
    // shares, so a re-created App does not inherit a permanently wet ship.
    this.wetness.dispose();
    this.buoyancy?.dispose();
    this.wake?.dispose();
    this.ship?.dispose();
    this.props?.dispose();
    this.seafloor?.dispose();
    this.reflections?.dispose();
    this.ssr?.dispose();
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
