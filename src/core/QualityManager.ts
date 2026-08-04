export type QualityTier = 'low' | 'medium' | 'high' | 'ultra' | 'max';

export interface QualitySettings {
  /** Resolution of each FFT cascade (square). */
  fftSize: 128 | 256 | 512;
  /** Number of spectral cascades composited into the surface. */
  cascades: 1 | 2 | 3;
  /**
   * Concentric rings in the radial ocean grid. This is the single strongest
   * lever on surface fidelity: vertex spacing scales as radius / meshRings, and
   * a cascade can only displace geometry out to where its wavelength still
   * exceeds that spacing.
   */
  meshRings: number;
  /** Segments around the circle. */
  meshSegments: number;
  /**
   * Resolution of the sun's shadow map, per side. 0 disables shadow rendering
   * entirely. Applied to the light, not just to `renderer.shadowMap.enabled` —
   * a tier that claims a cheaper shadow has to actually allocate a smaller map.
   */
  /**
   * Sun shadow map resolution per side.
   *
   * Never zero, and that is a deliberate policy change rather than an oversight.
   * Turning a light's `castShadow` off and on at runtime makes three rebuild the
   * light's node graph, and its shadow node is created lazily inside `setup()` —
   * so a transition can leave a cached node holding a null render target that the
   * next thing to draw the scene reads `depthTexture` from. The planar reflector
   * renders the scene from its own `updateBefore`, so it reliably got there
   * first, and the result was a crash on a tier change.
   *
   * The class of bug disappears if the light simply always casts. Low pays one
   * 512-map shadow pass for it, which against 0.33 ms of a 16.7 ms budget is a
   * cost worth taking to make tier changes unable to crash.
   */
  shadowMapSize: 512 | 1024 | 2048 | 4096;
  /** Raymarch steps for the volumetric cloud layer; 0 disables volumetrics. */
  cloudSteps: number;
  /** Raymarch steps for underwater god rays; 0 disables them. */
  godRaySteps: number;
  underwaterParticles: number;
  /**
   * Gulls in the flock, and fish in the school.
   *
   * Both are single instanced draws with every transform derived on the GPU, so
   * the count moves `instanceCount` and nothing else — no rebuild, no
   * allocation, and an individual keeps its own circuit across a tier change.
   * At 0 the renderer skips the draw entirely, which is why Low can have none
   * without a branch anywhere.
   *
   * The fish figure is a *total across ten schools*, which is what made the
   * previous numbers misleading: 90 at High reads like a shoal and divides into
   * nine fish per school, and nine fish spread over a 30 m station is not a
   * school — it is a scatter of individuals a diver has to go looking for. The
   * whole reef half of the scene was being judged on that. These are set so a
   * reef school is thirty-odd strong, which is the smallest number that still
   * reads as *a school* when one swims past.
   */
  birds: number;
  fish: number;
  /**
   * How much of the water's transmitted colour is the real refracted scene, as
   * opposed to the analytic depth-graded body colour.
   *
   * 0 mixes the refracted colour out; it does **not** skip the backdrop and
   * depth-buffer reads, which are unconditional in the node graph. An earlier
   * version of this comment claimed it did, which was simply false — an
   * independent review traced the uniform to its single use and found no branch.
   * The reads are cheap relative to the surface's fragment cost and both are
   * already paid for by the reflection path, so the honest description is that
   * this is a *visual* policy and not a cost one.
   */
  refraction: number;
  /**
   * How strongly the planar reflection of the scene shows in the water, 0..1.
   * 0 leaves the analytic sky gradient alone.
   *
   * Note what this does *not* do: whether the reflection is rendered at all is a
   * build-time property of the surface's node graph, decided once from the
   * backend, so a WebGPU tier with `reflection: 0` still pays for the mirrored
   * view and simply does not show it. Measured at 0.26 ms on the reference GPU —
   * accepted because the genuine low-end path is WebGL2, which has no reflector
   * in its graph at all.
   */
  reflection: number;
  /**
   * Resolution of the reflection render relative to the canvas. This is the real
   * cost lever — the reflection is sampled through a normal being perturbed by
   * every ripple, so it is never seen sharp.
   */
  reflectionScale: number;
  /**
   * Volumetric fog march steps. 0 is a bit-exact pass-through costing nothing.
   *
   * The march integrates cell weights exactly rather than as Riemann rectangles,
   * so raising this refines the noise detail, not the amount of fog — which is
   * why the tiers can differ this widely without the image changing brightness.
   */
  fogSteps: number;
  /**
   * Whether the bloom pyramid contributes, 0 or 1.
   *
   * An enable, not a strength, and the distinction is the same one `refraction`
   * makes: how strong bloom is belongs to the *look* — it is why
   * `toneMappingExposure` lives on the preset and not here — while what a tier
   * decides is whether a scene can afford five downsample-and-blur passes at
   * all. A tier that also set the strength would make the same preset a
   * different brightness on different hardware.
   *
   * 0 does not remove the node: rebuilding `outputNode` would recompile shaders
   * on a live tier change. It zeroes the contribution and drops the pyramid to
   * an eighth resolution, which together cost a rounding error. See
   * `SceneBloom.setEnabled`.
   */
  bloom: 0 | 1;
  /**
   * Taps in the depth-of-field gather.
   *
   * 0 is a bit-exact pass-through, and genuinely bit-exact rather than merely
   * cheap: the gather sits behind a uniform-coherent branch, so at zero the
   * output is the source texel untouched. The same construction `fogSteps: 0`
   * and `godRaySteps: 0` already use.
   *
   * The taps are laid out on a golden-angle spiral, so raising this refines the
   * bokeh rather than widening it — the radius comes from the aperture and the
   * circle of confusion, never from the count.
   */
  dofSamples: number;
  /**
   * Whether the sun/moon lens flare is drawn, 0 or 1.
   *
   * An enable rather than a strength, for the same reason `bloom` is: how strong
   * a flare reads is a property of the lens the whole project is photographed
   * through, not of how fast the machine is.
   */
  lensFlare: 0 | 1;
  /**
   * Lens-rain droplet lattice count, 1..3. 0 disables the effect entirely.
   *
   * Each level adds a lattice and, above 1, extra texture reads for misting
   * and chromatic dispersion. A clear frame costs one compare at any level.
   */
  lensRainQuality: number;
  /**
   * Strength of the ship wake's surface deformation, 0..1.
   *
   * Three taps of the wake buffer — one in the vertex stage, two in the fragment
   * stage for the gradient — so unlike most of the knobs here 0 genuinely removes
   * work rather than just hiding a result. Low turns it off because it is the
   * tier that also has no refraction and no reflection: a wake it cannot light
   * would read as a grey smear, not as water.
   */
  wakeDisplacement: number;
  /**
   * Fraction of the placed scene dressing that is drawn, 0..1.
   *
   * Instance counts only — the island's planting, the cove's clutter and the
   * reef's rocks thin out, they do not move or disappear as groups. Density is
   * the right lever because the dressing's cost is almost entirely draw-side
   * repetition of small meshes, and because a thinner grove still reads as a
   * grove where a missing one reads as a bug. It never reaches zero: the floor is
   * a quarter of placed capacity, so a low tier changes the island's density and
   * never its shape.
   */
  propsDetail: number;
  /**
   * Blades of kelp and seagrass drawn on the shallow bottom.
   *
   * Instanced, and every transform is derived on the GPU from a seed and the
   * clock, so this moves `instanceCount` and nothing else. Low draws none for
   * the same reason it draws no fish: it has no underwater pass worth dressing.
   */
  kelp: number;
  /**
   * Blades in the island's grass field.
   *
   * Instanced and placed on the GPU from the heightfield, so this is
   * `instanceCount` and nothing else — see `src/scene/Meadow.ts`. The field
   * follows the camera rather than covering the island, so this number is a
   * *density* over a 150 m square rather than a total: halving it halves how
   * thick the sward looks underfoot, wherever the viewer is standing.
   */
  meadow: number;

