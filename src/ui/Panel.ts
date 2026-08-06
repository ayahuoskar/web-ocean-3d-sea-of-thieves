/**
 * Right-hand control panel.
 *
 * Pure DOM — no three.js, no framework. It owns nothing but its own markup and
 * reports every user edit through {@link UiCallbacks.onChange}. The host app is
 * free to echo values back with {@link Panel.setState} (which never re-fires the
 * callbacks, so it is safe to call from inside a change handler).
 */

import {
  PRESET_IDS,
  QUALITY_TIERS,
  type PresetId,
  type QualityTier,
  type UiCallbacks,
  type UiState,
} from './types.ts';

/** Where "View Source" goes. It previously pointed at `#`. */
const SOURCE_URL = 'https://github.com/2600th/web-ocean-3d';

type SliderKey =
  | 'windSpeed'
  | 'peakWavelength'
  | 'cloudCoverage'
  | 'timeOfDay'
  | 'fogDensity'
  | 'volume'
  | 'pixelRatio';
type ToggleKey = 'buoyancyProbes' | 'wakeProbes' | 'forceWebGL';

interface SliderSpec {
  readonly key: SliderKey;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  format(value: number): string;
}

interface SliderRefs {
  readonly spec: SliderSpec;
  readonly input: HTMLInputElement;
  readonly value: HTMLElement;
}

/**
 * Which sliders go above the toggles, and which below.
 *
 * Named, not sliced. This used to be `SLIDERS.slice(0, 3)` above the toggles and
 * `SLIDERS[3]` below, on the assumption that index 3 was the pixel-ratio
 * control — which it was, until `fogDensity` and `timeOfDay` were inserted ahead
 * of it. After that the "pixel ratio" slot silently rendered the fog slider, and
 * Time of Day and Pixel Ratio were never built at all. Nothing failed; the
 * controls simply did not exist, and the day/night cycle had no way to be
 * reached from the UI.
 *
 * `assertSlidersPlaced` below makes the same mistake impossible to repeat: every
 * entry in `SLIDERS` has to appear in exactly one group or construction throws.
 */
const ENVIRONMENT_SLIDERS = [
  'windSpeed',
  'peakWavelength',
  'cloudCoverage',
  'fogDensity',
  'timeOfDay',
] as const satisfies readonly SliderKey[];

const DISPLAY_SLIDERS = ['volume', 'pixelRatio'] as const satisfies readonly SliderKey[];

