# Planning — Hemma / Bostadskalkyl feature batch

Six requests reviewed on 2026-06-27. All six are implementable; each has its own
doc. **Files are numbered 01–06 in recommended build order**; the **Req** column
maps each back to your original request list. The **Decisions locked** section at
the top of each doc is the source of truth (and each doc's title keeps its
original request number, e.g. "#3", which the cross-references rely on).

## The six (in build order)

| File | Req | Summary | Effort | Depends on |
|------|-----|---------|--------|------------|
| [01-ci-pin-ubuntu.md](01-ci-pin-ubuntu.md) | 6 | Pin CI runner `ubuntu-latest` → `ubuntu-24.04`. | XS | — |
| [02-chart-morph-jank-fix.md](02-chart-morph-jank-fix.md) | 4 | Fix chart jank on minimize — defer mounting the heavy visx chart until the morph settles. | S–M | — |
| [03-hushallsbudget-lock-names.md](03-hushallsbudget-lock-names.md) | 5 | Lock Hushållsbudget item/category names behind a per-row pen-edit toggle. | S | — |
| [04-scenarios-dashboard.md](04-scenarios-dashboard.md) | 3 | Bostadskalkyl scenarios become a full-page dashboard you land on; calculator moves to `/bostadskalkyl/:id`. Hybrid save (named cards auto-save; "New" = scratch draft). | M–L | — (foundation) |
| [05-bostadskalkyl-editable-constants.md](05-bostadskalkyl-editable-constants.md) | 2 | Settings panel for the statutory constants (fastighetsavgift cap, 15% min, lagfart, pantbrev, ränteavdrag, amort rules). Per-scenario override; amort rate auto-derives. | M | Req 3 |
| [06-tool-card-expand-animation.md](06-tool-card-expand-animation.md) | 1 | Hub tool card "expands into the page" via the native View Transitions API (RR v7 `viewTransition`). Bostadskalkyl card first. | S–M | Req 3 |
| [07-scenarios-dashboard-ui-polish.md](07-scenarios-dashboard-ui-polish.md) | — | UI/UX rebuild of the shipped scenarios dashboard: wider canvas, hero+chips cards (6 figures), whole-card-open + kebab, sort+search, add-tile, muted health colors, Motion/NumberFlow. | M | Req 3 (shipped) |
| [08-tool-card-dolly-zoom.md](08-tool-card-dolly-zoom.md) | — | **Reworks #06's animation:** replace the card→page cross-fade morph with a no-fade parallax "dolly into the card" (solid scale-up + late micro-dissolve, dashboard parallax behind, symmetric collapse on back). Bostadskalkyl only. | M | Supersedes #06 |

## Dependency graph

```
Req 3 scenarios dashboard (file 04) ──┬──► Req 2 editable constants (file 05)  (constants ride inside the scenario record)
                                      └──► Req 1 card expand anim   (file 06)  (morph destination = the dashboard)

Req 4 chart jank (file 02) ── independent
Req 5 lock names (file 03) ── independent
Req 6 CI pin     (file 01) ── independent
```

## Build order = file order

1. **01 — CI pin** (Req 6) — trivial, ship it first (one PR, two lines).
2. **02 — chart jank** (Req 4) + **03 — lock names** (Req 5) — independent,
   self-contained polish; either order.
3. **04 — scenarios dashboard** (Req 3) — the foundation; restructures routing +
   the store.
4. **05 — editable constants** (Req 2) — rides on 04's per-scenario model and the
   `calc.ts` refactor.
5. **06 — card expand animation** (Req 1) — its morph lands on the 04 dashboard,
   so do it with/after 04.
6. **07 — dashboard UI polish** — follow-up to the now-shipped 04. Touches the
   same card markup as 06, so build **07 before 06** if both are done, or 06's
   View Transition will land on the old card design and need rework.

Each remains its own branch + PR (`ui/<slug>`), base `main`, landed one at a time.