  /**
   * Canopy billboards standing on the island — see `src/scene/Canopy.ts`.
   *
   * Unlike `meadow` this is a *total*, not a density: the cards are planted on
   * the island rather than tiled around the camera, so the number is how much of
   * the island's forest exists. Low keeps a quarter of it, because the thing it
   * buys — the island having a canopy silhouette at all — is exactly what a low
   * tier must not lose. It is also nearly free: one draw, two triangles a card,
   * no texture and no shadow.
   */
  canopy: number;
}

export const QUALITY_TIERS: Record<QualityTier, QualitySettings> = {
  low: {
    fftSize: 128,
    cascades: 1,
    meshRings: 128,
    meshSegments: 192,
    shadowMapSize: 512,
    cloudSteps: 0,
    godRaySteps: 0,
    underwaterParticles: 400,
    birds: 0,
    fish: 0,
    // No backdrop or depth-buffer read at all. This is the WebGL2 floor, where
    // the analytic body colour has to carry the water on its own.
    refraction: 0,
    reflection: 0,
    reflectionScale: 0.25,
    fogSteps: 0,
    bloom: 0,
    dofSamples: 0,
    lensFlare: 0,
    lensRainQuality: 1,
    wakeDisplacement: 0,
    propsDetail: 0.3,
    kelp: 0,
    meadow: 0,
    canopy: 4000,
  },
  medium: {
    fftSize: 128,
    cascades: 2,
    meshRings: 192,
    meshSegments: 288,
    shadowMapSize: 1024,
    cloudSteps: 12,
    godRaySteps: 12,
    underwaterParticles: 1200,
    birds: 14,
    fish: 110,
    // Partial: the scene shows through, but the analytic body still carries most
    // of the colour, which hides the coarser depth resolution at this tier.
    refraction: 0.6,
    reflection: 0.6,
    reflectionScale: 0.35,
    fogSteps: 12,
    bloom: 1,
    dofSamples: 8,
    lensFlare: 1,
    lensRainQuality: 2,
    wakeDisplacement: 0.75,
    propsDetail: 0.5,
    kelp: 800,
    meadow: 18000,
    canopy: 9000,
  },
  high: {
    fftSize: 256,
    cascades: 3,
    meshRings: 288,
    meshSegments: 448,
    shadowMapSize: 2048,
    cloudSteps: 24,
    godRaySteps: 24,
    underwaterParticles: 2400,
    birds: 26,
    fish: 240,
    refraction: 1,
    reflection: 0.85,
    reflectionScale: 0.5,
    fogSteps: 24,
    bloom: 1,
    dofSamples: 16,
    lensFlare: 1,
    lensRainQuality: 3,
    wakeDisplacement: 1,
    propsDetail: 0.75,
    kelp: 1800,
    meadow: 38000,
    canopy: 15000,
  },
  ultra: {
    fftSize: 256,
    cascades: 3,
    meshRings: 384,
    meshSegments: 576,
    shadowMapSize: 2048,
    cloudSteps: 40,
    godRaySteps: 40,
    underwaterParticles: 4000,
    birds: 40,
    fish: 380,
    refraction: 1,
    reflection: 1,
    reflectionScale: 0.6,
    fogSteps: 40,
    bloom: 1,
    dofSamples: 24,
    lensFlare: 1,
    lensRainQuality: 3,
    wakeDisplacement: 1,
    propsDetail: 1,
    kelp: 2900,
    meadow: 62000,
    canopy: 20000,
  },
  max: {
    fftSize: 512,
    cascades: 3,
    meshRings: 512,
    meshSegments: 768,
    shadowMapSize: 4096,
    cloudSteps: 64,
    godRaySteps: 56,
    underwaterParticles: 6000,
    birds: 64,
    fish: 560,
    refraction: 1,
    reflection: 1,
    reflectionScale: 0.75,
    fogSteps: 56,
    bloom: 1,
    dofSamples: 32,
    lensFlare: 1,
    lensRainQuality: 3,
    wakeDisplacement: 1,
    propsDetail: 1,
    kelp: 4000,
    meadow: 90000,
    canopy: 24000,
  },
};

