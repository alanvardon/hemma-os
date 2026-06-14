/* lonevaxling.js — Löneväxling: salary sacrifice into pension, Sweden 2026.
   "Is it worth swapping salary for pension — and how much?" Turns a gross
   salary + a monthly sacrifice into: the eligibility verdict (are you above the
   income-pension ceiling?), the tax you save right now, the employer payroll-tax
   uplift, and what it's worth net once you draw the pension.

   The pure math section is exported for node tests; everything below the DOM
   guard only runs in the browser.

   All tax constants are for INCOME YEAR 2026 (same sources as konsultkalkyl.js —
   Skatteverket "Belopp och procent 2026"):
     • Prisbasbelopp (PBB) .................... 59 200 kr
     • Inkomstbasbelopp (IBB) ................. 83 400 kr
     • Statlig skatt: 20 % over skiktgräns .... 643 000 kr (taxable income)
     • Arbetsgivaravgift (employer fee) ....... 31.42 %
     • Särskild löneskatt (on pension) ........ 24.26 %

   Why a salary FLOOR exists: the public income pension is only earned on salary
   up to 8.07 × IBB (the 7.5 IBB pensionsgrundande-inkomst ceiling grossed up for
   the 7 % allmän pensionsavgift). Sacrifice below that and you shrink your state
   pension, so 8.07 × IBB ÷ 12 ≈ 56 087 kr/mån is the eligibility floor.

   Why the EMPLOYER UPLIFT exists: salary carries 31.42 % arbetsgivaravgift, a
   pension premium only 24.26 % särskild löneskatt. Redirecting the same employer
   cost to pension affords 1.3142 / 1.2426 − 1 ≈ 5.76 % more — the växlingsuppräkning,
   which good employers add to the premium. */
