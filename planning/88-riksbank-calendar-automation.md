# Plan 88 — Stop hand-typing the Riksbank decision calendar; generate it from riksbank.se

**Status:** plan · **Owner model:** Split — **Opus** for the scraper's
merge/accumulate semantics, the sanity gate, and the CI workflow (a wrong
gate silently ships an empty or truncated calendar, which is the exact
"Nästa besked" UX bug we're trying to kill); **Sonnet** for the app-side
swap once the JSON file exists (JSON import + change one default param). ·
**Source:** follow-up to plan 70 ship (2026-07-11) — user asked for a
better process than editing an array in code · **Sequencing:** independent
of, but supersedes the "refresh by hand each December" note in
[70-bolanekoll-rantebesked.md](completed/70-bolanekoll-rantebesked.md);
land after plan 70's PR (#274) merges · **Touches:**
`web/src/lib/riksbank.ts`, new `web/src/lib/riksbank-decisions.json`, new
`scripts/scrape-riksbank-calendar.mjs`, new
`.github/workflows/riksbank-calendar.yml`, `web/src/lib/riksbank.test.ts`.

## Goal

The Swedish policy-rate **decision calendar** (the ~8 announcement dates a
year) currently lives as a hand-typed array in code
([riksbank.ts:26](../web/src/lib/riksbank.ts#L26)) that a human must refresh
every December from riksbank.se. Replace that chore with a **monthly CI job
that scrapes riksbank.se, accumulates the dates into a committed JSON file,
and opens a PR** when they change. The array stops being authored by hand;
it becomes generated data a human reviews as a diff. The app reads the JSON,
with a tiny committed fallback so a broken scrape never blanks the card.

## Finding — why the current approach is the weak point of plan 70

[riksbank.ts:20-32](../web/src/lib/riksbank.ts#L20-L32):

```ts
// Maintained by hand — refresh each December from riksbank.se → Calendar.
export const RIKSBANK_DECISIONS_2026: string[] = [
  '2026-01-29', '2026-03-19', '2026-05-07', '2026-06-17', '2026-08-19',
]
```

Three problems:

1. **It's incomplete right now.** Only 5 of 2026's 8 decisions are listed;
   sep/nov/dec are missing, so `nextDecision` already returns `null` after
   19 aug and the card shows "se riksbank.se" for the rest of the year.
2. **The refresh is a silent, calendar-driven chore** — nothing prompts it,
   and forgetting degrades the feature with no error.
3. **Plan 70's comment is factually wrong:** it says riksbank.se is
   "JS-rendered". It is **server-rendered** — see below — which is exactly
   what makes automation feasible.

## Investigation — what riksbank.se actually exposes (verified 2026-07-11)

All fetched server-side with `curl` (no browser), which is the environment a
scraper or Edge Function runs in.

- **The calendar is server-rendered.** `GET /en-gb/press-and-published/
  calendar/calendar-2026/` returns full HTML (~600 KB) containing the
  monetary-policy events as anchors like
  `/calendar/calendar-2026/2026-08-19/`, each carrying the exact title
  *"Monetary policy meeting: Decision on monetary policy including the policy
  rate"*.
- **Per-event ICS export exists and is the stable structured field:**
  `GET …/calendar-2026/2026-08-19//Download` → `text/calendar`:
  ```
  BEGIN:VEVENT
  DTSTART:20260819T070000Z
  SUMMARY:Monetary policy meeting: Decision on monetary policy including the policy rate
  DESCRIPTION:Monetary policy meeting at which the Executive Board takes a decision on monetary policy including the policy rate.
  STATUS:CONFIRMED
  END:VEVENT
  ```
  `DTSTART` is `07:00Z` = 09:00 Sweden (the 09:30 announcement); the **UTC
  date equals the announcement date** — no midnight-crossing risk. This is
  the canonical date to extract.
- **Next year is published ahead:** `…/calendar-2027/` already lists 2027
  decision meetings. So a scraper covering `[thisYear, thisYear+1]` always
  sees the upcoming December rollover before it happens.
- **The year page shows ONLY upcoming events.** Past 2026 decisions
  (jan 29, mar 19, may 07, jun 17) return **0 occurrences** in today's HTML;
  only aug 19 onward appear. → **A single scrape cannot see history.** This
  is the load-bearing constraint: the process must *accumulate* dates into a
  persisted file and never re-derive from scratch, or `lastDecision` (the
  "Senaste besked" cell) loses its data the moment a decision moves into the
  past.
- **No bulk ICS or JSON API** — the year `//Download` and root `//Download`
  both 404. Enumeration must go through the year listing HTML, then the
  per-event ICS for verification.
- **Bare `User-Agent` gets `403`.** urllib/fetch default UA is blocked; a
  browser-like UA (`Mozilla/5.0`) succeeds. The scraper MUST set one.

## Design

### Decision: CI-generated committed JSON, accumulated, human-reviewed

Three options were considered:

- **(A) Live-scrape inside the `riksbank-proxy` Edge Function.** Rejected:
  the year page only shows upcoming events, so to keep past dates the
  function would need to persist them — i.e. a table — which drags in the
  infra plan 70 deliberately avoided. It also puts fragile HTML parsing on
  the user's request path and depends on riksbank.se being up and
  markup-stable *at request time*.
- **(B) Monthly GitHub Action → committed `riksbank-decisions.json`, PR on
  change.** ✅ **Chosen.** The data stays static, fast, offline-safe, and
  **accumulates** (merge-union into the committed file — past dates, once
  captured while upcoming, are never dropped). Fragility surfaces as a
  *failed CI job or a reviewable PR diff*, not a silent production bug —
  matching this repo's CI-hardening posture (plans 77–80) and keeping a
  human in the loop. No new runtime infra, no table, no RLS surface.
- **(C) Scheduled Supabase function → `policy_calendar` table.** Rejected:
  reintroduces the cron + table + RLS that plan 70 explicitly refused, for a
  dataset that changes ~8 times a year and tolerates hours of staleness.

The hand-typed array becomes the **seed and ultimate fallback**, not the
source of truth.

### The accumulate-and-gate invariant (the part that needs real reasoning)

The scraper must **never shrink or blank** the committed set from a bad
fetch. Rules, in order:

1. Fetch years `[thisYear, thisYear+1]`. For each, parse the listing for
   anchors whose title is exactly the decision SUMMARY phrase → candidate
   dates.
2. **Verify each candidate against its ICS**: fetch `…/{date}//Download`,
   require `DESCRIPTION`/`SUMMARY` to contain
   `decision on monetary policy including the policy rate` (case-insensitive),
   and take the date from `DTSTART`. This rejects false positives (auctions,
   speeches) even if the listing markup drifts.
3. **Merge** the verified set into the existing JSON as a sorted, de-duped
   **union**. Existing dates are never removed.
4. **Sanity gate — refuse to write if any hold:** zero candidates scraped;
   any HTTP failure; or the merged set has **fewer future dates than the
   current file already had** (a scrape that would regress coverage). On any
   of these, exit non-zero and write nothing — CI goes red, a human looks.
5. Only if the merged JSON *differs* from the committed one does the workflow
   open a PR.

Because the file only ever grows by union, seeding it once with the known
2026 H1 dates (below) preserves history that the live page no longer shows.

### Files and real code

**`web/src/lib/riksbank-decisions.json`** — new committed data file. Seed it
with the full verified 2026 set (H1 from the retiring array + H2 from the
scrape) so history is bootstrapped:

```json
{
  "_comment": "Generated by scripts/scrape-riksbank-calendar.mjs via .github/workflows/riksbank-calendar.yml. Do not hand-edit except to seed. Announcement (09:30 publication) dates, ISO, sorted.",
  "decisions": [
    "2026-01-29", "2026-03-19", "2026-05-07", "2026-06-17",
    "2026-08-19", "2026-09-23", "2026-11-03", "2026-12-15"
  ]
}
```

> Implementer: confirm 2026-09-23 / 11-03 / 12-15 against each event's ICS at
> build time — they were read from today's listing but should be ICS-verified
> before seeding.

**`web/src/lib/riksbank.ts`** — retire the hand-typed const; read the JSON.
`nextDecision`/`lastDecision` already take a `calendar` param, so only the
default source changes:

```ts
import decisionsData from './riksbank-decisions.json'

// Announcement (09:30 publication) dates, generated from riksbank.se by
// scripts/scrape-riksbank-calendar.mjs (see .github/workflows/riksbank-calendar.yml).
// This array is DATA, not hand-authored — edit the scraper, not the list.
// The literal fallback is the last resort if the JSON is ever empty, so the
// card degrades to "se riksbank.se" rather than throwing.
const FALLBACK_DECISIONS = ['2026-08-19', '2026-09-23', '2026-11-03', '2026-12-15']
export const RIKSBANK_DECISIONS: string[] =
  (decisionsData.decisions?.length ? decisionsData.decisions : FALLBACK_DECISIONS)

export function nextDecision(today: string, calendar: string[] = RIKSBANK_DECISIONS): string | null {
  return (calendar || []).find((d) => d >= today) ?? null
}
export function lastDecision(today: string, calendar: string[] = RIKSBANK_DECISIONS): string | null {
  const past = (calendar || []).filter((d) => d < today)
  return past[past.length - 1] ?? null
}
```

Delete `RIKSBANK_DECISIONS_2026`. Update its one importer if any (grep:
`RIKSBANK_DECISIONS_2026` — currently only the two functions above default to
it). `tsconfig` already allows JSON imports via Vite; if `resolveJsonModule`
is not set, add it (verify in `web/tsconfig.app.json`).

**`scripts/scrape-riksbank-calendar.mjs`** — Node ESM, no deps (uses global
`fetch`, Node ≥ 18). Skeleton the implementer fills to the rules above:

```js
const TITLE = 'decision on monetary policy including the policy rate'
const UA = { 'User-Agent': 'Mozilla/5.0 (hemma-os calendar bot)' } // bare UA → 403
const base = 'https://www.riksbank.se/en-gb/press-and-published/calendar'

async function candidatesForYear(year) {
  const html = await (await fetch(`${base}/calendar-${year}/`, { headers: UA })).then(r => r.text())
  const dates = new Set()
  const re = /href="\/en-gb\/press-and-published\/calendar\/calendar-\d{4}\/(\d{4}-\d{2}-\d{2})\/"([^>]*)>(.*?)<\/a>/gs
  for (const m of html.matchAll(re)) if (m[3].replace(/<[^>]+>/g, ' ').toLowerCase().includes(TITLE)) dates.add(m[1])
  return [...dates]
}
async function verify(date) { // fetch the ICS, confirm it's a decision, return DTSTART date
  const ics = await (await fetch(`${base}/calendar-${date.slice(0,4)}/${date}//Download`, { headers: UA })).then(r => r.text())
  if (!ics.toLowerCase().includes(TITLE)) return null
  const m = ics.match(/DTSTART:(\d{4})(\d{2})(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}
// main: gather+verify [thisYear, thisYear+1] → union with existing JSON →
// APPLY SANITY GATE (throw/exit 1 on empty, fetch error, or fewer future
// dates than before) → write sorted JSON only if changed.
```

Be polite: a short delay between ICS fetches; fail the whole run on any fetch
error (don't write a partial set).

**`.github/workflows/riksbank-calendar.yml`** — monthly + manual:

```yaml
name: Riksbank calendar refresh
on:
  schedule: [{ cron: '0 6 1 * *' }]   # 06:00 UTC, 1st of each month
  workflow_dispatch:
jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: node scripts/scrape-riksbank-calendar.mjs   # exits non-zero on gate failure
      - uses: peter-evans/create-pull-request@v6
        with:
          branch: chore/riksbank-calendar-refresh
          title: 'chore: refresh Riksbank decision calendar'
          commit-message: 'chore: refresh Riksbank decision calendar'
          body: 'Automated scrape of riksbank.se. Review the date diff before merging.'
          add-paths: web/src/lib/riksbank-decisions.json
```

A red job (gate failure) is the signal to look; a green job with no diff is
the common no-op; a green job with a diff opens a reviewable PR. Never
auto-merges — a human confirms the dates.

## Acceptance criteria

- `web/src/lib/riksbank-decisions.json` exists, ISO-sorted, seeded with the
  ICS-verified full 2026 set; `RIKSBANK_DECISIONS_2026` is deleted and no code
  references it (grep clean).
- `nextDecision`/`lastDecision` default to the JSON-derived `RIKSBANK_DECISIONS`;
  existing unit tests still pass, plus a new test asserting the exported array
  is non-empty and sorted, and that an empty JSON falls back to
  `FALLBACK_DECISIONS` (not `[]`).
- `node scripts/scrape-riksbank-calendar.mjs` run locally against live
  riksbank.se produces the current upcoming decisions for `[2026, 2027]`,
  each ICS-verified, and **does not shrink** a seeded file. Simulate a failed
  fetch (bad URL) → script exits non-zero and writes nothing.
- The gate is proven: feed the script a stubbed "0 candidates" response →
  it refuses to overwrite and exits non-zero.
- Workflow validates (`workflow_dispatch` runs green end-to-end on a branch),
  opens a PR only when the JSON changes, and touches only
  `riksbank-decisions.json`.
- `npm run build` green; `resolveJsonModule` confirmed on in `web/tsconfig`.
- The stale "JS-rendered / maintained by hand" comment in `riksbank.ts` is
  gone.

## Out of scope

- **Live in-app scraping / an in-UI "refresh" button** — rejected in Design;
  there is no request-time source and it can't see history. The build-time
  accumulate is strictly better.
- **Auto-merging the refresh PR** — deliberately human-reviewed; a wrong date
  is worse than a day's delay.
- **Scraping meeting vs. announcement nuance beyond the ICS `DTSTART`** — the
  ICS date is the announcement day the app already keys on (plan 70); no extra
  modelling needed.
- **Historical backfill before 2026** — the app only needs the current
  `lastDecision`/`nextDecision`; deep history isn't used and the live page
  won't provide it anyway.
- **Porting the same mechanism to other Riksbank event types** (auctions,
  reports) — not needed by any tool today.
