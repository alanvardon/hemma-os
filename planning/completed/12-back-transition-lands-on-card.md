# Plan 12 — Back transition lands on the tool card, not page top (Hemma `web/`)

**Status:** code-review + fix · **Owner model:** Sonnet-suitable (small, surgical
— one prop + a verify pass) · **Relationship:** directly amends the just-merged
`dbad566` ("scroll incoming page to top on every view transition"). Pairs with
plan 13's hero roll-in (the numbers land as the un-zoom settles).

## The bug (codebase review)

Leaving a tool back to the hub lands you at the **top of the homepage**, not on
the card you came from. Root cause, traced:

1. Back-to-home is a **PUSH**, not a browser-back. Every tool's back-link is
   `<Link to="/" viewTransition onClick={() => markVtTransition(path,'back')}>`
   (e.g. `Konsultkalkyl.tsx:137`, `Bolanekoll.tsx:695`, … all six). PUSH to `/`
   creates a fresh history entry.
2. `dbad566` added `<ScrollRestoration />` in the `Layout` route (`App.tsx:15`).
   With no `getKey`, RR scrolls **every PUSH to y=0** — including the back-to-hub
   PUSH. So the hub always opens at the top, and the whoosh-back shrinks into a
   card that's no longer where you left it.

The forward fix from `dbad566` (reset the *incoming tool page* to top so the
hub's below-the-fold scroll doesn't bleed into the VT snapshot) is still wanted —
the fix here must **keep** that while changing only the back trip.

## The fix

Give `<ScrollRestoration>` a per-pathname key:

```tsx
<ScrollRestoration getKey={(location) => location.pathname} />
```

- **Forward** (hub at scrollY=800, card below fold → click → PUSH
  `/konsultkalkyl`): RR saves `/`→800; the tool path has no saved key → opens at
  **top**. ✓ preserves `dbad566`.
- **Back** (PUSH `/`): key `/` has saved scroll 800 → hub **restores to 800**, the
  origin card sits in its exact prior slot, and the whoosh-back (which already
  names that card via `useToolCardActive` → `view-transition-name: tool-card`)
  shrinks **into** it. ✓
- **Bostadskalkyl sub-flow** (hub → `/bostadskalkyl` dashboard → `/bostadskalkyl/:id`
  calc; calc's back-link goes to the dashboard, dashboard's to `/`): each path
  restores its own scroll for free. ✓

### Decisions locked
1. **Exact pixel restore** (un-zoom into the precise original card position), via
   `getKey=pathname` — not a looser `scrollIntoView`-the-card.
2. **Manual fallback only if needed:** if the VT snapshot is captured *before* RR
   restores (card lands a few px off), stash hub `scrollY` at forward-click time
   (module var or `sessionStorage`) and restore it synchronously in a
   `useLayoutEffect` on the hub's back-mount — reuse the existing
   `viaBack`/`data-vt-dir === 'back'` hook in `Home.tsx:26-28`. Prefer the prop;
   only add the fallback if verification shows misalignment.
3. **Deep-link / no history** (opened a tool URL directly, no saved hub scroll):
   `/` has no key → lands at **top**. Only sane behaviour; accepted.
4. **Silent landing** — no pulse/highlight on the returned-to card. The
   shrink-into-card is the cue.

## Verify (this is mostly a verification task — the change is one line)
- Forward whoosh from a **below-the-fold** card still opens the tool at top with
  no scroll bleed into the snapshot (the `dbad566` regression must not return).
- Back from each of the six tools lands with the origin card in its prior
  position and the un-zoom shrinks into it, in light + dark.
- The `/bostadskalkyl` dashboard ↔ calc sub-flow restores correctly at each hop.
- Reduced-motion / no-VT path: back still restores scroll (RR runs regardless of
  VT), just without the whoosh.
- Deep-link → "‹ Hemma" lands at top without error.
- `npm run build` / `oxlint` / `vitest` green.

## Out of scope
- Converting back-nav to a real POP (`navigate(-1)`) — fragile for deep-links and
  the dashboard intermediate hop; rejected in favour of `getKey`.
- Any change to the forward whoosh, card naming, or `viewTransition.ts` plumbing.

## Definition of done
- Returning to the hub lands on the tool card (exact prior scroll), un-zoom
  shrinks into it; forward-to-top behaviour from `dbad566` preserved; one-line
  `getKey` change (plus the documented fallback only if verification needs it).
