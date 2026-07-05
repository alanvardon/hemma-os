# Plan 09 — Propagate the tool-card whoosh transition to all live tools

**Status:** ready to build · **Owner model:** Sonnet · **Depends on:** PR #176
(`ui/bostadskalkyl-dolly-zoom`) merged to `main`.

## Goal

The cinematic card→page transition (plan 08) currently works for **one** card:
Bostadskalkyl. Make it work for every **Live** tool card on the hub:

- Hushållsbudget (`/hushallsbudget`)
- Konsultkalkyl (`/konsultkalkyl`)
- Månadsavslut (`/manadsavslut`)
- Bolånekoll (`/bolanekoll`)
- Löneväxling (`/lonevaxling`)

Exclude the two **Soon** cards (Kalender, Matplan — they are plain `<div>`s, not
links).

The end state: clicking any Live card pans it to centre, "sucks in" (dives) into
the page; clicking **‹ Hemma** on any tool plays the two-stage close (corners
round full-screen, then the page shrinks back into its card). Identical feel to
Bostadskalkyl, no per-tool special-casing in the CSS.

---

## How the Bostadskalkyl PoC works (read this first)

Four files implement the whole effect. **Study them before touching anything** —
they are your reference implementation.

| File | Role |
|---|---|
| `web/src/lib/viewTransition.ts` | `markVtDirection(dir)` tags `<html data-vt-dir>` and self-clears after `--vt-dur + 700ms`. Generic already. |
| `web/src/styles/transitions.css` | All the VT keyframes/rules, keyed to the `bk-card` view-transition-name and the `.bk-vt` / `.bk-page-root.bk-vt` selectors. |
| `web/src/routes/Home.tsx` | The hub. Camera **pan** (`.hub-pan` + `panRef`), the `onBostadCardClick` handler, the `bk-vt` class on the Bostadskalkyl `<Link>`, `viaBack` entrance suppression. **Header is a sibling of `.hub-pan`, not a child** (a transform on `.hub-pan` breaks the sticky header — keep it outside). |
| `web/src/routes/ScenariosDashboard.tsx` | The destination. Root `<div className={'bk-page-root' + (bkActive ? ' bk-vt' : '')}>`, the `viaWhoosh → entranceInstant` entrance suppression, and the `‹ Hemma` back-link with `viewTransition` + `markVtDirection('back')`. |

How a forward trip runs, end to end:
1. Card click → `e.preventDefault()`, WAAPI **pan** of `.hub-pan` translates the
   clicked card to screen-centre (760ms).
2. On `.finished` → `markVtDirection('forward')` then
   `navigate(path, { viewTransition: true })`.
3. React Router wraps the nav in `document.startViewTransition`. The hub card and
   the destination root **share `view-transition-name: bk-card`**, so the browser
   renders the destination shrunk into the card's slot and grows it to fill the
   screen. The hub (`old(root)`) scales up + fades ("dive"). Corners morph via
   `clip-path`.
4. `data-vt-dir` self-clears ~`--vt-dur + 700ms` later.

Key behaviours that already work and must be preserved:
- **Solidity:** `.bk-page-root.bk-vt { background: var(--paper); min-height: 100svh }`
  makes the snapshot a solid, full-length page (no see-through, no stub).
- **Corner clipping uses `clip-path: inset(0 round …)`, NOT `border-radius`** —
  border-radius can't clip a VT snapshot pseudo (overflow is visible).
- **Entrance suppression:** the destination captures `viaWhoosh`
  (`data-vt-dir === 'forward'` at mount) and the hub captures `viaBack`
  (`=== 'back'`) so each page freezes its own mount entrance during the whoosh
  (otherwise rows/numbers "pop in" after the zoom).

---

## Target design (generic, multi-tool)

The trick: **a single shared `view-transition-name` works for all tools**,
because only one transition is ever live at a time. Rename `bk-card` →
`tool-card` and split the marker class so cards and page-roots both claim the
same name during their own transition.

### The one genuinely tricky bit — back-trip disambiguation

On the **forward** trip there is no ambiguity: only the clicked card has
`useViewTransitionState('/its-path') === true`, so only it claims the name.

On the **back** trip every hub card sees `useViewTransitionState('/') === true`
(they all watch the same `/` target). If every card claimed `tool-card` on the
way back you'd have **multiple elements with the same view-transition-name → the
transition throws / falls back**. So the hub must know **which tool we are
returning from** and name only that one card.

