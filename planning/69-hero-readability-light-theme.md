# Plan 69 — Hero polish: subline readability, aurora banding, a light theme that isn't a smudge

**Status:** plan · **Owner model:** Opus-suitable (WebGL scene + typography
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
