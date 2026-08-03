import type { PresetId } from './types';

/**
 * A line of text over the sea, shown once when the viewer takes the helm in
 * heavy weather.
 *
 * **Why it is a DOM element and not drawn in the scene.** Everything else on
 * screen that is text — the HUD, the panel — is DOM, and text is the one thing a
 * browser does better than a renderer: hinting, subpixel positioning, ligatures
 * and a font stack that degrades gracefully are all free here and would each be
 * work in a texture atlas. The overlay is `pointer-events: none`, so it cannot
 * take a click away from the helm.
 *
 * **Why it fires once.** A line that reappears every time the weather crosses a
 * threshold stops being a moment and becomes a notification. This arms when the
 * viewer is *not* at the helm in a storm and fires on the transition into it, so
 * sailing out of a squall and back in shows it again, but pitching over the
 * threshold mid-wave does not flicker it. `reset()` re-arms it for a harness.
 *
 * The fade is CSS rather than a JS tween for the same reason the element is DOM:
 * the compositor owns it, so it stays smooth through a frame the renderer
 * misses — which, in the weather this fires in, is exactly when it is showing.
 */

/** Presets that count as heavy weather for the purpose of the line. */
const STORMY: ReadonlySet<PresetId> = new Set<PresetId>(['storm']);

/**
 * Wind speed, m/s, above which the sea is rough enough to earn it even under a
 * preset that is not nominally a storm.
 *
 * 18 is a strong gale on the Beaufort scale and comfortably past the 15 m/s the
 * clear-day preset ships with, so the line does not fire on the default sea.
 */
const STORMY_WIND = 18;

/** Seconds the line holds at full opacity, between the fades. */
const HOLD_SECONDS = 4.5;
/** Seconds each fade takes. Matches the CSS transition. */
const FADE_SECONDS = 1.6;

const QUOTE = 'A smooth sea never made a skilled sailor';

export interface QuoteState {
  preset: PresetId;
  windSpeed: number;
  atHelm: boolean;
}

export class StormQuote {
  private readonly root: HTMLElement;
  private readonly el: HTMLElement;

  /** Armed once the viewer is seen *outside* the trigger condition. */
  private armed = false;
  private shownAt: number | null = null;
  private visible = false;
  private disposed = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.el = document.createElement('div');
    this.el.className = 'quote';
    this.el.setAttribute('aria-hidden', 'true');

    const line = document.createElement('p');
    line.className = 'quote__line';
    line.textContent = QUOTE;
    this.el.append(line);
    this.root.append(this.el);
  }

  /**
   * Drives the overlay from the world's state and the simulation clock.
   *
   * `elapsed` rather than a wall clock, so a deterministic rewind puts the
   * overlay back where it was instead of leaving a line fading over a capture.
   */
  update(state: QuoteState, elapsed: number): void {
    if (this.disposed) return;

    const stormy = STORMY.has(state.preset) || state.windSpeed >= STORMY_WIND;
    const trigger = stormy && state.atHelm;

    if (!trigger) {
      // Leaving the condition re-arms it. Note this is checked before the
      // timeout below, so stepping off the helm takes the line with it rather
      // than leaving it hanging over a camera that has cut elsewhere.
      this.armed = true;
      if (this.visible) this.hide();
      return;
    }

    if (this.armed) {
      this.armed = false;
      this.shownAt = elapsed;
      this.show();
      return;
    }

    if (this.visible && this.shownAt !== null && elapsed - this.shownAt > HOLD_SECONDS) {
      this.hide();
    }
  }

  /** Re-arms and clears, for a deterministic capture. */
  reset(): void {
    this.armed = true;
    this.shownAt = null;
    this.hide();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.el.remove();
  }

  private show(): void {
    this.visible = true;
    this.el.classList.add('quote--on');
  }

  private hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.shownAt = null;
    this.el.classList.remove('quote--on');
  }
}

export const QUOTE_FADE_SECONDS = FADE_SECONDS;
