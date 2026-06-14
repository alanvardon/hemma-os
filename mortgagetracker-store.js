/* mortgagetracker-store.js — persistence for Bolånekoll (the mortgage tracker).

   Five collections plus a small settings blob, mirroring how the household
   actually thinks about its mortgage:
     • loan_parts   — the lånedelar (each its own start balance, rate, number,
                      and — schema v2 — its bound-rate type + expiry date).
                      The anchor for every part's running balance.
     • payments     — imported (or manual) payment rows: ränta + amortering per
                      draw. Each links to a loan part by id. Schema v3 adds
                      `paid_by` so amortering can build one owner's share.
     • valuations   — manual property-value snapshots over time; equity is the
                      property value minus the outstanding debt.
     • rate_changes — (v2) a part's interest rate over time, so the blended
                      rate and cost history stay accurate as variable rates move.
     • contributions— (v3) down-payments and lump sums each owner put in, for
                      contribution-based ownership beyond the flat split.

   Today everything lives in one localStorage envelope; the rows are shaped 1:1
   with future Supabase tables (`mortgage_loan_parts`, `mortgage_payments`,
   `mortgage_valuations`, `mortgage_rate_changes`, `mortgage_contributions`,
   snake_case) and every method returns a Promise, so swapping to the Supabase
   client later is a one-file change here — no edits at the call sites in
   mortgagetracker.js. Older envelopes (v1/v2) load forward transparently:
   missing collections default to [] and missing settings keys to their default.

   This is a browser IIFE (attaches to window.App.mortgageStore); the tests run
   the source in a vm sandbox with a fake localStorage, like manadsavslut-store.js. */
