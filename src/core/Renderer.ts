import * as THREE from 'three/webgpu';

export type Backend = 'webgpu' | 'webgl';

export interface RendererBootstrap {
  renderer: THREE.WebGPURenderer;
  backend: Backend;
  /** True when WebGPU was requested but the device could not be acquired. */
  fellBack: boolean;
}

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  /** Force the WebGL2 backend even when WebGPU is available. */
  forceWebGL?: boolean;
  pixelRatio?: number;
}

/** Upper bound on DPR — beyond 2x the cost is real and the gain is not. */
export const MAX_PIXEL_RATIO = 2;

export async function createRenderer(options: RendererOptions): Promise<RendererBootstrap> {
  const { canvas, forceWebGL = false } = options;

  const webgpuAvailable = !forceWebGL && (await probeWebGPU());
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    forceWebGL: !webgpuAvailable,
    powerPreference: 'high-performance',
    alpha: false,
  });

  renderer.setPixelRatio(clampPixelRatio(options.pixelRatio ?? window.devicePixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  // Linear-space rendering with filmic tonemapping — the ocean has a very wide
  // dynamic range between sun glitter and shadowed troughs.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  await renderer.init();

  // `isWebGPUBackend` is set on the concrete backend instance but is not part of
  // the exported base type, so read it defensively.
  const isWebGPU = (renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  const backend: Backend = isWebGPU ? 'webgpu' : 'webgl';

  return {
    renderer,
    backend,
    fellBack: !forceWebGL && backend === 'webgl',
  };
}

/**
 * `navigator.gpu` existing is not sufficient — adapter request can still fail on
 * blocklisted drivers, and a failed WebGPU init leaves a dead canvas. Probe first.
 */
async function probeWebGPU(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    return adapter !== null;
  } catch {
    return false;
  }
}

export function clampPixelRatio(value: number): number {
  return Math.min(MAX_PIXEL_RATIO, Math.max(0.5, value));
}
