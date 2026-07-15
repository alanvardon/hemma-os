# Plan 107 — Make Betalningar the source of truth for debt and ownership

**Status:** completed · **Priority:** High (financial correctness) · **Depends
on:** none; builds on the shipped mortgage model in plans 103–105 · **Effort:**
L · **Owner model:** GPT-5.6 Sol · **Source:** production report 2026-07-15:
adding Betalning, Amortering and Insats records did not move the Bolånekoll hero
or its dependent percentages; owner decisions confirmed 2026-07-15 ·
**Touches:** `web/src/lib/mortgage.ts` and focused mortgage tests;
`web/src/lib/mortgage-store.ts` and store tests; `web/src/lib/hub-stats.ts` and
tests; `web/src/routes/Bolanekoll.tsx` and component tests;
`web/src/routes/bolanekoll/PaymentDialog.tsx`; retire the independent
`ContribDialog.tsx` entry flow; `web/e2e/save-sync.spec.ts`; one new repeatable
Supabase data migration for legacy `mortgage_contributions`; `planning/README.md`.

> **Financial and persisted-data approval — GRANTED 2026-07-15.** The owner
> chose the provisional rule that an unpaired Betalning reduces principal by its
> full amount, with a visible missing-Ränta warning, and chose one Betalningar
> entry surface with Insatser as a linked derived view. The owner also clarified
> that an explicit Amortering is always an independent principal event: a
> same-month Betalning and Amortering both count. Implementation may add a new
> migration, but must never apply it to production; the owner deploys/merges.

## Goal

Make every debt-affecting record flow through one deterministic, auditable
balance engine so the entire application agrees immediately after a save.

After this plan:

- Betalning, Amortering and extra Amortering/Insats records entered after the
  latest Saldo move the remaining debt and every value derived from it.
- The large market-equity hero, Insatt kapital, Remaining debt, LTV, Total
  amortised, owner equity shares, charts, milestones, amorteringskrav, forecast
  starting balances and homepage figures cannot use competing balance rules.
- Betalningar is the only editing surface for kontantinsats, ordinary
  amortering and extra amortering. Insatser becomes a linked read-only view of
  those source records, with Edit returning to the source Betalning.
- Missing Ränta never stays invisible: the app follows the owner's provisional
  full-principal rule but labels the affected figures as estimated and explains
  that ownership may be overstated.

## Confirmed production failure

The current `partBalance()` has two mutually exclusive paths:

1. With no `balance_after`, it returns `start balance - all amortization rows`.
2. Once any Saldo exists, it returns the latest Saldo and ignores every later
   payment or amortering without its own `balance_after`.

Reproduced against `main` at `0e44906`:

```text
latest Saldo                              1 000 000 kr
later explicit Amortering                    10 000 kr
current calculated balance               1 000 000 kr  (wrong)
required calculated balance                 990 000 kr
```

The same stale balance then propagates consistently into the wrong hero, so the
problem can look like disconnected UI even though the root is the balance
resolver. `partBalAsOfMk()` and `partBalanceAsOf()` repeat the same branch and
freeze the ownership timeline and equity bridge too. Existing tests cover
Saldo-only and amortering-only histories, but not a Saldo followed by rows that
lack a new Saldo.

## Decisions locked

### 1. One chronological principal ledger per loan part

Introduce one pure resolver, tentatively:

```ts
interface BalanceResolution {
  balance: number
  principalPaid: number
  anchor: { date: string; balance: number; source: 'saldo' | 'origination' }
  quality: 'observed' | 'estimated'
  warnings: Array<'missing-interest' | 'interest-exceeds-payment' | 'conflicting-saldo'>
}

resolvePartBalance(part, payments, asOf?): BalanceResolution
```

`partBalance`, total-balance helpers, timelines and UI warnings become thin
consumers of this resolver. Do not leave separate copies of the arithmetic in
the current/as-of/monthly paths.

Resolution order:

1. Select the latest valid Saldo at or before `asOf`; otherwise use the loan's
   explicit original/start balance and date.
2. A Saldo is an authoritative **post-transaction snapshot for its date**. It
   supersedes every earlier event, and rows on the same date are treated as
   already represented by that Saldo. Only strictly later principal events are
   applied. A later Saldo resets the running balance again.
3. Process later events chronologically and floor debt at zero. Never silently
   clamp malformed input into a plausible financial record; return a warning or
   exclude it according to the existing normalisation contract and test it.

### 2. Betalning reduces principal; Ränta refines it

For each loan part and calendar month after the active anchor:

```text
betalning principal = max(0, sum(Betalning) - sum(Ränta))
```

- When at least one Ränta row exists, this is the principal component of the
  bank's total debit.
- When Ränta is missing, use the owner's chosen provisional rule:
  `principal = full Betalning`. Mark the resolution `estimated` and add
  `missing-interest`.
