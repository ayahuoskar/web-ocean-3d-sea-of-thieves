export type QualityTier = 'low' | 'medium' | 'high' | 'ultra' | 'max';

export interface QualitySettings {
  fftSize: 128 | 256 | 512;
  cascades: 1 | 2 | 3;
  meshRings: number;
  meshSegments: number;
  shadowMapSize: 512 | 1024 | 2048 | 4096;
  terrainShadowSteps: number;
  cloudSteps: number;
  godRaySteps: number;
  spray: number;
  underwaterParticles: number;
  birds: number;
  fish: number;
  refraction: number;
  reflection: number;
  reflectionScale: number;
  fogSteps: number;
  bloom: 0 | 1;
  dofSamples: number;
  lensFlare: 0 | 1;
  lensRainQuality: number;
  wakeDisplacement: number;
  propsDetail: number;
  kelp: number;
  meadow: number;
  canopy: number;
}

export const QUALITY_TIERS: Record<QualityTier, QualitySettings> = {
  low: {
    fftSize: 128,
    cascades: 1,
    meshRings: 206,
    meshSegments: 119,
    shadowMapSize: 512,
    terrainShadowSteps: 0,
    cloudSteps: 0,
    godRaySteps: 0,
    spray: 0,
    underwaterParticles: 400,
    birds: 0,
    fish: 0,
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
    meshRings: 308,
    meshSegments: 179,
    shadowMapSize: 1024,
    terrainShadowSteps: 12,
    cloudSteps: 12,
    godRaySteps: 12,
    spray: 0.6,
    underwaterParticles: 1200,
    birds: 14,
    fish: 110,
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
    meshRings: 469,
    meshSegments: 275,
    shadowMapSize: 2048,
    terrainShadowSteps: 20,
    cloudSteps: 18,
    godRaySteps: 24,
    spray: 1,
    underwaterParticles: 2400,
    birds: 26,
    fish: 240,
    refraction: 1,
    reflection: 0.85,
    reflectionScale: 0.5,
    fogSteps: 18,
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
    meshRings: 613,
    meshSegments: 360,
    shadowMapSize: 2048,
    terrainShadowSteps: 28,
    cloudSteps: 34,
    godRaySteps: 40,
    spray: 1,
    underwaterParticles: 4000,
    birds: 40,
    fish: 380,
    refraction: 1,
    reflection: 1,
    reflectionScale: 0.6,
    fogSteps: 34,
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
    meshRings: 817,
    meshSegments: 481,
    shadowMapSize: 4096,
    terrainShadowSteps: 28,
    cloudSteps: 34,
    godRaySteps: 40,
    spray: 1,
    underwaterParticles: 6000,
    birds: 64,
    fish: 560,
    refraction: 1,
    reflection: 1,
    reflectionScale: 0.75,
    fogSteps: 34,
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
 * Conservative adaptive quality for the interactive ocean lab.
 *
 * The old policy could fall from High all the way to Low during asset/shader
 * pressure, and every step is a visible resource rebuild. For a tuning sandbox
 * visual continuity matters more than chasing a target FPS immediately, so we:
 *
 *  - ignore the first 12 seconds;
 *  - require six continuous seconds of real frame pressure;
 *  - wait twenty seconds between changes;
 *  - never auto-drop below Medium.
 *
 * Manual selection can still choose Low when someone explicitly wants it.
 */
export class AdaptiveQuality {
  private belowTargetFor = 0;
  private aboveTargetFor = 0;
  private lastChange = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly targetFps = 55,
    private readonly onDowngrade: (tier: QualityTier) => void = () => {},
    private readonly minimumAutomaticTier: QualityTier = 'medium',
  ) {}

  enabled = true;

  update(dt: number, fps: number, currentTier: QualityTier, elapsed: number): void {
    if (!this.enabled) return;
    if (elapsed < 12) return;
    if (elapsed - this.lastChange < 20) return;

    if (fps < this.targetFps * 0.68) {
      this.belowTargetFor += dt;
      this.aboveTargetFor = 0;
    } else {
      this.aboveTargetFor += dt;
      this.belowTargetFor = 0;
    }

    if (this.belowTargetFor <= 6) return;

    const index = TIER_ORDER.indexOf(currentTier);
    const floorIndex = TIER_ORDER.indexOf(this.minimumAutomaticTier);
    if (index > floorIndex) {
      this.belowTargetFor = 0;
      this.lastChange = elapsed;
      this.onDowngrade(TIER_ORDER[index - 1]);
    } else {
      // We are already at the lab floor. Clear the timer so a sustained low FPS
      // does not keep trying to trigger the same transition every frame.
      this.belowTargetFor = 0;
    }
  }

  reset(): void {
    this.belowTargetFor = 0;
    this.aboveTargetFor = 0;
  }
}
