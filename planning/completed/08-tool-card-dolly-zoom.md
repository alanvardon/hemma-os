# #8 — Tool card "dolly zoom" (parallax dive, no fade)

Reworks the animation shipped under [06-tool-card-expand-animation.md](06-tool-card-expand-animation.md).
The shipped effect is a shared-element **morph + cross-fade** (the card box grows
while the old card fades out and the new page fades in). The fade is the problem.
This replaces it with a **parallax dolly**: the camera dives *into* the clicked
card — the card scales up solid in the foreground while the destination page
parallax-zooms behind it at a slower rate, with only a micro-dissolve at the very
end as you punch through. No slow cross-fade anywhere.

## Decisions locked

Grilled 2026-06-27. Each line is source of truth.

1. **Effect = dolly INTO the card.** Foreground (card) scales up fast; background
   (destination) zooms at a slower rate → parallax depth. Not a flat morph, not a
   cross-fade.
2. **No fade — solid zoom.** The card stays 100% opaque while it scales.
3. **Destination zooms up solid behind it** (the real dashboard, not a placeholder).
4. **Pass-through = micro-dissolve at the very end.** Card is solid for ~85% of
   the timeline, then dissolves over the final ~15% as the camera passes through
   its plane (the only physically-honest way to fly *through* an opaque card to a
   different page). This is a fast, late snap — deliberately *not* the old slow
   ghosty cross-fade.
5. **Origin = into the card where it sits.** `transform-origin` = the clicked
   card's own centre in the grid; the camera lunges toward that slot.
6. **Back = symmetric dolly-out.** Pressing back collapses the dashboard back down
   *into* the card's slot and re-forms the card. Needs reverse handling.
7. **Pacing = cinematic ~560ms, big parallax.** Card → ~4×, page ~1.18 → 1.0,
   ease-in-out. All values CSS-tunable; expect to dial in by eye.
8. **Surroundings:** accepted consequence of strict no-fade — the *other* hub
   cards are covered instantly by the opaque incoming dashboard; only the clicked
   card carries continuity. We do **not** try to animate the other cards out.
9. **Scope = Bostadskalkyl card → scenarios dashboard only** (PoC). Other active
   cards keep normal navigation; "Soon" cards stay static.
10. **Reduced motion:** keep the existing `prefers-reduced-motion` kill-switch →
    instant navigation, no animation.

## Current state (what we're replacing)

- [`transitions.css`](../web/src/styles/transitions.css) — `.bk-vt { view-transition-name: bk-card }`,
  a tuned `::view-transition-group(bk-card)` (360ms) and a `root` cross-fade
  (280ms). **This whole file gets rewritten.**
