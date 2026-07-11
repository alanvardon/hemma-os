# Plan 70 — Bolånekoll: räntebesked (Riksbank policy-rate watcher)

**Status:** plan · **Owner model:** Sonnet-suitable (the API quirks,
plumbing, and UI placement are fully decided below — this is
well-specified integration work; the visx step chart follows plan 63's
palette rules rather than needing fresh design) · **Source:** idea
session 2026-07-07 · **Touches:**
`Bolanekoll.tsx`, new `lib/riksbank.ts` (+ test), new Supabase Edge
Function `riksbank-proxy`, `Home.tsx` (bento tile), `bolanekoll.css`.

## Goal

Bolånekoll should always know the current Swedish policy rate
(styrräntan), tell us **when it changes**, and show **when the next
decision lands** — plus a small history chart for context. In-app only;
email is [72-email-notifications.md](72-email-notifications.md).

## Verified facts (2026-07-07)

- The Riksbank SWEA REST API is free, no key needed for our volume:
  `GET https://api.riksbank.se/swea/v1/Observations/Latest/SECBREPOEFF`
  → `{"date":"2026-07-07","value":1.75}`. Series `SECBREPOEFF` **is** the
  policy rate (confirmed via `/swea/v1/Series`, current through today).
  Range form: `/Observations/SECBREPOEFF/{from}/{to}` returns one point
  per banking day.
- **The API is not browser-callable.** When an `Origin` header is present
  the API returns `200` with an **empty body** (and no
  `Access-Control-Allow-Origin`). Direct fetch from GitHub Pages will
  silently get nothing — it MUST be proxied.
- The API does **not** expose the meeting calendar. 2026 announcement
  dates confirmed so far: 29 jan, 18/19 mar, 7 maj, 16/17 jun, meeting
  19 aug (rate applies from 26 aug). Sept–Dec dates exist on
  riksbank.se/calendar-2026 (JS-rendered page — pull them manually during
  implementation).

## Design

### Plumbing — on-demand Edge Function proxy, no cron

New Supabase Edge Function `riksbank-proxy`:

- One endpoint, returns `{ latest: {date, value}, changes: [{date, value}, …] }`.
- Server-side it calls the SWEA API **without** an Origin header:
  `Latest/SECBREPOEFF` + `Observations/SECBREPOEFF/2010-01-01/{today}`.
- Collapse the per-banking-day series into **change points** (keep only
  rows where `value` differs from the previous row) server-side — the
  since-2010 payload shrinks from ~4 000 rows to a few dozen.
- Cache: set `Cache-Control: max-age=3600` and keep a module-level
  in-memory cache so repeated loads don't hammer the Riksbank. The data
  changes at most ~8×/year at 09:30 on decision days; staleness up to an
  hour is fine.
- No cron, no table. A scheduled poller only becomes necessary for email
  (plan 72) — don't build it twice.

Client: `lib/riksbank.ts` exports `fetchPolicyRate()` (calls the function
via the existing supabase client — `supabase.functions.invoke`), plus pure
helpers (tested):

- `nextDecision(today, calendar)` — next upcoming announcement date.
- `detectChange(latest, acknowledged)` — is there a change the user
  hasn't seen?

### Decision calendar — hardcoded constants

`RIKSBANK_DECISIONS_2026: string[]` in `lib/riksbank.ts` — the
**announcement** dates (the 09:30 publication day, not the meeting day).
Add a loud comment: *maintained by hand, refresh each December from
riksbank.se → Calendar*. When the list is exhausted (past the last date),
render "Nästa besked: se riksbank.se" instead of a wrong guess — that's
the graceful-degradation path for the year rollover.

### UI in Bolånekoll

- **Rate strip** (small card, near the räntor section, NOT a new hero —
  plan 64 owns hero hierarchy): current styrränta, date it took effect
  (last change point), and "Nästa räntebesked: 20 aug" with a subtle
  countdown ("om 44 dagar").
- **Change banner:** when `detectChange` fires, a dismissible banner —
  "Styrräntan sänktes 2.00 % → 1.75 % den 17 jun". Dismissing stores the
  acknowledged value+date in localStorage (per-device is fine; this is a
  nudge, not state). Direction word (höjdes/sänktes) from the delta.
- **History chart:** visx step chart of the change points since 2010
  (step, not line — the rate is piecewise-constant). Follows the plan 63
  dataviz palette/legend rules. Optional overlay of the household's own
  mortgage rate from mortgage-store is explicitly **out of scope** (was
  offered, not chosen).

### Hub bento tile

The Bolånekoll tile on Home gets a live stat line (same mechanism as
plan 30's living-bento stats, via `hub-stats.ts`): "Styrränta 1,75 % ·
nästa besked 20 aug". Reuse the fetch — cache the proxy response in
sessionStorage so Home and Bolånekoll don't both hit the function.

### Failure behaviour

The proxy or API being down must not degrade Bolånekoll: the strip
renders a quiet "kunde inte hämta styrräntan" state, the banner and tile
stat simply don't show. Never block the calculator on this fetch.

## Acceptance criteria

- Bolånekoll shows the current policy rate, its effective-from date, and
  the next announcement date; a change vs the acknowledged value shows a
  dismissible banner that stays dismissed after reload.
- Step chart renders change points 2010→today; numbers formatted with
  `lib/format.ts` conventions (sv-SE, comma decimals).
- Zero direct browser calls to `api.riksbank.se` (would silently return
  empty — everything goes through the Edge Function). No new CSP origin
  needed in the client (plan 54): supabase origin already covers it.
- Riksbank fetch failing leaves the calculator fully usable.
- Pure helpers (`change-point collapse`, `nextDecision`, `detectChange`)
  unit-tested in `lib/riksbank.test.ts`.

## Out of scope

- Email/push on change → plan 72.
- Nudging the user's mortgage-rate inputs when the policy rate moves.
- Savings-account rate tracking (dropped — no API exists).
