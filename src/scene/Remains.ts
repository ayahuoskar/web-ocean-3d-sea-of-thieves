import * as THREE from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  cameraViewMatrix,
  faceDirection,
  float,
  mix,
  normalGeometry,
  normalWorld,
  positionGeometry,
  positionWorld,
  select,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { mulberry32 } from '../core/random';
import { smoothstepDown } from '../core/tslMath';
import { ISLAND, seafloorHeight } from './Seafloor';

/**
 * Two procedural set dressings for the shore: a grove of coconut palms, and a
 * pirate's remains half-buried in the sand.
 *
 * **Why these are built rather than downloaded.** Poly Haven — the CC0 source
 * every other prop in this project comes from — publishes no coconut palm and
 * no skeleton; `Props`' own manifest comment already says as much about the
 * palm. The CC0 libraries that do have them are low-poly stylised assets that
 * would sit next to 40k-triangle photogrammetry scans and read as a different
 * game. Both shapes are also unusually tractable: a palm is a swept tube and a
 * fan of arcs, and a skull is a deformed sphere with two holes in it. So this
 * follows the route `Birds` and `Fish` already took for the same reason —
 * procedural geometry, GPU-instanced where there are many, animated from a
 * clock so `resetClock(t)` reproduces a frame exactly.
 *
 * The two halves share almost nothing but the small mesh-accumulator at the top
 * of the file, and they are deliberately different in kind:
 *
 *  - **`Palms`** is a field. One instanced draw per *part* (trunk-and-nuts,
 *    fronds), every transform derived in the vertex stage from a per-instance
 *    seed and three phase uniforms, so `setCount` moves an integer and nothing
 *    else. 1,964 triangles a palm — 404 of trunk and coconuts, 1,560 of frond.
 *  - **`Remains`** is one object, placed once. It is a single merged geometry
 *    and a single draw, so it can afford 3,430 triangles on detail that only
 *    pays off when the camera is a metre away — orbits, a tooth row, ribs that
 *    thin as they curve.
 *
 * Neither uses compute or storage textures: the same node graph has to compile
 * on the WebGL2 fallback.
 */

/**
 * TSL node objects are structurally dynamic, and expressions composed out of
 * `attribute()` values resolve to `any` — which the overloaded typings then
 * narrow to the wrong constructor. Node-typed locals are therefore `any` by
 * design; the classes' public APIs stay typed.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;

/** `vec3` under a loose signature. See the note above. */
const vec3n = vec3 as unknown as (x: unknown, y: unknown, z: unknown) => Node;
/** `vec2` under a loose signature. */
const vec2n = vec2 as unknown as (x: unknown, y: unknown) => Node;
/**
 * A `vec3` node from a `THREE.Color`. Legal at runtime and the way every colour
 * constant in this file reaches a shader; the generated typings simply do not
 * describe the constructor overload that accepts one.
 */
const rgb = vec3 as unknown as (c: THREE.Color) => Node;

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// mesh accumulator
// ---------------------------------------------------------------------------

/**
 * A growing indexed triangle mesh with two free per-vertex channels.
 *
 * Both halves of this file build geometry out of the same handful of shapes, and
 * both need exactly two extra floats a vertex — the palm carries `(part, angle)`
 * and the skeleton carries `(stain, cavity)` — so one accumulator serves both.
 * The channels are deliberately unnamed here: naming them would mean two
 * near-identical classes.
 *
 * `setMatrix` bakes a transform into everything pushed after it, which is how
 * the skeleton assembles thirty separately-authored bones into one geometry and
 * one draw call without a scene graph.
 */
class MeshData {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly channel: number[] = [];
  readonly index: number[] = [];

  private readonly matrix = new THREE.Matrix4();
  private readonly normalMatrix = new THREE.Matrix3();
  private transformed = false;
  private readonly p = new THREE.Vector3();
  private readonly n = new THREE.Vector3();

  /** Bakes `m` into every subsequent vertex. Pass null to stop transforming. */
  setMatrix(m: THREE.Matrix4 | null): void {
    if (m === null) {
      this.transformed = false;
      return;
    }
    this.matrix.copy(m);
    this.normalMatrix.getNormalMatrix(this.matrix);
    this.transformed = true;
  }

  /** Appends a vertex and returns its index. */
  vertex(
    px: number, py: number, pz: number,
    nx: number, ny: number, nz: number,
    c0: number, c1: number,
  ): number {
    if (this.transformed) {
      this.p.set(px, py, pz).applyMatrix4(this.matrix);
      this.n.set(nx, ny, nz).applyMatrix3(this.normalMatrix).normalize();
      this.position.push(this.p.x, this.p.y, this.p.z);
      this.normal.push(this.n.x, this.n.y, this.n.z);
    } else {
      this.position.push(px, py, pz);
      this.normal.push(nx, ny, nz);
    }
    this.channel.push(c0, c1);
    return this.channel.length / 2 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.index.push(a, b, c);
  }

  /** Two triangles over a quad wound `a -> b -> c -> d`. */
  quad(a: number, b: number, c: number, d: number): void {
    this.index.push(a, b, c, a, c, d);
  }

  get vertexCount(): number {
    return this.channel.length / 2;
  }

  get triangleCount(): number {
    return this.index.length / 3;
  }

  /**
   * Replaces every normal with the area-weighted average of the faces meeting
   * at that vertex.
   *
   * For shapes whose normals are cheaper to derive from the winding than to
   * write down — palm leaflets, which are separate quads with no shared
   * vertices, so this gives each blade a flat normal consistent with the face
   * it was wound as. That consistency is what makes `faceDirection` mean
   * "you are looking at the underside" in the fragment stage rather than
   * "the author guessed".
   */
  recomputeNormals(): void {
    const p = this.position;
    const n = this.normal;
    for (let i = 0; i < n.length; i++) n[i] = 0;

    for (let i = 0; i < this.index.length; i += 3) {
      const a = this.index[i] * 3;
      const b = this.index[i + 1] * 3;
      const c = this.index[i + 2] * 3;
      const ax = p[b] - p[a];
      const ay = p[b + 1] - p[a + 1];
      const az = p[b + 2] - p[a + 2];
      const bx = p[c] - p[a];
      const by = p[c + 1] - p[a + 1];
      const bz = p[c + 2] - p[a + 2];
      // Not normalised: the cross product's length is twice the triangle area,
      // which is exactly the weight a big face should have over a sliver.
      const nx = ay * bz - az * by;
      const ny = az * bx - ax * bz;
      const nz = ax * by - ay * bx;
      n[a] += nx; n[a + 1] += ny; n[a + 2] += nz;
      n[b] += nx; n[b + 1] += ny; n[b + 2] += nz;
      n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
    }

    for (let i = 0; i < n.length; i += 3) {
      const len = Math.hypot(n[i], n[i + 1], n[i + 2]);
      if (len < 1e-9) {
        n[i] = 0; n[i + 1] = 1; n[i + 2] = 0;
      } else {
        n[i] /= len; n[i + 1] /= len; n[i + 2] /= len;
      }
    }
  }

  /** Bakes the accumulator into a geometry, naming the two free channels. */
  toGeometry(channelName: string, instanced: boolean): THREE.BufferGeometry {
    const geometry = instanced ? new THREE.InstancedBufferGeometry() : new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.position, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normal, 3));
    geometry.setAttribute(channelName, new THREE.Float32BufferAttribute(this.channel, 2));
    geometry.setIndex(this.index);
    return geometry;
  }
}

/** Fills `out` with a surface point for parameters in [0, 1]. */
type SurfacePoint = (u: number, v: number, out: THREE.Vector3) => void;

const _s0 = new THREE.Vector3();
const _s1 = new THREE.Vector3();
const _s2 = new THREE.Vector3();
const _du = new THREE.Vector3();
const _dv = new THREE.Vector3();
const _sn = new THREE.Vector3();

/**
 * A lathed surface: `lon + 1` columns (the seam is duplicated) by `lat + 1`
 * rows, with the first and last rows collapsed to poles.
 *
 * `point(lon01, lat01)` may be any deformation of a sphere — the normal is taken
 * from central differences of that function rather than from the sphere it
 * started as, which is what lets the cranium have eye sockets pushed into it and
 * still shade like a solid object. The differencing step is clamped away from
 * the poles because the parameterisation degenerates there; the error that
 * introduces is one 1e-3 step of latitude, which is invisible.
 *
 * The seam column is duplicated rather than shared so that anything driven by
 * the longitude parameter — the palm trunk's helical leaf scars — does not have
 * to interpolate the whole way back around the object between the last column
 * and the first.
 */
function lathe(
  md: MeshData,
  lon: number,
  lat: number,
  point: SurfacePoint,
  channel: (u: number, v: number) => readonly [number, number],
): void {
  const h = 1e-3;
  const base = md.vertexCount;

  for (let iy = 0; iy <= lat; iy++) {
    const v = iy / lat;
    const vs = Math.min(1 - h, Math.max(h, v));
    for (let ix = 0; ix <= lon; ix++) {
      const u = ix / lon;
      point(u, v, _s0);
      point(u + h, vs, _s1);
      point(u - h, vs, _s2);
      _du.copy(_s1).sub(_s2);
      point(u, vs + h, _s1);
      point(u, vs - h, _s2);
      _dv.copy(_s1).sub(_s2);
      // du x dv, in that order: the other order is the inward normal, and on a
      // closed solid that is a surface lit from the inside — every face dark
      // except the ones the sun happens to be behind.
      _sn.copy(_du).cross(_dv);
      if (_sn.lengthSq() < 1e-18) _sn.set(0, 1, 0);
      else _sn.normalize();
      const c = channel(u, v);
      md.vertex(_s0.x, _s0.y, _s0.z, _sn.x, _sn.y, _sn.z, c[0], c[1]);
    }
  }

  const stride = lon + 1;
  for (let iy = 0; iy < lat; iy++) {
    for (let ix = 0; ix < lon; ix++) {
      const a = base + iy * stride + ix;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      // The pole rows collapse to a point, so half of each quad there is
      // degenerate; emitting one triangle instead keeps the index buffer honest.
      if (iy === 0) md.tri(a, d, c);
      else if (iy === lat - 1) md.tri(a, b, c);
      else md.quad(a, b, d, c);
    }
  }
}

/** Fills `out` with a point on a swept path, for `s` in [0, 1]. */
type PathPoint = (s: number, out: THREE.Vector3) => void;

const _t0 = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _ref = new THREE.Vector3();
const _bi = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _ring = new THREE.Vector3();

/**
 * A tapered tube swept along `path`, capped with a shallow dome at each end.
 *
 * Every bone in the skeleton is one of these. The frame is built against a fixed
 * reference direction rather than parallel-transported: bones are short arcs
 * that never turn far enough for the frame to degenerate, and a transported
 * frame would make the tube's seam — and therefore any per-vertex channel that
 * follows it — depend on where the sweep started.
 *
 * The caps are what stop a femur from being a drinking straw seen end-on. They
 * are a single fan to a point pushed `0.55 r` past the end along the tangent,
 * which reads as a rounded epiphysis at any distance a viewer can get to.
 */