## Out of scope / parked (raised during review, not requested)

- Scenario **comparison** view on the dashboard (natural extension; not asked for).
- Extending the card-expand animation to the **other 5 tools** (deliberately scoped to Bostadskalkyl first as a proof-of-concept).
- Moving drift/savings line items from session-global to per-scenario (currently session-level by design).
- SHA-pinning GitHub Actions (considered in 01, deferred).

---

# Design-review batch — 2026-07-07 (plans 57–69) + mobile addendum (73–75)

Senior-designer Playwright walkthrough of all seven surfaces (tools first,
then homepage, then a dedicated 390 px mobile pass). Numbers = build order
within each group. Plans 70–72 (ideas batch) are unrelated and documented in
their own files.

| File | Scope | Summary | Owner model | Effort |
|------|-------|---------|-------------|--------|
| [57-field-label-clipping.md](57-field-label-clipping.md) | tools | Bilingual field labels ellipsize mid-word everywhere; never-clip rule | Sonnet | S |
| [58-konsult-sticky-ledger-header.md](58-konsult-sticky-ledger-header.md) | tools | Sticky ledger header overlaps rows mid-scroll | Sonnet | XS |
| [59-page-background-seam.md](59-page-background-seam.md) | tools | Fixed-size body gradient ends in a visible full-width band | Sonnet | XS–S |
| [60-icon-system.md](60-icon-system.md) | tools | Text glyphs (⚙ ✎ ✕ ☆…) → lucide-react + real hit areas | Sonnet | S |
| [61-button-hierarchy-destructive.md](61-button-hierarchy-destructive.md) | tools | Demote Delete-all from headers; one danger variant; disable impossible CTAs | Sonnet | S |
| [62-empty-states-first-run.md](62-empty-states-first-run.md) | tools | First-run = one hero CTA, not 2 300 px of empty cards | Opus | M |
| [63-dataviz-palette-legends.md](63-dataviz-palette-legends.md) | tools | Tokenized 8-slot green/copper ramp; donut legend rework (after plan 41) | Opus | M |
| [64-bolanekoll-hero-hierarchy.md](64-bolanekoll-hero-hierarchy.md) | tools | One hero, ≤4 KPI chips, kill the focus-mimicking outline | Opus | M |
| [65-dashboard-card-language-numbers.md](65-dashboard-card-language-numbers.md) | tools | Scenario-card stat labels/formats; hero whole-kr rule | Sonnet | S |
| [66-skip-link-fixed-positioning.md](66-skip-link-fixed-positioning.md) | home | Skip-link visible mid-page (transform breaks position:fixed) | Sonnet | XS |
| [67-homepage-copy-truth-pass.md](67-homepage-copy-truth-pass.md) | home | "Synced tomorrow"/"Supabase-ready" stale; Live chips = noise; wordmark | Sonnet | XS–S |
| [68-bento-card-anatomy.md](68-bento-card-anatomy.md) | home | Labeled stats, one mobile card shape, data-driven wide slots | Opus | M |
| [69-hero-readability-light-theme.md](69-hero-readability-light-theme.md) | home | Subline scrim, aurora banding probe, real light-mode treatment | Opus | M–L |
| [73-mobile-tables-to-cards.md](73-mobile-tables-to-cards.md) | mobile | Tables are 2.4× viewport with invisible scroll; rows become cards ≤600 px | Opus (pattern) + Sonnet (fan-out) | M |
| [74-mobile-text-starvation.md](74-mobile-text-starvation.md) | mobile | Row names/CTAs clip ("Submit this month's sal…"); text gets priority | Sonnet | S |
| [75-ios-input-zoom.md](75-ios-input-zoom.md) | mobile | 12–14 px inputs → iOS focus-zoom; 16 px on coarse pointers | Sonnet | XS–S |

## Sequencing notes

