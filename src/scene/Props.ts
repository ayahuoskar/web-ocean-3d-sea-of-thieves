import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AssetLoader } from './AssetLoader';
import { ISLAND, seafloorHeight } from './Seafloor';
import { SEEDS, mulberry32 } from '../core/random';

/**
 * Scene dressing: floating props near the play area, the island that sits on the
 * horizon, and the authored set pieces on it — a pirate cove on the leeward
 * shore, a ruined shore fort on the headland above it, and a wreck's worth of
 * cargo on the reef.
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
 *    Authored one-offs — the jetty, the pinnace, the fort, the chest — are plain
 *    meshes; there is exactly one of each and instancing them would only add
 *    indirection.
 *  - **Everything on land is seated on `seafloorHeight`.** The island is a
 *    heightfield, not a plane, and it is the same function the floor mesh is
 *    built from. Placing by radius alone put props two metres in the air on one
 *    bearing and two metres underground on the next.
 *  - **Nothing is placed at an absolute radius.** The scatter bands are
 *    fractions of `ISLAND.radius` and the set pieces are offsets from a
 *    shoreline this file *finds* with `shorelineRadius`. Everything here was
 *    once written in metres against a 260 m island whose shore was a circle at
 *    150 m; when `Seafloor` was reshaped, every one of those numbers became
 *    wrong at once and the whole cove ended up 350 m inland. Fractions and
 *    elevation bands survive that; metres do not.
 *  - **Orientation comes from the terrain, never from the island centre.** See
 *    `contourYaw`.
 *  - **Placement is seeded.** The scene must be identical on every load,
 *    otherwise reference comparison screenshots never match. The dressing draws
 *    from its *own* stream (see `DRESSING_SEED_MIX`) so that adding or removing
 *    a plant kind cannot reshuffle the floaters, the island rocks or the reef.
 *
 * On scale: the island is ~1.4 km from the origin and now covers about 0.8 km²
 * of land rising to 73 m, four times the area the old dome had. Most of it is
 * still a silhouette from the play area, so the budget goes on the things that
 * survive that distance — coastal cliffs, wave-cut shelves, and canopy tall
 * enough to break the skyline — and the understorey exists for the fly camera
 * rather than the horizon, which is why the detail scale thins it hardest.
 */

const BUOY_URL = '/models/ocean_buoy/ocean_buoy_1k.gltf';
const BARREL_URL = '/models/barrel_03/barrel_03_1k.gltf';
const ROCK_URL = '/models/rock_07/rock_07_1k.gltf';
const CLIFF_URL = '/models/namaqualand_cliff_01/namaqualand_cliff_01_1k.gltf';

