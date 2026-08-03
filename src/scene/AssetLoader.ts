import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

/**
 * Caching glTF loader.
 *
 * Three properties matter for this project:
 *
 *  - **Dedup.** `Ship` and `Props` are constructed in parallel from the same
 *    `AssetLoader`. Two concurrent `load()` calls for one URL must issue exactly
 *    one network fetch, so the cache stores the in-flight *promise*, not the
 *    resolved value.
 *  - **Isolation.** Callers get a `clone()` of the cached scene graph. Handing
 *    out the same `Group` twice would mean the second `scene.add()` silently
 *    reparents it away from the first. Clones share geometry and material, so
 *    the cost is a handful of `Object3D`s.
 *  - **Determinism.** Every GPU resource the loader creates is recorded, so
 *    `dispose()` frees the lot in one pass rather than relying on callers to
 *    traverse their own subtrees.
 *
 * Compression is configured defensively. The current asset set is uncompressed,
 * but re-exporting through `gltf-transform` (Draco or Meshopt) is a normal
 * optimisation step and should not require a code change. The Draco decoder is
 * only wired up if a decoder is actually served from this origin — pointing at a
 * CDN would add a third-party runtime dependency to an otherwise self-contained
 * build, so if there is no local decoder we simply do not advertise Draco
 * support.
 */

/** Where a locally hosted Draco decoder might live, best candidate first. */
const DRACO_CANDIDATES = [
  '/draco/gltf/',
  '/draco/',
  // Vite serves the project root in dev, so the copy that ships inside the
  // three.js package is reachable without a build step.
  '/node_modules/three/examples/jsm/libs/draco/gltf/',
];

export interface AssetProgress {
  /** 0..1 over every file this loader has seen, across all requests. */
  fraction: number;
  itemsLoaded: number;
  itemsTotal: number;
  /** The file that just completed. */
  url: string;
}

export type AssetProgressCallback = (progress: AssetProgress) => void;

export interface AssetLoaderOptions {
  onProgress?: AssetProgressCallback;
  /**
   * Convert loaded glTF materials to `MeshPhysicalNodeMaterial` so downstream
   * systems (caustics, underwater tint) can attach TSL nodes to them. Defaults
   * to true.
   */
  convertToNodeMaterials?: boolean;
  /** Explicit Draco decoder directory; skips auto-detection when provided. */
  dracoDecoderPath?: string;
}

export class AssetLoader {
  private readonly manager = new THREE.LoadingManager();
  private readonly gltf: GLTFLoader;
  private readonly cache = new Map<string, Promise<THREE.Group>>();

  /** Everything we created and therefore must free. */
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();
  private readonly textures = new Set<THREE.Texture>();

  /**
   * Loaded material -> the node material standing in for it.
   *
   * One entry per *source* material, which is the whole point. `GLTFLoader`
   * hands the same `Material` instance to every mesh that shares it in the
   * file, and downstream code relies on that identity: `Props.bakeParts` groups
   * geometry by material instance so that a multi-part asset merges into one
   * draw per material. Converting per mesh would fork one glTF material into
   * one node material per node — which is exactly what happened to
   * `grass_bermuda_01`, a single-material file of twenty-one separate blades:
   * every blade became its own material, so nothing merged and the tuft was
   * scattered as twenty-one lonely sprigs instead of being stacked into one.
   */
  private readonly converted = new Map<THREE.Material, THREE.Material>();

  private draco: DRACOLoader | null = null;
  private dracoProbe: Promise<string | null> | null = null;
  private meshoptProbe: Promise<void> | null = null;

  private readonly convertMaterials: boolean;
  private readonly explicitDracoPath: string | undefined;
  private onProgress: AssetProgressCallback | undefined;
  private disposed = false;

  /** Reused so the per-file progress callback never allocates. */
  private readonly progressState: AssetProgress = {
    fraction: 0,
    itemsLoaded: 0,
    itemsTotal: 0,
    url: '',
  };

  constructor(options: AssetLoaderOptions = {}) {
    this.convertMaterials = options.convertToNodeMaterials ?? true;
    this.explicitDracoPath = options.dracoDecoderPath;
    this.onProgress = options.onProgress;

    this.manager.onProgress = (url, itemsLoaded, itemsTotal) => {
      const state = this.progressState;
      state.url = url;
      state.itemsLoaded = itemsLoaded;
      state.itemsTotal = itemsTotal;
      state.fraction = itemsTotal > 0 ? itemsLoaded / itemsTotal : 0;
      this.onProgress?.(state);
    };

    this.gltf = new GLTFLoader(this.manager);
  }

