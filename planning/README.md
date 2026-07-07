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
