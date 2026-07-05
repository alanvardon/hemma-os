# Plan 32 — Kinetic type entrance + icon line-draw: the final lacquer

**Status:** plan · **Owner model:** Sonnet-suitable with taste checkpoints
(both effects are timing/easing judgement; screenshot before/after) ·
**Req:** 4 (of this batch; last — polish over whatever plan 30 made of the
grid) · **Relationship:** replaces the hero copy's single-block `rise-in-hub`
reveal (plan: the whole h1 currently rises as one slab); icon paths are the
stroke SVGs already inline in `Home.tsx`; must respect the `viaBack`
no-reveal suppression and `prefers-reduced-motion` exactly like the existing
reveals.

## Goal

The two remaining items from the original "award-winning" list: the h1
performs its entrance instead of fading in as a block, and the card icons
reward hover the way the terrain rewards the pointer.

## A. Kinetic type entrance

**The trap first:** true per-line mask reveals require measuring rendered
line boxes (SplitType-style) and re-splitting on resize — brittle with a
responsive serif at `clamp(2.9rem, 8.5vw, 6rem)`. Not worth it.

**Chosen approach — semantic block spans:** author the h1 as three
`display: block` spans matching its phrasing:

```
<span>Everything for the</span>
<span>household, <em>in one</em></span>
<span><em>place.</em></span>
```

Each span gets its own mask reveal (`clip-path: inset(0 0 100% 0)` →
`inset(0)` with a ~90ms stagger, the existing `cubic-bezier(0.22,1,0.36,1)`
ease, ~0.7s each) plus a small translateY rise. Lines inside a span wrap
together on narrow viewports — the reveal degrades to "phrase by phrase",
which still reads intentional (this is the compromise that buys resilience).
Check the authored breaks at 390/768/1440: they must never force an ugly
mid-word river; adjust span boundaries by eye.

- The italic `place.` gets a **drawn underline**: an `::after` (2px, accent)
  scaling from `scaleX(0)` left-origin to full over 0.5s, delayed until its
  span's mask lands. Same accent as the em color.
- Greeting and sub keep their current reveals; only the h1 upgrades.
- `viaBack === true` (back-whoosh) and `prefers-reduced-motion`: spans render
  fully visible, underline already drawn — reuse the exact `no-reveal` /
  media-query gating the current reveals use, no new mechanism.

## B. Icon line-draw on hover

The six card icons are inline stroke SVGs — the classic dash trick applies:

- Add `pathLength="1"` to every `<path>`/`<rect>` in the icons (normalizes
  dash math regardless of geometry; rects support pathLength too).
- CSS on `a.app-card:hover .app-icon` paths: `stroke-dasharray: 1;
  stroke-dashoffset: 1; animation: icon-draw 0.55s ease forwards`, with
  `animation-delay: calc(var(--i, 0) * 90ms)` per path (`--i` via
  `:nth-child`) so multi-stroke icons (house then door, etc.) draw in
  sequence.
- Draw ONCE per hover entry (animation, not transition, so re-entering the
  card replays it — that's the charm), never on `:focus-visible` (keyboard
  focus gets plan 29's ring, not a redraw), never under
  `prefers-reduced-motion` (icons stay fully drawn).
- The un-hovered state stays fully drawn — the animation starts by clearing
  and redrawing; verify there is NO flash-of-empty-icon on hover start
  (start the dash animation from the drawn state's appearance: first frame
  must hide the cleared state behind the 0-delay first path).

## Out of scope

- Any card layout/stat work (plan 30), glow/cue (plan 31), hero scene.
- Splitting the sub-copy or greeting into masked lines.
- Letter-level or word-level splits — phrase blocks only.

## Definition of done

- First visit, motion allowed: three phrase masks rise in stagger, underline
  draws under `place.`; total entrance no longer than today's (~1s to
  settled) so the page never feels slower than before.
- Back-whoosh arrival and reduced-motion: h1 + underline appear instantly,
  exactly like today's `no-reveal` path — the VT snapshot never catches a
  half-revealed headline.
- Hovering each of the six cards draws its icon stroke-by-stroke; keyboard
  focus does not; reduced-motion does not; no first-frame flash.
- Authored line breaks verified at 390/768/1440 in both themes; build, lint,
  tests green.
