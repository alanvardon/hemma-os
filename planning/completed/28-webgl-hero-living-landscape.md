# Plan 28 — WebGL hero: a living Nordic landscape (three.js)

**Status:** plan · **Owner model:** strong model recommended (custom shaders +
scene tuning are taste work, not mechanical) · **Req:** 1 (of this batch) ·
**Relationship:** replaces the 2D `HeroCanvas` terrain (keeping it as the
fallback); must coexist with the hub-pan camera move (plan 08) + background
overscan (plan 26), the whoosh View Transitions (plans 08/09/25), the mobile
push (plan 20), and the theme system (`data-theme` + `--canvas-*` aliases).

## Goal

The hero's wireframe terrain is the page's most ambitious element and its least
visible — at desktop widths it reads as faint texture and the right half of the
hero is empty. Replace it with a lazy-loaded **@react-three/fiber** scene: a
particle terrain with real depth, that **knows the time of day** (tinting with
the greeting), shows an **aurora in dark mode**, **ripples under the cursor**,
and **dollies with scroll** as the user moves from hero to Tools. Atmosphere,
not tech demo: same motif, same palette, same restraint — ten times the
presence.

Explicitly *not* in this plan (rejected in review): assembling 3D house models,
particle text morphs, custom cursors, sound.

## Concept

One scene, four behaviours layered on the existing motif:

1. **Terrain v2** — the current sine-field becomes a grid of GPU **points**
   (vertex-shader displacement, ridged noise), with **depth fog** and
   size-attenuated dots. Accent green rows with periodic copper rows, exactly
   like today's canvas — recognisably the same landscape, now dimensional.
2. **Time-of-day palette** — the greeting already knows the hour; the scene
   uses the *same* bucket so text and light always agree:
   - *God morgon* (5–10): pale, desaturated, higher fog density (mist).
   - *God dag* (10–18): clear, brightest accent, thinnest fog.
   - *God kväll* (18–24): dusk — copper weighting up, warm horizon.
   - *God natt* (0–5): darkest, sparse dots.
3. **Aurora** — whenever `data-theme="dark"` (any hour): a curtain shader on a
   horizon-spanning quad behind the terrain — 2–3 layered noise bands in the
   dark-theme accent greens (`--canvas-accent` `#7cbf8f` territory), additive
   blend, slow vertical shimmer, low max opacity (~0.35). In light theme the
   quad is not rendered. This is the dark-mode showpiece.
4. **Pointer ripple + scroll dolly** — the cursor adds a moving gaussian bump
   into the heightfield (smoothed/decaying uniform, replacing today's
   yaw/pitch-only parallax — keep a gentler version of that parallax too);
   scrolling from hero toward Tools maps to a camera descent + pitch-down +
   fog pull-in, then the whoosh into a tool reads as the third beat of one
   continuous camera language (pan → dolly → zoom).

## Constraints inherited from the existing hub (all must keep working)

- **Hub-pan overscan (plan 26):** the pan translates the whole page sideways by
  up to ~half the viewport toward a clicked card. The 2D canvas solves this
  with `OVERSCAN_X = 0.4` + JS-anchored mask fades. The WebGL canvas sits in
  the same `.hero-wrap` slot and reuses the **same approach**: oversize the
  canvas horizontally, keep the projection's pixel density anchored to the
  pre-overscan width (widen the frustum, don't zoom), and reuse the existing
  `--hc-fade-in/out` mask anchoring (CSS `mask-image` applies to WebGL
  canvases the same as 2D).
- **Theme switching:** keep the `MutationObserver` on `data-theme` and the
  `--canvas-accent` / `--canvas-copper` hex-alias read (`getComputedStyle`
  returns OKLCH tokens verbatim — the aliases exist for exactly this). Theme
  change lerps uniforms over ~600ms rather than snapping.
- **View Transitions:** the whoosh rasterises the page — a WebGL canvas
  snapshots fine, but verify the frozen frame isn't mid-ripple ugly; on
  `markVtTransition` we can ease the ripple/parallax targets to neutral.
- **Reduced motion:** unchanged contract — no animation loop. Fallback ladder
  below.
- **Mobile push (plan 20, ≤600px):** terrain contributes ~nothing at 390px and
  phones shouldn't pay for three.js. Mobile keeps the current 2D canvas (or
  its static frame) — the WebGL chunk must not even be *fetched* ≤600px.

## Architecture

### Dependencies

`three` + `@react-three/fiber` only. **No drei** — we need points, two custom
`ShaderMaterial`s and a camera; drei buys nothing here and this keeps the lazy
chunk lean (~150–170 kB gz for three + R3F).

### Loading / fallback ladder

`HeroCanvas` becomes the orchestrator; the current 2D implementation is renamed
`HeroCanvas2D` (unchanged logic) and stays as both fallback and loading state:

1. `≤600px`, `prefers-reduced-motion`, or WebGL unavailable/context-lost →
   **HeroCanvas2D** (reduced-motion already draws its single static frame).
2. Otherwise `React.lazy(() => import('./HeroScene'))` inside
   `<Suspense fallback={<HeroCanvas2D/>}>` — the 2D terrain paints
   immediately, the WebGL scene **crossfades in** (~400ms opacity) when the
   chunk arrives. First paint is never blocked; slow connections just keep
   today's hero.
3. `visibilitychange` and an `IntersectionObserver` on `.hero-wrap` pause the
   R3F loop (`frameloop: 'never'` + manual invalidate, or demand mode) when
   hidden/scrolled past — the hub must stay cheap while idle below the fold.

### File layout

