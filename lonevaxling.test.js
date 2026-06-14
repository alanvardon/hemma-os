/* lonevaxling.test.js — pure-function tests for the löneväxling model.
   Run: node --test lonevaxling.test.js */
const test = require('node:test');
const assert = require('node:assert');
const L = require('./lonevaxling.js');

const near = (a, b, tol = 1) =>
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (±${tol})`);

// ── Constants ──────────────────────────────────────────────────────
test('pension ceiling is 8.07 × IBB ÷ 12 ≈ 56 087 kr/mån', () => {
  near(L.PENSION_CEILING_YR, 8.07 * 83400, 0.001);
  near(L.PENSION_CEILING_YR / 12, 56086.5, 1);
});

test('default uplift is the 31.42 % → 24.26 % payroll-tax arbitrage ≈ 5.76 %', () => {
  near(L.DEFAULT_UPLIFT, ((1.3142 / 1.2426) - 1) * 100, 0.01);
  near(L.DEFAULT_UPLIFT, 5.76, 0.02);
});

test('SGI ceiling is 10 × PBB', () => {
  near(L.SGI_CEILING_YR, 10 * 59200, 0.001);
});

// ── netEmploymentSalary ────────────────────────────────────────────
test('net salary: zero gross → zero, positive gross is taxed but positive', () => {
  near(L.netEmploymentSalary(0, 0.3238).net, 0, 0.001);
  const r = L.netEmploymentSalary(720000, 0.3238);
  assert.ok(r.net > 0 && r.net < 720000, 'net is between 0 and gross');
  assert.ok(r.stateTax > 0, 'a 720k salary pays some statlig skatt');
});

// ── computeLonevaxling: the core scenario (defaults) ───────────────
test('default scenario: marginal ≈ 52.4 % (fully above brytpunkt, below JSA phase-out)', () => {
  const r = L.computeLonevaxling(); // 65 000 gross, 5 000 sacrifice, 32.38 % kommunal
  near(r.marginalRateNow, 0.3238 + 0.20, 0.003);
  // tax saved is the slice you don't keep; net given up is the rest
  near(r.netGivenUp + r.taxSavedNow, r.sacrifice, 1);
});

test('premium applies the employer uplift; net pension nets the withdrawal tax', () => {
  const r = L.computeLonevaxling({ grossSalaryMonthly: 65000, sacrificeMonthly: 5000, upliftPct: 5.76, withdrawalTaxPct: 32 });
  near(r.premiumToPension, 60000 * 1.0576, 1);          // sacrifice 60 000/yr
  near(r.upliftAmount, 60000 * 0.0576, 1);
  near(r.netPensionValue, r.premiumToPension * 0.68, 1);
});

test('leverage > 1 when you defer at 52 % and withdraw at 32 %', () => {
  const r = L.computeLonevaxling({ grossSalaryMonthly: 65000, sacrificeMonthly: 5000, withdrawalTaxPct: 32 });
  assert.ok(r.leverage > 1.3, `leverage ${r.leverage} should clear 1.3`);
  near(r.leveragePct, (r.leverage - 1) * 100, 0.001);
});

// ── Optimal-sacrifice suggestion ───────────────────────────────────
test('suggested sacrifice = salary down to the pension ceiling', () => {
  const r = L.computeLonevaxling({ grossSalaryMonthly: 65000 });
  near(r.suggestedSacrifice, 65000 - L.PENSION_CEILING_YR / 12, 1);
  near(r.maxSafeSacrifice, r.suggestedSacrifice, 0.001);
});

// ── Eligibility & flags ────────────────────────────────────────────
test('below the ceiling → not eligible, flag fires', () => {
  const r = L.computeLonevaxling({ grossSalaryMonthly: 50000, sacrificeMonthly: 3000 });
  assert.equal(r.eligible, false);
  assert.equal(r.flags.notEligible, true);
  near(r.maxSafeSacrifice, 0, 0.001);
});

test('over-sacrificing under the ceiling flags overSacrificed (not notEligible)', () => {
  const r = L.computeLonevaxling({ grossSalaryMonthly: 60000, sacrificeMonthly: 6000 });
  assert.equal(r.flags.notEligible, false);
  assert.equal(r.flags.overSacrificed, true);   // cash 54 000 < ceiling 56 087
  assert.equal(r.flags.belowBrytpunkt, true);   // 54 000 < brytpunkt ~55 033
});

test('deep sacrifice dips below the SGI ceiling', () => {
  const r = L.computeLonevaxling({ grossSalaryMonthly: 60000, sacrificeMonthly: 12000 });
  assert.equal(r.flags.belowSgi, true);          // cash 48 000 < 49 333
});

test('a high withdrawal rate flags "no tax-rate gain"', () => {
  const r = L.computeLonevaxling({ grossSalaryMonthly: 65000, sacrificeMonthly: 5000, withdrawalTaxPct: 55 });
  assert.equal(r.flags.withdrawalNotBelowMarginal, true);
});

// ── Edge: zero sacrifice ───────────────────────────────────────────
test('zero sacrifice → all-zero outputs, no divide-by-zero', () => {
  const r = L.computeLonevaxling({ grossSalaryMonthly: 65000, sacrificeMonthly: 0 });
  near(r.netGivenUp, 0, 0.001);
  near(r.taxSavedNow, 0, 0.001);
  near(r.premiumToPension, 0, 0.001);
  near(r.marginalRateNow, 0, 0.001);
  near(r.leverage, 0, 0.001);
  assert.equal(r.flags.belowSgi, false);
  assert.equal(r.flags.belowBrytpunkt, false);
});