- **57 → 74 → 75** share the "nothing readable ever clips" thread: 57 fixes
  field labels, 74 extends the rule to row names/CTAs, 75's font bump then
  reflows the fixed layouts — build in that order.
- **41 → 63**: the chart-theme hook consolidation lands first so 63 changes
  colors in one place.
- **61 vs 73**: both touch the Månadsavslut/Bolånekoll section headers and
  row actions — land one before starting the other.
- **69** ends in a user taste decision (day-tuned scene vs static editorial
  header in light mode) — prototype both, get sign-off before merging.
- Each plan = own branch (`ui/<slug>`) + PR, base `main`, one at a time.

## Out of scope / parked (raised during review, not planned)

- Data-freshness chip on hub cards ("Uppdaterad idag") — only worthwhile
  successor to the deleted Live chip; revisit after 68.
- Lönevaxling mobile: headline result sits 2+ viewports down (sticky bar
  mitigates) — reassess after 73–75 land.
- Homepage `More Plans.md` items and plans 70–72 (ideas batch) — separate
  thread.

---

# Infra — 2026-07-07 (standalone)

| File | Scope | Summary | Owner model | Effort |
|------|-------|---------|-------------|--------|
| [81-custom-se-domain.md](81-custom-se-domain.md) | hosting | Move Hemma·OS onto a custom `.se` domain while keeping GitHub Pages as the host — DNS + Pages custom-domain + Supabase Auth allow-list; the only repo change is a one-line `CNAME` echo in `deploy.yml` | Human-led (Haiku for the workflow edit) | S |

Standalone; not blocked by and does not block any other batch. **Do the GitHub
Pages custom-domain step and the Supabase Auth allow-list step in one sitting** —
the gap between them is exactly when magic-link login silently breaks. Written
pedagogically (mental model + the two non-obvious gotchas) at the user's request.

---

# Bolånekoll — 2026-07-08 (standalone)

| File | Scope | Summary | Owner model | Effort |
|------|-------|---------|-------------|--------|
| [82-bolanekoll-rate-whatif.md](82-bolanekoll-rate-whatif.md) | bolånekoll | Rate what-if in the Prognos card — hypothetical rate on the whole balance → now / at X % / delta chips (kr/mån + kr/år); pure `rateWhatIf` helper + golden tests, ephemeral state, no schema change | Opus (golden values + ränteavdrag-per-month semantics) + Sonnet (UI wiring) | S |

Standalone; not blocked by anything. Deliberately a *hypothetical*, not a
forecast — plan 70 (Räntebesked) owns real repricing; plan 23 owns predicted
actual charges. All 10 design decisions locked via grilled Q&A, recorded in
the plan.

---

# Bolånekoll UX from live review — 2026-07-10 (batch)

Raised while using the app after plans 63–69 shipped. Two design plans; the
sibling correctness/polish fixes from the same review (bento hydration
layout-shift + back-zoom, Bolånekoll empty-hero flash, cost-basis figure in the
wrong font) were **implemented directly** — no plan doc — on branch
`fix/bolanekoll-hydration-flash-hero-font`.

| File | Scope | Summary | Owner model | Effort |
|------|-------|---------|-------------|--------|
| [86-bolanekoll-ownership-split-vocab.md](86-bolanekoll-ownership-split-vocab.md) | bolånekoll | One ownership-split model: same % is printed 3× under "equity share"/"funded"/"contributed" against 3 different bases — state the split once, keep two distinct bases, kill the third label | Opus (information design) | S |
| [87-bolanekoll-insatser-onboarding.md](87-bolanekoll-insatser-onboarding.md) | bolånekoll | Give Insatser a front door: explicit "track who paid what" CTA, drop the native `confirm()`, let the section teach before tracking is on, name the 3 concepts once | Opus (onboarding/IA) | M |

