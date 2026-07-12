# Plan 90 — Branded error & offline pages (crash boundary, offline banner, friendlier inline errors, PWA offline fallback)

**Status:** plan · **Owner model:** split — **Opus for the service-worker layer
(Layer 4)**: it interacts with the strict prod CSP, the `base: './'` +
hash-router scoping, and cache-invalidation-on-deploy, all of which are
"break the deployed app if wrong" territory; **Sonnet can build Layers 1–3**
(ErrorBoundary component, offline banner hook, swapping `alert()` for toasts)
once the visual spec below is followed. · **Source:** user report 2026-07-12 —
"experienced an error page for the first time when my internet went down, the
page didn't look good." · **Sequencing:** standalone; nothing blocks it and it
blocks nothing. Layers 1–3 can ship as one PR; **Layer 4 (service worker) is a
separate PR** so its caching behavior can be verified in isolation before it
touches the deployed site. · **Touches:** `web/src/App.tsx` (wire
`errorElement`), `web/src/components/ErrorBoundary.tsx` (**new**),
`web/src/components/OfflineBanner.tsx` (**new**), `web/src/lib/useOnline.ts`
(**new**), `web/src/routes/Hushallsbudget.tsx` (2 `alert()` → toast),
`web/src/styles/error.css` (**new**), `web/src/main.tsx` (import error.css;
Layer 4: register SW), `web/vite.config.ts` (Layer 4: `vite-plugin-pwa` +
its CSP hash), `web/package.json` (Layer 4: add `vite-plugin-pwa`).

## Finding

When the network drops, the app has **no branded failure surface**. Three
separate gaps produce three different bad experiences:

