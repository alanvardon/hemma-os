# Plan 75 — Kill the iOS focus-zoom: 16 px inputs on touch screens

**Status:** plan · **Owner model:** Sonnet-suitable (mechanical CSS rule,
but bumping input font 14→16 px reflows every tight form grid — each tool
needs a 390 px eyeball pass, which is exactly the plan-57/74 checklist
again; batch it with 74 in one branch if convenient) · **Source:** mobile
design review 2026-07-07 · **Sequencing:** after 74 (both touch the same
row layouts; 74's wrapping rules should win, then this reflow lands on the
fixed layout) · **Touches:** one shared rule in `global.css` or
`components.css`; per-tool exceptions in `konsultkalkyl.css:92-94`,
`components.css:93` (.listing-row input, 13 px), `components.css:388`
(.afford-input, 12 px) and siblings.

## Finding

Every input in the suite renders below 16 px: the standard field input is
**14 px** (verified live — all 8 inputs on Konsultkalkyl compute to 14 px;
konsultkalkyl.css:92), `.listing-row input` is 13 px, `.afford-input`
12 px. The viewport meta is `width=device-width, initial-scale=1.0`
(web/index.html:16) with no `maximum-scale` — correct for accessibility,
but it means **iOS Safari auto-zooms the page ~1.15-1.33× on every input
focus** and does not zoom back on blur. On a phone-first household app
where both users enter salaries, costs and payments monthly, every single
form interaction shunts the layout sideways and leaves the page zoomed.
This is the classic "web app vs app" tell on iPhone.

Do NOT fix it with `maximum-scale=1` / `user-scalable=no` — that disables
pinch-zoom for low-vision users and Android respects it; the only correct
fix is 16 px inputs.

## Fix

One rule, scoped to touch devices so desktop density is untouched:

```css
/* global.css — iOS zooms any focused input rendered below 16px.
   Coarse pointer = touch: min 16px on every text-entry control. */
@media (pointer: coarse) {
  input, select, textarea { font-size: 16px; }
}
```

- Audit the exceptions: `.listing-row input` (13 px), `.afford-input`
  (12 px in a 52 px box — 16 px will overflow it; widen the box or accept
  a slightly larger chip), the dialog inputs from plans 39b/c, and any
  spinbutton in the Bostadskalkyl bank cards. The media query must win
  everywhere — check specificity, don't sprinkle `!important`.
- Eyeball all seven routes at 390 px after the bump: 16 px digits in the
  2-up grids (Konsultkalkyl Timpris/Timmar row) must not re-introduce the
  plan-57 label/value squeeze. Where a grid becomes too tight, the grid
  goes single-column at ≤ 480 px rather than the font going back down.
- Real-device (or iOS Simulator Safari) spot check: focus a Konsultkalkyl
  input and a Hushållsbudget cost input → no viewport zoom.

## Acceptance criteria

- `[...document.querySelectorAll('input,select,textarea')].every(e =>
  parseFloat(getComputedStyle(e).fontSize) >= 16)` on every route with
  touch emulation (Playwright `hasTouch`), 390 px.
- iOS Safari (device or simulator): focusing inputs on Konsultkalkyl and
  Hushållsbudget triggers no zoom; pinch-zoom still works.
- No new horizontal overflow at 390 px (re-run plan 74's probe).
- Desktop (fine pointer) rendering byte-identical CSS-wise — the rule is
  inert there (visual diff on one route suffices).