**Solution (consistent with the existing `data-vt-dir` mechanism):** record the
active tool path on `<html>` at click time, and gate the card on it.

```ts
// viewTransition.ts — extend the helper. Since the #177 fix the tag is cleared
// by clearVtTag() on the real VT's `.finished` (patched startViewTransition),
// NOT a parsed timer — so clearVtTag() must delete BOTH `vtDir` and `vtTool`.
export function markVtTransition(toolPath: string, dir: 'forward' | 'back'): void {
  const el = document.documentElement
  el.dataset.vtDir = dir
  el.dataset.vtTool = toolPath          // NEW: which tool is whooshing
  ensurePatched()                       // existing: clears BOTH tags on VT .finished
}
export function activeVtTool(): string | null {
  return (typeof document === 'undefined' ? null : document.documentElement.dataset.vtTool) ?? null
}
```

Then a hub-card hook (reads the attr the same way `viaBack`/`viaWhoosh` already
read `data-vt-dir`):

```ts
// hub card: claims the name on forward (arriving) OR on the back trip that
// targets THIS card.
export function useToolCardActive(path: string): boolean {
  const arriving = useViewTransitionState(path)   // forward → this tool
  const returning = useViewTransitionState('/')    // back → hub (true for all cards)
  return arriving || (returning && activeVtTool() === path)
}
```

The destination side has only **one** root, so no disambiguation is needed —
identical to today's dashboard:

```ts
// tool page: the single page root
export function useToolPageActive(path: string): boolean {
  const arriving = useViewTransitionState(path)
  const returning = useViewTransitionState('/')
  return arriving || returning
}
```

> Rules-of-hooks: call `useViewTransitionState` unconditionally — never collapse
> two calls with `||` on one line (it short-circuits the second hook). This bit
> the PoC; see the `arriving`/`returning` split in `Home.tsx`.

---

## Step-by-step

### Phase 0 — Setup
1. Confirm PR #176 is merged to `main`. From `main`: `git checkout main && git pull`.
2. Branch: `git checkout -b ui/tool-transitions-propagation`.
3. `cd web && npm run dev` and confirm the Bostadskalkyl card→dashboard
   transition works as the reference before changing anything.

### Phase 1 — Generalize the core (refactor, **zero behaviour change**)
Goal: make Bostadskalkyl run through the generic plumbing, verify it's
pixel-identical, then everything else is "add another tool".

1. **`viewTransition.ts`**: add `markVtTransition(path, dir)` + `activeVtTool()`
   (above). Keep `markVtDirection` as a thin wrapper or replace its call sites.
   Make the self-clear delete **both** `vtDir` and `vtTool`.
2. **New hooks module** `web/src/lib/toolTransition.ts` (or `hooks/`): export
   `useToolCardActive(path)` and `useToolPageActive(path)` (above).
3. **`transitions.css`** — rename, don't rewrite the choreography:
   - `bk-card` → `tool-card` everywhere (the IDE selection is on line ~20).
   - Split the marker class:
     ```css
     .vt-card { view-transition-name: tool-card; }                 /* hub cards */
     .vt-page {                                                     /* tool page roots */
       view-transition-name: tool-card;
       background: var(--paper);
       min-height: 100svh;
     }
     ```
   - Replace the old `.bk-vt` rule and `.bk-page-root.bk-vt` rule with the two
     above. Leave every keyframe (`vt-dive`, `vt-grow-round`, `vt-shrink-round`,
     `vt-solid`, `vt-hidden`, `vt-late-in`) and the back-scoped
     `::view-transition-group(tool-card)` delay **unchanged** except the name.
4. **`Home.tsx`** (Bostadskalkyl card only, for now): replace
   `bkActive`/`bk-vt` with `useToolCardActive('/bostadskalkyl')` and the `vt-card`
   class; have `startWhoosh`/`onBostadCardClick` call
   `markVtTransition('/bostadskalkyl', 'forward')`.
5. **`ScenariosDashboard.tsx`**: root class `bk-vt → vt-page` via
   `useToolPageActive('/bostadskalkyl')`; back-link
   `onClick={() => markVtTransition('/bostadskalkyl', 'back')}`.
6. **Verify Bostadskalkyl is unchanged** (Verification protocol below). Commit:
   `refactor(transitions): generalise the whoosh plumbing (no behaviour change)`.

### Phase 2 — Generalise the hub camera-pan handler
In `Home.tsx`, turn `onBostadCardClick` into a path-parameterised handler and
point `startWhoosh` at the path:

```ts
const startWhoosh = (path: string) => {
  markVtTransition(path, 'forward')
  navigate(path, { viewTransition: true })
}
const onToolCardClick = (e: React.MouseEvent<HTMLAnchorElement>, path: string) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
  e.preventDefault()
  const pan = panRef.current
  if (prefersReducedMotion() || !pan) { startWhoosh(path); return }
  const r = e.currentTarget.getBoundingClientRect()
  const dx = window.innerWidth / 2 - (r.left + r.width / 2)
  const dy = window.innerHeight / 2 - (r.top + r.height / 2)
  pan.animate(
    [{ transform: 'translate(0,0)' }, { transform: `translate(${dx}px,${dy}px) scale(1.04)` }],
    { duration: 760, easing: 'cubic-bezier(0.4,0,0.2,1)', fill: 'forwards' },
  ).finished.then(() => startWhoosh(path), () => startWhoosh(path))
}
```

`viaBack` + `.hub-pan.no-reveal .reveal` already suppresses the hub's rise-in on
**every** back trip — no per-card change needed there.

### Phase 3 — Wire the hub cards
For **each** of the 5 Live `<Link>`s in `Home.tsx`, mirror the Bostadskalkyl card:
- `className={'app-card reveal reveal-N' + (useToolCardActive(path) ? ' vt-card' : '')}`
  — call `useToolCardActive(path)` once per card at the top of the component
  (fixed count, fine for rules-of-hooks).
- `onClick={(e) => onToolCardClick(e, path)}`
- Keep `onPointerMove`/`onPointerLeave` and the `reveal-N` ordering as-is.
- Do **not** add the `viewTransition` prop to the `<Link>` — the click handler
  drives the transition manually.

### Phase 4 — Wire each tool page (do ONE first as the template)
**Recommended template: Löneväxling or Konsultkalkyl** (NumberFlow only, no
charts → lowest-risk). Get one perfect end-to-end, then replicate.

Per tool route file (`Konsultkalkyl.tsx`, `Lonevaxling.tsx`, `Bolanekoll.tsx`,
`Manadsavslut.tsx`, `Hushallsbudget.tsx`):

1. **Find the outermost wrapper** returned by the default-exported route
   component (e.g. Hushållsbudget's is `.hb-root`). Add the page class:
   ```tsx
   const active = useToolPageActive('/konsultkalkyl')
   // ...
   <div className={'…existing…' + (active ? ' vt-page' : '')}>
   ```
   If the root is a fragment, wrap it in a single element so there is one node to
   carry `view-transition-name`.
2. **Back-link** (every tool has `<Link className="hub-link" to="/">‹ Hemma</Link>`):
   add `viewTransition` and the marker:
   ```tsx
   <Link className="hub-link" to="/" viewTransition
         onClick={() => markVtTransition('/konsultkalkyl', 'back')}>‹ Hemma</Link>
   ```
3. **Entrance suppression** (Phase 5 — the bespoke part).
4. Build/lint/test + Playwright-verify this tool. Commit per tool:
   `feat(transitions): whoosh for Konsultkalkyl`.

### Phase 5 — Per-tool entrance suppression (the bespoke part)
On the **forward** trip the VT snapshots the destination at mount, freezing any
mount entrance, which then "pops in" after the zoom. Suppress it.

Generic pattern (copy from `ScenariosDashboard.tsx`):
```ts
const [viaWhoosh] = useState(
  () => typeof document !== 'undefined' && document.documentElement.dataset.vtDir === 'forward',
)
const entranceInstant = reduce || viaWhoosh
```
Then, **for each entrance animation the tool actually has**, render the settled
state when `entranceInstant`:
- **NumberFlow count-up-from-zero on mount** (Konsultkalkyl, Hushållsbudget):
  start the value at its final number instead of 0 when `entranceInstant`
  (see `ScenarioCard`'s `countUp` prop for the exact technique). Live edits must
  still animate — only the *mount* roll is suppressed.
- **Motion `initial/animate`/`variants` + `staggerChildren`**: set the stagger to
  0 and use the settled variant when `entranceInstant`.
- **CSS `.reveal`-style rise-ins**: add a no-reveal gate like the hub's
  `.hub-pan.no-reveal .reveal { animation: none !important }`.
- **visx charts (Bolånekoll, Månadsavslut, Hushållsbudget donut)** — higher risk:
  a chart that animates/measures (`ParentSize`) on mount can pop or jank under
  the VT. If a chart animates in, render it settled when `entranceInstant`; if it
  measures with `ParentSize`, confirm it doesn't reflow mid-transition (this was
  the plan-04 jank class). Verify each chart tool with slow-mo frames.

> If a tool hydrates store data asynchronously on mount, warm it on the hub so the
> snapshot isn't empty — the hub already calls `useStore.getState().hydrate()` for
> the scenarios store; add equivalents only if a tool actually shows empty-then-pop.

---

## Landmines (read before you start — each cost real time on the PoC)

1. **Corners need `clip-path`, not `border-radius`.** A VT snapshot pseudo has
   `overflow: visible`; `border-radius` won't clip it → square white corners.
   The keyframes already use `clip-path: inset(0 round …)` — keep it.
2. **Keep sticky/fixed headers OUT of any transformed wrapper.** The hub's camera
   pan transforms `.hub-pan`; a transform changes a sticky child's containing
   block and drags it into frame. The hub header is already a sibling of
   `.hub-pan` — don't move it back in. (Tool pages don't get a camera pan, so
   their own sticky headers are fine.)