const SLIDERS: readonly SliderSpec[] = [
  {
    key: 'windSpeed',
    label: 'Wind Speed',
    min: 0.5,
    max: 25,
    step: 0.5,
    format: (v) => `${v.toFixed(1)} m/s`,
  },
  {
    key: 'peakWavelength',
    label: 'Peak Wavelength',
    min: 10,
    max: 150,
    step: 1,
    format: (v) => `${Math.round(v)} m`,
  },
  {
    key: 'cloudCoverage',
    label: 'Cloud Coverage',
    min: 0,
    max: 1,
    step: 0.01,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: 'fogDensity',
    label: 'Volumetric Fog',
    min: 0,
    max: 1,
    step: 0.01,
    format: (v) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`),
  },
  {
    key: 'timeOfDay',
    label: 'Time of Day',
    min: 0,
    max: 24,
    step: 0.1,
    // Clock face rather than a bare number: "17.4" is not a time anyone reads.
    format: (v) => {
      const hours = Math.floor(v) % 24;
      const minutes = Math.round((v - Math.floor(v)) * 60);
      return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    },
  },
  {
    key: 'volume',
    label: 'Volume',
    min: 0,
    max: 1,
    step: 0.01,
    format: (v) => (v === 0 ? 'Muted' : `${Math.round(v * 100)}%`),
  },
  {
    key: 'pixelRatio',
    label: 'Pixel Ratio',
    min: 0.5,
    max: 2,
    step: 0.05,
    format: (v) => `${v.toFixed(2)}x`,
  },
];

const TOGGLES: readonly { key: ToggleKey; label: string }[] = [
  { key: 'buoyancyProbes', label: 'Buoyancy Probes' },
  { key: 'wakeProbes', label: 'Wake Probes' },
  { key: 'forceWebGL', label: 'Force WebGL' },
];

const QUALITY_LABELS: Record<QualityTier, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  ultra: 'Ultra',
  max: 'Max',
};

// Neutral, descriptive names. The preset *ids* are stable API; the labels
// describe the look rather than borrowing product or game titles.
const PRESET_LABELS: Record<PresetId, string> = {
  skyPro: 'Clear Day',
  arctic: 'Arctic',
  blackFlag: 'High Seas',
  dusk: 'Dusk',
  foggy: 'Foggy',
  moonlit: 'Moonlit',
  seaOfThieves: 'Tropical',
  storm: 'Storm',
  sunset: 'Sunset',
};

let instanceCounter = 0;

function sliderSpec(key: SliderKey): SliderSpec {
  const spec = SLIDERS.find((s) => s.key === key);
  if (spec === undefined) throw new Error(`Panel: no slider spec for "${key}"`);
  return spec;
}

/**
 * Every declared slider must be placed exactly once.
 *
 * Called at construction rather than written as a comment, because the failure
 * this guards against is invisible: a slider that is never built does not throw,
 * does not warn, and does not look different from one the designer left out.
 */
function assertSlidersPlaced(): void {
  const placed = [...ENVIRONMENT_SLIDERS, ...DISPLAY_SLIDERS] as readonly SliderKey[];
  for (const spec of SLIDERS) {
    const count = placed.filter((key) => key === spec.key).length;
    if (count !== 1) {
      throw new Error(
        `Panel: slider "${spec.key}" is placed ${count} times; it must be placed exactly once`,
      );
    }
  }
  for (const key of placed) {
    if (!SLIDERS.some((spec) => spec.key === key)) {
      throw new Error(`Panel: slider "${key}" is placed but has no spec`);
    }
  }
}

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

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export class Panel {
  private readonly root: HTMLElement;
  private readonly callbacks: UiCallbacks;
  private readonly controller = new AbortController();
  private readonly state: UiState;
  private readonly sliders = new Map<SliderKey, SliderRefs>();
  private readonly toggles = new Map<ToggleKey, HTMLButtonElement>();
  private readonly qualitySelect: HTMLSelectElement;
  private readonly presetSelect: HTMLSelectElement;
  private readonly panelEl: HTMLElement;
  private readonly sheetButton: HTMLButtonElement;
  private disposed = false;
  private sheetOpen = false;

  constructor(root: HTMLElement, initial: UiState, callbacks: UiCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.state = { ...initial };

    assertSlidersPlaced();

    const uid = `panel${++instanceCounter}`;
    const signal = this.controller.signal;

    const panel = el('section', 'panel');
    panel.setAttribute('aria-label', 'Ocean controls');
    panel.id = `${uid}-sheet`;

    // ---- Title block -------------------------------------------------------
    // No standfirst under the title. An eyebrow or subtitle stacked on a heading
    // is a label doing work the heading already does — and "Demo" told a visitor
    // nothing they could not see. The heading carries itself.
    const head = el('header', 'panel__head');
    const title = el('h1', 'panel__title');
    title.append('Web ', el('span', 'panel__title-accent', 'Ocean'), ' 3D');
    head.append(title);
    panel.append(head);

    const body = el('div', 'panel__body');
    panel.append(body);

    // ---- Selects -----------------------------------------------------------
    this.qualitySelect = this.buildSelect(
      body,
      `${uid}-quality`,
      'Quality',
      QUALITY_TIERS.map((tier) => [tier, QUALITY_LABELS[tier]] as const),
      this.state.quality,
    );
    this.qualitySelect.addEventListener(
      'change',
      () => {
        const value = this.qualitySelect.value as QualityTier;
        if (!QUALITY_TIERS.includes(value)) return;
        this.state.quality = value;
        this.callbacks.onChange('quality', value);
      },
      { signal },
    );

    this.presetSelect = this.buildSelect(
      body,
      `${uid}-preset`,
      'Preset',
      PRESET_IDS.map((id) => [id, PRESET_LABELS[id]] as const),
      this.state.preset,
    );
    this.presetSelect.addEventListener(
      'change',
      () => {
        const value = this.presetSelect.value as PresetId;
        if (!PRESET_IDS.includes(value)) return;
        this.state.preset = value;
        this.callbacks.onChange('preset', value);
      },
      { signal },
    );

    // ---- Wave / sky sliders ------------------------------------------------
    for (const key of ENVIRONMENT_SLIDERS) {
      this.buildSlider(body, `${uid}-${key}`, sliderSpec(key));
    }

    body.append(el('div', 'panel__divider'));

    // ---- Toggles -----------------------------------------------------------
    for (const toggle of TOGGLES) {
      this.buildToggle(body, toggle.key, toggle.label);
    }

    // ---- Display sliders ---------------------------------------------------
    for (const key of DISPLAY_SLIDERS) {
      this.buildSlider(body, `${uid}-${key}`, sliderSpec(key));
    }

    body.append(el('div', 'panel__divider'));

    // ---- Actions -----------------------------------------------------------
    const actions = el('div', 'panel__actions');
    const primary = el('a', 'btn btn--primary', 'View Source');
    primary.href = SOURCE_URL;
    primary.rel = 'noopener';
    primary.target = '_blank';
    actions.append(primary);
    body.append(actions);

    // ---- Mobile bottom-sheet trigger --------------------------------------
    const sheetButton = el('button', 'panel-toggle');
    sheetButton.type = 'button';
    sheetButton.setAttribute('aria-controls', panel.id);
    sheetButton.setAttribute('aria-expanded', 'false');
    sheetButton.append(el('span', 'panel-toggle__icon'), el('span', undefined, 'Settings'));
    sheetButton.addEventListener('click', () => this.setSheetOpen(!this.sheetOpen), { signal });

    this.panelEl = panel;
    this.sheetButton = sheetButton;
    this.root.append(panel, sheetButton);
  }

  /** Push values in from the host without re-emitting change callbacks. */
  setState(partial: Partial<UiState>): void {
    if (this.disposed) return;

    if (partial.quality !== undefined) {
      this.state.quality = partial.quality;
      this.qualitySelect.value = partial.quality;
    }
    if (partial.preset !== undefined) {
      this.state.preset = partial.preset;
      this.presetSelect.value = partial.preset;
    }
    if (partial.cameraMode !== undefined) {
      this.state.cameraMode = partial.cameraMode;
    }

    for (const [key, refs] of this.sliders) {
      const next = partial[key];
      if (next === undefined) continue;
      // `timeOfDay` is nullable — null means the preset still owns the sun. The
      // control has to show *something*, so it falls back to the preset's own
      // elevation, which the app supplies alongside the null.
      if (next === null) continue;
      const value = clamp(next, refs.spec.min, refs.spec.max);
      this.state[key] = value;
      refs.input.value = String(value);
      this.paintSlider(refs);
    }

    for (const [key, button] of this.toggles) {
      const next = partial[key];
      if (next === undefined) continue;
      this.state[key] = next;
      button.setAttribute('aria-checked', next ? 'true' : 'false');
      button.classList.toggle('is-on', next);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    this.panelEl.remove();
    this.sheetButton.remove();
    this.sliders.clear();
    this.toggles.clear();
  }

  // -- builders -------------------------------------------------------------

  private buildSelect(
    parent: HTMLElement,
    id: string,
    labelText: string,
    options: readonly (readonly [string, string])[],
    selected: string,
  ): HTMLSelectElement {
    const field = el('div', 'field');
    const label = el('label', 'field__label', labelText);
    label.htmlFor = id;

    const shell = el('div', 'select');
    const select = el('select', 'select__input');
    select.id = id;
    for (const [value, text] of options) {
      const option = el('option', undefined, text);
      option.value = value;
      select.append(option);
    }
    select.value = selected;
    shell.append(select);
    field.append(label, shell);
    parent.append(field);
    return select;
  }

  private buildSlider(parent: HTMLElement, id: string, spec: SliderSpec): void {
    const field = el('div', 'field field--slider');
    const row = el('div', 'field__row');
    const label = el('label', 'field__label', spec.label);
    label.htmlFor = id;
    const value = el('span', 'field__value');
    row.append(label, value);

    const input = el('input', 'range');
    input.type = 'range';
    input.id = id;
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(this.state[spec.key]);

    const refs: SliderRefs = { spec, input, value };
    this.sliders.set(spec.key, refs);
    this.paintSlider(refs);

    input.addEventListener(
      'input',
      () => {
        const next = clamp(Number(input.value), spec.min, spec.max);
        this.state[spec.key] = next;
        this.paintSlider(refs);
        this.callbacks.onChange(spec.key, next);
      },
      { signal: this.controller.signal },
    );

    field.append(row, input);
    parent.append(field);
  }

  private buildToggle(parent: HTMLElement, key: ToggleKey, labelText: string): void {
    const button = el('button', 'switchrow');
    button.type = 'button';
    button.setAttribute('role', 'switch');
    const on = this.state[key];
    button.setAttribute('aria-checked', on ? 'true' : 'false');
    button.classList.toggle('is-on', on);

    const track = el('span', 'switch');
    track.append(el('span', 'switch__knob'));
    button.append(el('span', 'switchrow__label', labelText), track);

    button.addEventListener(
      'click',
      () => {
        const next = !this.state[key];
        this.state[key] = next;
        button.setAttribute('aria-checked', next ? 'true' : 'false');
        button.classList.toggle('is-on', next);
        this.callbacks.onChange(key, next);
      },
      { signal: this.controller.signal },
    );

    this.toggles.set(key, button);
    parent.append(button);
  }

  // -- helpers --------------------------------------------------------------

  private paintSlider(refs: SliderRefs): void {
    const { spec, input, value } = refs;
    const current = Number(input.value);
    const pct = ((current - spec.min) / (spec.max - spec.min)) * 100;
    input.style.setProperty('--fill', `${clamp(pct, 0, 100).toFixed(2)}%`);
    value.textContent = spec.format(current);
    input.setAttribute('aria-valuetext', spec.format(current));
  }

  private setSheetOpen(open: boolean): void {
    this.sheetOpen = open;
    this.panelEl.classList.toggle('panel--open', open);
    this.sheetButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    this.sheetButton.classList.toggle('is-active', open);
  }
}
