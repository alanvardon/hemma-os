# Plan 104 — Bank profiles (per-bank, learned, declared conventions)

**Status:** proposed · **Priority:** High · **Depends on:**
[plan 103](103-mortgage-domain-model.md) (Bank/Mortgage entities) · **Effort:** M
(Phase 1 S–M, Phase 2 M) · **Owner:** Claude Opus 4.8 · **Source:** owner design
discussion after the #305 forecast fix + the move to a rolling 3-month bunden
from Aug 2026, 2026-07-14 · **Approvals:** owner approved the relational route on
2026-07-14 · **Touches:** `supabase/migrations/` (new, additive — profile
columns on `mortgage_banks`), RLS, `web/src/lib/mortgage.ts`,
`web/src/lib/mortgage-forecast.test.ts`, `web/src/lib/mortgage-store.ts`,
`web/src/lib/mortgage-store.test.ts`, `web/src/routes/Bolanekoll.tsx`,
`web/src/routes/bolanekoll/` (Bankvillkor section + dialog)

## Goal

Give each **Bank** entity (introduced by [plan 103](103-mortgage-domain-model.md))
a **profile** of that bank's stable billing conventions (day-count year, billing
cadence). The forecast reads the profile of a part's bank (via
`bankForPart`, `part → mortgage → bank`) instead of re-deriving those conventions
from noisy ledger history. Profiles are **per bank, retained across bank switches
(a bank change is a new mortgage on a retained bank — plan 103), and learned by
pooling evidence across all of that bank's rate windows.** Detection stays the
bootstrap; a locked profile value is authoritative.

## Framing: declared *data*, not per-bank *code*

