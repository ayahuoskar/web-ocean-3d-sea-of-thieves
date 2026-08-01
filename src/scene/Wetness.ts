import * as THREE from 'three/webgpu';

/**
 * Rain wetting for loaded glTF surfaces.
 *
 * Two things happen to a surface under rain, and both are cheap to express:
 *
 * **It darkens.** A water film is optically thicker than air, so light that
 * scatters out of the substrate is more likely to be reflected back into it at
 * the film's top surface and absorbed on a second pass. The albedo a viewer
 * measures therefore falls, typically by a third to a half on porous materials
 * like wood and canvas — which is most of this ship.
 *
 * **It gets glossier.** The film fills the microfacet valleys, so the effective
 * roughness collapses toward that of a flat water surface. This is what actually
 * reads as "wet" — the darkening alone looks like a lighting change.
 *
 * Both are scalar multipliers on `MeshStandardMaterial`, and three multiplies
 * `color` by `map` and `roughness` by `roughnessMap.g` in its standard shading.
 * So scaling the scalars composes correctly with the glTF's textures, needs no
 * node-graph edit, and cannot trigger a shader recompile mid-session — which
 * rules it out of the in-gameplay compile budget by construction.
 *
 * **What this does not do.** Wetness is uniform over the object. A real hull
 * wets from above: the deck and the weather side soak while the underside of a
 * beam stays dry, and water runs down and pools. Expressing that needs the world
 * normal, which means a node graph per material and a rebuild of materials the
 * asset loader shares between clones. The uniform version is the honest 80%: a
 * ship that visibly darkens and gleams in a squall and dries out afterwards.
 */

/** Roughness a fully wetted surface tends toward. Flat water is ~0.05. */
const WET_ROUGHNESS = 0.09;

/** Fraction of its dry albedo a fully wetted surface keeps. */
const WET_ALBEDO = 0.58;

/**
 * Time constants, seconds.
 *
 * Deliberately asymmetric, because the physics is. A surface wets as fast as
 * rain lands on it — a few seconds in any real downpour — and then dries by
 * evaporation, which at sea, in wind, still takes the better part of a minute.
 * Equal constants make rain look like a switch.
 */
const WET_TAU = 3.5;
const DRY_TAU = 26;

interface Tracked {
  material: THREE.MeshStandardMaterial;
  roughness: number;
  color: THREE.Color;
}

export class SurfaceWetness {
  private readonly tracked: Tracked[] = [];
  private wetness = 0;
  /** Materials are shared between clones; adopting one twice would double-apply. */
  private readonly seen = new Set<THREE.Material>();

  /**
   * Adopts every standard material under `root`.
   *
   * Safe to call for several roots — the ship and the props share materials
   * through the asset loader's cache, and adopting a material twice would take
   * the already-darkened colour as its dry reference and walk it to black over
   * repeated calls.
   */
  adopt(root: THREE.Object3D): void {
    root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (this.seen.has(material)) continue;
        this.seen.add(material);
        const standard = material as THREE.MeshStandardMaterial;
        // Duck-typed, not flag-tested. The asset loader converts every glTF
        // material to `MeshPhysicalNodeMaterial`, which sets
        // `isMeshPhysicalNodeMaterial` and *not* `isMeshStandardMaterial` — so a
        // check against the classic flag silently adopts nothing, and the effect
        // is wired, tested for existence, and completely inert. What this needs
        // is a numeric `roughness` and a `Color`, so that is what it asks for.
        if (typeof standard.roughness !== 'number') continue;
        if (!(standard.color instanceof THREE.Color)) continue;
        this.tracked.push({
          material: standard,
          roughness: standard.roughness,
          color: standard.color.clone(),
        });
      }
    });
    // Re-apply so a root adopted after rain has started matches the rest.
    this.write();
  }

  /**
   * @param rain Rain rate, 0..1, from the weather system.
   */
  update(dt: number, rain: number): void {
    const target = Math.max(0, Math.min(1, rain));
    if (!(dt > 0)) return;
    const tau = target > this.wetness ? WET_TAU : DRY_TAU;
    // Exponential approach, framerate-independent.
    this.wetness += (target - this.wetness) * (1 - Math.exp(-dt / tau));
    this.write();
  }

  /** Immediate set, for deterministic capture. Skips the time constants. */
  setWetness(value: number): void {
    this.wetness = Math.max(0, Math.min(1, value));
    this.write();
  }

  get value(): number {
    return this.wetness;
  }

  private write(): void {
    const w = this.wetness;
    if (w < 1e-4) {
      for (const entry of this.tracked) {
        entry.material.roughness = entry.roughness;
        entry.material.color.copy(entry.color);
      }
      return;
    }
    const albedo = 1 + (WET_ALBEDO - 1) * w;
    for (const entry of this.tracked) {
      entry.material.roughness = entry.roughness + (WET_ROUGHNESS - entry.roughness) * w;
      entry.material.color.copy(entry.color).multiplyScalar(albedo);
    }
  }

  /** Restores every adopted material to its dry state and forgets it. */
  dispose(): void {
    this.setWetness(0);
    this.tracked.length = 0;
    this.seen.clear();
  }
}
