# Plan 69 — Hero polish: subline readability, aurora banding, a light theme that isn't a smudge

**Status:** shipped (light-hero portfolio sign-off pending before merge) ·
**Owner model:** Opus-suitable (WebGL scene + typography
judgment; carries the plan-28 landmines — R3F v9 clones `uniforms` props,
verify canvas via in-page rAF probe not screenshots) · **Source:** homepage
design review 2026-07-07 · **Touches:** `home.css` hero text block,
`components/hero*` / `lib/heroScene` (28a-c code), light-theme treatment.

## Finding

1. **Subline fights the particle waves.** "The family operating system —
   calculators, plans and shared tools…" is `--ink-soft` text laid directly
   over the dotted terrain in BOTH themes; the dot rows pass through the
   letterforms at the exact luminance where AA contrast is marginal. In
   light theme it is worse: grey text on a pale green wash with orange/
   green dots through it. The one paragraph that explains the product is
   the hardest text on the page to read.
2. **Aurora shows blocky rectangular patches** (dark theme, top band
   ~y 100-190 at 1440×900): visible rectangles of brightness instead of a
   smooth veil — reads as a low-res texture/FBO upscaled with hard edges
   (or gradient banding on the 8-bit background). Confirm live before
   fixing — could partly be JPEG in review shots, but the block shapes
   look structural.
3. **Light-theme hero is designed-dark-shipped-light.** The nightscape
   concept (28c: time-of-day, aurora) reads as a washed-out green blur in
   daylight palette — neither the editorial calm of the paper theme nor
   the drama of the dark one. Meanwhile the greeting line ("God morgon —
   tisdag 7 juli") renders in `--ink-faint`-ish grey that nearly vanishes
   on the wash.
4. Mobile: the canvas contributes nothing but a dark void between subline
   and grid (~1 empty viewport-third) — the overscan region is empty at
   390 px.

## Fix

- Text protection, cheapest first: a local scrim behind the hero text
  block (radial `--paper` at ~60-75% fading to transparent, both themes)
  OR mask the particle field with a cutout around the text column
  (`mask-image` on the canvas wrapper). Keep the display serif on the
  headline as-is — it already knocks out fine; the subline + greeting are
  the problem.
- Greeting/date bump to `--ink-mid` minimum; verify AA on the actual
  rendered background (sample, don't assume).
- Aurora: rAF-probe + `preserveDrawingBuffer` screenshot of the canvas
  alone; if the blocks are structural, raise the aurora FBO/texture
  resolution or add a blur/dither pass. If it's background gradient
  banding, add a subtle noise/dither (cf. plan 59's seam work — same
  perceptual issue, coordinate).
- Light theme: pick ONE — (a) tune the scene for day (paper-tinted sky,
  particles at much lower alpha, no aurora) or (b) static editorial
  header in light mode (no canvas — the dots become a faint single SVG
  wave), canvas remains dark-mode's showpiece. Decide by eye, prototype
  both cheaply behind the existing theme flag.
- Mobile: cap the hero block so subline→TOOLS gap ≤ ~120 px at 390 px.

## Acceptance criteria

- Subline + greeting pass WCAG AA against their worst sampled background
  pixel, both themes (measure, note values in PR).
- No visible rectangular patches in the aurora band (live inspection, not
  screenshots).
- Light-mode hero screenshot presentable as a portfolio shot (subjective
  gate: the user signs off before merge).
- Mobile 390: no dead scroll region between subline and TOOLS.

## Outcome

Shipped on `ui/plan-69-hero-readability`. Verified live on the isolated dev
server (localhost:5174, WebGL2 path active) with per-pixel AA sampling — text
glyphs hidden, tight `Range.getClientRects()` boxes, worst background pixel over
3 animation frames, contrast vs the resolved `--ink-mid` sRGB.

1. **Text protection (findings 1 + 3).** Local paper radial scrim on
   `.hero::before` (z-index −1: above the terrain, below the copy), sized to
   the left copy column and fading out before the Tools grid — invisible as a
   blob in both themes. Greeting → `--ink-mid`, date → `--ink-mid` (was
   `--ink-soft`/`--ink-faint`). Measured contrast against the worst sampled
   background pixel:
   - Dark: greeting **7.31**, subline **4.87** (both ≥ 4.5 AA)
   - Light: greeting **8.08**, subline **7.16**
2. **Aurora banding (finding 2).** Root cause was `mediump` precision on the
   `hash(sin(n)·43758)` value noise — the large-magnitude `sin()` loses
   precision in rectangular lattice cells. Switched the aurora fragment shader
   to `precision highp float` and added a screen-space sub-LSB dither on the
   output. Forensic 2.6× contrast/brightness boost of the y40–210 band shows
   smooth curtain rays with fine grain — no contour banding, no rectangular
   quantization blocks.
3. **Light theme (finding 3).** Chose option (a): tuned the scene for day.
   `heroScene.ts` now dims the light-theme dot field to half opacity
   (`LIGHT_ALPHA_SCALE = 0.5`) and carries **no aurora** in light
   (`paletteFor(..,'light').aurora === 0`) — the washed-out green pigment veil
   is gone; light hero reads as a calm editorial paper header. Tests updated.
4. **Mobile (finding 4).** Capped `.hero` bottom padding to 3rem at ≤600px:
   subline→TOOLS gap is now **48 px** at 390 px (was ~a viewport-third).

Remaining gate: light-hero portfolio screenshot sign-off before merge.