A bank profile is a **data record**, not a per-bank *model* (bank-specific code
paths). Every quirk decoded across #300→#305 (faktisk/360, month-end billing,
contractual-rate-for-bunden, "Betalning" = total debit) was a **parameter, not
an algorithm** — the same generic formulas fed the right values. So a declared
profile captures 100 % of bank-specific behaviour; per-bank code would only wrap
those parameters in `if (bank === …)` branching that is harder to test and read.
The math stays **generic and bank-agnostic**, reading convention values from the
active profile. **No bank-specific branching in the calculation layer** — an
explicit non-goal. Same principle as the contractual `listed` rate (#303) and
amortering ([plan 105](105-declared-amortering-plan.md)): declared facts win
over detection.

A profile does **not** remove the need to *decode* a new bank from its first
statements. It gives one durable place to write the answer, keyed to the bank,
so moving bank (and moving back) is data, not code.

## Storage — profile columns on the Bank entity

The `mortgage_banks` and `mortgages` tables and `mortgage_loan_parts.mortgage_id`
are created by [plan 103](103-mortgage-domain-model.md); `tool_state` was
rejected because a profile is a **retained entity with identity**, not a
singleton config value (see 105). This plan adds only the **profile columns** to
`mortgage_banks`, in its own additive migration:

- `year_basis (int null)`, `billing (text null)`, and per-field provenance
  (`year_basis_source`, `billing_source` ∈ detected/suggested/declared, or a
  small JSON). **Additive, idempotent; never edit 105's migration or an applied
  migration — new migration only.** Defensive against rows lacking the columns
  (null → detect).
- **Change-and-return** works by construction (plan 103): a bank change is a new
  mortgage on the new bank; returning re-uses the retained bank row with its
  conventions intact.

## The trigger: the rolling 3-month bunden breaks trailing-window detection

From Aug 2026 the household moves from the current bunden (3,93 %, faktisk/360,
ending end of July 2026) to a **rolling 3-month bunden** that re-fixes quarterly.
Most of this the forecast already handles (effective-dated `RatePeriod`s per
quarter, monthly billing preserved, preview truncates at each villkorsändringsdag,
#298 banner flags resets). What breaks is `interestYearBasis`
([mortgage.ts:740-755](../web/src/lib/mortgage.ts#L740-L755)): it scores the
**trailing 6 charges**, which under quarterly fixing straddle two rates, so both
error scores fail and it reverts to its **365 default** — re-introducing the
~1,4 % undershoot (~4 005 vs 4 061 kr) every quarter.

## The learner: score within each window, pool across the bank's windows

The fix for both the break and the owner's "learn from 2–3 rolling windows"
requirement is to change *what* the learner reads:

- Score integer-day-ness **within each rate period** — inside one window the
  listed rate is constant, so its 2–3 charges score cleanly (charge ÷
  (saldo × listed/360) is a whole number of days on a faktisk/360 bank).
- **Pool the per-window evidence across all of that bank's windows** (all its
  parts, all its periods). One 3-month window is too thin (~2–3 charges); 2–3
  windows pooled clears the confidence gate.
- Reuse the existing decision thresholds on the pooled evidence (near-exact
  under /360 AND a clear miss under /365; off-rate history misses under both and
  stays on the Swedish default).

Consequence — an **honest correction to the earlier deadline framing**: the hard
"lock before end of July or lose the signal" was an artifact of the trailing-6
detector. With window-scoped, bank-pooled learning, the current steady 3,93 %
history remains permanent evidence (its rate period does not vanish at
villkorsändring), so faktisk/360 stays derivable through and after the
transition. A **manual lock still makes it correct the instant it is set** — so
Phase 1 is "immediate certainty and an owner-confirmed authoritative value,"
**not** a last-chance capture.

## Decisions locked

- **Profile is per bank, relational, retained** (on the plan 103 Bank entity).
  Conventions are **bank-level; rates stay per Lånedel** — this plan never
  touches per-part `RatePeriod`s (rate, rörlig/bunden). The data model allows
  several banks; the UI surfaces the active mortgage's bank (no multi-bank
  management UI yet).
- **Profile fields:** `year_basis: 360 | 365` (the correctness fix, Phase 1);
  `billing: 'month-end' | 'fixed'` (Phase 2, optional pin over
  `isMonthEndBilling`). Rate source stays governed by #303 (out of scope). Never
  pin a basis on the derived-rate path (self-calibrating).
- **Provenance per field: detected → suggested → declared.** *detected* = live
  learner output (provisional); *suggested* = pooled evidence crossed the
  confidence gate and offers a lock; *declared* = owner-confirmed lock. Only a
  *declared* value short-circuits the learner. Surface the state in the Nästa
  avisering detail (observed/estimated/declared labelling convention).
- **Suggest, never silently lock** — a financial convention is promoted to
  authoritative only by an explicit owner action.
- **Drift safety valve** — when a locked value stops matching fresh imports,
  surface it via the #298 stale-row banner pattern; a lock must not hide a real
  change.
- **Detection stays default and fallback** — no bank / no lock reproduces
  today's #305 behaviour. The profile short-circuits, never deletes, the learner.
- **No calculation-layer bank branching** (restated non-goal).
- **Lånedelar rename is out of scope** — the profile UI naturally sits above the
  parts list, inviting "Lånedelar" → "Lån / Bankvillkor", but that is a separate
  cosmetic PR.

## Design

1. **Profile columns & store.** Add `year_basis`/`billing`/provenance to the
   plan 103 `Bank` type + `mortgage_banks`; normalisers default them to null.
   Extend `mortgage-store.ts` to read/write them on the bank CRUD 105 introduces
   (supabase-js returns `{data,error}` — check `error`, as the store does).
2. **Math reads the profile.** Where `year_basis` is computed
   ([mortgage.ts:931-932](../web/src/lib/mortgage.ts#L931-L932)):
   `lockedBunden ? (profileYearBasis(part) ?? learnYearBasis(...)) : 365`, where
   `profileYearBasis` resolves the part's bank via 105's `bankForPart`
   (`part → mortgage → bank`). `rollChargeOnce` already threads `out.year_basis`,
   so the series inherits it.
3. **New learner** `learnYearBasis(bankParts, periods, payments)` — window-scoped
   + bank-pooled scoring as above; pure, no side effects. Replaces the trailing-6
   internals of `interestYearBasis` (keep a thin back-compat wrapper if other
   call sites exist). Pools across all the bank's parts/windows via 105's
   resolvers.
4. **`suggestBankProfile(bank, parts, periods, payments)`** — runs the learner
   and returns per-field value + confident? for the UI's "lås detta?" affordance.
5. **UI.** Phase 1: a minimal Bankvillkor affordance (in the active mortgage's
   bank header from 105) showing the detected year-basis with one-click **Lås
   faktisk/360** (or 365). Phase 2: the bank header gains the full profile
   controls — year-basis + billing (*Auto (upptäck)* | explicit), suggest→confirm
   flow, provenance badges, drift banner — above its nested Lånedelar. Concise
   Swedish copy.

## Phased delivery (each its own branch + PR off `main`, after plan 103)

- **Phase 1 — profile columns + the lock.** Additive migration adding
  `year_basis`/provenance to `mortgage_banks`, store read/write, math reads it,
  minimal lock UI. Makes faktisk/360 authoritative the moment it is set.
- **Phase 2 — the learner + full profile.** Window-scoped bank-pooled
  `learnYearBasis`, the billing pin, suggest→confirm with provenance, the
  Bankvillkor section, drift surfacing.

## Tests (test-first)

Goldens on the **real 13-month ledger** with value-date noise (the #305 lesson:
fixtures carry `elapsed ≠ charged` days), extended with a simulated quarterly
rate change:

- **Rolling-3-month regression (headline)** — a fixture whose history spans the
  old 3,93 % window plus two rolling windows at new rates, monthly month-end
  billing. Assert the **trailing-6** approach reverts to 365 (documents the
  bug); assert the **window-scoped bank-pooled learner** stays 360; assert a
  **declared `year_basis = 360`** is correct across the reset and rolled series
  regardless.
- **Learner pooling** — one 3-month window alone is below the confidence gate
  (stays *detected*); 2–3 pooled windows cross it (becomes *suggested* 360).
- **Pin wins both ways** — clean /365 ledger + 360 pin → 360; 360-shaped ledger
  + 365 pin → 365.
- **Unset = current behaviour** — no bank/profile reproduces every #305 golden
  byte-for-byte (regression guard).
- **Derived path unaffected** — rörlig/expired part ignores the pin, stays 365.
- **Change-and-return** — a part under a retained bank (via 105's mortgage link)
  reads that bank's locked conventions (no re-learn needed). (Entity plumbing for
  this is covered by plan 103's tests; here we assert the *profile lookup*.)
- **Profile store + migration** — save/load/merge of the profile columns with a
  mocked Supabase client (success **and** failure paths, per the AGENTS.md
  writes-and-failures rule); the additive column migration is idempotent; a bank
  row lacking the columns falls back to detection without crashing.
- **Malformed profile** — out-of-set year_basis/billing ignored → detection.

## Rollout note for the owner (operational)

Lock `year_basis = 360` on the Danske bank whenever convenient (no hard
deadline) for immediate certainty; the learner also keeps it robust through the
rolling transition. Each quarterly reset then needs only a new bunden
`RatePeriod` on the affected Lånedel (rate + next villkorsändringsdag). If you
ever move bank, plan 103 makes that a new mortgage on the new bank; moving back
re-uses the retained bank and its profile.

## Out of scope

- Multi-bank management UI / preset marketplace — model supports several banks,
  UI shows the active one; seed one Danske bank.
- Auto-fetching the quarterly rate (parked rate-watcher plan) — owner enters each
  new 3-month rate.
- The Lånedelar rename (separate cosmetic PR).
- Amortering — [plan 105](105-declared-amortering-plan.md).

## Verify gates

`npm run lint`, `npm run test`, `npm run build` from `web/`, plus the local
migration/RLS checks. Store-layer test with a mocked Supabase client for the
profile-column read/write (success + failure), per the AGENTS.md
writes-and-failures rule. (Bank/mortgage entity CRUD is tested in plan 103.)
