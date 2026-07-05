# Plan 22 — Månadsavslut personal offsets (discount-before-split, line stays whole) (Hemma `web/`)

**Status:** feature — fully specced · **Owner model:** Sonnet-suitable, but the
**core math + data model change**: do it test-first (the split/settlement math is
the heart of the tool). · **Relationship:** `lib/manadsavslut.ts` (model + math),
`lib/manadsavslut-store.ts` (defaults/migration), `routes/Manadsavslut.tsx`
(editor + a new nested dialog + open-list marker + history breakdown),
`styles/manadsavslut.css`. **Extends Plan 18's** expanded history row. Shares
`Manadsavslut.tsx`/`Segmented` with **Plan 19**. **Build last of the batch.**
**Req:** _More Plans_ — "sometimes a transaction includes items personal to a
person which should not be shared. I want to enter an amount to discount the whole
transaction by before we split."

## The need (from grilling)

A single bank transaction sometimes mixes **shared** spend with **personal**
items belonging to one (or both) people. The user must be able to carve the
personal portion out **before the 50/50 split** — but the **line must stay whole**
(`enter_amount` = exactly one bank-statement transaction). Splitting it into
several rows (the existing workaround) is unacceptable: the rows wouldn't match
the statement on reconciliation. Both directions occur — **the payer** can have
personal items *and* **the other person** can — sometimes in the same transaction.

## The model — two amount fields keyed by person