**Build order: 86 → 87.** 86 settles the vocabulary ("paid in"); 87 reuses it in
every onboarding string. Each is its own branch + PR, base main, landed one at a
time.

---

# Cross-tool sync — 2026-07-11 (standalone)

Raised during the plan-82 grilled Q&A; all 8 design decisions locked via a
second grilled Q&A the same day and recorded in the plan.

| File | Scope | Summary | Owner model | Effort |
|------|-------|---------|-------------|--------|
| [89-hushallsbudget-bolan-auto-sync.md](89-hushallsbudget-bolan-auto-sync.md) | hushållsbudget ← bolånekoll | Auto-synced read-only "Bolån" section in the budget's joint costs: two rows (ränta = balance × blended /12, amortering observed), synced on budget mount, `source:'bolanekoll'`-tagged rows + `_migrate` guard, dismissible double-count hint, off-toggle | Opus (sync/state-identity semantics + migrate guard + golden values) + Sonnet (pinned card UI) | M |

Standalone; builds on plan 82's figure conventions (shipped, PR #275). Key
landmine documented in the plan: the store's `_migrate` force-categorises
category-less joint rows on every load and must be guarded or it teleports the
synced rows into user categories. Branch/PR convention as always: own branch,
base main.

## Plan 90 — Branded error & offline pages

| File | Scope | Summary | Owner model | Effort |
|------|-------|---------|-------------|--------|
| [90-error-pages-offline-ux.md](90-error-pages-offline-ux.md) | app-wide (router, offline UX) | Replace React Router's default "Unexpected Application Error" page + the browser's offline page with branded surfaces: (1) `errorElement` crash boundary that leads with "Du är offline", (2) global offline banner, (3) unify Hushållsbudget `alert()` → toast, (4) `vite-plugin-pwa` offline shell fallback | Split — Opus for Layer 4 (SW ↔ strict CSP + `base:'./'` scope + cache-on-deploy) + Sonnet for Layers 1–3 | M |

Standalone; blocks nothing. Layers 1–3 ship as one PR; **Layer 4 (service
worker) is a separate PR** so its caching behavior is verified in isolation.
Source: user report 2026-07-12 (ugly page when the network dropped). Branch/PR
convention as always: own branch, base main.

## Plan 91 — Replace native `confirm()` with a themed dialog

| File | Scope | Summary | Owner model | Effort |
|------|-------|---------|-------------|--------|
| [91-confirm-dialog-native-dialog-replacement.md](91-confirm-dialog-native-dialog-replacement.md) | app-wide (all tools) | Kill all 19 native `window.confirm()` calls (deletes, bulk, multi-line decisions): new `ConfirmDialog` on DialogShell + promise-based `useConfirm()` provider so `if (confirm(…))` → `if (await confirm({…}))` with minimal churn; danger-styled themed dialog in both light/dark; plus the 3 leftover Hushållsbudget `alert()`s not owned by plan 90 → toast | Split — Opus for the component + `useConfirm()` API/promise semantics; Sonnet fans out the ~19 call-site swaps | M |

Standalone; **coordinate with plan 90 on Hushållsbudget** — 90 Layer 3 converts
that route's two save/delete-failure `alert()`s to a toast; 91 must not
double-convert lines 221/331. Either order works. Source: user report 2026-07-12
("dialog boxes are standard browser dialog boxes … when delete"). Undo-toast for
reversible single deletes is deliberately deferred to plan 92. Branch/PR
convention as always: own branch, base main.

## Plan 92 — Undo toast for reversible single-row deletes

| File | Scope | Summary | Owner model | Effort |
|------|-------|---------|-------------|--------|
| [92-undo-toast-reversible-deletes.md](92-undo-toast-reversible-deletes.md) | bolånekoll · månadsavslut · hushållsbudget | For the 6 reversible leaf deletes (payment, valuation, contribution, rate period, month-end item, salary submission): drop the confirmation, delete immediately, show a 6s "Deleted · Ångra" toast that re-inserts the exact row (`id`/`created_at` preserved by `stamp()`). New `restore*` store fns + a shared `useUndo()` hook; also migrate ScenariosDashboard's hand-rolled undo onto it. Cascade/bulk/non-delete stay on plan 91's ConfirmDialog | Split — Opus for `restore*` + `useUndo()` (identity-preservation + delete-now semantics); Sonnet wires the toast per route | M |

