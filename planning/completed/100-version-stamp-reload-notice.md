# Plan 100 — Build stamp + "Ny version finns" reload notice

**Status:** plan · **Owner model:** single-model, small scope · **Source:**
2026-07-13 prod incident during the Bolånekoll forecast fixes (PRs #295–#298):
an SPA tab/app instance kept running a bundle from between two same-morning
deploys for hours. Hash routing never refetches code, GitHub Pages caches
`index.html` for 10 minutes, and nothing in the UI reveals which build is
running — so "prod is still wrong" took three diagnosis rounds to attribute to
a stale client. · **Touches:** `web/vite.config.ts` (emit
`bk-assets/version.json`), `.github/workflows/deploy.yml` (pass the commit SHA
into the build env), `web/src/lib/version.ts` (**new**, pure),
`web/src/lib/version.test.ts` (**new**), `web/src/components/UpdateNotice.tsx`
(**new**), `web/src/components/UpdateNotice.test.tsx` (**new**),
`web/src/App.tsx` (mount), `web/src/routes/Home.tsx` (footer stamp),
`web/src/styles/modals.css` (notice styles).

## Goal

Two affordances so a deployed fix can never silently lag behind an open app
instance again:

1. **A visible build stamp** — the short commit SHA in the hub footer, so
   "which version am I running?" is a 5-second check on any device, without
   DevTools or a fresh login.
2. **An update notice** — the running app periodically compares its own
   embedded SHA against the deployed one and, on mismatch, shows a small
   non-blocking notice: *"En ny version av Hemma·OS finns."* with a
   **Ladda om** button (plain `location.reload()` — an explicit reload
   revalidates `index.html`, which then references the new hashed assets).

## Decisions locked

- **Version identity = commit SHA**, injected as `VITE_BUILD_SHA` by the deploy
  workflow (`${{ github.sha }}`). Local/dev builds have no SHA → the checker is
  **disabled in dev** and in local prod builds; the footer shows no stamp. No
  behavioural change for tests or the e2e preview.
- **Deployed version discovery = `bk-assets/version.json`**, emitted by a tiny
  Vite plugin at build time (`{ "sha": …, "builtAt": … }`). It lives under
  `bk-assets/` so the existing deploy assembly step copies it without changes.
  Same-origin fetch — already allowed by the CSP (`connect-src 'self'`).
- **Check cadence:** on app start, on `visibilitychange` → visible (the
  overnight-tab case), and every 15 minutes — throttled to at most one fetch
  per minute, `cache: 'no-store'` so the browser cache can't answer. GitHub
  Pages' CDN may still serve `version.json` up to 10 minutes stale — accepted;
  the notice may simply arrive a few minutes after a deploy.
- **Never auto-reload.** The user may be mid-edit in a dialog; reload is always
  an explicit tap. The notice is dismissible (✕) and stays dismissed for that
  SHA; a *newer* deploy shows it again.
- **Failure behaviour:** fetch error, non-OK, or malformed JSON → treated as
  "no information", never as "update available". No retry storm (the cadence is
  the retry).

## Non-goals

- No service worker / precache — the app deliberately has none.
- No forced migration of running state; reload is user-initiated.
- No version semantics (semver): equality check on SHA only.

## Tests

- `version.test.ts` (node): `parseVersionJson` accepts the emitted shape,
  rejects malformed/missing/wrong-typed payloads; `isUpdateAvailable` is false
  for missing current SHA (dev), missing deployed info, equal SHAs; true only
  for a differing non-empty pair.
- `UpdateNotice.test.tsx` (jsdom): mocked fetch — differing SHA renders the
  notice with the Ladda om button; equal SHA and failing fetch render nothing;
  clicking Ladda om triggers the reload helper; dismissing hides it.

## Verify

`npm run lint` · `npm run test` · `npm run build` from `web/`, plus a browser
check on the local dev server that the notice renders correctly at 390×844 and
desktop when the check is forced (dev stub), and that production builds emit
`bk-assets/version.json` containing the SHA (`VITE_BUILD_SHA=test npm run
build` + inspect `dist/`).
