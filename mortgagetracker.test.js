'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const m = require('./mortgagetracker.js');

// ── mortgagetracker-store.js is a browser IIFE (window.App.mortgageStore, no
// module.exports), so we run its source in a vm sandbox that supplies the
// browser globals it touches. Each call gets a fresh in-memory localStorage.
const STORE_SRC = fs.readFileSync(path.join(__dirname, 'mortgagetracker-store.js'), 'utf8');
function freshStore() {
  const mem = {};
  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
    setItem(k, v) { mem[k] = String(v); },
    removeItem(k) { delete mem[k]; }
  };
  const sandbox = { window: { App: {} }, localStorage };
  vm.runInNewContext(STORE_SRC, sandbox);
  return { store: sandbox.window.App.mortgageStore, localStorage };
}

// ───────────────────────── CSV layer ─────────────────────────

test('detectDelimiter sniffs comma, semicolon and tab', () => {
  assert.equal(m.detectDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(m.detectDelimiter('Bokföringsdag;Specifikation;Belopp\n2025-03-31;Ränta;-4.323,00'), ';');
  assert.equal(m.detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
});

test('parseCsv handles a quoted semicolon file with a trailing newline', () => {
  const text = '"Bokföringsdag";"Specifikation";"Belopp";"Saldo"\r\n"2025-03-31";"Ränta";"-4.323,00";"-1.204.323,00"\r\n';
  const out = m.parseCsv(text);
  assert.equal(out.delimiter, ';');
  assert.deepEqual(out.headers, ['Bokföringsdag', 'Specifikation', 'Belopp', 'Saldo']);
  assert.equal(out.rows.length, 1);
  assert.deepEqual(out.rows[0], ['2025-03-31', 'Ränta', '-4.323,00', '-1.204.323,00']);
});

test('parseAmount copes with dot thousands and comma decimals (and negatives)', () => {
  assert.equal(m.parseAmount('4.323,00'), 4323);
  assert.equal(m.parseAmount('-1.200.000,00'), -1200000);
  assert.equal(m.parseAmount('-1.204.323,00'), -1204323);
  assert.equal(m.parseAmount('1 234,56'), 1234.56);
  assert.ok(Number.isNaN(m.parseAmount('')));
});

test('autoMapColumns maps the bank ledger header', () => {
  const map = m.autoMapColumns(['Bokföringsdag', 'Specifikation', 'Belopp', 'Saldo', 'Status', 'Avstämt']);
  assert.equal(map.date, 0);
  assert.equal(map.specification, 1);
  assert.equal(map.amount, 2);
  assert.equal(map.balance, 3);
  assert.equal(map.loan_number, null);
});

test('classifyKind reads the Specifikation text', () => {
  assert.equal(m.classifyKind('Ränta'), 'interest');
  assert.equal(m.classifyKind('Betalning'), 'payment');
  assert.equal(m.classifyKind('Amortering'), 'amortization');
  assert.equal(m.classifyKind('Avbetalning'), 'amortization');
  assert.equal(m.classifyKind('Lån'), 'loan');
  assert.equal(m.classifyKind('Aviavgift'), 'fee');
  assert.equal(m.classifyKind('Whatever'), 'other');
});

// ───────────────────────── row builders ─────────────────────────

test('makeLoanPart normalises a draft (no rate fields — rate lives in periods)', () => {
  const p = m.makeLoanPart({ label: 'Del 1', start_balance: 1200000, start_date: '2024-07-24' });
  assert.equal(p.start_balance, 1200000);
  assert.equal(p.start_date, '2024-07-24');
  assert.equal(p.archived, false);
  assert.ok(!('interest_rate' in p), 'the part no longer carries a static rate');
});

test('makeRatePeriod normalises start / end / rate / type', () => {
  const r = m.makeRatePeriod({ loan_part_id: 'p1', start_date: '2024-07-24', end_date: '2027-09-01', rate: 3.54, rate_type: 'bunden' });
  assert.equal(r.rate, 3.54);
  assert.equal(r.rate_type, 'bunden');
  assert.equal(r.end_date, '2027-09-01');
  const open = m.makeRatePeriod({ loan_part_id: 'p1', start_date: '2024-07-24', rate: 2.5 });
  assert.equal(open.end_date, null, 'no end → open / ongoing');
  assert.equal(open.rate_type, 'rörlig', 'default type is variable');
});

test('makePayment classifies, keeps magnitudes and derives the kind', () => {
  const p = m.makePayment({ date: '2025-03-31', description: 'Ränta', amount: -4323, balance_after: -1204323 });
  assert.equal(p.kind, 'interest');
  assert.equal(p.amount, 4323);
  assert.equal(p.balance_after, 1204323, 'debt stored as a positive magnitude');
  assert.equal(p.source, 'manual');
  const explicit = m.makePayment({ kind: 'payment', amount: 4323 });
  assert.equal(explicit.kind, 'payment');
  assert.equal(explicit.balance_after, null);
});

// ───────────────────────── mortgage math ─────────────────────────

test('partBalance trusts the latest settled Saldo', () => {
  const part = { id: 'p1' };
  const pays = [
    { loan_part_id: 'p1', date: '2025-03-31', kind: 'payment', amount: 4323, balance_after: 1200000 },
    { loan_part_id: 'p1', date: '2025-03-31', kind: 'interest', amount: 4323, balance_after: 1204323 },
    { loan_part_id: 'p1', date: '2025-02-28', kind: 'payment', amount: 3537, balance_after: 1200000 }
  ];
  assert.equal(m.partBalance(part, pays), 1200000, 'interest-charge row does not inflate the balance');
});

test('partBalance falls back to start minus amortization without a Saldo', () => {
  const part = { id: 'p1', start_balance: 100000, start_date: '2025-01-01' };
  const pays = [{ loan_part_id: 'p1', date: '2025-02-01', kind: 'amortization', amount: 2000 }];
  assert.equal(m.partBalance(part, pays), 98000);
});

test('totalInterest sums only the interest-kind rows', () => {
  const pays = [
    { kind: 'interest', amount: 4323 },
    { kind: 'payment', amount: 4323 },
    { kind: 'interest', amount: 3537 },
    { kind: 'loan', amount: 1200000 }
  ];
  assert.equal(m.totalInterest(pays), 7860);
});

test('partAmortized is original principal minus current balance', () => {
  const part = { id: 'p1' };
  const interestOnly = [
    { loan_part_id: 'p1', date: '2024-07-24', kind: 'loan', amount: 1200000, balance_after: 1200000 },
    { loan_part_id: 'p1', date: '2025-03-31', kind: 'payment', amount: 4323, balance_after: 1200000 }
  ];
  assert.equal(m.partOriginal(part, interestOnly), 1200000);
  assert.equal(m.partAmortized(part, interestOnly), 0, 'interest-only loan amortises nothing');
  assert.equal(m.totalAmortized([part], interestOnly), 0);

  const amortising = [
    { loan_part_id: 'p1', date: '2024-07-01', kind: 'loan', amount: 1000000, balance_after: 1000000 },
    { loan_part_id: 'p1', date: '2025-01-01', kind: 'payment', amount: 5000, balance_after: 970000 }
  ];
  assert.equal(m.partAmortized(part, amortising), 30000);
});

test('totalBalance sums active parts only', () => {
  const parts = [
    { id: 'p1', start_balance: 100000 },
    { id: 'p2', start_balance: 50000 },
    { id: 'p3', start_balance: 25000, archived: true }
  ];
  assert.equal(m.totalBalance(parts, []), 150000);
});

test('ranteavdrag applies 30% up to 100k then 21%', () => {
  assert.equal(m.ranteavdrag(80000), 24000);
  assert.equal(m.ranteavdrag(120000), 34200);
  assert.equal(m.ranteavdrag(0), 0);
});

test('equity and loanToValue', () => {
  assert.equal(m.equity(3000000, 1200000), 1800000);
  assert.equal(m.loanToValue(1200000, 3000000), 40);
  assert.equal(m.loanToValue(1200000, 0), 0);
});

test('ownerSplit and ownerPercents divide by ownership and respect who I am', () => {
  assert.deepEqual(m.ownerSplit(1800000, { i_am: 'a', my_ownership_pct: 60 }), { a: 1080000, b: 720000 });
  assert.deepEqual(m.ownerSplit(1800000, { i_am: 'b', my_ownership_pct: 60 }), { b: 1080000, a: 720000 });
  assert.deepEqual(m.ownerPercents({ i_am: 'a', my_ownership_pct: 60 }), { a: 60, b: 40 });
  assert.deepEqual(m.ownerPercents({ i_am: 'b', my_ownership_pct: 60 }), { b: 60, a: 40 });
});

test('myShareEquity clamps out-of-range ownership', () => {
  assert.equal(m.myShareEquity(1000000, 50), 500000);
  assert.equal(m.myShareEquity(1000000, 150), 1000000);
  assert.equal(m.myShareEquity(1000000, -10), 0);
});

test('latestValuation returns the newest on/before asOf', () => {
  const vals = [{ date: '2026-01-01', value: 3000000 }, { date: '2026-04-01', value: 3200000 }];
  assert.equal(m.latestValuation(vals).value, 3200000);
  assert.equal(m.propertyValue(vals, '2026-02-01'), 3000000);
  assert.equal(m.propertyValue([], '2026-02-01'), 0);
});

test('assignPaymentsToPart matches loan numbers, else falls back', () => {
  const parts = [{ id: 'p1', loan_number: '111' }, { id: 'p2', loan_number: '222' }];
  assert.deepEqual(
    m.assignPaymentsToPart(['111', '999'], parts, { auto: true, selectedPartId: 'p2' }),
    [{ loan_part_id: 'p1', matched: true }, { loan_part_id: 'p2', matched: false }]
  );
  assert.deepEqual(
    m.assignPaymentsToPart(['111'], parts, { auto: false, selectedPartId: 'p2' }),
    [{ loan_part_id: 'p2', matched: false }]
  );
});

test('flagDuplicates keys on date, part, kind and amount', () => {
  const existing = [{ date: '2025-03-31', loan_part_id: 'p1', kind: 'interest', amount: 4323 }];
  const incoming = [
    { date: '2025-03-31', loan_part_id: 'p1', kind: 'interest', amount: 4323 }, // re-import → dup
    { date: '2025-03-31', loan_part_id: 'p1', kind: 'payment', amount: 4323 }    // same amount, other kind → not a dup
  ];
  assert.deepEqual(m.flagDuplicates(existing, incoming), [true, false]);
});

// ───────────────────────── timelines ─────────────────────────

test('balanceTimeline carries the settled Saldo forward, gap-filled', () => {
  const parts = [{ id: 'p1' }];
  const pays = [
    { loan_part_id: 'p1', date: '2025-01-31', kind: 'payment', amount: 4061, balance_after: 1200000 },
    { loan_part_id: 'p1', date: '2025-03-31', kind: 'payment', amount: 4323, balance_after: 1200000 }
  ];
  const tl = m.balanceTimeline(parts, pays);
  assert.deepEqual(tl.map((r) => r.month), ['2025-01', '2025-02', '2025-03']);
  assert.deepEqual(tl.map((r) => r.balance), [1200000, 1200000, 1200000], 'February carries January forward');
});

test('equityTimeline splits equity between both owners', () => {
  const parts = [{ id: 'p1' }];
  const pays = [
    { loan_part_id: 'p1', date: '2025-01-31', kind: 'payment', amount: 1, balance_after: 1200000 },
    { loan_part_id: 'p1', date: '2025-02-28', kind: 'payment', amount: 1, balance_after: 1200000 }
  ];
  const vals = [{ date: '2025-01-01', value: 3000000 }];
  const tl = m.equityTimeline(parts, pays, vals, { my_ownership_pct: 60, i_am: 'a' });
  assert.equal(tl[0].equity, 1800000);
  assert.equal(tl[0].a_equity, 1080000);
  assert.equal(tl[0].b_equity, 720000);
  assert.equal(tl[0].bank, 1200000);
});

// ───────────────────────── store ─────────────────────────

test('addLoanPart stamps id + created_at and writes a versioned envelope', async () => {
  const { store, localStorage } = freshStore();
  const saved = await store.addLoanPart(m.makeLoanPart({ label: 'Del 1', start_balance: 1200000 }));
  assert.ok(saved.id && saved.created_at);
  const raw = JSON.parse(localStorage.getItem(store.STORAGE_KEY));
  assert.equal(raw.version, 4);
  assert.equal(raw.loan_parts.length, 1);
});

test('addPayments bulk-inserts and listPayments returns newest date first', async () => {
  const { store } = freshStore();
  await store.addPayments([
    { loan_part_id: 'p1', date: '2025-01-31', kind: 'payment', amount: 1 },
    { loan_part_id: 'p1', date: '2025-03-31', kind: 'payment', amount: 1 }
  ]);
  const rows = await store.listPayments();
  assert.deepEqual(rows.map((r) => r.date), ['2025-03-31', '2025-01-31']);
});

test('updatePayment patches a row and resolves it', async () => {
  const { store } = freshStore();
  const saved = await store.addPayment({ loan_part_id: 'p1', date: '2025-02-01', kind: 'interest', amount: 4061 });
  const updated = await store.updatePayment(saved.id, { amount: 4200 });
  assert.equal(updated.amount, 4200);
  assert.equal(await store.updatePayment('missing', { amount: 1 }), null);
});

test('removePayment and removePayments delete by id', async () => {
  const { store } = freshStore();
  const a = await store.addPayment({ loan_part_id: 'p1', date: '2025-02-01', kind: 'interest', amount: 1 });
  const b = await store.addPayment({ loan_part_id: 'p1', date: '2025-03-01', kind: 'interest', amount: 1 });
  assert.equal(await store.removePayment(a.id), 1);
  assert.equal(await store.removePayments([b.id]), 1);
  assert.deepEqual(await store.listPayments(), []);
});

test('removeLoanPart cascade-deletes its payments', async () => {
  const { store } = freshStore();
  const p = await store.addLoanPart({ label: 'P' });
  await store.addPayment({ loan_part_id: p.id, date: '2025-02-01', kind: 'interest', amount: 4061 });
  await store.addPayment({ loan_part_id: 'other', date: '2025-02-01', kind: 'interest', amount: 1 });
  const remaining = await store.removeLoanPart(p.id);
  assert.equal(remaining, 0);
  const pays = await store.listPayments();
  assert.equal(pays.length, 1);
  assert.equal(pays[0].loan_part_id, 'other');
});

test('valuation CRUD round-trips', async () => {
  const { store } = freshStore();
  const v = await store.addValuation({ date: '2025-01-01', value: 3000000 });
  const upd = await store.updateValuation(v.id, { value: 3200000 });
  assert.equal(upd.value, 3200000);
  assert.equal(await store.removeValuation(v.id), 0);
});

test('settings default and saveSettings patches without clobbering', async () => {
  const { store } = freshStore();
  assert.deepEqual(await store.getSettings(), {
    property_name: '', owner_a_name: 'Alex', owner_b_name: 'Sam',
    my_ownership_pct: 50, i_am: 'a', currency: 'SEK', ranteavdrag: true,
    household_income_yearly: null, import_presets: {}, track_contributions: false
  });
  const saved = await store.saveSettings({ owner_a_name: 'Mia', my_ownership_pct: 65 });
  assert.equal(saved.owner_a_name, 'Mia');
  assert.equal(saved.my_ownership_pct, 65);
  assert.equal(saved.currency, 'SEK');
});

test('a corrupt stored value yields an empty store instead of throwing', async () => {
  const { store, localStorage } = freshStore();
  localStorage.setItem(store.STORAGE_KEY, '{ not json');
  assert.deepEqual(await store.listLoanParts(), []);
  assert.deepEqual(await store.listPayments(), []);
  assert.deepEqual(await store.listValuations(), []);
});

test('exportJSON / importJSON round-trip and merge idempotently by id', async () => {
  const { store } = freshStore();
  await store.addLoanPart({ id: 'p1', label: 'P', created_at: '2025-01-01T00:00:00.000Z' });
  await store.addPayment({ id: 'pay1', loan_part_id: 'p1', date: '2025-02-01', kind: 'interest', amount: 4061, created_at: '2025-02-01T00:00:00.000Z' });
  await store.addValuation({ id: 'v1', date: '2025-01-01', value: 3000000, created_at: '2025-01-01T00:00:00.000Z' });
  const dump = await store.exportJSON();

  const fresh = freshStore();
  const added = await fresh.store.importJSON(dump);
  assert.deepEqual(added, { loan_parts: 1, payments: 1, valuations: 1, rate_periods: 0, contributions: 0 });
  const again = await fresh.store.importJSON(dump);
  assert.deepEqual(again, { loan_parts: 0, payments: 0, valuations: 0, rate_periods: 0, contributions: 0 });

  await assert.rejects(() => fresh.store.importJSON('{ not json'), /valid JSON/);
  await assert.rejects(() => fresh.store.importJSON(JSON.stringify({ nope: true })), /No Bolånekoll data/);
});

// ──────────────── end-to-end: the real bank ledger CSV ────────────────

test('the real Fastighetshypotek ledger imports correctly (interest-only)', async () => {
  const lines = [
    '"Bokföringsdag";"Specifikation";"Belopp";"Saldo";"Status";"Avstämt"',
    '"2025-03-31";"Betalning";"4.323,00";"-1.200.000,00";"Utförd";"Nej"',
    '"2025-03-31";"Ränta";"-4.323,00";"-1.204.323,00";"Utförd";"Nej"',
    '"2025-02-28";"Betalning";"3.537,00";"-1.200.000,00";"Utförd";"Nej"',
    '"2025-02-28";"Ränta";"-3.537,00";"-1.203.537,00";"Utförd";"Nej"',
    '"2025-01-31";"Betalning";"4.061,00";"-1.200.000,00";"Utförd";"Nej"',
    '"2025-01-31";"Ränta";"-4.061,00";"-1.204.061,00";"Utförd";"Nej"',
    '"2024-12-30";"Betalning";"3.668,00";"-1.200.000,00";"Utförd";"Nej"',
    '"2024-12-30";"Ränta";"-3.668,00";"-1.203.668,00";"Utförd";"Nej"',
    '"2024-12-02";"Betalning";"4.061,00";"-1.200.000,00";"Utförd";"Nej"',
    '"2024-12-02";"Ränta";"-4.061,00";"-1.204.061,00";"Utförd";"Nej"',
    '"2024-10-31";"Betalning";"4.061,00";"-1.200.000,00";"Utförd";"Nej"',
    '"2024-10-31";"Ränta";"-4.061,00";"-1.204.061,00";"Utförd";"Nej"',
    '"2024-09-30";"Betalning";"3.668,00";"-1.200.000,00";"Utförd";"Nej"',
    '"2024-09-30";"Ränta";"-3.668,00";"-1.203.668,00";"Utförd";"Nej"',
    '"2024-09-02";"Betalning";"4.978,00";"-1.200.000,00";"Utförd";"Nej"',
    '"2024-09-02";"Ränta";"-4.978,00";"-1.204.978,00";"Utförd";"Nej"',
    '"2024-07-24";"Lån";"-1.200.000,00";"-1.200.000,00";"Utförd";"Nej"'
  ];
  const parsed = m.parseCsv(lines.join('\n') + '\n');
  const map = m.autoMapColumns(parsed.headers);
  assert.equal(parsed.rows.length, 17);

  const { store } = freshStore();
  const part = await store.addLoanPart(m.makeLoanPart({ label: 'FastHypotek' }));
  const drafts = parsed.rows.map((r) => m.makePayment({
    loan_part_id: part.id,
    date: r[map.date],
    description: r[map.specification],
    amount: m.parseAmount(r[map.amount]),
    balance_after: m.parseAmount(r[map.balance]),
    source: 'import:bank.csv'
  }));
  await store.addPayments(drafts);

  const pays = await store.listPayments();
  const parts = await store.listLoanParts();
  assert.equal(pays.length, 17);
  assert.equal(m.totalInterest(pays), 32357, 'sum of the eight Ränta rows');
  assert.equal(m.totalBalance(parts, pays), 1200000, 'interest-only → principal stays at 1.2M');
  assert.equal(m.totalAmortized(parts, pays), 0, 'nothing amortised');
});

// ════════════════════ Roadmap features ════════════════════

// ── #1 Equity bridge ──
test('partBalanceAsOf and totalBalanceAsOf bound entries by date', () => {
  const part = { id: 'p1' };
  const pays = [
    { loan_part_id: 'p1', date: '2025-01-31', kind: 'payment', amount: 1, balance_after: 1000000 },
    { loan_part_id: 'p1', date: '2025-06-30', kind: 'payment', amount: 1, balance_after: 900000 }
  ];
  assert.equal(m.partBalanceAsOf(part, pays, '2025-03-01'), 1000000, 'only the January row is in scope');
  assert.equal(m.partBalanceAsOf(part, pays, '2025-12-31'), 900000);
  assert.equal(m.totalBalanceAsOf([part], pays, '2025-03-01'), 1000000);
});

test('equityBridge splits equity growth into amortisation and appreciation', () => {
  const parts = [{ id: 'p1' }];
  const pays = [
    { loan_part_id: 'p1', date: '2025-01-31', kind: 'payment', amount: 1, balance_after: 1200000 },
    { loan_part_id: 'p1', date: '2025-12-31', kind: 'amortization', amount: 1, balance_after: 1100000 }
  ];
  const vals = [{ date: '2025-01-01', value: 3000000 }, { date: '2025-12-01', value: 3300000 }];
  const b = m.equityBridge(parts, pays, vals, '2025-01-31', '2025-12-31');
  assert.equal(b.start_equity, 1800000);
  assert.equal(b.end_equity, 2200000);
  assert.equal(b.amortization_gain, 100000, 'paid the balance down by 100k');
  assert.equal(b.appreciation_gain, 300000, 'house rose 300k');
  assert.equal(b.total_gain, 400000, 'and the two reconcile to Δequity');
});

// ── #2 Projection ──
test('monthlyAmortizationRate reads the average principal drop off the timeline', () => {
  const parts = [{ id: 'p1' }];
  const pays = [
    { loan_part_id: 'p1', date: '2025-01-31', kind: 'payment', amount: 1, balance_after: 1000000 },
    { loan_part_id: 'p1', date: '2025-04-30', kind: 'amortization', amount: 1, balance_after: 970000 }
  ];
  assert.equal(m.monthlyAmortizationRate(parts, pays), 10000, '30k over 3 months');
});

test('projectBalance is flat for interest-only and amortises with extra', () => {
  const flat = m.projectBalance([], [], { startBalance: 1200000, monthlyAmortization: 0 });
  assert.equal(flat.flat, true);
  assert.equal(flat.months, null);
  const proj = m.projectBalance([], [], { startBalance: 100000, monthlyAmortization: 0, extraMonthly: 10000 });
  assert.equal(proj.flat, false);
  assert.equal(proj.months, 10);
  assert.equal(proj.schedule[proj.schedule.length - 1].balance, 0);
  const slow = m.projectBalance([], [], { startBalance: 5000000, monthlyAmortization: 1, maxMonths: 12 });
  assert.equal(slow.months, null, 'debt still left at the horizon → not paid off');
});

test('projectMilestones reports months to LTV thresholds and payoff', () => {
  const parts = [{ id: 'p1', start_balance: 1600000, start_date: '2025-01-01' }];
  const vals = [{ date: '2025-01-01', value: 2000000 }];
  const ms = m.projectMilestones(parts, [], vals, {}, { monthlyAmortization: 10000 });
  assert.equal(ms.current_ltv, 80);
  assert.equal(ms.ltv70_months, 20, '1.6M → 1.4M at 10k/mo');
  assert.equal(ms.ltv50_months, 60, '1.6M → 1.0M at 10k/mo');
  assert.equal(ms.payoff_months, 160);
});

// ── #3 Monthly cost ──
test('monthlyCost groups interest + amortering per month, net of ränteavdrag', () => {
  const pays = [
    { date: '2025-03-31', kind: 'interest', amount: 4000 },
    { date: '2025-03-15', kind: 'amortization', amount: 2000 },
    { date: '2025-02-28', kind: 'interest', amount: 3000 }
  ];
  const rows = m.monthlyCost(pays);
  assert.equal(rows.length, 2);
  const march = rows[1];
  assert.equal(march.gross, 6000);
  assert.equal(march.deduction, 1200, '30% of 4000 interest');
  assert.equal(march.net, 4800);
  assert.equal(m.monthlyCost(pays, { ranteavdrag: false })[1].net, 6000, 'no deduction → net equals gross');
});

// ── #4 Fixed-rate expiry ──
test('bindingStatus counts days to the active bunden period’s villkorsändringsdag', () => {
  const part = { id: 'p1' };
  const periods = [{ loan_part_id: 'p1', start_date: '2024-01-01', end_date: '2027-09-01', rate: 2.5, rate_type: 'bunden' }];
  const s = m.bindingStatus(part, periods, '2027-06-01');
  assert.equal(s.bound, true);
  assert.equal(s.days_left, 92);
  assert.equal(s.expired, false);
  assert.equal(m.bindingStatus(part, periods, '2027-10-01').expired, true);
  const rorlig = [{ loan_part_id: 'p1', start_date: '2024-01-01', rate: 3, rate_type: 'rörlig' }];
  assert.equal(m.bindingStatus(part, rorlig, '2027-06-01').bound, false, 'a rörlig period has no binding');
});

// ── #5 Rate periods ──
test('effectiveRatePeriod picks the period spanning the date, weightedAvgRate blends by balance', () => {
  const part = { id: 'p1' };
  const periods = [
    { loan_part_id: 'p1', start_date: '2024-01-01', end_date: '2025-05-31', rate: 3.0, rate_type: 'rörlig' },
    { loan_part_id: 'p1', start_date: '2025-06-01', end_date: null, rate: 2.5, rate_type: 'rörlig' }
  ];
  assert.equal(m.effectiveRate(part, periods, '2025-01-01'), 3.0, 'within the first period');
  assert.equal(m.effectiveRate(part, periods, '2025-07-01'), 2.5, 'within the open period');
  assert.equal(m.effectiveRatePeriod(part, periods, '2025-07-01').rate_type, 'rörlig');
  assert.equal(m.effectiveRate(part, [], null), null, 'no periods → no rate');

  const p1 = { id: 'p1' }, p2 = { id: 'p2' };
  const per = [
    { loan_part_id: 'p1', start_date: '2024-01-01', end_date: null, rate: 3.0, rate_type: 'rörlig' },
    { loan_part_id: 'p2', start_date: '2024-01-01', end_date: null, rate: 1.0, rate_type: 'rörlig' }
  ];
  const pays = [
    { loan_part_id: 'p1', date: '2025-01-01', kind: 'payment', amount: 1, balance_after: 1000000 },
    { loan_part_id: 'p2', date: '2025-01-01', kind: 'payment', amount: 1, balance_after: 3000000 }
  ];
  assert.equal(m.weightedAvgRate([p1, p2], per, pays), 1.5, '(3×1M + 1×3M) / 4M');
});

test('derivedRate annualises interest ÷ balance over the actual days between charges', () => {
  const part = { id: 'p1' };
  // interest-only: each Ränta cancelled by a Betalning, principal flat at 1.2M
  const pays = [
    { loan_part_id: 'p1', date: '2024-12-30', kind: 'interest', amount: 3668, balance_after: 1203668 },
    { loan_part_id: 'p1', date: '2024-12-30', kind: 'payment', amount: 3668, balance_after: 1200000 },
    { loan_part_id: 'p1', date: '2025-01-31', kind: 'interest', amount: 4061, balance_after: 1204061 },
    { loan_part_id: 'p1', date: '2025-01-31', kind: 'payment', amount: 4061, balance_after: 1200000 },
    { loan_part_id: 'p1', date: '2025-02-28', kind: 'interest', amount: 3537, balance_after: 1203537 },
    { loan_part_id: 'p1', date: '2025-02-28', kind: 'payment', amount: 3537, balance_after: 1200000 },
    { loan_part_id: 'p1', date: '2025-03-31', kind: 'interest', amount: 4323, balance_after: 1204323 },
    { loan_part_id: 'p1', date: '2025-03-31', kind: 'payment', amount: 4323, balance_after: 1200000 }
  ];
  const r = m.derivedRate(part, pays, { trailing: 3 });
  assert.ok(r > 3.8 && r < 4.1, 'trailing-3 day-weighted lands ~3.98 %, got ' + r);
  assert.equal(m.derivedRate({ id: 'p1' }, pays.slice(0, 2)), null, 'one charge → not enough to bound a period');
});

// ── #6 Amorteringskrav ──
test('amorteringskrav encodes the LTV bands and the 4.5× income add-on', () => {
  assert.equal(m.amorteringskrav(80, 0), 2);
  assert.equal(m.amorteringskrav(60, 0), 1);
  assert.equal(m.amorteringskrav(40, 0), 0);
  assert.equal(m.amorteringskrav(80, 5), 3, '+1% over 4.5× income');
  assert.equal(m.amorteringskrav(40, 5), 1);
});

test('amorteringskravStatus compares required vs observed amortisation', () => {
  const parts = [{ id: 'p1', start_balance: 1600000, start_date: '2025-01-01' }];
  const vals = [{ date: '2025-01-01', value: 2000000 }];
  const s = m.amorteringskravStatus(parts, [], vals, { household_income_yearly: 0 });
  assert.equal(s.ltv, 80);
  assert.equal(s.required_pct, 2);
  assert.equal(s.required_annual, 32000);
  assert.equal(s.meets, false, 'interest-only meets nothing');
  assert.equal(s.exempt, false);
  const withIncome = m.amorteringskravStatus(parts, [], vals, { household_income_yearly: 300000 });
  assert.equal(withIncome.required_pct, 3, 'debt is >4.5× income → +1%');
});

// ── #7 Import presets ──
test('header presets round-trip by name and survive reordered columns', () => {
  const headers = ['Bokföringsdag', 'Specifikation', 'Belopp', 'Saldo'];
  const mapping = { date: 0, specification: 1, amount: 2, balance: 3, loan_number: null };
  const names = m.mappingToNames(headers, mapping);
  assert.equal(names.amount, 'Belopp');
  assert.deepEqual(m.applyPreset(headers, names), mapping, 'resolves back to the same indices');
  const reordered = ['Saldo', 'Belopp', 'Specifikation', 'Bokföringsdag'];
  assert.deepEqual(m.applyPreset(reordered, names), { date: 3, specification: 2, amount: 1, balance: 0, loan_number: null });
  assert.equal(m.headerSignature(headers), m.headerSignature(reordered), 'same column set → same signature');
});

// ── #8 CSV export ──
test('paymentsToCsv emits a semicolon file with a header and escapes specials', () => {
  const parts = [{ id: 'p1', label: 'Del 1' }, { id: 'p2', label: 'A;B' }];
  const pays = [
    { loan_part_id: 'p1', date: '2025-03-31', kind: 'interest', amount: 4323, balance_after: 1200000, paid_by: 'joint', source: 'import:bank.csv' },
    { loan_part_id: 'p2', date: '2025-03-31', kind: 'amortization', amount: 1000, balance_after: null, paid_by: 'a', source: 'manual' }
  ];
  const lines = m.paymentsToCsv(pays, parts).split('\n');
  assert.equal(lines[0], 'Date;Loan part;Type;Amount;Balance after;Paid by;Source');
  assert.equal(lines[1], '2025-03-31;Del 1;interest;4323;1200000;joint;import:bank.csv');
  assert.equal(lines[2], '2025-03-31;"A;B";amortization;1000;;a;manual', 'a label with ; is quoted, null balance blank');
});

// ── #9 Reconciliation ──
test('reconcileBalance checks the start balance against the ledger start, not amortering rows', () => {
  const parts = [
    { id: 'p1', start_balance: 1200000, start_date: '2024-07-01' }, // full import, amortises via Saldo
    { id: 'p2', start_balance: 1200000, start_date: '2024-07-01' }, // partial import: ledger starts lower
    { id: 'p3', start_balance: 0 }                                  // no start balance → nothing to check
  ];
  const pays = [
    // p1: principal falls 1.2M → 1.032M through plain "payment" rows (no typed amortering)
    { loan_part_id: 'p1', date: '2024-07-24', kind: 'loan', amount: 1200000, balance_after: 1200000 },
    { loan_part_id: 'p1', date: '2025-06-30', kind: 'payment', amount: 4000, balance_after: 1032000 },
    // p2: only recent rows imported — earliest Saldo 1.08M < entered start balance
    { loan_part_id: 'p2', date: '2025-01-31', kind: 'payment', amount: 4000, balance_after: 1080000 },
    { loan_part_id: 'p2', date: '2025-06-30', kind: 'payment', amount: 4000, balance_after: 1032000 }
  ];
  const r = m.reconcileBalance(parts, pays);
  assert.equal(r[0].drift, 0, 'amortising via Saldo with a matching start balance does NOT drift');
  assert.equal(r[0].current, 1032000, 'current balance still tracks the latest Saldo');
  assert.equal(r[1].drift, 120000, 'partial import: start 1.2M vs ledger start 1.08M');
  assert.equal(r[2].drift, null, 'no start balance → nothing to reconcile');
});

// ── #10 Contribution-based ownership ──
test('normPaidBy and makePayment default paid_by to joint', () => {
  assert.equal(m.normPaidBy('a'), 'a');
  assert.equal(m.normPaidBy('x'), 'joint');
  assert.equal(m.makePayment({ paid_by: 'b' }).paid_by, 'b');
  assert.equal(m.makePayment({}).paid_by, 'joint');
});

test('contributionSplit builds ownership from amortering + lump sums', () => {
  const settings = { i_am: 'a', my_ownership_pct: 50 };
  const pays = [
    { kind: 'amortization', amount: 10000, paid_by: 'a' },
    { kind: 'amortization', amount: 5000, paid_by: 'b' },
    { kind: 'amortization', amount: 4000, paid_by: 'joint' },
    { kind: 'interest', amount: 9999, paid_by: 'a' }
  ];
  const contribs = [
    { owner: 'a', amount: 200000 },
    { owner: 'b', amount: 100000 },
    { owner: 'joint', amount: 50000 }
  ];
  const split = m.contributionSplit(pays, contribs, settings);
  assert.equal(split.a, 237000, '200k + 10k + half of 54k joint');
  assert.equal(split.b, 132000);
  assert.equal(split.total, 369000);
  assert.equal(split.a_pct, 64.23);
});

test('settlement trues contributions up to the target ownership split', () => {
  const settings = { i_am: 'a', my_ownership_pct: 50 };
  const pays = [
    { kind: 'amortization', amount: 10000, paid_by: 'a' },
    { kind: 'amortization', amount: 5000, paid_by: 'b' },
    { kind: 'amortization', amount: 4000, paid_by: 'joint' }
  ];
  const contribs = [{ owner: 'a', amount: 200000 }, { owner: 'b', amount: 100000 }, { owner: 'joint', amount: 50000 }];
  const s = m.settlement(pays, contribs, settings);
  assert.equal(s.total, 369000);
  assert.equal(s.target_a, 184500);
  assert.equal(s.a_over, 52500, 'A has put in more than a 50% share');
  assert.equal(s.owes, 'b');
  assert.equal(s.amount, 52500);
});

// ── store: new collections ──
test('rate-period CRUD round-trips and cascades when its loan part is deleted', async () => {
  const { store } = freshStore();
  const p = await store.addLoanPart({ label: 'P' });
  const rc = await store.addRatePeriod({ loan_part_id: p.id, start_date: '2024-07-24', end_date: null, rate: 2.5, rate_type: 'rörlig' });
  assert.ok(rc.id && rc.created_at);
  assert.equal((await store.listRatePeriods()).length, 1);
  const upd = await store.updateRatePeriod(rc.id, { rate: 2.25 });
  assert.equal(upd.rate, 2.25);
  await store.removeLoanPart(p.id);
  assert.equal((await store.listRatePeriods()).length, 0, 'rate periods cascade with the part');
});

test('contribution CRUD round-trips', async () => {
  const { store } = freshStore();
  const c = await store.addContribution({ owner: 'a', date: '2025-01-01', amount: 200000 });
  assert.ok(c.id && c.created_at);
  const upd = await store.updateContribution(c.id, { amount: 250000 });
  assert.equal(upd.amount, 250000);
  assert.equal(await store.removeContribution(c.id), 0);
});

test('exportJSON / importJSON carry rate periods and contributions', async () => {
  const { store } = freshStore();
  await store.addLoanPart({ id: 'p1', label: 'P', created_at: '2025-01-01T00:00:00.000Z' });
  await store.addRatePeriod({ id: 'r1', loan_part_id: 'p1', start_date: '2024-07-24', end_date: null, rate: 2.5, rate_type: 'rörlig', created_at: '2024-07-24T00:00:00.000Z' });
  await store.addContribution({ id: 'c1', owner: 'a', date: '2025-01-01', amount: 200000, created_at: '2025-01-01T00:00:00.000Z' });
  const dump = await store.exportJSON();
  const fresh = freshStore();
  const added = await fresh.store.importJSON(dump);
  assert.equal(added.rate_periods, 1);
  assert.equal(added.contributions, 1);
});

test('a pre-v4 envelope migrates the part rate + rate_changes into rate_periods', async () => {
  const { store, localStorage } = freshStore();
  localStorage.setItem(store.STORAGE_KEY, JSON.stringify({
    version: 3,
    loan_parts: [{ id: 'p1', label: 'Del 1', start_date: '2024-07-24', interest_rate: 3.79, rate_type: 'rörlig', rate_binding_until: null }],
    payments: [], valuations: [],
    rate_changes: [{ id: 'rc1', loan_part_id: 'p1', date: '2025-06-01', rate: 2.54 }],
    contributions: [], settings: {}
  }));
  const periods = await store.listRatePeriods();
  assert.equal(periods.length, 2, 'base rate + the one change become two periods');
  const byStart = periods.slice().sort((a, b) => a.start_date.localeCompare(b.start_date));
  assert.equal(byStart[0].rate, 3.79);
  assert.equal(byStart[0].end_date, '2025-05-31', 'base ends the day before the change');
  assert.equal(byStart[1].rate, 2.54);
  assert.equal(byStart[1].end_date, null, 'latest stays open');
  const parts = await store.listLoanParts();
  assert.ok(!('interest_rate' in parts[0]), 'the old static rate field is stripped');
});
