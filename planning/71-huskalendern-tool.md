# Plan 71 — Huskalendern (house log + expiry timeline)

**Status:** plan · **Owner model:** Opus-suitable (a whole new tool: the
timeline is novel visual design with real judgment calls — rail/milestone
anatomy, past-vs-future treatment, soft "≈" milestones — plus a new
table/RLS migration and store; the derivation helpers are the easy part)
· **Source:** idea session 2026-07-07 · **Touches:** new
route `Huskalendern.tsx` + `huskalendern.css`, new `lib/huskalendern.ts`
(+ test) + `lib/huskalendern-store.ts`, Supabase migration
(`house_items` table + RLS), `Home.tsx`/`App.tsx` (hub card + route).

## Goal

One shared place for "the house's memory": when the avlopp company last
cleaned the pipes, when the roof was done, when the el-avtal and TV
package run out — rendered as a **vertical timeline around "today"**,
with in-app flags when something is due or about to expire. Replaces the
"was it 2019 or 2021?" conversation.

## Data model

New household-scoped table `house_items` (row-store pattern à la
manadsavslut — one row per item, RLS on `household_id`, NOT a tool_state
blob: items are edited independently and this must survive concurrent
edits):

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `household_id` | uuid fk | RLS: member-only, all CRUD |
| `type` | text | `'log'` (something done) \| `'contract'` (something that runs out) |
| `title` | text | "Avloppsspolning", "Elavtal Tibber" |
| `category` | text | free enum in app: `underhåll` / `avtal` / `besiktning` / `övrigt` — drives icon + timeline colour |
| `date` | date | log: when it was done · contract: when it **expires** |
| `cost` | numeric null | optional kr (logs mostly) |
| `vendor` | text null | who did it / who the contract is with, free text incl. phone |
| `interval_years` | numeric null | logs only: "every N years" soft hint |
| `remind_days` | int default 60 | contracts: flag when within this window |
| `notes` | text null | |
| `created_at` / `updated_at` | timestamptz | |

Derived, in `lib/huskalendern.ts` (pure, tested — never stored):

- `nextDue(item)`: contract → `date`; log with `interval_years` →
  `date + interval` ("due again ≈ 2027-05"); log without interval → none.
- `status(item, today)`: `overdue` (nextDue passed) · `soon` (within
  `remind_days`, contracts, or within 90 days for interval hints) ·
  `ok` · `none`.
- `timelineEntries(items, today)`: one entry per **milestone** — every
  log's done-date (past) and every item's nextDue (future) — sorted
  ascending, bucketed by year, with a `today` divider entry injected.
  A log with an interval therefore appears twice: as history and as a
  future soft milestone.

Store `lib/huskalendern-store.ts`: Zustand + Supabase rows, following the
manadsavslut-store shape (snake_case rows, optimistic update, per-row
upsert/delete — **never** delete-then-insert; plan 43's lesson applies).
Save errors surface via toast (plan 44 discipline).

## UI — the timeline

Single vertical timeline, past at the top, future below, **auto-scrolled
so "Idag" sits in view on load**:

- **Past (above Idag):** completed log milestones — dot, date, title,
  vendor, cost if set. Muted/ink styling; year markers between groups.
- **"Idag" divider:** the anchor line, visually distinct.
- **Future (below Idag):** scrolling down reveals what's coming, nearest
  first — contract expiries (hard dates) and interval hints (soft,
  rendered with "≈" and dashed connector to signal estimate). Items in
  `soon` state get an amber flag, `overdue` red, per the plan 61/63
  colour rules.
- Timeline connector is one continuous rail; category icon per node
  (plan 60 icon system).
- **Add/edit** via DialogShell (one dialog, `type` toggles which fields
  show); delete confirms per plan 61 destructive-button rules.
- **Empty state** (plan 62): explains the two item kinds, one-tap
  examples ("Lägg till: Avloppsspolning · Elavtal …").
- Mobile (≤600 px): timeline is already a vertical list — mostly a
  padding/rail-width pass, verify at 390.

## Reminders (in-app only)

- Tool page: `soon`/`overdue` items flagged on the timeline + a compact
  "Behöver ses över (2)" strip pinned above it when count > 0.
- Hub bento tile: Huskalendern card shows the same count via
  `hub-stats.ts` ("2 saker behöver ses över" / next milestone when zero).
- Email digest → plan 72.

## Acceptance criteria

- CRUD on both item types syncs across the household (verify with two
  sessions against local Supabase); RLS blocks non-members.
- Timeline renders past→Idag→future correctly for a mixed fixture (logs
  with/without interval, contracts inside/outside remind window); an
  interval log appears both as history and as a future "≈" milestone.
- `nextDue`/`status`/`timelineEntries` unit-tested including edges:
  expiry today, interval crossing year boundary, no-interval log.
- Hub card shows the attention count; empty household shows the plan-62
  empty state, not a bare rail.
- Both themes + 390 px pass; migration applied to local Supabase and
  checked into the migrations dir.

## Out of scope

- Full recurrence engine (RRULE etc.) — `interval_years` hint only.
- Document/warranty attachments (natural later extension).
- Editing reminders per-device; `remind_days` is per-item, shared.
