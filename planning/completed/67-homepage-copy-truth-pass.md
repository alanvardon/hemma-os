# Plan 67 — Homepage copy truth pass: the page still says sync is "tomorrow"

**Status:** plan · **Owner model:** Sonnet-suitable (copy swaps + one chip
removal; decisions are made in this plan) · **Source:** homepage design
review 2026-07-07 · **Touches:** `Home.tsx` copy strings + card chip,
`home.css` for the removed chip.

## Finding

The homepage undersells the product's own headline feature and decorates
every card with a meaningless badge:

1. **Stale positioning.** Hero subline: "Local-first today, synced
   everywhere tomorrow." (Home.tsx:450) and footer badge "Local-first ·
   Supabase-ready" (Home.tsx:475). Supabase sync SHIPPED across the whole
   suite (plans 16a–16h: auth, households, invites, per-tool stores). The
   marketing copy is now false in the humble direction — "ready" and
   "tomorrow" describe last month's app.
2. **`Live` chip on all six cards** (hardcoded, Home.tsx:378). When every
   card is Live, the chip is pure chrome — it existed to contrast with
   "Soon" cards that plan 29 demoted out of the grid. Six identical badges
   = zero bits of information, and it's the most-repeated element on the
   page.
3. **Wordmark inconsistency:** header renders "Hemma · OS" (spaced), footer
   and `document.title` use "Hemma·OS". Pick the tight form (it's the
   brand, cf. plan 15) everywhere.
4. Greeting row renders a decorative dash AND the greeting's own appended
   "—" ("— God morgon — tisdag 7 juli") — one dash too many; drop the
   `g + ' —'` concatenation (Home.tsx:257) and let the markup own the
   separator.

## Fix

- Subline → present tense, e.g. "The family operating system — calculators,
  plans and shared tools that grow with us. Synced across the household."
  (final wording: keep the voice, kill "tomorrow").
- Footer badge → "Local-first · Synced via Supabase" or drop the badge and
  keep the pulse dot + "Synced". (It's a status ornament, not a promise.)
- Delete the `chip-live` element and its CSS. If a card-corner element is
  wanted later, plan 30's living-bento stats already carry the "this tool
  is alive" signal — a data-freshness chip ("Uppdaterad idag") is the only
  version worth building, and that is NOT this plan.
- Normalize wordmark to "Hemma·OS" in the header.

## Acceptance criteria

- `grep -rn "tomorrow\|Supabase-ready\|chip-live" web/src` → zero hits.
- One "—" between greeting and date.
- Header/footer/title all render the identical wordmark string.
- Visual pass at 1440 + 390, both themes (card head layout must not jump
  after chip removal — the icon row keeps its height).
