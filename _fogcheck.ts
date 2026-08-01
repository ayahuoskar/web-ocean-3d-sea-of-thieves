import * as THREE from 'three/webgpu';
import { Fn, pass, vec4 } from 'three/tsl';
import { VolumetricFog } from './src/post/VolumetricFog';

const log: string[] = [];
function note(s: string) {
  log.push(s);
  // eslint-disable-next-line no-console
  console.log('FOGCHECK ' + s);
  (window as unknown as Record<string, unknown>).__fogLog = log;
}

function buildScene() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 640 / 360, 0.1, 40000);
  camera.position.set(0, 6, 0);
  camera.lookAt(0, 5.5, -80);
  camera.updateMatrixWorld();

  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(6000, 6000),
    new THREE.MeshBasicNodeMaterial({ color: 0x2b6ea8 }),
  );
  sea.rotateX(-Math.PI / 2);
  scene.add(sea);

  const box = new THREE.Mesh(
    new THREE.BoxGeometry(12, 12, 12),
    new THREE.MeshBasicNodeMaterial({ color: 0xffcc88 }),
  );
  box.position.set(0, 6, -70);
  scene.add(box);
  return { scene, camera };
}

async function run(canvasId: string, forceWebGL: boolean, wrapped: boolean) {
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL });
  await renderer.init();
  renderer.setSize(640, 360, false);

  const { scene, camera } = buildScene();

  const fog = new VolumetricFog();
  fog.setCamera(camera);
  fog.setSteps(24);
  fog.setParams({ density: 0.012, detail: 0.6, sunDirection: new THREE.Vector3(0.2, 0.25, -0.94) });

  const post = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  const colour = scenePass.getTextureNode();
  const depth = scenePass.getTextureNode('depth');

  // `wrapped` exercises the non-texture-node input path: a colour node that is
  // already the output of another pass, which is how it sits after UnderwaterPass.
  const input = wrapped ? (Fn(() => vec4((colour as never as { rgb: unknown }).rgb, 1))() as unknown) : colour;

  post.outputNode = fog.build(input, depth) as THREE.Node;

  fog.update(0.016);
  await post.renderAsync();
  // second frame, to make sure nothing recompiles or throws on reuse
  fog.setSteps(12);
  fog.update(0.016);
  await post.renderAsync();

  const backend = (renderer.backend as { constructor: { name: string } }).constructor.name;
  note(`OK ${canvasId} backend=${backend} forceWebGL=${forceWebGL} wrapped=${wrapped}`);
}

(async () => {
  try {
    await run('c', false, false);
  } catch (e) {
    note('FAIL webgpu: ' + String((e as Error)?.stack ?? e));
  }
  try {
    await run('c2', true, true);
  } catch (e) {
    note('FAIL webgl: ' + String((e as Error)?.stack ?? e));
  }
  (window as unknown as Record<string, unknown>).__fogDone = true;
  note('DONE');
})();
