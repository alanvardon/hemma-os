console.log('[Bostadskalkyl] app.js loaded');
  // Shorthand aliases for App.calc and App.dom functions used throughout this file
  const fmt             = (...a) => App.calc.fmt(...a);
  const pct             = (...a) => App.calc.pct(...a);
  const formatWithSpaces = (...a) => App.calc.formatWithSpaces(...a);
  const parseFormatted  = (...a) => App.calc.parseFormatted(...a);
  const set             = (...a) => App.dom.set(...a);
  const val             = (...a) => App.dom.val(...a);

  // Legacy key constants kept for reference; actual storage uses App.storage


  // ── State ───────────────────────────────────────────────────────
  let activeScenarioId = null;  // id of loaded scenario, or null
  let isDirty = false;          // unsaved changes since last save/load

  // ── Input IDs ──────────────────────────────────────────────────
  const CURRENCY_IDS = ['salePrice','currentMortgage','agentCost','movingCost','newPrice','deposit','existingPantbrev','propertyTax','driftkostnad'];
  const NUMBER_IDS   = ['amortRate','interestRateA','interestRateB','currentTerm','currentAmortRate','affordThreshold'];
  const TEXT_IDS     = ['bankAName','bankBName','listingUrl'];
  const ALL_IDS      = [...CURRENCY_IDS, ...NUMBER_IDS];

  // ── Read / write all inputs ─────────────────────────────────────
  function readInputs() {
    const data = {};
    ALL_IDS.forEach(id => { data[id] = val(id); });
    TEXT_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (el) data[id] = el.value;
    });
    data.ranteavdrag = document.getElementById('ranteavdragToggle').checked;
    return data;
  }

  function writeInputs(data) {
    CURRENCY_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (el && data[id] !== undefined) el.value = formatWithSpaces(data[id]);
    });
    NUMBER_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (el && data[id] !== undefined) el.value = data[id];
    });
    TEXT_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (el && data[id] !== undefined) el.value = data[id];
    });
    if (data.ranteavdrag !== undefined) {
      document.getElementById('ranteavdragToggle').checked = data.ranteavdrag;
    }
    App.recalc();
  }

  // ── localStorage helpers — delegating to App.storage ────────────
  // These thin wrappers call App.storage fire-and-forget for writes.
  // Reads are synchronous (App.storage bodies are sync localStorage today).
  // Boot uses the full async path in Commit 2f.

  function loadScenarios() {
    // App.storage.loadScenarios() wraps a sync localStorage call — safe to unwrap here
    var result = [];
    try { result = JSON.parse(localStorage.getItem('bostadskalkyl_scenarios_v1')) || []; } catch (_) {}
    return result;
  }

  function saveScenarios(scenarios) {
    App.storage.saveScenarios(scenarios); // fire-and-forget
  }

  function saveSession() {
    App.storage.saveSession(readInputs(), activeScenarioId, isDirty); // fire-and-forget
  }

  function loadSession() {
    try {
      const s = JSON.parse(localStorage.getItem('bostadskalkyl_session_v1'));
      if (s && s.inputs) {
        writeInputs(s.inputs);
        activeScenarioId = s.activeScenarioId || null;
        isDirty = s.isDirty || false;
        App.modals.updateHeaderLabel();
        return true; // session was loaded
      }
    } catch (_) {}
    return false;
  }


  // ── Mark dirty on any input change ────────────────────────────
  function markDirty() {
    isDirty = true;
    App.modals.updateHeaderLabel();
    saveSession();
  }

  // ── Calc ───────────────────────────────────────────────────────
  function recalc() {
    const salePrice        = val('salePrice');
    const currentMortgage  = val('currentMortgage');
    const agentCost        = val('agentCost');
    const movingCost       = val('movingCost');
    const newPrice         = val('newPrice');
    const deposit          = val('deposit');
    const existingPantbrev = val('existingPantbrev');
    const amortRate        = val('amortRate');
    const propertyTax      = val('propertyTax');
    const driftkostnad     = val('driftkostnad');
    const interestRateA    = val('interestRateA');
    const interestRateB    = val('interestRateB');
    const affordThreshold  = val('affordThreshold') || 30;
    const ranteavdragOn    = document.getElementById('ranteavdragToggle').checked;

    const totalTakeaway     = salePrice - currentMortgage;
    const netProceeds       = totalTakeaway - agentCost - movingCost;
    const loanAmount        = newPrice - deposit;
    const lagfartAmt        = App.calc.lagfart(newPrice);
    const newPantbrevNeeded = Math.max(0, loanAmount - existingPantbrev);
    const pantbrevCostAmt   = App.calc.pantbrevCost(loanAmount, existingPantbrev);
    const totalUpfront      = deposit + lagfartAmt + pantbrevCostAmt;
    const movingCosts       = agentCost + movingCost + lagfartAmt + pantbrevCostAmt;
    const cashBalance       = netProceeds - totalUpfront;
    const ltv               = App.calc.equityPct(loanAmount, newPrice);
    const monthlyAmort      = (loanAmount * (amortRate / 100)) / 12;
    const taxMonthly        = propertyTax / 12;

    // Bank A
    const interestA      = (loanAmount * (interestRateA / 100)) / 12;
    const totalA         = interestA + monthlyAmort + taxMonthly + driftkostnad;
    const annualInterestA = interestA * 12;
    const reliefA        = App.calc.ranteavdrag(annualInterestA);
    const effectiveA     = totalA - reliefA / 12;

    // Bank B
    const interestB      = (loanAmount * (interestRateB / 100)) / 12;
    const totalB         = interestB + monthlyAmort + taxMonthly + driftkostnad;
    const annualInterestB = interestB * 12;
    const reliefB        = App.calc.ranteavdrag(annualInterestB);
    const effectiveB     = totalB - reliefB / 12;
    const diff           = totalA - totalB;
    const totalMonthly   = totalA;

    // ── Ränteavdrag summary card values ───────────────────────
    const relief           = reliefA;
    const effectiveMonthly = effectiveA;

    // ── Affordability ──────────────────────────────────────────
    const monthlyBase      = ranteavdragOn ? effectiveMonthly : totalMonthly;
    const reqSalaryMonthly = monthlyBase / (affordThreshold / 100);

    // ── Equity at key years ───────────────────────────────────
    const annualAmort = loanAmount * (amortRate / 100);
    const equityAt = yr => Math.min(deposit + annualAmort * yr, newPrice);

    // ── Stress slider ──────────────────────────────────────────
    const stressSlider = document.getElementById('stressSlider');
    if (stressSlider.dataset.syncedRate !== String(interestRateA)) {
      stressSlider.value = interestRateA;
      stressSlider.dataset.syncedRate = String(interestRateA);
    }
    const stressRate  = parseFloat(stressSlider.value);
    const stressMI    = (loanAmount * (stressRate / 100)) / 12;
    const stressTotal = stressMI + monthlyAmort + taxMonthly + driftkostnad;
    const stressAnn   = loanAmount * (stressRate / 100);
    const stressRel   = App.calc.ranteavdrag(stressAnn);
    const stressAfter = stressTotal - stressRel / 12;
    document.getElementById('stressRateDisplay').textContent = stressRate.toFixed(2) + '%';
    document.getElementById('stressMonthlyInterest').textContent = fmt(stressMI);
    const stressTotalEl = document.getElementById('stressTotalMonthly');
    stressTotalEl.textContent = fmt(stressTotal);
    stressTotalEl.style.color = stressRate > 6 ? 'var(--warn)' : '';
    document.getElementById('stressAfterRelief').textContent = fmt(stressAfter);

    // ── Deposit % hint ───────────────────────────────────────
    const depPct = newPrice > 0 ? ((deposit / newPrice) * 100).toFixed(1) : '0';
    document.getElementById('depositPct').textContent = depPct + '% of purchase price';

    // ── Inline derived ───────────────────────────────────────
    set('d-takeaway',    fmt(totalTakeaway), totalTakeaway >= 0 ? 'positive' : 'negative');
    set('d-netProceeds', fmt(netProceeds),   netProceeds >= 0 ? 'positive' : 'negative');
    set('d-loanAmount',     fmt(loanAmount));
    set('d-lagfart',        fmt(lagfartAmt));
    set('d-newPantbrevAmt', fmt(newPantbrevNeeded));
    set('d-pantbrevCost',   fmt(pantbrevCostAmt));
    set('d-totalUpfront',   fmt(totalUpfront));
    set('d-cashBalance',    (cashBalance >= 0 ? '+' : '') + fmt(cashBalance), cashBalance >= 0 ? 'positive' : 'negative');

    set('d-interestA', fmt(interestA));
    set('d-amortA',    fmt(monthlyAmort));
    set('d-taxA',      fmt(taxMonthly));
    set('d-driftA',    fmt(driftkostnad));
    set('d-totalA',    fmt(totalA));
    set('d-reliefA',   '−' + fmt(reliefA / 12));
    set('d-effectiveA', fmt(effectiveA));

    set('d-interestB', fmt(interestB));
    set('d-amortB',    fmt(monthlyAmort));
    set('d-taxB',      fmt(taxMonthly));
    set('d-driftB',    fmt(driftkostnad));
    set('d-totalB',    fmt(totalB));
    set('d-reliefB',   '−' + fmt(reliefB / 12));
    set('d-effectiveB', fmt(effectiveB));

    const diffEl    = document.getElementById('d-bankDiff');
    const bankAName = document.getElementById('bankAName').value.trim() || 'Bank A';
    const bankBName = document.getElementById('bankBName').value.trim() || 'Bank B';
    document.getElementById('d-bankDiffLabel').textContent = `Difference (${bankAName} vs ${bankBName})`;
    if (diff > 0) {
      diffEl.textContent = `${bankBName} is cheaper by ${fmt(Math.abs(diff))}/mo`;
      diffEl.className = 'derived-value positive';
    } else if (diff < 0) {
      diffEl.textContent = `${bankAName} is cheaper by ${fmt(Math.abs(diff))}/mo`;
      diffEl.className = 'derived-value positive';
    } else {
      diffEl.textContent = 'Same cost';
      diffEl.className = 'derived-value';
    }

    // ── Summary ───────────────────────────────────────────────
    set('s-netProceeds',  fmt(netProceeds), netProceeds >= 0 ? 'positive' : 'negative');
    set('s-takeaway',     fmt(totalTakeaway));
    set('s-costs',        '−' + fmt(agentCost + movingCost));
    set('s-totalUpfront', fmt(totalUpfront));
    set('s-deposit',      fmt(deposit));
    set('s-lagfart',      fmt(lagfartAmt));
    set('s-pantbrev',     fmt(pantbrevCostAmt));
    set('s-loanAmount',   fmt(loanAmount));
    set('s-ltv',          pct(100 - ltv));  // ltv = loanAmount/price %, equity = 100-ltv
    set('s-totalMonthly', fmt(totalMonthly));
    set('s-interest',     fmt(interestA));
    set('s-amort',        fmt(monthlyAmort));
    set('s-tax',          fmt(taxMonthly));
    set('s-drift',        fmt(driftkostnad));

    // Ränteavdrag card
    const rCard = document.getElementById('ranteavdragCard');
    rCard.style.display = '';
    set('s-ranteavdrag',      fmt(relief / 12) + '/mo');
    set('s-annualInterest',   fmt(annualInterestA) + '/yr');
    set('s-skatteverket',     fmt(relief) + '/yr');
    set('s-effectiveMonthly', fmt(effectiveMonthly));

    // Affordability
    set('s-reqSalary', fmt(reqSalaryMonthly) + '/mo');

    // Equity
    set('s-equity5',  fmt(equityAt(5)),  'positive');
    set('s-equity10', fmt(equityAt(10)), 'positive');
    set('s-equity20', fmt(equityAt(20)), 'positive');

    // LTV bar — shows equity (inverse of LTV)
    const equity = 100 - ltv;
    const ltvBar = document.getElementById('ltv-bar');
    ltvBar.style.width = Math.min(Math.max(equity, 0), 100) + '%';
    ltvBar.style.background = equity < 15 ? 'var(--warn)' : equity < 30 ? 'var(--warn-light)' : 'var(--accent)';

    // P&L card
    const savingsTotal  = App.modals.getSavingsTotal();
    const totalBalance  = cashBalance + savingsTotal;
    const pnlCard = document.getElementById('pnl-card');
    pnlCard.classList.remove('pnl-positive', 'pnl-negative');
    if (totalBalance > 0) pnlCard.classList.add('pnl-positive');
    else if (totalBalance < 0) pnlCard.classList.add('pnl-negative');
    set('s-cashBalance', (totalBalance >= 0 ? '+' : '') + fmt(totalBalance), totalBalance >= 0 ? 'positive' : 'negative');
    set('s-pnl-net',     fmt(netProceeds));
    set('s-pnl-upfront', '−' + fmt(totalUpfront));

    // Savings row in P&L card
    const savingsRow = document.getElementById('s-savings-row');
    if (savingsTotal > 0) {
      savingsRow.style.display = '';
      set('s-savings-total', '+' + fmt(savingsTotal), 'positive');
    } else {
      savingsRow.style.display = 'none';
    }

  }

  // ── Event listeners ────────────────────────────────────────────
  document.querySelectorAll('input[data-type="currency"]').forEach(el => {
    el.addEventListener('focus', function() {
      this.value = parseFormatted(this.value) || '';
    });
    el.addEventListener('blur', function() {
      const n = parseFormatted(this.value);
      if (!isNaN(n) && this.value !== '') this.value = formatWithSpaces(n);
      App.recalc();
      markDirty();
    });
    el.addEventListener('input', () => { App.recalc(); markDirty(); });
  });

  document.querySelectorAll('input[type="number"]').forEach(el => {
    el.addEventListener('input', () => { App.recalc(); markDirty(); });
  });

  document.querySelectorAll('.bank-name-input').forEach(el => {
    el.addEventListener('input', () => { App.recalc(); markDirty(); });
  });

  document.getElementById('listingUrl').addEventListener('input', () => { App.recalc(); markDirty(); });

  // Stress slider
  document.getElementById('stressSlider').addEventListener('input', () => { App.recalc(); });

  // Affordability threshold
  document.getElementById('affordThreshold').addEventListener('input', () => { App.recalc(); markDirty(); });

  // Ränteavdrag toggle
  document.getElementById('ranteavdragToggle').addEventListener('change', () => { App.recalc(); markDirty(); });

  // Listing URL "Open ›" button
  document.getElementById('openListingBtn').addEventListener('click', function () {
    var u = document.getElementById('listingUrl').value.trim();
    if (u) window.location.href = u.startsWith('http') ? u : 'https://' + u;
  });

  // Theme toggle
  document.getElementById('themeToggleBtn').addEventListener('click', toggleTheme);

  // ── Theme ──────────────────────────────────────────────────────
  function initTheme() {
    App.storage.loadTheme().then(function (stored) {
      const theme = stored === 'dark' ? 'dark' : 'light';
      document.documentElement.dataset.theme = theme;
      const btn = document.getElementById('themeToggleBtn');
      if (btn) btn.textContent = theme === 'dark' ? '☾' : '☀';
    });
  }

  function toggleTheme() {
    const current = document.documentElement.dataset.theme;
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    App.storage.saveTheme(next); // fire-and-forget
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.textContent = next === 'dark' ? '☾' : '☀';
    App.charts.renderAmortChart();
  }

  // ── Expose App.recalc ────────────────────────────────────────────
  App.recalc = recalc;

  // ── Boot ───────────────────────────────────────────────────────
  initTheme();
  (async function boot() {
    var driftItems = await App.storage.loadDriftItems();
    App.modals.setDriftItems(driftItems);
    var savingsItems = await App.storage.loadSavingsItems();
    App.modals.setSavingsItems(savingsItems);
    var session = await App.storage.loadSession();
    if (session && session.inputs) {
      writeInputs(session.inputs);
      activeScenarioId = session.activeScenarioId || null;
      isDirty = session.isDirty || false;
      App.modals.updateHeaderLabel();
    }
    App.recalc();
    document.querySelector('.inputs-col').classList.remove('inputs-loading');
  })();