function tube(
  md: MeshData,
  path: PathPoint,
  radius: (s: number) => number,
  stations: number,
  sides: number,
  reference: THREE.Vector3,
  channel: (s: number, around: number) => readonly [number, number],
): void {
  const base = md.vertexCount;
  const h = 1e-4;

  for (let i = 0; i < stations; i++) {
    const s = i / (stations - 1);
    path(s, _t0);
    path(Math.min(1, s + h), _t1);
    _tan.copy(_t1).sub(_t0);
    path(Math.max(0, s - h), _t1);
    _tan.sub(_t1);
    if (_tan.lengthSq() < 1e-18) _tan.set(0, 1, 0);
    _tan.normalize();

    _ref.copy(reference);
    _bi.copy(_ref).cross(_tan);
    if (_bi.lengthSq() < 1e-8) {
      // The reference happened to line up with the tangent. Any perpendicular
      // will do; this only ever fires on a caller that passed a bad reference.
      _ref.set(_tan.z, _tan.x, _tan.y);
      _bi.copy(_ref).cross(_tan);
    }
    _bi.normalize();
    _nrm.copy(_tan).cross(_bi).normalize();

    const r = radius(s);
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * TAU;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      _ring.copy(_bi).multiplyScalar(ca).addScaledVector(_nrm, sa);
      const c = channel(s, j / sides);
      md.vertex(
        _t0.x + _ring.x * r, _t0.y + _ring.y * r, _t0.z + _ring.z * r,
        _ring.x, _ring.y, _ring.z,
        c[0], c[1],
      );
    }
  }

  for (let i = 0; i + 1 < stations; i++) {
    for (let j = 0; j < sides; j++) {
      const j2 = (j + 1) % sides;
      const a = base + i * sides + j;
      const b = base + i * sides + j2;
      const c = base + (i + 1) * sides + j;
      const d = base + (i + 1) * sides + j2;
      // Wound against the (binormal, normal, tangent) frame this sweep builds,
      // which is right-handed — so the outward face is a -> b -> d -> c and the
      // mirror of it is a tube you can only see the inside of.
      md.quad(a, b, d, c);
    }
  }

  // Caps. Wound so that the start cap faces backwards along the sweep and the
  // end cap forwards, which is what `quad`'s ordering above implies for the wall.
  for (const end of [0, 1] as const) {
    const s = end;
    path(s, _t0);
    path(end === 0 ? h : 1 - h, _t1);
    _tan.copy(_t0).sub(_t1);
    if (_tan.lengthSq() < 1e-18) _tan.set(0, 1, 0);
    _tan.normalize();
    const r = radius(s);
    const c = channel(s, 0);
    const tip = md.vertex(
      _t0.x + _tan.x * r * 0.55, _t0.y + _tan.y * r * 0.55, _t0.z + _tan.z * r * 0.55,
      _tan.x, _tan.y, _tan.z,
      c[0], c[1],
    );
    const ring = base + (end === 0 ? 0 : (stations - 1) * sides);
    for (let j = 0; j < sides; j++) {
      const j2 = (j + 1) % sides;
      if (end === 0) md.tri(tip, ring + j2, ring + j);
      else md.tri(tip, ring + j, ring + j2);
    }
  }
}

// ---------------------------------------------------------------------------
// shared shading helpers
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Reduces a phase to [0, 2pi) in float64, before it reaches a float32 uniform. */
function wrapTau(phase: number): number {
  return ((phase % TAU) + TAU) % TAU;
}

/**
 * How much direct sun a ground object should receive, from the sun's elevation.
 *
 * Derived rather than exposed, for the same reason `Birds` derives it: a caller
 * that has to remember to fade the sun term is a caller that will eventually
 * ship a palm lit like noon against a night sky.
 */
function sunGainFor(sun: THREE.Vector3): number {
  const above = clamp01((sun.y + 0.09) / 0.18);
  return above * above * (3 - 2 * above);
}

// ===========================================================================
// palms
// ===========================================================================

/**
 * Local seed. `core/random` owns the shared `SEEDS` table and this module may
 * not edit it, so the constant lives here — as a literal, for the same reason
 * the shared ones are: a grove re-drawn on every load is a grove no screenshot
 * baseline can be compared against, and a change to the layout has to be
 * visible in a diff.
 */
const PALM_SEED = 0x9a1f03;

/**
 * Instance buffer capacity. `setCount` draws a prefix of it, so a tier change
 * costs one integer write and palm `i` keeps its own position, height and lean
 * whatever the count is — a low tier thins the grove rather than replacing it.
 */
const MAX_PALMS = 96;

/**
 * Fronds the geometry is built for; a palm draws `MIN_FRONDS..MAX_FRONDS` of
 * them and collapses the rest to a point, which costs degenerate triangles and
 * no fragments at all.
 *
 * A mature coconut palm carries 25 to 35 leaves and sheds about one a month, so
 * this is the low end of honest. It is also where the shape stops improving. At
 * **12** the crown reads as an agave — you see sky between the fronds, the
 * silhouette has notches in it, and the dome that makes a palm a palm never
 * closes. At **40** the crown closes into an opaque green ball, the individual
 * fronds stop being legible at all, and the extra fourteen are 840 triangles
 * almost entirely occluded by the 26 in front of them. 26 is the point where
 * the outline is continuous and you can still count the leaves.
 */
const MAX_FRONDS = 26;
const MIN_FRONDS = 18;

/**
 * Divergence between successive fronds, radians — the golden angle.
 *
 * Neither decorative nor arbitrary: palms are genuinely phyllotactic, and this
 * is the one value that cannot let fronds stack into rows however many there
 * are. Every rational fraction of a turn does, and the failure is loud — 24
 * fronds 15 degrees apart is a crown with a seam down one side of it.
 */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Trunk tessellation. Eight sides is round enough at a 30 cm diameter. */
const TRUNK_RINGS = 10;
const TRUNK_SIDES = 8;

/** Leaflets a side, and stations along the rachis strip. */
const LEAFLETS = 11;
const RACHIS_STATIONS = 9;

/** Coconuts in the cluster, and their tessellation. */
const NUT_COUNT = 7;
const NUT_LON = 6;
const NUT_LAT = 4;

/**
 * Trunk radius at height `t`, as a fraction of the bole radius at the base.
 *
 * A coconut palm is not a cone. It has a swollen bole in the first metre and is
 * then very nearly parallel-sided the rest of the way up, which is why a linear
 * taper reads as a fir tree and not as a palm. This decays to 0.52 within about
 * 25 cm of the ground on a 10 m trunk, so the base flares and everything above
 * it is a column.
 */
function trunkTaper(t: number): number {
  return 0.52 + 0.48 * Math.exp(-t / 0.085);
}

/** Trunk lengths the grove draws from, metres of arc along the trunk. */
const TRUNK_MIN = 6;
const TRUNK_MAX = 14;

/** Bole radius, metres. A coconut trunk is ~30 cm across above the flare. */
const BOLE_MIN = 0.2;
const BOLE_MAX = 0.29;

/**
 * Growth lean, as a fraction of trunk height.
 *
 * Baked at placement, and deliberately not driven by `setWind`: this is where
 * the tree grew, not how it is bending right now. 0.26 puts the crown of a 12 m
 * palm three metres off its own root, which is about as far as a coconut leans
 * before it goes over — and it is the strongest single cue that these are palms
 * and not poles with leaves stuck on the end.
 */
const LEAN_MIN = 0.05;
const LEAN_MAX = 0.26;

/** Frond length, metres. */
const FROND_MIN = 3.4;
const FROND_MAX = 5.4;

/**
 * The frond arc: the tangent angle where it leaves the crown, and how far that
 * angle rotates down over the frond's length. Radians, interpolated by age.
 *
 * The rachis is a **circular arc of the frond's true length** — closed form, two
 * sines and two cosines — rather than a polynomial in a straight-line
 * coordinate. That matters because the droop is most of the silhouette and a
 * polynomial gets it wrong at exactly the wrong end: it stretches the frond as
 * the tip falls, so the old drooping fronds come out longer than the young ones
 * on the same tree.
 *
 * The young values arc up and out and end still climbing; the old values leave
 * the crown almost level and finish pointing 110 degrees below it, which is the
 * drooping outer skirt.
 */
const TILT_YOUNG = 1.3;
const CURL_YOUNG = 1.15;
const TILT_OLD = -0.05;
const CURL_OLD = 1.95;

/** Leaflet half-length at the widest station, as a fraction of frond length. */
const LEAFLET_WIDTH = 0.17;
/** Where the leaflets start; below this the frond is bare petiole. */
const LEAFLET_START = 0.24;
/** How far a leaflet tip hangs below the rachis plane, per unit of its length. */
const LEAFLET_DROOP = 0.42;
/** How far a leaflet tip is swept toward the frond tip, per unit of its length. */
const LEAFLET_SWEEP = 0.5;
/** Half-width of the rachis strip at the petiole, as a fraction of the length. */
const RACHIS_WIDTH = 0.013;

/**
 * Leaflet half-length at rachis parameter `u`.
 *
 * Peaks at about 40% along rather than at the middle, which is where a coconut
 * frond is widest, and the last leaflets converge on the tip instead of
 * vanishing before it.
 */
function leafletWidth(u: number): number {
  const s = clamp01((u - LEAFLET_START) / (1 - LEAFLET_START));
  return LEAFLET_WIDTH * Math.sin(Math.PI * Math.pow(s, 0.75));
}

/**
 * Vertical rise of a trunk of arc length `length` leaning by `ratio`.
 *
 * The centreline is `(H t, L t^2)`, whose arc length is longer than `H`, so
 * feeding the requested height straight in makes a hard-leaning palm visibly
 * taller than an upright one of the same nominal size. The integral is closed
 * form; solving it costs one `asinh` per palm at construction and removes a
 * correlation between lean and height that has no business existing.
 */
function trunkRise(length: number, ratio: number): number {
  const k = 2 * ratio;
  if (k < 1e-4) return length;
  const arcFactor = (Math.sqrt(1 + k * k) + Math.asinh(k) / k) / 2;
  return length / arcFactor;
}

// --------------------------------------------------------------- wind response

/**
 * Wind speed at which the trunk bend and the frond sweep saturate, m/s.
 *
 * A palm is a cantilever with an enormous sail area at the top, so it reaches
 * its visible limit long before the sea does: `Spectrum` is still adding fetch
 * at 20 m/s while the tree has been laid over as far as it goes since about 14.
 */
const WIND_FULL = 14;
/** Wind speed at which the leaflet flutter saturates. Leaves react far sooner. */
const FLUTTER_FULL = 6;
/**
 * Deflection of the crown as a fraction of trunk height, at full wind.
 *
 * 7% of a 10 m trunk is 70 cm of crown travel, which is a palm in a stiff blow
 * rather than in a hurricane. Much past this it starts to look like the trunk is
 * made of rubber, because there is no second mode here — the whole trunk bends
 * as one quadratic, and a real trunk whips.
 */
const TRUNK_BEND = 0.07;
/** Amplitude of the trunk's slow sway, as a fraction of trunk height. */
const TRUNK_SWAY = 0.014;
/** Downwind sweep of a frond tip, as a fraction of frond length, at full wind. */
const FROND_BEND = 0.2;
const FROND_SWAY = 0.09;
/** Leaflet flap amplitude, as a fraction of the leaflet's own length. */
const LEAFLET_FLAP = 0.3;

/**
 * Frequencies, Hz. Every one of them is global — only the *phases* vary, per
 * palm and per frond.
 *
 * That is what lets the clock reach the GPU as wrapped phases rather than as
 * seconds: the CPU keeps time in float64 and hands the shader `omega t mod 2pi`,
 * and because no shader-side frequency is a per-instance multiple, the wrap is
 * exactly invisible and the argument never grows large enough for `sin` to lose
 * precision to range reduction. Per-instance frequencies would forfeit both and
 * buy nothing: seeded phase offsets desynchronise a grove just as completely.
 */
const SWAY_HZ = 0.19;
const GUST_HZ = 0.043;
const FLUTTER_HZ = 1.15;

/**
 * Spatial frequency of the gust front, radians per metre.
 *
 * A gust is not a global multiplier, it is a thing that crosses the ground.
 * Offsetting each palm's gust phase by its position along the wind vector makes
 * the grove ripple in the direction the wind is travelling for the cost of one
 * dot product, and it is the detail that turns "all the trees are wobbling" into
 * "the wind just came through". 2pi/95 m, so a front crosses a grove in about
 * eight seconds.
 */
const GUST_WAVENUMBER = TAU / 95;

// ------------------------------------------------------------------ palm colour

/** Trunk: pale grey-brown bark, and the darker groove of an old frond scar. */
const BARK_COLOR = new THREE.Color(0.42, 0.37, 0.31);
const SCAR_COLOR = new THREE.Color(0.23, 0.2, 0.17);
/** Coconut husk — still green-brown in the crown, not the fibrous shop nut. */
const HUSK_COLOR = new THREE.Color(0.3, 0.31, 0.17);

/** Vertical spacing of the leaf scars on the trunk, metres. */
const SCAR_SPACING = 0.21;

/** Frond: fresh green at the crown, older and yellower toward the tips. */
const FROND_BASE_COLOR = new THREE.Color(0.13, 0.24, 0.07);
const FROND_TIP_COLOR = new THREE.Color(0.29, 0.36, 0.11);
const FROND_DRY_COLOR = new THREE.Color(0.38, 0.31, 0.13);

/**
 * Colour of the light that comes *through* a leaflet, and how much of it there
 * is.
 *
 * This is the most valuable thing in the frond material and it is worth more
 * than any amount of extra geometry, because a palm frond is thin enough to be
 * translucent and it does not read as the same object backlit as it does lit
 * from the front. Front-lit it is a dark green blade; against a low sun it is a
 * bright yellow-green lantern with the ribs showing through as dark lines. Every
 * photograph of a palm at golden hour is that effect and nothing else.
 *
 * The tint is far more saturated in green than the reflected colour, because
 * chlorophyll is what the light had to cross to get here. The strength is
 * calibrated against `Atmosphere`'s 3.2-intensity sun, at which a fully lit
 * white surface leaves three's physical model at about 1.0 — so 0.8 makes a
 * backlit frond a shade brighter than a front-lit one, which is correct.
 *
 * Known limitation: this rides on `emissiveNode`, so it is not shadowed. A frond
 * standing in the shadow of the crown above it still glows. The alternative is
 * `MeshPhysicalNodeMaterial.transmissionNode`, which needs the transmission
 * render pass and would drag every palm in the scene into the transparent queue
 * — a far worse trade for a grove.
 */
