# Plan 59 — Kill the horizontal background seam on long tool pages

**Status:** plan · **Owner model:** Sonnet-suitable (CSS detective work,
small diff; the hard part is *seeing* it, and the repro is given) ·
**Source:** design review 2026-07-07 · **Touches:** `global.css` (body
background), possibly per-tool page veils.

## Finding

On tall pages (Bolånekoll ~y≈800 dark, Månadsavslut ~y≈900) there is a
visible full-width horizontal band where the page background abruptly
changes brightness — the top of the page sits on a subtly lighter wash, and
below the seam it drops to flat dark. Cause: `body` background is
`radial-gradient(1100px 500px at 85% -10%, var(--accent-faint), transparent
60%), var(--paper)` (global.css:26) — a FIXED-SIZE gradient that ends
mid-page instead of fading imperceptibly, plus (verify) any per-tool veil
with a hard end. On a dark theme the eye catches a 2% luminance step across
the full viewport width instantly; it reads as a rendering bug.

## Fix

- Reproduce with a fullPage screenshot of /#/bolanekoll (populated) in dark
  mode; the seam survives JPEG compression, so it is not subtle.
- Make the wash viewport-attached instead of page-attached
  (`background-attachment: fixed` has mobile jank; prefer a
  `position: fixed; inset: 0; z-index: -1` pseudo-element/div carrying the
  radial) OR extend the gradient stops so the transition to `--paper`
  happens over ≥50% of its extent (no step > ~1 OKLCH L% per 100 px).
- Audit the other tool pages + hub at full page height in both themes for
  the same artifact once fixed.

## Acceptance criteria

- Dark + light theme fullPage screenshots of Bolånekoll, Månadsavslut and
  the hub show no detectable horizontal band (pixel-sample two rows either
  side of the old seam — ΔL below perceptible threshold).
- No scroll-performance regression (the fix must not repaint the gradient
  on scroll — verify with DevTools paint flashing or an rAF probe).
