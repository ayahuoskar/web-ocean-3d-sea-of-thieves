---
name: Web Ocean 3D
description: The instrument as a printed reference page — an Admiralty tide table read at a chart table under a shaded red lamp.
colors:
  ink: "#14100d"
  ink-raised: "#1e1813"
  ink-deep: "#0b0806"
  bone: "#e9dfcb"
  bone-dim: "#a2937c"
  rule: "#443c33"
  rule-soft: "#372f28"
  red: "#e8503a"
  red-deep: "#b0341f"
  ok: "#8fbf6a"
  warn: "#e0a33c"
typography:
  voice:
    fontFamily: "Bodoni Moda, Bodoni 72, Didot, Times New Roman, serif"
    fontSize: "clamp(30px, 7vw, 44px)"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "0.005em"
  reading:
    fontFamily: "Bitter, Roboto Slab, Rockwell, Georgia, serif"
    fontSize: "40px"
    fontWeight: 600
    lineHeight: 0.94
    letterSpacing: "-0.02em"
  label:
    fontFamily: "Bitter, Roboto Slab, Rockwell, Georgia, serif"
    fontSize: "9.5px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.2em"
  value:
    fontFamily: "Bitter, Roboto Slab, Rockwell, Georgia, serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.01em"
rounded:
  none: "0"
spacing:
  hair: "4px"
  tight: "6px"
  row: "9px"
  rowTop: "13px"
  gutter: "16px"
  edge: "20px"
components:
  panel:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.bone}"
    rounded: "{rounded.none}"
    width: "296px"
  field-label:
    textColor: "{colors.bone-dim}"
    typography: "{typography.label}"
  field-value:
    textColor: "{colors.bone}"
    typography: "{typography.value}"
  select:
    backgroundColor: "{colors.ink-deep}"
    textColor: "{colors.bone}"
    rounded: "{rounded.none}"
    padding: "7px 26px 7px 9px"
  range-track:
    backgroundColor: "{colors.rule-soft}"
    rounded: "{rounded.none}"
    height: "5px"
  range-fill:
    backgroundColor: "{colors.bone-dim}"
    height: "5px"
  range-thumb:
    backgroundColor: "{colors.red}"
    rounded: "{rounded.none}"
    width: "2px"
    height: "15px"
  toggle-box:
    backgroundColor: "{colors.ink-deep}"
    rounded: "{rounded.none}"
    size: "15px"
  toggle-box-on:
    backgroundColor: "{colors.red}"
    rounded: "{rounded.none}"
    size: "11px"
  button-primary:
    backgroundColor: "transparent"
    textColor: "{colors.bone-dim}"
    rounded: "{rounded.none}"
    padding: "10px 14px"
    typography: "{typography.label}"
  button-primary-hover:
    backgroundColor: "{colors.red}"
    textColor: "{colors.ink}"
  index-row:
    backgroundColor: "transparent"
    textColor: "{colors.bone-dim}"
    rounded: "{rounded.none}"
    padding: "5px 14px 5px 13px"
  index-row-active:
    backgroundColor: "{colors.ink-raised}"
    textColor: "{colors.bone}"
  keycap:
    backgroundColor: "{colors.ink-deep}"
    textColor: "{colors.bone-dim}"
    rounded: "{rounded.none}"
    padding: "1px 5px"
---

# Design

Recorded from the built interface, not from an intention written before it.

## Overview

The interface is a **printed reference page** — specifically an Admiralty tide
table or a page of the Nautical Almanac — laid over a realtime sea.

The scene that decides everything is a chart table at three in the morning under
a shaded red lamp. That is the one place a printed table is actually read against
a dark window, and it is what makes the ground warm near-black rather than paper
white: the page here is always seen over moving water at whatever hour the
viewer has set, so a bright sheet would be a hole punched in the render.

Four rules carry the whole system, and each one refuses something this category
ships by default:

1. **Opaque, never glass.** There is no `backdrop-filter` anywhere. A blurred
   panel over a 3D canvas is both the genre cliché and a real per-frame cost on
   the exact surface whose frame budget *is* the product. Opaque is also the only
   thing legible over a sea that is white in one corner and black in the other.
2. **Square.** No `border-radius` anywhere. A rounded rectangle is a software
   affordance; a page has corners.
3. **Ruled.** Structure comes from hairlines and double rules the way a table
   carries it — never from boxes, cards or elevation. Nothing here is a card and
   nothing is nested inside another one.
4. **One overprint.** A single vermilion, spent the way an almanac spends it: on
   the *reading* — the tick on a scale, the row you are in, a ticked box — and
   never on furniture, never as a glow.

The product principle behind all four is that the render is the product and the
interface is the frame around it. Any pixel of chrome has to earn its place
against showing more ocean.

## Colors

| Token | Value | On `ink` | Use |
|---|---|---|---|
| `ink` | `#14100d` | — | The page. Every surface ground. |
| `ink-raised` | `#1e1813` | — | The row under the pointer, and the active index row. |
| `ink-deep` | `#0b0806` | — | Wells: select interiors, keycaps, unticked boxes, the body behind everything. |
| `bone` | `#e9dfcb` | 13.4:1 | The impression. All primary type and every figure. |
| `bone-dim` | `#a2937c` | 6.3:1 | Labels, units, secondary rows, bar tint. |
| `rule` | `#443c33` | 2.4:1 | **Hairlines only, never text.** |
| `rule-soft` | `#372f28` | — | Row rules inside a table. |
| `red` | `#e8503a` | 5.1:1 | The overprint. Readings and state, nothing else. |
| `warn` | `#e0a33c` | — | Reserved for the two truth-telling instruments (below). |

Two colour decisions were forced by measurement rather than taste, and both are
worth keeping:

