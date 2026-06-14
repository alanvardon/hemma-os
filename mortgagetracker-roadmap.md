# Bolånekoll — Roadmap & Feature Backlog

> **Status: all ten items shipped** in one branch (`ui/mortgage-roadmap`) rather than
> the staged PRs A–E suggested below — store schema went straight to v3. The
> sequencing section is kept as the original design rationale. Pure math lives in
> `mortgagetracker.js` and is fully unit-tested (`mortgagetracker.test.js`, 51 tests).

Improvement ideas for the mortgage tracker (`mortgagetracker.*`), beyond the shipped
v1 (PR #141: ledger-format importer, multiple loan parts, manual valuations,
two-owner equity split, stacked-area equity timeline, ränteavdrag estimate,
multi-file import, per-part delete, include/skip-all triage).

Ordered by **insight-per-effort** for the real use case: an interest-only,
shared, Swedish (FastHypotek-style) mortgage. Each item notes what it does, why
it matters, the data/approach, and whether it needs a store schema change.

Architecture reminders for every item below:
- New math lives as **pure functions** in `mortgagetracker.js` (above the
  `if (typeof document === 'undefined') return;` DOM guard) and is unit-tested in
  `mortgagetracker.test.js` via the `node --test` vm sandbox.
- Storage stays the localStorage envelope `bostadskalkyl_mortgage_v1`
  (`{version, loan_parts, payments, valuations, settings}`); any new field bumps
  `version` and adds a migration in `mortgagetracker-store.js`.
- Honor static-checks: `classList` only, no hardcoded hex outside the token
  block, localStorage keys prefixed `bostadskalkyl_`.

---

## Tier 1 — Highest value, data already present (no new data entry)

### 1. Equity bridge: amortization vs appreciation
**What:** Decompose equity growth over a period into the part you *paid down*
(amortization) and the part the *market* gave you (property appreciation).
> "Your equity rose 180 000 kr this year — 40 000 you amortized, 140 000 the
> house appreciating."

**Why:** The single most interesting number not currently surfaced. For an
interest-only loan it also makes the honest point visible: nearly all equity
movement is market, not paydown.

**Approach:** New pure fn
`equityBridge(parts, payments, valuations, fromDate, toDate)` →
`{ amortization_gain, appreciation_gain, total_gain, start_equity, end_equity }`.
amortization_gain = Σ amortization in window; appreciation_gain =
Δ(property value) over window; both reconcile to Δ equity. Render as a small
two-segment bar + caption on the dashboard, with a period selector (YTD / 12m /
all / custom).

**Schema:** none.

### 2. Projection / what-if (payoff & LTV milestones)
**What:** "At the current amortization rate you reach 50% LTV in *Mar 2031* and
full payoff in *2048*." Plus a slider: "amortize +2 000 kr/mo → payoff moves up
6 years." For a flat interest-only loan, honestly render "balance is flat unless
you start amortizing."

**Why:** Turns a backward-looking ledger into forward-looking planning; the
slider is the nudge to start (or increase) amortization.

**Approach:** Pure fn `projectBalance(parts, payments, { extraMonthly, ratePct })`
→ month-by-month projected balance/LTV until payoff or horizon. Derive the
baseline monthly amortization from recent history (trailing avg), user-overridable.
Milestone helper `projectMilestones(...)` → dates for 70% / 50% LTV and payoff.
Render as a dashed continuation of the existing equity chart + milestone chips.

**Schema:** none (projection assumptions live in component state, not storage).

### 3. Real monthly cost view
**What:** What actually leaves the account each month — interest + amortization —
then net of the ränteavdrag already computed. "This month: 8 200 kr out · ~5 740
kr after tax deduction."

**Why:** Adds the "flow" dimension to a dashboard that today only shows "stock"
(equity). It's the number you actually budget around.

**Approach:** Pure fn `monthlyCost(payments, { ranteavdrag })` →
`[{ month, interest, amortization, gross, net_after_deduction }]`. Surface latest
month as dashboard chips and as a small bars list; optionally a thin line on the
chart.

**Schema:** none.

---

## Tier 2 — Swedish-mortgage specific (high value for this user)

### 4. Fixed-rate expiry tracking (villkorsändringsdag)
**What:** Each loan part has a binding period; track when bound rates expire and
surface "Del 2 (1.89%) binds until *2027-09* — 3 months left" on the dashboard,
sorted by soonest.

**Why:** Missing the omförhandling/renegotiation window is real money. Best
small, high-signal feature.

**Approach:** Add `rate_type: 'rörlig' | 'bunden'` and `rate_binding_until` (date,
nullable) to loan parts; extend the part dialog. Pure helper
`bindingStatus(part, asOf)` → `{ days_left, expired }`. Dashboard chip + amber
flag when < 90 days.

**Schema:** **yes** — new loan-part fields → bump `version` to 2 + migration
(default `rörlig`, null binding date).

### 5. Rate history + weighted average rate
**What:** Rate is one static field per part today. Log rate changes over time and
show a blended/weighted-average rate across parts.

