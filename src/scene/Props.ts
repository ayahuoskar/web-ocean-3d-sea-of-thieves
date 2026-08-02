import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AssetLoader } from './AssetLoader';
import { ISLAND, seafloorHeight } from './Seafloor';
import { SEEDS, mulberry32 } from '../core/random';

/**
 * Scene dressing: floating props near the play area, the rocky island that sits
 * on the horizon, and the two authored set pieces — a pirate cove on the
 * island's leeward shore and a wreck's worth of cargo on the reef.
 *
 * Placement rules, in the order they matter:
 *
 *  - **Floaters are individual objects.** Each buoy and barrel is driven by its
 *    own `BuoyantBody`, so each needs its own transform. Instancing them would
 *    save a handful of draw calls and cost the independent bobbing that the
 *    reference is quite obviously doing.
 *  - **Everything static and repeated is instanced.** A model kind costs one
 *    draw per *material* no matter how many copies are scattered, because the
 *    loaded sub-meshes are baked and merged per material before instancing.
 *    Authored one-offs — the jetty, the pinnace, the cannon, the chest — are
 *    plain meshes; there is exactly one of each and instancing them would only
 *    add indirection.
 *  - **Everything on land is seated on `seafloorHeight`.** The island is a
 *    heightfield, not a plane, and it is the same function the floor mesh is
 *    built from. Placing by radius alone put props two metres in the air on one
 *    bearing and two metres underground on the next.
 *  - **Placement is seeded.** The scene must be identical on every load,
 *    otherwise reference comparison screenshots never match. The dressing draws
 *    from its *own* stream (see `DRESSING_SEED_MIX`) so that adding or removing
 *    a plant kind cannot reshuffle the floaters, the island rocks or the reef.
 *
 * On scale: the island is ~1.4 km from the origin, where one screen pixel is
 * a bit over a metre of island. It is a silhouette. So the budget goes on the
 * few things that survive that — headland cliffs, wave-cut rock shelves and
 * trees tall enough to break the skyline — and the understorey exists for the
 * fly camera rather than the horizon, which is why its counts are small and why
 * the detail scale thins it hardest.
 */

const BUOY_URL = '/models/ocean_buoy/ocean_buoy_1k.gltf';
const BARREL_URL = '/models/barrel_03/barrel_03_1k.gltf';
const ROCK_URL = '/models/rock_07/rock_07_1k.gltf';
const CLIFF_URL = '/models/namaqualand_cliff_01/namaqualand_cliff_01_1k.gltf';

/** Scene-dressing library. Every entry is optional: a 404 thins the scene. */
const DRESSING_URLS = {
  coastalCliff: '/models/dressing/coastal_cliff_02.glb',
  coastRocksWide: '/models/dressing/coast_rocks_01.glb',
  coastRocksTall: '/models/dressing/coast_rocks_03.glb',
  sandRocks: '/models/dressing/sand_rocks_small_01.glb',
  tree: '/models/dressing/island_tree_01.glb',
  pachira: '/models/dressing/pachira_aquatica_01.glb',
  fern: '/models/dressing/fern_02.glb',
  sorrel: '/models/dressing/shrub_sorrel_01.glb',
  grass: '/models/dressing/grass_bermuda_01.glb',
  anthurium: '/models/dressing/anthurium_botany_01.glb',
  calathea: '/models/dressing/calathea_orbifolia_01.glb',
  pinnace: '/models/dressing/ship_pinnace.glb',
  pier: '/models/dressing/modular_wooden_pier.glb',
  cannon: '/models/dressing/cannon_01.glb',
  barrels: '/models/dressing/wooden_barrels_01.glb',
  lantern: '/models/dressing/wooden_lantern_01.glb',
  coveCrate: '/models/dressing/wooden_crate_02.glb',
  chest: '/models/dressing/treasure_chest.glb',
  reefCrate: '/models/dressing/wooden_crate_01.glb',
  shell: '/models/dressing/lambis_shell.glb',
} as const;

type DressingKey = keyof typeof DRESSING_URLS;
type Dressing = Record<DressingKey, THREE.Group | null>;

const BUOY_COUNT = 5;
const BARREL_COUNT = 6;
const ROCK_COUNT = 34;
const CLIFF_COUNT = 5;

/** Reef outcrops on the seafloor. One instanced draw, so this can be generous. */
const REEF_COUNT = 90;
/** Clear of the spawn point, and inside the shallow plateau (radius 320 m). */
const REEF_INNER = 26;
const REEF_OUTER = 260;

/**
 * Instance counts for the island dressing at detail 1.
 *
 * These are triangle budgets as much as they are art direction. The photogram-
 * metry assets are LOD0 scans — the tree is 77k triangles, the small sand rocks
 * are 74k — so a count here is worth ~50-80k triangles, and the number that
 * makes the island read is a lot smaller than the number that would make it
 * look dense from ten metres away.
 */
const COASTAL_CLIFF_COUNT = 6;
const COAST_ROCKS_WIDE_COUNT = 5;
const COAST_ROCKS_TALL_COUNT = 5;
const SAND_ROCKS_COUNT = 4;
const TREE_COUNT = 9;
const PACHIRA_COUNT = 9;
const ANTHURIUM_COUNT = 10;
const CALATHEA_COUNT = 12;
const FERN_COUNT = 16;
const SORREL_COUNT = 18;
const GRASS_COUNT = 54;
const SHELL_COUNT = 9;

/**
 * XOR mix that derives the dressing's PRNG seed from the props seed.
 *
 * A separate stream, not a continuation of the same one: `Props` writes the
 * floaters, the island rocks and the reef from `SEEDS.props`, and if the
 * dressing drew from that same generator then adding one fern would move every
 * buoy in the scene. Golden-ratio constant, which is only to say "some fixed
 * number with a well-spread bit pattern".
 */