  setProgressCallback(callback: AssetProgressCallback | undefined): void {
    this.onProgress = callback;
  }

  /** 0..1 across every file requested so far. */
  get progress(): number {
    return this.progressState.fraction;
  }

  /**
   * Loads `url` and resolves with an independent clone of its scene graph.
   * Concurrent calls for the same URL share one fetch.
   */
  async load(url: string): Promise<THREE.Group> {
    if (this.disposed) throw new Error(`AssetLoader disposed; cannot load ${url}`);

    let pending = this.cache.get(url);
    if (!pending) {
      pending = this.loadSource(url);
      this.cache.set(url, pending);
      // A failed load must not poison the cache — the next attempt should retry.
      pending.catch(() => this.cache.delete(url));
    }

    const source = await pending;
    return source.clone(true) as THREE.Group;
  }

  /** Frees every geometry, material and texture this loader created. */
  dispose(): void {
    this.disposed = true;
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.textures.clear();
    this.converted.clear();
    this.cache.clear();
    this.draco?.dispose();
    this.draco = null;
  }

  // ------------------------------------------------------------------ internals

  private async loadSource(url: string): Promise<THREE.Group> {
    await Promise.all([this.configureDraco(), this.configureMeshopt()]);

    const gltf = await this.gltf.loadAsync(url);
    const scene = gltf.scene;
    scene.name = scene.name || url;

    // Bake the glTF's own node transforms into world matrices once, so callers
    // that read bounding boxes immediately get correct numbers.
    scene.updateMatrixWorld(true);

    scene.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;

      this.geometries.add(mesh.geometry);

      const source = mesh.material;
      if (Array.isArray(source)) {
        mesh.material = source.map((m) => this.adoptMaterial(m));
      } else {
        mesh.material = this.adoptMaterial(source);
      }
    });

    return scene;
  }

  /**
   * Takes ownership of a loaded material, optionally converting it to a node
   * material, and registers it (and its textures) for disposal.
   */
  private adoptMaterial(material: THREE.Material): THREE.Material {
    const already = this.converted.get(material);
    if (already) return already;

    const converted =
      this.convertMaterials && (material as THREE.MeshStandardMaterial).isMeshStandardMaterial
        ? toPhysicalNodeMaterial(material as THREE.MeshStandardMaterial)
        : material;

    if (converted !== material) {
      // The original is dead the moment we swap it out; free it now rather than
      // holding a reference to something nothing renders. Keyed on it first, so
      // the next mesh sharing it still finds the replacement.
      this.converted.set(material, converted);
      material.dispose();
    } else {
      this.converted.set(material, converted);
    }

    this.materials.add(converted);
    collectTextures(converted, this.textures);
    return converted;
  }

  private configureDraco(): Promise<void> {
    if (this.draco) return Promise.resolve();

    if (!this.dracoProbe) {
      this.dracoProbe = this.explicitDracoPath
        ? Promise.resolve(this.explicitDracoPath)
        : probeDracoDecoder();
    }

    return this.dracoProbe.then((path) => {
      if (!path || this.draco || this.disposed) return;
      const draco = new DRACOLoader();
      draco.setDecoderPath(path);
      this.gltf.setDRACOLoader(draco);
      this.draco = draco;
    });
  }

  /**
   * Meshopt's decoder is a self-contained ES module inside the three package —
   * no sidecar files, so it can always be wired up. The dynamic import keeps it
   * out of the initial bundle for the (current) case where nothing uses it.
   */
  private configureMeshopt(): Promise<void> {
    if (!this.meshoptProbe) {
      this.meshoptProbe = import('three/addons/libs/meshopt_decoder.module.js')
        .then((module) => {
          if (this.disposed) return;
          this.gltf.setMeshoptDecoder(module.MeshoptDecoder);
        })
        .catch(() => {
          /* Meshopt support is optional; uncompressed assets load regardless. */
        });
    }
    return this.meshoptProbe;
  }
}

/**
 * Builds a `MeshPhysicalNodeMaterial` equivalent to a glTF-produced
 * `MeshStandardMaterial`.
 *
 * `Material.copy()` is not usable here: the node material does not extend
 * `MeshStandardMaterial`, so `copy` would skip exactly the map slots that
 * matter. The slots are therefore transferred explicitly. Textures are shared,
 * not cloned — the loader owns them either way.
 */
