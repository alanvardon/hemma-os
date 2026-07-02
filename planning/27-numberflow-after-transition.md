# Plan 27 — Hold NumberFlow rolls until the page transition finishes

**Status:** plan · **Owner model:** Sonnet-suitable (one signal in
`viewTransition.ts` + a gate in `AnimatedNumber.tsx`) · **Req:** 1 (of this
batch) · **Relationship:** builds on the roll-in from plan 13 and the
`.finished`-driven clear in `viewTransition.ts` (plans 08/09).

## Goal

Digit rolls should start **after** the whoosh/dolly has settled, not during it.
Today a tool page's entrance figures roll *while* the page is still transitioning
(or the roll completes behind the frozen VT snapshot and is wasted). The result
is either double-motion (page zooming **and** digits spinning) or a roll the user
never sees. Desired: the page arrives, the whoosh finishes, **then** the hero
figures roll from 0 → value as an accent.

## Two sources of entrance motion to gate (both, uniformly)

1. **Explicit `rollIn`** (plan 13): `useRollIn` mounts the figure at `0` and sets
   the real value in a `useEffect`, forcing a post-mount roll. That roll fires on
   mount — i.e. mid-transition.
2. **Async hydration churn:** tools that hydrate from localStorage on mount
   (Månadsavslut, Hushållsbudget, Bolånekoll) go `0/empty → real` as the store
   populates, so **default reactive** NumberFlow figures also roll during the
   transition even without `rollIn`. (Home already pre-hydrates the scenarios
   store to dodge this for the dashboard; the other tools don't.)

Gate **both** with one mechanism so entrance motion is silent until settled.

## Mechanism

### A. Expose a "transition settled" signal from `viewTransition.ts`

The patch already ties cleanup to the VT's own `.finished` (`clearVtTag` runs one
frame past `.finished`). Add a tiny subscribable flag alongside it:

- Track `let vtActive = false`; set it `true` in `markVtTransition`, back to
  `false` inside `clearVtTag` (fires after `.finished`, and via the 2500ms
  fallback for no-VT / reduced-motion paths).
- Maintain a `Set<() => void>` of listeners; notify them in `clearVtTag`.
- Export `isVtActive(): boolean` and `subscribeVtSettled(fn): () => void` (returns
  an unsubscribe). Keep it framework-free (module-level), matching the file's
  existing style.

This reuses the exact lifecycle that already clears `data-vt-dir` — no new timers,
immune to CSS-minification unit bugs (the reason the timer approach was removed).

### B. Gate the roll in `AnimatedNumber.tsx`

NumberFlow specifics that make this clean (confirmed against the lib):

- **Initial mount never animates** — only subsequent value changes do.
- `animated` prop (default `true`); **`false` snaps and stops/suppresses**
  animation.

So, in the shared `Money`/`Percent`/`Num`/`MoneyCompact` components:

1. Read a `settled` boolean: `true` if `!isVtActive()` at mount; otherwise
   subscribe via `subscribeVtSettled` and flip to `true` when it fires. (One small
   hook, e.g. `useVtSettled()`, so all four components share it.)
2. While `!settled`, render `<NumberFlow animated={false} …>` so **any** value
   churn (hydration or a premature `rollIn` set) snaps silently — no roll behind
   the whoosh.
3. When `settled` flips to `true`, render `animated={true}`. For `rollIn`
   figures, drive the `0 → value` change **at that moment** (set display value in
   the same effect that observes `settled`), so the roll plays as the whoosh ends
   — exactly the intended accent.
4. Extend `useRollIn` to key off `settled`: hold `display = 0` until
   `settled && !prefersReducedMotion`, then set `value`. Non-`rollIn` figures just
   flip `animated` at settle.

### C. Reduced motion / no-transition paths

- **Reduced motion:** unchanged — paint the final value immediately, no roll
  (`useRollIn` already skips; keep `respectMotionPreference` on).
- **Direct load / navigation without a VT** (`isVtActive()` false at mount):
  `settled` is `true` immediately, so behaviour matches today — figures roll on
  first real value change / rollIn with no added delay.
- **Fallback:** the 2500ms `clearVtTag` fallback guarantees `settled` eventually
  flips even if no `.finished` ever fires, so figures can never get stuck frozen.

## Why not just delay with a timer

A fixed delay races the real transition (the forward trip is pan ~760ms **+**
dolly ~740ms ≈ 1.5s; back differs; mobile push is ~300ms; device speed varies).
Tying to the VT's `.finished` — the signal the file already uses to clear
`data-vt-dir` — is the only version that stays correct across directions,
devices, and the minified build.

## Scope / which figures

- Applies wherever `AnimatedNumber` is used — the gate lives in the shared
  component, so every tool inherits it; no per-route edits expected.
- Confirm the **hero `rollIn`** figures (plan 13 inventory: Bolånekoll equity/LTV,
  Hushållsbudget settle, Månadsavslut net, etc.) now roll *after* the whoosh.
- Confirm **hydration-churn** tools (Månadsavslut, Bolånekoll, Hushållsbudget) no
  longer show figures spinning during the whoosh — they snap, then are live.

## Out of scope
- The whoosh/dolly itself (plans 08/09/25) and the background overscan (plan 26).
- Live, in-tool input rolls (typing, sliders) — those must keep animating; the
  gate only suppresses motion **while a transition is active**, then restores
  `animated={true}`.
- Home page figures (the hub uses FlipClock, not `AnimatedNumber`).

## Definition of done
- Entering any tool via the whoosh: hero `rollIn` figures roll **after** the
  transition settles; no figure rolls *during* the zoom; hydration churn snaps
  silently instead of spinning mid-transition.
- Direct loads and reduced-motion behave exactly as before (immediate/no roll).
- No figure can get stuck non-animated (2500ms fallback covers no-VT paths).
- `npm run build && npx oxlint src && npx vitest run` green; manual click-through
  of all six tools confirming the roll lands on settle, plus in-tool live input
  still rolls normally.
