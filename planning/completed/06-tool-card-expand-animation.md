# #1 — Tool card "expands into the page" animation

## Decisions locked

- **Feel:** the clicked card **grows/morphs to fill the screen and becomes the
  tool page**; pressing back shrinks it back into its grid slot. Reversible.
- **Scope:** **Bostadskalkyl card first** as a proof-of-concept (pairs with the
  new scenarios dashboard, #3). Roll out to the other 5 tools later if it feels
  right. "Soon" cards stay static.

## Approach — native View Transitions API (confirmed via Context7)

The stack is React 19.2 + **react-router-dom 7.18** + Motion 12. React Router v7
has first-class view-transition support that is a perfect fit and far simpler than
trying to run a Motion `layoutId` morph across a route unmount:

- `<Link to="/bostadskalkyl" viewTransition>` **automatically wraps the
  navigation update in `document.startViewTransition()`** (RR v7 docs). Works with
  `HashRouter` — it wraps the navigation regardless of router type.
- `useViewTransitionState(to)` returns `true` while a transition to/from `to` is
  active — use it to assign a **shared `view-transition-name`** only during the
  transition (names must be unique among mounted elements at any instant).
- The browser morphs the element with a given `view-transition-name` on the
  **old** page into the element with the **same name** on the **new** page —
  i.e. the card's box grows into the destination container. Back reverses it for
  free. This mirrors RR's documented "image list → image detail expand" recipe.

### Implementation

**[Home.tsx](../web/src/routes/Home.tsx)** — Bostadskalkyl `<Link>` ([:107](../web/src/routes/Home.tsx#L107)):

```tsx
const isBkTransition = useViewTransitionState('/bostadskalkyl')
<Link
  to="/bostadskalkyl"
  viewTransition
  className="app-card reveal reveal-4"
  style={isBkTransition ? { viewTransitionName: 'bk-card' } : undefined}
  …
>
```

**Destination** — the scenarios dashboard root (#3) (or, until #3 lands, the
calculator shell) gets the **matching** name, also gated so it only claims `bk-card`
on the relevant route:

```tsx
const isBkTransition = useViewTransitionState('/bostadskalkyl')
<div style={isBkTransition ? { viewTransitionName: 'bk-card' } : undefined} …>
```

**CSS** (new `web/src/styles/transitions.css`, imported once) — tune the morph to
the Nordic-editorial feel and add `contain: layout` on the destination container
to keep the morph clean:

```css
::view-transition-group(bk-card) { animation-duration: 360ms; animation-timing-function: cubic-bezier(.2,.7,.2,1); }
.bk-page-root { contain: layout; }
```

## Reduced motion / fallback

- `@media (prefers-reduced-motion: reduce) { ::view-transition-group(*) { animation: none; } }`
  → effectively instant for motion-sensitive users.
- Browsers without the View Transitions API (older Firefox) **navigate normally** —
  RR guards the call, so it's a graceful no-op, no JS errors.

## Edge cases

- **Unique-name rule:** never have two mounted elements claim `bk-card`
  simultaneously → that's why the name is gated behind `useViewTransitionState`
  on both ends (only present mid-transition).
- **Destination = the #3 dashboard.** This animation should land on the scenarios
  dashboard, so it depends on #3. If built before #3, point it at the current
  calculator and re-target after #3 ships.
- **Layout shift** on the destination can make the morph look off — `contain:
  layout` on the destination root + a stable header height helps.

## Testing

- Mostly manual / Playwright (navigate, observe the grow + the reverse on back).
- Best-effort unit check: the Link carries `viewTransition` and `bk-card` appears
  on the card while `useViewTransitionState` is true.

## Rejected alternative

Motion `layoutId` shared-layout across the route boundary — the source card
unmounts on navigation, so it'd need a portal-cloned overlay that animates then
navigates. The native View Transitions API does this for free; keep Motion for the
in-page morphs (charts, dialogs).

## Effort

**Small–Medium** — two hooks + a little CSS; the browser does the heavy lifting.
Pairs with / follows #3.
