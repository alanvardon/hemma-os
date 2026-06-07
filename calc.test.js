// calc.test.js — unit tests for pure calculation functions
// Loads functions from calc.js via require().

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Load from calc.js (the IIFE sets window.App.calc; the CJS tail exports it)
// Provide a minimal window stub so the IIFE does not throw in Node
global.window = global.window || {};
const calc = require('./calc.js');

const { lagfart, pantbrevCost, ranteavdrag, fastighetsavgiftCap, equityPct, cashToClose } = calc;

// ── Tests ────────────────────────────────────────────────────────

test('lagfart: 2 000 000 kr property', () => {
  assert.equal(lagfart(2_000_000), 30_000);
});

test('lagfart: zero property price', () => {
  assert.equal(lagfart(0), 0);
});

test('pantbrevCost: loan exceeds existing pantbrev', () => {
  assert.equal(pantbrevCost(1_500_000, 1_000_000), 10_000);
});

test('pantbrevCost: loan does not exceed existing pantbrev', () => {
  assert.equal(pantbrevCost(800_000, 1_000_000), 0);
});

test('ranteavdrag: interest below threshold (80 000)', () => {
  assert.equal(ranteavdrag(80_000), 24_000);
});

test('ranteavdrag: interest exactly at threshold (100 000)', () => {
  assert.equal(ranteavdrag(100_000), 30_000);
});

test('ranteavdrag: interest above threshold (150 000)', () => {
  assert.equal(ranteavdrag(150_000), 40_500);
});

test('equityPct: standard case', () => {
  assert.equal(equityPct(1_500_000, 2_000_000), 75);
});

test('equityPct: zero price returns 0', () => {
  assert.equal(equityPct(0, 0), 0);
});

test('fastighetsavgiftCap: above cap', () => {
  assert.equal(fastighetsavgiftCap(12_000), 9_287);
});

test('fastighetsavgiftCap: below cap', () => {
  assert.equal(fastighetsavgiftCap(6_000), 6_000);
});

// ── cashToClose tests ─────────────────────────────────────────────

// Acceptance criterion 6: CommonJS export must resolve to a function
test('cashToClose: exported as a function via CommonJS (require)', () => {
  assert.equal(typeof cashToClose, 'function');
});

// Acceptance criterion 7: IIFE return object must also carry the export
test('cashToClose: exported as a function on window.App.calc (IIFE return)', () => {
  assert.equal(typeof window.App.calc.cashToClose, 'function');
});

// Acceptance criterion 1: 15%-floor wins when implied down payment < 15% of price
// price=3 000 000, loan=2 600 000 → implied=400 000 < floor=450 000 → use 450 000
test('cashToClose: 15%-floor wins over implied down payment (price 3 000 000, loan 2 600 000)', () => {
  const expected = 450_000 + lagfart(3_000_000) + pantbrevCost(2_600_000, 0);
  assert.equal(cashToClose(3_000_000, 2_600_000, 0), expected);
});

// Acceptance criterion 2: actual down payment wins when it exceeds 15% floor
// price=3 000 000, loan=2 000 000 → implied=1 000 000 > floor=450 000 → use 1 000 000
test('cashToClose: actual down payment wins over 15%-floor (price 3 000 000, loan 2 000 000)', () => {
  const expected = 1_000_000 + lagfart(3_000_000) + pantbrevCost(2_000_000, 0);
  assert.equal(cashToClose(3_000_000, 2_000_000, 0), expected);
});

// Acceptance criterion 3: lagfart is always included — result exceeds bare down payment by at least lagfart(price)
test('cashToClose: result exceeds bare down-payment by at least lagfart(price)', () => {
  const price = 2_500_000;
  const loanAmount = 1_500_000;
  const downPayment = Math.max(price * 0.15, price - loanAmount);
  const result = cashToClose(price, loanAmount, 0);
  assert.ok(
    result >= downPayment + lagfart(price),
    `cashToClose ${result} should be >= downPayment(${downPayment}) + lagfart(${lagfart(price)})`
  );
});

// Acceptance criterion 4: pantbrevCost is always included — result exceeds bare down payment by at least pantbrevCost(loanAmount, 0)
test('cashToClose: result exceeds bare down-payment by at least pantbrevCost(loanAmount, 0)', () => {
  const price = 2_500_000;
  const loanAmount = 1_500_000;
  const downPayment = Math.max(price * 0.15, price - loanAmount);
  const result = cashToClose(price, loanAmount, 0);
  assert.ok(
    result >= downPayment + pantbrevCost(loanAmount, 0),
    `cashToClose ${result} should be >= downPayment(${downPayment}) + pantbrevCost(${pantbrevCost(loanAmount, 0)})`
  );
});

// Acceptance criterion 5: existing pantbrev reduces new pantbrev cost (existingPantbrev correctly forwarded)
test('cashToClose: existing pantbrev reduces the pantbrev cost component', () => {
  const price = 3_000_000;
  const loanAmount = 2_000_000;
  const withNoPantbrev = cashToClose(price, loanAmount, 0);
  const withExistingPantbrev = cashToClose(price, loanAmount, 2_000_000);
  // With existing pantbrev covering the whole loan, pantbrevCost should be 0
  const expectedReduction = pantbrevCost(loanAmount, 0) - pantbrevCost(loanAmount, 2_000_000);
  assert.equal(withNoPantbrev - withExistingPantbrev, expectedReduction);
});

// Acceptance criterion 5 (no mutation): lagfart still returns expected values after cashToClose is defined
test('lagfart: unchanged — still returns 1.5% of price after cashToClose addition', () => {
  assert.equal(lagfart(3_000_000), 45_000);
});

// Acceptance criterion 5 (no mutation): pantbrevCost still returns expected values after cashToClose is defined
test('pantbrevCost: unchanged — still returns 2% of new loan portion after cashToClose addition', () => {
  assert.equal(pantbrevCost(2_000_000, 0), 40_000);
});