const FROND_TRANSMISSION = new THREE.Color(0.62, 0.86, 0.24);
const FROND_TRANSMISSION_GAIN = 0.8;

// ------------------------------------------------------------ palm geometry

/**
 * Trunk and coconut cluster, in one geometry and therefore one draw.
 *
 * The nuts ride along with the trunk rather than getting their own mesh because
 * they hang off the top of it: the vertex stage has already solved the trunk's
 * frame at `t = 1` by the time it needs to place them, and they are the same
 * material — an opaque, single-sided, matte solid. A separate draw would buy
 * nothing but a second pipeline and a second instance buffer.
 *
 * The two are told apart by `palmPart.x`, which is 0 on the trunk and 1 on the
 * nuts. `palmPart.y` is the longitude around the trunk, and it is the reason the
 * seam column is duplicated: it drives the helical leaf-scar pattern, and it has
 * to be able to step by exactly one whole scar at the seam. Interpolating it
 * backwards around the whole trunk instead would put a smeared band of grooves
 * down one side.
 *
 * Local convention: `position = (radial x, t, radial z)` on the trunk with `t`
 * running 0..1 up the centreline, and `position = (x, y, z)` in metres relative
 * to the crown base on a nut.
 */
function buildTrunkGeometry(): THREE.InstancedBufferGeometry {
  const md = new MeshData();

  const columns = TRUNK_SIDES + 1;
  for (let i = 0; i < TRUNK_RINGS; i++) {
    const t = i / (TRUNK_RINGS - 1);
    const r = trunkTaper(t);
    for (let j = 0; j < columns; j++) {
      const a01 = j / TRUNK_SIDES;
      const a = a01 * TAU;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // The taper's own slope is under 0.01 above the bole, so the surface
      // normal is radial to well inside a shading gradient; correcting it would
      // be arithmetic in service of nothing.
      md.vertex(ca * r, t, sa * r, ca, 0, sa, 0, a01);
    }
  }

  for (let i = 0; i + 1 < TRUNK_RINGS; i++) {
    for (let j = 0; j < TRUNK_SIDES; j++) {
      const a = i * columns + j;
      md.quad(a, a + columns, a + columns + 1, a + 1);
    }
  }

  // Cap the top. It is hidden by the crown from anywhere on the ground, and it
  // exists only so that a camera above the tree does not look down a pipe.
  const capR = trunkTaper(1);
  const capCentre = md.vertex(0, 1, 0, 0, 1, 0, 0, 0);
  const capRing: number[] = [];
  for (let j = 0; j < TRUNK_SIDES; j++) {
    const a = (j / TRUNK_SIDES) * TAU;
    capRing.push(md.vertex(Math.cos(a) * capR, 1, Math.sin(a) * capR, 0, 1, 0, 0, j / TRUNK_SIDES));
  }
  for (let j = 0; j < TRUNK_SIDES; j++) {
    md.tri(capCentre, capRing[(j + 1) % TRUNK_SIDES], capRing[j]);
  }

  // The nut cluster: a ring of six under the crown with one hanging lower, all
  // pushed against the trunk. Coconuts grow in a bunch on a single stalk, so
  // they touch each other and the bole rather than floating in a halo.
  const random = mulberry32(PALM_SEED ^ 0x21c0de);
  for (let k = 0; k < NUT_COUNT; k++) {
    const a = (k / (NUT_COUNT - 1)) * TAU + random() * 0.4;
    const ring = k === NUT_COUNT - 1 ? 0.06 : 0.34 + random() * 0.1;
    const cx = Math.cos(a) * ring;
    const cz = Math.sin(a) * ring;
    const cy = -0.34 - random() * 0.42;
    const rr = 0.13 + random() * 0.03;
    lathe(
      md,
      NUT_LON,
      NUT_LAT,
      (u, v, out) => {
        const phi = u * TAU;
        const theta = v * Math.PI;
        const st = Math.sin(theta);
        // Slightly prolate along the hanging axis, which is what a husked
        // coconut is; a sphere reads as a ball bearing.
        out.set(
          cx + Math.cos(phi) * st * rr,
          cy + Math.cos(theta) * rr * 1.22,
          cz + Math.sin(phi) * st * rr,
        );
      },
      () => [1, 0],
    );
  }

  const geometry = md.toGeometry('palmPart', true) as THREE.InstancedBufferGeometry;
  geometry.name = 'palm-trunk';
  return geometry;
}

/**
 * All `MAX_FRONDS` fronds of one palm, in one geometry.
 *
 * Authored in a canonical frond space: `position = (lateral, vertical, u)`, all
 * three in units of the frond's own length, with `u` running 0 at the crown to 1
 * at the tip. The vertex stage bends that space onto the rachis arc and scales
 * it, and because the scale is uniform the space stays metrically similar to the
 * deformed frond — which is what makes normals computed here from the winding
 * still correct after the deformation.
 *
 * `palmFrond.x` is the frond index, so the shader can give each one its own
 * azimuth, age and phase and collapse the ones past the instance's frond count.
 * `palmFrond.y` is 0 on the rachis and 1 at a leaflet tip; it masks the flutter
 * to the blades and masks the transmission to the parts that are actually thin.
 */
function buildFrondGeometry(): THREE.InstancedBufferGeometry {
  const md = new MeshData();

  for (let f = 0; f < MAX_FRONDS; f++) {
    // The rachis strip. Mostly hidden by leaflets, but it is what the petiole
    // is made of and it stops the frond being a hole between two rows of blades.
    const strip: number[] = [];
    for (let k = 0; k < RACHIS_STATIONS; k++) {
      const u = k / (RACHIS_STATIONS - 1);
      const hw = RACHIS_WIDTH * (1 - 0.85 * u);
      strip.push(
        md.vertex(hw, 0, u, 0, 1, 0, f, 0),
        md.vertex(-hw, 0, u, 0, 1, 0, f, 0),
      );
    }
    for (let k = 0; k + 1 < RACHIS_STATIONS; k++) {
      const a = strip[k * 2];
      const b = strip[k * 2 + 1];
      const c = strip[k * 2 + 2];
      const d = strip[k * 2 + 3];
      md.quad(a, b, d, c);
    }

    for (const side of [1, -1]) {
      for (let k = 0; k < LEAFLETS; k++) {
        // A gap between consecutive leaflets, which is where the feathered
        // outline comes from. Filling the rachis solidly gives a sword, not a
        // pinnate leaf.
        const s0 = k / LEAFLETS;
        const s1 = (k + 0.82) / LEAFLETS;
        const u0 = LEAFLET_START + s0 * (1 - LEAFLET_START);
        const u1 = LEAFLET_START + s1 * (1 - LEAFLET_START);
        const w = leafletWidth((u0 + u1) * 0.5);
        const drop = w * LEAFLET_DROOP;
        const sweep = w * LEAFLET_SWEEP;
        const edge = RACHIS_WIDTH * 0.5;

        const v0 = md.vertex(side * edge, 0, u0, 0, 0, 0, f, 0);
        const v1 = md.vertex(side * edge, 0, u1, 0, 0, 0, f, 0);
        const v2 = md.vertex(side * w, -drop, u1 + sweep, 0, 0, 0, f, 1);
        const v3 = md.vertex(side * w * 0.93, -drop * 0.93, u0 + sweep * 0.93, 0, 0, 0, f, 0.93);

        // Mirrored winding on the far side, so both blades of a frond present
        // the same face upward and `faceDirection` can be trusted.
        if (side > 0) md.quad(v0, v1, v2, v3);
        else md.quad(v0, v3, v2, v1);
      }
    }
  }

  md.recomputeNormals();

  const geometry = md.toGeometry('palmFrond', true) as THREE.InstancedBufferGeometry;
  geometry.name = 'palm-fronds';
  return geometry;
}

// ---------------------------------------------------------------- palm class

/** Where one palm stands. Only `x` and `z` are required. */
export interface PalmPlacement {
  x: number;
  z: number;
  /** Ground height. Taken from `seafloorHeight(x, z)` when omitted. */
  y?: number;
  /** Trunk length in metres, overriding the seeded draw. */
  height?: number;
  /** Lean bearing in radians, overriding the slope-and-wind derivation. */
  lean?: number;
}

export interface PalmsOptions {
  /** Palms drawn at construction. Clamped to `Palms.MAX_COUNT`. */
  count?: number;
  /** Overrides the seeded per-palm variation; useful for A/B-ing a grove. */
  seed?: number;
  /**
   * Bearing the prevailing wind blows *toward*, radians, in the scene's
   * `x = cos, z = sin` convention — the same one `Spectrum` and `Props` use.
   *
   * This bakes which way the trunks grew and is deliberately separate from
   * `setWind`: a tree's lean is decades of weather, and rebuilding it whenever
   * the live wind veers would have the whole grove slowly writhing.
   */
  prevailingWind?: number;
  /** Where the palms stand. Equivalent to calling `setPlacements` after. */
  placements?: readonly PalmPlacement[];
}

/**
 * How much of the growth lean comes from the prevailing wind, and how much from
 * the ground falling away.
 *
 * Both are real and the second is the stronger. A coconut on a shore leans out
 * over the water because that is where the light is, and the terrain gradient is
 * the only thing in this scene that knows where the water is — which is also why
 * it is derived from `seafloorHeight` at placement time rather than from a
 * hard-coded shoreline. The island is being reshaped in parallel; a lean read
 * off the heightfield follows it, and a lean read off a radius does not.
 */
const WIND_LEAN_WEIGHT = 0.35;
const SLOPE_LEAN_WEIGHT = 0.85;
/** Peak random deviation from that bearing, radians. */
const LEAN_JITTER = 0.9;
/** Half-width of the terrain sample the downhill direction comes from, metres. */
const LEAN_SPAN = 12;

/**
 * Metres of slack added to the grove's bounding sphere.
 *
 * The bound is computed from the *displaced* extent — every palm contributes its
 * own trunk height and frond reach, not the undisplaced base the geometry
 * happens to be authored around. This is the margin on top of that, and it
 * covers the wind: at full gust a crown travels about a metre and the frond tips
 * another metre past that. Without it a grove leaning into a squall clips itself
 * out of frame at the edges, which is the exact failure a bound taken from an
 * undeformed vertex buffer produces.
 */
const GROVE_SLACK = 2.5;

/**
 * A grove of coconut palms: two instanced draws, ~1,960 triangles a palm.
 *
 * Add `object` to the **scene root**. The vertex stage emits world coordinates
 * directly, exactly as `Fish` does, so the container carries an identity
 * transform and must not be parented to anything that moves.
 *
 * Everything visible is a pure function of the clock and the wind uniforms.
 * There is no integrator and no remembered pose anywhere in the class, which is
 * what makes `resetClock(t)` land on the same frame `update()`-ing to `t` would.
 */
export class Palms {
  /** Instances the buffers hold. `setCount` is clamped to this. */
  static readonly MAX_COUNT = MAX_PALMS;

  readonly object: THREE.Object3D;

  private readonly trunkGeometry: THREE.InstancedBufferGeometry;
  private readonly frondGeometry: THREE.InstancedBufferGeometry;
  private readonly trunkMaterial: THREE.MeshStandardNodeMaterial;
  private readonly frondMaterial: THREE.MeshStandardNodeMaterial;
  private readonly trunkMesh: THREE.Mesh;
  private readonly frondMesh: THREE.Mesh;

  /**
   * Per-instance data, held once on the CPU and mirrored into two attribute
   * objects per array — one for each geometry.
   *
   * The array is shared and the attribute wrappers are not. Sharing the wrapper
   * across two geometries would work and would even save a buffer, but it makes
   * both geometries co-owners of one GPU resource, and `dispose()` then has to
   * know which of them is allowed to free it. Two 1.5 KB buffers is not a price
   * worth arguing about.
   */
  private readonly anchorData = new Float32Array(MAX_PALMS * 4);
  private readonly formData = new Float32Array(MAX_PALMS * 4);
  private readonly crownData = new Float32Array(MAX_PALMS * 4);
  private readonly seedData = new Float32Array(MAX_PALMS * 4);
  private readonly attributes: THREE.InstancedBufferAttribute[] = [];

