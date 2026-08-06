/**
 * Top-left heads-up display: FPS meter, renderer backend badge, camera-mode
 * segmented control and per-mode control hints.
 *
 * Pure DOM. The FPS write is throttled to ~4 Hz so that a 120 fps render loop
 * cannot force 120 layout/paint invalidations a second on the UI layer.
 */

import { CAMERA_MODES, type CameraMode, type RendererBackend, type UiCallbacks } from './types.ts';

interface Hint {
  readonly action: string;
  readonly key: string;
}

// Spelled out. These were abbreviated because the modes were laid out as a
// three-column grid of four buttons; they are a numbered index now and the row
// is as wide as the panel, so nothing has to be clipped to "Cine".
const MODE_LABELS: Record<CameraMode, string> = {
  orbit: 'Orbit',
  fly: 'Fly',
  boat: 'Helm',
  cinematic: 'Tour',
};

const MODE_DIGITS: Record<CameraMode, string> = {
  orbit: '1',
  fly: '2',
  boat: '3',
  cinematic: '4',
};

const HINTS: Record<CameraMode, readonly Hint[]> = {
  orbit: [
    { action: 'Orbit', key: 'LMB' },
    { action: 'Pan', key: 'RMB' },
    { action: 'Zoom', key: 'Scroll' },
  ],
  fly: [
    { action: 'Move', key: 'WASD' },
    { action: 'Look', key: 'Mouse' },
    { action: 'Speed', key: 'Scroll' },
    { action: 'Boost', key: 'Shift' },
  ],
  // `Camera / Mouse` used to be listed here and was never implemented — the
  // chase rig derives its pose from the hull and ignores the mouse entirely.
  // Reverse is real, though: S astern of a stop backs the ship, and the rudder
  // reverses with it.
  boat: [
    { action: 'Throttle', key: 'W S' },
    { action: 'Steer', key: 'A D' },
    { action: 'Look', key: 'Drag' },
    { action: 'Zoom', key: 'Scroll' },
  ],
  // Nothing to drive — the flight holds the wheel. The hint names what the
  // viewer *can* do, which is leave, rather than listing controls that are
  // deliberately inert while the mode is running.
  cinematic: [
    { action: 'Auto tour', key: '4' },
    { action: 'Take helm', key: '3' },
    { action: 'Free look', key: '2' },
  ],
};

/** Keyboard digits, in mode order. See `MODE_DIGITS`. */
const MODE_DIGITS_ORDER: readonly string[] = CAMERA_MODES.map((mode) => MODE_DIGITS[mode]);

/** Minimum milliseconds between FPS text writes (~4 updates per second). */
const FPS_WRITE_INTERVAL = 250;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fpsClass(fps: number): string {
  if (fps >= 55) return 'is-good';
  if (fps >= 30) return 'is-warn';
  return 'is-bad';
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'OPTION';
}

export class Hud {
  private readonly root: HTMLElement;
  private readonly callbacks: UiCallbacks;
  private readonly controller = new AbortController();
  private readonly hudEl: HTMLElement;
  private readonly fpsValue: HTMLElement;
  private readonly backendBadge: HTMLElement;
  private readonly hintList: HTMLElement;
  private readonly modeButtons = new Map<CameraMode, HTMLButtonElement>();

  private mode: CameraMode;
  private pendingFps = 0;
  private writtenFps = -1;
  private lastFpsWrite = 0;
  private fpsTimer = 0;
  private disposed = false;