const DRESSING_SEED_MIX = 0x9e3779b9;

/** Rejected samples per instance before a scatter gives up on that instance. */
const PLACEMENT_ATTEMPTS = 24;

/**
 * Fraction of an instanced kind that survives however low the detail scale
 * goes. A kind that thins to nothing changes the island's shape rather than its
 * density, which is the one thing the detail scale must not do.
 */
const DETAIL_FLOOR = 0.25;

// ------------------------------------------------------------------ the cove

/**
 * Bearing of the cove from the island centre, radians in the same convention as
 * the scatter code (x = cos, z = sin).
 *
 * The default wind blows toward +x/+z (`Spectrum` defaults to pi/4), so this
 * face is the lee — the only shore of the island where a boat could be left on
 * a mooring. It also happens to be the face that looks back at the play area,
 * which is what makes the cove worth building at all.
 */
const COVE_BEARING = 0.7;

/**
 * Radii are metres from the island centre. The heightfield crosses sea level at
 * about 150 m on this bearing, so anything below that number is beach and
 * anything above it is water.
 */
const JETTY_RADIUS = 159;
const JETTY_SCALE = 1.5;
/** Deck height above mean sea level, metres. */
const JETTY_DECK_Y = 2.1;
/** Deck surface in the pier model's own units, for seating things on it. */
const PIER_DECK_LOCAL = 2.67;

const PINNACE_RADIUS = 152;
const PINNACE_ALONGSHORE = -21;
const PINNACE_SCALE = 0.55;
/** Metres the hull is lifted off the sand, so the keel bites rather than floats. */
const PINNACE_KEEL_LIFT = 1.05;
const PINNACE_HEEL = 0.17;
/** Bow-up trim, radians. Negative pitches the bow up in a YXZ rotation. */
const PINNACE_TRIM = -0.09;

/** Centre of the underwater find, world metres. A local high on the plateau. */
const FIND = { x: -38, z: -66 } as const;
/** Radius the shells scatter over, around the chest. */
const FIND_SPREAD = 13;

const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;

export interface Floater {
  object: THREE.Object3D;
  /** Effective flotation radius in metres, for buoyancy probe layout. */
  radius: number;
}

export interface PropsOptions {
  /** Overrides the seeded layout; useful for A/B-ing a dressing pass. */
  seed?: number;
  /**
   * Density of the scattered dressing, 0..1. Scales the instance count of every
   * repeated kind — planting, shore rocks, island rocks and the reef — without
   * touching the authored set pieces, which are the parts that carry meaning
   * rather than density.
   *
   * Applied by moving `InstancedMesh.count`, never by rebuilding: a tier change
   * can call `setDetailScale` on a live scene for the cost of a few integer
   * writes. Defaults to 1.
   */
  detailScale?: number;
}

/** An instanced kind the detail scale is allowed to thin. */
interface Thinnable {
  /** One mesh per material, all driven by the same instance matrices. */
  meshes: THREE.InstancedMesh[];
  /** Instances actually written. The ceiling for `count`. */
  capacity: number;
  /** Count below which this kind stops thinning. */
  floor: number;
}

/** A loaded asset baked down to one geometry per material. */
interface BakedPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

type BakeOrigin =
  /** Keep the asset's own origin. For models that are already assembled. */
  | 'asset'
  /** Recentre the selection as a whole on its footprint, base at y = 0. */
  | 'cluster'
  /**
   * Recentre every node individually, collapsing a row of variants laid out
   * side by side in the source file into one overlapping clump.
   */
  | 'stack';

interface BakeOptions {
  /** Keeps only the nodes whose name passes this test. */
  include?: (name: string) => boolean;
  origin?: BakeOrigin;
}

/** How one model kind scatters across the island. */
interface ScatterSpec {
  /** Radial band from the island centre, metres. */
  minRadius: number;
  maxRadius: number;
  /** Elevation band a sample must land in, metres relative to sea level. */
  minHeight: number;
  maxHeight: number;
  /** Steepest ground the kind will sit on, as a gradient (rise over run). */
  maxSlope?: number;
  /** Confines the kind to an arc; omitted means the whole island. */
  bearing?: number;
  /** Half-width of that arc, radians. */
  spread?: number;
  /** Uniform scale range. */
  minScale: number;
  maxScale: number;
  /** Extra vertical stretch on top of the uniform scale. */
  minStretch?: number;
  maxStretch?: number;
  /** Metres sunk below the ground per unit of instance scale. */
  sink?: number;
  /** How far the model tips toward the ground normal, 0..1. */
  slope?: number;
  /** Half-width of the terrain sample the normal comes from, metres. */
  slopeSpan?: number;
  /** Peak random tilt added on top of the ground normal, radians. */
  lean?: number;
  /** Where the model's forward axis points. */
  facing?: 'random' | 'outward' | 'alongshore';
  /** Number of clumps to gather the instances into; 0 scatters evenly. */
  clusters?: number;
  /** Radius of one clump, metres. */
  clusterRadius?: number;
  bake?: BakeOptions;
}

export class Props {
  readonly object: THREE.Object3D;
  readonly floaters: Floater[] = [];

  private readonly ownedGeometries: THREE.BufferGeometry[] = [];
  private readonly sources: THREE.Group[] = [];
  private readonly thinnable: Thinnable[] = [];
  private detail = 1;
  private disposed = false;

  private constructor(
    sources: LoadedSources,
    dressing: Dressing,
    seed: number,
    detailScale: number,
  ) {
    this.object = new THREE.Group();
    this.object.name = 'props';
    this.sources.push(sources.buoy, sources.barrel, sources.rock, sources.cliff);
    for (const group of Object.values(dressing)) if (group) this.sources.push(group);

    const random = mulberry32(seed);

    this.placeFloaters(sources.buoy, sources.barrel, random);
    this.placeIsland(sources.rock, sources.cliff, random);
    this.placeReef(sources.rock, random);

    const dressingRandom = mulberry32((seed ^ DRESSING_SEED_MIX) >>> 0);
    this.dressIsland(dressing, dressingRandom);
    this.placeCove(dressing);
    this.placeFind(dressing, dressingRandom);

    this.setDetailScale(detailScale);
  }

