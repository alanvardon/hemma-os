# Plan 57 — Stop clipping field labels (bilingual label system)

**Status:** plan · **Owner model:** Sonnet-suitable (CSS + a copy rule, but
every field must be eyeballed at 1440/768/390 — the failure is visual, not
logical) · **Source:** design review 2026-07-07 (Playwright walkthrough) ·
**Touches:** `konsultkalkyl.css`, `lonevaxling.css`, `hushallsbudget.css`,
`bolanekoll.css`, the corresponding route markup for label text.

## Finding

The dual-language field labels ("Timmar / vecka *Hours/week*") are clipped
mid-word all over the calculators. `.field label` is `white-space: nowrap;
overflow: hidden; text-overflow: ellipsis` (konsultkalkyl.css:72-83), and in
the 2-up input grids the columns are narrow enough that the English gloss
(`.field-en`) renders as "Hour…", "Gross/montl", "To pensi", "Sa", "Tc".
Same pattern clips stat-card labels on mobile in Bolånekoll ("LATEST MO ·
NET C…", "AMORTERINGSKRA…"). Truncated UI copy is the single loudest
amateur tell in the whole suite — it reads as "nobody looked at this
viewport".

## Fix

Pick ONE rule and apply it everywhere:

1. The Swedish term is the label. It never truncates (`white-space: normal`,
   allow a second line inside `.field`).
2. The English gloss is a helper, not a right-hand appendage fighting for
   the same line. Either:
   - drop it where the Swedish is already used by both users (they built
     these tools — "Semester" needs no gloss), or
   - move it below the input as the existing hint style (`.field-hint`
     pattern, cf. "Capped at 10 425 kr/yr"), which already wraps safely.
3. Delete `overflow: hidden; text-overflow: ellipsis` from label rules —
   ellipsis on a *label* is never acceptable; if it doesn't fit, the layout
   is wrong, and hiding that is worse.
4. Stat-card micro-labels (Bolånekoll insights, mobile): same treatment —
   shorten the copy ("Latest month", "Amort.krav") rather than clip it.

Sweep: grep `text-overflow` + `nowrap` across `web/src/styles/*.css`, audit
every hit that applies to a label/heading (values like `.sum-row-val` may
keep nowrap — numbers should not wrap).

## Acceptance criteria

- No visible mid-word clipping of any label at 1440, 768 and 390 px on all
  six tools (manual Playwright pass, both themes).
- No `text-overflow: ellipsis` remains on `label` / `*-label` selectors.
- `npm run build` green.
