import * as THREE from 'three/webgpu';
import type { AssetLoader } from './AssetLoader';
import { ISLAND, seafloorHeight } from './Seafloor';
import { SEEDS, mulberry32 } from '../core/random';

/**
 * Scene dressing: floating props near the play area, and the rocky island that
 * sits on the horizon.
 *
 * Two placement rules drive everything here:
 *
 *  - **Floaters are individual objects.** Each buoy and barrel is driven by its
 *    own `BuoyantBody`, so each needs its own transform. Instancing them would
 *    save a handful of draw calls and cost the independent bobbing that the
 *    reference is quite obviously doing.
 *  - **Everything static is instanced.** The island is ~30 boulders and 4 cliff
 *    blocks built from two geometries, so it is two `InstancedMesh`es and two
 *    draw calls regardless of how much rock we pile up.
 *
 * Placement is driven by a seeded PRNG: the scene must be identical on every
 * load, otherwise reference comparison screenshots never match.
 */

const BUOY_URL = '/models/ocean_buoy/ocean_buoy_1k.gltf';
const BARREL_URL = '/models/barrel_03/barrel_03_1k.gltf';
const ROCK_URL = '/models/rock_07/rock_07_1k.gltf';
const CLIFF_URL = '/models/namaqualand_cliff_01/namaqualand_cliff_01_1k.gltf';

const BUOY_COUNT = 5;
const BARREL_COUNT = 6;
const ROCK_COUNT = 34;
const CLIFF_COUNT = 5;

export interface Floater {
  object: THREE.Object3D;
  /** Effective flotation radius in metres, for buoyancy probe layout. */
  radius: number;
}

export interface PropsOptions {
  /** Overrides the seeded layout; useful for A/B-ing a dressing pass. */
  seed?: number;
}

export class Props {
  readonly object: THREE.Object3D;
  readonly floaters: Floater[] = [];

  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly sources: THREE.Group[] = [];
  private disposed = false;

  private constructor(sources: LoadedSources, seed: number) {
    this.object = new THREE.Group();
    this.object.name = 'props';
    this.sources.push(sources.buoy, sources.barrel, sources.rock, sources.cliff);

    const random = mulberry32(seed);

    this.placeFloaters(sources.buoy, sources.barrel, random);
    this.placeIsland(sources.rock, sources.cliff, random);
  }

  static async load(loader: AssetLoader, options: PropsOptions = {}): Promise<Props> {
    const [buoy, barrel, rock, cliff] = await Promise.all([
      loader.load(BUOY_URL),
      loader.load(BARREL_URL),
      loader.load(ROCK_URL),
      loader.load(CLIFF_URL),
    ]);
    for (const group of [buoy, barrel, rock, cliff]) group.updateMatrixWorld(true);
    return new Props({ buoy, barrel, rock, cliff }, options.seed ?? SEEDS.props);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.removeFromParent();
    this.object.clear();
    this.floaters.length = 0;
    // Only the geometries this class *created* (baked instancing copies) are
    // ours to free; the loaded originals belong to the AssetLoader.
    for (const geometry of this.ownedGeometries) geometry.dispose();
    this.ownedGeometries.length = 0;
    for (const source of this.sources) source.clear();
    this.sources.length = 0;
  }

  // ------------------------------------------------------------------ internals

  /**
   * Scatters buoys and barrels on an annulus around the origin. The inner
   * radius keeps them clear of the ship at spawn, the outer radius keeps them
   * inside the wake texture's footprint and inside the shallow plateau, where
   * they read against the turquoise instead of vanishing into deep blue.
   */
  private placeFloaters(buoy: THREE.Group, barrel: THREE.Group, random: () => number): void {
    const normaliseBuoy = normaliseFloater(buoy, 2.4);
    const normaliseBarrel = normaliseFloater(barrel, 1.15);

    for (let i = 0; i < BUOY_COUNT; i++) {
      const angle = ((i + random() * 0.6) / BUOY_COUNT) * Math.PI * 2;
      const radius = 55 + random() * 145;
      const object = normaliseBuoy();
      object.name = `buoy-${i}`;
      object.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      object.rotation.y = random() * Math.PI * 2;
      this.object.add(object);
      this.floaters.push({ object, radius: 1.1 });
    }

    for (let i = 0; i < BARREL_COUNT; i++) {
      // Barrels cluster: flotsam travels together.
      const cluster = i < BARREL_COUNT / 2 ? 0 : 1;
      const baseAngle = cluster === 0 ? 2.1 : 4.9;
      const angle = baseAngle + (random() - 0.5) * 0.5;
      const radius = (cluster === 0 ? 34 : 72) + random() * 22;
      const object = normaliseBarrel();
      object.name = `barrel-${i}`;
      object.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      object.rotation.set((random() - 0.5) * 0.5, random() * Math.PI * 2, (random() - 0.5) * 0.5);
      this.object.add(object);
      this.floaters.push({ object, radius: 0.62 });
    }
  }