(function () {
  'use strict';

  var STORAGE_KEY = 'bostadskalkyl_mortgage_v1';
  var VERSION = 3;

  function _defaultSettings() {
    return {
      property_name: '',
      owner_a_name: 'Alex',
      owner_b_name: 'Sam',
      my_ownership_pct: 50,
      i_am: 'a',
      currency: 'SEK',
      ranteavdrag: true,
      household_income_yearly: null,   // v2 — feeds the amorteringskrav check
      import_presets: {},              // v2 — remembered column mappings per bank
      track_contributions: false       // v3 — show contribution-based ownership
    };
  }

  // Read the whole envelope. Tolerates a missing/corrupt key by returning an
  // empty store so the UI never throws. Collections absent in an older (v1/v2)
  // envelope default to [] — that IS the forward migration.
  function _read() {
    var empty = { version: VERSION, loan_parts: [], payments: [], valuations: [], rate_changes: [], contributions: [], settings: _defaultSettings() };
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return empty;
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return empty;
      return {
        version: VERSION,
        loan_parts: Array.isArray(data.loan_parts) ? data.loan_parts : [],
        payments: Array.isArray(data.payments) ? data.payments : [],
        valuations: Array.isArray(data.valuations) ? data.valuations : [],
        rate_changes: Array.isArray(data.rate_changes) ? data.rate_changes : [],
        contributions: Array.isArray(data.contributions) ? data.contributions : [],
        settings: Object.assign(_defaultSettings(), data.settings || {})
      };
    } catch (_) {
      return empty;
    }
  }

  function _write(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: VERSION,
        loan_parts: data.loan_parts,
        payments: data.payments,
        valuations: data.valuations,
        rate_changes: data.rate_changes,
        contributions: data.contributions,
        settings: data.settings
      }));
      return true;
    } catch (_) {
      return false;
    }
  }

  // Client-side id; Supabase would supply this via gen_random_uuid().
  function _id(prefix) {
    try {
      if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    } catch (_) {}
    return (prefix || 'row') + '-' + new Date().getTime().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function _stamp(record, prefix) {
    return Object.assign({}, record, {
      id: record.id || _id(prefix),
      created_at: record.created_at || new Date().toISOString()
    });
  }

  // Newest first by created_at.
  function _byCreatedDesc(rows) {
    return rows.slice().sort(function (a, b) {
      return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
  }
  // Most recent transaction/valuation date first; created_at breaks ties. Used
  // for the list surfaces, where the date that matters is the row's own date,
  // not when it happened to be imported.
  function _byDateDesc(rows) {
    return rows.slice().sort(function (a, b) {
      var d = String(b.date || '').localeCompare(String(a.date || ''));
      return d !== 0 ? d : String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
  }

  // ── Loan parts ───────────────────────────────────────────────────────────
  // Kept in insertion order (Lånedel 1 stays first) — a stable, predictable list.
  function listLoanParts() { return Promise.resolve(_read().loan_parts.slice()); }

  function addLoanPart(record) {
    var saved = _stamp(record, 'part');
    var data = _read();
    data.loan_parts.push(saved);
    _write(data);
    return Promise.resolve(saved);
  }

  function updateLoanPart(id, patch) {
    var data = _read();
    var found = null;
    data.loan_parts = data.loan_parts.map(function (p) {
      if (p && p.id === id) { found = Object.assign({}, p, patch); return found; }
      return p;
    });
    _write(data);
    return Promise.resolve(found);
  }

  // Delete a loan part AND its payments + rate changes (an orphaned payment would
  // silently stop moving any balance). Resolves the remaining loan-part count.
  function removeLoanPart(id) {
    var data = _read();
    data.loan_parts = data.loan_parts.filter(function (p) { return p && p.id !== id; });
    data.payments = data.payments.filter(function (pay) { return !(pay && pay.loan_part_id === id); });
    data.rate_changes = data.rate_changes.filter(function (r) { return !(r && r.loan_part_id === id); });
    _write(data);
    return Promise.resolve(data.loan_parts.length);
  }

  // ── Payments ───────────────────────────────────────────────────────────────
  function listPayments() { return Promise.resolve(_byDateDesc(_read().payments)); }

  function addPayment(record) {
    var saved = _stamp(record, 'pay');
    var data = _read();
    data.payments.push(saved);
    _write(data);
    return Promise.resolve(saved);
  }

  // Add many in one write (used by CSV import) — resolves the saved rows.
  function addPayments(records) {
    var data = _read();
    var saved = (records || []).map(function (r) { return _stamp(r, 'pay'); });
    data.payments = data.payments.concat(saved);
    _write(data);
    return Promise.resolve(saved);
  }

  function updatePayment(id, patch) {
    var data = _read();
    var found = null;
    data.payments = data.payments.map(function (p) {
      if (p && p.id === id) { found = Object.assign({}, p, patch); return found; }
      return p;
    });
    _write(data);
    return Promise.resolve(found);
  }

  function removePayment(id) {
    var data = _read();
    data.payments = data.payments.filter(function (p) { return p && p.id !== id; });
    _write(data);
    return Promise.resolve(data.payments.length);
  }

  // Bulk-delete by id in one write. Resolves the number actually removed.
  function removePayments(ids) {
    var drop = {};
    (ids || []).forEach(function (id) { drop[id] = true; });
    var data = _read();
    var before = data.payments.length;
    data.payments = data.payments.filter(function (p) { return !(p && drop[p.id]); });
    _write(data);
    return Promise.resolve(before - data.payments.length);
  }

  // ── Valuations ─────────────────────────────────────────────────────────────
  function listValuations() { return Promise.resolve(_byDateDesc(_read().valuations)); }

  function addValuation(record) {
    var saved = _stamp(record, 'val');
    var data = _read();
    data.valuations.push(saved);
    _write(data);
    return Promise.resolve(saved);
  }

  function updateValuation(id, patch) {
    var data = _read();
    var found = null;
    data.valuations = data.valuations.map(function (v) {
      if (v && v.id === id) { found = Object.assign({}, v, patch); return found; }
      return v;
    });
    _write(data);
    return Promise.resolve(found);
  }

  function removeValuation(id) {
    var data = _read();
    data.valuations = data.valuations.filter(function (v) { return v && v.id !== id; });
    _write(data);
    return Promise.resolve(data.valuations.length);
  }

  // ── Rate changes (v2) ──────────────────────────────────────────────────────
  // A part's interest rate over time. Each row { loan_part_id, date, rate }.
  function listRateChanges() { return Promise.resolve(_byDateDesc(_read().rate_changes)); }

  function addRateChange(record) {
    var saved = _stamp(record, 'rate');
    var data = _read();
    data.rate_changes.push(saved);
    _write(data);
    return Promise.resolve(saved);
  }

  function updateRateChange(id, patch) {
    var data = _read();
    var found = null;
    data.rate_changes = data.rate_changes.map(function (r) {
      if (r && r.id === id) { found = Object.assign({}, r, patch); return found; }
      return r;
    });
    _write(data);
    return Promise.resolve(found);
  }

  function removeRateChange(id) {
    var data = _read();
    data.rate_changes = data.rate_changes.filter(function (r) { return r && r.id !== id; });
    _write(data);
    return Promise.resolve(data.rate_changes.length);
  }

  // ── Contributions (v3) ─────────────────────────────────────────────────────
  // Money an owner put in beyond the shared split. Each row { owner, date, amount, note }.
  function listContributions() { return Promise.resolve(_byDateDesc(_read().contributions)); }

  function addContribution(record) {
    var saved = _stamp(record, 'contrib');
    var data = _read();
    data.contributions.push(saved);
    _write(data);
    return Promise.resolve(saved);
  }

  function updateContribution(id, patch) {
    var data = _read();
    var found = null;
    data.contributions = data.contributions.map(function (c) {
      if (c && c.id === id) { found = Object.assign({}, c, patch); return found; }
      return c;
    });
    _write(data);
    return Promise.resolve(found);
  }

  function removeContribution(id) {
    var data = _read();
    data.contributions = data.contributions.filter(function (c) { return c && c.id !== id; });
    _write(data);
    return Promise.resolve(data.contributions.length);
  }

  // ── Settings ─────────────────────────────────────────────────────────────
  function getSettings() { return Promise.resolve(_read().settings); }

  function saveSettings(patch) {
    var data = _read();
    data.settings = Object.assign(_defaultSettings(), data.settings, patch || {});
    _write(data);
    return Promise.resolve(data.settings);
  }

  // ── Backup ───────────────────────────────────────────────────────────────
  function exportJSON() {
    var data = _read();
    return Promise.resolve(JSON.stringify({
      version: VERSION,
      loan_parts: data.loan_parts,
      payments: _byDateDesc(data.payments),
      valuations: _byDateDesc(data.valuations),
      rate_changes: _byDateDesc(data.rate_changes),
      contributions: _byDateDesc(data.contributions),
      settings: data.settings
    }, null, 2));
  }

  // Merge a previously-exported backup. Every collection is deduped by id so
  // re-importing the same file is idempotent (a restore, not a wipe). Settings
  // are adopted only if present. Resolves a per-collection count of new rows
  // added; rejects on unparseable / unrecognised input.
  function importJSON(text) {
    return new Promise(function (resolve, reject) {
      var parsed;
      try { parsed = JSON.parse(text); } catch (_) { reject(new Error('That file isn’t valid JSON.')); return; }
      if (!parsed || typeof parsed !== 'object') { reject(new Error('No Bolånekoll data found in that file.')); return; }
      if (!parsed.loan_parts && !parsed.payments && !parsed.valuations && !parsed.rate_changes && !parsed.contributions) {
        reject(new Error('No Bolånekoll data found in that file.')); return;
      }

      var data = _read();
      var added = { loan_parts: 0, payments: 0, valuations: 0, rate_changes: 0, contributions: 0 };

      function merge(collection, incoming, prefix) {
        var seen = {};
        collection.forEach(function (r) { if (r && r.id) seen[r.id] = true; });
        var n = 0;
        (Array.isArray(incoming) ? incoming : []).forEach(function (raw) {
          if (!raw || typeof raw !== 'object') return;
          var row = Object.assign({}, raw);
          if (!row.id) row.id = _id(prefix);
          if (seen[row.id]) return;
          if (!row.created_at) row.created_at = new Date().toISOString();
          seen[row.id] = true;
          collection.push(row);
          n++;
        });
        return n;
      }

      added.loan_parts = merge(data.loan_parts, parsed.loan_parts, 'part');
      added.payments = merge(data.payments, parsed.payments, 'pay');
      added.valuations = merge(data.valuations, parsed.valuations, 'val');
      added.rate_changes = merge(data.rate_changes, parsed.rate_changes, 'rate');
      added.contributions = merge(data.contributions, parsed.contributions, 'contrib');
      if (parsed.settings && typeof parsed.settings === 'object') {
        data.settings = Object.assign(_defaultSettings(), data.settings, parsed.settings);
      }
      _write(data);
      resolve(added);
    });
  }

  window.App = window.App || {};
  window.App.mortgageStore = {
    STORAGE_KEY: STORAGE_KEY,
    listLoanParts: listLoanParts,
    addLoanPart: addLoanPart,
    updateLoanPart: updateLoanPart,
    removeLoanPart: removeLoanPart,
    listPayments: listPayments,
    addPayment: addPayment,
    addPayments: addPayments,
    updatePayment: updatePayment,
    removePayment: removePayment,
    removePayments: removePayments,
    listValuations: listValuations,
    addValuation: addValuation,
    updateValuation: updateValuation,
    removeValuation: removeValuation,
    listRateChanges: listRateChanges,
    addRateChange: addRateChange,
    updateRateChange: updateRateChange,
    removeRateChange: removeRateChange,
    listContributions: listContributions,
    addContribution: addContribution,
    updateContribution: updateContribution,
    removeContribution: removeContribution,
    getSettings: getSettings,
    saveSettings: saveSettings,
    exportJSON: exportJSON,
    importJSON: importJSON
  };
}());
