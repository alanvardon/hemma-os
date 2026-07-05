# Plan 19 — Fix the squashed Treatment control (segmented on desktop, dropdown on mobile) (Hemma `web/`)

**Status:** bug + small feature — root-caused · **Owner model:** Sonnet-suitable
(CSS + one prop on a shared component; verify on a phone) · **Relationship:**
touches `routes/Manadsavslut.tsx` (import triage) + the shared `Segmented`
component + `styles/manadsavslut.css`. Shares files with **Plan 22** (both edit
`Manadsavslut.tsx`); no logic overlap. **Req:** _More Plans_ — "Importera
kontoutdrag the Treatment column looks squashed since we have 4 options. Default
treatment per row is also on 2 lines when it should be on 1."

## The problem

In **Importera kontoutdrag**, two 4-option Treatment controls render cramped:

1. **Per-row Treatment cell** — a 4-chip `Segmented` (`Split · All · Ask later ·
   Skip`) lives in `.col-treat { width: 1% }` ([manadsavslut.css:124](../web/src/styles/manadsavslut.css#L124))
   inside `.segmented { … flex-wrap: wrap }` ([manadsavslut.css:99](../web/src/styles/manadsavslut.css#L99)),
   so the four chips **wrap and squash** ([Manadsavslut.tsx:550-551](../web/src/routes/Manadsavslut.tsx#L550-L551)).
2. **"Default treatment per row"** master control above the table — the same
   4-option `Segmented` ([Manadsavslut.tsx:528-529](../web/src/routes/Manadsavslut.tsx#L528-L529))
   **wraps to 2 lines** when it should sit on one.

### Root cause

`.segmented { flex-wrap: wrap }` is global, and the per-row column has no minimum
width, so four chips can't fit one line and wrap. On a phone four chips can't fit
*regardless* of `nowrap`.

## The fix (two parts)

### Part 1 — desktop (≥640px): stop the wrap, give the column width
Scope `flex-wrap: nowrap` to the two Treatment controls (a new `responsive`
variant class — see Part 2 — not the global `.segmented`, so the 2-option
Split/All toggle elsewhere is untouched) and give the per-row column a real
minimum:

```css
.segmented.segmented-responsive { flex-wrap: nowrap; }
.triage-table .col-treat { min-width: 15rem; }   /* room for 4 chips on one line */
```

This alone unsquashes desktop/tablet and keeps the master control on one line.

### Part 2 — mobile (<640px): native `<select>`
Below 640px the four chips can't fit, so **both** the per-row control **and** the
"Default treatment per row" master control render as a native `<select>`
dropdown. Implement by extending the shared `Segmented` component
([Manadsavslut.tsx:44](../web/src/routes/Manadsavslut.tsx#L44)) with an opt-in
`responsive` prop that renders **both** a `.segmented` and a paired
`<select className="seg-select">` bound to the same `onChange`, then CSS toggles
visibility at 640px:

```tsx
function Segmented<T extends string>({ value, options, onChange, small, responsive, ariaLabel }) {
  return (
    <>
      <div className={'segmented' + (small ? ' segmented-sm' : '') + (responsive ? ' segmented-responsive' : '')} role="radiogroup" aria-label={ariaLabel}>
        {/* …existing chips… */}
      </div>
      {responsive && (
        <select className="seg-select" value={value} aria-label={ariaLabel}
          onChange={e => onChange(e.target.value as T)}>
          {options.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
      )}
    </>
  )
}
```

```css
.seg-select { display: none; }
@media (max-width: 640px) {
  .segmented-responsive { display: none; }
  .seg-select { display: inline-block; width: 100%; /* native control styling */ }
}
```

Add `responsive` to the two 4-option call sites only ([Manadsavslut.tsx:528-529](../web/src/routes/Manadsavslut.tsx#L528-L529)
and [:550-551](../web/src/routes/Manadsavslut.tsx#L550-L551)). The `<select>`
options use the fuller labels (`Split 50/50`, `Owes all`, `Ask later`, `Skip`)
since a dropdown has the room.

## Decisions locked
1. **Keep the segmented** on desktop/tablet (not a redesign) — it's the app-wide
   idiom; the squash is a layout bug. Fix = `nowrap` + column `min-width`.
2. **Mobile (<640px) → native `<select>`** for **both** the per-row Treatment
   control **and** the "Default treatment per row" master control.
3. **Breakpoint = 640px** (phones get the dropdown; tablets/desktop keep chips,
   which fit once `nowrap` + `min-width` are set — at 700-900px there's room).
4. **Mechanism = render both, CSS toggle** (`display:none` per breakpoint), both
   bound to one `onChange`. No JS `matchMedia`/resize listener — can't desync.
5. **Opt-in `responsive` prop** on `Segmented`, applied to the two 4-option
   controls only — the 2-option Split/All toggles stay chips everywhere.

## Verify
- **Desktop:** both Treatment controls sit on **one line**; the per-row column is
  wide enough for all four chips; the rest of the triage table is unchanged.
- **Mobile (≤640px, real device or DevTools):** both controls are dropdowns;
  selecting an option updates the row/master exactly as the chips did; the table
  no longer overflows.
- 2-option Split/All toggles (open-items list) are unaffected on every width.
- `npm run build` / `oxlint` / `vitest` green.

## Out of scope
- Any redesign of the triage table layout beyond the Treatment column.
- Converting other segmented controls to dropdowns (deliberately opt-in).

## Definition of done
- Treatment controls read cleanly on one line on desktop and as dropdowns on
  mobile; no wrapping/squash; the 2-option toggles untouched; checks green.