/** Scene-dressing library. Every entry is optional: a 404 thins the scene. */
const DRESSING_URLS = {
  coastalCliff: '/models/dressing/coastal_cliff_02.glb',
  coastalRampart: '/models/dressing/coastal_cliff_04.glb',
  coastLineWide: '/models/dressing/coast_line_01.glb',
  coastLineNarrow: '/models/dressing/coast_line_02.glb',
  coastRocksWide: '/models/dressing/coast_rocks_01.glb',
  coastRocksTall: '/models/dressing/coast_rocks_03.glb',
  landRocks: '/models/dressing/coast_land_rocks_03.glb',
  sandRocks: '/models/dressing/sand_rocks_small_01.glb',
  tree: '/models/dressing/island_tree_01.glb',
  treeMid: '/models/dressing/island_tree_02.glb',
  treeWind: '/models/dressing/island_tree_03.glb',
  jacaranda: '/models/dressing/jacaranda_tree.glb',
  pachira: '/models/dressing/pachira_aquatica_01.glb',
  fern: '/models/dressing/fern_02.glb',
  sorrel: '/models/dressing/shrub_sorrel_01.glb',
  grass: '/models/dressing/grass_bermuda_01.glb',
  anthurium: '/models/dressing/anthurium_botany_01.glb',
  calathea: '/models/dressing/calathea_orbifolia_01.glb',
  pinnace: '/models/dressing/ship_pinnace.glb',
  pier: '/models/dressing/modular_wooden_pier.glb',
  fort: '/models/dressing/modular_fort_01.glb',
  cannon: '/models/dressing/cannon_01.glb',
  barrels: '/models/dressing/wooden_barrels_01.glb',
  lantern: '/models/dressing/wooden_lantern_01.glb',
  coveCrate: '/models/dressing/wooden_crate_02.glb',
  bucket: '/models/dressing/wooden_bucket_01.glb',
  jug: '/models/dressing/jug_01.glb',
  estoc: '/models/dressing/antique_estoc.glb',
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
 * metry assets are decimated LOD0 scans — a canopy tree is ~34k triangles, the
 * long rampart cliff is 92k — so a count here is worth ~30-90k triangles, and
 * the number that makes the island read is a lot smaller than the number that
 * would make it look dense from ten metres away.
 *
 * They went up across the board when the island did. On the old 260 m dome nine
 * trees covered the whole of it; on 0.8 km² of land the same nine read as a bare
 * rock with a few sticks on it, which is the failure these counts exist to fix.
 * Rock is the expensive half and it went up least: a coastline 3.4 km long can
 * never be *covered* by 40 m scans, so the coast kinds are accents chosen for
 * where they land, not for how much of the shore they fill.
 */
const COASTAL_CLIFF_COUNT = 6;
const COASTAL_RAMPART_COUNT = 3;
const COAST_LINE_WIDE_COUNT = 4;
const COAST_LINE_NARROW_COUNT = 4;
const COAST_ROCKS_WIDE_COUNT = 4;
const COAST_ROCKS_TALL_COUNT = 4;
const LAND_ROCKS_COUNT = 4;
const SAND_ROCKS_COUNT = 4;
/**
 * Planting density, and these numbers are the difference between an island and
 * a sandbank.
 *
 * The first pass at the enlarged island scaled the old counts by about 2.3x on
 * 4x the land area, which is a *thinning* — and an aerial capture showed exactly
 * that: a white dome with objects sprinkled on it. Canopy has to close over the
 * interior for the island to read as vegetated at all, because what a viewer
 * registers from a mile out is the ratio of green to sand and nothing else.
 *
 * These are per-kind capacities, thinned by `propsDetail` — 0.3 at Low — so the
 * high-water mark is what Ultra and Max draw and the lower tiers keep the shape
 * and lose the density. The reef, at 90 instances of a 15k-triangle rock, is
 * still the largest single cost in this file; the entire canopy is less.
 */
const JACARANDA_COUNT = 14;
const TREE_COUNT = 46;
const TREE_MID_COUNT = 44;
const TREE_WIND_COUNT = 26;
const PACHIRA_COUNT = 40;
const ANTHURIUM_COUNT = 70;
const CALATHEA_COUNT = 84;
const FERN_COUNT = 110;
const SORREL_COUNT = 130;
const GRASS_COUNT = 620;
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

/**
 * Rejected samples per instance before a scatter gives up on that instance.
 *
 * Raised from 24 when the bands became elevation-led. The tightest of them is
 * the waterline strip the `coast_line` shelves want, which is about a tenth of
 * the annulus they are drawn from; at 24 attempts one shelf in five never
 * placed, and a kind with four instances cannot afford to lose one. Placement
 * runs once at load, so the cost of the extra attempts is unmeasurable.
 */
const PLACEMENT_ATTEMPTS = 40;

/**
 * Fraction of an instanced kind that survives however low the detail scale
 * goes. A kind that thins to nothing changes the island's shape rather than its
 * density, which is the one thing the detail scale must not do.
 */
const DETAIL_FLOOR = 0.25;

// ------------------------------------------------------- terrain-derived yaw

/**
 * Gradient below which "downhill" stops meaning anything and `contourYaw` hands
 * back to the random draw. A tenth of a percent of grade is half a metre over
 * the length of the longest cliff slab, which is noise.
 */
const CONTOUR_MIN_GRADE = 1e-3;
/** Peak random yaw laid on top of a contour-derived facing, radians. */
const CONTOUR_JITTER = 0.3;

// ------------------------------------------------------------------ the cove

/**
 * Bearing of the cove from the island centre, radians in the same convention as
 * the scatter code (x = cos, z = sin).
 *
 * `Seafloor` puts its lagoon sector on this bearing and keeps it navigable, so
 * the two files have to agree on the number. The default wind blows toward
 * +x/+z (`Spectrum` defaults to pi/4), so this face is the lee — the only shore
 * of the island where a boat could be left on a mooring. It also happens to be
 * the face that looks back at the play area, which is what makes the cove worth
 * building at all.
 */
const COVE_BEARING = 0.7;

/**
 * Bearing of the headland from the island centre.
 *
 * `Seafloor` pushes the shore out and raises a ridge on this bearing, giving the
 * one genuinely exposed piece of ground on the island — which is why the
 * wind-shorn planting is confined to an arc about it. Written out here rather
 * than exported from `Seafloor` because it is art direction on this side of the
 * fence: `Props` is choosing where the wind gets to matter, not reading a fact
 * about the terrain.
 */
const HEADLAND_BEARING = 1.45;

/**
 * Everything in the cove is placed as metres from the *waterline on the cove's
 * bearing*, which `shorelineRadius` finds by asking the heightfield. Positive is
 * seaward.
 *
 * These were radii from the island centre — `JETTY_RADIUS = 159` and so on —
 * back when the shore on this bearing was a circle at 150 m. It is now at 501 m
 * and it is not a circle, so those numbers put the whole cove a third of the way
 * up the hill. An offset from the water cannot go wrong that way: the shore can
 * move anywhere it likes and the jetty follows it.
 */
const JETTY_OFFSHORE = 5;
const JETTY_SCALE = 1.5;
/** Deck height above mean sea level, metres. */
const JETTY_DECK_Y = 2.1;
/** Deck surface in the pier model's own units, for seating things on it. */
const PIER_DECK_LOCAL = 2.67;

const PINNACE_OFFSHORE = -7;
const PINNACE_ALONGSHORE = -30;
const PINNACE_SCALE = 0.55;
/** Metres the hull is lifted off the sand, so the keel bites rather than floats. */
const PINNACE_KEEL_LIFT = 1.05;
const PINNACE_HEEL = 0.17;
/**
 * Bow-up trim, radians. Negative pitches the bow up in a YXZ rotation.
 *
 * This is the beach gradient and nothing else, so it moved when the beach did:
 * the cove now falls about a tenth of a metre per metre instead of a fifth, and
 * the hull lies mostly *along* the beach rather than up it, which leaves about a
 * twentieth of grade under the keel. At the old -0.09 the boat was correcting
 * for twice the slope it is actually sitting on and stood on its stern.
 */
const PINNACE_TRIM = -0.05;

/**
 * The camp, on the dry beach above the swash. `Seafloor` washes the sand within
 * ~3 m of sea level, and the beach here falls about a metre per ten, so this is
 * the first stretch that is dry ground rather than wet sand.
 */
const CAMP_OFFSHORE = -46;

/**
 * The sword. The scan stands point *up* with its pommel 0.2 m below the origin,
 * so it is turned over before it is planted — hence the pi in the rotation and
 * `ESTOC_POINT`, which is where the tip ends up once it has been.
 *
 * Thrust into the sand rather than laid on it. A sword lying flat on a beach is
 * a 4 cm silhouette from any camera higher than the dune line; standing, it
 * casts a shadow across the sand and reads from the water.
 */
const ESTOC_SCALE = 1.15;
const ESTOC_LEAN = 0.3;
/** Model-space metres from the origin to the point, at unit scale. */
const ESTOC_POINT = 1.29;
/** Metres of blade buried. */
const ESTOC_BURY = 0.35;

/**
 * The three jugs, in the group's own frame, world metres.
 *
 * Two upright and one on its side, which is the whole difference between "a
 * camp" and "three jugs left in a row". The tipped one's `y` rests it on its
 * shoulder: a couple of centimetres of it buried in the sand is invisible, and a
 * couple of centimetres floating is not.
 */
const JUG_PIECES: readonly KitPiece[] = [
  { x: 0, z: 0, yaw: 0.4, scale: 2.2 },
  { x: 0.62, z: 0.38, yaw: 2.1, scale: 2.2 },
  { x: -0.3, y: 0.14, z: 0.66, yaw: 5, tilt: 1.45, scale: 2.2 },
];

// ------------------------------------------------------------- the shore fort

/**
 * The fort sits on the headland's tableland, which `Seafloor` holds at ~35 m out
 * to 550 m before dropping it 22 m into a bluff.
 *
 * Bearing and inset were chosen against the heightfield rather than by eye: over
 * a 44 x 32 m footprint here the ground varies by half a metre, and masonry is
 * built level. Anywhere nearer the brow the same footprint spans five metres of
 * fall, which no amount of sinking makes look like a wall rather than a
 * landslide.
 */
const FORT_BEARING = 1.35;
/** Metres back from the waterline, as a fraction of `ISLAND.radius`. */
const FORT_INSET = 0.34;
/** Metres the whole assembly is pushed into the ground, to bury the half-metre. */
const FORT_SINK = 0.8;
/**
 * How far offshore of the cove's beach the fort is laid.
 *
 * A shore battery is laid on the channel a ship has to cross, not on the open
 * sea, so the fort is turned to face a point out in the lagoon rather than
 * turned to face outward. That works out almost exactly alongshore, which is
 * also what puts its wall face toward the play area instead of its back.
 */
const FORT_AIM_OFFSHORE = 90;

/**
 * The fort as built, in its own frame: +Z toward the water it commands, +X to
 * the right of that, y = 0 at the ground.
 *
 * The asset is a *kit* — twenty-two wall, tower and walkway pieces laid out side
 * by side in the source file, not an assembled fort — so something has to
 * assemble it, and `assemble` is that something.
 *
 * Ruined on purpose, and the ruin is what makes the kit usable: the corner
 * pieces would have to meet their neighbours to within a few centimetres to
 * close a wall, and nothing here knows which quadrant a given corner turns. A
 * broken curtain wall with a breach in it needs no piece to meet any other.
 */
const FORT_PIECES = [
  // The seaward tower, on the flank nearest the cove: 15.8 m across and 13.4 m
  // tall, so it is the piece that carries the fort from the play area. Spans
  // x +7.5..+23.3.
  { node: 'modular_fort_01_tower_round', x: 15.4, z: 6.5 },
  // Curtain wall across the front. The sections are authored running along
  // their own Z, so each is turned a quarter turn to lie along the face. The
  // two of them span x -26.3..+1.3, which leaves 6 m of nothing between the
  // wall and the tower: the breach, and the reason the gun has a field of fire.
  { node: 'modular_fort_01_wall_thick_straight_01', x: -4.4, z: 10, yaw: Math.PI / 2 },
  { node: 'modular_fort_01_wall_thick_straight_02', x: -19, z: 10, yaw: Math.PI / 2 },
  // The broken end, settled and tipped along its own length: where the wall
  // stops rather than where it was built to stop.
  { node: 'modular_fort_01_wall_thick_end_02', x: -28.7, z: 10, y: -0.5, yaw: Math.PI / 2, tilt: 0.08 },
  // Landward flank and its gate, returning inland from that end. Subsiding
  // slightly, which is the cheapest legible difference between a ruin and a
  // building site.
  { node: 'modular_fort_01_wall_thin_straight_02', x: -29, z: 1, tilt: 0.05 },
  { node: 'modular_fort_01_wall_thin_gate_01', x: -29, z: -10.1 },
  // Inside: the stair up to the fighting step, and the step itself behind the
  // curtain. Without them the wall reads as a fence.
  { node: 'modular_fort_01_wall_stairs_straight_01', x: -22, z: 0 },
  { node: 'modular_fort_01_wall_walkway_straight_01', x: -4.4, z: 6.2, yaw: Math.PI / 2 },
] as const;

/**
 * The gun, in the fort's frame: laid in the breach between the end of the
 * curtain wall (which stops at x = +1.3) and the tower (which starts at +7.5).
 *
 * Parented to the fort rather than placed in world space, for the same reason
 * the lantern is parented to the jetty — a gun in a breach is *in* the breach,
 * and moving the fort must not leave it standing in open grass. The local y
 * undoes `FORT_SINK`, so the carriage sits on the ground the walls are dug into.
 */
const CANNON_LOCAL = { x: 4.4, z: 9.5, yaw: 0.18 } as const;
const CANNON_SCALE = 1.7;

/** Centre of the underwater find, world metres. A local high on the plateau. */
const FIND = { x: -38, z: -66 } as const;
/** Radius the shells scatter over, around the chest. */
const FIND_SPREAD = 13;

const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;

/**
 * Bracket `shorelineRadius` bisects in, as fractions of `ISLAND.radius`.
 *
 * The shore fraction `Seafloor` computes runs from 0.72 at the head of the bay
 * to 1.30 at the tip of the headland, so this brackets the lot with room either
 * side; the inner end has to stay dry land and the outer end has to stay water
 * on every bearing this is asked about.
 */
const SHORE_SEARCH_IN = 0.4;
const SHORE_SEARCH_OUT = 1.7;
/** Halvings. 24 resolves the waterline to well under a millimetre. */
const SHORE_SEARCH_STEPS = 24;

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

/** One placed copy of a source node inside an assembled set piece. */
interface KitPiece {
  /** Node to take from the source. Omitted takes the whole model. */
  node?: string;
  /** Position in the assembly's own frame, world metres; y = 0 is the base. */
  x: number;
  y?: number;
  z: number;
  /** Yaw about the assembly's up axis, radians. */
  yaw?: number;
  /**
   * Tip about the piece's *own* X axis, applied before the yaw — so a wall
   * leans along its own length and a jug rolls onto its side. What makes a
   * ruin read as a ruin rather than as a building site.
   */
  tilt?: number;
  scale?: number;
}

/** How one model kind scatters across the island. */
interface ScatterSpec {
  /**
   * Radial band the sampler draws from, as a fraction of `ISLAND.radius`.
   *
   * Fractions, and named `inner`/`outer` rather than `minRadius`/`maxRadius`, so
   * that no metre value from the old island could survive the change unnoticed
   * — every one of them was silently wrong once the shore moved from 150 m to
   * 501 m. The band is only a *sampler* hint: it exists to keep rejection
   * sampling converging, and the elevation band below is what actually decides
   * where a kind lives.
   */
  inner: number;
  outer: number;
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
  /** Where the model's long axis points. */
  facing?: 'random' | 'contour';
  /** Number of clumps to gather the instances into; 0 scatters evenly. */
  clusters?: number;
  /** Radius of one clump, metres. */
  clusterRadius?: number;
  /**
   * Whether this kind casts a shadow. Receiving is always on — it is a term in
   * a shader the object already runs — but casting means drawing the kind a
   * second time into the depth map, which is not worth it for ground cover.
   */
  casts?: boolean;
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
    this.placeFort(dressing);
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
      // Settled, not `all`. The dressing is thirty independent files and no one
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
   * above it that grades from bare sand through scrub to closed canopy inland.
   *
   * The elevation bands do the art direction, and they are the part of this that
   * survived the island being reshaped. Nothing is placed by radius alone
   * because the shoreline is not a circle and never was going to stay where it
   * was — the coastal kinds ask for ground between roughly -5 m and +4 m and
   * land wherever that happens to be, which is what puts rock exactly where the
   * water meets the island instead of on a ring that only approximately follows
   * it.
   *
   * Species vary by elevation and by exposure, which between them are the whole
   * of the planting scheme:
   *
   *  - **0-2 m** nothing. Bare sand and the swash band, which is what makes the
   *    beach read as a beach rather than as lawn that stops at the water.
   *  - **2-14 m** pachira on the fringe, grass and sorrel, the first ferns.
   *  - **6-30 m** the closed canopy: the two broadleaf trees, with the jacaranda's
   *    broad crown held to sheltered ground under a fifth grade — a crown that
   *    wide on a ridge would be shredded, and a scan that big on a slope reads
   *    as a mushroom sitting on the hill.
   *  - **10-52 m** the smaller broadleaf carries the mid slopes and the ridge.
   *  - **the headland arc, any height** the wind-shorn kind: smaller, squashed
   *    below its natural proportions, leaning hard, and scattered singly rather
   *    than in groves, because the exposed point is the one part of the island
   *    where trees do not shelter each other.
   *
   * Density falls off toward the shore for free: the radial sample is uniform in
   * *radius*, so on a disc it concentrates inland, and the planting's minimum
   * height then cuts off the last stretch of beach entirely.
   */
  private dressIsland(dressing: Dressing, random: () => number): void {
    const island = new THREE.Group();
    island.name = 'island-dressing';
    this.object.add(island);

    // Two cliff silhouettes, not one. Six copies of a single 41 m slab was half
    // the reason the old coast read as a stage flat; the 87 m rampart breaks the
    // repeat at a completely different scale, and `contourYaw` flips half of
    // every kind end-for-end so even one model shows two profiles.
    this.scatter(island, dressing.coastalCliff, COASTAL_CLIFF_COUNT, 'island-coastal-cliffs', random, {
      inner: 0.6,
      outer: 1.36,
      minHeight: 1,
      maxHeight: 24,
      minScale: 1,
      maxScale: 1.8,
      minStretch: 0.85,
      maxStretch: 1.3,
      sink: 3.2,
      // High, and deliberately so. At the old 0.35 the slabs stayed near-vertical
      // whatever they were standing on, so a slab on the beach gradient buried
      // one end and floated the other by two metres over its length.
      slope: 0.75,
      slopeSpan: 24,
      facing: 'contour',
    });

    // The long rampart. A 24 m sample span, which is about a third of its own
    // length: any narrower and it is levelled against a boulder rather than
    // against the headland it is supposed to be part of.
    this.scatter(island, dressing.coastalRampart, COASTAL_RAMPART_COUNT, 'island-ramparts', random, {
      inner: 0.55,
      outer: 1.3,
      minHeight: 2,
      maxHeight: 30,
      minScale: 0.8,
      maxScale: 1.25,
      minStretch: 0.9,
      maxStretch: 1.35,
      sink: 3.5,
      slope: 0.8,
      slopeSpan: 40,
      facing: 'contour',
    });

    // Shoreline edges. These two are authored as coast rather than as rock: a
    // wave-cut platform with a lip, so they only make sense lying *on* the
    // waterline contour, which is why their elevation band is the tightest here
    // and why they take the contour facing rather than a random spin.
    this.scatter(island, dressing.coastLineWide, COAST_LINE_WIDE_COUNT, 'island-coast-line-wide', random, {
      inner: 0.7,
      outer: 1.36,
      minHeight: -3,
      maxHeight: 2,
      minScale: 0.7,
      maxScale: 1.15,
      sink: 0.6,
      slope: 0.9,
      slopeSpan: 26,
      facing: 'contour',
    });

    this.scatter(island, dressing.coastLineNarrow, COAST_LINE_NARROW_COUNT, 'island-coast-line-narrow', random, {
      inner: 0.7,
      outer: 1.36,
      minHeight: -3,
      maxHeight: 2,
      minScale: 0.8,
      maxScale: 1.3,
      sink: 0.5,
      slope: 0.9,
      slopeSpan: 20,
      facing: 'contour',
    });

    // Wave-cut platforms. Both coast rock scans are wide and flat with their
    // origin buried inside the mass, so they need a wide terrain sample to tilt
    // against: a 60 m shelf levelled from a 6 m sample drives one edge metres
    // into the ground on a slope this gentle.
    this.scatter(island, dressing.coastRocksWide, COAST_ROCKS_WIDE_COUNT, 'island-coast-rocks-wide', random, {
      inner: 0.66,
      outer: 1.42,
      // Floor of the band is set by the model, not by taste: these shelves are
      // only ~1.3 m proud of their own origin, so ground below about -5 m puts
      // a 40k-triangle scan entirely out of sight under the water.
      minHeight: -5,
      maxHeight: 3,
      minScale: 0.7,
      maxScale: 1.15,
      sink: 0.35,
      slope: 0.85,
      slopeSpan: 26,
    });

    this.scatter(island, dressing.coastRocksTall, COAST_ROCKS_TALL_COUNT, 'island-coast-rocks-tall', random, {
      inner: 0.66,
      outer: 1.42,
      minHeight: -5,
      maxHeight: 4,
      minScale: 0.9,
      maxScale: 1.6,
      sink: 0.4,
      slope: 0.85,
      slopeSpan: 13,
    });

    // Boulder fields above the tideline, in clumps. Loose rock does not arrive
    // one stone at a time; it arrives where something above it gave way.
    this.scatter(island, dressing.landRocks, LAND_ROCKS_COUNT, 'island-land-rocks', random, {
      inner: 0.55,
      outer: 1.36,
      minHeight: 2,
      maxHeight: 16,
      minScale: 1.4,
      maxScale: 2.6,
      sink: 0.25,
      slope: 0.9,
      slopeSpan: 8,
      clusters: 3,
      clusterRadius: ISLAND.radius * 0.09,
    });

    // Beach rubble, confined to the cove's arc. This scan is 74k triangles for
    // something four metres across: from the play area it is one pixel, so the
    // only place it earns its cost is the stretch of beach the cove gives a
    // reason to fly to.
    this.scatter(island, dressing.sandRocks, SAND_ROCKS_COUNT, 'island-sand-rocks', random, {
      inner: 0.8,
      outer: 1.1,
      minHeight: 0,
      maxHeight: 5,
      bearing: COVE_BEARING,
      spread: 0.3,
      minScale: 1.6,
      maxScale: 3,
      sink: 0.08,
      slope: 1,
      slopeSpan: 5,
    });

    // The biggest crowns, in two groves on sheltered ground. Only four of them:
    // this scan is 45k triangles and 19 m across at unit scale, so it is worth
    // having where it can be the thing that gives the canopy a top and worth
    // nothing at all repeated across a hillside.
    this.scatter(island, dressing.jacaranda, JACARANDA_COUNT, 'island-jacaranda', random, {
      inner: 0.25,
      outer: 1.15,
      minHeight: 6,
      maxHeight: 26,
      maxSlope: 0.22,
      minScale: 0.55,
      maxScale: 0.95,
      minStretch: 0.9,
      maxStretch: 1.1,
      sink: 0.2,
      slope: 0.15,
      slopeSpan: 24,
      lean: 0.04,
      clusters: 2,
      clusterRadius: ISLAND.radius * 0.16,
    });

    // Trees in groves rather than an even scatter. Evenly spaced trees read as
    // an orchard from any distance; clumps read as vegetation, and at 1.4 km the
    // clumping is most of what is left of them. The grove radius is a fraction
    // of the island rather than a fixed 45 m, or the same five groves would
    // cover a quarter of the ground they used to.
    this.scatter(island, dressing.tree, TREE_COUNT, 'island-trees', random, {
      inner: 0.1,
      outer: 1.25,
      minHeight: 6,
      maxHeight: 42,
      maxSlope: 0.4,
      minScale: 2,
      maxScale: 3.4,
      minStretch: 0.9,
      maxStretch: 1.2,
      sink: 0.1,
      slope: 0.25,
      slopeSpan: 12,
      lean: 0.06,
      clusters: 5,
      clusterRadius: ISLAND.radius * 0.18,
    });

    this.scatter(island, dressing.treeMid, TREE_MID_COUNT, 'island-trees-mid', random, {
      inner: 0.05,
      outer: 1.15,
      minHeight: 10,
      maxHeight: 52,
      minScale: 2.2,
      maxScale: 3.6,
      minStretch: 0.9,
      maxStretch: 1.15,
      sink: 0.08,
      slope: 0.25,
      slopeSpan: 10,
      lean: 0.08,
      clusters: 5,
      clusterRadius: ISLAND.radius * 0.15,
    });

    // The exposed headland. Held under its natural proportions by the stretch
    // range and leaned four times as hard as anything in the interior, because
    // the difference between a sheltered tree and an exposed one is a shape, not
    // a species — and scattered singly, since there are no groves out here to
    // shelter each other.
    this.scatter(island, dressing.treeWind, TREE_WIND_COUNT, 'island-trees-wind', random, {
      inner: 0.6,
      outer: 1.3,
      minHeight: 6,
      maxHeight: 38,
      bearing: HEADLAND_BEARING,
      spread: 0.52,
      minScale: 1.5,
      maxScale: 2.4,
      minStretch: 0.7,
      maxStretch: 0.95,
      sink: 0.1,
      slope: 0.4,
      slopeSpan: 8,
      lean: 0.16,
    });

    // The pachira ships as four plants laid out in a row; `_d` is the tallest of
    // them, and taking one variant rather than the row is what keeps this to a
    // single instanced clump instead of four plants marching sideways. Held to
    // the low fringe: the species is a swamp tree, and it is what turns the join
    // between beach and canopy into a gradient.
    this.scatter(island, dressing.pachira, PACHIRA_COUNT, 'island-pachira', random, {
      inner: 0.55,
      outer: 1.3,
      minHeight: 2.5,
      maxHeight: 14,
      minScale: 2.2,
      maxScale: 3.8,
      sink: 0.05,
      slope: 0.2,
      slopeSpan: 7,
      lean: 0.08,
      clusters: 4,
      clusterRadius: ISLAND.radius * 0.09,
      bake: { include: (name) => name.endsWith('_d'), origin: 'cluster' },
    });

    // Understorey. Everything below here only *receives* shadow: it lives under
    // the canopy, where the light is already the canopy's shadow, and drawing a
    // few thousand leaf cards a second time into the depth map buys a contact
    // shadow nobody will ever be close enough to see.
    this.scatter(island, dressing.anthurium, ANTHURIUM_COUNT, 'island-anthurium', random, {
      inner: 0.1,
      outer: 1.22,
      minHeight: 4,
      maxHeight: 36,
      maxSlope: 0.3,
      minScale: 1.8,
      maxScale: 3.2,
      slope: 0.3,
      slopeSpan: 8,
      lean: 0.1,
      clusters: 5,
      clusterRadius: ISLAND.radius * 0.07,
      casts: false,
      bake: { include: (name) => name.endsWith('_a'), origin: 'cluster' },
    });

    this.scatter(island, dressing.calathea, CALATHEA_COUNT, 'island-calathea', random, {
      inner: 0.1,
      outer: 1.22,
      minHeight: 4,
      maxHeight: 32,
      maxSlope: 0.3,
      minScale: 2.2,
      maxScale: 3.8,
      slope: 0.3,
      slopeSpan: 8,
      lean: 0.1,
      clusters: 6,
      clusterRadius: ISLAND.radius * 0.07,
      casts: false,
      bake: { include: (name) => name.endsWith('_a'), origin: 'cluster' },
    });

    this.scatter(island, dressing.fern, FERN_COUNT, 'island-ferns', random, {
      inner: 0.08,
      outer: 1.28,
      minHeight: 3,
      maxHeight: 44,
      minScale: 2.4,
      maxScale: 4.2,
      slope: 0.35,
      slopeSpan: 6,
      lean: 0.12,
      clusters: 7,
      clusterRadius: ISLAND.radius * 0.07,
      casts: false,
      bake: { include: (name) => name.endsWith('_b'), origin: 'cluster' },
    });

    this.scatter(island, dressing.sorrel, SORREL_COUNT, 'island-sorrel', random, {
      inner: 0.08,
      outer: 1.28,
      minHeight: 3,
      maxHeight: 46,
      minScale: 7,
      maxScale: 14,
      slope: 0.4,
      slopeSpan: 5,
      lean: 0.12,
      clusters: 7,
      clusterRadius: ISLAND.radius * 0.06,
      casts: false,
      bake: { include: (name) => name.endsWith('_d'), origin: 'cluster' },
    });

    // Grass is the one kind with a slope test. It is also the one kind whose
    // source file is a row of twenty-one separate blades: stacking the medium
    // and seedling variants on a common origin turns that row into a tuft, and
    // merging them makes the tuft a single geometry and therefore a single draw.
    this.scatter(island, dressing.grass, GRASS_COUNT, 'island-grass', random, {
      inner: 0.05,
      outer: 1.3,
      minHeight: 2,
      maxHeight: 50,
      maxSlope: 0.18,
      minScale: 4,
      maxScale: 8,
      slope: 0.6,
      slopeSpan: 5,
      lean: 0.07,
      clusters: 10,
      clusterRadius: ISLAND.radius * 0.06,
      casts: false,
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
   * Every position here is a fixed offset from the waterline rather than a
   * random draw, because the point of the cluster is the relative arrangement —
   * jetty out into the water, boat beached beside it, camp up on the dry sand,
   * a sword dropped between the camp and the sea. Scattered to the same density
   * it would read as debris.
   *
   * The one thing that is *not* seated on the heightfield is the jetty. A jetty's
   * deck is level and its height is set by the water, not by the bank, so it is
   * placed at a fixed height above sea level and the terrain is left to meet it:
   * the landward posts bury themselves in the beach and the seaward ones stand
   * clear in about two metres of water, which is exactly what the model is for.
   *
   * The lagoon behind the jetty is 5.5 m deep out to 750 m and the entrance is
   * left clear, so a ship can still come in — which is the only reason the cove
   * is on this bearing at all.
   */
  private placeCove(dressing: Dressing): void {
    const cove = new THREE.Group();
    cove.name = 'pirate-cove';
    this.object.add(cove);

    const shore = shorelineRadius(COVE_BEARING);
    const point = new THREE.Vector3();

    const pier = this.buildStatic(this.bakeParts(dressing.pier), 'cove-jetty-deck');
    let jetty: THREE.Group | null = null;
    if (pier) {
      jetty = new THREE.Group();
      jetty.name = 'cove-jetty';
      const bearing = covePoint(shore + JETTY_OFFSHORE, 0, point);
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
      const bearing = covePoint(shore + PINNACE_OFFSHORE, PINNACE_ALONGSHORE, point);
      pinnace.position.set(point.x, point.y + PINNACE_KEEL_LIFT, point.z);
      // Run aground at a shallow angle rather than bow-on: mostly along the
      // beach, angled just enough inshore to look driven there.
      const bowX = -Math.cos(bearing) * 0.42 - Math.sin(bearing) * 0.91;
      const bowZ = -Math.sin(bearing) * 0.42 + Math.cos(bearing) * 0.91;
      // YXZ so the roll is about the model's own keel line and not about world Z
      // — the heel is what says "aground" rather than "moored", and the trim is
      // the beach gradient (see `PINNACE_TRIM`): a level ship on a shelving
      // beach buries its forefoot and floats its rudder.
      pinnace.rotation.set(PINNACE_TRIM, yawAlignZ(bowX, bowZ), PINNACE_HEEL, 'YXZ');
      pinnace.scale.setScalar(PINNACE_SCALE);
      cove.add(pinnace);
    }

    const barrels = this.buildStatic(this.bakeParts(dressing.barrels), 'cove-barrels');
    if (barrels) {
      covePoint(shore + CAMP_OFFSHORE, -12, point);
      seatOnGround(barrels, point, 2.4, 0.9, 5);
      barrels.scale.setScalar(1.35);
      cove.add(barrels);
    }

    const crate = this.buildStatic(this.bakeParts(dressing.coveCrate), 'cove-crate');
    if (crate) {
      covePoint(shore + CAMP_OFFSHORE + 6, -4, point);
      seatOnGround(crate, point, 0.55, 0.8, 4);
      crate.scale.setScalar(1.5);
      cove.add(crate);
    }

    const bucket = this.buildStatic(this.bakeParts(dressing.bucket), 'cove-bucket');
    if (bucket) {
      covePoint(shore + CAMP_OFFSHORE + 9, -18, point);
      seatOnGround(bucket, point, 1.9, 0.9, 3);
      bucket.scale.setScalar(1.8);
      cove.add(bucket);
    }

    // Three jugs, assembled into one geometry rather than placed as three props.
    // The model is a 21 cm pot: instancing it would cost a draw call to save
    // nothing, and three separate meshes would cost three. Baking them together
    // makes the whole group one draw and one bounding sphere, and lets the one
    // on its side be authored as a tilt rather than as a special case.
    const jugs = this.buildStatic(this.assemble(dressing.jug, JUG_PIECES), 'cove-jugs');
    if (jugs) {
      covePoint(shore + CAMP_OFFSHORE - 3, -7, point);
      seatOnGround(jugs, point, 1.2, 0.8, 3);
      cove.add(jugs);
    }

    const estoc = this.buildStatic(this.bakeParts(dressing.estoc), 'cove-estoc');
    if (estoc) {
      const bearing = covePoint(shore + CAMP_OFFSHORE + 14, 3, point);
      // Turned point-down (the pi) and then tilted back out of vertical, so the
      // lean is a lean rather than an overhang. YXZ puts the tilt in the yawed
      // frame, which is what makes the yaw decide *which way* it leans.
      estoc.rotation.set(Math.PI - ESTOC_LEAN, bearing + 1.9, 0, 'YXZ');
      estoc.position.set(
        point.x,
        point.y + ESTOC_POINT * ESTOC_SCALE * Math.cos(ESTOC_LEAN) - ESTOC_BURY,
        point.z,
      );
      estoc.scale.setScalar(ESTOC_SCALE);
      cove.add(estoc);
    }
  }

  // -------------------------------------------------------------- shore fort

  /**
   * The ruined fort on the headland, and the gun laid in its breach.
   *
   * It is the far half of the cove's story and it is placed to be read with it:
   * 300 m along the coast from the beach and 35 m above it, on the tableland
   * that ends in the bluff, facing the water a boat has to cross to reach the
   * jetty. The camp is what someone did last week; the fort is what was already
   * here.
   *
   * Seated level, not tilted to the ground. The site was picked because the
   * ground varies half a metre across the whole footprint, and `FORT_SINK`
   * swallows that — a fort that followed the terrain would read as subsidence
   * on a hillside rather than as masonry on a plateau.
   */
  private placeFort(dressing: Dressing): void {
    const walls = this.buildStatic(this.assemble(dressing.fort, FORT_PIECES), 'shore-fort-walls');
    const cannon = this.buildStatic(this.bakeParts(dressing.cannon), 'shore-fort-cannon');
    if (!walls && !cannon) return;

    const fort = new THREE.Group();
    fort.name = 'shore-fort';
    this.object.add(fort);

    const radius = shorelineRadius(FORT_BEARING) - ISLAND.radius * FORT_INSET;
    const x = ISLAND.x + Math.cos(FORT_BEARING) * radius;
    const z = ISLAND.z + Math.sin(FORT_BEARING) * radius;

    const aim = shorelineRadius(COVE_BEARING) + FORT_AIM_OFFSHORE;
    const aimX = ISLAND.x + Math.cos(COVE_BEARING) * aim;
    const aimZ = ISLAND.z + Math.sin(COVE_BEARING) * aim;

    fort.position.set(x, seafloorHeight(x, z) - FORT_SINK, z);
    fort.rotation.y = yawAlignZ(aimX - x, aimZ - z);

    if (walls) fort.add(walls);
    if (cannon) {
      cannon.position.set(CANNON_LOCAL.x, FORT_SINK, CANNON_LOCAL.z);
      cannon.rotation.y = CANNON_LOCAL.yaw;
      cannon.scale.setScalar(CANNON_SCALE);
      fort.add(cannon);
    }
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
    for (const mesh of shells) {
      // A 14 cm shell 16 m under water casts nothing anyone can resolve.
      mesh.castShadow = false;
      find.add(mesh);
    }
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
    const contour = spec.facing === 'contour';

    let placed = 0;
    for (let i = 0; i < count; i++) {
      const found =
        clusters.length > 0
          ? pickClusterPoint(random, spec, clusters, (i % (clusters.length / 2)) * 2, clusterRadius, point)
          : pickIslandPoint(random, spec, point);
      if (!found) continue;

      const s = spec.minScale + random() * (spec.maxScale - spec.minScale);
      position.set(point.x, point.y - sink * s, point.z);

      // One terrain sample serves both the facing and the tilt, and the facing
      // reads it *before* the tilt lerps it toward vertical — at `slope: 0` the
      // lerp lands exactly on up and there is no gradient left to read.
      if (slope > 0 || contour) groundNormal(point.x, point.z, slopeSpan, normal);

      let yaw = random() * TAU;
      if (contour) {
        const derived = contourYaw(normal);
        // Half of them face the other way along the same contour. These scans
        // are asymmetric end to end, so the flip is a second silhouette for no
        // triangles — and one silhouette repeated is exactly what made six
        // identical slabs read as a fence.
        if (derived !== null) yaw = derived + (random() - 0.5) * CONTOUR_JITTER + (random() < 0.5 ? 0 : Math.PI);
      }

      if (slope > 0) {
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
    // Shadow flags stand. They used to be cleared here and in the cove, because
    // the sun's shadow camera was a +/-260 m box anchored at the world origin and
    // the island is 1.4 km from it — nothing out here could cast into that box or
    // receive from it, so the flags only bought a per-frame frustum test against
    // a map the island was nowhere near. `Atmosphere.setShadowFocus` now moves
    // the box to follow the camera, so the island gets the same shadows the ship
    // does and the cliffs finally sit on the ground rather than hovering over it.
    // What is still true is the cost, which is why `casts` exists: a caster is
    // drawn a second time into the depth map, and the understorey opts out.
    for (const mesh of meshes) {
      mesh.castShadow = spec.casts ?? true;
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

  /**
   * Bakes an authored arrangement of a kit model's nodes down to one geometry
   * per material.
   *
   * `modular_fort_01` is not a fort. It is twenty-two wall, tower and walkway
   * pieces laid out side by side in the source file for someone to build a fort
   * out of, and `bakeParts` on its own would faithfully reproduce the shop
   * display. This poses the chosen pieces into a temporary group and hands *that*
   * to `bakeParts`, which is why the result is a set piece for the price of one
   * draw per material rather than one per wall.
   *
   * Every piece is re-origined on its own footprint before it is posed, because
   * the offset a piece carries in the kit layout means nothing here; the
   * authored position is then the only position it has.
   */
  private assemble(source: THREE.Group | null, pieces: readonly KitPiece[]): BakedPart[] {
    if (!source) return [];

    const assembly = new THREE.Group();
    const box = new THREE.Box3();
    const shift = new THREE.Vector3();

    for (const piece of pieces) {
      const node = piece.node === undefined ? source : source.getObjectByName(piece.node);
      // A renamed node costs that piece. A ruin is missing pieces by definition,
      // so this degrades to a slightly more ruined fort rather than to nothing.
      if (!node) continue;

      const copy = node.clone(true);
      // Replace the copy's local transform with the original's *world* one:
      // `clone` keeps only the local transform, so every ancestor's contribution
      // would otherwise be silently dropped.
      copy.position.set(0, 0, 0);
      copy.quaternion.identity();
      copy.scale.set(1, 1, 1);
      copy.applyMatrix4(node.matrixWorld);

      const socket = new THREE.Group();
      socket.add(copy);
      socket.updateMatrixWorld(true);
      box.setFromObject(copy, true);
      recentreShift(box, shift);
      copy.position.add(shift);

      socket.position.set(piece.x, piece.y ?? 0, piece.z);
      // YXZ so the tilt happens in the yawed frame — a wall leans out of its own
      // face, not out of the assembly's.
      socket.rotation.set(piece.tilt ?? 0, piece.yaw ?? 0, 0, 'YXZ');
      if (piece.scale !== undefined) socket.scale.setScalar(piece.scale);
      assembly.add(socket);
    }

    assembly.updateMatrixWorld(true);
    return this.bakeParts(assembly);
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
 * for both drives one end of the shelf underground. It is also what decides how
 * far `contourYaw` can see, which is the same argument for the same reason.
 */
function groundNormal(x: number, z: number, span: number, out: THREE.Vector3): THREE.Vector3 {
  const dx = (seafloorHeight(x + span, z) - seafloorHeight(x - span, z)) / (2 * span);
  const dz = (seafloorHeight(x, z + span) - seafloorHeight(x, z - span)) / (2 * span);
  return out.set(-dx, 1, -dz).normalize();
}

/**
 * Yaw that lays a model's long (+X) axis along the terrain's contour, or null
 * where the ground is too level for a contour to mean anything.
 *
 * `normal` is a `groundNormal` sample, whose horizontal part is the negated
 * gradient and therefore points *downhill*. Turning the model's +Z down it puts
 * +X across it, along the contour — so the slab lies the way the ground lies and
 * faces the way the ground faces, in a bay, on a headland or along a spit,
 * because the only thing it reads is the shape of the terrain.
 *
 * What this replaced computed the tangent to a *circle* about the island centre.
 * That was defensible while the island was a radially symmetric dome and wrong
 * the moment `Seafloor` stopped being one: on a coast that now runs from 362 m
 * at the head of the bay to 752 m at the tip of the spit, six cliff slabs all
 * turned to the same imaginary circle stood in a line facing the same way and
 * rendered as a straight grey wall across the back of the island. A screenshot
 * of the far side is what caught it — from the play area they were behind the
 * summit, so nothing on the approach ever showed the error.
 */
function contourYaw(normal: THREE.Vector3): number | null {
  if (Math.hypot(normal.x, normal.z) < CONTOUR_MIN_GRADE) return null;
  return yawAlignZ(normal.x, normal.z);
}

/** Fills `out` with (x, ground height, z). */
function groundPoint(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(x, seafloorHeight(x, z), z);
}

/**
 * Radius at which the heightfield crosses sea level on `bearing`, in metres from
 * the island centre.
 *
 * Bisection rather than arithmetic, because the shoreline is a sum of harmonics,
 * sector masks and a noise field, and `Seafloor` is entitled to change all three
 * without telling anyone. Asking the height function where the water is cannot
 * go stale; `ISLAND.radius` is only the *mean* shore radius and reading it as a
 * coastline is what put the jetty 350 m inland.
 *
 * Assumes a single crossing inside the bracket. That holds on every bearing this
 * is called for; it would not hold on the spit's, which is a bar with water
 * behind it and therefore two crossings.
 */
function shorelineRadius(bearing: number): number {
  const dx = Math.cos(bearing);
  const dz = Math.sin(bearing);
  let inner = ISLAND.radius * SHORE_SEARCH_IN;
  let outer = ISLAND.radius * SHORE_SEARCH_OUT;
  for (let i = 0; i < SHORE_SEARCH_STEPS; i++) {
    const mid = (inner + outer) * 0.5;
    if (seafloorHeight(ISLAND.x + dx * mid, ISLAND.z + dz * mid) > 0) inner = mid;
    else outer = mid;
  }
  return (inner + outer) * 0.5;
}

/**
 * A point on the cove's shore, given a radius from the island centre and a
 * distance along the shore from the cove's bearing. Returns the bearing of the
 * point itself, which is what the props are turned against.
 *
 * Callers pass `shorelineRadius(COVE_BEARING) + offset` rather than a radius,
 * which is the only reason anything in the cove is still where it should be.
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
    const radius = ISLAND.radius * (spec.inner + random() * (spec.outer - spec.inner));
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