**Build order: 91 → 92.** 91 gives every delete a ConfirmDialog; 92 then removes
the confirm for the reversible leaf subset and swaps in delete-now + undo. Both
edit the same call sites for that subset, so land 91 first, then rebase 92.
Source: follow-up deferred out of plan 91. Branch/PR convention as always: own
branch, base main.

---

# Security, persistence & structure review — 2026-07-12 (plans 93–101)

Code-level review of `web/`, every Supabase migration, the store layer, emitted
assets, CSS boundaries, and critical tests. No confirmed cross-household access
or service-role leak was found. The top risk is silent data loss: several
Supabase writes ignore resolved `{ error }` results, while the cache is described
as eventual sync without a replay queue.

| File | Priority | Scope | Summary | Owner model | Effort | Depends on |
|------|----------|-------|---------|-------------|--------|------------|
| [93-supabase-write-errors-auth-gate.md](93-supabase-write-errors-auth-gate.md) | High | persistence + auth | Check every mutation result, fail household provisioning closed, and map raw backend errors to stable UI copy | GPT-5.6 Sol | M | — |
| [94-atomic-mortgage-loan-part-delete.md](completed/94-atomic-mortgage-loan-part-delete.md) | Medium | bolånekoll | Replace parent-first three-request delete with one confirmed, household-scoped transaction | GPT-5.6 Sol | S–M | 93; product decision |
| [95-household-lifecycle-concurrency.md](completed/95-household-lifecycle-concurrency.md) | Medium | membership/invites | Serialize final-member leave and define deterministic multiple-invite behavior | GPT-5.6 Sol | S–M | product decision |
| [96-live-supabase-security-verification.md](completed/96-live-supabase-security-verification.md) | Medium | deployed boundary | Live DB catalog + Auth hook verified; grant migration applied; header gaps documented separately | GPT-5.6 Sol | M | approval/access |
| [97-durable-sync-cache-isolation.md](completed/97-durable-sync-cache-isolation.md) | High | all cloud stores | Durable household-scoped outbox, dirty-cache reconciliation, deletion tombstones, shared-device cleanup | GPT-5.6 Sol | L | 93 |
| [98-optimistic-concurrency-tool-state.md](completed/98-optimistic-concurrency-tool-state.md) | Medium | blobs + row stores | Use server revisions to detect partner/device conflicts; split or atomically patch shared prefs | GPT-5.6 Sol | M–L | 93, 97 |
| [99-typed-persistence-boundaries.md](completed/99-typed-persistence-boundaries.md) | Low–Med | storage/import/domain seams | Runtime-validate JSON/cache/import rows and brand high-risk ids/dates | GPT-5.6 Terra | M–L | preferably 93, 97–98 |
| [100-route-css-scoping.md](100-route-css-scoping.md) | Low | all route CSS | Scope tool selectors, remove import-order coupling, add a selector audit | GPT-5.6 Terra | M | coordinate with UI plans |
| [101-route-store-decomposition.md](101-route-store-decomposition.md) | Low | large routes/stores | Incrementally extract orchestration and stable row-store mechanics after semantics are fixed | GPT-5.6 Sol | L | 93, 97–98 |

## Recommended sequence

Execute the files in numeric order:

