# Plan 86 — Bolånekoll: one ownership-split model, not three labels for the same %

**Status:** plan · **Owner model:** Opus (this is information-design, not a
mechanical edit — the same funding percentage is currently projected onto three
different money bases under three labels, and the fix is *deciding* the one
mental model the card should teach, then paring the UI to it. A wrong call here
makes a confusing screen differently confusing.) · **Source:** user review
2026-07-10 ("is funded and equity share not the same?") · **Sequencing:** do
BEFORE plan 87 — 87's onboarding copy and the "why track contributions" pitch
depend on the vocabulary this plan settles. · **Touches:** `Bolanekoll.tsx`
hero split-rows + Insatser split cards, `bolanekoll.css` (`.split-sub` /
`.split-row`), copy only — no store/schema change.

## Finding

The Bolånekoll dashboard shows the **same person at the same percentage three
times**, under three different labels, each multiplying that percentage by a
different base — with nothing explaining they are the same split:

1. **"equity share"** — [Bolanekoll.tsx:515,520](web/src/routes/Bolanekoll.tsx#L515):
   `ALEX · 50,00 %` → **5 000 000 kr** = *market* equity (`eq`) × `cbSplit.a_pct`.
2. **"funded"** — [Bolanekoll.tsx:541,546](web/src/routes/Bolanekoll.tsx#L541):
   `ALEX · 50,00 %` → **750 000 kr** = *cost-basis* equity (`cbSplit.a`) — the
   same `a_pct` applied to a different base.
3. **"contributed"** — [Bolanekoll.tsx:1021-1022](web/src/routes/Bolanekoll.tsx#L1021):
   `ALEX · 50,00 %` → **0 kr** = `contribSplit.a`, a *third* base (kontantinsats
   + logged lump sums) in the Insatser section.

All three percentages come from one function — `contributionSplit()` via
`costBasisSplit()` ([mortgage.ts:345-350](web/src/lib/mortgage.ts#L345)). So the
**percentage is one fact**; only the base differs. A reader sees "ALEX · 50 %"
twice in the hero card alone, with two different kronor figures and two labels
("equity share", "funded"), and reasonably asks whether these are the same thing
or two different splits. They are the same split — that is exactly what the UI
fails to say.

Screenshots (2026-07-10, dev data): market equity 10 000 000 kr, cost-basis
1 500 000 kr, split 50/50 → the hero literally reads `ALEX · 50,00 % / 5 000 000
kr / equity share` next to `ALEX · 50,00 % / 750 000 kr / funded`.

## Fix

Pick ONE model and make the card teach it. Recommended direction (Opus to
finalise against the domain, but this is the intended shape):

- **State the split once, as a shared header, not per-row.** The percentage is a
  property of the *household*, not of each figure. Render `ALEX 50 % ·
  SAM 50 %` once (e.g. a labelled "Ownership split" line or a single two-person
  bar), then show the two *bases* as the differentiated numbers beneath —
  because the two bases are the genuinely distinct facts:
  - **Market equity share** — "what your slice of today's equity is worth"
    (`eq × pct`). Belongs under the market-equity headline.
  - **Paid in / cost-basis** — "what you've actually put in so far"
    (`cbSplit`). Belongs in the cost-basis row.
- **Kill the third vocabulary.** "funded" (hero) and "contributed" (Insatser)
  describe the same base (cost-basis / kontantinsats + amortised). Choose ONE
  term and use it in both places. Recommend **"paid in"** (plain, unambiguous in
  English; Swedish sub "insatt") over "funded"/"contributed".
- **Never show the same % twice without a connective.** If both split-rows
  survive, add a one-line explainer tying them: e.g. "Same 50 / 50 split, applied
  to today's equity above and to what's been paid in below." One sentence removes
  the entire ambiguity even if the layout is otherwise unchanged — this is the
  minimum acceptable fix if the fuller restructure is deferred.

Whichever layout is chosen, the acceptance below is about the *reader's*
takeaway, not the pixels.

## Acceptance criteria

- A person's ownership percentage appears **once** per split concept in the hero
  card — no `ALEX · 50 %` printed twice with two labels and no connective.
- At most **two** distinct split vocabularies across the whole page (one for
  "share of current equity", one for "amount paid in"); the third label is
  eliminated. Grep `equity share|funded|contributed` in
  [Bolanekoll.tsx](web/src/routes/Bolanekoll.tsx) — the survivors must be a
  consistent pair, used identically in the hero and the Insatser section.
- The two money figures under a person remain correct and distinct
  (`eq × pct` vs cost-basis), i.e. this is a relabel/restructure, not a maths
  change — existing `costBasisSplit`/`contributionSplit` tests stay green.
- Checked in both themes at 1440 and 390; the 390 stacked layout
  ([bolanekoll.css:508](web/src/styles/bolanekoll.css#L508) `.split-row` → 1 col)
  still reads cleanly with the new header-once structure.

## Out of scope

- Changing how the split is *computed* (`contributionSplit` weighting) — this is
  purely how it's presented.
- The onboarding into contribution tracking — plan 87.
