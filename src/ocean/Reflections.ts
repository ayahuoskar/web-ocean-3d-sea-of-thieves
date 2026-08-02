import * as THREE from 'three/webgpu';
import { reflector } from 'three/tsl';

/**
 * Planar reflection of the scene in the water surface.
 *
 * The surface previously reflected `mix(horizonColor, skyColor, reflectDir.y)` —
 * a two-colour analytic gradient. It is a reasonable stand-in for open ocean
 * under an empty sky and it is completely wrong the moment anything is *on* the
 * water: a ship sitting in a mirror that does not contain it reads as pasted on,
 * and no amount of Fresnel tuning fixes that.
 *
 * **Planar, not screen-space.** SSR can only reflect what is already on screen,
 * and the geometry that matters here is the hull — which, seen from a low camera,
 * has its reflection below the waterline while the object itself is near the top
 * of the frame or out of it entirely. That is precisely the case SSR cannot
 * serve. A mirrored camera has the whole scene available, and the ocean is a
 * plane, which is the one situation where planar reflection is exactly right
 * rather than an approximation.
 *
 * The cost is a second view of the scene. It is charged only where it buys
 * something: see `setQuality`.
 */
export class Reflections {
  /** Add to the scene; its transform defines the mirror plane. */
  readonly plane: THREE.Object3D;

  /** TSL texture node carrying the reflected scene. Bind once. */
  readonly node: any;

  private readonly base: any;
  /**
   * Set once `setQuality` has written the resolution scale.
   *
   * Changing `resolutionScale` resizes the reflector's render target, and that
   * target now carries a mip chain for the surface's roughness-aware sampling.
   * Rebuilding a mipmapped target while the scene is mid-rebuild is what finally
   * explained a crash that had survived three previous fixes: a tier change
   * resized this, three tore down and re-created the affected node graphs
   * asynchronously, and the reflector — which renders the whole scene from its
   * own `updateBefore` — reached a shadow node that had not finished rebuilding
   * and read `depthTexture` off null.
   *
   * The reflection therefore keeps whatever scale the session booted at. That is
   * a real cost: someone who starts on Low and switches to Max gets a
   * quarter-resolution reflection. It buys a renderer that cannot crash on a tier
   * change, and the reflection is sampled through a normal perturbed by every
   * ripple and at a roughness-driven mip level, so the resolution is the least
   * visible thing about it.
   */
  private resolutionFixed = false;

  constructor(resolutionScale = 0.5) {
    // `reflector` mirrors about the target's local XY plane, so the target is
    // rotated to put its normal along +Y. Sea level, not the camera's height:
    // the displaced surface oscillates about y = 0 and reflecting about the mean
    // plane is what keeps the reflection stable as waves pass through it.
    // Mipmapped, so the surface can sample it at a roughness-driven level.
    //
    // `generateMipmaps: false` was fine while the reflection was only ever
    // sampled as a sharp mirror, and that is exactly the problem: a rough sea
    // does not reflect sharply, and without a mip chain there is nothing to
    // sample instead. A single level costs a third again in bandwidth on a target
    // that is already at half resolution, and it is what lets a chopped-up sea
    // reflect as a chopped-up sea rather than as polished metal.
    const node = reflector({ resolutionScale, generateMipmaps: true, bounces: false });
    node.target.rotateX(-Math.PI / 2);
    node.target.name = 'ocean-reflector';

    this.node = node;
    this.base = node.reflector;
    this.plane = node.target;
  }

  /**
   * Per-tier cost policy.
   *
   * `resolutionScale` is the real lever. The reflection is sampled through a
   * surface normal that is being perturbed by every ripple in the wave field, so
   * it is never seen sharp — half resolution is indistinguishable from full in
   * motion, and a quarter is acceptable wherever the sea state is rough enough
   * to break the image up anyway.
   */
  setQuality(scale: number): void {
    // Honoured once, then fixed — see `resolutionFixed`.
    if (this.resolutionFixed) return;
    this.resolutionFixed = true;
    this.base.resolutionScale = Math.max(0.1, Math.min(1, scale));
  }

  dispose(): void {
    this.plane.removeFromParent();
    for (const target of this.base.renderTargets.values()) target.dispose();
    this.base.renderTargets.clear();
  }
}
