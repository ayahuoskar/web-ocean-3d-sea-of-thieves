import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createRenderer } from './core/Renderer';
import { Loop } from './core/Loop';
import { QUALITY_TIERS, type QualityTier } from './core/QualityManager';
import { OceanSimulation } from './ocean/OceanSimulation';
import { OceanMesh } from './ocean/OceanMesh';
import { OceanMaterial } from './ocean/OceanMaterial';
import { DEFAULT_SPECTRUM, GRAVITY } from './ocean/Spectrum';

const boot = {
  root: document.getElementById('boot') as HTMLElement,
  bar: document.getElementById('boot-bar') as HTMLElement,
  status: document.getElementById('boot-status') as HTMLElement,
  set(progress: number, message: string) {
    if (this.bar) this.bar.style.width = `${Math.round(progress * 100)}%`;
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

async function start(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;

  boot.set(0.05, 'Initialising renderer…');
  const { renderer, backend } = await createRenderer({ canvas });
  // eslint-disable-next-line no-console
  console.info(`[ocean] renderer backend: ${backend}`);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 40000);
  camera.position.set(0, 12, 42);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.target.set(0, 2, 0);
  controls.maxDistance = 900;
  controls.minDistance = 2;

  boot.set(0.3, 'Building wave spectrum…');
  const tier: QualityTier = 'high';
  const quality = QUALITY_TIERS[tier];

  const simulation = new OceanSimulation(renderer, {
    size: quality.fftSize,
    cascadeCount: quality.cascades,
    params: DEFAULT_SPECTRUM,
  });

  boot.set(0.6, 'Compiling water shaders…');
  const water = new OceanMaterial({
    displacementTextures: simulation.displacementTextures,
    derivativeTextures: simulation.derivativeTextures,
    tileSizes: simulation.tileSizes,
  });

  const oceanMesh = new OceanMesh(water.material, {
    radialSegments: quality.meshRings,
    angularSegments: quality.meshSegments,
  });
  scene.add(oceanMesh.mesh);

  // Provisional lighting and background until the atmosphere layer lands.
  const sunDirection = new THREE.Vector3(0.35, 0.42, 0.28).normalize();
  water.setSun(sunDirection, new THREE.Color(1.0, 0.95, 0.86), 6);
  scene.background = new THREE.Color(0x8fbde4);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  });

  const loop = new Loop(() => {
    renderer.render(scene, camera);
  });

  loop.add((_dt, elapsed) => {
    controls.update();
    simulation.update(elapsed);
    oceanMesh.recenter(camera.position);
    water.setWorldOffset(oceanMesh.mesh.position.x, oceanMesh.mesh.position.z);
  });

  boot.set(1, 'Ready');
  loop.start();
  window.setTimeout(() => boot.hide(), 350);

  // Expose a deterministic control surface for the Playwright verification loop.
  Object.assign(window, {
    __ocean: {
      renderer,
      scene,
      camera,
      controls,
      simulation,
      loop,
      backend,
      gravity: GRAVITY,
    },
  });
}

start().catch((error: unknown) => {
  console.error(error);
  boot.fail(
    error instanceof Error
      ? `Failed to start: ${error.message}`
      : 'Failed to start: unknown error',
  );
});