- Adding the missing Ränta later recalculates history automatically. Example:
  Betalning 6 000 initially reduces debt by 6 000; adding Ränta 3 000 revises
  the principal reduction to 3 000 and raises remaining debt by 3 000.
- If Ränta exceeds Betalning, principal is zero and the resolver emits
  `interest-exceeds-payment`; it does not create negative amortering.
- Multiple rows in a month are summed per loan part. A row on another part can
  never satisfy or alter this part's pairing.
- Betalning and Ränta are household-joint records and cannot be attributed to
  one person. Their inferred principal enters the joint contribution bucket and
  follows the configured ownership-target split. Defensive loading treats any
  legacy `paid_by:'a'|'b'` on these two kinds as joint; the UI must not offer an
  individual payer for them.

This provisional inference must be visible wherever it materially affects a
decision. A quiet hint only beside the ledger is insufficient when the hero is
showing estimated ownership.

### 3. Every explicit Amortering is separate and additive

Every `kind:'amortization'` row reduces principal by its full amount, whether it
is ordinary or has `is_insats:true`.

**A same-month Betalning does not supersede an explicit Amortering.** Both count:

```text
Betalning 6 000 - Ränta 3 000              = 3 000 principal
separate extra Amortering / Insats 20 000  = 20 000 principal
total monthly debt reduction               = 23 000
```

Do not introduce a month-level "Amortering wins" rule. An explicit row may be
an additional voluntary mortgage reduction and suppressing it would recreate
the reported bug.

Double-count protection is limited to records proven to represent the **same
transaction** through existing import/prediction reconciliation or stable
identity. Similar dates or amounts are not enough evidence. If exact identity
cannot be established, retain both and surface a duplicate-review affordance
rather than silently deleting financial effect.

### 4. Collapse Insatser into the Betalningar source ledger

Betalningar becomes the only place to add or edit capital events:

| Betalningar record | Loan part | Debt effect | Ownership attribution | Appears in Insatser |
|---|---:|---:|---:|---:|
| Kontantinsats (`kind:'down_payment'`) | none | none; already represented by purchase price minus original loans | full amount by `paid_by` / `paid_split` | yes |
| Amortering | required | full amount | full amount by `paid_by` / `paid_split` | no |
| Extra amortering / Insats | required | full amount | full amount by `paid_by` / `paid_split` | yes |
| Betalning | required | Betalning minus same-part/month Ränta; full amount provisionally if Ränta is absent | always joint; inferred principal follows the configured ownership-target split | only if deliberately marked as Insats |

- Add `down_payment` to `PaymentKind`. The database's `kind` column is already
  unconstrained text, so the new value needs no schema column or RLS change.
- Kontantinsats changes **who funded existing cost-basis equity**, not total
  debt or market equity. Increasing total equity again would double-count the
  purchase deposit already present in `purchase price - original loans`.
- `is_insats` remains a classification flag, not a second amount. On an
  amortering it means "show this voluntary extra principal event under
  Insatser"; it never changes the row's debt effect.
- Insatser loses independent Add/Delete state. It is a projection of
  `down_payment` and `is_insats` payment rows. Each item carries its source id;
  Edit opens that exact Betalningar record and deletion uses the normal payment
  mutation path.
- `contributionSplit()` must consume the same canonical rows and the same
  inferred-principal components as the balance engine. It may not count a full
  Betalning for ownership while the debt engine counts only its net principal.

### 5. Preserve legacy contributions without duplication

Existing `mortgage_contributions` contain real household data and cannot simply
disappear when the UI is collapsed.

- Add a new, repeatable Supabase **data migration** that inserts each legacy
  contribution into `mortgage_payments` as `kind:'down_payment'`,
  `loan_part_id:null`, `is_insats:true`, retaining date, amount, owner, note and
  creation time. Use a deterministic derived id/source marker so rerunning is
  idempotent and cannot collide with an ordinary payment.
- Keep the legacy table and rows in place for rollback/audit in this plan; stop
  new application writes to it. Dropping the table is a later cleanup after a
  shipped-version soak period, not part of the correctness fix.
- Migrate cached/imported envelopes defensively with the same deterministic ids.
  A household that sees both the migrated cloud row and an old cached
  contribution must still get one canonical payment, never two.
- Test malformed, zero, missing-owner and already-migrated rows. Do not silently
  invent ownership or amounts.
- Update export/import so a round-trip produces the canonical payment once and
  can still read a legacy backup.

## One dependency graph for every displayed result

All present and historical consumers must use the shared resolver:

