# Plan 54 — CSP meta tag + self-hosted fonts

**Status:** plan · **Severity: LOW (L3)** · **Source:** repo audit 2026-07-06 ·
**Req:** 12 of the audit batch ·
Touches `web/index.html` (+ font files under `web/src/assets/` or
`web/public/`).

## Finding

- No Content-Security-Policy anywhere. GitHub Pages can't set response
  headers, but a `<meta http-equiv="Content-Security-Policy">` works for
  everything except `frame-ancestors`/reporting. Relevant because the Supabase
  session token lives in localStorage — CSP is the cheap cap on what an
  injected script could do (exfiltration targets, inline eval).
- Fonts load from Google's CDN (index.html:17–22): a third-party runtime
  origin (availability + EU privacy noise) that also forces the CSP to be
  wider than necessary.

## Fix

**1. Self-host the two fonts** (Instrument Serif ital 0/1 + Inter wght
300–600). Download the woff2 files (google-webfonts-helper or direct), place
under `web/public/fonts/`, replace the three `<link>` tags with a small
`@font-face` block in `global.css` (`font-display: swap` to keep current
behavior). Kills the `fonts.googleapis.com`/`fonts.gstatic.com` origins.

**2. Add the CSP meta** as the FIRST element in `<head>` (before the theme
script — note that inline script requires either `'unsafe-inline'` or a hash;
prefer the hash of the exact theme-script text):

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self';
  script-src 'self' 'sha256-<hash-of-theme-script>';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data:;
  font-src 'self';
  media-src 'self';
  connect-src 'self' https://<project-ref>.supabase.co;
  object-src 'none';
  base-uri 'self';
"/>
```

Gotchas to verify in a real build before merging:
- `connect-src` needs the concrete Supabase project host — it's baked at build
  time anyway (the key is in the bundle), so hardcoding it in index.html is
  fine; keep dev working by allowing `ws:`/`http://localhost:*` only in dev
  (vite env conditional or a dev-only relaxed meta).
- Motion/visx/NumberFlow inject inline styles → `style-src 'unsafe-inline'`
  stays (acceptable; style injection is far lower risk than script).
- The aurora video/posters are bundled assets → `media-src 'self'` suffices.
- Recompute the script hash if the theme snippet ever changes — add a comment
  next to the snippet saying so.

## Acceptance criteria

- Console shows zero CSP violations on: login screen (dark, with video), hub,
  each of the 6 tools, a chart expand, a dialog open.
- No requests to `fonts.googleapis.com`/`gstatic.com` in the network tab; text
  renders in Instrument Serif/Inter (not fallbacks).
- Deployed Pages build verified, not just dev.
