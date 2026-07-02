# Plan 25 — Whoosh miniature fits the card for tall tools (Månadsavslut, Bolånekoll)

**Status:** plan · **Owner model:** Sonnet-suitable (one CSS rule + a scroll
caveat call) · **Req:** 3 (of this batch) · **Relationship:** fixes the
shared-element whoosh from plans 08/09/12; touches only `transitions.css`.

## Goal

When you open a tool from the hub, the forward whoosh should read as *this card
grows into the page* — a card-shaped miniature zooming up. For the short tools
(Konsultkalkyl, Löneväxling) it does. For **Månadsavslut** and **Bolånekoll** it
doesn't: the miniature at the start of the zoom is the **entire long page**
crammed into the card slot — a tiny, tall, squished full document — instead of a
clean card-shaped box. Back reverses the same wrongness (a full page shrinks
down instead of the page docking as a card).

## Root cause

The shared element is `.vt-page` (the tool-page root: `.ma-root`, `.bk-root`,
etc.), which claims `view-transition-name: tool-card` only during the transition
(via `useToolPageActive`). Its transition-only rule today is:

```css
/* transitions.css */
.vt-page {
  view-transition-name: tool-card;
  background: var(--paper);
  min-height: 100svh;   /* floor only — NO ceiling */
}
```

The View Transitions API snapshots the **named element at its full rendered
size**. Månadsavslut and Bolånekoll are long, scrollable pages, so their root is
2–4× viewport height. The snapshot is therefore a tall image, and when the
`tool-card` group morphs it down into the small (roughly viewport-ratio) card
slot you see the whole long page miniaturised. Konsultkalkyl / Löneväxling are
~one viewport tall, so their snapshot is already card/viewport-shaped and the
zoom reads correctly. The differentiator is **content height**, nothing tool-
specific.

## Fix — clip the transition snapshot to one viewport

Give `.vt-page` a **height ceiling of one viewport and clip the overflow**, so
the captured snapshot is always exactly the top viewport of the page — the same
shape the short tools already produce:

```css
.vt-page {
  view-transition-name: tool-card;
  background: var(--paper);
  min-height: 100svh;
  max-height: 100svh;   /* NEW: cap the captured snapshot to one viewport */
  overflow: hidden;     /* NEW: clip the rest so the snapshot is card-shaped */
}
```

Because the class is applied **only during the transition** (added by
`useToolPageActive`, removed when `data-vt-dir` clears), the live page's normal
height and scrolling are untouched — this only shapes the snapshot the VT
captures. For the short tools `max-height: 100svh` is a no-op (they're already
≤ one viewport), so they keep looking exactly as they do now.

## Caveat to decide during implementation — back trip from a scrolled page

Forward is clean: the destination page mounts fresh at scroll-top, so clipping
to the top viewport shows the real top of the tool. **Back** is the case to eye:
if the user has scrolled down inside Månadsavslut/Bolånekoll and then navigates
home, `overflow: hidden` + `max-height` clips to the element's **top**, not the
current scroll offset — so the shrinking miniature shows the page *header*, not
what was on screen. Two acceptable resolutions, pick one after looking at it:

1. **Ship as-is (recommended).** The miniature still reads as a clean card
   docking into the slot; showing the page top on the way out is a minor,
   arguably nicer, "return to the top of the tool" cue. Simplest, zero JS.
2. **Anchor the clip to scroll position** only if #1 looks jarring: before the
   back nav, set `--vt-clip-top: <scrollY>px` and use `object-view-box` / a
   translate on the captured content so the visible viewport is snapshotted.
   More moving parts; only reach for it if the manual check demands it.

Do **not** over-engineer this preemptively — implement the one-rule fix, click
both tools forward *and* back (top and scrolled), and only add #2 if it reads
wrong.

## Verify these didn't regress

- Both `data-vt-dir='forward'` and `'back'` keyframes (`vt-grow-round`,
  `vt-shrink-round`, corner rounding) still land — the clip changes the snapshot
  *shape*, not the group animation.
- `min-height: 100svh` still wins for genuinely short content (the miniature
  must fill, not letterbox) — keep it; `max-height` only caps the tall case.
- Mobile (≤600px) path is unaffected: it drops `view-transition-name` entirely
  (`.vt-card, .vt-page { view-transition-name: none }`) and uses the push, so
  the new `max-height`/`overflow` never participate there.
- Reduced-motion path unchanged (VT animations already `none`).

## Out of scope
- The tool pages' own layout/scroll behaviour (live pages keep their real height).
- The camera pan / dolly tuning (plans 08/09) and background overscan (plan 26).
- Any change to `useToolPageActive` / `viewTransition.ts` — CSS-only fix.

## Definition of done
- Opening **Månadsavslut** and **Bolånekoll** from the hub shows a card-shaped
  miniature growing to full page (not a squished full document), matching the
  short tools; back docks a card-shaped miniature into the slot.
- Short tools visually unchanged.
- `npm run build && npx oxlint src && npx vitest run` green; manual forward+back
  click-through of all six tools (each at scroll-top and scrolled-down).