  static async load(loader: AssetLoader, options: PropsOptions = {}): Promise<Props> {
    const dressingKeys = Object.keys(DRESSING_URLS) as DressingKey[];

    const [hero, dressingResults] = await Promise.all([
      Promise.all([
        loader.load(BUOY_URL),
        loader.load(BARREL_URL),
        loader.load(ROCK_URL),
        loader.load(CLIFF_URL),
      ]),
      // Settled, not `all`. The dressing is twenty independent files and no one
      // of them is worth the scene: a missing fern should cost a fern, not the
      // island, the cove and the ship's wake along with it.
      Promise.allSettled(dressingKeys.map((key) => loader.load(DRESSING_URLS[key]))),
    ]);

    const [buoy, barrel, rock, cliff] = hero;
    for (const group of hero) group.updateMatrixWorld(true);

    const dressing = {} as Dressing;
    dressingKeys.forEach((key, index) => {
      const result = dressingResults[index];
      if (result.status === 'fulfilled') {
        result.value.updateMatrixWorld(true);
        dressing[key] = result.value;
      } else {
        console.warn(`[ocean] dressing asset unavailable: ${DRESSING_URLS[key]}`, result.reason);
        dressing[key] = null;
      }
    });

    return new Props(
      { buoy, barrel, rock, cliff },
      dressing,
      options.seed ?? SEEDS.props,
      options.detailScale ?? 1,
    );
  }

  /** Current scattered-dressing density, 0..1. */
  get detailScale(): number {
    return this.detail;
  }

