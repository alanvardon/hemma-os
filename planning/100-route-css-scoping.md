# Plan 100 — Remove route CSS leakage and import-order coupling

**Status:** proposed · **Priority:** Low · **Effort:** M · **Owner model:**
GPT-5.6 Terra — owns the mechanical selector scoping, static audit, and browser
regression pass

## Goal

Every tool-owned selector is scoped under its route root. `main.tsx` import order
must not be required to keep one route from restyling another.

## Confirmed leakage

- `web/src/styles/konsultkalkyl.css:61-74` defines generic `.field-grid` and
  `.field` rules without a route root.
- `web/src/styles/hushallsbudget.css:909-916` contains mobile `.field` rules that
  escape `.hb-root` nesting.
- `web/src/main.tsx:17-21` explicitly depends on Hushållsbudget and touch styles
  loading last.
- `components.css` intentionally owns shared generic selectors; route sheets
  also redefine some of them.

## Decisions locked

1. Add/use a stable root for each route (`.ko-root`, `.lv-root`, `.bk-root`,
   `.ma-root`, `.hb-root`, and explicit Bostadskalkyl roots).
2. Route-specific selectors must be descendants of that root. Shared selectors
   belong only in shared stylesheets.
3. Global `html`, `body`, element, and generic class selectors in route sheets
   require an inline justification and the narrowest possible `:has()`/root
   condition.
4. Keep the coarse-pointer 16 px input rule app-wide; it is an intentional
   accessibility baseline, not leakage.
5. This is visual parity work. Do not redesign fields or introduce CSS Modules,
   Tailwind, or a component library.

## Implementation

- Scope Konsultkalkyl first, then audit every route stylesheet mechanically.
- Move genuinely shared rules to `components.css`; keep route overrides local.
- Remove “imported last” dependencies and prove stylesheet order no longer
  changes computed route styling.
- Extend static checks with a route-CSS selector audit. Fix the existing skill
  documentation path from `.Codex/...` to
  `.agents/skills/static-checks/static-checks.sh` in the same documentation-only
  portion of this plan.

## Tests and visual verification

- Static selector check rejects bare `html/body/input` and generic `.field`,
  `.card`, `.layout`, etc. in route sheets unless allow-listed with rationale.
- Snapshot computed styles for representative shared fields if the existing
  harness supports it; do not add a test dependency without approval.
- Verify every changed route at 390×844 and desktop, both themes; add 320 px and
  coarse-pointer checks for field changes.

## Acceptance criteria

- Reordering route stylesheet imports does not change another route's computed
  styles.
- No unintended horizontal overflow or iOS focus zoom regression.
- Static checks, lint, tests, and build pass.
