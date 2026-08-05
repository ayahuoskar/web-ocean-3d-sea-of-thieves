import * as THREE from 'three/webgpu';
import { vertexSpacingPerMetre } from './meshSampling';

export interface OceanMeshOptions {
  /** Vertices along the radial axis. */
  radialSegments: number;
  /** Vertices around the circle. */
  angularSegments: number;
  /** Radius of the innermost ring, metres. */
  innerRadius: number;
  /** Radius of the outermost ring, metres — must reach past the horizon. */
  outerRadius: number;
}

export const DEFAULT_MESH_OPTIONS: OceanMeshOptions = {
  radialSegments: 320,
  angularSegments: 512,
  innerRadius: 0.6,
  outerRadius: 24000,
};

/**
 * Camera-centred radial grid.
 *
 * Chosen over nested clipmap rings because it has no inter-level seams to crack
 * under vertical displacement and no popping as levels swap — both are very
 * visible on a water surface, where a seam reads as a tear in the horizon. Ring
 * radii grow geometrically, which keeps roughly constant *screen-space* triangle
 * size from the camera out to the horizon.
 *
 * The mesh is re-centred on the camera every frame but deliberately NOT rotated
 * with it: the wave field is sampled in world space, so a rotating grid would
 * make the tessellation pattern swim through the waves.
 *
 * Vertex positions are world metres about the mesh origin, and the mesh origin
 * is snapped to the camera every frame — so a vertex's own XZ length is its
 * ground distance from the viewer, which is what the vertex stage's level of
 * detail is computed from.
 */
export class OceanMesh {
  readonly geometry: THREE.BufferGeometry;
  readonly mesh: THREE.Mesh;
  /**
   * Metres of vertex spacing per metre of ground distance — the worse of the
   * two axes. The vertex stage needs it to decide how much of the wave field
   * this mesh is entitled to be displaced by; see `ocean/meshSampling`.
   */
  readonly spacingPerMetre: number;
  private readonly options: OceanMeshOptions;

  constructor(material: THREE.Material, options: Partial<OceanMeshOptions> = {}) {
    this.options = { ...DEFAULT_MESH_OPTIONS, ...options };
    this.spacingPerMetre = vertexSpacingPerMetre(
      this.options.radialSegments,
      this.options.angularSegments,
      this.options.innerRadius,
      this.options.outerRadius,
    );
    this.geometry = buildRadialGrid(this.options);
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false; // it is always centred on the viewer
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 0;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'ocean-surface';
  }

  /**
   * Snaps the grid to the camera. Quantising to whole metres stops the innermost
   * triangles from shimmering as the camera creeps: without it, sub-texel motion
   * of the grid against a static wave field produces a crawling moiré.
   */
  recenter(cameraPosition: THREE.Vector3): void {
    const x = Math.floor(cameraPosition.x);
    const z = Math.floor(cameraPosition.z);
    this.mesh.position.set(x, 0, z);
    this.mesh.updateMatrix();
  }

  get triangleCount(): number {
    return (this.geometry.getIndex()?.count ?? 0) / 3;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

function buildRadialGrid(options: OceanMeshOptions): THREE.BufferGeometry {
  const { radialSegments, angularSegments, innerRadius, outerRadius } = options;

  const ringCount = radialSegments + 1;
  const vertexCount = ringCount * angularSegments + 1; // +1 for the centre cap
  const positions = new Float32Array(vertexCount * 3);
  // Normalised radial coordinate, handed to the shader for distance-based fades.
  const radialParam = new Float32Array(vertexCount);

  // Centre vertex.
  positions[0] = 0;
  positions[1] = 0;
  positions[2] = 0;
  radialParam[0] = 0;

  const growth = Math.pow(outerRadius / innerRadius, 1 / radialSegments);

  let write = 1;
  for (let ring = 0; ring < ringCount; ring++) {
    const radius = innerRadius * Math.pow(growth, ring);
    const t = ring / radialSegments;
    for (let seg = 0; seg < angularSegments; seg++) {
      const angle = (seg / angularSegments) * Math.PI * 2;
      positions[write * 3 + 0] = Math.cos(angle) * radius;
      positions[write * 3 + 1] = 0;
      positions[write * 3 + 2] = Math.sin(angle) * radius;
      radialParam[write] = t;
      write++;
    }
  }

  const quadCount = radialSegments * angularSegments;
  const indexCount = angularSegments * 3 + quadCount * 6;
  const indices = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);

  let cursor = 0;
  // Centre fan.
  for (let seg = 0; seg < angularSegments; seg++) {
    const next = (seg + 1) % angularSegments;
    indices[cursor++] = 0;
    indices[cursor++] = 1 + next;
    indices[cursor++] = 1 + seg;
  }

  // Concentric quad bands.
  for (let ring = 0; ring < radialSegments; ring++) {
    const inner = 1 + ring * angularSegments;
    const outer = 1 + (ring + 1) * angularSegments;
    for (let seg = 0; seg < angularSegments; seg++) {
      const next = (seg + 1) % angularSegments;
      const a = inner + seg;
      const b = inner + next;
      const c = outer + next;
      const d = outer + seg;
      indices[cursor++] = a;
      indices[cursor++] = c;
      indices[cursor++] = b;
      indices[cursor++] = a;
      indices[cursor++] = d;
      indices[cursor++] = c;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('radialParam', new THREE.BufferAttribute(radialParam, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // A fixed, generous bound — the mesh follows the camera and is never culled.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), outerRadius);
  return geometry;
}