**Why:** Variable rates move; a single field loses history and can't feed an
accurate cost/projection. Pairs with #3 and #2.

**Approach:** New collection `rate_changes[] { id, created_at, loan_part_id, date,
rate }`. `effectiveRate(part, rate_changes, asOf)` (step function, latest ≤ asOf)
and `weightedAvgRate(parts, rate_changes, payments, asOf)` (by balance share).
Small rate-history list per part + a blended-rate dashboard chip.

**Schema:** **yes** — new collection → same version-2 migration as #4.

### 6. Amorteringskrav (amortization-requirement) check
**What:** Given LTV — and optionally household gross income — flag whether the
legally required amortization rate is being met. Likely reads "exempt at current
LTV" today (interest-only), but flips silently if a valuation drops.

**Why:** Compliance awareness; the "exempt → not exempt" transition is exactly
the thing you'd otherwise miss.

**Approach:** Optional `household_income_yearly` in settings. Pure fn
`amorteringskrav(ltv, debtToIncome)` encoding the rule (LTV > 70% → 2%/yr,
50–70% → 1%/yr, +1% if loan > 4.5× gross income). Compare required vs actual
annualized amortization; dashboard status chip (green/amber).

**Schema:** **yes** (optional settings field) — folds into version-2 migration.

---

## Tier 3 — Workflow polish

### 7. Per-bank CSV mapping presets
**What:** Remember the column mapping per bank so next month's re-import is one
click instead of re-confirming every field.

**Why:** Removes the main recurring friction in the monthly chore.

**Approach:** `settings.import_presets: { [bankLabel]: mapping }`. On confirm,
offer "save this mapping as <bank>"; on a new import, auto-match by header
signature and pre-select. Reuses existing `autoMapColumns` as the fallback.

**Schema:** settings-only (folds into version-2 migration).

### 8. CSV export
**What:** Export payments (and a summary) back out to CSV, not just JSON.

**Why:** You're migrating *off* a Google Sheet — let people export for taxes
(Skatteverket), spreadsheets, or backups without a JSON detour.

**Approach:** Pure `paymentsToCsv(payments, parts)` → string; download via Blob +
object URL. Mirror the existing JSON export button in settings.

**Schema:** none.

### 9. Reconciliation banner (derived vs Saldo drift)
**What:** Surface when the derived balance (start − Σ amortization) drifts from
the imported running `Saldo` you trust as truth.

**Why:** A malformed/partial import currently skews equity silently; a banner
makes it visible and correctable.

**Approach:** Wire the already-designed `reconcileBalance(parts, payments)` →
per-part `{ derived, csv, drift }`; show a dismissible banner only when
`|drift| > threshold`. Non-destructive (never auto-overwrites).

**Schema:** none.

---

## Tier 4 — Sharing (mirrors Månadsavslut's strength)

### 10. Actual contribution tracking vs flat %
**What:** Ownership is a single % today. If one partner put in more down payment
or amortizes more, track real money-in and show "owned by virtue of contribution"
alongside (or instead of) the flat split — plus a Månadsavslut-style settlement.

**Why:** The flat % is a simplification; real couples rarely split every krona
50/50. Reuses the settlement logic already built next door.

**Approach:** Add `paid_by: 'a' | 'b' | 'joint'` to payments (and optional
down-payment contributions). Pure `contributionSplit(payments, contributions)` →
per-owner totals and implied ownership; `settlement(...)` → who-owes-whom.
Bigger change; gate behind a settings toggle so the simple flat-% path stays
default.

**Schema:** **yes** — new payment field + optional contributions collection →
its own version bump (3).

---

## Suggested sequencing (PRs)

1. **PR A — Equity bridge + Fixed-rate expiry** (`ui/mortgage-insights`):
   #1 (pure, no schema) + #4 (small schema bump). Tight, high-signal first PR;
   the bridge enriches the existing chart, the expiry chip is a date field.
2. **PR B — Cost & projection** (`ui/mortgage-forecast`): #3 then #2; both pure,
   build on each other (#2 reuses the rate from #5 if landed, else the static rate).
3. **PR C — Rate history + amorteringskrav** (`ui/mortgage-rates`): #5 + #6;
   shares the version-2 migration, makes #2/#3 accurate.
4. **PR D — Import & export polish** (`ui/mortgage-io`): #7 + #8 + #9.
5. **PR E — Contribution tracking** (`ui/mortgage-contributions`): #10, its own
   schema bump; do last since it's the largest and behind a toggle.

Each PR: branch off `main` first, keep `node --test mortgagetracker.test.js`
green and `bash .claude/skills/static-checks/static-checks.sh` at exit 0 before
committing, PR base = `main`.

## Schema-migration summary
- **v1 → v2**: loan-part `rate_type` + `rate_binding_until` (#4); `rate_changes[]`
  collection (#5); settings `household_income_yearly` (#6) + `import_presets` (#7).
- **v2 → v3**: payment `paid_by` + optional `contributions[]` (#10).

Migrations live in `mortgagetracker-store.js` (load path), default-fill missing
fields, and must round-trip through `exportJSON`/`importJSON`.