1. **93** — establish truthful persistence failures and a fail-closed AuthGate.
2. **94** — make the known mortgage deletion operation atomic.
3. **95** — close household lifecycle races.
4. **96** — verify the live boundary before further schema/sync expansion.
5. **97** — add durable replay and household-scoped cache isolation.
6. **98** — add conflict detection on top of the durable sync contract.
7. **99** — validate persistence boundaries and strengthen ids/dates.
8. **100** — isolate route CSS after the data-safety work is stable.
9. **101** — decompose routes/stores last, so it abstracts the corrected
   persistence behavior rather than preserving the old one.

This order deliberately ships bounded correctness/security fixes before the
larger sync redesign and leaves structural cleanup until behavior is proven.
Plan 96 requires the approval documented in its file. Each implementation
remains its own branch and PR from current `main`.

---

# Student Loan forecast — 2026-07-12 (standalone)

| File | Priority | Scope | Summary | Owner | Effort |
|------|----------|-------|---------|-------|--------|
| [102-student-loan-decision-forecast.md](102-student-loan-decision-forecast.md) | High | UK Plan 1 Student Loan | Effective-dated overseas rules, currency-correct cash flows, independent forecast paths, scenarios, break-even triggers, seeded probability analysis and adaptive reassessment | Codex | L |

Standalone financial-model upgrade based on the confirmed post-2006
England/Wales Plan 1 loan, steady expected earnings and lowest-expected-cost
objective. Both deterministic scenarios and probability analysis are in scope.
Implementation requires owner confirmation of formulas and default forecast
ranges because it materially changes the payoff recommendation.

---

# Bolånekoll — bank model + declared overrides — 2026-07-14

