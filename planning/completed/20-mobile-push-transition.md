# Plan 20 — Replace the dolly-zoom with a horizontal push on mobile (Hemma `web/`)

**Status:** feature/fix — designed · **Owner model:** Sonnet-suitable (CSS
keyframes + one JS guard; careful verify on a real phone) · **Relationship:**
`styles/transitions.css`, `routes/Home.tsx`, references the breakpoint in
`styles/home.css`. Modifies what Plans 08/09 built (the dolly-zoom) **only at
≤600px**; desktop is untouched. **Req:** _More Plans_ — "The dolly zoom
transition effect should not happen on mobile as it looks strange; it should be a
very subtle and simple transition."

## The problem (root-caused)

On mobile the hub collapses to a **single full-width column**
(`@media (max-width: 600px) { .app-grid { grid-template-columns: 1fr } }` —
[home.css:396-397](../web/src/styles/home.css#L396-L397)). The dolly-zoom is built
to grow a **small grid tile** into a page: it pans the tapped card to screen
centre then zooms "into" it. With one full-width card there is **nothing to pan
to** and no tile to zoom from, so the effect reads as useless/strange. A plain
fade would be calm but wouldn't communicate navigation at all.

The dolly is **three** coordinated pieces, all of which must change at ≤600px:
1. **JS camera-pan** — WAAPI pans the card to centre + `scale(1.04)` over 760ms
   before the whoosh ([Home.tsx:55-63](../web/src/routes/Home.tsx#L55-L63)).
2. **CSS shared-element morph** — `tool-card` box morph + `vt-dive` (hub scales
   `1→1.25` + fades) + corner-rounding keyframes ([transitions.css](../web/src/styles/transitions.css)).
3. **`data-vt-dir`** forward/back tag ([viewTransition.ts:42](../web/src/lib/viewTransition.ts#L42)).

## The fix — horizontal push at ≤600px

A single-column list drilling into a detail page wants the **iOS push** idiom:

- **Forward:** the tool page **slides in from the right**, covering the hub; the
  hub does a **subtle ~25% parallax** in the slide direction and **dims** (depth:
  page-on-top-of-hub, not two flat slides).
- **Back:** the page **slides off to the right**, the hub slides back from its
  parallax offset. ~**300ms**, ease-out.

It's directional (reads as deeper → / ← back), familiar, and reuses the existing
`data-vt-dir` tag to pick the direction. Desktop/tablet (>600px) keep the dolly.

### JS — skip the camera-pan on mobile
Mirror the existing `prefersReducedMotion()` early-out at
[Home.tsx:51](../web/src/routes/Home.tsx#L51):
```ts
const isMobilePush = () =>
  typeof window !== 'undefined' && window.matchMedia('(max-width: 600px)').matches

// in onToolCardClick, before the pan:
if (prefersReducedMotion() || isMobilePush() || !pan) { startWhoosh(path); return }
```
`markVtTransition` still sets/clears `data-vt-dir` and the `.finished` patch still
runs ([viewTransition.ts](../web/src/lib/viewTransition.ts)) — only the pan is
skipped.

### CSS — drop the morph, add the slide (scoped to ≤600px)
```css
@media (max-width: 600px) {
  /* no shared-element zoom on a single-column hub */
  .vt-card, .vt-page { view-transition-name: none; }

  /* page (root new) pushes in over the hub (root old) */
  html[data-vt-dir='forward']::view-transition-new(root) { animation: push-in-right 300ms ease-out both; }
  html[data-vt-dir='forward']::view-transition-old(root) { animation: parallax-out-left 300ms ease-out both; }
  html[data-vt-dir='back']::view-transition-new(root)    { animation: parallax-in-left 300ms ease-out both; }
  html[data-vt-dir='back']::view-transition-old(root)    { animation: push-out-right 300ms ease-out both; }
}
@keyframes push-in-right   { from { transform: translateX(100%); }            to { transform: translateX(0); } }
@keyframes push-out-right  { from { transform: translateX(0); }               to { transform: translateX(100%); } }
@keyframes parallax-out-left { from { transform: translateX(0); filter: brightness(1); }
                               to   { transform: translateX(-25%); filter: brightness(0.8); } }
@keyframes parallax-in-left  { from { transform: translateX(-25%); filter: brightness(0.8); }
                               to   { transform: translateX(0); filter: brightness(1); } }
```
Dropping `view-transition-name` removes the `tool-card` group, so the existing
`::view-transition-*(tool-card)` keyframes simply don't apply at ≤600px — the
root old/new slide is all that runs. The global
`@media (prefers-reduced-motion: reduce)` rule
([transitions.css:146-152](../web/src/styles/transitions.css#L146-L152)) still
zeroes everything for motion-sensitive users.

## Decisions locked
1. **Push, not fade** — a single-column drill-down needs a transition that *means*
   navigation; a fade would be subtle but useless. Subtle = quick (300ms) + eased,
   no zoom/pan/dive.
2. **Trigger = `max-width: 600px`**, locked to the existing single-column grid
   rule, so push ⇄ dolly flips exactly when the layout collapses (incl. a narrow
   desktop window; excl. iPad portrait, which keeps ≥2 columns and the dolly).
3. **Same number both sides** — JS `matchMedia('(max-width: 600px)')` skips the
   pan; CSS `@media (max-width: 600px)` swaps the keyframes. No desync.
4. **Subtle iOS parallax** — hub drifts ~25% + dims under the sliding page (depth),
   not a static hub.
5. **Desktop/tablet (>600px) unchanged** — dolly-zoom stays exactly as Plans 08/09
   built it.

## Verify
- **Mobile (≤600px):** tapping a tool **slides the page in from the right** with a
  subtle hub parallax/dim; **‹ Hemma** slides it back off the right. **No** pan,
  **no** zoom, **no** dive. Snappy (~300ms).
- **Desktop/tablet (>600px):** dolly-zoom + camera-pan unchanged.
- **Reduced motion:** instant navigation, no animation, both widths.
- Crossing 600px (resize / rotate) cleanly switches idioms; `data-vt-dir` still
  clears after each transition (no stuck tag).
- `npm run build` / `oxlint` / `vitest` green.

## Out of scope
- The **back-lands-on-the-card** behaviour (Plan 12) is a desktop/dolly concern;
  at ≤600px the push simply reveals the hub — no card docking.
- Any redesign of the mobile hub layout itself (only the transition changes).
- A vertical container-transform alternative (considered, rejected for the push).

## Definition of done
- ≤600px uses a quick horizontal push with subtle hub parallax; >600px keeps the
  dolly; one breakpoint drives both JS and CSS; reduced-motion respected; the
  dolly "looks strange on mobile" complaint is resolved; checks green.