  /**
   * Thins every scattered kind to `scale` of the instances that were placed.
   *
   * Moves `InstancedMesh.count` only. The matrices stay written and the bounding
   * spheres stay as computed over the full set, so this is reversible, costs no
   * allocation, and can run on a live scene between frames.
   *
   * Instances are written in seeded-random order precisely so that truncating
   * the count thins the scatter evenly instead of clipping off whichever part of
   * the island happened to be filled last.
   */
  setDetailScale(scale: number): void {
    const clamped = Math.min(1, Math.max(0, scale));
    this.detail = clamped;
    for (const entry of this.thinnable) {
      const count = Math.max(entry.floor, Math.round(entry.capacity * clamped));
      for (const mesh of entry.meshes) mesh.count = Math.min(entry.capacity, count);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.removeFromParent();
    this.object.clear();
    this.floaters.length = 0;
    this.thinnable.length = 0;
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
   * Scatters a reef across the shallow plateau, so there is something down there
   * to look at.
   *
   * The submerged view was empty water over flat sand: the god rays had nothing
   * to fall across, the caustics had nothing to bend over, and there was no
   * parallax to give the depth any scale. Rocks on the bottom fix all three at
   * once, and they are the one thing that can — a fish shoal would move
   * independently of the swell and read as decoration, while a reef is what
   * makes the water *volume* legible.
   *
   * Reuses the island's rock, which is already loaded and instanced, so this
   * costs one more draw call and no download. Scattered on an annulus that
   * clears the spawn point but stays inside the plateau, where the water is
   * shallow enough that light still reaches the bottom.
   */
  private placeReef(rock: THREE.Group, random: () => number): void {
    const reefMesh = this.buildInstanced(rock, REEF_COUNT, 'reef-rocks');
    if (!reefMesh) return;
    // Never culled by its own bounds against the surface: the reef is read
    // through refraction from above as well as directly from below.
    reefMesh.castShadow = false;
    this.object.add(reefMesh);

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const euler = new THREE.Euler();

    for (let i = 0; i < REEF_COUNT; i++) {
      const angle = random() * Math.PI * 2;
      // Square-root radius keeps the scatter even in *area* rather than
      // clustering everything at the inner edge.
      const radius = REEF_INNER + Math.sqrt(random()) * (REEF_OUTER - REEF_INNER);
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const s = 1.6 + random() * 7;

      // Sunk into the floor by a fraction of their size, so they read as
      // outcrops rather than as boulders resting on a plane.
      position.set(x, seafloorHeight(x, z) - s * 0.28, z);
      euler.set((random() - 0.5) * 0.7, random() * Math.PI * 2, (random() - 0.5) * 0.7);
      quaternion.setFromEuler(euler);
      scale.set(s, s * (0.5 + random() * 0.7), s);
      reefMesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    }
    reefMesh.instanceMatrix.needsUpdate = true;
    reefMesh.computeBoundingSphere();
    this.registerThinnable([reefMesh], REEF_COUNT);
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
      this.registerThinnable([cliffMesh], CLIFF_COUNT);
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
      this.registerThinnable([rockMesh], ROCK_COUNT);
    }
  }

  // ---------------------------------------------------------- island dressing

  /**
   * Dresses the island: a broken rocky coast at the waterline, and planting
   * above it that thins out as it approaches the shore.
   *
   * The elevation bands do the art direction. Nothing is placed by radius alone
   * because the heightfield's shoreline is not a circle — the coastal rock kinds
   * ask for ground between roughly -6 m and +4 m and land wherever that happens
   * to be, which is what puts rock exactly where the water meets the island
   * instead of on a ring that only approximately follows it.
   *
   * Density falls off toward the shore for free: the radial sample is uniform in
   * *radius*, so on a disc it concentrates inland, and the planting's minimum
   * height then cuts off the last stretch of beach entirely.
   */
  private dressIsland(dressing: Dressing, random: () => number): void {
    const island = new THREE.Group();
    island.name = 'island-dressing';
    this.object.add(island);

    // Headlands. The model is a 41 m wall lying along its own X axis, so it is
    // turned to run along the shore and sunk until only its top few metres show,
    // which is what turns a smooth dome into a coastline with corners in it.
    this.scatter(island, dressing.coastalCliff, COASTAL_CLIFF_COUNT, 'island-coastal-cliffs', random, {
      minRadius: 118,
      maxRadius: 168,
      minHeight: -4,
      maxHeight: 6,
      minScale: 1,
      maxScale: 1.7,
      minStretch: 0.85,
      maxStretch: 1.25,
      sink: 4.5,
      slope: 0.35,
      slopeSpan: 14,
      facing: 'alongshore',
    });

    // Wave-cut platforms. Both coast rock scans are wide and flat with their
    // origin buried inside the mass, so they need a wide terrain sample to tilt
    // against: a 60 m shelf levelled from a 6 m sample drives one edge metres
    // into the ground on a slope this gentle.
    this.scatter(island, dressing.coastRocksWide, COAST_ROCKS_WIDE_COUNT, 'island-coast-rocks-wide', random, {
      minRadius: 130,
      maxRadius: 176,
      // Floor of the band is set by the model, not by taste: these shelves are
      // only ~1.3 m proud of their own origin, so ground below about -4 m puts
      // a 40k-triangle scan entirely out of sight under the water.
      minHeight: -4,
      maxHeight: 3,
      minScale: 0.7,
      maxScale: 1.15,
      sink: 0.35,
      slope: 0.85,
      slopeSpan: 22,
    });

    this.scatter(island, dressing.coastRocksTall, COAST_ROCKS_TALL_COUNT, 'island-coast-rocks-tall', random, {
      minRadius: 124,
      maxRadius: 172,
      minHeight: -4,
      maxHeight: 4,
      minScale: 0.9,
      maxScale: 1.6,
      sink: 0.4,
      slope: 0.85,
      slopeSpan: 11,
    });

    // Beach rubble, confined to the cove's arc. This scan is 74k triangles for
    // something four metres across: from the play area it is one pixel, so the
    // only place it earns its cost is the stretch of beach the cove gives a
    // reason to fly to.
    this.scatter(island, dressing.sandRocks, SAND_ROCKS_COUNT, 'island-sand-rocks', random, {
      minRadius: 134,
      maxRadius: 154,
      minHeight: -1,
      maxHeight: 4,
      bearing: COVE_BEARING,
      spread: 0.24,
      minScale: 1.6,
      maxScale: 3,
      sink: 0.08,
      slope: 1,
      slopeSpan: 5,
    });

    // Trees in groves rather than an even scatter. Evenly spaced trees read as
    // an orchard from any distance; clumps read as vegetation, and at 1.4 km the
    // clumping is most of what is left of them.
    this.scatter(island, dressing.tree, TREE_COUNT, 'island-trees', random, {
      minRadius: 20,
      maxRadius: 118,
      minHeight: 4.5,
      maxHeight: Infinity,
      minScale: 2,
      maxScale: 3.2,
      minStretch: 0.9,
      maxStretch: 1.15,
      sink: 0.1,
      slope: 0.25,
      slopeSpan: 8,
      lean: 0.06,
      clusters: 3,
      clusterRadius: 45,
    });

    // The pachira ships as four plants laid out in a row; `_d` is the tallest of
    // them, and taking one variant rather than the row is what keeps this to a
    // single instanced clump instead of four plants marching sideways.
    this.scatter(island, dressing.pachira, PACHIRA_COUNT, 'island-pachira', random, {
      minRadius: 28,
      maxRadius: 128,
      minHeight: 3.5,
      maxHeight: Infinity,
      minScale: 2.2,
      maxScale: 3.6,
      sink: 0.05,
      slope: 0.2,
      slopeSpan: 7,
      lean: 0.08,
      clusters: 3,
      clusterRadius: 38,
      bake: { include: (name) => name.endsWith('_d'), origin: 'cluster' },
    });

    this.scatter(island, dressing.anthurium, ANTHURIUM_COUNT, 'island-anthurium', random, {
      minRadius: 25,
      maxRadius: 130,
      minHeight: 3,
      maxHeight: Infinity,
      minScale: 1.8,
      maxScale: 3.2,
      slope: 0.3,
      slopeSpan: 6,
      lean: 0.1,
      clusters: 4,
      clusterRadius: 30,
      bake: { include: (name) => name.endsWith('_a'), origin: 'cluster' },
    });

    this.scatter(island, dressing.calathea, CALATHEA_COUNT, 'island-calathea', random, {
      minRadius: 25,
      maxRadius: 132,
      minHeight: 3,
      maxHeight: Infinity,
      minScale: 2.2,
      maxScale: 3.8,
      slope: 0.3,
      slopeSpan: 6,
      lean: 0.1,
      clusters: 4,
      clusterRadius: 30,
      bake: { include: (name) => name.endsWith('_a'), origin: 'cluster' },
    });

    this.scatter(island, dressing.fern, FERN_COUNT, 'island-ferns', random, {
      minRadius: 25,
      maxRadius: 136,
      minHeight: 2.5,
      maxHeight: Infinity,
      minScale: 2.4,
      maxScale: 4.2,
      slope: 0.35,
      slopeSpan: 6,
      lean: 0.12,
      clusters: 5,
      clusterRadius: 28,
      bake: { include: (name) => name.endsWith('_b'), origin: 'cluster' },
    });

    this.scatter(island, dressing.sorrel, SORREL_COUNT, 'island-sorrel', random, {
      minRadius: 25,
      maxRadius: 138,
      minHeight: 2,
      maxHeight: Infinity,
      minScale: 7,
      maxScale: 14,
      slope: 0.4,
      slopeSpan: 5,
      lean: 0.12,
      clusters: 5,
      clusterRadius: 26,
      bake: { include: (name) => name.endsWith('_d'), origin: 'cluster' },
    });

    // Grass is the one kind with a slope test. It is also the one kind whose
    // source file is a row of twenty-one separate blades: stacking the medium
    // and seedling variants on a common origin turns that row into a tuft, and
    // merging them makes the tuft a single geometry and therefore a single draw.
    this.scatter(island, dressing.grass, GRASS_COUNT, 'island-grass', random, {
      minRadius: 15,
      maxRadius: 130,
      minHeight: 2.5,
      maxHeight: Infinity,
      maxSlope: 0.13,
      minScale: 4,
      maxScale: 8,
      slope: 0.6,
      slopeSpan: 5,
      lean: 0.07,
      clusters: 8,
      clusterRadius: 24,
      bake: {
        include: (name) => name.includes('_medium_') || name.includes('_seedling_'),
        origin: 'stack',
      },
    });
  }

  // -------------------------------------------------------------- pirate cove

  /**
   * The pirate cove: authored placement, not scatter.
   *
   * Every position here is a fixed polar coordinate about the island centre
   * rather than a random draw, because the point of the cluster is the relative
   * arrangement — jetty out into the water, boat beached beside it, gun above
   * the tideline covering the approach, stores stacked behind the gun. Scattered
   * to the same density it would read as debris.
   *
   * The one thing that is *not* seated on the heightfield is the jetty. A jetty's
   * deck is level and its height is set by the water, not by the bank, so it is
   * placed at a fixed height above sea level and the terrain is left to meet it:
   * the landward posts bury themselves in the beach and the seaward ones stand
   * clear in three metres of water, which is exactly what the model is for.
   */
  private placeCove(dressing: Dressing): void {
    const cove = new THREE.Group();
    cove.name = 'pirate-cove';
    this.object.add(cove);

    const point = new THREE.Vector3();

    const pier = this.buildStatic(this.bakeParts(dressing.pier), 'cove-jetty-deck');
    let jetty: THREE.Group | null = null;
    if (pier) {
      jetty = new THREE.Group();
      jetty.name = 'cove-jetty';
      const bearing = covePoint(JETTY_RADIUS, 0, point);
      jetty.position.set(point.x, JETTY_DECK_Y - PIER_DECK_LOCAL * JETTY_SCALE, point.z);
      // The model runs along its own Z with the intact sections at -Z and the
      // collapsed end at +Z, so pointing +Z out to sea leaves the ruined half
      // and the standing mooring posts in the water.
      jetty.rotation.y = yawAlignZ(Math.cos(bearing), Math.sin(bearing));
      jetty.scale.setScalar(JETTY_SCALE);
      jetty.add(pier);
      cove.add(jetty);
    }

    // Parented to the jetty rather than placed in world space: a lantern on a
    // pier is on the pier, and this way moving the jetty cannot leave it hanging
    // over open water. The scale compensates for the jetty's own.
    const lantern = this.buildStatic(this.bakeParts(dressing.lantern), 'cove-lantern');
    if (lantern && jetty) {
      lantern.position.set(0.86, PIER_DECK_LOCAL, -1.4);
      lantern.rotation.y = 0.7;
      lantern.scale.setScalar(1.4);
      jetty.add(lantern);
    }

    const pinnace = this.buildStatic(this.bakeParts(dressing.pinnace), 'cove-pinnace');
    if (pinnace) {
      const bearing = covePoint(PINNACE_RADIUS, PINNACE_ALONGSHORE, point);
      pinnace.position.set(point.x, point.y + PINNACE_KEEL_LIFT, point.z);
      // Run aground at a shallow angle rather than bow-on: mostly along the
      // beach, angled just enough inshore to look driven there.
      const bowX = -Math.cos(bearing) * 0.42 - Math.sin(bearing) * 0.91;
      const bowZ = -Math.sin(bearing) * 0.42 + Math.cos(bearing) * 0.91;
      // YXZ so the roll is about the model's own keel line and not about world Z
      // — the heel is what says "aground" rather than "moored". The bow-up trim
      // is the beach gradient: the hull spans about nine metres of a shore that
      // falls a fifth of a metre per metre, so a level ship buries its forefoot
      // and floats its rudder.
      pinnace.rotation.set(PINNACE_TRIM, yawAlignZ(bowX, bowZ), PINNACE_HEEL, 'YXZ');
      pinnace.scale.setScalar(PINNACE_SCALE);
      cove.add(pinnace);
    }

    const cannon = this.buildStatic(this.bakeParts(dressing.cannon), 'cove-cannon');
    if (cannon) {
      const bearing = covePoint(138, 6, point);
      // Only partly levelled to the slope: a gun position gets dug in, so it
      // follows the beach less than the barrels stacked behind it do.
      seatOnGround(cannon, point, yawAlignZ(Math.cos(bearing), Math.sin(bearing)) + 0.28, 0.45, 6);
      cannon.position.y -= 0.05;
      cannon.scale.setScalar(1.7);
      cove.add(cannon);
    }

    const barrels = this.buildStatic(this.bakeParts(dressing.barrels), 'cove-barrels');
    if (barrels) {
      covePoint(133, -11, point);
      seatOnGround(barrels, point, 2.4, 0.9, 5);
      barrels.scale.setScalar(1.35);
      cove.add(barrels);
    }

    const crate = this.buildStatic(this.bakeParts(dressing.coveCrate), 'cove-crate');
    if (crate) {
      covePoint(136, -4, point);
      seatOnGround(crate, point, 0.55, 0.8, 4);
      crate.scale.setScalar(1.5);
      cove.add(crate);
    }

    // The island is 1.4 km from the origin and the sun's shadow camera is a
    // +/-260 m box anchored there, so nothing on the island can cast into it or
    // receive from it. Leaving the flags on would buy a per-frame frustum test
    // against a shadow map the island is nowhere near.
    cove.traverse(clearShadowFlags);
  }

  // ---------------------------------------------------------- underwater find

  /**
   * The find: a chest, a crate and a scatter of shells on the reef.
   *
   * Sited on a local high of the plateau at about 16 m of water. That depth is
   * chosen against the shaders rather than the art — `Seafloor` fades its
   * caustics out over 2 m to 48 m of depth, so at 16 m the pattern is still at
   * about three quarters strength and the god rays still reach — and it is
   * inside the reef's annulus, so the chest is found among rocks rather than on
   * open sand.
   *
   * These do keep their shadow flags. Unlike the island, this is well inside the
   * sun shadow camera's box, and a chest with no contact shadow floats.
   */
  private placeFind(dressing: Dressing, random: () => number): void {
    const find = new THREE.Group();
    find.name = 'reef-find';
    this.object.add(find);

    const point = new THREE.Vector3();

    const chest = this.buildStatic(this.bakeParts(dressing.chest), 'reef-chest');
    if (chest) {
      groundPoint(FIND.x, FIND.z, point);
      seatOnGround(chest, point, 0.92, 1, 4);
      chest.position.y -= 0.14;
      chest.scale.setScalar(2.2);
      find.add(chest);
    }

    const crate = this.buildStatic(this.bakeParts(dressing.reefCrate), 'reef-crate');
    if (crate) {
      groundPoint(FIND.x + 3.6, FIND.z - 2.4, point);
      seatOnGround(crate, point, 2.6, 1, 4);
      crate.position.y -= 0.1;
      crate.scale.setScalar(2);
      find.add(crate);
    }

    const shells = this.buildScatter(this.bakeParts(dressing.shell), SHELL_COUNT, 'reef-shells');
    if (!shells) return;

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const normal = new THREE.Vector3();

    for (let i = 0; i < SHELL_COUNT; i++) {
      // Square-root radius so the shells spread over the area around the chest
      // rather than piling up against it.
      const angle = random() * TAU;
      const radius = 2 + Math.sqrt(random()) * FIND_SPREAD;
      const x = FIND.x + Math.cos(angle) * radius;
      const z = FIND.z + Math.sin(angle) * radius;
      const s = 2.2 + random() * 2;

      position.set(x, seafloorHeight(x, z) - s * 0.01, z);
      groundNormal(x, z, 3, normal);
      quaternion.setFromUnitVectors(UP, normal);
      quaternion.multiply(spinAbout(UP, random() * TAU));
      scale.set(s, s, s);
      for (const mesh of shells) mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
    }
    this.seal(shells, SHELL_COUNT);
    for (const mesh of shells) find.add(mesh);
  }

  // ---------------------------------------------------------------- placement

  /**
   * Scatters one model kind across the island according to `spec`.
   *
   * A sample that misses the elevation or slope band is rejected and redrawn,
   * up to `PLACEMENT_ATTEMPTS` times, and an instance that never finds ground is
   * simply not placed — so the count in the constants above is a ceiling, and
   * the instance count is fixed afterwards to what actually landed. Leaving the
   * unplaced instances at their identity matrix would stack the whole kind on
   * the world origin, in the middle of the play area.
   */
  private scatter(
    parent: THREE.Object3D,
    source: THREE.Group | null,
    count: number,
    name: string,
    random: () => number,
    spec: ScatterSpec,
  ): void {
    const meshes = this.buildScatter(this.bakeParts(source, spec.bake), count, name);
    if (!meshes) return;

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const point = new THREE.Vector3();

    // Clump centres are drawn first and reused, so an instance only has to find
    // ground near one of them.
    const clusterCount = spec.clusters ?? 0;
    const clusters: number[] = [];
    for (let i = 0; i < clusterCount; i++) {
      if (pickIslandPoint(random, spec, point)) clusters.push(point.x, point.z);
    }
    const clusterRadius = spec.clusterRadius ?? 30;

    const sink = spec.sink ?? 0;
    const slope = spec.slope ?? 0;
    const slopeSpan = spec.slopeSpan ?? 6;
    const lean = spec.lean ?? 0;
    const minStretch = spec.minStretch ?? 1;
    const maxStretch = spec.maxStretch ?? minStretch;

    let placed = 0;
    for (let i = 0; i < count; i++) {
      const found =
        clusters.length > 0
          ? pickClusterPoint(random, spec, clusters, (i % (clusters.length / 2)) * 2, clusterRadius, point)
          : pickIslandPoint(random, spec, point);
      if (!found) continue;

      const s = spec.minScale + random() * (spec.maxScale - spec.minScale);
      position.set(point.x, point.y - sink * s, point.z);

      let yaw: number;
      if (spec.facing === 'outward') {
        yaw = yawAlignZ(point.x - ISLAND.x, point.z - ISLAND.z);
      } else if (spec.facing === 'alongshore') {
        // The model's long axis is X, and +X is a quarter turn behind +Z.
        yaw = yawAlignZ(-(point.z - ISLAND.z), point.x - ISLAND.x) - Math.PI / 2;
      } else {
        yaw = random() * TAU;
      }

      if (slope > 0) {
        groundNormal(point.x, point.z, slopeSpan, normal);
        // Partial alignment: a rock lies on the slope, a tree grows up out of it.
        if (slope < 1) normal.lerp(UP, 1 - slope).normalize();
        quaternion.setFromUnitVectors(UP, normal);
        quaternion.multiply(spinAbout(UP, yaw));
      } else {
        quaternion.copy(spinAbout(UP, yaw));
      }
      if (lean > 0) quaternion.multiply(randomLean(random, lean));

      const stretch = minStretch + random() * (maxStretch - minStretch);
      scale.set(s, s * stretch, s);
      matrix.compose(position, quaternion, scale);
      for (const mesh of meshes) mesh.setMatrixAt(placed, matrix);
      placed++;
    }

    if (placed === 0) return;
    this.seal(meshes, placed);
    for (const mesh of meshes) {
      // The island is far outside the sun's shadow camera; see `placeCove`.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      parent.add(mesh);
    }
  }

  /**
   * Fixes an instanced kind's count at what was actually placed and takes its
   * bounds.
   *
   * Order matters: `InstancedMesh.computeBoundingSphere` only walks the first
   * `count` instances, so the sphere is taken over the full placed set *before*
   * the detail scale is allowed to trim the count. A sphere that covers
   * instances we are not currently drawing is conservative, and a conservative
   * sphere can never cull something that is on screen.
   */
  private seal(meshes: THREE.InstancedMesh[], placed: number): void {
    for (const mesh of meshes) {
      mesh.count = placed;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
    this.registerThinnable(meshes, placed);
  }

  private registerThinnable(meshes: THREE.InstancedMesh[], capacity: number): void {
    this.thinnable.push({
      meshes,
      capacity,
      floor: Math.max(1, Math.ceil(capacity * DETAIL_FLOOR)),
    });
  }

  // ------------------------------------------------------------------ baking

  /**
   * Bakes a loaded asset down to one geometry per material.
   *
   * Two jobs. First, the glTF node transforms are baked into geometry copies so
   * that an instance matrix is pure placement — otherwise every instance would
   * have to carry the asset's own arbitrary rotation. Second, sub-meshes that
   * share a material are merged, which is what keeps a nineteen-part barrel pile
   * or a twenty-one-blade grass patch down to one draw call per material rather
   * than one per part.
   *
   * Grouping by the three.js `Material` instance rather than by name is load
   * bearing: `GLTFLoader` already forks a material when some primitives carry
   * vertex colours and others do not, so grouping this way separates exactly the
   * meshes whose attribute sets would have made the merge fail.
   */
  private bakeParts(source: THREE.Group | null, options: BakeOptions = {}): BakedPart[] {
    if (!source) return [];
    const origin = options.origin ?? 'asset';

    const collected: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    const collect = (filtered: boolean): void => {
      source.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (filtered && options.include && !options.include(mesh.name)) return;

        const geometry = mesh.geometry.clone();
        geometry.applyMatrix4(mesh.matrixWorld);
        collected.push(geometry);
        materials.push(Array.isArray(mesh.material) ? mesh.material[0] : mesh.material);
      });
    };

    collect(true);
    // A renamed or re-exported asset should degrade to "the whole model, which
    // may look odd" rather than to nothing at all.
    if (collected.length === 0) collect(false);
    if (collected.length === 0) return [];

    if (origin !== 'asset') {
      const box = new THREE.Box3();
      const bounds = new THREE.Box3();
      const shift = new THREE.Vector3();
      // 'cluster' recentres the selection once, preserving how the parts sit
      // relative to each other; 'stack' recentres each part on its own footprint,
      // which is what collapses a row of variants into a single clump.
      if (origin === 'cluster') {
        box.makeEmpty();
        for (const geometry of collected) {
          geometry.computeBoundingBox();
          if (geometry.boundingBox) box.union(geometry.boundingBox);
        }
        recentreShift(box, shift);
        for (const geometry of collected) geometry.translate(shift.x, shift.y, shift.z);
      } else {
        for (const geometry of collected) {
          geometry.computeBoundingBox();
          if (!geometry.boundingBox) continue;
          bounds.copy(geometry.boundingBox);
          recentreShift(bounds, shift);
          geometry.translate(shift.x, shift.y, shift.z);
        }
      }
    }

    const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
    for (let i = 0; i < collected.length; i++) {
      const material = materials[i];
      const bucket = byMaterial.get(material);
      if (bucket) bucket.push(collected[i]);
      else byMaterial.set(material, [collected[i]]);
    }

    const parts: BakedPart[] = [];
    for (const [material, geometries] of byMaterial) {
      const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries);
      if (merged === null) {
        // `mergeGeometries` refuses mismatched attribute sets and says so on the
        // console. Ship the parts separately rather than dropping the model.
        for (const geometry of geometries) parts.push(this.adopt(geometry, material));
        continue;
      }
      if (merged !== geometries[0]) {
        // Never uploaded, so this is bookkeeping rather than a GPU free.
        for (const geometry of geometries) geometry.dispose();
      }
      parts.push(this.adopt(merged, material));
    }
    return parts;
  }

  /** Takes ownership of a geometry this class created. */
  private adopt(geometry: THREE.BufferGeometry, material: THREE.Material): BakedPart {
    geometry.computeBoundingSphere();
    this.ownedGeometries.push(geometry);
    return { geometry, material };
  }

  /**
   * One `InstancedMesh` per material, sized for `capacity` instances. All of
   * them are driven by the same matrices, so a multi-material kind still places
   * as a single object.
   */
  private buildScatter(
    parts: BakedPart[],
    capacity: number,
    name: string,
  ): THREE.InstancedMesh[] | null {
    if (parts.length === 0 || capacity <= 0) return null;
    return parts.map((part, index) => {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, capacity);
      mesh.name = parts.length === 1 ? name : `${name}-${index}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      return mesh;
    });
  }

  /** A one-off prop: one mesh per material under a single group. */
  private buildStatic(parts: BakedPart[], name: string): THREE.Group | null {
    if (parts.length === 0) return null;
    const group = new THREE.Group();
    group.name = name;
    for (let i = 0; i < parts.length; i++) {
      const mesh = new THREE.Mesh(parts[i].geometry, parts[i].material);
      mesh.name = `${name}-${i}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      group.add(mesh);
    }
    return group;
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
    const meshes = this.buildScatter(this.bakeParts(source), count, name);
    return meshes === null ? null : meshes[0];
  }
}

