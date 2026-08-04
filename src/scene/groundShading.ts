import * as THREE from 'three/webgpu';
import { Fn, float, mix, positionWorld, vec3 } from 'three/tsl';
import { occludeLight } from '../core/lightOcclusion';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;

/**
 * The three things every object standing on the seabed or the island was
 * missing.
 *
 * They are grouped because they are one omission with three faces: nothing
 * placed in this world was told anything about the ground it was placed on.
 *
 * 1. **Contact darkening.** Corals sat on sand with no shadow at their base and
 *    read as pasted on; the reef scatter and several island scatters clear
 *    `castShadow` for cost, which is defensible — a coral head is a few hundred
 *    triangles and there are hundreds of them — but the *replacement* was never
 *    added. iq's fish in `ldj3Dm` casts a soft shadow on the seabed and it is a
 *    large part of why it sits in the scene rather than over it. This is the
 *    cheap version of the same cue: darken by proximity to the heightfield,
 *    which is where an object's own occlusion of the sky is concentrated.
 *
 * 2. **Caustics.** `Caustics.intensityNode` was written to be shared — its own
 *    header says "a seafloor material, a rock material and a hull material" —
 *    and was wired to the seafloor alone. So the reef's corals and rocks stood
 *    in a caustic pattern that stopped at their feet. Every underwater reference
 *    in the set puts caustics on *every* lit surface.
 *
 * 3. **Key occlusion.** The island's own shadow and the cloud deck's, the same
 *    terms the terrain now receives. Without it a palm on a shaded hillside is
 *    lit as if it were on the sunlit one.
 *
 * All three are analytic functions of world position, so one treatment covers
 * land and seabed and the elevation ramps decide which parts apply where.
 */

export interface GroundShadingInputs {
  /** The key light, for the direct-occlusion hook. */
  light: THREE.Light;
  /** `(worldPosition) => 0..1` — terrain shadow times cloud shade. */
  keyShadow: (worldPosition: Node) => Node;
  /** `(worldPosition) => ~1` — the caustic pattern, centred on 1. */
  caustics: (worldPosition: Node) => Node;
  /** `(worldPosition) => metres` — seafloor elevation, for the contact term. */
  groundHeight: (worldPosition: Node) => Node;
}

/**
 * Height above the ground over which contact darkening fades out, metres.
 *
 * Small on purpose. This is not ambient occlusion of the object by itself — it
 * is the wedge of sky a surface loses to the ground it is sitting on, and that
 * closes within about a metre for anything reef-sized. Wider and every coral
 * head goes uniformly dark, which trades one wrong read for another.
 */
const CONTACT_HEIGHT = 1.4;
/** Ambient reaching a surface in contact with the ground. */
const CONTACT_FLOOR = 0.34;

/** Where caustics stop, in metres of depth, and where they are strongest. */
const CAUSTIC_SHALLOW = 2;
const CAUSTIC_DEEP = 48;
/** Half-width of the band across the waterline where caustics fade in. */
const WATERLINE_BAND = 1.2;

/**
 * Applies the treatment to one material.
 *
 * `aoNode` carries the contact term because three applies it to indirect light
 * only, which is where a contact shadow belongs: a coral in contact with the
 * sand has lost sky, not sun. The caustics multiply the albedo instead, because
 * they *are* the sun — a pattern in the direct light — and there is no hook that
 * modulates one light directionally per material without replacing its whole
 * lighting model.
 */
export function applyGroundShading(
  material: THREE.NodeMaterial,
  inputs: GroundShadingInputs,
): void {
  const existingColor = material.colorNode as Node;

  const contact = Fn(() => {
    const wp = positionWorld.toVar('gsWorld');
    const above = wp.y.sub(inputs.groundHeight(wp)).max(0).toVar('gsAbove');
    return mix(float(CONTACT_FLOOR), float(1), above.smoothstep(0, CONTACT_HEIGHT));
  })();

  material.aoNode =
    material.aoNode === null ? contact : (material.aoNode as Node).mul(contact);

  material.colorNode = Fn(() => {
    const wp = positionWorld.toVar('gsWorldC');
    const base = existingColor === null ? vec3(1, 1, 1) : vec3(existingColor);

    // Underwater only, and fading with depth for the same reason the seafloor's
    // does: past a few tens of metres the surface pattern has diverged into
    // ambient light and there is no caustic left to project.
    const depth = wp.y.negate().toVar('gsDepth');
    const submerged = float(1).sub(wp.y.smoothstep(-WATERLINE_BAND, WATERLINE_BAND));
    const reach = float(1)
      .sub(depth.smoothstep(CAUSTIC_SHALLOW, CAUSTIC_DEEP))
      .mul(submerged)
      .toVar('gsReach');

    const lit = mix(float(1), inputs.caustics(wp), reach).toVar('gsLit');
    return base.mul(lit);
  })();

  occludeLight(material, inputs.light, Fn(() => inputs.keyShadow(positionWorld))());
  material.needsUpdate = true;
}

/**
 * Walks an object tree and treats every distinct material once.
 *
 * Once, and that matters: a kind is baked to one geometry per material and
 * placed as an `InstancedMesh` per part, so the same material object is reached
 * through many meshes. Wrapping `colorNode` twice would square the caustics and
 * wrapping `setupLighting` twice would square the shadow.
 */
export function applyGroundShadingTo(
  root: THREE.Object3D,
  inputs: GroundShadingInputs,
): void {
  const seen = new Set<THREE.Material>();
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material || seen.has(material)) continue;
      seen.add(material);
      // Node materials only — the treatment is a node graph. Everything the
      // asset loader produces is one; anything else is left alone rather than
      // silently skipped in a way that looks like it worked.
      if ((material as THREE.NodeMaterial).isNodeMaterial !== true) continue;
      applyGroundShading(material as THREE.NodeMaterial, inputs);
    }
  });
}