```text
Saldo + Betalning/Ränta + every explicit Amortering
                         │
                         ▼
               resolvePartBalance(asOf)
                         │
          ┌──────────────┼────────────────┐
          ▼              ▼                ▼
   current debt    historical debt   quality/warnings
          │              │                │
          ├─ market equity / owner equity │
          ├─ cost-basis equity / owned %  │
          ├─ Remaining debt               │
          ├─ LTV and DTI                   │
          ├─ Total amortised               │
          ├─ amorteringskrav               │
          ├─ payoff/LTV milestones         │
          ├─ rate what-if start balance    │
          ├─ forecast/group balances       │
          ├─ homepage debt/%/sparkline     │
          └─ cross-tool mortgage snapshot ┘
```

Audit and route at least these current duplicate paths through the resolver:

- `partBalance`, `totalBalance`, `totalAmortized`;
- `partBalAsOfMk`, `balanceTimeline`, `equityTimeline`;
- `partBalanceAsOf`, `totalBalanceAsOf`, `equityBridge`;
- `projectBalance` / `projectMilestones` and their current LTV;
- `groupLoanParts`, forecast starting balances and rate what-if inputs;
- `amorteringskravStatus` (LTV, DTI, required annual amount);
- the Bolånekoll hero, per-owner splits, metric chips and per-part rows;
- `hub-stats.ts` debt, owned percentage and sparkline;
- any Hushållsbudget mortgage snapshot derived from `totalBalance`.

Do not alter valuation selection, statutory thresholds, interest formulas or
forecast rate rules while centralising the balance.

## UX and wording

### Betalningar editor

- Replace the generic checkbox ambiguity with explicit types/actions:
  Kontantinsats, Betalning, Amortering and Extra amortering / Insats.
- Extra amortering writes `kind:'amortization', is_insats:true`; ordinary
  Amortering writes the same kind with the flag false. Both require a loan part.
- Kontantinsats writes `kind:'down_payment', loan_part_id:null,
  is_insats:true` and requires owner allocation.
- Betalning keeps optional Saldo. When it has no same-month Ränta and no
  authoritative later Saldo, show the warning before save and on the affected
  dashboard state; do not block the owner-approved provisional calculation.
- Betalning and Ränta always save with `paid_by:'joint'` and no `paid_split`;
  hide individual payer/allocation controls for these kinds. Amortering and
  Extra amortering / Insats retain owner allocation because one owner may fund
  them separately.
- Explain that adding Ränta later revises the inferred principal and may reduce
  the displayed ownership.

### Hero and warnings

- Keep observed Saldo-derived results visually normal.
- When any active loan part relies on an unpaired Betalning after its latest
  Saldo, label debt-derived figures as estimates and show concise Swedish copy:
  `Ränta saknas för en eller flera betalningar — ägandet kan vara överskattat.`
- Link the warning to the affected rows/loan parts. Do not make colour the only
  signal and do not hide it below the fold.
- Clear the warning automatically when Ränta or a later authoritative Saldo
  resolves the uncertainty.

### Insatser linked view

- Retain the Insatser section and its per-owner summary.
- Replace its Add contribution button and independent CRUD with a link to
  Betalningar and linked source rows.
- Show record type (Kontantinsats or Extra amortering), loan part when relevant,
  owner allocation, amount and date. Editing navigates/opens the canonical
  record; saved changes update both views immediately.

## Test plan — test first

### Pure balance-engine goldens

Add a focused `mortgage-balance.test.ts` (or an equivalently cohesive file):

1. **Reported regression:** Saldo 1 000 000 followed by Amortering 10 000 with
   no new Saldo resolves to 990 000.
2. **Unpaired Betalning:** 6 000 after the anchor resolves as 6 000 principal,
   marks estimated and emits `missing-interest`.
3. **Ränta arrives later:** adding same-part/month Ränta 3 000 revises that
   principal to 3 000 and clears `missing-interest`.
4. **Owner clarification:** paired Betalning contributes 3 000 **plus** a
   separate same-month Amortering/Insats 20 000, for 23 000 total principal.
5. Ordinary and `is_insats:true` amortering have identical debt effects.
6. A later Saldo supersedes prior inference; rows strictly after it apply.
   Same-day rows are not applied twice.
7. Multiple loan parts/months never cross-pair Ränta and Betalning.
8. Interest-only (`Betalning === Ränta`) produces zero principal; interest above
   payment produces zero plus a warning.
9. Betalning/Ränta inferred principal is always joint even when malformed legacy
   rows carry an individual `paid_by`; no per-person payment allocation is
   possible. Explicit Amortering/Insats attribution remains unchanged.
10. Multiple payments/interests aggregate deterministically; order does not
   matter; debt floors at zero.
11. `asOf` and month-end resolutions use the same engine and reproduce the
    current balance at the final date.
12. Malformed dates/amounts, missing part ids, zero/negative values and
    conflicting same-date Saldo values follow explicit tested rules.

### Downstream invariant matrix

