# QA failures

## renderAmortChart called as bare global in modals.js — runtime crash

**File:** `modals.js`, line 254

**Code:**
```js
function openAmortModal() {
  document.getElementById('amortModal').classList.add('open');
  renderAmortChart();  // global from charts.js
}
```

`renderAmortChart` is defined inside the `charts.js` IIFE (line 34 of charts.js) and is not exposed as a window global. Calling it as a bare identifier will throw `ReferenceError: renderAmortChart is not defined` every time the amort modal is opened via the "View payoff chart ›" card.

The plan (Commit 2e step 2) explicitly states: "In `app.js` and `modals.js`, replace direct calls with `App.charts.*`." The correct call is `App.charts.renderAmortChart()`.

## Suggested next steps

In `modals.js` line 254, change:
```js
renderAmortChart();  // global from charts.js
```
to:
```js
App.charts.renderAmortChart();
```