Raised after the #305 forecast fix and the owner's move to a rolling 3-month
bunden from Aug 2026. The through-line: **a declared fact wins over ledger
detection, which stays the default and fallback** (same principle as the
contractual `listed` rate, #303). The discussion surfaced a domain-model gap,
so the batch grew a foundational plan (103) that 104 builds on. **Files are
numbered in execution order.**

**Build order: 103 → 104 → 105.** 103 is the foundation (104 depends on it); 105
(amortering) is independent and can slot in any time. Each its own branch + PR
off `main`; the approved schema/RLS changes in 103/104 seed + backfill and never
edit an applied migration.

| File | Priority | Depends on | Scope | Summary | Owner | Effort |
|------|----------|-----------|-------|---------|-------|--------|
| [103-mortgage-domain-model.md](completed/103-mortgage-domain-model.md) | High (foundational) · shipped | — | mortgage schema | **Bank → Mortgage → Lånedel.** Restructure the flat model into the real bolån hierarchy: new `mortgage_banks` + `mortgages` tables, `mortgage_loan_parts.mortgage_id`. Conventions live on the Bank, rates stay per Lånedel (per-part rörlig/bunden preserved). Model many mortgages / build UI for one; **change bank = new mortgage** on a retained bank. Also **retires the overloaded per-part `start_balance` / "As of date"**: adds an explicit `original_balance` origination anchor and rebuilds `reconcileBalance` so a loan older than its imported ledger no longer trips the false *"start balance off by 192 000 kr"* banner. Owner-approved relational route + entity model 2026-07-14. Foundation for 104. | Claude Opus 4.8 | L |
| [104-declared-calc-overrides.md](completed/104-declared-calc-overrides.md) | High | **103** | mortgage forecast | **Bank profiles** (data records on 103's Bank entity, not per-bank code): billing conventions (chiefly day-count year, faktisk/360) the generic math reads instead of guessing. **The rolling 3-month bunden breaks the trailing-window `interestYearBasis` every quarter** — its 6-charge window straddles two rates and reverts to 365, returning the #305 undershoot; a **declared** value is immune, and a **new window-scoped, bank-pooled learner** (score within each rate window, pool across the bank's windows — learns from 2–3 rolling windows) fixes the detection path too. Provenance: detected → suggested → declared; suggest, never silently lock; drift banner if a lock stops matching. Adds only the profile columns to `mortgage_banks` (103 owns the tables). Phased: Phase 1 = profile columns + year-basis lock; Phase 2 = the learner + full bank-header UI. | Claude Opus 4.8 | M |
| [105-declared-amortering-plan.md](completed/105-declared-amortering-plan.md) | Medium | — (independent) | mortgage forecast | Declare a fixed rak amortering (kr/mån) on a named part; wins over the derived paired-diff/timeline estimate but not over real rows. Fixes the ~3-month lag when the arrangement is new or changes. | Claude Sonnet 5 | S–M |

**104 is the correctness item** — without it, the rolling-3-month move
re-introduces the exact 1,4 % (~4 005 vs 4 061 kr) the #300–#305 arc fixed, once
per quarter. The window-scoped learner keeps faktisk/360 derivable through the
villkorsändring (the earlier "lock before end of July" urgency was an artifact of
the old trailing-6 detector — corrected); a manual lock makes it correct the
moment it is set. Builds on 103's Bank entity; adds an approved additive column
migration + store/profile tests. 105 is a smaller, independent convenience for
changing the amortering arrangement.

---

# Huskalendern → Apple Calendar — 2026-07-14 (standalone)

Owner asked whether the calendar tool can sync to Apple Calendar. Chosen shape:
a **one-way, read-only ICS subscription feed** (`webcal://`) served by a public
Edge Function, keyed by a per-household bearer token — not CalDAV two-way (Apple
is never the editing surface, and two-way needs a conflict model AGENTS.md
forbids promising without one). Independent of the 103–105 batch.

| File | Priority | Depends on | Scope | Summary | Owner | Effort |
|------|----------|-----------|-------|---------|-------|--------|
| [106-huskalendern-ics-feed.md](106-huskalendern-ics-feed.md) | Medium | — (independent) | new Edge Function + table + Huskalendern UI | Publish Huskalendern's upcoming milestones (contract expiries + `≈` interval projections) as a subscribable `.ics`/`webcal` feed. New `calendar_feeds` token table + get/rotate RPCs; public `house-calendar` function (`verify_jwt=false`, token in URL is the auth) reusing the Deno-portable timeline core; a "Prenumerera i kalender" dialog on the Huskalendern page. **Requires owner sign-off** — public endpoint serving household data + schema/RLS change. | Claude Opus 4.8 | M |

**Owner-approval gate:** unlike the browser-auth'd tools, this exposes household
data at an unauthenticated bearer-token URL. The plan is written so the token
model and the `cost`/`notes` field-exposure decision (§5) can be settled before
any code is written; do not build until approved.

---

# Bolånekoll balance propagation — 2026-07-15 (standalone)

Production use exposed a financial-correctness gap: once a loan part has any
Saldo, later Betalning/Amortering rows without their own Saldo do not move the
current balance, freezing the hero and every ratio derived from debt. The owner
also chose to collapse capital entry into Betalningar and retain Insatser as a
linked derived view.

| File | Priority | Depends on | Scope | Summary | Owner | Effort |
|------|----------|------------|-------|---------|-------|--------|
| [107-bolanekoll-balance-propagation.md](completed/107-bolanekoll-balance-propagation.md) | High | — | mortgage balance engine + persistence + Bolånekoll UI | Replace the competing Saldo/amortering branches with one chronological balance resolver; Betalning reduces principal by Betalning−Ränta (full amount provisionally when Ränta is missing, with an estimate warning), and every explicit Amortering remains separately additive. Route hero, debt, LTV/DTI, cost basis, charts, milestones, forecasts, hub and cross-tool figures through the same debt. Make Betalningar the sole editor and Insatser a linked view; migrate legacy contributions idempotently. | GPT-5.6 Sol | L |

Standalone correctness plan; the owner approved the financial semantics and
persisted-data consolidation on 2026-07-15. It does not change valuations,
statutory rules or rate forecasts. One branch/PR from `main`; never apply its
data migration to production from an agent session.