  /**
   * Builds the island silhouette: a few large cliff blocks forming the mass,
   * ringed with boulders down to the waterline, all seated on the seafloor
   * heightfield so nothing floats or buries itself.
   */
  private placeIsland(rock: THREE.Group, cliff: THREE.Group, random: () => number): void {
    const island = new THREE.Group();
    island.name = 'island';
    this.object.add(island);

    const cliffMesh = this.buildInstanced(cliff, CLIFF_COUNT, 'island-cliffs');
    const rockMesh = this.buildInstanced(rock, ROCK_COUNT, 'island-rocks');
    if (cliffMesh) island.add(cliffMesh);
    if (rockMesh) island.add(rockMesh);

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const euler = new THREE.Euler();

    if (cliffMesh) {
      for (let i = 0; i < CLIFF_COUNT; i++) {
        const angle = (i / CLIFF_COUNT) * Math.PI * 2 + random() * 0.4;
        const radius = ISLAND.radius * (0.1 + random() * 0.3);
        const x = ISLAND.x + Math.cos(angle) * radius;
        const z = ISLAND.z + Math.sin(angle) * radius;
        const s = 7.5 + random() * 4.5;

        position.set(x, seafloorHeight(x, z) - 6 * s * 0.06, z);
        euler.set(0, angle + Math.PI, (random() - 0.5) * 0.12);
        quaternion.setFromEuler(euler);
        scale.set(s, s * (0.85 + random() * 0.4), s);
        cliffMesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
      }
      cliffMesh.instanceMatrix.needsUpdate = true;
      cliffMesh.computeBoundingSphere();
    }

    if (rockMesh) {
      for (let i = 0; i < ROCK_COUNT; i++) {
        const angle = random() * Math.PI * 2;
        // Bias toward the shoreline ring so the island gets a broken edge
        // rather than a clean cone.
        const radius = ISLAND.radius * (0.35 + Math.sqrt(random()) * 0.6);
        const x = ISLAND.x + Math.cos(angle) * radius;
        const z = ISLAND.z + Math.sin(angle) * radius;
        const s = 14 + random() * 30;

        position.set(x, seafloorHeight(x, z) - s * 0.02, z);
        euler.set((random() - 0.5) * 0.3, random() * Math.PI * 2, (random() - 0.5) * 0.3);
        quaternion.setFromEuler(euler);
        scale.set(s, s * (0.7 + random() * 0.7), s);
        rockMesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
      }
      rockMesh.instanceMatrix.needsUpdate = true;
      rockMesh.computeBoundingSphere();
    }
  }

  /**
   * Collapses a loaded single-mesh asset into an `InstancedMesh`.
   *
   * The glTF node transform is baked into a copy of the geometry so the
   * instance matrices are pure placement — otherwise every instance would need
   * to carry the asset's own arbitrary rotation.
   */
  private buildInstanced(
    source: THREE.Group,
    count: number,
    name: string,
  ): THREE.InstancedMesh | null {
    const mesh = firstMesh(source);
    if (!mesh) return null;

    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    geometry.computeBoundingSphere();
    this.ownedGeometries.push(geometry);

    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const instanced = new THREE.InstancedMesh(geometry, material, count);
    instanced.name = name;
    instanced.castShadow = true;
    instanced.receiveShadow = true;
    instanced.frustumCulled = true;
    return instanced;
  }
}

interface LoadedSources {
  buoy: THREE.Group;
  barrel: THREE.Group;
  rock: THREE.Group;
  cliff: THREE.Group;
}

/**
 * Returns a factory producing normalised copies of a floating prop: scaled to
 * `targetHeight` metres tall, centred horizontally, and with its resting
 * waterline at y = 0 so buoyancy can drive the object origin directly.
 */
function normaliseFloater(source: THREE.Group, targetHeight: number): () => THREE.Object3D {
  const box = new THREE.Box3().setFromObject(source, true);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = targetHeight / Math.max(1e-4, size.y);

  // Floating debris sits with roughly 40% of its height submerged.
  const waterlineY = box.min.y + size.y * 0.4;

  return () => {
    const inner = source.clone(true);
    inner.position.set(-center.x, -waterlineY, -center.z);

    const holder = new THREE.Object3D();
    const scaled = new THREE.Group();
    scaled.scale.setScalar(scale);
    scaled.add(inner);
    holder.add(scaled);

    holder.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });

    return holder;
  };
}

function firstMesh(root: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (found === null && mesh.isMesh) found = mesh;
  });
  return found;
}