Using one realistic fictional household, add an amortering after a Saldo and
assert the exact delta propagates to:

- Remaining debt (down by the principal delta);
- market equity and Insatt kapital (up by the delta);
- LTV and cost-basis-owned percentage (recomputed from the new debt);
- Total amortised and per-owner equity/paid-in shares;
- historical chart endpoint and equity bridge amortization gain;
- current LTV/DTI/amorteringskrav annual amount;
- payoff/LTV milestones and forecast/group starting balances;
- homepage debt, owned percentage and sparkline endpoint;
- any cross-tool mortgage snapshot.

This is a dependency-contract test, not a collection of snapshots: if a new
debt-derived figure is added later, it should join the same matrix.

### Persistence, migration and user-visible failure tests

Because this changes `mortgage-store.ts` and mutation handlers, pure tests are
not sufficient:

- Store tests with `createSupabaseMock()` cover successful canonical payment
  save, failed save, retry, edit and delete; no Insatser view may update on a
  rejected write.
- Migration tests prove cloud/cache legacy contribution conversion is
  idempotent and does not duplicate when both legacy and canonical rows exist.
- Component tests prove the missing-Ränta warning is visible, clears after a
  matching Ränta/save or Saldo, and a failed save leaves the dialog open with a
  user-visible error.
- Extend `e2e/save-sync.spec.ts`: save an extra amortering, verify every relevant
  hero/KPI delta, reload, and verify the canonical Betalningar row and linked
  Insatser row remain consistent.

## Execution

Each stage is a separate subagent and runs its gate before the next starts.

1. **[gpt-5.6-sol] Balance engine, provenance and pure tests.** Implement the
   single chronological resolver test-first; route current/as-of/monthly
   calculations and pure downstream consumers through it. Gate: focused
   mortgage balance/domain/forecast/cost-basis/hub tests.
2. **[gpt-5.6-sol] Canonical persistence and legacy migration.** Add
   `down_payment`, the repeatable Supabase data migration, defensive cache/import
   migration, store success/failure coverage and export compatibility. This
   agent owns the migration and store files; it must not change UI. Gate:
   migration/static SQL checks plus focused store tests.
3. **[gpt-5.6-terra] Betalningar and linked Insatser UI.** Make Betalningar the
   sole editor, replace contribution CRUD with the linked projection, add
   estimate warnings and component/e2e coverage. This agent owns route,
   dialog/style and browser-flow files and must consume the engine/store APIs
   from stages 1–2 without recreating calculations. Gate: focused component
   tests and the extended save-sync spec.

The orchestrating agent retains the financial-correctness gate, reviews the
combined dependency matrix, then runs the final repository gates. Do not begin
a stage if an implementation discovery would change any locked rule above;
return to the owner with a concrete example first.

## Verification gates

From `web/`:

```sh
npm run lint
npm run test
npm run build
```

Also:

- Run relevant migration/security checks locally; never apply or inspect
  production data.
- Run the scripted `save-sync.spec.ts` extension against its preview build.
- Verify the changed local-dev flow with fictional data at 390x844 and desktop:
  ordinary Betalning, missing-Ränta warning, Ränta added later, regular
  amortering, same-month extra amortering, Kontantinsats, edit via Insatser,
  reload, light/dark and keyboard operation.
- Leave the local dev server running for owner review after interactive
  verification.

## Acceptance criteria

- The confirmed 1 000 000 - 10 000 regression resolves to 990 000 and every
  listed debt-derived display changes in the correct direction.
- A same-month Betalning and explicit Amortering both reduce debt; no
  month-level precedence suppresses either.
- Missing Ränta uses full Betalning provisionally, visibly marks results as
  estimated, and adding Ränta recalculates all dependent values.
- A later Saldo resets the inferred balance without double-counting same-day or
  earlier transactions.
- Betalningar is the only create/edit surface for kontantinsats and extra
  amortering; Insatser is a linked view of the same canonical records.
- Existing contribution data survives the migration exactly once and remains
  attributable to the correct owner.
- Market equity, cost-basis equity, remaining debt, LTV, DTI, Total amortised,
  owner shares, charts, bridges, milestones, amorteringskrav, forecasts, hub and
  cross-tool consumers agree on the same resolved debt.
- Save failures are visible and never leave a phantom change in either view.
- Full lint, test and build gates pass; relevant mobile/desktop flows are
  verified locally with fictional data.

## Out of scope

- Changing valuation selection, purchase price, Swedish amorteringskrav
  thresholds, ränteavdrag, interest accrual or bank year-basis rules.
- Treating contribution-based paid-in percentages as a legal title change; the
  UI remains a household funding model.
- Forecasting a future extra amortering that has not been recorded yet.
- Dropping the legacy `mortgage_contributions` table in the same release.
- Applying migrations, reading production household data, merging or deploying.