(function () {
  'use strict';

  // ── 2026 constants ───────────────────────────────────────────────
  var PBB_2026 = 59200;               // prisbasbelopp
  var IBB_2026 = 83400;               // inkomstbasbelopp
  var STATE_TAX_SKIKTGRANS = 643000;  // taxable income where statlig skatt (20 %) starts
  var STATE_TAX_RATE = 0.20;
  var EMPLOYER_FEE = 31.42;           // arbetsgivaravgift, %
  var SARSKILD_LONESKATT = 24.26;     // särskild löneskatt på pension, %

  var PENSION_CEILING_YR = 8.07 * IBB_2026;                 // 673 038 → /12 ≈ 56 087 kr/mån
  var SGI_CEILING_YR = 10 * PBB_2026;                       // sjuk-/föräldrapenning ceiling (10 PBB)
  var DEFAULT_UPLIFT = ((1 + EMPLOYER_FEE / 100) / (1 + SARSKILD_LONESKATT / 100) - 1) * 100; // ≈ 5.76 %

  // ── Pure: defaults ───────────────────────────────────────────────
  // Salary / sacrifice are MONTHLY; rates are percentages.
  function defaultInputs() {
    return {
      grossSalaryMonthly: 65000,   // gross salary before any sacrifice
      sacrificeMonthly: 5000,      // amount swapped into pension each month
      upliftPct: 5.76,             // employer payroll-tax uplift added to the premium
      withdrawalTaxPct: 32,        // assumed tax rate when the pension is drawn
      municipalTaxPct: 32.38       // kommunalskatt (national average; set your kommun's)
    };
  }

  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : (parseFloat(v) || 0); }

  // Grundavdrag for employment income, under 66, 2026 (bracket formula in PBB,
  // rounded UP to nearest 100 kr). Copied from konsultkalkyl.js by the project's
  // "each page owns its math" convention (no cross-tool load-order coupling).
  function grundavdrag(income, pbb) {
    var ff = Math.max(0, income);
    var g;
    if (ff <= 0.99 * pbb)      g = 0.423 * pbb;
    else if (ff <= 2.72 * pbb) g = 0.423 * pbb + 0.20 * (ff - 0.99 * pbb);
    else if (ff <= 3.11 * pbb) g = 0.77 * pbb;
    else if (ff <= 7.88 * pbb) g = 0.77 * pbb - 0.10 * (ff - 3.11 * pbb);
    else                       g = 0.293 * pbb;
    return Math.ceil(g / 100) * 100;
  }

  // Jobbskatteavdrag (skattereduktion för arbetsinkomst), under 66, 2026.
  // Copied from konsultkalkyl.js — same calibration.
  function jobbskatteavdrag(arbetsinkomst, ga, kommunalRate, pbb) {
    var ai = Math.max(0, arbetsinkomst);
    var PLATEAU = 3.027;
    var base;
    if (ai <= 0.91 * pbb) {
      base = ai;
    } else if (ai <= 3.24 * pbb) {
      base = 0.91 * pbb + 0.3874 * (ai - 0.91 * pbb);
    } else if (ai <= 8.08 * pbb) {
      var b2end = 0.91 * pbb + 0.3874 * (3.24 - 0.91) * pbb;
      var slope = (PLATEAU * pbb - b2end) / ((8.08 - 3.24) * pbb);
      base = b2end + slope * (ai - 3.24 * pbb);
    } else if (ai <= 13.54 * pbb) {
      base = PLATEAU * pbb;
    } else {
      base = PLATEAU * pbb - 0.03 * (ai - 13.54 * pbb);
    }
    return Math.max(0, (base - ga) * kommunalRate);
  }

  // Net employment salary for a yearly gross, under 66, 2026. Factors the inline
  // personal-tax math from konsultkalkyl.computeContracting into one helper.
  function netEmploymentSalary(grossAnnual, kommunalRate) {
    var gross = Math.max(0, grossAnnual);
    var ga = grundavdrag(gross, PBB_2026);
    var taxable = Math.max(0, gross - ga);
    var municipalTax = taxable * kommunalRate;
    var stateTax = Math.max(0, taxable - STATE_TAX_SKIKTGRANS) * STATE_TAX_RATE;
    var jsaRaw = jobbskatteavdrag(gross, ga, kommunalRate, PBB_2026);
    var workTaxCredit = Math.min(jsaRaw, municipalTax + stateTax);
    var net = gross - municipalTax - stateTax + workTaxCredit;
    return {
      net: net,
      municipalTax: municipalTax,
      stateTax: stateTax,
      workTaxCredit: workTaxCredit,
      grundavdrag: ga,
      taxableIncome: taxable
    };
  }

  // The whole picture. Yearly kronor where it's an amount (the DOM divides by 12
  // for the monthly column); rates are fractions (0–1). No growth/compounding —
  // the "at withdrawal" figures are in today's kronor.
  function computeLonevaxling(input) {
    var d = Object.assign(defaultInputs(), input || {});
    var kommunalRate = num(d.municipalTaxPct) / 100;

    var grossMo = Math.max(0, num(d.grossSalaryMonthly));
    var grossYr = grossMo * 12;
    var sacrificeMo = Math.max(0, num(d.sacrificeMonthly));
    var sacrificeYr = Math.min(sacrificeMo * 12, grossYr);
    var cashAfterYr = grossYr - sacrificeYr;
    var cashAfterMo = cashAfterYr / 12;

    // Net pay with vs without the sacrifice — the difference is what you actually
    // give up, and the rest of the sacrificed slice is tax you no longer pay now.
    var before = netEmploymentSalary(grossYr, kommunalRate);
    var after = netEmploymentSalary(cashAfterYr, kommunalRate);
    var takeHomeReduction = before.net - after.net;          // net salary given up (yearly)
    var taxSavedNow = sacrificeYr - takeHomeReduction;        // tax not paid now (yearly)
    var marginalRateNow = sacrificeYr > 0 ? taxSavedNow / sacrificeYr : 0;

    // Employer uplift → pension premium → its value net of tax at withdrawal.
    var upliftPct = num(d.upliftPct);
    var premiumToPension = sacrificeYr * (1 + upliftPct / 100);
    var upliftAmount = premiumToPension - sacrificeYr;
    var withdrawalRate = num(d.withdrawalTaxPct) / 100;
    var netPensionValue = premiumToPension * (1 - withdrawalRate);
    var leverage = takeHomeReduction > 0 ? netPensionValue / takeHomeReduction : 0;

    // Eligibility & ceilings (monthly).
    var ceilingMo = PENSION_CEILING_YR / 12;
    var sgiCeilingMo = SGI_CEILING_YR / 12;
    var brytpunktYr = STATE_TAX_SKIKTGRANS + grundavdrag(STATE_TAX_SKIKTGRANS, PBB_2026);
    var brytpunktMo = brytpunktYr / 12;

    var eligible = grossMo > ceilingMo;
    var maxSafeSacrifice = Math.max(0, grossMo - ceilingMo);   // monthly
    var suggestedSacrifice = maxSafeSacrifice;                  // sacrifice down to the ceiling

    var EPS = 1e-6;
    var flags = {
      notEligible: !eligible,
      // eligible but sacrificing so much you dip under the pension ceiling
      overSacrificed: eligible && cashAfterMo < ceilingMo - EPS,
      belowSgi: sacrificeYr > 0 && cashAfterMo < sgiCeilingMo - EPS,
      belowBrytpunkt: sacrificeYr > 0 && cashAfterMo < brytpunktMo - EPS,
      withdrawalNotBelowMarginal: sacrificeYr > 0 && withdrawalRate >= marginalRateNow - 1e-9
    };

    return {
      // inputs echoed (yearly amounts)
      grossSalary: grossYr,
      sacrifice: sacrificeYr,
      cashAfter: cashAfterYr,
      // now
      netGivenUp: takeHomeReduction,
      taxSavedNow: taxSavedNow,
      marginalRateNow: marginalRateNow,
      // pension
      premiumToPension: premiumToPension,
      upliftAmount: upliftAmount,
      netPensionValue: netPensionValue,
      withdrawalRate: withdrawalRate,
      leverage: leverage,
      leveragePct: (leverage - 1) * 100,
      // eligibility
      eligible: eligible,
      ceilingMonthly: ceilingMo,
      sgiCeilingMonthly: sgiCeilingMo,
      brytpunktMonthly: brytpunktMo,
      maxSafeSacrifice: maxSafeSacrifice,
      suggestedSacrifice: suggestedSacrifice,
      flags: flags
    };
  }

  var api = {
    PBB_2026: PBB_2026,
    IBB_2026: IBB_2026,
    STATE_TAX_SKIKTGRANS: STATE_TAX_SKIKTGRANS,
    PENSION_CEILING_YR: PENSION_CEILING_YR,
    SGI_CEILING_YR: SGI_CEILING_YR,
    DEFAULT_UPLIFT: DEFAULT_UPLIFT,
    defaultInputs: defaultInputs,
    grundavdrag: grundavdrag,
    jobbskatteavdrag: jobbskatteavdrag,
    netEmploymentSalary: netEmploymentSalary,
    computeLonevaxling: computeLonevaxling
  };

  // Browser export
  if (typeof window !== 'undefined') {
    window.App = window.App || {};
    window.App.lonevaxling = api;
  }
  // Guarded CJS export for node --test (lonevaxling.test.js)
  if (typeof module !== 'undefined') module.exports = api;

  // ────────────────────────────────────────────────────────────────
  // DOM wiring (browser only)
  // ────────────────────────────────────────────────────────────────
  if (typeof document === 'undefined' || !document.getElementById('o-leverage')) return;

  var STORAGE_KEY = 'bostadskalkyl_lonevaxling_v1';
  var C = window.App.calc;

  // input id → state key, with formatting kind ('cur' = thousands-spaced, 'num' = plain)
  var FIELDS = [
    { id: 'in-gross',        key: 'grossSalaryMonthly', kind: 'cur' },
    { id: 'in-sacrifice',    key: 'sacrificeMonthly',   kind: 'cur' },
    { id: 'in-uplift',       key: 'upliftPct',          kind: 'num' },
    { id: 'in-withdrawalTax', key: 'withdrawalTaxPct',  kind: 'num' },
    { id: 'in-municipalTax', key: 'municipalTaxPct',    kind: 'num' }
  ];

  // result key → [monthly element id, yearly element id]
  var PAIRS = [
    ['sacrifice',        'o-sacrifice-m',   'o-sacrifice-y'],
    ['netGivenUp',       'o-netGivenUp-m',  'o-netGivenUp-y'],
    ['taxSavedNow',      'o-taxSaved-m',    'o-taxSaved-y'],
    ['premiumToPension', 'o-premium-m',     'o-premium-y'],
    ['upliftAmount',     'o-uplift-m',      'o-uplift-y'],
    ['netPensionValue',  'o-netPension-m',  'o-netPension-y']
  ];

  var state = load();
  var lastResult = null;

  function load() {
    var s = defaultInputs();
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        Object.keys(s).forEach(function (k) {
          if (typeof saved[k] === 'number' && isFinite(saved[k])) s[k] = saved[k];
        });
      }
    } catch (_) {}
    return s;
  }

  var saveTimer = null;
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
    var badge = document.getElementById('saveState');
    if (!badge) return;
    badge.classList.add('show');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { badge.classList.remove('show'); }, 1400);
  }

  // ── Formatters ──
  function money(n) { return C.formatWithSpaces(Math.round(n)) + ' kr'; }
  function pct0(x) { return Math.round(x) + ' %'; }
  function signedPct0(x) { return (x >= 0 ? '+' : '−') + Math.abs(Math.round(x)) + ' %'; }
  function numStr(n) { return (Math.round(n * 100) / 100).toString().replace('.', ','); }
  function curStr(n) { return C.formatWithSpaces(Math.round(n)); }

  function setText(id, str) {
    var el = document.getElementById(id);
    if (el) el.textContent = str;
  }

  function fieldByInput(id) {
    for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i].id === id) return FIELDS[i];
    return null;
  }

  function fillInputs() {
    FIELDS.forEach(function (f) {
      var el = document.getElementById(f.id);
      if (!el) return;
      el.value = f.kind === 'cur' ? curStr(state[f.key]) : numStr(state[f.key]);
    });
  }

  // ── Build the warnings list from the flags ──
  function renderWarnings(r) {
    var list = document.getElementById('warnList');
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);

    var items = [];
    var f = r.flags;
    if (f.notEligible) {
      items.push(['warn-amber',
        'Din lön (' + money(r.grossSalary / 12) + '/mån) ligger under pensionstaket ' +
        money(r.ceilingMonthly) + '/mån. Löneväxling minskar då din allmänna pension — växla helst inte.']);
    } else if (f.overSacrificed) {
      items.push(['warn-amber',
        'Du växlar ner under pensionstaket. Sänk växlingen till ' +
        money(r.suggestedSacrifice) + '/mån för att behålla full allmän pension.']);
    } else {
      items.push(['warn-good',
        'Lönen efter växling håller sig över pensionstaket ' + money(r.ceilingMonthly) + '/mån.']);
    }
    if (f.belowSgi) {
      items.push(['warn-amber',
        'Lönen efter växling understiger taket för sjuk- och föräldrapenning (' +
        money(r.sgiCeilingMonthly) + '/mån) — det kan sänka de ersättningarna.']);
    }
    if (f.belowBrytpunkt) {
      items.push(['warn-info',
        'En del av växlingen ligger under brytpunkten (' + money(r.brytpunktMonthly) +
        '/mån) — där sparar du bara kommunalskatt, inte den statliga skatten på 20 %.']);
    }
    if (f.withdrawalNotBelowMarginal) {
      items.push(['warn-amber',
        'Skatten vid uttag (' + pct0(r.withdrawalRate * 100) + ') är minst lika hög som din ' +
        'marginalskatt nu (' + pct0(r.marginalRateNow * 100) + '). Vinsten kommer då bara från ' +
        'uppräkningen, inte skatteskillnaden.']);
    }

    items.forEach(function (it) {
      var li = document.createElement('li');
      li.classList.add('warn-item', it[0]);
      var dot = document.createElement('span');
      dot.classList.add('warn-dot');
      var txt = document.createElement('span');
      txt.classList.add('warn-text');
      txt.textContent = it[1];
      li.appendChild(dot);
      li.appendChild(txt);
      list.appendChild(li);
    });
  }

  // ── Recalculate & render ──
  function recalc() {
    var r = computeLonevaxling(state);
    lastResult = r;

    PAIRS.forEach(function (p) {
      setText(p[1], money(r[p[0]] / 12));
      setText(p[2], money(r[p[0]]));
    });

    // single-value ledger cells
    setText('o-marginal', pct0(r.marginalRateNow * 100));
    setText('o-withdrawalRate', pct0(r.withdrawalRate * 100));
    var spread = (r.marginalRateNow - r.withdrawalRate) * 100;
    setText('o-spread', (spread >= 0 ? '+' : '−') + Math.abs(Math.round(spread)) + ' pp');

    // eligibility verdict
    var verdict = document.getElementById('verdictBox');
    if (verdict) {
      verdict.classList.toggle('verdict-good', r.eligible);
      verdict.classList.toggle('verdict-warn', !r.eligible);
    }
    setText('o-verdictIcon', r.eligible ? '✓' : '⚠');
    setText('o-verdict', r.eligible
      ? 'Du är över pensionstaket — du kan växla upp till ' + money(r.maxSafeSacrifice) + '/mån.'
      : 'Du behöver tjäna minst ' + money(r.ceilingMonthly) + '/mån innan löneväxling lönar sig.');

    // hero — leverage headline
    setText('o-leverage', r.leverage > 0 ? signedPct0(r.leveragePct) : '—');
    setText('o-leverageSub', r.netGivenUp > 0
      ? 'Du avstår ' + money(r.netGivenUp / 12) + ' netto/mån och får ' +
        money(r.netPensionValue / 12) + ' (efter skatt) till pension.'
      : 'Ange en löneväxling för att se hävstången.');
    setText('o-heroGiveUp', money(r.netGivenUp / 12));
    setText('o-heroGet', money(r.netPensionValue / 12));

    // mini-readout under the salary inputs
    setText('o-ceiling', money(r.ceilingMonthly));
    setText('o-maxSafe', money(r.maxSafeSacrifice) + '/mån');

    renderWarnings(r);

    // mobile bar
    setText('m-giveUp', money(r.netGivenUp / 12));
    setText('m-leverage', r.leverage > 0 ? signedPct0(r.leveragePct) : '—');
  }

  // ── Input handling (delegated) ──
  document.querySelector('.inputs-col').addEventListener('input', function (e) {
    var f = fieldByInput(e.target.id);
    if (!f) return;
    state[f.key] = C.parseFormatted(e.target.value);
    recalc();
    save();
  });

  document.querySelector('.inputs-col').addEventListener('focusout', function (e) {
    var f = fieldByInput(e.target.id);
    if (!f) return;
    e.target.value = f.kind === 'cur' ? curStr(state[f.key]) : numStr(state[f.key]);
  });

  // ── Suggest optimal sacrifice ──
  var suggestBtn = document.getElementById('btn-suggest');
  if (suggestBtn) suggestBtn.addEventListener('click', function () {
    var r = lastResult || computeLonevaxling(state);
    state.sacrificeMonthly = Math.round(r.suggestedSacrifice);
    fillInputs();
    recalc();
    save();
  });

  // ── Reset ──
  var resetBtn = document.getElementById('resetBtn');
  if (resetBtn) resetBtn.addEventListener('click', function () {
    state = defaultInputs();
    fillInputs();
    recalc();
    save();
  });

  // ── Theme toggle (shared key with the rest of Hemma) ──
  var THEME_KEY = 'bostadskalkyl_theme';
  var themeBtn = document.getElementById('themeToggleBtn');

  function applyThemeIcon() {
    if (themeBtn) themeBtn.textContent = document.documentElement.dataset.theme === 'dark' ? '☾' : '☀';
  }
  function syncThemeColor() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
  }
  if (themeBtn) themeBtn.addEventListener('click', function () {
    var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
    applyThemeIcon();
    syncThemeColor();
  });
  applyThemeIcon();
  syncThemeColor();

  // ── Boot ──
  fillInputs();
  recalc();
}());