3. **`data-vt-dir` / `data-vt-tool` self-clear must outlast the VT.** Already
   handled (`--vt-dur + 700ms`); don't hardcode a shorter timer.
4. **Rules-of-hooks:** call `useViewTransitionState` unconditionally; never
   `useVTS(a) || useVTS(b)` on one line.
5. **Multiple `tool-card` names = thrown transition.** This is the back-trip
   disambiguation — only the returning tool's card may carry `.vt-card`. Use
   `activeVtTool()`.
6. **Don't add the camera pan to tool pages.** Only the hub pans; the back trip is
   the two-stage close, no reverse pan.
7. **Playwright instrumenting trap:** never re-wrap React Router's
   `startViewTransition` update callback with extra awaits/rAFs → "Transition was
   aborted because of timeout in DOM update". Record at call-time only.

---

## Verification protocol (per tool + final)

Mechanical (must pass before each commit), run in `web/`:
```
npm run build && npx oxlint src && npx vitest run
```
(Expect the 2 pre-existing `App.tsx` fast-refresh warnings; 105 tests green.)

Feel / visual (animation feel needs the human's eye, but verify the mechanics):
- Run `npm run dev`. In the browser, slow the transition by setting
  `--vt-dur` for inspection: `document.documentElement.style.setProperty('--vt-dur','6000ms')`
  (clear it after). The PoC used Playwright with this override to grab mid-frames.
- Confirm, forward and back, for the tool:
  - No **pop-in** after the zoom (entrance suppression works).
  - **Solid** page during the zoom (no see-through) and **full-length** (no stub).
  - **Rounded corners** the whole shrink / the two-stage close on the way back
    (sample `getComputedStyle(document.documentElement,'::view-transition-old(tool-card)').clipPath`
    → `inset(0px round 18px)` mid-shrink).
  - Header not dragged into frame when clicking the card **scrolled to the bottom**
    of the hub.
- Reduced-motion (`prefers-reduced-motion`) → instant navigation, no animation.

---

## Recommended sequence
1. Phase 0–2 (core generalise + handler) — verify Bostadskalkyl unchanged.
2. **Löneväxling** (template; NumberFlow=0, no chart — simplest).
3. **Konsultkalkyl** (NumberFlow count-up — exercises the count-up suppression).
4. **Månadsavslut**, **Bolånekoll** (visx charts — verify no chart pop/jank).
5. **Hushållsbudget** (NumberFlow + donut chart + the chart-overlay — most moving
   parts; do last).

## Definition of done
- All 5 Live cards play the forward dive and the two-stage back close, matching
  Bostadskalkyl.
- No pop-ins, no see-through, no square corners, no stuck header, on any tool,
  forward or back.
- `npm run build` / `oxlint` / `vitest` green.
- One branch `ui/tool-transitions-propagation`, one PR to `main`, **base = main**
  (no stacking), per-tool commits for reviewability.

## Reference: copy from these exact spots
- Click handler + pan: `Home.tsx` `onBostadCardClick` / `startWhoosh` / `panRef`.
- Card naming + hooks pattern: `Home.tsx` `arriving`/`returning`/`bkActive`.
- Page root + entrance suppression + back-link: `ScenariosDashboard.tsx`.
- All keyframes/rules: `transitions.css` (rename `bk-card`→`tool-card`, split
  `.bk-vt`→`.vt-card`/`.vt-page`; leave choreography untouched).
- Direction tagging + self-clear: `viewTransition.ts`.
