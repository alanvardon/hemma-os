# Plan 14 — Homepage split-flap (Solari) flip clock (Hemma `web/`)

**Status:** plan · **Owner model:** Sonnet-suitable, but the CSS 3D split-flap is
fiddly — budget a careful pass on the fold geometry. · **Relationship:**
standalone; lives on `Home.tsx`. Independent of plan 13 (do **not** reuse
`AnimatedNumber`/NumberFlow — see Decision 1).

## Goal

Replace the static `HH:MM` header clock (a plain `<span className="clock">`,
refreshed every 30 s, **hidden on mobile** — `home.css:403`) with a **live,
to-the-second, bespoke split-flap "Solari" flip clock** promoted into the hub
**hero**, alongside the existing greeting + date line. It should read as an old
train-station departure board, harmonised with the Nordic-editorial palette.

> Discipline: one branch `ui/flip-clock`, base = `main`, no stacking. New
> component + CSS + a small unit test for the riffle helper. `npm run build &&
> npx oxlint src && npx vitest run` green; manual check in light **and** dark,
> desktop **and** mobile, plus a reduced-motion pass.

---

## Decisions locked (source of truth)

1. **Bespoke split-flap, NOT NumberFlow.** NumberFlow is an odometer roll; the
   ask is a *card flip*. Build a custom component with **CSS 3D transforms**
   (`perspective` + `rotateX` hinge fold). **No new dependency** (Motion is
   already available if a springy fold easing is wanted; CSS keyframes are fine).
2. **Solari riffle behaviour.** Each digit flips **forward only** through its
   sequence (0-9), wrapping 9→0. A +1 tick = one flap; a rollover riffles several
   (e.g. seconds-tens 5→0 = 5→6→7→8→9→0, six flaps; a fresh mount riffles from 0).
3. **Promoted to the hero, header span removed.** Kill the `.header-meta`
   `<span className="clock">`; render the clock as a hero centrepiece under/beside
   the greeting + date. **Responsive** — scaled down but visible on mobile (fixes
   today's `display:none`).
4. **Time only flips.** `HH:MM:SS`, **24h** (sv-SE), 2-digit groups, leading
   zeros, **static colon** separators (no blink). Greeting + date stay as the
   existing editorial text line — they do **not** go on flaps.
5. **Theme-aware flaps.** Flaps use the existing `--ink`/`--paper` tokens
   (paper-on-ink in light, inverted in dark) — *not* a hard black departure
   board. The horizontal **seam** + a subtle inner shadow do the "mechanical"
   work so it still reads as a split-flap within the editorial palette.

---

## Component shape

```
<FlipClock>           // owns the 1s tick, maps "HH:MM:SS" → digit groups
  <FlipDigit value=.../>   // one per digit; owns its own riffle queue
  <FlipColon/>             // static separator
  ...
```

- **`FlipDigit`** is the unit: classic two-leaf card (top + bottom halves), the
  top leaf folds down over the bottom on each step (`rotateX(0 → -90deg)` then the
  next card's top reveals). Each digit independently drives a queue of single
  flaps to reach its target value (the riffle).
- **Riffle helper (the testable part):** a pure
  `forwardSteps(from, to, modulo=10): number[]` returning the forward path with
  wrap (`forwardSteps(9,0)===[0]`, `forwardSteps(5,0)===[6,7,8,9,0]`). **Unit-test
  this** — the wrap is the only error-prone logic; the fold itself is visual.

## Timing & lifecycle (build requirements)

- **Tick:** align to the wall-clock second (schedule next tick at
  `1000 - (Date.now() % 1000)`), not a naive `setInterval(…,1000)` that drifts.
- **Per-flap speed:** ~45–60 ms per intermediate flap, so a 6-flap rollover
  completes well under one second and the seconds digit never visibly lags.
- **Tab hidden:** pause on `visibilitychange` (don't riffle in the background);
  on return, **snap/riffle to the current time** (recompute from `new Date()`,
  don't replay missed seconds).
- **Mount entrance:** riffle in from `00:00:00` (or blank) to the current time on
  hub load — pairs with the existing `reveal` entrance. Reduced-motion-safe.
- **Reduced motion (`prefers-reduced-motion: reduce`):** no fold animation —
  update the digit text directly each second (still live, just no flip). Mirror
  the `prefersReducedMotion()` check already in `Home.tsx`.

## Files
- New: `components/FlipClock.tsx` (+ `FlipDigit`), `lib/flipClock.ts`
  (`forwardSteps`, time→groups), `lib/flipClock.test.ts`.
- New CSS: `styles/flip-clock.css` (or a block in `home.css`) — uses `--ink`/
  `--paper`; `prefers-reduced-motion` media query strips the transforms.
- Edit `routes/Home.tsx`: remove the header `.clock` span + the `clock` state's
  30 s interval; mount `<FlipClock>` in the `.hero`. Keep `greeting`/`dateLine`.
- Edit `styles/home.css`: drop the `.clock` rules incl. the mobile `display:none`.

## Out of scope
- Flipping the date/weekday/greeting (Decision 4).
- Timezone / locale switching — sv-SE 24h, local time only.
- Any change to the tool cards, theme toggle, or transitions.

## Definition of done
- Live `HH:MM:SS` flip clock in the hub hero, ticking every second, riffling
  forward on rollovers, in both themes and on mobile.
- Header `.clock` span gone; no 30 s interval left.
- `forwardSteps` unit-tested incl. the 9→0 wrap; `build`/`oxlint`/`vitest` green.
- Reduced-motion shows a live, non-flipping clock; tab-switch doesn't background-
  riffle and snaps correct on return.