- The overprint started as a truer vermilion (`#d6402c`) and measured **4.2:1**
  on the ink — under the 4.5 floor, so it could not legally carry a value anyone
  has to read. Lifting it to `#e8503a` brings it to 5.1:1.
- The primary button knocks out in **ink on red, not bone on red**. Bone measures
  2.8:1 against this vermilion and is simply unreadable; ink measures 5.1:1 — and
  reversing the type out of a solid is what a press does anyway.

`rule` is deliberately below the text floor. Hairlines are drawn objects, not
writing; holding them to a reading contrast turns a ruled table into a striped
one. Nothing in the stylesheet sets it as a text colour.

## Typography

Two families, four files, self-hosted, 167 KB total — a roman **and a true
italic** for each. Declaring only a roman does not disable italic; it makes the
browser shear the upright letterforms, and a Didone is the worst face to do that
to, since a real Bodoni italic is a different alphabet (single-storey `a`, entry
and exit strokes, a narrower fit). The two places this project sets italic are
its own name and the storm quote, so a synthesised oblique lands precisely on the
one line that is voice rather than instrument.

The split between the families is load-bearing:

- **Bodoni Moda** is the project's *voice*: its name, and the one line of prose it
  ever speaks (the storm quote). Nothing else.
- **Bitter** is its *instrument*: every label, figure, table row and control.

That separation is a brand commitment recorded in PRODUCT.md — the storm quote
must never read as one more readout — and it survives the redesign in a changed
form. The old rule was "a serif, where everything else is a UI sans". Here the
whole interface is already a slab serif, so the distinction is carried by voice
versus instrument instead.

Labels are set at 9.5px/700 with `0.2em` tracking in caps: the letterspaced small
capitals a printed table uses for its column heads. Figures carry
`font-variant-numeric: tabular-nums` **and** a `min-width` in `ch` behind it,
because `tnum` is a font feature that silently does nothing if the face lacks it,
and a jittering column is the one failure this world cannot afford.

## Layout

- Panel 296px, top-right; HUD 188px, top-left; 20px edge gutter (12px under
  900px).
- Row rhythm is asymmetric — `13px` above, `9px` below — so a label binds to the
  bar it describes rather than floating between two of them.
- Below 900px the panel becomes a bottom sheet on `transform`, and the HUD's key
  legend is dropped rather than shrunk.
- `.panel__body` carries `min-height: 0`. This is load-bearing: a flex child
  defaults to `min-height: auto` and refuses to shrink, so the body grew past the
  panel's `max-height`, `overflow: hidden` cut the bottom off, and two sliders
  were simply not on screen — while `scrollWidth` stayed equal to `clientWidth`,
  because clipped content does not overflow.

## Elevation & Depth

One elevation, one shadow: `0 14px 34px rgba(0,0,0,.55), 0 2px 6px rgba(0,0,0,.4)`.
Offset and blur, never a zero-offset halo — this is a sheet lying on a surface,
and a sheet casts its shadow downward.

Panels carry two nearly-invisible crossed gradients over the flat ground. Not
decoration: a 300px field of one colour bands on an 8-bit display sitting next to
a dithered ocean.

## Shapes

Everything is square. `--rounded-none: 0` is the only radius token and there is
no exception anywhere in the stylesheet, including the focus ring.

Rules come in two weights: `1px solid` between rows within a group, and
`3px double` as a section break — the almanac's two lines with a hair of paper
between them. Dividers run full-bleed to the panel edge (`margin-inline: -16px`)
the way a printed rule runs to the margin rather than stopping at the text block.

## Components

- **Range** — a printed bar with a pencil tick. The fill is a *tint*
  (`bone-dim`), not solid ink: at full bone it was a 300px block of the brightest
  colour in the system repeated seven times down the panel, which made the
  controls louder than the sea. The reading is the 2px vermilion rule; the bar
  only says where in its range it sits. The thumb is carried on a 12px
  transparent block (30px on coarse pointers) so the grab target is a finger's
  worth of screen rather than two pixels.
- **Toggle** — a ballot box, ticked. Not a sliding switch: a switch is hardware
  borrowed from a phone, and a printed form has a box you mark. The knob element
  survives from the old markup and becomes the mark inside the box.
- **Select** — a table row with a solid triangular marker in `bone-dim`, not a
  chevron chip. The marker is deliberately *not* red; red is for readings.
- **Camera index** — numbered rows, not a row of cards. The active row takes a
  vermilion left rule; every row reserves that 1px margin so selecting one never
  shifts the column.
- **Backend stamp** — the one place colour is an assertion rather than a
  decoration. On the WebGL2 fallback there is no planar reflection, no refraction
  and no lens misting, so the visitor is looking at a materially reduced scene
  and the stamp overprints in `warn` to say so.

## Do's and Don'ts

**Do**

- Spend the vermilion on readings and state. A new control gets red only where it
  reports a value or a selection.
- Reach for a rule before reaching for a box. If something needs separating, rule
  it.
- Set figures in Bitter with tabular numerals and a `ch` floor.
- Pick dark or light from the use scene, not from category habit.

**Don't**

- Add `backdrop-filter`, `border-radius`, or a gradient anywhere.
- Introduce a card, and never nest one.
- Put an eyebrow, kicker or standfirst above a heading. The panel used to carry
  "Demo" under its title; the heading carries itself.
- Set Bodoni anywhere except the project's name and the storm quote. Using the
  voice face for a readout collapses the one distinction PRODUCT.md binds.
- Use `rule` or `rule-soft` as a text colour.
- Animate `width`, `height`, `padding` or `margin`. The boot bar used to animate
  `width` — a layout pass and a paint per update, during the one stretch where
  the main thread is already compiling shaders. It is `transform: scaleX()` now.
