# Plan 29 — Homepage hygiene: mobile overflow, focus polish, Soon demotion

**Status:** plan · **Owner model:** Sonnet-suitable (small CSS/markup changes,
one measurable bug) · **Req:** 1 (of this batch, build order 29→30→31→32) ·
**Relationship:** hygiene pass on the hub before the living bento (plan 30)
rebuilds the grid; touches `Home.tsx`, `home.css`, `global.css` only.

## Goal

Three small usability debts on the hub, one PR: a real horizontal-overflow bug
on mobile, default-grade keyboard focus on a page where everything else is
crafted, and two "Soon" placeholder cards costing a full grid row while
diluting the Live chips.

## A. Mobile horizontal overflow (bug)

Measured on main at 390×844: `document.body.scrollWidth > window.innerWidth`
is **true** — the overscanned hero canvas (plan 26/28: inline width = hero
width × 1.8, `left: -40%`) extends the layout. `body { overflow-x: hidden }`
exists, but on iOS Safari a body-level guard is unreliable unless `html` is
also guarded, and stray overflow can break `position: sticky` and cause
rubber-band side-panning.

Fix: `html { overflow-x: clip }` (clip, not hidden — it cannot create a
scroll container, so it can't eat scroll gestures or break sticky).

Must-verify (the reason the overscan exists at all):
- The hub-pan toward every corner card still shows terrain, never a canvas
  edge — viewport-level clip only cuts at the viewport, and the pan
  translates the overscan INTO view, so this should hold; confirm visually.
- `scrollWidth === innerWidth` afterward at 390px, and the sticky header
  stays pinned.
- Real-device (or DevTools device-mode touch) check: no sideways pan.

## B. Focus polish + skip link

- `:focus-visible` on `.app-card`, `.wordmark`, `.theme-toggle-btn`: the
  existing `--ring` token plus the same border-accent + lift the cards use on
  hover — keyboard users get the hover experience, not a UA default outline.
  (Focus must NOT trigger the sheen sweep — that's pointer flair.)
- Skip link: first tabbable element, visually hidden until focused
  (`position: fixed`, appears top-left on focus), jumping to `#tools`
  (add `id="tools"` to the `.apps` section). Style it like a small
  `.chip-live` so even the a11y affordance is on-brand.

## C. Demote the "Soon" cards

Remove the Kalender and Matplan cards from the grid. Replace with one quiet
line in the footer, next to the Local-first badge:
`Kommer snart: Kalender · Matplan` (`--ink-soft`, 12.5px, matching footer
type). The six live tools own the grid; plan 30 uses the freed space for the
wide bento cards.

- Delete the two `.app-card.soon` blocks in `Home.tsx` and the now-unused
  `.app-card.soon` CSS (verify no other tool page uses it first).
- Reveal stagger: reveals 10–11 die with the cards; renumber nothing (gaps in
  the delay classes are harmless), but cap the last delay so the footer
  doesn't inherit a 1s wait if it has a reveal class.

## Out of scope

- Grid hierarchy, live stats, card ordering — plan 30.
- Scroll cue and dark-mode glow — plan 31.
- Any hero/scene change.

## Definition of done

- 390px fresh load: `body.scrollWidth === window.innerWidth`; hub-pan to all
  four corner cards shows no canvas edge; sticky header unaffected.
- Tab from load: skip link appears first and jumps to Tools; every card shows
  the accent ring + lift on `:focus-visible`; pointer clicks show no ring.
- Grid shows exactly six cards; footer carries the Kommer-snart line in both
  themes.
- `npm run build` + `npx oxlint src` + `npx vitest run` green (no test
  changes expected — this is markup/CSS).