export function toPhysicalNodeMaterial(
  source: THREE.MeshStandardMaterial,
): THREE.MeshPhysicalNodeMaterial {
  const target = new THREE.MeshPhysicalNodeMaterial();

  target.name = source.name;
  target.color.copy(source.color);
  target.map = source.map;
  target.roughness = source.roughness;
  target.roughnessMap = source.roughnessMap;
  target.metalness = source.metalness;
  target.metalnessMap = source.metalnessMap;
  target.normalMap = source.normalMap;
  target.normalScale.copy(source.normalScale);
  target.normalMapType = source.normalMapType;
  target.aoMap = source.aoMap;
  target.aoMapIntensity = source.aoMapIntensity;
  target.emissive.copy(source.emissive);
  target.emissiveMap = source.emissiveMap;
  target.emissiveIntensity = source.emissiveIntensity;
  target.alphaMap = source.alphaMap;
  target.alphaTest = source.alphaTest;
  target.transparent = source.transparent;
  target.opacity = source.opacity;
  target.side = source.side;
  target.flatShading = source.flatShading;
  target.wireframe = source.wireframe;
  target.vertexColors = source.vertexColors;
  target.depthWrite = source.depthWrite;
  target.envMapIntensity = source.envMapIntensity;
  target.lightMap = source.lightMap;
  target.lightMapIntensity = source.lightMapIntensity;
  target.bumpMap = source.bumpMap;
  target.bumpScale = source.bumpScale;
  target.displacementMap = source.displacementMap;
  target.displacementScale = source.displacementScale;
  target.displacementBias = source.displacementBias;

  // KHR_materials_* extensions land on the standard material as loose
  // properties; carry over the ones the physical model understands.
  const extended = source as unknown as Record<string, unknown>;
  if (typeof extended.ior === 'number') target.ior = extended.ior;
  if (typeof extended.clearcoat === 'number') target.clearcoat = extended.clearcoat;
  if (typeof extended.transmission === 'number') target.transmission = extended.transmission;
  if (typeof extended.sheen === 'number') target.sheen = extended.sheen;
  if (typeof extended.iridescence === 'number') target.iridescence = extended.iridescence;

  return target;
}

/**
 * Rewrites every quantised vertex attribute of `geometry` as plain float32.
 *
 * Call this before baking a transform into loaded geometry. It is not an
 * optimisation — it is a correctness fix, and the bug it prevents is silent and
 * spectacular.
 *
 * `scripts/optimize-assets.mjs` Meshopt-encodes the scene dressing, and Meshopt
 * encoding quantises: positions arrive as an `Int16Array` with
 * `normalized = true`, holding values in [-1, 1], and the model's real size
 * lives in the glTF node's scale. `BufferAttribute.applyMatrix4` reads through
 * `getX/getY/getZ`, which de-normalise, and writes back through `setXYZ`, which
 * does not — so baking a node scale of 4 into the geometry tries to store 4.2 in
 * a buffer whose representable range stops at 1, and every vertex outside the
 * unit cube is clamped onto its faces.
 *
 * A tree came out of that as a hollow box of ribbons standing where the tree
 * should be — the exact silhouette of a mesh flattened onto a cube. Worth
 * knowing as a failure mode, because nothing errors: the model loads, the draw
 * succeeds, and only the shape is wrong.
 *
 * De-normalising also makes `mergeGeometries` work across an asset's parts,
 * since it refuses inputs whose attributes disagree about normalisation.
 */
export function dequantiseGeometry(geometry: THREE.BufferGeometry): void {
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    const source = attribute as THREE.BufferAttribute;
    if (!source.normalized && source.array instanceof Float32Array) continue;

    const items = source.itemSize;
    const values = new Float32Array(source.count * items);
    for (let i = 0; i < source.count; i++) {
      for (let c = 0; c < items; c++) values[i * items + c] = source.getComponent(i, c);
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(values, items));
  }
}

/** Adds every texture referenced by `material` to `into`. */
function collectTextures(material: THREE.Material, into: Set<THREE.Texture>): void {
  const record = material as unknown as Record<string, unknown>;
  for (const key in record) {
    const value = record[key];
    if (value && (value as THREE.Texture).isTexture) {
      into.add(value as THREE.Texture);
    }
  }
}

/**
 * Finds a same-origin Draco decoder, or null.
 *
 * A dev server with SPA fallback happily answers 200 with `index.html` for a
 * missing path, so the content type is checked as well as the status.
 */
async function probeDracoDecoder(): Promise<string | null> {
  if (typeof fetch !== 'function') return null;

  for (const base of DRACO_CANDIDATES) {
    try {
      const response = await fetch(`${base}draco_decoder.js`, { method: 'HEAD' });
      if (!response.ok) continue;
      const type = response.headers.get('content-type') ?? '';
      if (type.includes('html')) continue;
      return base;
    } catch {
      // Network error or blocked path — try the next candidate.
    }
  }
  return null;
}
