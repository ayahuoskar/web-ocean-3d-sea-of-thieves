import * as THREE from 'three/webgpu';
import { builtinShadowContext } from 'three/tsl';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;

/**
 * Attaches an extra occlusion factor to one light's **direct** contribution, for
 * one material.
 *
 * This exists because the two shadows this project needs on land are not shadow
 * maps and cannot be. The sun's map is a +/-260 m box that follows the viewer, so
 * it can shade the ship and the props standing near it and nothing else; the
 * island is a kilometre across and its own hillside has to shade its own far
 * face. And the cloud deck's shade is a lookup into the same procedural field the
 * clouds are drawn from — there is no geometry to rasterise at all. Both are
 * analytic functions of the world position, and both belong exactly where a
 * shadow map's result belongs: multiplying the key light before the BRDF sees it.
 *
 * ### Why not the obvious alternatives
 *
 * **Multiplying `colorNode`** darkens the albedo, so it takes the sky fill and
 * the specular down with the sun. A hillside in its own shadow is not a darker
 * hillside — it is the same hillside lit only by the sky, which is *bluer* as
 * well as dimmer. Multiplying albedo cannot express that and reads as dirt.
 *
 * **`material.aoNode`** is the right hook for the opposite term: three applies it
 * to *indirect* light only. Cavity occlusion goes there; a cast shadow does not.
 *
 * **`light.shadow.shadowNode`** would work but is global to the light, so the
 * terrain's own shadow function would be evaluated for the sea, the hull, the
 * gulls and the rigging as well — and it *replaces* the shadow map rather than
 * composing with it, so the map would have to be rebuilt by hand.
 *
 * ### How it works
 *
 * `NodeMaterial.setupLighting` resolves the lights node as
 * `this.lightsNode || builder.lightsNode`, and `AnalyticLightNode.setupShadow`
 * consults `builder.context.getShadow` after it has computed its own shadow term.
 * `builtinShadowContext` is three's own helper for exactly this: it wraps a lights
 * node in a context whose `getShadow` multiplies one nominated light's shadowed
 * colour by an extra node. So the composition is three's, not ours, and the
 * shadow map still applies underneath.
 *
 * The material's own `setupLighting` is wrapped rather than subclassed because
 * the materials that need this are of four different classes across the scene
 * (`MeshStandardNodeMaterial`, `MeshLambertNodeMaterial`, and two instanced
 * variants), and a mixin over the instance keeps that from becoming four
 * near-identical subclasses.
 *
 * **The light must cast shadows.** `AnalyticLightNode.setup` only calls
 * `setupShadow` — and therefore only consults the context — when
 * `light.castShadow` is true. That is guaranteed here: `QualitySettings`
 * documents that the sun always casts at every tier, precisely so that toggling
 * it cannot crash a tier change.
 *
 * @param material Material whose lighting should be occluded. Marked for a
 *   shader rebuild, so call this at setup rather than per frame.
 * @param light The light to occlude. Only this light is affected.
 * @param factor `(worldPosition) => float` in 0..1. 1 is unoccluded.
 */
/**
 * Materials already wrapped, so a second call is a no-op rather than a squared
 * occlusion factor.
 *
 * Every call site guards itself today, and that is exactly the arrangement that
 * stops being true when a fourth one is added. Wrapping twice would multiply the
 * shadow by itself, which reads as a plausible-but-too-dark hillside rather than
 * as a bug.
 */
const wrapped = new WeakSet<THREE.Material>();

export function occludeLight(
  material: THREE.NodeMaterial,
  light: THREE.Light,
  factor: Node,
): void {
  if (wrapped.has(material)) return;
  wrapped.add(material);

  const target = material as unknown as {
    lightsNode: Node;
    setupLighting: (builder: Node) => Node;
  };

  const base = target.setupLighting.bind(material);

  target.setupLighting = (builder: Node): Node => {
    const saved = target.lightsNode;
    // `builder.lightsNode` is the scene's; wrapping it leaves every other light
    // untouched and every other material sharing it unwrapped.
    target.lightsNode = builtinShadowContext(factor, light, saved ?? builder.lightsNode);
    try {
      return base(builder);
    } finally {
      target.lightsNode = saved;
    }
  };

  material.needsUpdate = true;
}