  private readonly seed: number;
  private readonly prevailingWind: number;

  /** Palms `setPlacements` actually wrote. The ceiling on `count`. */
  private placed = 0;
  /**
   * What the caller asked for, kept apart from what there is ground for.
   *
   * Without the separation, `new Palms({ count: 40 })` followed by
   * `setPlacements(points)` draws nothing: the constructor clamps 40 against a
   * placement list that does not exist yet, and nothing ever un-clamps it. The
   * requested count is remembered and re-applied whenever the ceiling moves.
   */
  private wantCount: number;
  private count = 0;
  private wantVisible = true;
  private disposed = false;

  /** Seconds, float64, never wrapped. The GPU only ever sees phases from it. */
  private time = 0;

  // --- uniforms -------------------------------------------------------------
  /** (wind x, wind z, bend 0..1, flutter gain 0..1). See `setWind`. */
  private readonly uWind = uniform(new THREE.Vector4(0.707, 0.707, 0.25, 0.3));
  private readonly uSway = uniform(0);
  private readonly uGust = uniform(0);
  private readonly uFlutter = uniform(0);
  private readonly uSunDir = uniform(new THREE.Vector3(0.35, 0.62, 0.7).normalize());
  private readonly uSunColor = uniform(new THREE.Color(1, 0.96, 0.9));
  private readonly uSunGain = uniform(1);

  constructor(options: PalmsOptions = {}) {
    this.seed = options.seed ?? PALM_SEED;
    this.prevailingWind = options.prevailingWind ?? Math.PI / 4;
    this.wantCount = clampPalmCount(options.count ?? 0);

    this.trunkGeometry = buildTrunkGeometry();
    this.frondGeometry = buildFrondGeometry();
    this.attachInstanceData(this.trunkGeometry);
    this.attachInstanceData(this.frondGeometry);

    this.trunkMaterial = this.buildTrunkMaterial();
    this.frondMaterial = this.buildFrondMaterial();

    this.trunkMesh = new THREE.Mesh(this.trunkGeometry, this.trunkMaterial);
    this.trunkMesh.name = 'palm-trunks';
    this.frondMesh = new THREE.Mesh(this.frondGeometry, this.frondMaterial);
    this.frondMesh.name = 'palm-fronds';

    for (const mesh of [this.trunkMesh, this.frondMesh]) {
      // Flags set as the object deserves, not as today's shadow camera happens
      // to be framed: the island currently sits outside the sun's +/-260 m box,
      // so these cost one frustum test and produce nothing — and the moment the
      // box is widened, a palm casts the long shadow a palm should.
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Culled against a sphere computed over the *placed and displaced* grove.
      // See `GROVE_SLACK` and `refreshBounds`.
      mesh.frustumCulled = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
    }

    this.object = new THREE.Object3D();
    this.object.name = 'palms';
    this.object.matrixAutoUpdate = false;
    this.object.updateMatrix();
    this.object.add(this.trunkMesh);
    this.object.add(this.frondMesh);

    this.setPlacements(options.placements ?? []);
    this.refresh();
  }

  getCount(): number {
    return this.count;
  }

  /** Palms placed by the last `setPlacements`. The ceiling on `setCount`. */
  getPlacedCount(): number {
    return this.placed;
  }

  /**
   * Palms actually drawn, 0..`Palms.MAX_COUNT`.
   *
   * Moves `instanceCount` and nothing else — no rebuild, no allocation, and palm
   * `i` keeps its position, height, lean and phase across a tier change, so a
   * lower tier thins the grove instead of replacing it with a different one. At
   * 0 the object is hidden outright and the draw is never submitted.
   */
  setCount(count: number): void {
    this.wantCount = clampPalmCount(count);
    this.applyCount();
  }

  setVisible(v: boolean): void {
    this.wantVisible = v;
    this.applyCount();
  }

  /**
   * Places the grove.
   *
   * Positions come from the caller because the island is a heightfield that is
   * being reshaped, and a module that scattered palms against its own idea of
   * where the shore is would be wrong the moment it moved. `scatterPalms` in
   * this file is the convenience path and it derives everything from
   * `seafloorHeight` and `ISLAND`; anything that produces an `{x, z}` will do.
   *
   * Order is preserved and is load bearing: `setCount` draws a prefix, so a
   * caller that hands over a seeded-random ordering gets an even thin-out, and
   * one that hands over a sorted list gets half an island of palms.
   */
  setPlacements(points: readonly PalmPlacement[]): void {
    if (this.disposed) return;
    const random = mulberry32(this.seed);
    this.placed = Math.min(MAX_PALMS, points.length);

    const box = new THREE.Box3();
    box.makeEmpty();

    for (let i = 0; i < MAX_PALMS; i++) {
      const base = i * 4;
      // Every palm draws the same number of values in the same order whatever
      // the placement count is, so palm `i` is the same tree between runs and
      // adding one at the end of the list cannot reshuffle the rest.
      const lengthDraw = random();
      const boleDraw = random();
      const leanDraw = random();
      const jitterDraw = random();
      const crownDraw = random();
      const frondDraw = random();
      const frondLengthDraw = random();
      const nutDraw = random();
      const nutSizeDraw = random();
      const tintDraw = random();
      const swayDraw = random();
      const flutterDraw = random();
      const gustDraw = random();

      if (i >= this.placed) {
        // Not placed: zero the trunk so the instance collapses to a point even
        // if something later raises the count past what was written.
        this.anchorData[base + 3] = 0;
        this.crownData[base] = 0;
        this.crownData[base + 1] = 0;
        this.crownData[base + 2] = 0;
        continue;
      }

      const point = points[i];
      const x = point.x;
      const z = point.z;
      const y = point.y ?? seafloorHeight(x, z);

      const trunkLength = point.height ?? TRUNK_MIN + lengthDraw * (TRUNK_MAX - TRUNK_MIN);
      const leanRatio = LEAN_MIN + leanDraw * (LEAN_MAX - LEAN_MIN);
      const rise = trunkRise(trunkLength, leanRatio);
      const leanAmount = leanRatio * rise;
      const leanAngle = point.lean ?? this.leanBearing(x, z, jitterDraw);

      // Frond length correlates loosely with trunk height — a big palm carries
      // a bigger crown — but only loosely, because the correlation is weak in
      // life and a perfect one makes a grove look like one tree scaled.
      const sizeMix = (trunkLength - TRUNK_MIN) / (TRUNK_MAX - TRUNK_MIN);
      const frondLength =
        FROND_MIN + (FROND_MAX - FROND_MIN) * clamp01(sizeMix * 0.55 + frondLengthDraw * 0.55);
      const fronds = MIN_FRONDS + Math.floor(frondDraw * (MAX_FRONDS - MIN_FRONDS + 1));
      // Roughly half of a stand is in fruit at any time, and a palm under about
      // eight metres has not started.
      const nutScale = nutDraw < 0.45 || trunkLength < 8 ? 0 : 0.85 + nutSizeDraw * 0.3;

      this.anchorData[base] = x;
      this.anchorData[base + 1] = y;
      this.anchorData[base + 2] = z;
      this.anchorData[base + 3] = rise;

      this.formData[base] = leanAngle;
      this.formData[base + 1] = leanAmount;
      this.formData[base + 2] = crownDraw * TAU;
      this.formData[base + 3] = BOLE_MIN + boleDraw * (BOLE_MAX - BOLE_MIN);

      this.crownData[base] = fronds;
      this.crownData[base + 1] = frondLength;
      this.crownData[base + 2] = nutScale;
      this.crownData[base + 3] = 0;

      this.seedData[base] = swayDraw * TAU;
      this.seedData[base + 1] = flutterDraw * TAU;
      this.seedData[base + 2] = tintDraw;
      this.seedData[base + 3] = gustDraw * TAU;

      // The instance's own displaced extent. A young frond arcs up and out by
      // about 0.7 of its length and an old one hangs 0.72 below the crown, so
      // one frond length in every direction from the crown covers the lot with
      // room over.
      const reach = frondLength + leanAmount;
      box.expandByPoint(_boundLo.set(x - reach, y - 1.5, z - reach));
      box.expandByPoint(_boundHi.set(x + reach, y + rise + frondLength, z + reach));
    }

    for (const attribute of this.attributes) attribute.needsUpdate = true;
    this.refreshBounds(box);
    this.applyCount();
  }

  /**
   * The live wind.
   *
   * `directionRadians` is the bearing the wind blows *toward*, in the same
   * `x = cos, z = sin` convention as `Spectrum` and `Props`; `speed` is in m/s.
   * The simulation is deliberately not imported — a palm needs two numbers, and
   * taking them as setters keeps this module off the ocean's dependency graph.
   *
   * Only the flex responds. The growth lean is baked; see `PalmsOptions`.
   */
  setWind(directionRadians: number, speed: number): void {
    const wind = this.uWind.value as THREE.Vector4;
    wind.x = Math.cos(directionRadians);
    wind.y = Math.sin(directionRadians);
    // Squared, because drag is. It also matters at the bottom of the range:
    // a linear map has a palm visibly bent in a 3 m/s breeze, and the two
    // responses are shaped separately because leaves start moving several
    // metres per second before a trunk does.
    const bend = clamp01(speed / WIND_FULL);
    wind.z = Math.max(0.05, bend * bend);
    wind.w = Math.max(0.12, clamp01(speed / FLUTTER_FULL));
  }

  /**
   * The sun, for the frond transmission.
   *
   * `direction` points *toward* the sun and need not be normalised. The direct
   * term is faded out as it sets — derived here rather than exposed, so a caller
   * cannot leave a grove backlit by a sun that is below the horizon.
   *
   * Optional: the material has a defensible mid-morning default, so a caller
   * that never wires this still gets a lit grove.
   */
  setSun(direction: THREE.Vector3, color?: THREE.Color): void {
    const sun = this.uSunDir.value as THREE.Vector3;
    sun.copy(direction);
    if (sun.lengthSq() < 1e-8) sun.set(0, 1, 0);
    sun.normalize();
    this.uSunGain.value = sunGainFor(sun);
    if (color) (this.uSunColor.value as THREE.Color).copy(color);
  }

  /**
   * Advances the clock. Three scalar writes, no allocation.
   *
   * Runs whether or not the grove is visible: making the pose depend on
   * visibility would make it depend on the history of `setVisible` calls, which
   * is exactly the hidden state `resetClock` exists to rule out.
   */
  update(dt: number): void {
    if (this.disposed) return;
    this.time += dt;
    this.refresh();
  }

  /** Jumps the clock. Identical to having updated to `time`, to the bit. */
  resetClock(time = 0): void {
    if (this.disposed) return;
    this.time = time;
    this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.remove(this.trunkMesh);
    this.object.remove(this.frondMesh);
    this.object.removeFromParent();
    this.trunkGeometry.dispose();
    this.frondGeometry.dispose();
    this.trunkMaterial.dispose();
    this.frondMaterial.dispose();
    this.attributes.length = 0;
  }

  // ------------------------------------------------------------------ internals

  private applyCount(): void {
    this.count = Math.min(this.wantCount, this.placed);
    this.trunkGeometry.instanceCount = this.count;
    this.frondGeometry.instanceCount = this.count;
    // An empty grove is hidden outright, so it costs not even a culling test.
    this.object.visible = this.wantVisible && this.count > 0;
  }

  /** Pushes the current pose into the phase uniforms. See `SWAY_HZ`. */
  private refresh(): void {
    const t = this.time;
    this.uSway.value = wrapTau(t * SWAY_HZ * TAU);
    this.uGust.value = wrapTau(t * GUST_HZ * TAU);
    this.uFlutter.value = wrapTau(t * FLUTTER_HZ * TAU);
  }

  /**
   * Which way a palm at (x, z) grew, from the local ground gradient and the
   * prevailing wind. See `WIND_LEAN_WEIGHT`.
   */
  private leanBearing(x: number, z: number, jitter: number): number {
    const dx = seafloorHeight(x + LEAN_SPAN, z) - seafloorHeight(x - LEAN_SPAN, z);
    const dz = seafloorHeight(x, z + LEAN_SPAN) - seafloorHeight(x, z - LEAN_SPAN);
    let lx = Math.cos(this.prevailingWind) * WIND_LEAN_WEIGHT;
    let lz = Math.sin(this.prevailingWind) * WIND_LEAN_WEIGHT;
    const fall = Math.hypot(dx, dz);
    if (fall > 1e-6) {
      lx += (-dx / fall) * SLOPE_LEAN_WEIGHT;
      lz += (-dz / fall) * SLOPE_LEAN_WEIGHT;
    }
    return Math.atan2(lz, lx) + (jitter - 0.5) * LEAN_JITTER;
  }

