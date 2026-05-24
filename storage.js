(function () {
  'use strict';

  window.App = window.App || {};

  // ── Versioned key names ─────────────────────────────────────────
  var KEYS = {
    scenarios:    'bostadskalkyl_scenarios_v1',
    session:      'bostadskalkyl_session_v1',
    driftItems:   'bostadskalkyl_drift_items_v1',
    savingsItems: 'bostadskalkyl_savings_items_v1',
  };

  // Unchanged keys (no versioning needed)
  var KEY_DRIFT_YEARLY = 'bostadskalkyl_drift_yearly';
  var KEY_THEME        = 'bostadskalkyl_theme';

  // ── One-time migration from unversioned keys ────────────────────
  var MIGRATIONS = [
    { from: 'bostadskalkyl_scenarios',    to: KEYS.scenarios    },
    { from: 'bostadskalkyl_session',      to: KEYS.session      },
    { from: 'bostadskalkyl_drift_items',  to: KEYS.driftItems   },
    { from: 'bostadskalkyl_savings_items',to: KEYS.savingsItems },
  ];

  MIGRATIONS.forEach(function (m) {
    var oldVal = localStorage.getItem(m.from);
    var newVal = localStorage.getItem(m.to);
    if (oldVal !== null && newVal === null) {
      localStorage.setItem(m.to, oldVal);
      localStorage.removeItem(m.from);
    }
  });

  // ── onChange pub/sub registry ───────────────────────────────────
  // FUTURE: fire on Supabase realtime events
  var _subscribers = {};

  function onChange(key, cb) {
    if (!_subscribers[key]) _subscribers[key] = [];
    _subscribers[key].push(cb);
  }

  // ── Scenarios ───────────────────────────────────────────────────
  function loadScenarios() {
    try {
      var raw = localStorage.getItem(KEYS.scenarios);
      return Promise.resolve(JSON.parse(raw) || []);
    } catch (e) {
      return Promise.resolve([]);
    }
  }

  function saveScenarios(scenarios) {
    localStorage.setItem(KEYS.scenarios, JSON.stringify(scenarios));
    return Promise.resolve();
  }

  // ── Session ─────────────────────────────────────────────────────
  // FUTURE: per-user vs household session separation
  function loadSession() {
    try {
      var raw = localStorage.getItem(KEYS.session);
      return Promise.resolve(JSON.parse(raw));
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function saveSession(inputs, activeScenarioId, isDirty) {
    var payload = { inputs: inputs, activeScenarioId: activeScenarioId, isDirty: isDirty };
    localStorage.setItem(KEYS.session, JSON.stringify(payload));
    return Promise.resolve();
  }

  // ── Drift items ─────────────────────────────────────────────────
  function loadDriftItems() {
    try {
      var raw = localStorage.getItem(KEYS.driftItems);
      var stored = JSON.parse(raw);
      if (stored && stored.length) return Promise.resolve(stored);
      return Promise.resolve(null); // caller uses defaults
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function saveDriftItems(items) {
    localStorage.setItem(KEYS.driftItems, JSON.stringify(items));
    return Promise.resolve();
  }

  // ── Savings items ────────────────────────────────────────────────
  function loadSavingsItems() {
    try {
      var raw = localStorage.getItem(KEYS.savingsItems);
      var stored = JSON.parse(raw);
      return Promise.resolve(stored && stored.length ? stored : []);
    } catch (e) {
      return Promise.resolve([]);
    }
  }

  function saveSavingsItems(items) {
    localStorage.setItem(KEYS.savingsItems, JSON.stringify(items));
    return Promise.resolve();
  }

  // ── Drift yearly toggle (unchanged key) ─────────────────────────
  function loadDriftYearly() {
    return Promise.resolve(localStorage.getItem(KEY_DRIFT_YEARLY) === 'true');
  }

  function saveDriftYearly(val) {
    localStorage.setItem(KEY_DRIFT_YEARLY, String(val));
    return Promise.resolve();
  }

  // ── Theme (unchanged key) ────────────────────────────────────────
  function loadTheme() {
    return Promise.resolve(localStorage.getItem(KEY_THEME));
  }

  function saveTheme(theme) {
    localStorage.setItem(KEY_THEME, theme);
    return Promise.resolve();
  }

  // ── Export ───────────────────────────────────────────────────────
  window.App.storage = {
    loadScenarios:    loadScenarios,
    saveScenarios:    saveScenarios,
    loadSession:      loadSession,
    saveSession:      saveSession,
    loadDriftItems:   loadDriftItems,
    saveDriftItems:   saveDriftItems,
    loadSavingsItems: loadSavingsItems,
    saveSavingsItems: saveSavingsItems,
    loadDriftYearly:  loadDriftYearly,
    saveDriftYearly:  saveDriftYearly,
    loadTheme:        loadTheme,
    saveTheme:        saveTheme,
    onChange:         onChange,
  };
}());
