# Plan 30 — The living bento: the hub becomes a dashboard

**Status:** plan · **Owner model:** strong model recommended (touches every
tool's store + layout redesign; the flagship of this batch) · **Req:** 2 (of
this batch, after plan 29 frees the grid) · **Relationship:** the standing
"biggest UX win" since the first homepage review; consumes plan 29's freed
space; the whoosh/`vt-card` mechanics (plans 06/08/09) must keep working on
resized cards; NumberFlow gating (plan 27) already handles entrance rolls.

## Goal

The homepage's spectacle (plan 28) and its utility are two different pages
today: a living hero stapled to a static menu of identical cards. Break the
uniform grid into a **bento**: tools with persisted local data become wide
cards showing the actual household numbers — the mortgage balance, the next
month-end close, this month's leftover — in NumberFlow, with a sparkline
where there's history. The hub stops being a launcher and becomes the
family's glass cockpit. Zero clicks to the answer you visit for.

## Which cards get stats (inventory, from the stores)

Only tools with real persisted data get promoted; pure calculators stay
standard. All reads are local (localStorage-backed stores) — cheap to hydrate
on the hub.

1. **Bolånekoll → wide card (flagship).** From `mortgage-store`: total
   remaining debt across loan parts (`X XXX XXX kr kvar`), plus a small visx
   sparkline of balance over the imported payment history (already the
   tool's core dataset). Secondary line: equity share if cost-basis data
   exists (plan 24), else omit.
2. **Månadsavslut → wide card.** From `manadsavslut-store`: `nästa avslut om
   N dagar` (days to month-end, pure date math — testable) plus the latest
   settled result if any: `Alan → Sofia 1 234 kr` (respect the store's
   owed_by semantics). No sparkline; two figures is enough.
3. **Hushållsbudget → standard card + one stat line.** From
   `hushallsbudget-store`: leftover per person this month (`+X XXX kr var`).
4. **Bostadskalkyl → standard card + one stat line.** From `useStore`
   scenarios (already hydrated on the hub since plan 08): `N sparade
   scenarier`, or the latest scenario's monthly cost if exactly one.
5. **Konsultkalkyl, Löneväxling → standard cards, unchanged.** Stateless
   calculators; a fake stat would be noise.

Empty-state rule: a promoted card with NO data yet (fresh browser, cleared
storage) falls back to its current description — never `0 kr` / `NaN`. The
stat block renders only when the store returns real content.

## Layout

CSS grid, explicit spans instead of `auto-fill`:

- Desktop (>900px): 4 columns. Row 1: Bolånekoll (span 2) · Hushållsbudget ·
  Bostadskalkyl. Row 2: Månadsavslut (span 2) · Konsultkalkyl · Löneväxling.
- 600–900px: 2 columns; wide cards span both, standard cards pair up.
- ≤600px: single column (as today), and the **stat replaces the prose** —
  a phone user wants the number, not the pitch. Description hides behind the
  stat via a `@media` rule; tap target unchanged.

Wide cards are NOT taller than standard ones — the bento reads as one shelf.
Stat typography: `--font-display` serif numerals via the shared
`AnimatedNumber` components (NumberFlow`animated` gating from plan 27 comes
free), label in the small-caps style of `.apps-label`.

## Ordering: the OS learns the household

- On every tool open (the `onToolCardClick` path), write
  `hemma-last-opened.<path> = Date.now()` to localStorage.
- The four STANDARD cards sort by recency (most recent first); the two wide
  cards are pinned to their row starts so the layout never reflows its
  anchors. First visit (no timestamps): current authored order.
- Pure helper `orderTools(entries, timestamps)` in a lib with unit tests
  (stability, missing timestamps, all-missing).

## Data plumbing

- Extend the hub's existing warm-up effect (plan 08's `useStore.hydrate()`)
  to also hydrate mortgage/manadsavslut/hushallsbudget stores — all
  idempotent local reads, keeping the whoosh-snapshot-fully-populated
  guarantee for the dashboard AND the new stats.
- Derivations (`remainingDebt`, `daysToMonthEnd`, `latestSettle`,
  `leftoverPerPerson`) live in the tools' existing lib files (or a small
  `hub-stats.ts`) as pure functions with tests — NOT inline in `Home.tsx`.
- Sparkline: reuse the visx pattern from Bolånekoll's own chart, ~120×36,
  no axes, accent stroke, `aria-hidden` (the figure carries the meaning).

## Interactions with existing mechanics (must keep working)

- Whoosh: `vt-card` capture on a `span 2` card — verify forward/back to
  Bolånekoll and Månadsavslut from all grid positions.
- Reveal stagger: re-map `reveal-*` delays to the new card count/order.
- Card tilt/spotlight: unchanged; wide cards get the same treatment (tilt
  amplitude already derives from pointer position, not size).
- Privacy note (out of scope, decision recorded): real balances on the
  homepage are fine for a family hub today; a "hide figures" toggle can ride
  with the Supabase/auth work (plan 16) where guests become possible.

## Out of scope

- Dark-mode glow bleed + scroll cue (plan 31), type/icon polish (plan 32).
- Any change to the tools themselves or their stores' schemas.
- Command palette / search — eight tools don't need a launcher.
- Supabase-backed personalization (plan 16 territory).

## Definition of done

- Hub shows the bento: two wide stat cards with live figures (NumberFlow
  rolling only after the transition settles, per plan 27) and a Bolånekoll
  sparkline; two standard cards with stat lines; two untouched calculators.
- Fresh profile (no data): every promoted card falls back to prose — no
  zeros, no NaN, no layout jump when data appears later.
- Standard cards reorder by last-opened across sessions; wide cards pinned.
- Whoosh forward/back works on both wide cards; entrance reveals staggered;
  ≤600px shows stat-instead-of-prose single column.
- Unit tests: ordering helper + every stat derivation (incl. month-end math
  across year boundary and empty-store cases). Suite green, build/lint green,
  no three.js/entry-chunk changes.
