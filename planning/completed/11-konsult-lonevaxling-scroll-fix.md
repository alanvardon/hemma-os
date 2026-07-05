# Plan 11 — Fix Konsultkalkyl & Löneväxling scroll (desktop + mobile) (Hemma `web/`)

**Status:** bug — root-caused · **Owner model:** Sonnet-suitable (small CSS fix,
careful verify on a touch device) · **Relationship:** standalone CSS. No JS/logic
change.

## The bug

**Konsultkalkyl** and **Löneväxling** don't scroll — **on desktop *and* mobile**.
Content past the first viewport is unreachable. (Bostadskalkyl uses the same
`calc-layout` idiom and works on desktop — so this is not the lock itself, it's a
**severed flex/height chain** in these two tools.)

### Root cause (traced)

The three calc tools lock the viewport — `html.calc-layout, html.calc-layout body
{ height:100%; overflow:hidden }` (`global.css:12`) — and rely on **internal
column scroll** (`overflow-y:auto; height:100%`). For a `height:100%` column to
scroll, every ancestor up to `#root` must have a bounded height.

- **Bostadskalkyl (works):** route returns a **fragment `<>`**, so
  `<main className="layout">` (`flex:1; min-height:0`) is a **direct child of
  `#root`** — which is `display:flex; flex-direction:column` + `height:100%`
  (`global.css:30-36`). Chain intact → columns scroll.
- **Konsult / Löneväxling (broken):** both wrap their content in a
  `.kk-root` / `.lv-root` div (added to carry the `vt-page` transition class:
  `Konsultkalkyl.tsx:134`, `Lonevaxling.tsx:191`). **Those wrappers have zero
  CSS** — plain blocks. So `.konsult-layout { flex:1; min-height:0 }` (used by
  both tools — `konsultkalkyl.css:18`, `Lonevaxling.tsx:216`) is a flex item of a
  **non-flex** parent → `flex:1` is ignored, the columns' `height:100%` resolves
  against auto height, no scroll container forms, and the `overflow:hidden`
  viewport lock **clips** the overflow. → nothing scrolls.

There is **also** a latent mobile issue shared by *all* calc tools: at ≤900px the
columns switch to `overflow-y:visible` expecting the **page** to scroll, but
nothing releases `html.calc-layout {overflow:hidden}` on small screens — so even
after the desktop fix, mobile content is still clipped.

## The fix (two parts)

### Part 1 — restore the flex/height chain (desktop)
Give the transition wrappers the flex-column-fill the fragment gave Bostadskalkyl:

```css
/* in global.css or each tool's css */
.kk-root, .lv-root {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
```

Keep the wrappers (the `vt-page` class lives on them). This alone restores
**desktop** internal-column scroll for both tools.

### Part 2 — release the viewport lock on mobile (global)
Add one global media query so calc-layout pages **page-scroll** on small screens
(the natural touch idiom; momentum scroll, no trapped content):

```css
@media (max-width: 900px) {
  html.calc-layout, html.calc-layout body { height: auto; overflow: visible; }
  html.calc-layout #root { height: auto; min-height: 100svh; }
}
```

This is global on purpose (Decision: scope **a**): it also fixes Bostadskalkyl's
latent mobile scroll (works on desktop today; same lock would strand its mobile
content). Each tool's existing ≤900px collapse already sets the columns to
`overflow-y:visible; height:auto`, so content flows into the now-scrollable page.
Löneväxling reuses `.konsult-layout`, so it inherits that collapse for free — only
its **root** (`.lv-root`) was missing, fixed by Part 1.

### Decisions locked
1. **Scope = all three calc tools** for the mobile rule (global), desktop fix
   scoped to the two broken wrappers (`.kk-root`/`.lv-root`).
2. **Mobile UX = page-scroll** (release the lock), not internal root-scroll — it's
   the natural touch behaviour.
3. Keep the `.kk-root`/`.lv-root` wrappers (needed for `vt-page`); fix them rather
   than refactor the routes to fragments (would disturb the transition wiring).

## Verify
- **Desktop:** Konsult + Löneväxling scroll to the bottom of both columns (long
  ledger / long input rail). Bostadskalkyl unchanged.
- **Mobile / touch (real device or DevTools touch emulation):** all three calc
  tools page-scroll smoothly top-to-bottom; sticky headers behave; the bottom
  action bar / safe-area padding still clears content.
- Whoosh transitions in/out still work (wrappers + `vt-page` intact).
- `npm run build` / `oxlint` / `vitest` green.

## Out of scope
- Any redesign of the mobile layouts (this restores scroll; it doesn't re-style).
- Touch-event/gesture work — the only interactive widget is a native
  `<input type=range>`, which already works on touch.

## Definition of done
- Konsultkalkyl + Löneväxling scroll on desktop and mobile; Bostadskalkyl's
  latent mobile scroll also fixed; transitions intact; checks green.
