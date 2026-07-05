# Plan 31 — Nightscape bleed + scroll cue: one continuous page

**Status:** plan · **Owner model:** Sonnet-suitable (CSS + one tiny scroll
hook; no scene/shader work) · **Req:** 3 (of this batch; independent of plan
30's layout but lands best after it) · **Relationship:** finishes what plan
28 started — the hero's atmosphere currently stops dead at the Tools
boundary; in dark mode the grid below is a void of near-invisible cards.

## Goal

Make the page read as ONE nightscape instead of a hero stapled to a menu:
let the aurora's light appear to fall onto the Tools section, lift the
dark-mode cards out of the black, and give first-time visitors a cue that
the product lives below the fold.

## A. Aurora glow bleed (CSS only — do NOT read GL state)

The scene must stay the only owner of the canvas; the bleed is a static,
palette-driven veil that *implies* the same light:

- `.apps::before`: two soft radial gradients positioned upper-left /
  upper-right (`--orb-a`-style accent + copper at low alpha), `pointer-events:
  none`, sitting behind the cards. Dark theme: noticeably present (the
  aurora "spills"); light theme: barely-there warmth (the veil equivalent).
  Define strengths as tokens (`--bleed-a`, `--bleed-b`) in `tokens.css` per
  theme rather than hardcoding two rule sets.
- Dark-mode card lift: `--paper-card` in dark is nearly the page background —
  give `.app-card` in dark a border of `color-mix(in srgb, var(--accent) 14%,
  var(--rule))` and a faint inner top highlight (1px inset light line), so
  cards read as objects under sky-light rather than holes.
- No animation here — the grain, orbs and canvas already move; the bleed is
  set dressing. (If it reads static against the aurora, a 60s+ CSS drift on
  the gradient positions is the ceiling — decide by eye, default off.)

## B. Scroll cue

- A small chevron + `Verktyg` whisper centered at the hero's base
  (`.hero-cue`): 12px small-caps like `.apps-label`, chevron bobbing ~6px on
  a 2.2s ease loop.
- Dismissal: fade out (opacity transition, then `visibility: hidden`) the
  first time `scrollY > 40` — plain scroll listener in `Home.tsx`, removed
  after firing once. It never returns during the session (sessionStorage
  flag), so returning via the back-whoosh doesn't re-animate an invitation
  the user already accepted.
- Clicking it scrolls smoothly to `#tools` (the anchor from plan 29) —
  `scrollIntoView({ behavior: 'smooth' })`, which the scroll dolly (plan 28b)
  turns into the camera descent: the cue literally invites the camera move.
- `prefers-reduced-motion`: no bob (static chevron), instant scroll, still
  dismisses.
- Suppressed when arriving via the BACK whoosh (`viaBack` already exists in
  `Home.tsx`) — a returning user needs no invitation.

## Out of scope

- Reading aurora intensity/time-of-day into the CSS (tempting, but couples
  DOM styling to the scene's frame loop; the static per-theme tokens follow
  the palette closely enough).
- Any hero/canvas/shader change; bento layout (plan 30); type/icon polish
  (plan 32).

## Definition of done

- Dark theme: the Tools section shows the glow bleed and cards with visible
  accent-tinted borders — screenshot comparison against main shows the grid
  reading as lit objects, not a void; light theme is subtly warmed, nothing
  garish.
- Scroll cue: bobs at the hero base on first visit, fades permanently on
  first scroll (and stays gone via sessionStorage), click smooth-scrolls to
  Tools riding the dolly, reduced-motion path static/instant, absent when
  arriving via back-whoosh.
- No new JS beyond the one listener; no reads from the WebGL scene; build,
  lint, tests green.
