/* salary-store.js — append-only log of monthly salary submissions.
   Data-access module for the Hushållsbudget pot. Today it persists to
   localStorage; the rows are shaped 1:1 with a future Supabase table
   (`salary_submissions`, snake_case columns) and every method returns a
   Promise, so migrating to the Supabase JS client later is a one-file
   change here — no edits needed at the call sites in budget.js. */
(function () {
  'use strict';

  var STORAGE_KEY = 'bostadskalkyl_salary_log_v1';
  var VERSION = 1;

  // Read the whole log as { version, submissions }. Tolerates a missing or
  // corrupt key by returning an empty log so the UI never throws.
  function _read() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { version: VERSION, submissions: [] };
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.submissions)) return { version: VERSION, submissions: [] };
      return { version: VERSION, submissions: data.submissions };
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

  // Every submission, newest first (by created_at).
  function list() {
    var rows = _read().submissions.slice();
    rows.sort(function (a, b) {
      return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
    return Promise.resolve(rows);
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
    return Promise.resolve(JSON.stringify({ version: VERSION, submissions: _read().submissions }, null, 2));
  }

  window.App = window.App || {};
  window.App.salaryStore = {
    STORAGE_KEY: STORAGE_KEY,
    list: list,
    add: add,
    remove: remove,
    exportJSON: exportJSON
  };
}());
