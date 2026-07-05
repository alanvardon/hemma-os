# Plan 26 — Extend the homepage background past the viewport (no visible edge during the camera pan)

**Status:** plan · **Owner model:** Sonnet-suitable (canvas sizing + CSS
overscan; one diagnosis step first) · **Req:** 2 (of this batch) ·
**Relationship:** polishes the camera-pan open from plans 08/09; homepage only.

## Goal

Opening a tool triggers a two-beat camera move: a WAAPI **pan** of the whole hub
(`.hub-pan`) that slides the clicked card to screen centre (+ a `scale(1.04)`),
then the View-Transition **dolly** (`vt-dive` scales the root `1 → 1.25`). During
that move the camera travels far enough that a **viewport-sized background layer
runs out** — you see the edge of the pattern and bare paper beyond it, "as if the
background ended." The background should extend far enough past the viewport that
the pan/dolly never reveals an edge.

## Diagnose first (confirm the culprit layer)

The homepage has several background layers; they do **not** all pan, so pin down
which one shows its edge before sizing anything:

- `body::before` (ambient orbs) and `body::after` (noise texture) are
  `position: fixed; inset: 0` on **`body`**, *outside* `.hub-pan`. Fixed layers
  stay pinned to the viewport during the JS pan, so they keep covering it — these
  are likely **not** the culprit on the pan. (During the VT dolly they're
  captured into the `root` snapshot and scaled *up* 1.25, covering *more*, so not
  the culprit there either.)
- **`HeroCanvas`** (the animated 3‑D terrain grid) is `.hero-canvas
  { position:absolute; inset:0 }` inside `.hero-wrap`, which lives **inside
  `.hub-pan`** (`Home.tsx:149` → `156` `<HeroCanvas>`). It is only viewport-sized
  and **moves with the pan**, so when the camera slides the hub its terrain edge
  enters frame. This is the most likely "pattern that ended."

**Action:** reproduce by clicking a corner card (max pan distance) and watch
which layer's edge appears. Expected answer: the HeroCanvas terrain (and any hub-
level paper edge behind it). Size the fix to whatever the repro actually shows —
don't oversize layers that never move.

## The displacement budget (how much overscan is needed)

The pan translate is computed per click in `Home.tsx`:

```
dx = innerWidth/2  − cardCentreX
dy = innerHeight/2 − cardCentreY   // + scale(1.04) on .hub-pan
```

Worst case is a card near a corner: `|dx|` up to ~½ viewport width, `|dy|` up to
~½ viewport height. On top of that the VT dolly scales the root by `1.25`. So a
pannable layer must overscan the viewport by at least:

```
overscan ≳ max(|dx|,|dy|)  +  zoom slack (1.04 pan-scale × 1.25 dolly)
         ≈ 50% of the viewport per side  → roughly a 2× viewport footprint
```

Budget ~**60% overscan per side** to leave margin. (Confirm the real max pan by
logging `dx/dy` for the corner cards; if pan distance is clamped anywhere, the
overscan shrinks accordingly.)

## Fix — oversize the pannable pattern layer(s)

Make the layer(s) that live inside `.hub-pan` extend beyond the viewport by the
budget above so the camera never reaches an edge. For **HeroCanvas** specifically:

1. **Grow the canvas box past the hero-wrap.** Give `.hero-canvas` a negative
   inset (e.g. `inset: -60%` or a large fixed overscan) or wrap it in an
   oversized, `overflow: visible` container so its drawable area exceeds the
   viewport in every direction the pan can travel.
2. **Draw the terrain across the enlarged area.** `HeroCanvas` sizes its backing
   store from its own client rect (DPR-aware), and the terrain is generative
   (`elevation(x,z,time)` over `ROWS`/`COLS`), so extending the sampled `x/z`
   span to fill the larger canvas is a parameter change, not new art. Keep the
   existing edge **mask** (`.hero-canvas` mask-image feathering) so the terrain
   still fades out softly — but position the feather at the *new* outer edge, past
   the pan reach, so the soft edge is never on screen during the move.
3. **Watch cost.** A ~2× canvas is ~4× fill. Mitigate: cap DPR on the overscan
   region, or only enlarge along the axes the pan actually uses, or lower `COLS`
   for the off-screen band. Measure a frame after the change; the hub must stay
   smooth.

If the repro also shows a **paper/orb edge** (i.e. a layer that unexpectedly pans
because it's inside `.hub-pan`), extend that layer the same way (oversized,
centred, `background-position: center`), or move it *out* of `.hub-pan` so it
stays viewport-fixed like the orbs already are.

## Interaction with the existing "sticky header" note

`Home.tsx` already documents that a transform on `.hub-pan` changes the
containing block of any `position:*` descendant (that's why the header was pulled
out of `.hub-pan`). Keep the overscan layer **inside** `.hub-pan` on purpose —
it *should* move with the camera; it just needs to be big enough that its edge is
always off-frame. Don't reintroduce a fixed/sticky child inside `.hub-pan`.

## Paths where the pan is skipped (no overscan needed, must not break)

- **Reduced motion** and **mobile push** (`isMobilePush`, ≤600px): `Home.tsx`
  skips the WAAPI pan and the mobile CSS drops the shared-element group. The
  larger canvas is harmless here (still masked, still viewport-cropped visually),
  but verify no layout shift or scrollbar appears from the oversized box —
  contain it (`overflow: hidden` on a viewport-sized wrapper at these
  breakpoints if needed).

## Out of scope
- The dolly/pan *timing and distance* (plans 08/09) — this plan only makes the
  background survive the existing camera move.
- The tool-page whoosh snapshot (plan 25) and NumberFlow gating (plan 27).
- Any redesign of the terrain look — same pattern, just larger + re-feathered.

## Definition of done
- Clicking any hub card (including corner cards, at any scroll position) shows a
  continuous background throughout the pan **and** the dolly — no visible pattern
  edge or bare-paper strip enters frame.
- Hub framerate on the pan is unchanged to the eye (measure before/after).
- Reduced-motion and ≤600px paths show no new scrollbar / layout shift from the
  oversized layer.
- `npm run build && npx oxlint src && npx vitest run` green; manual click-through
  from corners and centre, light + dark.
