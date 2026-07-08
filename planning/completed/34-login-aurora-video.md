# Plan 34 — Photographic aurora video behind the login screen

**Status:** shipped (PR #226) · **Owner model:** Sonnet-suitable
(video sourcing/encode + CSS + small component change; no shader work) ·
**Relationship:** dresses the plan-16a magic-link wall; deliberately does NOT
reuse the plan-28c stylized hero aurora — the brief is *photographic*, and
the hero curtain is editorial by design.

## Goal

In dark theme, the login screen (`AuthGate`'s `MagicLinkScreen`) plays a
full-screen, seamlessly looping, real aurora-borealis timelapse behind a
frosted-glass login card. Light theme keeps the current flat paper screen
unchanged. Photographic quality means real licensed footage, not a shader.

## Decisions (locked during grilling)

1. **Approach: real video loop.** Licensed stock timelapse — the only
   literally photographic option. Not the cinemagraph or raymarch variants.
2. **Sourcing: Claude picks, ~10 MB, committed to the repo.** Free-license
   footage (Pexels/Pixabay — no attribution, commercial OK). Download 2–3
   candidates, show screenshots, user picks; only the winner is committed
   (git history is forever — never commit the rejects).
3. **Theming: dark theme only.** Light theme = current paper screen,
   untouched. The video (and its poster) must not even be *downloaded* in
   light theme — gate the element on the theme, not just its visibility.
4. **Card: frosted glass** in dark theme — `backdrop-filter: blur(…)` +
   translucent dark fill + hairline border; aurora glows through. Keep the
   existing card geometry/typography. `@supports not
   (backdrop-filter: blur(1px))` fallback: solid dark fill.
5. **Loading: poster-first fade.** A still frame of the same clip
   (~150 KB AVIF + JPEG fallback) paints immediately; the video crossfades
   in over it on `canplay`. `prefers-reduced-motion`: poster only, video
   never fetched. The form is interactive throughout.
6. **Loop seam: baked crossfade.** During encode, blend the clip's last
   ~2 s into its first ~2 s with ffmpeg (xfade/blend), producing ONE file
   that loops invisibly with the plain `loop` attribute. No runtime
   double-`<video>` machinery.
7. **Scope: form + sent state.** The video backs the whole
   `MagicLinkScreen` (it keeps playing across the swap to «Kolla din
   inkorg»). The restoring-session `auth-splash` stays a plain flash —
   never start a video there.
8. **Clip taste (shortlist criteria):** classic green curtains first
   (echoes the accent tokens), purple/pink mixed in welcome; landscape
   silhouette at the bottom of frame (ridge/treeline/lake); slow, calm
   drifting motion — not a fast substorm — behind a form you type into.

## Build notes

- **Asset pipeline (offline, documented in the commit message):** source
  clip → trim to ~20–40 s → bake loop crossfade → encode 1920×1080
  H.264 MP4 (`-crf` tuned to land ~8–12 MB, `faststart`) + poster still
  (AVIF + JPEG). Land in `web/public/auth/` (e.g. `aurora.mp4`,
  `aurora-poster.avif`, `aurora-poster.jpg`). Keep the source URL +
  license line in a small `web/public/auth/CREDITS.md`.
- **Markup:** in `MagicLinkScreen`, when theme is dark render a
  `.auth-scene` layer under the card: poster as CSS background (paints
  first), then `<video autoplay muted loop playsinline
  preload="auto" poster=…>` fading from `opacity: 0 → 1` on `canplay`.
  Theme read: same `data-theme` source the rest of the app uses — live,
  so toggling theme on the login screen swaps treatments without reload.
- **Mobile:** `object-fit: cover` (portrait crops the 16:9 sides —
  accepted); `playsinline` for iOS; low-power-mode autoplay rejection
  falls back to the poster naturally (listen for nothing — if `play()`
  never fires, opacity stays 0 and the poster shows).
- **`prefers-reduced-motion: reduce`:** don't render the `<video>`
  element at all; poster only.
- **Frosted card (dark only):** translucent `--paper-card`-derived fill,
  `backdrop-filter: blur(18px) saturate(1.1)`-ish, hairline border, and a
  soft radial scrim behind the card if the chosen clip runs bright.
  Text/inputs re-checked for contrast against footage, not tokens.

## Out of scope

- Any change to the light-theme login screen, the `auth-splash`, or the
  homepage hero aurora (plan 28c).
- External hosting (Supabase Storage) — revisit only if the repo weight
  ever hurts.
- Sound, parallax, pointer-reactivity on the video.

## Definition of done

- Dark theme: video paints poster-first, crossfades to motion, loops with
  no visible seam (watch two full loops), «Skicka länk» flow and sent
  state both sit on the running footage, frosted card readable over the
  brightest frames.
- Light theme: byte-identical network behavior to today — no video/poster
  requests (verify in devtools).
- `prefers-reduced-motion`: poster only, no video request.
- Committed asset ≤ ~12 MB, license recorded in `CREDITS.md`; build,
  lint, tests green.
