# Plan 87 — Bolånekoll: make first contact with "Insatser" intuitive

**Status:** plan · **Owner model:** Opus (onboarding/IA design — the fix is
deciding the *entry sequence* into a feature that today has no front door and
three overlapping concepts; the code moves are small but the ordering/copy
decisions carry it) · **Source:** user review 2026-07-10 ("first entering
insatser the starting UX is not at all intuitive and very confusing") ·
**Sequencing:** AFTER plan 86 — reuse the vocabulary 86 settles ("paid in") in
every string here. · **Touches:** `Bolanekoll.tsx` (insats entry point,
`maybeEnableContributions`, Insatser section gating), maybe a small new inline
CTA component, `bolanekoll.css`. No store/schema change.

## Finding

There is **no discoverable way to start tracking insatser**, and once you
stumble in, three concepts overlap with no scaffolding:

1. **The only entry point is a flag icon buried in a ledger row** —
   [Bolanekoll.tsx:951](web/src/routes/Bolanekoll.tsx#L951), a small `Flag`
   icon-button on each payment deep down the page. Nothing on the dashboard or
   the Insatser section says "start here".
2. **The enable prompt is a native `confirm()` that fires AFTER the toggle** —
   `handleToggleInsats` flags the row, *then* `maybeEnableContributions`
   ([Bolanekoll.tsx:327,350](web/src/routes/Bolanekoll.tsx#L327)) pops a browser
   `confirm("Flagged as insats. Turn on contribution tracking…?")`. Jarring
   (native dialog in a bespoke UI), and the order is backwards — it acts, then
   asks whether you wanted the feature the action belongs to.
3. **The "Insatser · Contributions" section is hidden until tracking is already
   on** — [Bolanekoll.tsx:1008](web/src/routes/Bolanekoll.tsx#L1008)
   (`settings.track_contributions || insatsPays.length > 0`). So the place that
   would explain the feature only appears *after* you've already triggered it
   elsewhere. Classic chicken-and-egg.
4. **Three overlapping money concepts, no map:** insats-flagged payments (the ★),
   auto-counted per-owner **amortering** (derived from `paid_by`/`paid_split` on
   ordinary payments), and standalone **lump-sum contributions** ("+ Add
   contribution", [Bolanekoll.tsx:1016-1022](web/src/routes/Bolanekoll.tsx#L1016)).
   The section note "Kontantinsats (deriverad) · köpeskilling − lån = …" plus
   "No lump sums yet. Per-owner amortering is counted automatically…" asks a
   first-timer to hold all three in their head at once.

Net: a user who wants "track who paid what" has no obvious first action, gets a
native popup mid-flow, and lands in a section written for someone who already
understands the model.

## Fix

Give the feature a **front door and a linear first-run**, in plan-86 vocabulary:

- **Surface an explicit entry from the ownership card.** When
  `!settings.track_contributions`, show a quiet CTA in/near the hero split area —
  e.g. "Track who paid what → " — that turns on tracking *intentionally* (the
  decision first, the data second). This replaces discovery-by-accident via the
  ledger flag.
- **Replace the native `confirm()`** in `maybeEnableContributions`
  ([:327](web/src/routes/Bolanekoll.tsx#L327)) with an in-app affordance
  (the CTA above, or a `DialogShell`-based confirm consistent with the rest of
  the app — [[project-web-architecture]]: all modals go through `DialogShell`).
  No `window.confirm` on this path.
- **Let the Insatser section render (in an explainer/empty state) before
  tracking is on**, so it can *teach* the model instead of only appearing once
  you're past onboarding. Gate its *interactive* bits on `track_contributions`,
  but let its heading + one-paragraph "what this is" show as the teaching
  surface. Reconcile with plan 62's first-run empty-state patterns already in
  the app.
- **Name the three concepts once, together.** A single short legend distinguishing
  (a) kontantinsats / paid-in, (b) amortering counted automatically, (c) manual
  lump sums — so the derived-vs-manual split stops being a surprise.

## Acceptance criteria

- From a fresh Bolånekoll with a loan + valuation but `track_contributions =
  false`, there is a **visible, labelled way to start tracking contributions**
  without scrolling to the ledger or knowing what the ★ does.
- **No `window.confirm` / `window.alert`** remains on the insats/contribution
  path — grep `confirm(`/`alert(` in
  [Bolanekoll.tsx](web/src/routes/Bolanekoll.tsx) returns only intentional
  destructive-delete confirms (or those are migrated too if plan 61 already did).
- Turning tracking on is a deliberate choice made *before* data entry, not a
  retroactive prompt after flagging a row.
- The Insatser section (or an equivalent teaching surface) is reachable/legible
  before any insats exists, and its copy names the three concepts once using
  plan 86's terms.
- Vocabulary matches plan 86 exactly (no "funded" vs "contributed" drift).
- Checked both themes, 1440 + 390.

## Out of scope

- Re-modelling how per-owner amortering is computed — presentation/onboarding
  only.
- The hero split-row relabel itself — plan 86.
- Removing the ledger-row ★ as a *secondary* way to flag an existing payment as
  an insats (keep it; it's fine once the feature is understood — it just can't be
  the only door).