  /**
   * Publishes a bound covering the placed, displaced grove.
   *
   * Both geometries get their own copy, because a `Sphere` handed to two
   * geometries is one object two owners can mutate. The object's transform is
   * the identity and the vertex stage emits world space, so this sphere is
   * already in the space the frustum test wants.
   */
  private refreshBounds(box: THREE.Box3): void {
    const sphere = new THREE.Sphere();
    if (box.isEmpty()) sphere.set(new THREE.Vector3(), 0);
    else box.getBoundingSphere(sphere).radius += GROVE_SLACK;
    this.trunkGeometry.boundingSphere = sphere.clone();
    this.frondGeometry.boundingSphere = sphere.clone();
    this.trunkGeometry.boundingBox = box.clone();
    this.frondGeometry.boundingBox = box.clone();
  }

  private attachInstanceData(geometry: THREE.InstancedBufferGeometry): void {
    const add = (name: string, array: Float32Array): void => {
      const attr = new THREE.InstancedBufferAttribute(array, 4);
      geometry.setAttribute(name, attr);
      this.attributes.push(attr);
    };
    add('palmAnchor', this.anchorData);
    add('palmForm', this.formData);
    add('palmCrown', this.crownData);
    add('palmSeed', this.seedData);
    geometry.instanceCount = 0;
  }

  // -------------------------------------------------------------- the shaders

  /**
   * The wind, resolved for one instance.
   *
   * `gust` is 0..1 and `sway` is -1..1; both carry the palm's own phase offset
   * *and* the gust front's travel term, so two palms twenty metres apart along
   * the wind are visibly out of step. See `GUST_WAVENUMBER`.
   */
  private windTerms(anchor: Node, seed: Node): {
    dir: Node; gust: Node; sway: Node; bend: Node; flutter: Node;
  } {
    const w: Node = this.uWind;
    const dir = vec3n(w.x, 0, w.y).toVar();
    const front = vec2n(anchor.x, anchor.z).dot(vec2n(w.x, w.y)).mul(GUST_WAVENUMBER).toVar();
    const gust = this.uGust.add(seed.w).sub(front).sin().mul(0.5).add(0.5).toVar();
    // The sway front travels more slowly than the gust front: the gust is the
    // air arriving, the sway is the tree's own response settling behind it.
    const sway = this.uSway.add(seed.x).sub(front.mul(0.35)).sin().toVar();
    return { dir, gust, sway, bend: w.z, flutter: w.w };
  }

  /**
   * Downwind travel of the crown, metres — the steady bend plus the slow sway.
   *
   * Both scale with trunk height, because a taller cantilever of the same
   * stiffness deflects further, and because it keeps the *angle* at the crown
   * roughly constant across the height range instead of making short palms look
   * rigid next to tall ones.
   */
  private crownDeflection(anchor: Node, wind: { gust: Node; sway: Node; bend: Node }): Node {
    const steady = anchor.w.mul(wind.bend).mul(TRUNK_BEND).mul(wind.gust.mul(0.55).add(0.45));
    const swing = anchor.w.mul(wind.bend).mul(TRUNK_SWAY).mul(wind.sway);
    return steady.add(swing);
  }

  /**
   * The trunk's centreline, tangent and two perpendiculars at parameter `t`.
   *
   * The centreline is `base + up*(H t) + lean*(L t^2) + wind*(D t^2)`. Quadratic
   * in both bending terms because that is the deflected shape of a cantilever
   * near its root, and — more usefully here — because it is the one low-order
   * curve whose tangent is exactly vertical at `t = 0`. A palm grows out of the
   * ground upright and acquires its lean with height; a linear term would have
   * the trunk emerging from the sand at an angle, with a visible corner where it
   * meets the ground.
   *
   * The frame is built by crossing the tangent with a *horizontal* reference
   * rather than with world up. Crossing with up is the obvious spelling and it
   * is degenerate for exactly the geometry this file is made of: these tangents
   * are within 35 degrees of vertical everywhere, so `cross(tangent, up)`
   * collapses and the ring vertices go to NaN. The horizontal reference is at
   * worst 55 degrees from the tangent, so the cross product never gets shorter
   * than 0.8 and needs no guard.
   */
  private trunkFrame(anchor: Node, form: Node, deflect: Node, windDir: Node, t: Node): {
    origin: Node; tangent: Node; e1: Node; e2: Node;
  } {
    const height = anchor.w;
    const leanCos = form.x.cos().toVar();
    const leanSin = form.x.sin().toVar();
    const lean = vec3n(leanCos, 0, leanSin).toVar();
    const across = vec3n(leanSin.negate(), 0, leanCos).toVar();

    const t2 = t.mul(t).toVar();
    const origin = vec3n(anchor.x, anchor.y, anchor.z)
      .add(vec3(0, 1, 0).mul(height.mul(t)))
      .add(lean.mul(form.y.mul(t2)))
      .add(windDir.mul(deflect.mul(t2)))
      .toVar();

    // dP/dt, term by term. Analytic rather than differenced: the tangent is what
    // the ring, the cap and the whole crown are built on, and a differenced one
    // would put a kink in the trunk wherever the step landed.
    const slope = vec3(0, 1, 0)
      .mul(height)
      .add(lean.mul(form.y.mul(t).mul(2)))
      .add(windDir.mul(deflect.mul(t).mul(2)))
      .toVar();

    const tangent = slope.normalize().toVar();
    const e1 = across.cross(tangent).normalize().toVar();
    const e2 = tangent.cross(e1).toVar();
    return { origin, tangent, e1, e2 };
  }

  /**
   * Trunk and coconuts.
   *
   * `MeshStandardNodeMaterial` rather than the hand-lit `MeshBasicNodeMaterial`
   * that `Birds` and `Fish` use, and for a reason that does not apply to either
   * of them: a palm stands on the island among photogrammetry scans that are lit
   * by three's physical model, and a hand-lit tree next to PBR-lit rock reads as
   * pasted on however carefully the constants are matched. It also means
   * `receiveShadow` is not a lie.
   */
  private buildTrunkMaterial(): THREE.MeshStandardNodeMaterial {
    const material = new THREE.MeshStandardNodeMaterial();
    material.name = 'palm-trunk';
    material.metalness = 0;
    material.side = THREE.FrontSide;

    const anchor: Node = attribute('palmAnchor', 'vec4');
    const form: Node = attribute('palmForm', 'vec4');
    const crown: Node = attribute('palmCrown', 'vec4');
    const seed: Node = attribute('palmSeed', 'vec4');
    const mark: Node = attribute('palmPart', 'vec2');
    const p: Node = positionGeometry;
    const n: Node = normalGeometry;

    const wind = this.windTerms(anchor, seed);
    const isNut = mark.x.greaterThan(0.5);
    // Nuts hang off the crown base, so they ride the frame at the top of the
    // trunk whatever their own vertex says.
    const t = select(isNut, float(1), p.y).toVar();
    const frame = this.trunkFrame(anchor, form, this.crownDeflection(anchor, wind), wind.dir, t);

    // The crown rotation applies to the nuts and not to the trunk, which is what
    // `mark.x` is doing in the angle: one expression covers both parts and there
    // is no branch anywhere in the vertex stage.
    const spin = form.z.mul(mark.x).toVar();
    const cs = spin.cos().toVar();
    const sn = spin.sin().toVar();
    const scale = select(isNut, crown.z, form.w).toVar();
    const lift = select(isNut, p.y, float(0)).toVar();

    const px = p.x.mul(cs).sub(p.z.mul(sn)).toVar();
    const pz = p.x.mul(sn).add(p.z.mul(cs)).toVar();
    const nx = n.x.mul(cs).sub(n.z.mul(sn)).toVar();
    const nz = n.x.mul(sn).add(n.z.mul(cs)).toVar();

    const world = frame.origin
      .add(frame.e1.mul(px.mul(scale)))
      .add(frame.e2.mul(pz.mul(scale)))
      .add(frame.tangent.mul(lift.mul(scale)));
    const worldNormal = frame.e1.mul(nx).add(frame.e2.mul(nz)).add(frame.tangent.mul(n.y));

    // The helical leaf-scar phase, in whole scars. Built here rather than in the
    // fragment stage because the seam column carries `mark.y = 1` against the
    // first column's 0: the phase therefore steps by exactly one scar across the
    // seam, and a period-1 function of it is continuous there. Any non-integer
    // pitch puts a visible smear down one side of every trunk in the grove.
    const scar = t.mul(anchor.w).div(SCAR_SPACING).add(mark.y).toVar();

    material.positionNode = world;
    const shade: Node = varying(vec4(worldNormal, scar), 'palmTrunkShade');

    material.normalNode = cameraViewMatrix.mul(vec4(shade.xyz.normalize(), 0)).xyz;

    // `cos` rather than `fract`, so the pattern is smooth, band-limited and
    // immune to the seam. Raised to a power to pull it into a narrow groove:
    // a coconut trunk is mostly smooth column with a thin dark ring every 20 cm,
    // not a stack of alternating light and dark bands.
    const groove = shade.w.mul(TAU).cos().mul(0.5).add(0.5).pow(2.6).toVar();
    const height = p.y.clamp(0, 1).toVar();

    const tint = mix(vec3(0.88, 0.9, 0.94), vec3(1.12, 1.04, 0.94), seed.z);
    const bark = rgb(BARK_COLOR).mul(tint).toVar();
    const grooved = mix(bark, rgb(SCAR_COLOR).mul(tint), groove.mul(0.8)).toVar();
    // The foot of a palm is damp and algal for the first metre or so, which is
    // also the part a viewer standing on the beach is closest to.
    const foot = smoothstepDown(height, 0.02, 0.15).toVar();
    const weathered = mix(grooved, grooved.mul(vec3(0.6, 0.68, 0.52)), foot.mul(0.7)).toVar();

    material.colorNode = vec4(mix(weathered, rgb(HUSK_COLOR), mark.x), 1);
    // Bark is matte; a green husk is not. The difference is small and it is the
    // thing that stops the nuts reading as lumps of the same wood.
    material.roughnessNode = mix(float(0.93), float(0.62), mark.x);

    return material;
  }

