/* salary-store.js — append-only log of monthly salary submissions.
   Data-access module for the Hushållsbudget pot. Today it persists to
   localStorage; the rows are shaped 1:1 with a future Supabase table
   (`salary_submissions`, snake_case columns) and every method returns a
   Promise, so migrating to the Supabase JS client later is a one-file
   change here — no edits needed at the call sites in budget.js. */
(function () {
  'use strict';

  var STORAGE_KEY = 'bostadskalkyl_salary_log_v1';
  var VERSION = 2; // v2 adds income_items (itemised income per person)

  // Forward-migrate a stored row to the current shape. v1 rows have scalar
  // income_a/income_b but no income_items — synthesise a single salary item per
  // person so older submissions still render and export with a breakdown.
  function _migrate(row) {
    if (!row || Array.isArray(row.income_items)) return row;
    row.income_items = [
      { owner: 'a', label: 'Lön / Salary', amount: row.income_a || 0 },
      { owner: 'b', label: 'Lön / Salary', amount: row.income_b || 0 }
    ];
    return row;
  }

  // Read the whole log as { version, submissions }. Tolerates a missing or
  // corrupt key by returning an empty log so the UI never throws.
  function _read() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { version: VERSION, submissions: [] };
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.submissions)) return { version: VERSION, submissions: [] };
      return { version: VERSION, submissions: data.submissions.map(_migrate) };
    } catch (_) {
      return { version: VERSION, submissions: [] };
    }
  }

  function _write(submissions) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, submissions: submissions }));
      return true;
    } catch (_) {
      return false;
    }
  }

  // Client-side id. Supabase would supply this via `gen_random_uuid()`.
  function _id() {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (_) {}
    return 'sub-' + new Date().getTime().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  // Newest first (by created_at). Shared by list/exportJSON/exportCSV so every
  // surface shows the same order.
  function _sortedDesc(rows) {
    return rows.slice().sort(function (a, b) {
      return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
  }

  // Every submission, newest first.
  function list() {
    return Promise.resolve(_sortedDesc(_read().submissions));
  }

  // Append one record. Stamps id + created_at (the DB would default these),
  // then resolves the saved row.
  function add(record) {
    var saved = Object.assign({}, record, {
      id: record.id || _id(),
      created_at: record.created_at || new Date().toISOString()
    });
    var rows = _read().submissions;
    rows.push(saved);
    _write(rows);
    return Promise.resolve(saved);
  }

  // Drop one record by id; resolves the remaining count.
  function remove(id) {
    var rows = _read().submissions.filter(function (r) { return r.id !== id; });
    _write(rows);
    return Promise.resolve(rows.length);
  }

  // Pretty-printed export of the whole log, shaped for migration.
  function exportJSON() {
    return Promise.resolve(JSON.stringify({ version: VERSION, submissions: _sortedDesc(_read().submissions) }, null, 2));
  }

  // Merge submissions from a previously-exported JSON string (the { version,
  // submissions } envelope or a bare array). Deduped by id so re-importing the
  // same backup is idempotent — a restore, not a wipe. Resolves the number of
  // NEW rows added; rejects on unparseable input.
  function importJSON(text) {
    return new Promise(function (resolve, reject) {
      var parsed;
      try { parsed = JSON.parse(text); } catch (_) { reject(new Error('That file isn’t valid JSON.')); return; }
      var incoming = Array.isArray(parsed) ? parsed
        : (parsed && Array.isArray(parsed.submissions)) ? parsed.submissions
        : null;
      if (!incoming) { reject(new Error('No submissions found in that file.')); return; }

      var rows = _read().submissions;
      var seen = {};
      rows.forEach(function (r) { if (r && r.id) seen[r.id] = true; });

      var added = 0;
      incoming.forEach(function (raw) {
        if (!raw || typeof raw !== 'object') return;
        var row = _migrate(Object.assign({}, raw));
        if (!row.id) row.id = _id();
        if (seen[row.id]) return; // already have it — skip (idempotent restore)
        if (!row.created_at) row.created_at = new Date().toISOString();
        seen[row.id] = true;
        rows.push(row);
        added++;
      });
      _write(rows);
      resolve(added);
    });
  }

  // One CSV field: quote + double up inner quotes when it holds a comma, quote
  // or newline (RFC 4180).
  function _csvCell(v) {
    var s = (v === null || v === undefined) ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // Flat, spreadsheet-friendly export of the scalar summary columns (the
  // itemised income breakdown stays in the JSON export). Newest first.
  function exportCSV() {
    var cols = ['month', 'created_at', 'person_a_name', 'income_a', 'person_b_name',
      'income_b', 'transfer_from', 'transfer_to', 'transfer_amount', 'equal_share', 'note'];
    var lines = [cols.join(',')];
    _sortedDesc(_read().submissions).forEach(function (r) {
      lines.push(cols.map(function (c) { return _csvCell(r[c]); }).join(','));
    });
    return Promise.resolve(lines.join('\r\n'));
  }

  window.App = window.App || {};
  window.App.salaryStore = {
    STORAGE_KEY: STORAGE_KEY,
    list: list,
    add: add,
    remove: remove,
    exportJSON: exportJSON,
    importJSON: importJSON,
    exportCSV: exportCSV
  };
}());
