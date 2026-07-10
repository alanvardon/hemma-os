# Plan 66 — Skip-link renders visibly mid-page (broken position:fixed)

**Status:** resolved, no code change needed (verified 2026-07-10) · **Owner model:** Sonnet-suitable (one containing-block
bug; repro + likely cause given) · **Source:** homepage design review
2026-07-07 · **Touches:** `home.css` (.skip-link), possibly where the link
sits in `Home.tsx:411`.

## Finding

The a11y skip-link ("SKIP TO TOOLS") is supposed to be parked off-screen —
`.skip-link { position: fixed; top: 0.9rem; transform: translateY(-150%) }`
(home.css:83-100) — and only slide in on `:focus-visible`. In reality it
renders **fully visible in the page flow**: on mobile it sits inline above
the tools grid; at desktop it showed up floating at the left edge mid-page.
Unfocused, both themes.

Almost-certain cause: an ancestor with a `transform`/`filter`/`will-change`
(the `.hub-pan` overscan wrapper from plan 26, and/or the plan-28b scroll
dolly) becomes the containing block, so `fixed` degrades to
ancestor-relative and `translateY(-150%)` of a 30 px chip only lifts it
45 px — it lands wherever the ancestor is.

## Fix

- Move the skip-link OUTSIDE every transformed wrapper — first child of the
  route root (it's the first tabbable element anyway, which is also better
  a11y ordering), or hide it with the standard visually-hidden pattern
  (clip + 1px box) instead of a transform offset, which is immune to
  containing-block games:
  `position: absolute; width/height: 1px; clip-path: inset(50%);` →
  un-clip on `:focus-visible`.
- Verify with keyboard: Tab once on load → chip slides in at the true
  viewport top-left; Escape/Tab away → gone. And verify it is NOT visible
  on load at 1440 and 390, both themes, scrolled and unscrolled.

## Acceptance criteria

- Skip-link invisible on load at all viewports/themes/scroll positions
  (Playwright screenshot assert).
- Tab reveals it at viewport top-left; Enter jumps to #tools.
- No other fixed-position element inside the hub suffers the same
  containing-block issue (quick audit of `position: fixed` in home.css).

## Resolution

Re-verified against current `main` (Home.tsx:407-413) with Playwright at
1440×900 and 390×844, scrolled and unscrolled: the skip-link already sits
as a sibling of `.hub-pan` (not a descendant), per the containing-block
comment now at `Home.tsx:407-412` — apparently landed as a side effect of
fixing the same issue for `.site-header`. Measured `getBoundingClientRect()`
confirms it sits off-screen (`top: -36px`) with no transformed ancestor.
Tab reveals it at the true viewport top-left; Enter navigates to `#tools`.
Audited the other two `position: fixed` rules in home.css — `.orbs`
(intentionally inside `.hub-pan`, panning by design per plan 26) and
`body::after` (grain overlay, not inside any transformed wrapper) — neither
has the bug. No code change required.
