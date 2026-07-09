# Plan 58 — Konsultkalkyl: sticky ledger header overlaps rows mid-scroll

**Status:** plan · **Owner model:** Sonnet-suitable (one CSS bug, easy to
reproduce with the dev server) · **Source:** design review 2026-07-07 ·
**Touches:** `konsultkalkyl.css` (ledger table), possibly `Konsultkalkyl.tsx`
if the header needs a wrapper.

## Finding

Scroll the right-hand ledger column (`.ledger-col`) and the column header
row ("LINE ITEM · PER MÅNAD · PER ÅR") floats down INTO the list: at
mid-scroll it renders on top of / directly below the "Övriga kostnader" row,
with rows visibly poking out above it (screenshot: sticky header sitting a
row below the top edge of the scroll container). Looks like
`position: sticky; top: <offset>` computed against the wrong scroll parent,
or a transparent background letting rows show through while the sticky cell
hasn't reached its top yet.

## Fix

- Reproduce: dev server → /#/konsultkalkyl → scroll the ledger column
  halfway.
- Likely fixes (verify which applies): `top: 0` relative to `.ledger-col`
  (the actual `overflow-y: auto` ancestor), give the sticky row an opaque
  `background: var(--paper-card)` + `z-index` above rows, and make sure no
  intermediate wrapper between the scroll container and the `<thead>`
  creates a new containing block.
- While in there: check Lönevaxling's identical ledger for the same bug
  (shared markup pattern).

## Acceptance criteria

- rAF/scroll probe or manual pass: at every scroll offset the header is
  either pinned flush to the top of the visible ledger area or scrolled
  away — never overlapping a data row.
- Rows never render above/through the header (opaque, correct z-order).
- Both themes, desktop + 390 px.