  /**
   * The fronds.
   *
   * `DoubleSide`, because a leaflet is a sheet with no thickness and half the
   * crown is seen from underneath at any moment. The authored winding is
   * mirrored between the two sides of a frond precisely so that `faceDirection`
   * means "you are looking at the underside" rather than "the author guessed".
   */
  private buildFrondMaterial(): THREE.MeshStandardNodeMaterial {
    const material = new THREE.MeshStandardNodeMaterial();
    material.name = 'palm-frond';
    material.side = THREE.DoubleSide;
    material.metalness = 0;
    material.roughness = 0.55;

    const anchor: Node = attribute('palmAnchor', 'vec4');
    const form: Node = attribute('palmForm', 'vec4');
    const crown: Node = attribute('palmCrown', 'vec4');
    const seed: Node = attribute('palmSeed', 'vec4');
    const leaf: Node = attribute('palmFrond', 'vec2');
    const p: Node = positionGeometry;
    const n: Node = normalGeometry;

    const wind = this.windTerms(anchor, seed);
    const frame = this.trunkFrame(
      anchor, form, this.crownDeflection(anchor, wind), wind.dir, float(1),
    );

    const index = leaf.x.toVar();
    const count = crown.x.max(1).toVar();
    // Surplus fronds collapse onto the crown point. Degenerate triangles are
    // discarded before rasterisation, so an 18-frond palm costs 18 fronds of
    // fragments out of a 26-frond vertex buffer.
    const alive = select(index.lessThan(count), float(1), float(0)).toVar();
    // Age runs 0 on the newest frond to 1 on the oldest. Because the azimuth is
    // the golden angle times the same index, the crown is a genuine phyllotactic
    // spiral: the young spears are scattered through it rather than gathered on
    // one side, which is what a palm actually looks like from below.
    const age = index.add(0.5).div(count).clamp(0, 1).toVar();

    const phi = form.z.add(index.mul(GOLDEN_ANGLE)).toVar();
    const radial = frame.e1.mul(phi.cos()).add(frame.e2.mul(phi.sin())).toVar();
    // Unit by construction: `radial` lies in the plane `tangent` is normal to.
    const sideAxis = radial.cross(frame.tangent).toVar();

    const tilt = mix(float(TILT_YOUNG), float(TILT_OLD), age).toVar();
    const curl = mix(float(CURL_YOUNG), float(CURL_OLD), age).max(0.15).toVar();
    // Per-frond length variation, deterministic in the index and the palm's own
    // seed. A crown of identical fronds has a suspiciously circular outline.
    const length = crown.y
      .mul(index.mul(2.3).add(seed.z.mul(9.1)).sin().mul(0.08).add(1))
      .toVar();

    // The rachis arc. `theta` is the tangent angle, rotating steadily down the
    // frond; integrating it gives a circular arc of exactly `length`, closed
    // form. See `TILT_YOUNG`.
    const u = p.z.toVar();
    const theta = tilt.sub(curl.mul(u)).toVar();
    const invCurl = float(1).div(curl).toVar();
    const arcOut = length.mul(tilt.sin().sub(theta.sin())).mul(invCurl).toVar();
    const arcUp = length.mul(theta.cos().sub(tilt.cos())).mul(invCurl).toVar();

    // The rachis-local frame: `along` runs down the spine, `across` is its
    // normal in the frond's own vertical plane, `sideAxis` completes it.
    const along = radial.mul(theta.cos()).add(frame.tangent.mul(theta.sin())).toVar();
    const across = frame.tangent.mul(theta.cos()).sub(radial.mul(theta.sin())).toVar();

    // Older fronds hang harder. The leaflets of a spent frond fold down into a
    // near-vertical curtain, and it is most of what distinguishes the outside of
    // the crown from the inside.
    const droop = mix(float(0.6), float(1.3), age).toVar();
    const offset = radial
      .mul(arcOut)
      .add(frame.tangent.mul(arcUp))
      .add(sideAxis.mul(p.x.mul(length)))
      .add(across.mul(p.y.mul(droop).mul(length)))
      .toVar();

    // Wind, in three parts. The crown has already moved with the trunk, because
    // `frame.origin` is solved at t = 1 with the deflection in it — so what is
    // left here is the frond bending relative to its own base. Quadratic in `u`,
    // so the tip travels four times as far as the midpoint and the attachment
    // does not move at all; a linear falloff shears the whole frond sideways
    // and reads as the crown sliding off the trunk.
    const u2 = u.mul(u).toVar();
    const bend = length.mul(wind.bend).mul(FROND_BEND).mul(wind.gust.mul(0.6).add(0.4));
    const swing = length
      .mul(wind.bend)
      .mul(FROND_SWAY)
      .mul(this.uSway.add(seed.x).add(index.mul(0.9)).sin());
    const push = wind.dir.mul(u2.mul(bend.add(swing)));

    // Leaflet flutter, masked to the blades by `leaf.y` and travelling down the
    // frond because the phase carries a `u` term. This is the fast motion the
    // eye actually reads as wind — the trunk and the rachis are too slow to see
    // without something rattling on top of them.
    const flap = this.uFlutter
      .add(seed.y)
      .add(index.mul(2.1))
      .add(u.mul(4))
      .sin()
      .mul(leaf.y)
      .mul(length)
      .mul(LEAFLET_FLAP * LEAFLET_WIDTH)
      .mul(wind.flutter);

    const world = frame.origin.add(offset.add(push).add(across.mul(flap)).mul(alive));
    const worldNormal = sideAxis.mul(n.x).add(across.mul(n.y)).add(along.mul(n.z));

    material.positionNode = world;
    const vNormal: Node = varying(worldNormal, 'palmFrondNormal');

    const shaded = vNormal.normalize().mul(faceDirection);
    material.normalNode = cameraViewMatrix.mul(vec4(shaded, 0)).xyz;

    // --- albedo --------------------------------------------------------------
    const uu = p.z.clamp(0, 1).toVar();
    const ageF = leaf.x.add(0.5).div(crown.x.max(1)).clamp(0, 1).toVar();
    const green = mix(
      rgb(FROND_BASE_COLOR),
      rgb(FROND_TIP_COLOR),
      uu.smoothstep(0.15, 0.95),
    ).toVar();
    // Only the oldest fronds go dry, and they go from the tip inward. A crown
    // where every frond browns evenly reads as a dying tree.
    const dry = ageF.smoothstep(0.74, 1).mul(uu.smoothstep(0.35, 1)).toVar();
    const blade = mix(green, rgb(FROND_DRY_COLOR), dry.mul(0.85)).toVar();
    const tint = mix(vec3(0.86, 1.0, 0.9), vec3(1.12, 0.98, 0.86), seed.z);
    material.colorNode = vec4(blade.mul(tint), 1);

    // --- transmission --------------------------------------------------------
    //
    // Two terms. `back` is how far the sun is behind the face being shaded, and
    // it is what makes a backlit frond glow from any viewpoint; `toward` is how
    // nearly the viewer is looking into the sun through it, and it is what turns
    // that glow into the hard yellow-green flare that reads as a palm at sunset.
    // Masked by `leaf.y`, which is 0 on the rachis and 1 at a leaflet tip — the
    // spine is a 2 cm rod and does not transmit anything.
    const view = cameraPosition.sub(positionWorld).normalize().toVar();
    const back = shaded.dot(this.uSunDir).negate().max(0).toVar();
    const toward = view.dot(this.uSunDir).negate().max(0).pow(3).toVar();
    const glow = back
      .mul(toward.mul(0.75).add(0.25))
      .mul(leaf.y.smoothstep(0.05, 0.55))
      .mul(FROND_TRANSMISSION_GAIN)
      .mul(this.uSunGain);
    material.emissiveNode = rgb(FROND_TRANSMISSION).mul(this.uSunColor).mul(glow);

    return material;
  }
}

function clampPalmCount(count: number): number {
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.min(MAX_PALMS, Math.floor(count)));
}

/** Scratch for the grove bound. Construction-time only; never per frame. */
const _boundLo = new THREE.Vector3();
const _boundHi = new THREE.Vector3();

// ------------------------------------------------------------- palm placement

export interface PalmScatterOptions {
  /** Overrides the layout seed. */
  seed?: number;
  /** Centre of the search disc. Defaults to the island centre. */
  centreX?: number;
  centreZ?: number;
  /** Radius of the search disc, metres. Defaults to a margin past `ISLAND`. */
  radius?: number;
  /** Elevation band above mean sea level a palm will accept, metres. */
  minHeight?: number;
  maxHeight?: number;
  /** Steepest ground a palm will stand on, as a gradient (rise over run). */
  maxSlope?: number;
  /** Confines the scatter to an arc; omitted means all round the island. */
  bearing?: number;
  /** Half-width of that arc, radians. */
  spread?: number;
  /** Metres kept between trunks. */
  minSpacing?: number;
  /** Rejected samples per palm before that palm is given up on. */
  attempts?: number;
}

/**
 * Seeded palm positions along the shore, found by rejection sampling the
 * heightfield.
 *
 * Nothing here knows where the island's coast is, and that is the point: another
 * module is reshaping it, and every constant below is a *property* — how high
 * above the tide a coconut will grow, how steep a slope it will stand on, how
 * far apart two trunks have to be — rather than a coordinate. Feed the same
 * function a different island and it finds the new beach.
 *
 * The elevation band is what does the work. Sampling by radius alone puts palms
 * two metres underwater on one bearing and forty metres up a cliff on the next,
 * because the shoreline of a noise heightfield is not a circle; asking for
 * ground between 1.2 m and 11 m lands wherever that happens to be. The minimum
 * spacing is the other half — without it, two independent draws land in the same
 * square metre often enough to be the first thing anyone notices.
 *
 * Returned in seeded-random order, which is what makes `Palms.setCount` thin the
 * grove evenly instead of clipping off one end of the beach.
 */