interface LoadedSources {
  buoy: THREE.Group;
  barrel: THREE.Group;
  rock: THREE.Group;
  cliff: THREE.Group;
}

// ------------------------------------------------------------------- helpers

const spinQuaternion = new THREE.Quaternion();
const leanQuaternion = new THREE.Quaternion();
const leanEuler = new THREE.Euler();
const seatNormal = new THREE.Vector3();

/** Yaw that turns a model's +Z axis toward the world direction (dx, dz). */
function yawAlignZ(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

/**
 * A rotation about `axis`, in shared scratch.
 *
 * The result is only valid until the next call. That is safe here and only here:
 * every caller is construction-time, single-threaded, and consumes the value
 * before asking for another.
 */
function spinAbout(axis: THREE.Vector3, angle: number): THREE.Quaternion {
  return spinQuaternion.setFromAxisAngle(axis, angle);
}

function randomLean(random: () => number, amount: number): THREE.Quaternion {
  leanEuler.set((random() - 0.5) * amount, 0, (random() - 0.5) * amount);
  return leanQuaternion.setFromEuler(leanEuler);
}

/**
 * Surface normal of the seafloor heightfield at (x, z), from a central
 * difference `span` metres wide.
 *
 * The width is a parameter because it decides what "the ground" means for the
 * thing being seated: a shell wants the centimetre it sits on, a sixty-metre
 * rock shelf wants the average across its whole footprint, and using one span
 * for both drives one end of the shelf underground.
 */
function groundNormal(x: number, z: number, span: number, out: THREE.Vector3): THREE.Vector3 {
  const dx = (seafloorHeight(x + span, z) - seafloorHeight(x - span, z)) / (2 * span);
  const dz = (seafloorHeight(x, z + span) - seafloorHeight(x, z - span)) / (2 * span);
  return out.set(-dx, 1, -dz).normalize();
}

/** Fills `out` with (x, ground height, z). */
function groundPoint(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(x, seafloorHeight(x, z), z);
}

/**
 * A point on the cove's shore, given a radius from the island centre and a
 * distance along the shore from the cove's bearing. Returns the bearing of the
 * point itself, which is what the props are turned against.
 */
function covePoint(radius: number, alongShore: number, out: THREE.Vector3): number {
  const bearing = COVE_BEARING + alongShore / radius;
  groundPoint(ISLAND.x + Math.cos(bearing) * radius, ISLAND.z + Math.sin(bearing) * radius, out);
  return bearing;
}

/** Seats a one-off prop on the ground at `point`, tilted toward the local slope. */
function seatOnGround(
  object: THREE.Object3D,
  point: THREE.Vector3,
  yaw: number,
  slope: number,
  span: number,
): void {
  object.position.copy(point);
  groundNormal(point.x, point.z, span, seatNormal);
  if (slope < 1) seatNormal.lerp(UP, 1 - slope).normalize();
  object.quaternion.setFromUnitVectors(UP, seatNormal);
  object.quaternion.multiply(spinAbout(UP, yaw));
}

/** Turns off shadow participation for a whole subtree. */
function clearShadowFlags(node: THREE.Object3D): void {
  const mesh = node as THREE.Mesh;
  if (!mesh.isMesh) return;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
}

/** Translation that moves a box to sit centred on the origin with its base at y = 0. */
function recentreShift(box: THREE.Box3, out: THREE.Vector3): THREE.Vector3 {
  return out.set(-(box.min.x + box.max.x) * 0.5, -box.min.y, -(box.min.z + box.max.z) * 0.5);
}

/** True if a candidate point clears the spec's elevation and slope bands. */
function acceptPoint(x: number, z: number, spec: ScatterSpec, out: THREE.Vector3): boolean {
  const y = seafloorHeight(x, z);
  if (y < spec.minHeight || y > spec.maxHeight) return false;
  if (spec.maxSlope !== undefined) {
    groundNormal(x, z, spec.slopeSpan ?? 6, seatNormal);
    if (Math.hypot(seatNormal.x, seatNormal.z) / seatNormal.y > spec.maxSlope) return false;
  }
  out.set(x, y, z);
  return true;
}

/**
 * Draws a point on the island inside the spec's bands, or returns false.
 *
 * The radius is uniform rather than square-rooted, which on a disc means the
 * density falls off with distance from the centre — the "thins out toward the
 * shore" the dressing wants, for no extra work.
 */
function pickIslandPoint(
  random: () => number,
  spec: ScatterSpec,
  out: THREE.Vector3,
): boolean {
  const spread = spec.spread ?? Math.PI;
  const base = spec.bearing ?? 0;
  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
    const angle = base + (spec.bearing === undefined ? random() * TAU : (random() * 2 - 1) * spread);
    const radius = spec.minRadius + random() * (spec.maxRadius - spec.minRadius);
    if (acceptPoint(ISLAND.x + Math.cos(angle) * radius, ISLAND.z + Math.sin(angle) * radius, spec, out)) {
      return true;
    }
  }
  return false;
}

/** As `pickIslandPoint`, but drawn from a disc around one clump centre. */
function pickClusterPoint(
  random: () => number,
  spec: ScatterSpec,
  clusters: number[],
  index: number,
  clusterRadius: number,
  out: THREE.Vector3,
): boolean {
  const cx = clusters[index];
  const cz = clusters[index + 1];
  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
    const angle = random() * TAU;
    const radius = Math.sqrt(random()) * clusterRadius;
    if (acceptPoint(cx + Math.cos(angle) * radius, cz + Math.sin(angle) * radius, spec, out)) {
      return true;
    }
  }
  return false;
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
