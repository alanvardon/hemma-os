// calc.test.js — unit tests for pure calculation functions
// Loads functions from calc.js via require().

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Load from calc.js (the IIFE sets window.App.calc; the CJS tail exports it)
// Provide a minimal window stub so the IIFE does not throw in Node
global.window = global.window || {};
const calc = require('./calc.js');

const { lagfart, pantbrevCost, ranteavdrag, fastighetsavgiftCap, equityPct } = calc;

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