- [`Home.tsx:111`](../web/src/routes/Home.tsx#L111) — the Bostadskalkyl `<Link
  to="/bostadskalkyl" viewTransition>` adds `bk-vt` while
  `useViewTransitionState('/bostadskalkyl')` is true ([:15](../web/src/routes/Home.tsx#L15)).
- [`ScenariosDashboard.tsx:102`](../web/src/routes/ScenariosDashboard.tsx#L102) —
  the `.bk-page-root` wrapper adds `bk-vt` while transitioning, **also claiming
  `bk-card`** → this is what creates the shared morph. The dashboard's `‹ Hemma`
  back-link already uses `viewTransition` ([:105](../web/src/routes/ScenariosDashboard.tsx#L105)).
- Imported once at [`main.tsx:14`](../web/src/main.tsx#L14).

## Why the approach has to change

A View-Transitions **shared element** (same `view-transition-name` on both pages)
*always* gives you a box-morph with a default old↔new cross-fade. That is exactly
the current effect. A dolly is the opposite: the card must **over-scale past the
viewport** (not land on a destination box), and the destination is a **separate,
slower-moving layer**. So the destination must **stop claiming `bk-card`** on the
forward trip — it becomes the `root` (background) layer instead.

## Target choreography

```
FORWARD  (hub ──► dashboard)            t=0 ─────────────────────► t=1
 foreground  clicked card (bk-card, OLD-only)   scale 1 → ~4×, origin = its slot
                                                opacity 1 ........ dissolve 85→100%
 background  dashboard (root, NEW)              scale 1.18 → 1.0, opaque (no fade)
             other hub cards (root, OLD)        covered instantly (accepted)

BACK  (dashboard ──► hub)               reverse — "the world shrinks into the slot"
 the dashboard collapses/zooms DOWN into the card's slot and the card re-forms.
```

### Forward — recommended technical strategy

- **Card = exit-only named element.** Keep `bk-card` on the hub card (as today),
  but **remove `bk-card` from the dashboard** on forward nav. With a name present
  only on the *old* page, the browser treats it as an **exiting** element →
  animate `::view-transition-old(bk-card)`: `transform: scale(4)` from
  `transform-origin: center`, plus a late `opacity 1→0` (keyframe holds 1 until
  85%). This is the solid dive + micro-dissolve.
- **Destination = root parallax.** `::view-transition-new(root)` →
  `scale(1.18) → scale(1)`, `opacity: 1` throughout (override the UA fade-in).
  `::view-transition-old(root)` → `animation: none` (it's covered; no fade).
- Result: dashboard fills the screen slightly over-scaled with the card sitting
  on top in its slot; card dives + dissolves; dashboard settles.

### Back — symmetric dolly-out

The natural inverse of "fly into the card" is "the page shrinks back into the
card slot" — which is precisely a **shared-element collapse morph**. So on the
**back** trip we *do* want `bk-card` on both ends:

- Re-apply `bk-card` to the **dashboard root** *only when leaving to home*, and
  keep `bk-card` on the **hub card** as it re-mounts → the group auto-morphs the
  box from full-screen down to the slot (position + size for free).
- Tune opacity so it reads solid: `::view-transition-old(bk-card)` (dashboard)
  stays opaque then dissolves in the last ~15%; `::view-transition-new(bk-card)`
  (card) reverse of that. `::view-transition-new(root)` (hub) settles `0.92→1.0`,
  opaque.

### Direction detection (the crux of the extra work)

Forward and back need *different* names on the dashboard root. Use
`useViewTransitionState` directionally — on the dashboard the **target path tells
us the direction**:

```tsx
// ScenariosDashboard root:
const arriving = useViewTransitionState('/bostadskalkyl') // forward (PUSH in)
const leaving  = useViewTransitionState('/')              // back  (POP/Link to '/')
// claim bk-card ONLY while leaving → enables the collapse morph on back;
// stay unnamed while arriving → forward is a root-parallax dolly.
const dashName = leaving ? 'bk-card' : undefined
```

```tsx
// Home hub card: name it while a transition to/from the tool is active
const active = useViewTransitionState('/bostadskalkyl') || useViewTransitionState('/')
```

Also set a `data-vt-dir="forward|back"` attribute on `<html>` (toggle in the card
`onClick` and the back-link `onClick`; clear on `transitionend`) so the **root
parallax keyframes can be scoped per direction** (`new(root)` means dashboard on
forward but hub on back — they want different scales). Browser-back (no click)
falls back to the `leaving` flag + `useNavigationType() === 'POP'`.

### CSS shape (rewrite `transitions.css`)

```css
:root { --vt-dur: 560ms; --vt-ease: cubic-bezier(.4,0,.2,1); }

/* FORWARD: card dives (exit-only), dashboard parallax-zooms behind */
html[data-vt-dir="forward"] {
  &::view-transition-old(bk-card) { animation: vt-dive var(--vt-dur) var(--vt-ease) both; }
  &::view-transition-new(root)    { animation: vt-bg-in var(--vt-dur) var(--vt-ease) both; }
  &::view-transition-old(root)    { animation: none; }            /* covered, no fade */
}
@keyframes vt-dive {  /* solid scale-up, dissolve only at the end */
  0%   { transform: scale(1);   opacity: 1; }
  85%  { transform: scale(3.4); opacity: 1; }
  100% { transform: scale(4);   opacity: 0; }
}
@keyframes vt-bg-in { from { transform: scale(1.18); } to { transform: scale(1); } }

/* BACK: shared collapse morph into the slot (handled by the group), opacity solid */
html[data-vt-dir="back"] {
  &::view-transition-group(bk-card) { animation-duration: var(--vt-dur); animation-timing-function: var(--vt-ease); }
  &::view-transition-old(bk-card) { animation: vt-collapse var(--vt-dur) var(--vt-ease) both; }
  &::view-transition-new(bk-card) { animation: vt-reform  var(--vt-dur) var(--vt-ease) both; }
  &::view-transition-new(root)    { animation: vt-bg-out var(--vt-dur) var(--vt-ease) both; }
}
/* vt-collapse: opacity 1 → 0 only in last 15%; vt-reform: 0 → 1 mirrored;
   vt-bg-out: scale .92 → 1 */

@media (prefers-reduced-motion: reduce) {
  ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation: none !important; }
}
```

(Exact scales/opacity split-points are eyeball-tuned during build — these are
starting values for the "cinematic" feel.)

### Perf

- Add `contain: layout paint` on `.bk-page-root` (already a wrapper) and
  `will-change: transform` on the captured snapshots' pseudos to keep the big
  scale on the compositor.
- Snapshots scaling to ~4× are GPU transforms (cheap); no layout thrash.

## Edge cases

- **Uniqueness rule:** `bk-card` must be claimed by ≤1 mounted element per
  snapshot. Forward → only the hub card. Back → dashboard root (old) + hub card
  (new), which live on different document states, so it's still unique per
  snapshot. The directional gating above guarantees this.
- **Browser back / swipe back (POP, no click):** `data-vt-dir` won't be set by a
  handler → derive it from `useNavigationType() === 'POP'` + the `leaving` flag.
- **Interrupting a transition** (clicking during the dive): VT cancels/!restarts;
  ensure `data-vt-dir` is cleared on `transitionend`/`finish` so a stale class
  doesn't mis-scope the next nav.
- **No View-Transitions support** (older Firefox): RR no-ops → plain navigation.
- **Destination is #07's redesigned dashboard:** the dolly scales the *whole*
  dashboard snapshot, so the new card layout from #07 doesn't affect the
  animation — looser coupling than the old shared-morph.

## Reduced motion / fallback

- Keep the `prefers-reduced-motion` block → instant nav.
- **If directional reverse proves flaky to land:** degrade *back* to a simple fast
  scale-down (`::view-transition-old(root){ scale 1→.96 }`, ~200ms) and ship the
  forward dolly first. (Forward is the star; this keeps the PoC unblocked.)

## Testing

- Mostly manual + Playwright: navigate hub→dashboard, observe solid scale + late
  dissolve + background parallax; press back, observe collapse into slot.
- `prefers-reduced-motion` emulation → assert no animation, navigation still works.
- Unit (best-effort): the hub card carries `bk-card` while transitioning; the
  dashboard root claims `bk-card` only on the back path, not forward.
- Capture a screen recording for before/after sign-off (the feel is the spec).

## Risks

- **Directional naming + `data-vt-dir` timing** is the main risk — getting the
  right pseudo-elements named per direction without violating uniqueness. Budget
  iteration here; the fallback above de-risks shipping.
- **Cinematic 560ms on every open** may tire — `--vt-dur` is a one-line dial.

## Effort

**Medium.** More than the original #06 ("two hooks + a little CSS"): a full
`transitions.css` rewrite with directional keyframes, removing `bk-card` from the
dashboard on the forward path, direction detection (`data-vt-dir` +
`useViewTransitionState`/`useNavigationType`), and by-eye tuning.

## Sequencing

- **Supersedes the animation in #06** — same files, new approach. Treat #06 as
  done/replaced by this.
- **Independent of #07** (dashboard polish): the dolly scales the whole dashboard,
  so either order works. If both are queued, doing #07 first just means the dive
  lands on the final design — nice but not required.
- Own branch `ui/bostadskalkyl-dolly-zoom`, base `main`, single PR.

## Revisions during build (PR #176)

The "dive into the exit-only card" (rev 1) and the root "scene zoom" (rev 2)
both got feedback that the zoom felt wrong / faded. The **shipped effect is
rev 3 — "whoosh into the card", a no-fade shared-element zoom**:

- The hub card AND the dashboard root share `bk-card` during the transition
  (back to the #06 shared-element model, gated by `useViewTransitionState`).
  Forward, the browser renders the **whole dashboard shrunk into the card's
  slot — a genuine miniature of the page** — then the shared group grows that
  box to fill the screen. **Opacity is held solid the entire time** (custom
  keyframes override the UA cross-fade), so it reads as a pure zoom with **no
  fade**: the card visibly *becomes* a tiny dashboard and whooshes up to full
  size. Verified via Playwright frame grabs (miniature-in-slot at ~45ms →
  near-fullscreen at ~225ms).
- Back reverses it: the dashboard shrinks solid back into the card's slot while
  the hub sits behind it (no fade-in), and the card content snaps back only in
  the last ~18% (`vt-late-in`).
- `data-vt-dir` (set on click) scopes the per-direction opacity timing only —
  the box morph itself is the automatic shared-group animation. `--vt-dur`
  (540ms) + `--vt-ease` are the tuning dials. No origin math needed (the card's
  slot IS the zoom origin, for free).
- ~~**Known nuance:** there is no separate "pan-to-centre then zoom" phase~~ →
  **ADDED in rev 4 (the user asked for it explicitly).** Two-beat open: a JS
  **camera pan** runs BEFORE the VT. On card click we `preventDefault`, wrap the
  whole hub in a `.hub-pan` div, and WAAPI-`animate()` it
  `translate(0,0) → translate(centre − cardCentre)(+scale 1.04)` over 360ms; on
  `.finished` we `markVtDirection('forward')` + `navigate('/bostadskalkyl',
  { viewTransition:true })`. Because the card is captured at screen centre, the
  existing VT whoosh now grows from the **centre**. Key timing fact: set
  `markVtDirection` *after* the pan (right before navigate) so the 820ms
  self-clear covers the whoosh, not the pan. `fill:'forwards'` holds the card
  centred through capture; Home unmounts on nav so the pan transform never leaks
  to the dashboard (no manual cleanup). Reduced-motion / modified-clicks skip
  the pan and navigate straight. The back trip still shrinks into the card's real
  grid slot (no reverse pan — could add later). Verified via frame grabs: card
  glides lower-left→centre (~360ms) then the mini-dashboard whooshes to
  fullscreen.
- **Remaining nuance:** the card↔page aspect-ratio mismatch means the miniature
  is briefly letterboxed/squished at t=0 (inherent to VT shared elements of
  different shapes).
- Files unchanged in count: `transitions.css` (rewritten), `viewTransition.ts`
  (direction tag only), `Home.tsx` + `ScenariosDashboard.tsx` (both name
  `bk-card` via `arriving || returning`, called as TWO unconditional hooks —
  collapsing to `||` trips rules-of-hooks).
