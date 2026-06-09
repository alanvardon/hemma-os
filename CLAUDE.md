# Bostadskalkyl — codebase guide

## Entry points

- `index.html` — homepage (site landing page)
- `kalkyl.html` — open `kalkyl.html` in a browser to launch the calculator

## Architecture

All calculator logic lives in plain vanilla JS files loaded by `kalkyl.html`:

| File | Responsibility |
|---|---|
| `app.js` | `App.recalc()` — single recalculation entry point; reads every input, computes every derived value, writes to DOM |
| `calc.js` | Pure calculation functions (lagfart, pantbrev, ränteavdrag, amortisation, …) |
| `dom.js` | DOM helpers: `val()`, `set()`, `fmt()`, currency/number input formatting |
| `storage.js` | `readInputs()` / `writeInputs()` — localStorage persistence under `bostadskalkyl_*_v1` keys |
| `modals.js` | Modal open/close helpers; every modal follows the backdrop-click + × button pattern |
| `charts.js` | Chart.js wrappers for payoff and cost charts |

## CSS conventions

- All colours and fonts are declared as CSS custom properties in `:root` inside `styles.css`
- Never hardcode colours — always reference a `var(--…)` token
- Fonts: DM Sans (body) and DM Serif Display (headings) only

## JS conventions

- All new derived values must be calculated and set inside `App.recalc()`
- All new inputs must be read inside `App.recalc()` via `val()`
- Currency inputs: add `data-type="currency"` attribute and register in `CURRENCY_IDS`
- Number inputs: register in `NUMBER_IDS`; text inputs: register in `TEXT_IDS`
- localStorage keys must use the `bostadskalkyl_*_v1` versioned naming convention
- One-writer rule: each `window.App.*` key must have exactly one writer file

## Modals

Follow the open/close pattern already in place:
- Every modal needs a `×` close button
- Every modal backdrop must close the modal on click (click-outside-to-close)