  constructor(root: HTMLElement, initial: CameraMode, callbacks: UiCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.mode = initial;

    const signal = this.controller.signal;

    const hud = el('section', 'hud');
    hud.setAttribute('aria-label', 'Performance and camera');

    // ---- FPS meter ---------------------------------------------------------
    const meter = el('div', 'hud__meter');
    const fpsValue = el('div', 'hud__fps is-good', '0');
    fpsValue.setAttribute('role', 'status');
    fpsValue.setAttribute('aria-live', 'off');
    fpsValue.setAttribute('aria-label', 'Frames per second');
    const backendBadge = el('div', 'hud__backend', 'WEBGPU');
    backendBadge.setAttribute('aria-label', 'Renderer backend: WebGPU');
    // The unit column, written the way a table of measurements writes a rate
    // rather than as the label of a statistic. `aria-label` on the value above
    // still says "Frames per second", so nothing is lost to a screen reader.
    meter.append(fpsValue, el('div', 'hud__fps-caption', 'f·s⁻¹'), backendBadge);
    hud.append(meter, el('div', 'hud__divider'));

    // ---- Camera mode segmented control ------------------------------------
    const modes = el('div', 'hud__modes');
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'Camera mode');
    for (const mode of CAMERA_MODES) {
      const button = el('button', 'seg');
      button.type = 'button';
      button.setAttribute('aria-pressed', mode === this.mode ? 'true' : 'false');
      button.setAttribute('aria-label', `${MODE_LABELS[mode]} camera (key ${MODE_DIGITS[mode]})`);
      button.classList.toggle('is-active', mode === this.mode);
      button.append(
        el('span', 'seg__digit', MODE_DIGITS[mode]),
        el('span', 'seg__name', MODE_LABELS[mode]),
      );
      button.addEventListener('click', () => this.selectMode(mode), { signal });
      this.modeButtons.set(mode, button);
      modes.append(button);
    }
    hud.append(modes);

    // ---- Hints -------------------------------------------------------------
    const hintList = el('ul', 'hud__hints');
    hud.append(hintList);

    this.hudEl = hud;
    this.fpsValue = fpsValue;
    this.backendBadge = backendBadge;
    this.hintList = hintList;

    this.renderHints(this.mode);
    this.root.append(hud);

    window.addEventListener('keydown', this.onKeyDown, { signal });
  }

  /** Feed the current frame rate; the DOM write is throttled internally. */
  setFps(fps: number): void {
    if (this.disposed) return;
    this.pendingFps = Math.max(0, Math.round(fps));

    const now = performance.now();
    const elapsed = now - this.lastFpsWrite;
    if (elapsed >= FPS_WRITE_INTERVAL) {
      this.flushFps(now);
      return;
    }
    if (this.fpsTimer === 0) {
      this.fpsTimer = window.setTimeout(
        () => {
          this.fpsTimer = 0;
          this.flushFps(performance.now());
        },
        FPS_WRITE_INTERVAL - elapsed,
      );
    }
  }

  setBackend(backend: RendererBackend): void {
    if (this.disposed) return;
    const text = backend === 'webgpu' ? 'WEBGPU' : 'WEBGL';
    this.backendBadge.textContent = text;
    this.backendBadge.classList.toggle('is-fallback', backend === 'webgl');
    this.backendBadge.setAttribute(
      'aria-label',
      `Renderer backend: ${backend === 'webgpu' ? 'WebGPU' : 'WebGL'}`,
    );
  }

  /** Programmatic mode change — does not fire `onChange`. */
  setCameraMode(m: CameraMode): void {
    if (this.disposed || m === this.mode) return;
    this.mode = m;
    for (const [mode, button] of this.modeButtons) {
      const active = mode === m;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    this.renderHints(m);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.fpsTimer !== 0) {
      window.clearTimeout(this.fpsTimer);
      this.fpsTimer = 0;
    }
    this.controller.abort();
    this.hudEl.remove();
    this.modeButtons.clear();
  }

  // -- internals ------------------------------------------------------------

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    if (isTypingTarget(event.target)) return;

    // Derived from the mode list rather than written out, so adding a mode
    // cannot leave it selectable by button and not by key.
    const index = MODE_DIGITS_ORDER.indexOf(event.key);
    if (index < 0) return;
    const mode = CAMERA_MODES[index];
    if (mode === undefined) return;

    event.preventDefault();
    this.selectMode(mode);
  };

  private selectMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.setCameraMode(mode);
    this.callbacks.onChange('cameraMode', mode);
  }

  private flushFps(now: number): void {
    this.lastFpsWrite = now;
    if (this.pendingFps === this.writtenFps) return;
    this.writtenFps = this.pendingFps;
    this.fpsValue.textContent = String(this.pendingFps);
    this.fpsValue.className = `hud__fps ${fpsClass(this.pendingFps)}`;
  }

  private renderHints(mode: CameraMode): void {
    this.hintList.replaceChildren();
    for (const hint of HINTS[mode]) {
      const row = el('li', 'hud__hint');
      row.append(el('span', 'hud__hint-action', hint.action), el('kbd', 'keycap', hint.key));
      this.hintList.append(row);
    }
  }
}