export const TIER_ORDER: QualityTier[] = ['low', 'medium', 'high', 'ultra', 'max'];

/**
 * Watches frame health and steps the tier down when the experience is
 * persistently below target. Deliberately one-way during a session: oscillating
 * between tiers is more distracting than running one notch below optimal.
 */
export class AdaptiveQuality {
  private belowTargetFor = 0;
  private aboveTargetFor = 0;
  private lastChange = 0;

  constructor(
    private readonly targetFps = 55,
    private readonly onDowngrade: (tier: QualityTier) => void = () => {},
  ) {}

  enabled = true;

  update(dt: number, fps: number, currentTier: QualityTier, elapsed: number): void {
    if (!this.enabled) return;
    // Ignore the first seconds — shader compilation and asset decode dominate.
    if (elapsed < 4) return;
    // Debounce so a single hitch never triggers a visible quality change.
    if (elapsed - this.lastChange < 6) return;

    if (fps < this.targetFps * 0.75) {
      this.belowTargetFor += dt;
      this.aboveTargetFor = 0;
    } else {
      this.aboveTargetFor += dt;
      this.belowTargetFor = 0;
    }

    if (this.belowTargetFor > 2.5) {
      const index = TIER_ORDER.indexOf(currentTier);
      if (index > 0) {
        this.belowTargetFor = 0;
        this.lastChange = elapsed;
        this.onDowngrade(TIER_ORDER[index - 1]);
      }
    }
  }

  reset(): void {
    this.belowTargetFor = 0;
    this.aboveTargetFor = 0;
  }
}