- `web/src/components/HeroScene.tsx` — R3F canvas, terrain points, aurora
  quad, uniform wiring (lazy chunk; nothing else imports three).
- `web/src/components/HeroCanvas2D.tsx` — the current `HeroCanvas.tsx`,
  renamed verbatim.
- `web/src/components/HeroCanvas.tsx` — thin orchestrator (ladder above).
- `web/src/lib/heroScene.ts` — **pure, testable** logic: time-of-day bucket
  (shared with the greeting — extract the `h<5/‹10/‹18` logic from `Home.tsx`
  so they can never disagree), palette/uniform derivation per
  (bucket × theme), scroll→camera mapping, ripple spring math. Unit tests live
  against this file; no three imports.

### Scene spec

- **Terrain:** one `THREE.Points` over a ~220×130 plane grid (~28k verts —
  trivial for a vertex shader). Displacement = 3-octave ridged noise (port the
  current `elevation()` character: slow x-swell + faster cross-waves) + the
  ripple bump. Per-row color attribute: copper every ~6th row, accent
  otherwise, matching today. Fragment: round-dot alpha, opacity falls with fog
  depth (`smoothstep` on view-space z) — the dots dissolve into the paper
  color rather than a hard horizon.
- **Aurora (dark only):** full-width quad behind/above the terrain,
  fragment-shader curtains — `fbm(uv.x·k − t·slow)` bands shaped by a vertical
  falloff, 2–3 layers at different speeds, additive, capped ~0.35 alpha.
  Uniform-driven so kväll/natt can push intensity slightly higher than a dark
  afternoon.
- **Fog/tone uniforms per bucket:** `uFogDensity`, `uAccent`, `uCopper`,
  `uCopperWeight`, `uDotScale` — all derived in `heroScene.ts` and lerped in
  the render loop (theme flips, and the hour rolling over mid-session via the
  existing 30s greeting interval, both just move targets).

### Interaction spec

- **Ripple:** pointer position → raycast-free mapping (screen → terrain plane
  is analytic) → `uRippleCenter` + `uRippleStrength` uniforms; strength springs
  up on move, decays over ~1.5s when the pointer stops/leaves. Gaussian bump
  radius ~15% of terrain width, height ≈ noise amplitude (visible, not
  volcanic).
- **Parallax:** keep today's yaw/pitch lerp (0.04 factor) at roughly half the
  current amplitude — the ripple is now the star.
- **Scroll dolly:** progress = `scrollY / heroHeight` clamped 0–1 (plain
  scroll listener + lerp; no new dep — `motion`'s `useScroll` optional).
  Maps to camera y −15%, pitch −0.1rad, fog density +30%, global opacity → the
  existing vertical mask already fades the bottom; the dolly must feel like
  descending past the ridge, not fading a poster.

## Performance budget & guardrails

- 60fps on the dev machine, no jank during the hub-pan (the pan is a
  compositor transform; the WebGL loop keeps running — verify they don't
  fight; if they do, pause the loop for the pan's 760ms).
- DPR capped at 2 (as today). Antialias off (points don't need MSAA).
- Grid density steps down once below 900px width.
- Zero three.js bytes in the entry chunk — assert via `npm run build` output
  (`HeroScene` must be its own chunk) and that's part of DoD.
- `powerPreference: 'low-power'`, context-loss listener → swap to
  `HeroCanvas2D` permanently for the session.

## Staged delivery (separate PRs, each off main — no stacking)

1. **28a — scaffold + terrain parity:** deps, fallback ladder, renamed
   `HeroCanvas2D`, points terrain with fog matching today's palette/motif,
   overscan + masks, pause-when-hidden. Ship when it's *at least as good* as
   the 2D canvas and every constraint above holds.
2. **28b — interaction:** pointer ripple + halved parallax + scroll dolly +
   VT-neutralising ease.
3. **28c — time & light:** shared time-bucket extraction, per-bucket palettes,
   theme lerp, aurora quad in dark mode.

Each stage is independently shippable; if 28c's aurora doesn't land tastefully
it can be cut without stranding anything.

## Out of scope

- House models, text/particle morphs, custom cursors, sound (rejected).
- Kinetic type entrance, icon line-draw, living bento grid, magnetic hover —
  separate plans if wanted; this plan only touches the hero background layer.
- Tool pages — the scene mounts on the hub route only; the lazy chunk must not
  load when deep-linking straight into a tool.
- Any change to the whoosh/pan/push transitions themselves.

## Definition of done

- Desktop, motion-ok, light theme: particle terrain with visible depth + fog,
  clearly the same motif as today but dimensional; time-of-day tint matches
  the greeting bucket in all four buckets (fake the clock to verify).
- Dark theme: aurora curtains visible above the ridge, subtle at ~0.35 alpha,
  colors from the dark accent tokens; no aurora in light theme.
- Cursor ripples the heightfield and decays; scroll descends the camera; the
  hub-pan toward any card (all four corners) never exposes a canvas edge, and
  the whoosh snapshot looks clean.
- Mobile ≤600px and reduced-motion get exactly today's experience, and the
  network tab shows **no three.js chunk fetched**; WebGL-unavailable falls
  back to the 2D canvas.
- Theme toggle lerps the scene (no snap); tab-hidden and scrolled-below-fold
  stop the render loop (verify via the performance panel).
- `npm run build` (chunk split verified) + `npx oxlint src` + `npx vitest run`
  green, with unit tests covering `heroScene.ts` (bucket boundaries 5/10/18,
  palette derivation per bucket×theme, scroll mapping clamp, ripple decay).
