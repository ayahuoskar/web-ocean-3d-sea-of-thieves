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
  shadowMapSize: 0 | 1024 | 2048 | 4096;
  /** Raymarch steps for the volumetric cloud layer; 0 disables volumetrics. */
  cloudSteps: number;
  /** Raymarch steps for underwater god rays; 0 disables them. */
  godRaySteps: number;
  ssrEnabled: boolean;
  causticsEnabled: boolean;
  bloomEnabled: boolean;
  underwaterParticles: number;
  fishCount: number;
  /** Multiplier applied on top of the user's pixel ratio. */
  renderScale: number;
}

export const QUALITY_TIERS: Record<QualityTier, QualitySettings> = {
  low: {
    fftSize: 128,
    cascades: 1,
    meshRings: 128,
    meshSegments: 192,
    shadowMapSize: 0,
    cloudSteps: 0,
    godRaySteps: 0,
    ssrEnabled: false,
    causticsEnabled: false,
    bloomEnabled: false,
    underwaterParticles: 400,
    fishCount: 0,
    renderScale: 0.75,
  },
  medium: {
    fftSize: 128,
    cascades: 2,
    meshRings: 192,
    meshSegments: 288,
    shadowMapSize: 1024,
    cloudSteps: 12,
    godRaySteps: 12,
    ssrEnabled: false,
    causticsEnabled: true,
    bloomEnabled: true,
    underwaterParticles: 1200,
    fishCount: 48,
    renderScale: 0.9,
  },
  high: {
    fftSize: 256,
    cascades: 3,
    meshRings: 288,
    meshSegments: 448,
    shadowMapSize: 2048,
    cloudSteps: 24,
    godRaySteps: 24,
    ssrEnabled: true,
    causticsEnabled: true,
    bloomEnabled: true,
    underwaterParticles: 2400,
    fishCount: 120,
    renderScale: 1,
  },
  ultra: {
    fftSize: 256,
    cascades: 3,
    meshRings: 384,
    meshSegments: 576,
    shadowMapSize: 2048,
    cloudSteps: 40,
    godRaySteps: 40,
    ssrEnabled: true,
    causticsEnabled: true,
    bloomEnabled: true,
    underwaterParticles: 4000,
    fishCount: 200,
    renderScale: 1,
  },
  max: {
    fftSize: 512,
    cascades: 3,
    meshRings: 512,
    meshSegments: 768,
    shadowMapSize: 4096,
    cloudSteps: 64,
    godRaySteps: 56,
    ssrEnabled: true,
    causticsEnabled: true,
    bloomEnabled: true,
    underwaterParticles: 6000,
    fishCount: 320,
    renderScale: 1,
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