1. **In-app crash → React Router's default error page.** The router in
   [App.tsx:40-59](../web/src/App.tsx#L40-L59) is a data router
   (`createHashRouter`) with **no `errorElement` anywhere**. Any error thrown
   during render of any route bubbles to React Router v7's built-in fallback:
   an unstyled white page reading *"Unexpected Application Error!"* with a raw
   stack trace. This is almost certainly the "page that didn't look good" the
   user saw — a transient render throw (e.g. reading a store shape that was
   mid-hydration when a fetch rejected) lands here with zero branding and no
   way back other than the browser's own reload.

2. **No offline signal while the app is loaded.** Nothing in the app reads
   `navigator.onLine` or listens for `online`/`offline` events. The stores
   swallow offline writes into the localStorage cache silently
   ([storage.ts:131](../web/src/lib/storage.ts#L131) `catch { /* offline — cache
   holds the latest */ }` and siblings), so the user gets **no indication**
   their edits aren't reaching the cloud. The one place failure surfaces is
   crude: [Hushallsbudget.tsx:221](../web/src/routes/Hushallsbudget.tsx#L221)
   and [:331](../web/src/routes/Hushallsbudget.tsx#L331) fire a native
   `alert('Couldn't save — you may be offline. …')`; Månadsavslut uses a toast
   ([Manadsavslut.tsx:179](../web/src/routes/Manadsavslut.tsx#L179)). Two
   different affordances for the same condition, one of them a jarring OS
   dialog.

3. **Full reload while offline → the browser's own error page.** There is **no
   service worker** (`ls web/public` is empty; no `vite-plugin-pwa`, no
   `registerSW`). GitHub Pages serves a plain SPA, so reloading or cold-opening
   the app with no network can't fetch `index.html`/the JS bundle and the user
   gets Chrome's *"No internet"* dinosaur — completely unbranded. This is the
   only layer that fixes the literal reload-while-offline case, and it's the
   one the user's report points at most directly.

**Already handled, do not touch:** the 3D hero already degrades gracefully — a
render/creation error in the lazy `HeroScene` is caught by the class boundary
in [HeroCanvas.tsx:41](../web/src/components/HeroCanvas.tsx#L41) and falls back
to the 2D canvas. That boundary stays as-is; the new app-level boundary sits
*above* it.

## Fix

Four layers, cheapest first. Layers 1–3 = one PR; Layer 4 = a second PR.

### Layer 1 — App-level ErrorBoundary as the router `errorElement`

New `web/src/components/ErrorBoundary.tsx`. It is **rendered by React Router as
`errorElement`**, so it uses `useRouteError()` (a functional component is fine —
React Router catches the error for us; we don't need a class here). It must:

- Detect the offline case and lead with it, because a dropped network is the
  most likely trigger: if `!navigator.onLine`, headline *"Du är offline"* with
  copy *"Hemma·OS når inte molnet just nu. Dina ändringar sparas lokalt och
  synkas när du är tillbaka online."* Otherwise a generic *"Något gick fel"*.
- Offer **two actions**: a primary **"Försök igen"** button
  (`onClick={() => window.location.reload()}`) and a ghost **"Till startsidan"**
  link (`href={import.meta.env.BASE_URL + '#/'}` then reload — resetting the
  hash route clears a route-local bad state).
- In DEV only (`import.meta.env.DEV`), render the error message/stack in a
  `<details>` so developers still see it; PROD hides it.
- Be themed by reusing existing tokens (see CSS below) — it renders inside
  `ThemeContext` because the router is mounted under it in
  [App.tsx:72-76](../web/src/App.tsx#L72-L76).

```tsx
// web/src/components/ErrorBoundary.tsx
import { useRouteError, isRouteErrorResponse } from 'react-router-dom'

export default function ErrorBoundary() {
  const error = useRouteError()
  const offline = typeof navigator !== 'undefined' && !navigator.onLine
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error)

  return (
    <main className="errpage" role="alert">
      <div className="errpage-card">
        <p className="errpage-kicker">Hemma·OS</p>
        <h1 className="errpage-title">
          {offline ? 'Du är offline' : 'Något gick fel'}
        </h1>
        <p className="errpage-lead">
          {offline
            ? 'Hemma·OS når inte molnet just nu. Dina ändringar sparas lokalt och synkas när du är tillbaka online.'
            : 'Ett oväntat fel uppstod. Ladda om sidan — dina sparade data finns kvar.'}
        </p>
        <div className="errpage-actions">
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Försök igen
          </button>
          <a
            className="btn btn-ghost"
            href={import.meta.env.BASE_URL + '#/'}
            onClick={() => setTimeout(() => window.location.reload(), 0)}
          >
            Till startsidan
          </a>
        </div>
        {import.meta.env.DEV && (
          <details className="errpage-detail">
            <summary>Felinformation (dev)</summary>
            <pre>{detail}</pre>
          </details>
        )}
      </div>
    </main>
  )
}
```

Wire it in [App.tsx:40-59](../web/src/App.tsx#L40-L59). Put `errorElement` on the
**layout route** so a throw in any child renders inside it, and *also* keep the
existing `path: '*'` redirect (that handles unknown hashes, not errors — the two
don't overlap):

```tsx
import ErrorBoundary from './components/ErrorBoundary'
// ...
const router = createHashRouter([
  {
    element: <Layout />,
    errorElement: <ErrorBoundary />,   // ← added
    children: [ /* unchanged */ ],
  },
])
```

### Layer 2 — Global offline banner

New `web/src/lib/useOnline.ts` — a tiny hook subscribing to the browser events
(defaults to `true` on the server / first paint to avoid a false "offline"
flash):

```ts
import { useSyncExternalStore } from 'react'
const sub = (cb: () => void) => {
  window.addEventListener('online', cb)
  window.addEventListener('offline', cb)
  return () => {
    window.removeEventListener('online', cb)
    window.removeEventListener('offline', cb)
  }
}
export const useOnline = () =>
  useSyncExternalStore(sub, () => navigator.onLine, () => true)
```

New `web/src/components/OfflineBanner.tsx` — a slim fixed bar at the top that
mounts only when offline, so it costs nothing online:

```tsx
import { useOnline } from '../lib/useOnline'
export default function OfflineBanner() {
  const online = useOnline()
  if (online) return null
  return (
    <div className="offline-banner" role="status">
      Offline — ändringar sparas lokalt och synkas när du är online igen.
    </div>
  )
}
```

Mount it once in `Layout()` in [App.tsx:13-20](../web/src/App.tsx#L13-L20), above
`<Outlet />`, so it shows on every route. It renders inside `AuthGate`'s
children, so it never covers the login screen (correct — an offline user can't
sign in anyway).

### Layer 3 — Unify inline save/delete failure messaging

Replace the two native `alert()` calls in Hushållsbudget with the shared toast
so the whole app reports write failures the same way Månadsavslut already does.
Hushållsbudget doesn't currently use `useToast`; add it (pattern:
[Manadsavslut.tsx:179](../web/src/routes/Manadsavslut.tsx#L179) — `const { toast,
showToast } = useToast()`, render an `.hb-toast` element, call `showToast(...)`
in the catch). Change [Hushallsbudget.tsx:221](../web/src/routes/Hushallsbudget.tsx#L221)
and [:331](../web/src/routes/Hushallsbudget.tsx#L331) from `alert(…)` to
`showToast('Kunde inte spara — du kanske är offline.')` /
`showToast('Kunde inte ta bort — du kanske är offline.')`. **No store logic
changes** — this is purely the surfacing.

### Layer 4 — PWA offline fallback (separate PR)

Add `vite-plugin-pwa` (workbox under the hood) so the app shell + assets are
precached and a reload-while-offline serves the app instead of Chrome's error
page. **Three project-specific gotchas make this Opus-owned, not a copy-paste
of the plugin's README:**

1. **Strict prod CSP.** [vite.config.ts](../web/vite.config.ts) injects a meta
   CSP where prod `script-src` is `'self' 'sha256-<theme-script-hash>'` — inline
   scripts not in the allowlist are blocked. `vite-plugin-pwa`'s default
   `injectRegister: 'auto'` emits an **inline** registration script that the
   prod CSP will silently block, so the SW never registers. Use
   `injectRegister: 'script'` (an external `registerSW.js`, allowed by
   `'self'`) **or** compute and add its sha256 to the `script-src` list the same
   way `cspMeta` already hashes the theme snippet. Prefer `injectRegister:
   'script'` — no new hash to keep in sync. Verify in a **prod build** (`npm run
   build && npm run preview`) that the SW actually registers (DevTools →
   Application → Service Workers) — dev's looser CSP will hide a prod-only
   block.
2. **`base: './'` + hash router.** The build uses relative base so it can be
   served at the domain root *or* a subpath. Workbox needs to know the real
   scope at runtime. Register with `{ scope: import.meta.env.BASE_URL }` and set
   the plugin's `scope`/`base` to match `BASE_URL`, and set the offline
   **navigation fallback** to `${BASE_URL}index.html`. Because routing is
   hash-based, every route is the *same* document — precaching `index.html` +
   the hashed bundle is enough; there are no per-route HTML files to miss.
3. **connect-src stays Supabase-only.** Do **not** let workbox runtime-cache
   Supabase API responses — the stores already own the cache/offline story
   (localStorage, last-write-wins). Configure workbox to precache the **app
   shell only** (`globPatterns` for the built JS/CSS/fonts/media) and leave
   `connect-src` and all `supabase.co` requests network-only. The SW's job here
   is strictly "serve the shell offline," not "cache data."

Suggested config sketch (tune globs to the real `bk-assets/` output):

```ts
// vite.config.ts — add to plugins
VitePWA({
  registerType: 'autoUpdate',
  injectRegister: 'script',
  base: '/',                 // resolved against the deploy path; see gotcha 2
  workbox: {
    globPatterns: ['**/*.{js,css,html,woff2,avif,jpg,mp4}'],
    navigateFallback: 'index.html',
    navigateFallbackDenylist: [/supabase\.co/],
    runtimeCaching: [],      // deliberately empty — no data caching
  },
})
```

Also register in `main.tsx` (or let `injectRegister: 'script'` do it) and
confirm the generated `sw.js` / `workbox-*.js` are served from the correct base.

## Accepted trade-off

The service worker introduces **update-on-deploy** behavior: `registerType:
'autoUpdate'` swaps to the new bundle on the next load after a deploy, meaning a
user mid-session may run stale JS until they reload. This is acceptable for a
private household tool (no strangers, deploys are infrequent), and `autoUpdate`
avoids nagging the user with an "update available" prompt. **Document this in a
comment** next to the `VitePWA` config so a future reviewer knows the staleness
window is a deliberate choice, not an oversight.

## Acceptance criteria

- **Layer 1:** With DevTools "Offline" on, force a route render throw (or visit a
  URL that triggers one) → the branded `.errpage` renders with the *"Du är
  offline"* headline and both buttons, **not** React Router's white
  "Unexpected Application Error" page. "Försök igen" reloads; "Till startsidan"
  returns to `#/`. Online, the same boundary shows *"Något gick fel"*. Check
  both light and dark themes.
- **Layer 2:** Toggle DevTools Offline → the `.offline-banner` appears on every
  route within a frame and disappears on reconnect (driven by `online`/`offline`
  events, verified without a reload). It never overlaps the login card.
- **Layer 3:** Offline, editing a Hushållsbudget row that triggers a save/delete
  failure shows the **toast**, not a native `alert()`. Grep confirms no
  `alert(` remains in `src/routes/` for the offline case.
- **Layer 4 (separate PR):** In a **production** build (`npm run build && npm run
  preview`), the SW registers (DevTools → Application → Service Workers shows it
  active) with **no CSP violation** in the console. Load once online, go offline,
  **reload** → the branded app shell loads (Home renders) instead of the
  browser's error page. Confirm Supabase requests are still network-only (no
  workbox cache entry for `*.supabase.co`).
- **New unit tests:** `web/src/lib/useOnline.test.ts` (jsdom) asserting the hook
  flips on dispatched `online`/`offline` events; a component test for
  `OfflineBanner` asserting it renders nothing when online and the banner text
  when offline (harness: plan 78's jsdom pattern). `ErrorBoundary` gets a jsdom
  test rendering it via a `createMemoryRouter` with a throwing route, asserting
  the offline vs. generic headline branches on `navigator.onLine`.
- **Verify gates (in `web/`):** `npm run build` green (the real typecheck),
  `npm test` green, `npm run lint` clean.

## Out of scope

- **Caching Supabase data for read-offline** — the stores already own offline
  reads via localStorage; duplicating that in workbox would create two sources
  of truth. Deliberately excluded (see Layer 4 gotcha 3).
- **A full install prompt / "Add to home screen" PWA experience** — this plan
  adds a service worker only for the offline shell, not app-install UX. Natural
  later extension if wanted.
- **Retrying queued writes automatically on reconnect** — the banner tells the
  user to expect sync-on-reconnect, and the stores already re-upsert on the next
  successful write, but an explicit outbox/flush-on-`online` queue is a separate,
  larger piece of work. Not asked for.
- **Error reporting/telemetry** (Sentry etc.) — the DEV-only `<details>` covers
  local debugging; wiring a remote error sink is a different concern.
