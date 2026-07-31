import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { createRenderer, clampPixelRatio, type Backend } from './core/Renderer';
import { Caustics, UnderwaterParticles, UnderwaterPass } from './underwater';
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

  private post!: THREE.PostProcessing;
  private underwater!: UnderwaterPass;
  private particles!: UnderwaterParticles;
  private caustics!: Caustics;

  private panel!: Panel;
  private hud!: Hud;
  private loop!: Loop;
  private adaptive!: AdaptiveQuality;

  private state: UiState = { ...DEFAULT_UI_STATE };
  private disposed = false;

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

    boot.set(0.5, 'Compiling water shaders…');
    this.water = new OceanMaterial({
      displacementTextures: this.simulation.displacementTextures,
      derivativeTextures: this.simulation.derivativeTextures,
      tileSizes: this.simulation.tileSizes,
    });
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

    this.post = new THREE.PostProcessing(this.renderer);
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

    this.loop = new Loop(() => {
      this.post.render();
    });
    this.loop.add(this.update);

    boot.set(1, 'Ready');
    this.loop.start();
    window.setTimeout(() => boot.hide(), 350);

    this.exposeTestHooks();
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

  private applyQuality(tier: QualityTier): void {
    const quality = QUALITY_TIERS[tier];
    this.simulation.resize(quality.fftSize, quality.cascades);
    this.sampler.rebuild();

    // The wave textures are recreated by `resize`, so the material's bindings are
    // stale — rebuild the surface against the new ones.
    const previous = this.water;
    this.water = new OceanMaterial({
      displacementTextures: this.simulation.displacementTextures,
      derivativeTextures: this.simulation.derivativeTextures,
      tileSizes: this.simulation.tileSizes,
    });
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
    this.renderer.shadowMap.enabled = quality.shadowMapSize > 0;
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
    this.sampler.update();

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

    this.hud.setFps(this.loop.stats.fps);
    this.adaptive.update(dt, this.loop.stats.fps, this.state.quality, elapsed);
  };

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
        getState: () => ({ ...this.state }),
        setState: (partial: Partial<UiState>) => {
          for (const [key, value] of Object.entries(partial)) {
            (this.state as unknown as Record<string, unknown>)[key] = value;
            this.onStateChange(key as keyof UiState);
          }
          this.panel.setState(partial);
        },
        /** Places the camera exactly, for reproducible screenshots. */
        setCamera: (px: number, py: number, pz: number, tx: number, ty: number, tz: number) => {
          this.camera.position.set(px, py, pz);
          this.director.orbit.target.set(tx, ty, tz);
          this.camera.lookAt(tx, ty, tz);
          this.director.orbit.update();
        },
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
