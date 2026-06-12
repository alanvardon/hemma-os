(function () {
  'use strict';

  window.App = window.App || {};

  // Helpers — delegates to App.calc/App.dom globals loaded before this file
  var fmt            = function () { return App.calc.fmt.apply(null, arguments); };
  var formatWithSpaces = function () { return App.calc.formatWithSpaces.apply(null, arguments); };
  var parseFormatted = function () { return App.calc.parseFormatted.apply(null, arguments); };

  // ── In-memory caches (pre-loaded at boot) ─────────────────────────
  // FUTURE: extract to drift.js once >200 lines

  var DEFAULT_DRIFT = [
    { id: 'drift_0', label: 'Electricity',     amount: 0 },
    { id: 'drift_1', label: 'Vatten / avlopp', amount: 0 },
    { id: 'drift_2', label: 'Renhållning',     amount: 0 },
    { id: 'drift_3', label: 'Home insurance',  amount: 0 },
    { id: 'drift_4', label: 'Internet',        amount: 0 },
  ];

  var driftItems  = [];
  var driftYearly = false;

  function setDriftItems(items) {
    driftItems = items && items.length ? items : JSON.parse(JSON.stringify(DEFAULT_DRIFT));
  }

  // FUTURE: extract to savings.js once >200 lines
  var savingsItems = [];

  function setSavingsItems(items) {
    savingsItems = items && items.length ? items : [];
  }

  function getSavingsTotal() {
    return savingsItems.reduce(function (sum, item) { return sum + (item.amount || 0); }, 0);
  }

  // ── Animated overlay close ─────────────────────────────────────────
  // Adds .closing so CSS can play the exit animation before display:none
  function animateClose(id) {
    var el = document.getElementById(id);
    if (!el || !el.classList.contains('open')) return;
    el.classList.add('closing');
    setTimeout(function () { el.classList.remove('open', 'closing'); }, 170);
  }

  // ── Header label ───────────────────────────────────────────────────
  function updateHeaderLabel() {
    var labelEl  = document.getElementById('activeScenarioLabel');
    var saveBtn  = document.getElementById('saveBtn');
    var scenarios = loadScenarios(); // global from app.js
    var active    = scenarios.find(function (s) { return s.id === activeScenarioId; }); // global from app.js

    if (active) {
      labelEl.style.display = 'inline';
      labelEl.innerHTML = '<span class="active-scenario-name">' + active.name + '</span>' +
        (isDirty ? '<span class="unsaved-dot" title="Unsaved changes"></span>' : ''); // isDirty global
      saveBtn.textContent = isDirty ? 'Update' : 'Save as new';
    } else {
      labelEl.style.display = isDirty ? 'inline' : 'none';
      labelEl.innerHTML = isDirty
        ? '<span class="active-scenario-name">Unsaved</span><span class="unsaved-dot"></span>'
        : '';
      saveBtn.textContent = 'Save';
    }
  }

  // ── Save flow ─────────────────────────────────────────────────────
  var saveMode = 'new'; // 'new' or 'update'

  function handleSaveClick() {
    var scenarios = loadScenarios();
    var active    = scenarios.find(function (s) { return s.id === activeScenarioId; });

    if (active && isDirty) {
      openUpdatePrompt(active.name);
    } else {
      openNewSavePrompt();
    }
  }

  function openNewSavePrompt() {
    saveMode = 'new';
    document.getElementById('savePromptTitle').textContent = 'Save scenario';
    document.getElementById('saveNameInput').value = '';
    document.getElementById('savePrompt').classList.add('open');
    setTimeout(function () { document.getElementById('saveNameInput').focus(); }, 50);
  }

  function openUpdatePrompt(name) {
    saveMode = 'update';
    document.getElementById('savePromptTitle').innerHTML = 'Update <em>' + name + '</em> or save as new?';
    document.getElementById('saveNameInput').value = '';
    document.getElementById('saveNameInput').placeholder = 'Leave blank to update, or enter a new name…';
    document.getElementById('savePrompt').classList.add('open');
    setTimeout(function () { document.getElementById('saveNameInput').focus(); }, 50);
  }

  function closeSavePrompt() {
    animateClose('savePrompt');
    document.getElementById('saveNameInput').placeholder = 'e.g. Lidingö house, Scenario A…';
  }

  function confirmSave() {
    var nameInput = document.getElementById('saveNameInput').value.trim();
    var scenarios = loadScenarios();

    if (saveMode === 'update' && !nameInput) {
      var idx = scenarios.findIndex(function (s) { return s.id === activeScenarioId; });
      if (idx !== -1) {
        scenarios[idx].inputs = readInputs();    // global from app.js
        scenarios[idx].savedAt = new Date().toISOString();
        saveScenarios(scenarios);                // global from app.js
        isDirty = false;                         // global from app.js
        updateHeaderLabel();
        saveSession();                           // global from app.js
      }
    } else {
      var name = nameInput || 'Unnamed scenario';
      var newScenario = {
        id: Date.now().toString(),
        name: name,
        savedAt: new Date().toISOString(),
        inputs: readInputs()
      };
      scenarios.push(newScenario);
      saveScenarios(scenarios);
      activeScenarioId = newScenario.id;         // global from app.js
      isDirty = false;
      updateHeaderLabel();
      saveSession();
    }

    closeSavePrompt();
  }

  // Enter key in save prompt
  document.getElementById('saveNameInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') confirmSave();
    if (e.key === 'Escape') closeSavePrompt();
  });

  // ── Scenarios modal ───────────────────────────────────────────────
  function openScenariosModal() {
    renderScenariosModal();
    document.getElementById('scenariosModal').classList.add('open');
  }

  // Renamed from closeModal() — plan decision 1
  function closeScenariosModal() {
    animateClose('scenariosModal');
  }

  document.getElementById('scenariosModal').addEventListener('click', function (e) {
    if (e.target === this) closeScenariosModal();
  });

  function renderScenariosModal() {
    var scenarios = loadScenarios();
    var body      = document.getElementById('scenariosBody');

    if (scenarios.length === 0) {
      body.innerHTML = '<div class="modal-empty">No saved scenarios yet.<br>Hit <strong>Save</strong> to store your first calculation.</div>';
      return;
    }

    var grid = document.createElement('div');
    grid.className = 'scenario-grid';

    var sorted = scenarios.slice().sort(function (a, b) {
      return new Date(b.savedAt) - new Date(a.savedAt);
    });

    sorted.forEach(function (s) {
      var card = document.createElement('div');
      card.className = 'scenario-card' + (s.id === activeScenarioId ? ' active-card' : '');

      var sum     = App.calc.summarize(s.inputs);
      var monthly = sum.monthly;
      var cash    = sum.cashBalance;
      var d       = s.inputs;

      var dateStr = new Date(s.savedAt).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' });

      // Build card content using DOM (no inline handlers)
      var nameEl = document.createElement('div');
      nameEl.className = 'scenario-card-name';
      nameEl.textContent = s.name;

      var dateEl = document.createElement('div');
      dateEl.className = 'scenario-card-date';
      dateEl.textContent = 'Saved ' + dateStr;

      var statsEl = document.createElement('div');
      statsEl.className = 'scenario-card-stats';
      statsEl.innerHTML =
        '<div class="scenario-stat"><span class="scenario-stat-label">New property</span><span class="scenario-stat-val">' + fmt(d.newPrice || 0) + '</span></div>' +
        '<div class="scenario-stat"><span class="scenario-stat-label">Monthly cost</span><span class="scenario-stat-val">' + fmt(monthly) + '</span></div>' +
        '<div class="scenario-stat"><span class="scenario-stat-label">Cash surplus / shortfall</span><span class="scenario-stat-val ' + (cash >= 0 ? 'pos' : 'neg') + '">' + (cash >= 0 ? '+' : '') + fmt(cash) + '</span></div>';

      var actionsEl = document.createElement('div');
      actionsEl.className = 'scenario-card-actions';

      var loadBtn = document.createElement('button');
      loadBtn.className = 'btn btn-ghost';
      loadBtn.textContent = 'Load';
      loadBtn.addEventListener('click', function () { loadScenario(s.id); });

      var dupBtn = document.createElement('button');
      dupBtn.classList.add('btn', 'btn-ghost');
      dupBtn.textContent = 'Duplicate';
      dupBtn.addEventListener('click', function () { duplicateScenario(s.id); });

      var deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-danger';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', function (e) { deleteScenario(s.id, e); });

      actionsEl.appendChild(loadBtn);
      actionsEl.appendChild(dupBtn);
      actionsEl.appendChild(deleteBtn);

      card.appendChild(nameEl);
      card.appendChild(dateEl);
      card.appendChild(statsEl);
      card.appendChild(actionsEl);

      grid.appendChild(card);
    });

    body.innerHTML = '';
    body.appendChild(grid);
  }

  function loadScenario(id) {
    var scenarios = loadScenarios();
    var s = scenarios.find(function (sc) { return sc.id === id; });
    if (!s) return;
    writeInputs(s.inputs);    // global from app.js
    activeScenarioId = id;
    isDirty = false;
    updateHeaderLabel();
    saveSession();
    closeScenariosModal();
  }

  function duplicateScenario(id) {
    var scenarios = loadScenarios();
    var s = scenarios.find(function (sc) { return sc.id === id; });
    if (!s) return;
    scenarios.push({
      id: Date.now().toString(),
      name: s.name + ' (copy)',
      savedAt: new Date().toISOString(),
      inputs: JSON.parse(JSON.stringify(s.inputs)),
    });
    saveScenarios(scenarios);
    renderScenariosModal();
  }

  function deleteScenario(id, e) {
    e.stopPropagation();
    var all = loadScenarios();
    var deleted = all.find(function (s) { return s.id === id; });
    if (!deleted) return;
    var prior = { activeScenarioId: activeScenarioId, isDirty: isDirty }; // globals from app.js
    saveScenarios(all.filter(function (s) { return s.id !== id; }));
    if (activeScenarioId === id) {
      activeScenarioId = null;
      isDirty = true;
    }
    updateHeaderLabel();
    saveSession();
    renderScenariosModal();
    showUndoToast(deleted, prior);
  }

  // ── Undo toast for scenario delete ────────────────────────────────
  var undoState = null; // { scenario, prior, timer }

  function showUndoToast(scenario, prior) {
    var toast = document.getElementById('undoToast');
    if (!toast) return;
    if (undoState && undoState.timer) clearTimeout(undoState.timer);
    document.getElementById('undoToastMsg').textContent = 'Deleted “' + scenario.name + '”';
    toast.classList.add('open');
    undoState = { scenario: scenario, prior: prior, timer: setTimeout(hideUndoToast, 6000) };
  }

  function hideUndoToast() {
    var toast = document.getElementById('undoToast');
    if (toast) toast.classList.remove('open');
    if (undoState && undoState.timer) clearTimeout(undoState.timer);
    undoState = null;
  }

  function undoDelete() {
    if (!undoState) return;
    var scenarios = loadScenarios();
    scenarios.push(undoState.scenario);
    saveScenarios(scenarios);
    if (undoState.prior.activeScenarioId === undoState.scenario.id) {
      activeScenarioId = undoState.scenario.id;
      isDirty = undoState.prior.isDirty;
    }
    updateHeaderLabel();
    saveSession();
    renderScenariosModal();
    hideUndoToast();
  }

  // ── Amort modal ───────────────────────────────────────────────────
  function openAmortModal() {
    document.getElementById('amortModal').classList.add('open');
    App.charts.renderAmortChart();
  }

  function closeAmortModal() {
    animateClose('amortModal');
  }

  document.getElementById('amortModal').addEventListener('click', function (e) {
    if (e.target === this) closeAmortModal();
  });

  // ── Drift modal ───────────────────────────────────────────────────
  // FUTURE: extract to drift.js once >200 lines

  function loadDriftItemsFromStorage() {
    try {
      var stored = JSON.parse(localStorage.getItem('bostadskalkyl_drift_items_v1'));
      driftItems = stored && stored.length ? stored : JSON.parse(JSON.stringify(DEFAULT_DRIFT));
    } catch (_) { driftItems = JSON.parse(JSON.stringify(DEFAULT_DRIFT)); }
  }

  function saveDriftItems() {
    App.storage.saveDriftItems(driftItems); // fire-and-forget
  }

  function openDriftModal() {
    loadDriftItemsFromStorage();
    App.storage.loadDriftYearly().then(function (yearly) {
      driftYearly = yearly;
      document.getElementById('driftYearlyToggle').checked = driftYearly;
      renderDriftItems();
    });
    document.getElementById('driftModal').classList.add('open');
  }

  function closeDriftModal() {
    animateClose('driftModal');
  }

  document.getElementById('driftModal').addEventListener('click', function (e) {
    if (e.target === this) closeDriftModal();
  });

  function toggleDriftMode() {
    driftYearly = document.getElementById('driftYearlyToggle').checked;
    App.storage.saveDriftYearly(driftYearly);
    renderDriftItems();
  }

  function addDriftItem() {
    var id = 'drift_' + Date.now();
    driftItems.push({ id: id, label: '', amount: 0 });
    saveDriftItems();
    renderDriftItems();
    var inputs = document.querySelectorAll('.drift-item-label-input');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }

  function removeDriftItem(id) {
    driftItems = driftItems.filter(function (d) { return d.id !== id; });
    saveDriftItems();
    renderDriftItems();
    applyDriftTotal();
  }

  function renderDriftItems() {
    var list  = document.getElementById('driftItemList');
    var label = driftYearly ? 'kr/yr' : 'kr/mo';
    list.innerHTML = '';

    driftItems.forEach(function (item, idx) {
      var displayVal = item.amount > 0
        ? App.calc.formatWithSpaces(driftYearly ? item.amount * 12 : item.amount)
        : '';

      var row = document.createElement('div');
      row.className = 'drift-item-row';

      // Label input
      var labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.className = 'drift-item-label-input';
      labelInput.placeholder = 'Category name';
      labelInput.value = item.label;
      labelInput.addEventListener('change', function () {
        driftItems[idx].label = this.value;
        saveDriftItems();
      });

      // Amount input wrap
      var wrap = document.createElement('div');
      wrap.className = 'input-wrap has-suffix';

      var amtInput = document.createElement('input');
      amtInput.type = 'text';
      amtInput.inputMode = 'numeric';
      amtInput.value = displayVal;
      amtInput.placeholder = '0';
      amtInput.dataset.driftIdx = idx;
      amtInput.addEventListener('focus', function () {
        this.value = App.calc.parseFormatted(this.value) || '';
      });
      amtInput.addEventListener('blur', function () {
        this.value = this.value
          ? App.calc.formatWithSpaces(App.calc.parseFormatted(this.value))
          : '';
        updateDriftAmount(idx, App.calc.parseFormatted(this.value));
        applyDriftTotal();
      });
      amtInput.addEventListener('input', function () {
        applyDriftTotal();
      });

      var suffix = document.createElement('span');
      suffix.className = 'suffix';
      suffix.textContent = label;

      wrap.appendChild(amtInput);
      wrap.appendChild(suffix);

      // Delete button
      var delBtn = document.createElement('button');
      delBtn.className = 'drift-delete';
      delBtn.title = 'Remove';
      delBtn.textContent = '\xd7';
      delBtn.addEventListener('click', function () {
        removeDriftItem(item.id);
      });

      row.appendChild(labelInput);
      row.appendChild(wrap);
      row.appendChild(delBtn);
      list.appendChild(row);
    });

    updateDriftTotal();
  }

  function updateDriftAmount(idx, inputVal) {
    var monthly = driftYearly ? inputVal / 12 : inputVal;
    driftItems[idx].amount = monthly;
    saveDriftItems();
  }

  // Display-only: refresh the modal's total line
  function updateDriftTotal() {
    var total = 0;
    document.querySelectorAll('input[data-drift-idx]').forEach(function (el) {
      var rawVal = App.calc.parseFormatted(el.value) || 0;
      total += driftYearly ? rawVal / 12 : rawVal;
    });
    document.getElementById('driftModalTotal').textContent = App.calc.fmt(total);
    return total;
  }

  // User-edit path: also write the total back to the main field —
  // including 0, so clearing all items doesn't leave a stale value
  function applyDriftTotal() {
    var total = updateDriftTotal();
    var driftEl = document.getElementById('driftkostnad');
    driftEl.value = total > 0 ? App.calc.formatWithSpaces(total) : '0';
    App.recalc();  // App.recalc() from app.js
    markDirty();   // global from app.js
  }

  // ── Savings modal ─────────────────────────────────────────────────
  // FUTURE: extract to savings.js once >200 lines

  function loadSavingsItemsFromStorage() {
    try {
      var stored = JSON.parse(localStorage.getItem('bostadskalkyl_savings_items_v1'));
      savingsItems = stored && stored.length ? stored : [];
    } catch (_) { savingsItems = []; }
  }

  function saveSavingsItems() {
    App.storage.saveSavingsItems(savingsItems); // fire-and-forget
  }

  function openSavingsModal() {
    loadSavingsItemsFromStorage();
    renderSavingsItems();
    document.getElementById('savingsModal').classList.add('open');
  }

  function closeSavingsModal() {
    animateClose('savingsModal');
  }

  document.getElementById('savingsModal').addEventListener('click', function (e) {
    if (e.target === this) closeSavingsModal();
  });

  function addSavingsItem() {
    savingsItems.push({ id: 'sav_' + Date.now(), label: '', amount: 0 });
    saveSavingsItems();
    renderSavingsItems();
    var inputs = document.querySelectorAll('.savings-label-input');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }

  function removeSavingsItem(id) {
    savingsItems = savingsItems.filter(function (s) { return s.id !== id; });
    saveSavingsItems();
    renderSavingsItems();
    updateSavingsTotal();
  }

  function renderSavingsItems() {
    var list = document.getElementById('savingsItemList');
    list.innerHTML = '';
    savingsItems.forEach(function (item, idx) {
      var displayVal = item.amount > 0 ? App.calc.formatWithSpaces(item.amount) : '';

      var row = document.createElement('div');
      row.className = 'drift-item-row';

      // Label input
      var labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.className = 'drift-item-label-input savings-label-input';
      labelInput.placeholder = 'e.g. ISK savings';
      labelInput.value = item.label;
      labelInput.addEventListener('change', function () {
        savingsItems[idx].label = this.value;
        saveSavingsItems();
      });

      // Amount input wrap
      var wrap = document.createElement('div');
      wrap.className = 'input-wrap has-suffix';

      var amtInput = document.createElement('input');
      amtInput.type = 'text';
      amtInput.inputMode = 'numeric';
      amtInput.value = displayVal;
      amtInput.placeholder = '0';
      amtInput.dataset.savingsIdx = idx;
      amtInput.addEventListener('focus', function () {
        this.value = App.calc.parseFormatted(this.value) || '';
      });
      amtInput.addEventListener('blur', function () {
        this.value = this.value
          ? App.calc.formatWithSpaces(App.calc.parseFormatted(this.value))
          : '';
        savingsItems[idx].amount = App.calc.parseFormatted(this.value);
        saveSavingsItems();
        updateSavingsTotal();
      });
      amtInput.addEventListener('input', function () {
        updateSavingsTotal();
      });

      var suffix = document.createElement('span');
      suffix.className = 'suffix';
      suffix.textContent = 'kr';

      wrap.appendChild(amtInput);
      wrap.appendChild(suffix);

      // Delete button
      var delBtn = document.createElement('button');
      delBtn.className = 'drift-delete';
      delBtn.title = 'Remove';
      delBtn.textContent = '\xd7';
      delBtn.addEventListener('click', function () {
        removeSavingsItem(item.id);
      });

      row.appendChild(labelInput);
      row.appendChild(wrap);
      row.appendChild(delBtn);
      list.appendChild(row);
    });
    updateSavingsTotal();
  }

  function updateSavingsTotal() {
    var total = 0;
    document.querySelectorAll('input[data-savings-idx]').forEach(function (el) {
      total += App.calc.parseFormatted(el.value) || 0;
    });
    document.getElementById('savingsModalTotal').textContent = App.calc.fmt(total);
    App.recalc();   // App.recalc() from app.js
  }

  // ── Overlay stack helpers (Escape + focus trap) ────────────────────
  // Priority order: fullscreen chart sits above the amort modal, the
  // save prompt above everything else
  var OVERLAY_IDS = ['chartFullscreen', 'savePrompt', 'scenariosModal', 'amortModal', 'driftModal', 'savingsModal'];
  var OVERLAY_CLOSERS = {
    chartFullscreen: function () { App.charts.closeFullscreenChart(); },
    savePrompt:      function () { closeSavePrompt(); },
    scenariosModal:  function () { closeScenariosModal(); },
    amortModal:      function () { closeAmortModal(); },
    driftModal:      function () { closeDriftModal(); },
    savingsModal:    function () { closeSavingsModal(); },
  };

  function topOverlay() {
    for (var i = 0; i < OVERLAY_IDS.length; i++) {
      var el = document.getElementById(OVERLAY_IDS[i]);
      if (el && el.classList.contains('open')) return el;
    }
    return null;
  }

  // Escape closes the topmost open overlay; Tab is trapped inside it
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var top = topOverlay();
      if (top) OVERLAY_CLOSERS[top.id]();
      return;
    }
    if (e.key !== 'Tab') return;
    var overlay = topOverlay();
    if (!overlay) return;
    var nodes = overlay.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])');
    var focusables = [];
    nodes.forEach(function (n) {
      if (!n.disabled && n.getClientRects().length > 0) focusables.push(n);
    });
    if (!focusables.length) return;
    var first  = focusables[0];
    var last   = focusables[focusables.length - 1];
    var active = document.activeElement;
    if (!overlay.contains(active)) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && active === first)       { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last)  { e.preventDefault(); first.focus(); }
  });

  // ── Static button event wiring ─────────────────────────────────────
  document.getElementById('scenariosBtn').addEventListener('click', openScenariosModal);
  document.getElementById('saveBtn').addEventListener('click', handleSaveClick);
  document.getElementById('scenariosCloseBtn').addEventListener('click', closeScenariosModal);
  document.getElementById('saveCancelBtn').addEventListener('click', closeSavePrompt);
  document.getElementById('saveConfirmBtn').addEventListener('click', confirmSave);
  document.getElementById('pnl-card').addEventListener('click', openSavingsModal);
  document.getElementById('mortgageCard').addEventListener('click', openAmortModal);
  document.getElementById('driftCard').addEventListener('click', openDriftModal);
  document.getElementById('amortCloseBtn').addEventListener('click', closeAmortModal);
  document.getElementById('driftCloseBtn').addEventListener('click', closeDriftModal);
  document.getElementById('driftYearlyToggle').addEventListener('change', toggleDriftMode);
  document.getElementById('addDriftItemBtn').addEventListener('click', addDriftItem);
  document.getElementById('savingsCloseBtn').addEventListener('click', closeSavingsModal);
  document.getElementById('addSavingsItemBtn').addEventListener('click', addSavingsItem);
  document.getElementById('undoToastBtn').addEventListener('click', undoDelete);

  // ── Export ─────────────────────────────────────────────────────────
  // Public API via App.modals
  window.App.modals = {
    updateHeaderLabel:       updateHeaderLabel,
    getSavingsTotal:         getSavingsTotal,
    setDriftItems:           setDriftItems,
    setSavingsItems:         setSavingsItems,
    handleSaveClick:         handleSaveClick,
    openNewSavePrompt:       openNewSavePrompt,
    closeSavePrompt:         closeSavePrompt,
    confirmSave:             confirmSave,
    openScenariosModal:      openScenariosModal,
    closeScenariosModal:     closeScenariosModal,
    renderScenariosModal:    renderScenariosModal,
    loadScenario:            loadScenario,
    duplicateScenario:       duplicateScenario,
    deleteScenario:          deleteScenario,
    undoDelete:              undoDelete,
    openAmortModal:          openAmortModal,
    closeAmortModal:         closeAmortModal,
    openDriftModal:          openDriftModal,
    closeDriftModal:         closeDriftModal,
    toggleDriftMode:         toggleDriftMode,
    addDriftItem:            addDriftItem,
    removeDriftItem:         removeDriftItem,
    updateDriftAmount:       updateDriftAmount,
    updateDriftTotal:        updateDriftTotal,
    applyDriftTotal:         applyDriftTotal,
    openSavingsModal:        openSavingsModal,
    closeSavingsModal:       closeSavingsModal,
    addSavingsItem:          addSavingsItem,
    removeSavingsItem:       removeSavingsItem,
    updateSavingsTotal:      updateSavingsTotal,
    loadSavingsItemsFromStorage: loadSavingsItemsFromStorage,
    loadDriftItemsFromStorage:   loadDriftItemsFromStorage,
  };

}());
