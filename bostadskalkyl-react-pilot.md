# Bostadskalkyl → React + Vite — pilot roadmap

**Status:** Phase 0 (scaffold) in progress · **Branch:** `ui/bostadskalkyl-react`
**Goal:** maximum craft — make bostadskalkyl a showstopping UI/UX, then roll proven patterns to the rest of the Hemma suite. *Not* a job-hunt artifact; framework chosen for the deepest motion + data-viz ecosystem.

## Decisions (locked via grilling, 2026-06-23)

| Decision | Choice | Why |
|---|---|---|
| Goal | Max craft ("how good can I get it") | Not employment; ignore CV-keyword value |
| Build | Migrate off zero-build vanilla | Tame the 2000-line state files + unlock declarative motion |
| Framework | **React + Vite + TypeScript** | Deepest motion (Motion) + data-viz (visx) ecosystem; TS = math safety |
| Scope | **Pilot bostadskalkyl first**, then roll to the suite | De-risk; learn-as-you-go |
| Aesthetic | **Keep & elevate** the Nordic-editorial identity | The look is already a strength; gaps are motion / data-viz / micro-detail, not identity |
| Coexistence | **Isolated `web/` subfolder + branch-preview deploy** | Live static suite stays untouched during the pilot; converge to multi-page Vite root later |

## Accepted stack

- **React 19 + Vite + TypeScript** (Vitest for unit tests)
- **Styling:** port the existing CSS-var design system verbatim into `tokens.css`; components use CSS Modules. **Not Tailwind** (would shred the bespoke editorial system). vanilla-extract optional later for type-safe tokens.
- **Headless primitives:** Radix UI (Dialog / Slider / Switch / Tooltip) — replaces hand-rolled `modals.js`
- **Motion:** `motion` (ex-Framer-Motion, import `motion/react`) + `@number-flow/react` for animated figures; gate on `useReducedMotion` / `respectMotionPreference`
- **Data-viz:** visx (`@visx/*` per-package) — bespoke editorial charts
- **State:** Zustand (scenarios / activeScenarioId / isDirty / theme / drift / savings) + a pure `derive(inputs)`
- **Signature later:** View Transitions API, `cmdk` palette, `sonner` toasts
- **Standards:** OKLCH palette, container queries (fixes the 390px header collision), fluid `clamp()` type, Lighthouse/axe to 100

## Source architecture → React mapping

| Today (vanilla) | Becomes |
|---|---|
| `calc.js` (pure, CJS-exported, tested) | `src/lib/calc.ts` — typed named exports + one `derive(inputs): Figures` |
| `recalc()` in `app.js` (reads inputs, writes ~50 DOM nodes by id) | `derive(inputs)` (pure) → JSX renders figures |
| `dom.js` `set`/`val` | Gone (JSX + state) |
| `storage.js` (async Promise API, versioned localStorage keys) | `src/lib/storage.ts` — **same signatures, same keys** → existing saved data carries over; Supabase swap stays one file |
| `modals.js` overlays | Radix Dialog components |
| `charts.js` (Chart.js / canvas reading CSS vars) | visx components reading the same CSS vars via `getComputedStyle` |
| `markDirty()` → `saveSession()` | debounced effect → `storage.saveSession()` |
| `val-flash` CSS animation | NumberFlow digit spin |

## Directory layout

```
web/
├── index.html               # keeps the pre-paint theme <script> verbatim
├── vite.config.ts · vitest.config.ts · tsconfig*.json
├── src/
│   ├── main.tsx · App.tsx    # two-column layout shell
│   ├── styles/  tokens.css (verbatim port) · global.css
│   ├── lib/     calc.ts · calc.test.ts · storage.ts · format.ts
│   ├── store/   useAppStore.ts (Zustand)
│   ├── hooks/   useInputs.ts
│   ├── components/ inputs/ · summary/ · charts/ · ui/(Radix wrappers)
│   └── modals/  ScenariosModal · SavePrompt · DriftModal · SavingsModal
└── tests/e2e/   Playwright parity + visual-regression
```

## Regression baseline (the "pixel-match today" guarantee)

1. **Numerical (golden test):** port `calc.test.js` → Vitest + a golden test asserting today's default-input figures — `cashBalance = 1 535 500`, `loanAmount = 5 850 000`, `netProceeds = 2 360 000`, Bank A total `30 623`, ränteavdrag `4 333/mo`, etc. Fails if `derive()` drifts from legacy math.
2. **Visual:** baseline screenshots captured 2026-06-23 (`bk-desktop-full.png`, `bk-dark.png`, `bk-mobile.png`, scrolled, chart). Phase 2 milestone = Playwright `toHaveScreenshot` diff under threshold.
3. **Behavioral:** e2e that drives inputs and checks the summary updates.

## Phases (each independently shippable; one PR per phase, base = main, no stacking)

- **0 — Scaffold + tokens** *(behavior-free)*: `web/` Vite React-TS, port `tokens.css`/fonts/theme bootstrap, empty two-column shell. *Visible: themed blank layout.*
- **1 — Pure core**: `calc.ts` + `derive()`; Vitest port + golden test green. *Numerical parity before UI.*
- **2 — Inputs + summary (parity)**: all input sections + summary cards wired to `derive()`, pixel-matched; reusable `CurrencyInput` (focus→raw / blur→spaced / arrow ±10k, shift ±100k). *Drop-in parity milestone.*
- **3 — Persistence**: `storage.ts` (same keys), Zustand, autosave, scenarios modal + save prompt + theme toggle (Radix). *Functional replacement reading existing data.*
- **4 — Motion**: NumberFlow (SEK) on every figure, Motion section reveals + derived-row transitions, reduced-motion gated. *First "wow."*
- **5 — Charts**: visx amort (reuse `buildAmortSchedule`) + equity-over-time + stress curve; `layoutId` card→fullscreen morph. *Biggest visual upgrade.*
- **6 — Standards**: OKLCH, container queries (mobile header fix), Lighthouse/axe, wire visual-regression e2e.

## Risks / landmines

- **Branch first**, never commit to main; one PR per phase, base=main (no stacking).
- **Keep localStorage keys identical** or the family's saved scenarios orphan.
- **Don't add a root build command** that disturbs the live static deploy; pilot deploys via branch-preview until convergence.
- `static-checks` targets the vanilla files only → the React app needs its own gate: ESLint + `tsc --noEmit` + Vitest.
- Repo PreToolUse hook `inspect-script.sh` blocks executing raw script files; npm-script-driven `vite`/`vitest` are fine.
- Libraries installed per-phase (not all front-loaded) → no unused deps; fetch each lib's current setup docs (Context7) at point of use.
