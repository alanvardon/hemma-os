'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// salary-store.js is a browser IIFE (attaches to window.App, no module.exports),
// so we run its source in a VM sandbox that supplies the browser globals it
// touches — localStorage + window — and read the store back off window.App.
// Each call gets a fresh in-memory localStorage, so tests don't bleed state.
const SRC = fs.readFileSync(path.join(__dirname, 'salary-store.js'), 'utf8');

function freshStore() {
  const mem = {};
  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
    setItem(k, v) { mem[k] = String(v); },
    removeItem(k) { delete mem[k]; }
  };
  // window.crypto omitted on purpose → exercises the _id() fallback path.
  const sandbox = { window: { App: {} }, localStorage };
  vm.runInNewContext(SRC, sandbox);
  return { store: sandbox.window.App.salaryStore, localStorage };
}

test('add stamps id + created_at and writes a version-2 envelope', async () => {
  const { store, localStorage } = freshStore();
  const saved = await store.add({ month: '2026-06', income_a: 100, income_b: 50, income_items: [] });
  assert.ok(saved.id, 'id is stamped');
  assert.ok(saved.created_at, 'created_at is stamped');
  const raw = JSON.parse(localStorage.getItem(store.STORAGE_KEY));
  assert.equal(raw.version, 2);
  assert.equal(raw.submissions.length, 1);
  assert.equal(raw.submissions[0].month, '2026-06');
});

test('list returns submissions newest-first by created_at', async () => {
  const { store } = freshStore();
  await store.add({ month: '2026-04', created_at: '2026-04-01T00:00:00.000Z' });
  await store.add({ month: '2026-06', created_at: '2026-06-01T00:00:00.000Z' });
  await store.add({ month: '2026-05', created_at: '2026-05-01T00:00:00.000Z' });
  const rows = await store.list();
  assert.deepEqual(rows.map((r) => r.month), ['2026-06', '2026-05', '2026-04']);
});

test('remove deletes by id and resolves the remaining count', async () => {
  const { store } = freshStore();
  const first = await store.add({ month: '2026-06' });
  await store.add({ month: '2026-07' });
  const remaining = await store.remove(first.id);
  assert.equal(remaining, 1);
  const rows = await store.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].month, '2026-07');
});

test('a corrupt stored value yields an empty log instead of throwing', async () => {
  const { store, localStorage } = freshStore();
  localStorage.setItem(store.STORAGE_KEY, '{ not json');
  const rows = await store.list();
  assert.deepEqual(rows, []);
});

test('v1 rows migrate forward: income_items synthesised, envelope reads as v2', async () => {
  const { store, localStorage } = freshStore();
  // A legacy v1 envelope: scalar totals, no income_items.
  localStorage.setItem(store.STORAGE_KEY, JSON.stringify({
    version: 1,
    submissions: [{ id: 'old', month: '2026-01', income_a: 40000, income_b: 30000, created_at: '2026-01-01T00:00:00.000Z' }]
  }));
  const rows = await store.list();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].income_items, [
    { owner: 'a', label: 'Lön / Salary', amount: 40000 },
    { owner: 'b', label: 'Lön / Salary', amount: 30000 }
  ]);
  const dump = JSON.parse(await store.exportJSON());
  assert.equal(dump.version, 2);
});

test('importJSON merges by id and is idempotent (restore, not wipe)', async () => {
  const { store } = freshStore();
  const existing = await store.add({ month: '2026-06', income_a: 100, income_b: 100 });
  // A backup containing the existing row plus a new one.
  const backup = JSON.stringify({
    version: 2,
    submissions: [
      existing,
      { id: 'imported-1', month: '2026-07', income_a: 200, income_b: 100, created_at: '2026-07-02T00:00:00.000Z' }
    ]
  });
  const addedFirst = await store.importJSON(backup);
  assert.equal(addedFirst, 1, 'only the new row is added; the duplicate id is skipped');
  const addedAgain = await store.importJSON(backup);
  assert.equal(addedAgain, 0, 're-importing the same backup adds nothing');
  const rows = await store.list();
  assert.equal(rows.length, 2);
});

test('importJSON accepts a bare array, migrates v1 rows, and rejects junk', async () => {
  const { store } = freshStore();
  const added = await store.importJSON(JSON.stringify([
    { id: 'bare-1', month: '2026-03', income_a: 1000, income_b: 500 }
  ]));
  assert.equal(added, 1);
  const rows = await store.list();
  assert.ok(Array.isArray(rows[0].income_items) && rows[0].income_items.length === 2, 'v1-shaped import is migrated');
  await assert.rejects(() => store.importJSON('{ not json'), /valid JSON/);
  await assert.rejects(() => store.importJSON(JSON.stringify({ nope: true })), /No submissions/);
});

test('exportCSV emits a header + one row each, newest-first, escaping commas/quotes', async () => {
  const { store } = freshStore();
  await store.add({
    month: '2026-06', created_at: '2026-06-01T00:00:00.000Z',
    person_a_name: 'Alan', income_a: 50000, person_b_name: 'Partner', income_b: 40000,
    transfer_from: 'a', transfer_to: 'b', transfer_amount: 5000, equal_share: 45000,
    note: 'bonus, backpay'
  });
  await store.add({ month: '2026-07', created_at: '2026-07-01T00:00:00.000Z', note: null });
  const csv = await store.exportCSV();
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 3, 'header + 2 rows');
  assert.ok(lines[0].startsWith('month,created_at,person_a_name'));
  assert.ok(lines[1].indexOf('2026-07') === 0, 'newest first');
  // a field containing a comma is wrapped in quotes
  assert.ok(lines[2].indexOf('"bonus, backpay"') !== -1);
});