export function scatterPalms(
  count: number,
  options: PalmScatterOptions = {},
): PalmPlacement[] {
  const random = mulberry32(options.seed ?? PALM_SEED ^ 0x5ca77e);
  const cx = options.centreX ?? ISLAND.x;
  const cz = options.centreZ ?? ISLAND.z;
  // A margin past the island's declared radius, because that constant is where
  // the *rise* has died out and the beach is a little inside it — and because
  // over-reaching costs a rejected sample while under-reaching silently loses
  // the shoreline if the island grows.
  const radius = options.radius ?? ISLAND.radius * 1.1;
  // A coconut grows down to the high-tide line and no lower; the upper bound
  // keeps the grove on the coastal flat instead of marching up the headland.
  const minHeight = options.minHeight ?? 1.2;
  const maxHeight = options.maxHeight ?? 11;
  const maxSlope = options.maxSlope ?? 0.42;
  const spread = options.spread ?? Math.PI;
  const bearing = options.bearing;
  const minSpacing = options.minSpacing ?? 5.5;
  const attempts = options.attempts ?? 48;

  const placements: PalmPlacement[] = [];
  const wanted = Math.max(0, Math.min(MAX_PALMS, Math.floor(count)));
  const spacingSq = minSpacing * minSpacing;

  for (let i = 0; i < wanted; i++) {
    for (let a = 0; a < attempts; a++) {
      const angle =
        bearing === undefined ? random() * TAU : bearing + (random() * 2 - 1) * spread;
      // Square-root radius, so the samples are uniform in *area* and do not pile
      // up at the island centre where there is no beach anyway.
      const r = Math.sqrt(random()) * radius;
      const x = cx + Math.cos(angle) * r;
      const z = cz + Math.sin(angle) * r;

      const y = seafloorHeight(x, z);
      if (y < minHeight || y > maxHeight) continue;

      const dx = seafloorHeight(x + 4, z) - seafloorHeight(x - 4, z);
      const dz = seafloorHeight(x, z + 4) - seafloorHeight(x, z - 4);
      if (Math.hypot(dx, dz) / 8 > maxSlope) continue;

      let clear = true;
      for (const other of placements) {
        const ox = other.x - x;
        const oz = other.z - z;
        if (ox * ox + oz * oz < spacingSq) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;

      placements.push({ x, z, y });
      break;
    }
  }

  return placements;
}

// ===========================================================================
// remains
// ===========================================================================

/**
 * Layout seed. Fixed, so it is the same skeleton every session — the mottled
 * staining and the scatter of loose bones are drawn from it, and a set piece
 * whose blotches move between loads is a set piece no screenshot baseline can
 * be compared against.
 */
const BONE_SEED = 0x5be1e7;

/**
 * How far the whole arrangement is sunk below the local sand, metres.
 *
 * Small on purpose. The burial is authored *into* the layout — the pelvis and
 * the lower ribs sit below y = 0 in the skeleton's own frame and the skull only
 * just clears it — rather than achieved by dropping a complete skeleton into the
 * ground, because sinking a whole body uniformly buries the parts that read
 * (the orbits, the mandible line) at the same rate as the parts that do not.
 */
const BONE_SINK = 0.03;

/** Half-width of the terrain sample the arrangement is levelled against. */
const BONE_GROUND_SPAN = 3;

/** Bone tessellation. Ribs are 15 mm across; five sides is plenty. */
const RIB_SIDES = 5;
const RIB_STATIONS = 9;
const LIMB_SIDES = 6;
const LIMB_STATIONS = 9;

/** Cranium tessellation. */
const SKULL_LON = 20;
const SKULL_LAT = 14;

/**
 * Bone colour, in three states, because a uniform bone-white plastic look is the
 * failure mode here and one albedo cannot avoid it.
 *
 * `BONE_CLEAN` is sun-bleached cortical bone — off-white with a warm cast, never
 * pure white; nothing in nature is, and 1.0 albedo under a 3.2-intensity sun
 * clips to a white silhouette with no form in it at all. `BONE_STAINED` is what
 * a decade in wet sand does: the mineral takes up iron and the buried half comes
 * out ochre. `BONE_CAVITY` is not a pigment at all, it is the ambient occlusion
 * of a hole — the orbits, the nasal aperture and the shadowed inner faces of the
 * ribs, baked as a vertex channel because a 20-segment sphere has no way to
 * cast a shadow into its own eye socket.
 */
const BONE_CLEAN = new THREE.Color(0.78, 0.75, 0.67);
const BONE_STAINED = new THREE.Color(0.46, 0.38, 0.26);
const BONE_CAVITY = new THREE.Color(0.1, 0.085, 0.07);

/**
 * Light that comes through the thin edges of bone, and how much of it there is.
 *
 * Cortical bone a couple of millimetres thick genuinely passes light, and it is
 * warm and orange when it does — which is exactly what stops the close look from
 * resolving into painted plastic. Driven by a Fresnel term, so it appears only
 * at grazing angles where the path through the material is short: the rim of the
 * cranium, the edge of a rib, the thin arch of the zygomatic. Weaker than the
 * fronds' by a factor of four, because bone is not a leaf.
 */
const BONE_TRANSMISSION = new THREE.Color(0.95, 0.55, 0.34);
const BONE_TRANSMISSION_GAIN = 0.2;

/**
 * The tide line, in the skeleton's own frame.
 *
 * `place` seats local y = 0 at `BONE_SINK` below the sand, so the sand surface
 * is at local `+BONE_SINK` and these two straddle it: clean above 6 cm, fully
 * stained at 0, and a 6 cm gradient across the middle. The gradient is the
 * whole trick. Bone that has sat half in wet sand has a *line* on it, and the
 * line is what says "buried" rather than "dropped here this morning" — a
 * uniformly stained skeleton and a uniformly clean one fail the same way.
 */
const STAIN_TOP = 0.06;
const STAIN_BOTTOM = 0;

export interface RemainsOptions {
  /** Overrides the layout and mottling seed. */
  seed?: number;
}

const _boneMatrix = new THREE.Matrix4();
const _boneEuler = new THREE.Euler();
const _boneQuat = new THREE.Quaternion();
const _bonePos = new THREE.Vector3();
const _boneScale = new THREE.Vector3(1, 1, 1);
const _bonePath = new THREE.Vector3();

/** Composes a placement matrix for one bone, in the skeleton's own frame. */
function bonePlace(
  x: number, y: number, z: number,
  rx: number, ry: number, rz: number,
): THREE.Matrix4 {
  _bonePos.set(x, y, z);
  _boneEuler.set(rx, ry, rz, 'YXZ');
  _boneQuat.setFromEuler(_boneEuler);
  return _boneMatrix.compose(_bonePos, _boneQuat, _boneScale);
}

/**
 * How stained a vertex at local height `y` is. See `STAIN_TOP`.
 *
 * Sampled from the *authored* height rather than the world height, so the tide
 * line survives the whole arrangement being tilted onto a slope — which is
 * correct, because the sand it was buried in tilted with it.
 */
function burialStain(y: number, mottle: number): number {
  const t = clamp01((STAIN_TOP - y) / (STAIN_TOP - STAIN_BOTTOM));
  const smooth = t * t * (3 - 2 * t);
  // Mottling on top of it, or the line reads as a dip-dye. Weighted so it can
  // only ever add stain to a clean bone and never bleach a buried one.
  return clamp01(smooth * 0.82 + mottle * 0.28 * (1 - smooth * 0.5));
}

/**
 * The long-bone radius profile: bulbous at both ends, waisted in the middle.
 *
 * `s` runs 0 to 1 along the shaft. This is the single shape that makes a tapered
 * tube read as a femur rather than as a stick — the epiphyses are nearly twice
 * the diameter of the diaphysis, and it is the only anatomical detail visible on
 * a leg bone from more than two metres away.
 */
function limbProfile(s: number, shaft: number, endGain: number): number {
  const ends = Math.pow(Math.abs(s * 2 - 1), 2.4);
  return shaft * (1 + (endGain - 1) * ends);
}

/** Straight-line path between two points, for the limb sweeps. */
function segment(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
): PathPoint {
  return (s, out) => out.set(x0 + (x1 - x0) * s, y0 + (y1 - y0) * s, z0 + (z1 - z0) * s);
}

/**
 * Frame references for the sweeps. See `tube`: the reference only has to stay
 * away from parallel with the tangent, and picking it per bone group rather than
 * transporting a frame keeps every tube's seam in a predictable place.
 */
const _boneRefY = new THREE.Vector3(0, 1, 0);
const _boneRefZ = new THREE.Vector3(0, 0, 1);

const _skullDir = new THREE.Vector3();
const _orbitR = new THREE.Vector3(0.4, 0.03, 0.92).normalize();
const _orbitL = new THREE.Vector3(-0.4, 0.03, 0.92).normalize();
const _nasal = new THREE.Vector3(0, -0.3, 0.95).normalize();

/** Hermite ramp, 1 inside `inner` and 0 outside `outer`. */
function falloff(d: number, inner: number, outer: number): number {
  const t = clamp01((outer - d) / (outer - inner));
  return t * t * (3 - 2 * t);
}

/**
 * How deep the skull surface is pushed in at direction `n`, and how much of a
 * cavity it is.
 *
 * Three recesses, and only three, because they are the three that make a lump of
 * bone read instantly as a skull: the two orbits and the nasal aperture. The
 * measure is the *tangential* distance from each recess's axis, with the
 * vertical component scaled so the orbits come out wider than they are tall —
 * a circular socket reads as a cartoon.
 *
 * Displacement and darkening come out of the same function because they have to
 * agree: a socket that is geometrically deep but shaded like the brow beside it
 * disappears the moment the sun is anywhere but behind the viewer, and a socket
 * that is painted dark but not sunk is a decal.
 */
function skullRecess(n: THREE.Vector3): { depth: number; cavity: number } {
  let depth = 0;
  let cavity = 0;

  for (const axis of [_orbitR, _orbitL]) {
    const along = n.dot(axis);
    if (along <= 0) continue;
    // Tangential offset from the socket axis, with the vertical squashed so the
    // socket is an ellipse lying on its side.
    const tx = n.x - axis.x * along;
    const ty = (n.y - axis.y * along) * 1.3;
    const tz = n.z - axis.z * along;
    const e = Math.hypot(tx, ty, tz);
    const m = falloff(e, 0.16, 0.44);
    depth += 0.021 * m;
    cavity = Math.max(cavity, m);
  }

  const nasalAlong = n.dot(_nasal);
  if (nasalAlong > 0) {
    // Narrow and tall, unlike the orbits — the aperture is a keyhole.
    const tx = (n.x - _nasal.x * nasalAlong) * 2.8;
    const ty = (n.y - _nasal.y * nasalAlong) * 0.9;
    const tz = (n.z - _nasal.z * nasalAlong) * 2.8;
    const m = falloff(Math.hypot(tx, ty, tz), 0.05, 0.34);
    depth += 0.016 * m;
    cavity = Math.max(cavity, m * 0.9);
  }

  return { depth, cavity };
}

/**
 * The cranium: a sphere with a face pulled out of the front of it.
 *
 * Authored with +Z anterior and +Y superior, in metres, at life size — a human
 * cranium is 19 cm long, 15 wide and 14 tall, and getting that right matters
 * more than any amount of surface detail, because the viewer has a very
 * accurate idea of how big a skull is and will read a wrong one as a prop.
 *
 * The deformations, in the order they are applied:
 *  - the neurocranium as a tri-axial ellipsoid;
 *  - the face pulled forward and down, and narrowed, which is the whole of the
 *    maxilla — a separate mesh for it would double the vertex count for a shape
 *    that is continuous with the cranium anyway;
 *  - the cranial base flattened, so the skull sits on sand instead of rocking;
 *  - the temporal fossae hollowed, which is what puts the corner in the
 *    silhouette between the brow and the ear;
 *  - the orbits and the nasal aperture, from `skullRecess`.
 */
function addCranium(md: MeshData, place: THREE.Matrix4): void {
  md.setMatrix(place);
  lathe(
    md,
    SKULL_LON,
    SKULL_LAT,
    (u, v, out) => {
      const phi = u * TAU;
      const theta = v * Math.PI;
      const st = Math.sin(theta);
      _skullDir.set(Math.cos(phi) * st, Math.cos(theta), Math.sin(phi) * st);
      const n = _skullDir;

      let x = n.x * 0.0735;
      let y = n.y * 0.0700;
      let z = n.z * 0.0930;

      const face = clamp01((n.z - 0.1) / 0.55) * clamp01((-n.y + 0.05) / 0.6);
      z += face * 0.026;
      y -= face * 0.034;
      x *= 1 - face * 0.3;

      // The cranial base is nearly flat and the occiput is not a hemisphere.
      if (y < -0.049) y = -0.049 - (y + 0.049) * 0.25;

      const temple = clamp01((Math.abs(n.x) - 0.68) / 0.3) * falloff(Math.abs(n.y - 0.1), 0.1, 0.5);
      x *= 1 - temple * 0.11;

      const recess = skullRecess(n);
      out.set(x - n.x * recess.depth, y - n.y * recess.depth, z - n.z * recess.depth);
    },
    (u, v) => {
      const phi = u * TAU;
      const theta = v * Math.PI;
      const st = Math.sin(theta);
      _skullDir.set(Math.cos(phi) * st, Math.cos(theta), Math.sin(phi) * st);
      return [0, skullRecess(_skullDir).cavity];
    },
  );
  md.setMatrix(null);
}

/**
 * The dental arch, shared by the mandible and the tooth rows.
 *
 * `t` runs -1 at the left condyle through 0 at the chin to +1 at the right. The
 * arch is a parabola in plan and the ramus rises only over the last quarter,
 * which is what gives the jaw its L-shaped profile rather than a banana's.
 */
function jawPoint(t: number, out: THREE.Vector3): THREE.Vector3 {
  const a = Math.abs(t);
  const rise = clamp01((a - 0.72) / 0.28);
  return out.set(
    t * 0.051,
    -0.026 + rise * rise * (3 - 2 * rise) * 0.062,
    0.052 - a * a * 0.105,
  );
}

/** The mandible, plus the two tooth rows it and the maxilla carry. */
function addJaw(md: MeshData, place: THREE.Matrix4): void {
  md.setMatrix(place);

  tube(
    md,
    (s, out) => jawPoint(s * 2 - 1, out),
    // Thinner at the condyles than at the body, and the body is the part the
    // silhouette is made of.
    (s) => 0.0135 * (1 - 0.3 * Math.abs(s * 2 - 1)),
    15,
    6,
    _boneRefZ,
    () => [0, 0.12],
  );

  // Teeth, on both jaws. Sixteen small nubs is a lot of draw for a 4 cm arch,
  // and it is the single most recognisable thing on a skull at arm's length —
  // a jaw modelled as a smooth tube reads as a horseshoe of driftwood.
  for (const upper of [false, true] as const) {
    for (let i = 0; i < 7; i++) {
      const t = (i / 6) * 2 - 1;
      jawPoint(t * 0.86, _bonePath);
      const baseY = _bonePath.y + (upper ? 0.031 : 0.006);
      const dir = upper ? -1 : 1;
      const x = _bonePath.x * 0.9;
      const z = _bonePath.z * 0.94;
      tube(
        md,
        segment(x, baseY, z, x, baseY + dir * 0.011, z),
        (s) => 0.0046 - s * 0.0014,
        2,
        4,
        _boneRefZ,
        // Teeth are enamel, not bone: paler and far less stained than the jaw
        // they sit in, which is why they are the last thing to disappear.
        () => [-0.55, 0],
      );
    }
  }

  md.setMatrix(null);
}

/**
 * The spine and the ribcage, lying supine with the lower half in the sand.
 *
 * Each rib is an elliptical arc in the body's cross-section, swept from the
 * vertebra at the bottom — the spine is the *lowest* part of a body on its back,
 * which is why the cage reads as a row of hoops coming up out of the sand rather
 * than as a basket sitting on it — up the side and over toward the sternum. The
 * radius falls by 40% along the way, because a rib genuinely does thin as it
 * curves forward and it is the only thing that keeps twelve identical arcs from
 * looking machined.
 *
 * Three ribs are missing and one is short. That is the difference between
 * remains and an anatomical model: something ate here.
 */
function addTorso(md: MeshData, random: () => number): void {
  // The spine. Buried, with only the transverse processes breaking the sand, so
  // its job is to be the thing the ribs are obviously attached to.
  tube(
    md,
    (s, out) => out.set(0, -0.024 + Math.sin(s * Math.PI) * 0.012, 0.1 + s * 0.56),
    // Six lobes along the length, which at this station count reads as
    // segmentation rather than as a smooth pipe. Not twelve: at four stations a
    // cycle the higher count aliases into a beat pattern.
    (s) => 0.0195 + 0.0055 * Math.cos(s * 6 * TAU),
    21,
    5,
    _boneRefY,
    () => [0.25, 0.15],
  );

  const missing = new Set(['1:-1', '3:1', '5:-1']);
  for (let k = 0; k < 6; k++) {
    for (const side of [1, -1]) {
      if (missing.has(`${k}:${side}`)) continue;
      const shortened = k === 2 && side === 1;
      const z0 = 0.52 - k * 0.058;
      // The cage is widest at the fourth rib and tapers both ways.
      const w = 0.108 + 0.036 * Math.sin((Math.PI * (k + 0.9)) / 7);
      const h = 0.086 + 0.012 * Math.sin((Math.PI * (k + 0.9)) / 7);
      // Lower ribs are floating: they stop well short of the midline in front.
      const arc = (shortened ? 1.5 : 2.62 - k * 0.16) as number;

      tube(
        md,
        (s, out) => {
          const ang = -1.5 + s * arc;
          out.set(side * w * Math.cos(ang), 0.062 + h * Math.sin(ang), z0 - s * 0.05);
        },
        (s) => 0.0102 * (1 - 0.42 * s),
        RIB_STATIONS,
        RIB_SIDES,
        _boneRefZ,
        // The vertebral end sits deep inside the cage and inside the sand; the
        // sternal end is out in the light.
        (s) => [0, 0.3 * (1 - clamp01(s * 2.2))],
      );
    }
  }

  // The pelvis: two blades, sunk almost to the crest. Flattened ellipsoids
  // rather than anything anatomical — from anywhere a viewer can stand, an
  // ilium is a curved plate, and this is a curved plate.
  for (const side of [1, -1]) {
    md.setMatrix(bonePlace(side * 0.082, -0.012, 0.095, 0.18, side * 0.5, side * -0.35));
    lathe(
      md,
      9,
      6,
      (u, v, out) => {
        const phi = u * TAU;
        const theta = v * Math.PI;
        const st = Math.sin(theta);
        out.set(Math.cos(phi) * st * 0.026, Math.cos(theta) * 0.082, Math.sin(phi) * st * 0.062);
      },
      () => [0.1, 0.1],
    );
    md.setMatrix(null);
  }

  // Loose bones — phalanges, a shed vertebra, a fragment. Scattered rather than
  // arranged, and drawn from the seeded stream so the scatter is the same one
  // every session.
  for (let i = 0; i < 11; i++) {
    const ang = random() * TAU;
    const r = 0.18 + Math.sqrt(random()) * 0.55;
    const x = Math.cos(ang) * r * 1.15;
    const z = 0.28 + Math.sin(ang) * r;
    const len = 0.022 + random() * 0.05;
    const lie = random() * TAU;
    const y = 0.004 + random() * 0.032;
    // Drawn here and not inside the profile callback: the callback runs once a
    // station, so a draw in there would give the bone a randomly lumpy radius
    // and would make the PRNG's position depend on the tessellation.
    const thickness = 0.0062 + random() * 0.002;
    tube(
      md,
      segment(x, y, z, x + Math.cos(lie) * len, y + 0.004, z + Math.sin(lie) * len),
      (s) => limbProfile(s, thickness, 1.5),
      5,
      5,
      _boneRefY,
      () => [0.18, 0],
    );
  }
}

/**
 * Arms and legs, arranged as a fall rather than as a diagram.
 *
 * Every joint is a coincident endpoint rather than a real articulation, which is
 * exactly what a body that has been lying in sand for years looks like: the
 * cartilage is long gone and the bones have settled into contact. The asymmetry
 * is the point — one leg is straight and one is folded out sideways, one arm is
 * thrown up past the head and the other has dropped across the chest. A
 * symmetric skeleton reads as a display case.
 */
function addLimbs(md: MeshData): void {
  const bones: ReadonlyArray<readonly [number, number, number, number, number, number, number, number]> = [
    // x0, y0, z0, x1, y1, z1, shaft radius, epiphysis gain
    [0.085, 0.014, 0.075, 0.2, 0.026, -0.34, 0.0155, 1.9], // right femur
    [0.2, 0.026, -0.34, 0.162, 0.012, -0.7, 0.0132, 1.85], // right tibia, sinking at the ankle
    [-0.09, 0.01, 0.07, -0.27, 0.024, -0.24, 0.0155, 1.9], // left femur, flung out
    [-0.27, 0.024, -0.24, -0.15, 0.004, -0.57, 0.0132, 1.85], // left tibia, folded back and under
    [0.145, 0.026, 0.5, 0.33, 0.03, 0.65, 0.0125, 1.7], // right humerus, thrown up past the head
    [0.33, 0.03, 0.65, 0.45, 0.008, 0.86, 0.0092, 1.65], // right ulna, hand lost in the sand
    [-0.15, 0.048, 0.49, -0.06, 0.052, 0.28, 0.0125, 1.7], // left humerus, across the chest
  ];

  for (const [x0, y0, z0, x1, y1, z1, shaft, gain] of bones) {
    tube(
      md,
      segment(x0, y0, z0, x1, y1, z1),
      (s) => limbProfile(s, shaft, gain),
      LIMB_STATIONS,
      LIMB_SIDES,
      _boneRefY,
      () => [0, 0],
    );
  }
}

/**
 * The whole arrangement, baked into one geometry and therefore one draw.
 *
 * The stain is applied here, after everything is placed, because it is a
 * function of where a vertex ended up relative to the sand and not of which bone
 * it belongs to. `channel[0]` up to this point is a per-part *bias* — negative on
 * the teeth, positive on the parts that spent their whole time buried — which
 * this pass adds to the burial gradient rather than replacing.
 */
function buildRemainsGeometry(seed: number): THREE.BufferGeometry {
  const md = new MeshData();
  const random = mulberry32(seed);

  // Blotch phases, drawn before anything else so the layout stays stable if the
  // skeleton later gains a bone.
  const p0 = random() * TAU;
  const p1 = random() * TAU;
  const p2 = random() * TAU;
  const p3 = random() * TAU;

  // The head has rolled to one side and the jaw has dropped away from it, which
  // is what a mandible does once the muscle is gone. Between them they are the
  // silhouette: the cranium is barely proud of the sand, and what the eye
  // catches first is the dark of the orbits and the open line of the jaw.
  addCranium(md, bonePlace(0.03, 0.055, 0.74, -0.35, 0.75, 0.3));
  // The mandible has dropped away from the cranium and turned a little further
  // than it did — which is what a jaw does once the muscle holding it is gone,
  // and it is the reason the gap between the two rows of teeth reads as a mouth
  // rather than as a modelling seam. It also sits lower, so the chin is under
  // the sand and the ramus is not: the jaw line is half of the silhouette.
  addJaw(md, bonePlace(0.055, 0.022, 0.775, -0.18, 0.9, 0.22));
  addTorso(md, random);
  addLimbs(md);

  const bias = md.channel;
  const pos = md.position;
  for (let i = 0; i < md.vertexCount; i++) {
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    // Two octaves of smooth blotching at roughly 0.9 m and 0.45 m, which is the
    // scale sediment staining actually comes in. White noise per vertex would be
    // cheaper and would read as dirt on the lens.
    const mottle = clamp01(
      0.5 +
        0.5 * (Math.sin(x * 7.3 + p0) * Math.sin(z * 6.1 + p1) * 0.62 +
               Math.sin(x * 13.7 + p2) * Math.sin(y * 11.3 + p3) * 0.38),
    );
    bias[i * 2] = clamp01(burialStain(y, mottle) + bias[i * 2]);
  }

  const geometry = md.toGeometry('boneTint', false);
  geometry.name = 'remains';
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

/**
 * A pirate's remains, half-buried in the sand: one mesh, one draw, ~3,400
 * triangles.
 *
 * Deliberately *not* an instanced field. There is one of these in the world and
 * the whole point of it is that it rewards walking up to it, so the budget goes
 * on the things that survive a close look — the orbits, the tooth row, ribs that
 * thin as they curve — rather than on making it cheap to repeat. At this size
 * that is 3,400 triangles, which is a twentieth of one of the photogrammetry
 * rocks `Props` scatters ninety of.
 *
 * There is no clock and nothing to animate: bones do not move. `place` seats the
 * whole arrangement on `seafloorHeight` and levels it to the local slope, so it
 * follows the island wherever the island goes.
 */
export class Remains {
  readonly object: THREE.Object3D;

  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshStandardNodeMaterial;
  private readonly mesh: THREE.Mesh;
  private disposed = false;

  private readonly uSunDir = uniform(new THREE.Vector3(0.35, 0.62, 0.7).normalize());
  private readonly uSunColor = uniform(new THREE.Color(1, 0.96, 0.9));
  private readonly uSunGain = uniform(1);

  constructor(options: RemainsOptions = {}) {
    this.geometry = buildRemainsGeometry(options.seed ?? BONE_SEED);
    this.material = this.buildMaterial();

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'remains';
    // Set as the object deserves rather than as today's shadow camera is framed;
    // see the same note on `Palms`. A skull with no contact shadow floats, and
    // the contact shadow is most of what says "half-buried".
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = true;

    this.object = new THREE.Object3D();
    this.object.name = 'remains';
    this.object.add(this.mesh);
  }

  /**
   * Seats the remains on the sand at (x, z).
   *
   * The whole arrangement is levelled to the local ground normal, taken from a
   * `BONE_GROUND_SPAN`-wide sample of the same heightfield the floor mesh is
   * built from — so a body on a slope lies along it instead of having one hip in
   * the air and the other underground. `yaw` turns the body about its own axis;
   * 0 puts the head toward +z.
   *
   * Nothing here assumes where the beach is. Hand it a point and it will find
   * the ground under it.
   */
  place(x: number, z: number, yaw = 0): void {
    if (this.disposed) return;
    const span = BONE_GROUND_SPAN;
    const dx = (seafloorHeight(x + span, z) - seafloorHeight(x - span, z)) / (2 * span);
    const dz = (seafloorHeight(x, z + span) - seafloorHeight(x, z - span)) / (2 * span);
    _boneNormal.set(-dx, 1, -dz).normalize();

    this.object.position.set(x, seafloorHeight(x, z) - BONE_SINK, z);
    this.object.quaternion.setFromUnitVectors(_boneUp, _boneNormal);
    this.object.quaternion.multiply(_boneSpin.setFromAxisAngle(_boneUp, yaw));
    this.object.updateMatrix();
    this.object.updateMatrixWorld(true);
  }

  setVisible(v: boolean): void {
    this.object.visible = v;
  }

  /**
   * The sun, for the thin-edge translucency. `direction` points toward the sun.
   *
   * Optional, like `Palms.setSun` and for the same reason: the default is a
   * defensible mid-morning sun, so a caller that never wires this gets a
   * skeleton that looks right rather than one that looks broken.
   */
  setSun(direction: THREE.Vector3, color?: THREE.Color): void {
    const sun = this.uSunDir.value as THREE.Vector3;
    sun.copy(direction);
    if (sun.lengthSq() < 1e-8) sun.set(0, 1, 0);
    sun.normalize();
    this.uSunGain.value = sunGainFor(sun);
    if (color) (this.uSunColor.value as THREE.Color).copy(color);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.remove(this.mesh);
    this.object.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }

  // ------------------------------------------------------------------ internals

  private buildMaterial(): THREE.MeshStandardNodeMaterial {
    const material = new THREE.MeshStandardNodeMaterial();
    material.name = 'bone';
    material.metalness = 0;

    const tint: Node = attribute('boneTint', 'vec2');
    const stain: Node = tint.x.clamp(0, 1);
    const cavity: Node = tint.y.clamp(0, 1);

    // Three tones, not one. See `BONE_CLEAN`: a single albedo is precisely the
    // uniform-plastic failure this is written to avoid, and the cavity term is
    // doing the job a shadow cannot — a 20-segment sphere has no way to occlude
    // its own eye socket.
    const base = mix(rgb(BONE_CLEAN), rgb(BONE_STAINED), stain).toVar();
    const albedo: Node = mix(base, rgb(BONE_CAVITY), cavity.mul(0.85));
    material.colorNode = vec4(albedo, 1);
    // Bleached bone is chalky; sand-stained bone is chalkier still. Neither is
    // anywhere near smooth, and a glossy skull is a plastic one.
    material.roughnessNode = mix(float(0.6), float(0.88), stain);

    // No custom `positionNode` or `normalNode` here — nothing deforms — so the
    // standard `normalWorld` is the real surface normal and can be used directly.
    const view = cameraPosition.sub(positionWorld).normalize().toVar();
    const nrm: Node = normalWorld;
    // Grazing angles only: that is where the path through the material is short
    // enough for anything to get through, and it is why this shows up on the rim
    // of the cranium and the edge of a rib and nowhere else.
    const rim = float(1).sub(nrm.dot(view).abs()).pow(2.6).toVar();
    const lit = nrm.dot(this.uSunDir).negate().max(0).mul(0.6).add(0.4).toVar();
    material.emissiveNode = rgb(BONE_TRANSMISSION)
      .mul(this.uSunColor)
      .mul(rim.mul(lit).mul(cavity.oneMinus()).mul(BONE_TRANSMISSION_GAIN).mul(this.uSunGain));

    return material;
  }
}

const _boneNormal = new THREE.Vector3();
const _boneUp = new THREE.Vector3(0, 1, 0);
const _boneSpin = new THREE.Quaternion();