Add to `Item` ([manadsavslut.ts:17-33](../web/src/lib/manadsavslut.ts#L17-L33)):

```ts
personal_a: number      // amount in this transaction personal to person A (default 0)
personal_b: number      // amount personal to person B            (default 0)
personal_note: string   // why — e.g. "Alex protein powder, Sam mag" (default '')
```

No `personal_owner` enum — **the field is the owner**. `enter_amount` is never
touched, so the line still equals the statement.

### The math
```
shared_base   = enter_amount − personal_a − personal_b      // the part that splits 50/50
each person's true cost = shared_base/2  +  their own personal_*
owed_by (the non-payer) owes:  round2(shared_base/2) + personal_[owed_by]
```
`owed_by = otherPerson(fronted_by)`; `personal_[owed_by]` is `personal_a` if
`owed_by === 'a'` else `personal_b`.

**Worked** — Alex (`a`) pays **800**, `personal_a` = 100, `personal_b` = 150 →
shared = 550 → **Sam owes 275 + 150 = 425**; Alex bears 275 + 100 = 375; total
800, line whole. Set either field to 0 to recover the one-sided cases (payer-only
→ Sam owes (800−p)/2; other-only → Sam owes (800−p)/2 + p).

### Where the math lives
- Replace the bare `computeOwedAmount(enter, split)` call in `makeItem`
  ([manadsavslut.ts:167](../web/src/lib/manadsavslut.ts#L167)) and in `toggleType`
  ([Manadsavslut.tsx:417](../web/src/routes/Manadsavslut.tsx#L417)) with a new
  pure helper:
  ```ts
  export function computeOwed(enter_amount, split, fronted_by, personal_a = 0, personal_b = 0): number {
    if (!split) return round2(enter_amount)                 // "owes all" → personal N/A (see Decision 3)
    const base = enter_amount - personal_a - personal_b
    const ownedByOther = otherPerson(fronted_by) === 'a' ? personal_a : personal_b
    return round2(base / 2) + round2(ownedByOther)
  }
  ```
- **`netBalance` / `buildSettlement` are unchanged** — they sum `it.amount`, which
  now already encodes the offset. No other math changes.
- `computeOwedAmount` stays (still used where there's no offset context); the new
  `computeOwed` supersedes it at the two item-construction sites.

## UI — nested "Personal offset" dialog (Split only)

In `ItemDialog`, **only when Treatment = Split**, show one row:
- **none set:** a **"+ Add personal items (not shared)"** button → opens a nested
  **Personal-offset modal** (precedent: Bolånekoll PartDialog → PeriodDialog).
- **set:** a **summary chip** — `Personal: Alex 100 · Sam 150 ✎` — click to
  re-open; the modal has a **Remove** action to clear back to 0/0/''.

The modal holds **`personal_a`**, **`personal_b`**, **`personal_note`**, a **live
preview** (`Shared {base} split · {owed_by} owes {owed}`), and **Save / Remove /
Cancel**. It only hands values back to the `ItemDialog` form state — **nothing
persists until the transaction itself is saved** (`handleSaveItem`,
[Manadsavslut.tsx:411](../web/src/routes/Manadsavslut.tsx#L411), must include the
three new fields).

```
Treatment:  [ Split 50/50 ]  [ Owes all ]
            + Add personal items (not shared)        →  opens modal
            ┌─ Personal offset ──────────────────────────┐
            │ Personal to Alex:  [ 100 ] kr               │
            │ Personal to Sam:   [ 150 ] kr               │
            │ Note: [ Alex protein powder, Sam mag ]      │
            │ → Shared 550 split · Sam owes 425           │
            │           [Remove]   [Cancel]  [Save]       │
            └─────────────────────────────────────────────┘
```

## Display

- **Open-items table** ([Manadsavslut.tsx:598-616](../web/src/routes/Manadsavslut.tsx#L598-L616)):
  keep **Charge = `enter_amount`** (matches the statement) and **Owed =
  `it.amount`** (already reflects the offset); add a subtle **`• personal`**
  marker in the **Item** cell (next to the existing `row-note`), like the
  `ask later` flag, so it's visible that the owed figure has a carve-out.
- **History (extends Plan 18)** — when an item has an offset, the expanded row
  adds the breakdown and note:
  > `Alex paid 800 kr` · **`(personal: Alex 100 · Sam 150)`** · `→ Sam owes 425 · Split`
  > _`Alex protein powder, Sam mag`_   ← `personal_note`, muted, own line

## Storage / migration / analytics
- **Defaults on read** in `manadsavslut-store.ts`: normalize every loaded item to
  `personal_a ?? 0`, `personal_b ?? 0`, `personal_note ?? ''` so pre-existing
  localStorage data and JSON backups load cleanly (no migration script needed).
- **Export/JSON backup** carries the three new fields automatically.
- **Analytics unchanged** — `spendByCategory` / `grocerySpendByMonth`
  ([manadsavslut.ts:310-337](../web/src/lib/manadsavslut.ts#L310-L337)) keep using
  gross `enter_amount` (personal items are still real spending).
- The **gross total** in history (Plan 18) is Σ `enter_amount` — also unchanged.

## Validation (stated rules, no further grilling)
- Each of `personal_a`, `personal_b` ≥ 0.
- `personal_a + personal_b ≤ enter_amount` (can't carve out more than the line) —
  **block Save in the modal with an inline error** if exceeded.
- `personal_note` optional; trimmed.

## Decisions locked
1. **Line stays whole** — `enter_amount` is never reduced; the carve-out lives in
   separate fields so each item still equals one bank transaction (reconciliation).
2. **Dual fields `personal_a` / `personal_b`** (not a single amount + owner enum)
   — handles payer-personal, other-personal, and both-in-one-transaction.
3. **Personal applies under Split only** — "Owes all" already means the other owes
   the whole line; "Ask later"/"Exclude" are out of the math. (The dual model
   under Split still covers "mostly one person's" by driving `shared_base→0`.)
4. **Dedicated `personal_note`** (separate from the transaction's general `note`)
   so the offset's reason rides with it and shows in history.
5. **Nested modal** to enter the offset (summary chip + Remove when set); values
   live in the editor's form until the transaction is saved.
6. **Editor-only** — no offset entry during CSV import triage (imported rows land
   with personal = 0; edit a row afterward to add one).
7. **Owed math = `shared_base/2 + personal_[owed_by]`**; `netBalance`/settlement
   consume `amount` and are unchanged.
8. **Display:** open list keeps Charge = `enter_amount` + a `• personal` marker;
   history shows the `(personal: …)` breakdown + muted `personal_note`.

## Verify (test-first on the math)
- **Unit (`manadsavslut.test.ts`):** `computeOwed` for — payer-only, other-only,
  both, and `enter`/`personal` rounding; `personal_a+personal_b === enter` →
  shared 0 → owed = personal_[owed_by]; `split=false` ignores personal.
- **Settlement:** an item with an offset nets correctly through `netBalance` /
  `buildSettlement` (the owed share is the only thing that changed).
- **UI:** Add a Split item → set Alex 100 / Sam 150 / note → preview shows
  "Shared 550 split · Sam owes 425"; Save; open list shows Charge 800, Owed 425,
  `• personal`; settle + reopen → history shows the breakdown + note.
- **Migration:** existing items / an old JSON backup load with personal = 0 and
  behave exactly as before.
- **Validation:** `personal_a + personal_b > enter_amount` blocks Save with an
  inline error.
- `npm run build` / `oxlint` / `vitest` green.

## Out of scope
- Per-item personal entry **during import** (Decision 6).
- Personal offsets on **"Owes all"** items (Decision 3).
- Tracking *which* personal line-items (descriptions) make up the carve-out — it's
  a single amount per person + one free-text note.

## Definition of done
- A transaction can carry a per-person personal carve-out that adjusts the split
  while the line stays equal to the bank statement; both people supported (incl.
  same transaction); editor-only via a nested modal with a note; open list marks
  it and history shows the breakdown; math is unit-tested; old data migrates
  silently; checks green.
