/* budget.js — Hushållsbudget: the household pot.
   Two adults pool every income into one pot, split it equally back,
   then pay joint costs 50/50 and individual costs from their own share.
   The pure math section is exported for node tests; everything below
   the DOM guard only runs in the browser. */
(function () {
  'use strict';

  // ── Pure: defaults & computation ─────────────────────────────────
  // Rows are grouped by owner: 'joint' (split 50/50), 'a' or 'b' (one person).

  function defaultState() {
    var id = 0;
    function row(label, amount, owner, category) {
      var r = { id: 'r' + (++id), label: label, amount: amount, owner: owner };
      if (category) r.category = category;
      return r;
    }
    var s = {
      version: 1,
      people: ['Alan', 'Partner'],
      // Categories group the JOINT costs (split 50/50). Individual costs aren't
      // categorised. Rows reference a category by id; drag-and-drop reassigns it.
      categories: [
        { id: 'c-boende',     name: 'Boende' },
        { id: 'c-hushall',    name: 'Mat & hushåll' },
        { id: 'c-transport',  name: 'Transport' },
        { id: 'c-forsakring', name: 'Försäkring & barn' },
        { id: 'c-ovrigt',     name: 'Övrigt' }
      ],
      incomes: [
        row('Lön / Salary', 46000, 'a'),
        row('Lön / Salary', 39000, 'b'),
        row('Barnbidrag', 2650, 'joint')
      ],
      costs: [
        // Joint — grouped into categories
        row('Bolån (ränta & amortering)', 12775, 'joint', 'c-boende'),
        row('El / Electricity', 2101, 'joint', 'c-boende'),
        row('Vatten & avlopp', 231, 'joint', 'c-boende'),
        row('Fastighetsavgift', 397, 'joint', 'c-boende'),
        row('Matvaror & hushåll', 9700, 'joint', 'c-hushall'),
        row('Restaurang & takeaway', 3000, 'joint', 'c-hushall'),
        row('Bilkostnad / leasing', 3500, 'joint', 'c-transport'),
        row('Bränsle, parkering & SL', 2970, 'joint', 'c-transport'),
        row('Försäkringar (hem, bil, barn, liv)', 1455, 'joint', 'c-forsakring'),
        row('Förskola, fritids & aktiviteter', 3300, 'joint', 'c-forsakring'),
        row('Bredband & streaming', 413, 'joint', 'c-ovrigt'),
        row('Kläder, hälsa & presenter', 2700, 'joint', 'c-ovrigt'),
        row('Diverse / oförutsett', 2000, 'joint', 'c-ovrigt'),
        // Individual
        row('Mobil', 300, 'a'),
        row('Gym', 500, 'a'),
        row('Hobby', 700, 'a'),
        row('Mobil', 300, 'b'),
        row('Gym', 450, 'b'),
        row('Hobby', 600, 'b')
      ],
      savings: [
        // Each person saves from their own take-home share
        row('Pension (eget)', 4000, 'a'),
        row('ISK / fondsparande', 3000, 'a'),
        row('Sparkonto / buffert', 1500, 'a'),
        row('Pension (eget)', 4000, 'b'),
        row('ISK / fondsparande', 3000, 'b'),
        row('Sparkonto / buffert', 1500, 'b')
      ]
    };
    s.seq = id;
    s.catSeq = 0;
    return s;
  }

  function computeBudget(state) {
    state = state || {};
    var incomes = state.incomes || [];
    var costs   = state.costs   || [];
    var savings = state.savings || [];

    function sum(rows, owner) {
      var t = 0;
      for (var i = 0; i < rows.length; i++) {
        if (owner === undefined || rows[i].owner === owner) t += (rows[i].amount || 0);
      }
      return t;
    }

    var incomeA     = sum(incomes, 'a');
    var incomeB     = sum(incomes, 'b');
    var incomeJoint = sum(incomes, 'joint');
    var totalIncome = incomeA + incomeB + incomeJoint;
    var equalShare  = totalIncome / 2;

    var costsJoint = sum(costs, 'joint');
    var costsA     = sum(costs, 'a');
    var costsB     = sum(costs, 'b');
    var totalCosts = costsJoint + costsA + costsB;

    // Break the joint costs down by category, in the user's category order.
    // Joint rows with no/unknown category collect into an "Övrigt" bucket.
    var cats = state.categories || [];
    var catTotals = {};
    cats.forEach(function (c) { catTotals[c.id] = 0; });
    var otherTotal = 0;
    for (var ci = 0; ci < costs.length; ci++) {
      var cr = costs[ci];
      if (cr.owner !== 'joint') continue;
      if (cr.category && Object.prototype.hasOwnProperty.call(catTotals, cr.category)) {
        catTotals[cr.category] += (cr.amount || 0);
      } else {
        otherTotal += (cr.amount || 0);
      }
    }
    var jointCategories = cats.map(function (c) {
      return { id: c.id, name: c.name, amount: catTotals[c.id] };
    });
    if (otherTotal > 0) jointCategories.push({ id: '_other', name: 'Övrigt', amount: otherTotal });

    var savingsJoint = sum(savings, 'joint');
    var savingsA     = sum(savings, 'a');
    var savingsB     = sum(savings, 'b');
    var totalSavings = savingsJoint + savingsA + savingsB;

    // The single person-to-person transfer that evens out the two salaries:
    // the higher earner sends the other half the gap. Joint income (barnbidrag
    // etc.) is shared 50/50 on top from the pot, so it doesn't change who pays
    // whom — only the final equalShare. transfer + each getting incomeJoint/2
    // lands both people on equalShare.
    var gap = incomeA - incomeB;
    var transfer = {
      amount: Math.abs(gap) / 2,
      from: gap >= 0 ? 'a' : 'b',
      to:   gap >= 0 ? 'b' : 'a'
    };

    // potNet: what flows back to (positive) or stays in (negative) the pot
    // for this person once everyone has taken out the same equal share.
    function person(ownIncome, ownCosts, ownSavings) {
      return {
        ownIncome: ownIncome,
        potNet: equalShare - ownIncome,
        jointCostShare: costsJoint / 2,
        ownCosts: ownCosts,
        jointSavingsShare: savingsJoint / 2,
        ownSavings: ownSavings,
        leftover: equalShare - costsJoint / 2 - ownCosts - savingsJoint / 2 - ownSavings
      };
    }

    return {
      incomeA: incomeA,
      incomeB: incomeB,
      incomeJoint: incomeJoint,
      totalIncome: totalIncome,
      equalShare: equalShare,
      costsJoint: costsJoint,
      costsA: costsA,
      costsB: costsB,
      totalCosts: totalCosts,
      jointCategories: jointCategories,
      savingsJoint: savingsJoint,
      savingsA: savingsA,
      savingsB: savingsB,
      totalSavings: totalSavings,
      personA: person(incomeA, costsA, savingsA),
      personB: person(incomeB, costsB, savingsB),
      transfer: transfer,
      surplus: totalIncome - totalCosts - totalSavings,
      savingsRate: totalIncome > 0 ? totalSavings / totalIncome : 0
    };
  }

  var api = {
    defaultState: defaultState,
    computeBudget: computeBudget
  };

  if (typeof module !== 'undefined') module.exports = api;
  if (typeof document === 'undefined') return;

  window.App = window.App || {};
  window.App.budget = api;

  // ── Browser only from here on ─────────────────────────────────────

  var STORAGE_KEY = 'bostadskalkyl_budget_v1';
  var TEXT_IDS = ['personAName', 'personBName']; // static-check #5 registry

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || s.version !== 1 || !Array.isArray(s.incomes) || !Array.isArray(s.costs) || !Array.isArray(s.savings)) return null;
      if (!Array.isArray(s.people) || s.people.length !== 2) s.people = ['Alan', 'Partner'];
      // Joint savings was removed from the UI — fold any legacy joint savings
      // rows into person A so saved budgets keep their money and still render.
      s.savings.forEach(function (r) { if (r.owner === 'joint') r.owner = 'a'; });
      // Categories are newer than some saved budgets: seed a starter set and
      // drop any uncategorised joint costs into the last category so nothing
      // disappears (the user can then drag them into place).
      if (!Array.isArray(s.categories) || !s.categories.length) s.categories = defaultState().categories;
      if (typeof s.catSeq !== 'number') s.catSeq = 0;
      var valid = {};
      s.categories.forEach(function (c) { valid[c.id] = true; });
      var fallback = s.categories[s.categories.length - 1].id;
      s.costs.forEach(function (r) {
        if (r.owner === 'joint' && !valid[r.category]) r.category = fallback;
      });
      return s;
    } catch (_) { return null; }
  }

  var state = loadState() || defaultState();

  var saveTimer = null;
  var savedFlashTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
      var el = document.getElementById('saveState');
      el.classList.add('show');
      clearTimeout(savedFlashTimer);
      savedFlashTimer = setTimeout(function () { el.classList.remove('show'); }, 1400);
    }, 250);
  }

  function nextId() {
    state.seq = (state.seq || 1000) + 1;
    return 'r' + state.seq;
  }

  // ── Formatting ────────────────────────────────────────────────────

  function fmt(n) { return App.calc.formatWithSpaces(Math.round(n)) + ' kr'; }

  function fmtSigned(n) {
    var r = Math.round(n);
    return (r > 0 ? '+' : r < 0 ? '−' : '±') + App.calc.formatWithSpaces(Math.abs(r)) + ' kr';
  }

  function setMoney(id, n, signed) {
    var el = document.getElementById(id);
    el.textContent = signed ? fmtSigned(n) : fmt(n);
  }

  function setPosNeg(el, n) {
    el.classList.toggle('positive', n > 0);
    el.classList.toggle('negative', n < 0);
  }

  function personName(owner) {
    return owner === 'a' ? (state.people[0] || 'A')
         : owner === 'b' ? (state.people[1] || 'B')
         : 'Together';
  }

  function nameStrong(owner) {
    var s = document.createElement('strong');
    s.textContent = personName(owner);
    return s;
  }

  function moneyStrong(text) {
    var s = document.createElement('strong');
    s.classList.add('pot-transfer-amount');
    s.textContent = text;
    return s;
  }

  // ── Row building & list rendering ─────────────────────────────────

  function buildRow(row, kind) {
    var el = document.createElement('div');
    el.classList.add('b-row');
    el.dataset.id = row.id;
    el.dataset.kind = kind;

    // Joint cost rows are draggable between categories. Only the handle is the
    // drag source (so text selection inside the inputs still works).
    if (kind === 'cost' && row.owner === 'joint') {
      el.classList.add('b-draggable');
      var handle = document.createElement('span');
      handle.classList.add('b-drag-handle');
      handle.setAttribute('draggable', 'true');
      handle.setAttribute('aria-hidden', 'true');
      handle.textContent = '⠿';
      el.appendChild(handle);
    }

    var label = document.createElement('input');
    label.type = 'text';
    label.value = row.label;
    label.placeholder = 'What is it?';
    label.classList.add('b-row-label');
    label.setAttribute('aria-label', 'Name');
    el.appendChild(label);

    var amount = document.createElement('input');
    amount.type = 'text';
    amount.inputMode = 'numeric';
    amount.value = App.calc.formatWithSpaces(row.amount || 0);
    amount.classList.add('b-row-amount');
    amount.setAttribute('aria-label', 'Amount, kr per month');
    el.appendChild(amount);

    var rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = '×';
    rm.classList.add('b-row-remove');
    rm.setAttribute('aria-label', 'Remove row');
    el.appendChild(rm);

    return el;
  }

  // base segment of the list element ids: 'Cost' -> ownCostListA/B (joint costs
  // live in category cards, not a flat list)
  function listBase(kind) { return kind === 'cost' ? 'Cost' : 'Savings'; }

  function listEl(kind, owner) {
    if (kind === 'income') return document.querySelector('.income-list[data-owner="' + owner + '"]');
    var base = listBase(kind);
    return owner === 'joint'
      ? document.getElementById('joint' + base + 'List')
      : document.getElementById('own' + base + 'List' + owner.toUpperCase());
  }

  function renderIncome() {
    ['a', 'b', 'joint'].forEach(function (owner) {
      var list = listEl('income', owner);
      list.replaceChildren();
      state.incomes.forEach(function (row) {
        if (row.owner === owner) list.appendChild(buildRow(row, 'income'));
      });
    });
  }

  // Individual (a/b) cost & savings lists. Joint costs live in category cards.
  function renderOwnerLists(kind) {
    var rows = kind === 'cost' ? state.costs : state.savings;
    ['a', 'b'].forEach(function (owner) { listEl(kind, owner).replaceChildren(); });
    rows.forEach(function (row) {
      if (row.owner === 'a' || row.owner === 'b') listEl(kind, row.owner).appendChild(buildRow(row, kind));
    });
  }

  function nextCatId() {
    state.catSeq = (state.catSeq || 0) + 1;
    return 'c-' + state.catSeq;
  }

  function buildCategoryCard(cat) {
    var card = document.createElement('div');
    card.classList.add('cat-card');
    card.dataset.catId = cat.id;

    var head = document.createElement('div');
    head.classList.add('cat-head');

    var name = document.createElement('input');
    name.type = 'text';
    name.value = cat.name;
    name.placeholder = 'Category name';
    name.classList.add('cat-name');
    name.setAttribute('aria-label', 'Category name');
    head.appendChild(name);

    var sub = document.createElement('span');
    sub.classList.add('cat-sub');
    sub.dataset.catSub = cat.id;
    sub.textContent = '—';
    head.appendChild(sub);

    var rm = document.createElement('button');
    rm.type = 'button';
    rm.classList.add('cat-remove');
    rm.setAttribute('aria-label', 'Remove category');
    rm.textContent = '×';
    head.appendChild(rm);

    card.appendChild(head);

    var list = document.createElement('div');
    list.classList.add('b-list', 'cat-list');
    list.dataset.catId = cat.id;
    state.costs.forEach(function (row) {
      if (row.owner === 'joint' && row.category === cat.id) list.appendChild(buildRow(row, 'cost'));
    });
    card.appendChild(list);

    var add = document.createElement('button');
    add.type = 'button';
    add.classList.add('btn', 'btn-ghost', 'row-add-btn');
    add.dataset.add = 'cost';
    add.dataset.owner = 'joint';
    add.dataset.cat = cat.id;
    add.textContent = '+ Add cost';
    card.appendChild(add);

    return card;
  }

  function renderJointCategories() {
    var container = document.getElementById('jointCategories');
    container.replaceChildren();
    (state.categories || []).forEach(function (cat) {
      container.appendChild(buildCategoryCard(cat));
    });
  }

  function renderAll() {
    document.getElementById('personAName').value = state.people[0];
    document.getElementById('personBName').value = state.people[1];
    renderIncome();
    renderJointCategories();
    renderOwnerLists('cost');
    renderOwnerLists('saving');
    recalc();
  }

  // Every place a name is printed
  function refreshNames() {
    document.querySelectorAll('[data-name-for]').forEach(function (el) {
      var suffix = el.dataset.nameSuffix || '';
      el.textContent = personName(el.dataset.nameFor) + suffix;
    });
  }

  // ── The doughnut chart — where the pot goes ───────────────────────
  // Joint costs are broken out per category (cycling the --cat-* palette),
  // then each person's own costs, savings, and what's left over.

  var costChart = null;
  var CAT_TOKENS = ['--cat-1', '--cat-2', '--cat-3', '--cat-4', '--cat-5', '--cat-6', '--cat-7', '--cat-8'];

  function updateChart(r) {
    if (!window.Chart) return;
    var cs = getComputedStyle(document.documentElement);
    var segs = [];
    (r.jointCategories || []).forEach(function (c, i) {
      segs.push({ label: c.name || 'Category', val: c.amount, token: CAT_TOKENS[i % CAT_TOKENS.length] });
    });
    segs.push({ label: personName('a') + ' costs', val: r.costsA,               token: '--accent-light' });
    segs.push({ label: personName('b') + ' costs', val: r.costsB,               token: '--copper' });
    segs.push({ label: 'Savings',                  val: r.totalSavings,         token: '--warn-light' });
    segs.push({ label: 'Left over',                val: Math.max(0, r.surplus), token: '--ink-faint' });
    var labels = [], data = [], colors = [];
    segs.forEach(function (s) {
      if (s.val > 0) {
        labels.push(s.label);
        data.push(s.val);
        colors.push(cs.getPropertyValue(s.token).trim());
      }
    });
    var paperCard = cs.getPropertyValue('--paper-card').trim();
    var inkMid = cs.getPropertyValue('--ink-mid').trim();

    if (!costChart) {
      costChart = new Chart(document.getElementById('costChart'), {
        type: 'doughnut',
        data: {
          labels: labels,
          datasets: [{ data: data, backgroundColor: colors, borderColor: paperCard, borderWidth: 2, hoverOffset: 6 }]
        },
        options: {
          maintainAspectRatio: false,
          cutout: '62%',
          plugins: {
            legend: {
              position: 'bottom',
              labels: { color: inkMid, boxWidth: 9, boxHeight: 9, padding: 10, font: { family: 'Inter', size: 11 } }
            },
            tooltip: {
              callbacks: {
                label: function (ctx) { return ' ' + fmt(ctx.parsed); }
              }
            }
          }
        }
      });
    } else {
      costChart.data.labels = labels;
      costChart.data.datasets[0].data = data;
      costChart.data.datasets[0].backgroundColor = colors;
      costChart.data.datasets[0].borderColor = paperCard;
      costChart.options.plugins.legend.labels.color = inkMid;
      costChart.update('none');
    }
  }

  // ── Recalculation ─────────────────────────────────────────────────

  function recalc() {
    var r = computeBudget(state);

    // Pot box (section 1)
    setMoney('d-potA', r.incomeA);
    setMoney('d-potB', r.incomeB);
    setMoney('d-potJoint', r.incomeJoint);
    setMoney('d-potTotal', r.totalIncome);
    setMoney('d-equalShare', r.equalShare);

    // Settle-up: one person pays the other to even out their salaries
    var tr = r.transfer;
    var txt = document.getElementById('potTransferText');
    var note = document.getElementById('potTransferNote');
    var transferEl = document.getElementById('potTransfer');
    if (tr.amount < 0.5) {
      transferEl.classList.add('even');
      txt.textContent = 'Incomes are already even — nothing to transfer';
    } else {
      transferEl.classList.remove('even');
      txt.replaceChildren(
        nameStrong(tr.from), document.createTextNode(' pays '),
        nameStrong(tr.to), document.createTextNode(' '),
        moneyStrong(fmt(tr.amount))
      );
    }
    note.textContent = r.incomeJoint > 0
      ? 'Joint income (' + fmt(r.incomeJoint) + ') is then shared 50/50 on top — you each take home ' + fmt(r.equalShare) + '.'
      : '';

    // Income column subtotals
    setMoney('subA', r.incomeA);
    setMoney('subB', r.incomeB);
    setMoney('subJoint', r.incomeJoint);

    // Per-category joint subtotals (cards persist across recalcs)
    (r.jointCategories || []).forEach(function (c) {
      var el = document.querySelector('.cat-sub[data-cat-sub="' + c.id + '"]');
      if (el) el.textContent = fmt(c.amount);
    });

    // Individual cost subtotals + section total
    setMoney('costsASub', r.costsA);
    setMoney('costsBSub', r.costsB);
    setMoney('costsTotal', r.totalCosts);
    setMoney('savingsASub', r.savingsA);
    setMoney('savingsBSub', r.savingsB);
    setMoney('savingsTotal', r.totalSavings);

    // Summary: left over
    var surplusEl = document.getElementById('s-surplus');
    surplusEl.textContent = fmtSigned(r.surplus);
    setPosNeg(surplusEl, r.surplus);
    setMoney('s-income', r.totalIncome);
    setMoney('s-costs', r.totalCosts);
    setMoney('s-savings', r.totalSavings);

    // Flow bar
    var total = r.totalIncome || 1;
    var pcts = {
      fbJoint: r.costsJoint / total,
      fbOwn: (r.costsA + r.costsB) / total,
      fbSav: r.totalSavings / total,
      fbLeft: Math.max(0, r.surplus) / total
    };
    Object.keys(pcts).forEach(function (k) {
      document.getElementById(k).style.width = (Math.max(0, Math.min(1, pcts[k])) * 100).toFixed(1) + '%';
    });
    document.getElementById('fl-joint').textContent = fmt(r.costsJoint);
    document.getElementById('fl-own').textContent = fmt(r.costsA + r.costsB);
    document.getElementById('fl-sav').textContent = fmt(r.totalSavings);
    document.getElementById('fl-left').textContent = fmt(Math.max(0, r.surplus));

    // Summary: the pot
    setMoney('s-equalShare', r.equalShare);
    setMoney('s-potA', r.incomeA);
    setMoney('s-potB', r.incomeB);
    setMoney('s-potJoint', r.incomeJoint);

    // Summary: person cards
    [['A', r.personA], ['B', r.personB]].forEach(function (pair) {
      var p = pair[1], k = pair[0];
      var left = document.getElementById('pcard' + k + 'Left');
      left.textContent = fmtSigned(p.leftover);
      setPosNeg(left, p.leftover);
      setMoney('pcard' + k + 'Share', p.ownIncome + p.potNet); // == equalShare
      document.getElementById('pcard' + k + 'Joint').textContent = '−' + fmt(p.jointCostShare);
      document.getElementById('pcard' + k + 'Own').textContent = '−' + fmt(p.ownCosts);
      document.getElementById('pcard' + k + 'Sav').textContent = '−' + fmt(p.jointSavingsShare + p.ownSavings);
    });

    // Summary: savings rate
    document.getElementById('s-savingsRate').textContent = (r.savingsRate * 100).toFixed(1) + '%';
    setMoney('s-savA', r.savingsA);
    setMoney('s-savB', r.savingsB);

    // Mobile bar
    var mSurplus = document.getElementById('m-surplus');
    mSurplus.textContent = fmtSigned(r.surplus);
    setPosNeg(mSurplus, r.surplus);
    setMoney('m-each', r.equalShare);

    updateChart(r);
  }

  // ── State lookups & mutations ─────────────────────────────────────

  function listFor(kind) {
    return kind === 'income' ? state.incomes : kind === 'cost' ? state.costs : state.savings;
  }

  function findRow(kind, id) {
    var list = listFor(kind);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return { list: list, index: i, row: list[i] };
    }
    return null;
  }

  function addRow(kind, owner, category) {
    var row = { id: nextId(), label: '', amount: 0, owner: owner };
    if (category) row.category = category;
    listFor(kind).push(row);
    return row;
  }

  // ── Categories (mutations + drag-and-drop) ────────────────────────

  function addCategory() {
    state.categories = state.categories || [];
    var cat = { id: nextCatId(), name: '' };
    state.categories.push(cat);
    renderJointCategories();
    recalc();
    save();
    var input = document.querySelector('.cat-card[data-cat-id="' + cat.id + '"] .cat-name');
    if (input) input.focus();
  }

  function removeCategory(catId) {
    var cats = state.categories || [];
    if (cats.length <= 1) { alert('Keep at least one category.'); return; }
    var idx = cats.findIndex(function (c) { return c.id === catId; });
    if (idx < 0) return;
    var fallback = cats[idx === 0 ? 1 : 0];
    var count = state.costs.filter(function (r) { return r.owner === 'joint' && r.category === catId; }).length;
    if (count > 0 && !confirm('Remove "' + (cats[idx].name || 'this category') + '"? Its ' + count + ' row(s) move to "' + (fallback.name || 'another category') + '".')) return;
    state.costs.forEach(function (r) { if (r.owner === 'joint' && r.category === catId) r.category = fallback.id; });
    cats.splice(idx, 1);
    renderJointCategories();
    recalc();
    save();
  }

  var draggedId = null;

  function dragAfterRow(listEl, y) {
    var rows = Array.prototype.slice.call(listEl.querySelectorAll('.b-row:not(.dragging)'));
    var closest = null, closestOffset = Number.NEGATIVE_INFINITY;
    rows.forEach(function (child) {
      var box = child.getBoundingClientRect();
      var offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closestOffset) { closestOffset = offset; closest = child; }
    });
    return closest;
  }

  function clearDragOver() {
    document.querySelectorAll('.cat-card.drag-over').forEach(function (el) { el.classList.remove('drag-over'); });
  }

  function moveRowToCategory(catId, beforeId) {
    var idx = state.costs.findIndex(function (r) { return r.id === draggedId; });
    if (idx < 0) return;
    var moved = state.costs.splice(idx, 1)[0];
    moved.owner = 'joint';
    moved.category = catId;
    if (beforeId && beforeId !== draggedId) {
      var bIdx = state.costs.findIndex(function (r) { return r.id === beforeId; });
      if (bIdx < 0) state.costs.push(moved); else state.costs.splice(bIdx, 0, moved);
    } else {
      state.costs.push(moved);
    }
    renderJointCategories();
    recalc();
    save();
  }

  // ── Events (delegated) ────────────────────────────────────────────

  document.addEventListener('input', function (e) {
    var t = e.target;
    var rowEl = t.closest('.b-row');
    if (rowEl) {
      var found = findRow(rowEl.dataset.kind, rowEl.dataset.id);
      if (!found) return;
      if (t.classList.contains('b-row-label')) found.row.label = t.value;
      if (t.classList.contains('b-row-amount')) found.row.amount = App.calc.parseFormatted(t.value);
      recalc();
      save();
      return;
    }
    if (t.classList.contains('cat-name')) {
      var card = t.closest('.cat-card');
      var cat = (state.categories || []).filter(function (c) { return c.id === card.dataset.catId; })[0];
      if (cat) { cat.name = t.value; recalc(); save(); } // recalc relabels the chart slice
      return;
    }
    if (t.id === 'personAName' || t.id === 'personBName') {
      state.people[t.id === 'personAName' ? 0 : 1] = t.value.trim() || (t.id === 'personAName' ? 'A' : 'B');
      refreshNames();
      recalc(); // the settle-up sentence is built with the live names
      save();
    }
  });

  document.addEventListener('focusout', function (e) {
    var t = e.target;
    if (t.classList && t.classList.contains('b-row-amount')) {
      t.value = App.calc.formatWithSpaces(App.calc.parseFormatted(t.value));
    }
  });

  document.addEventListener('click', function (e) {
    var t = e.target;

    if (t.classList && t.classList.contains('b-row-remove')) {
      var rowEl = t.closest('.b-row');
      var found = findRow(rowEl.dataset.kind, rowEl.dataset.id);
      if (found) found.list.splice(found.index, 1);
      rowEl.remove();
      recalc();
      save();
      return;
    }

    if (t.classList && t.classList.contains('cat-remove')) {
      removeCategory(t.closest('.cat-card').dataset.catId);
      return;
    }

    if (t.id === 'addCategoryBtn') { addCategory(); return; }

    // Add buttons: data-add="income|cost|saving" data-owner="joint|a|b" [data-cat]
    var add = t.closest('[data-add]');
    if (add) {
      var kind = add.dataset.add;
      var owner = add.dataset.owner;
      var cat = add.dataset.cat;
      var row = addRow(kind, owner, cat);
      var el = buildRow(row, kind);
      if (kind === 'cost' && owner === 'joint' && cat) {
        var catList = document.querySelector('.cat-list[data-cat-id="' + cat + '"]');
        if (catList) catList.appendChild(el);
      } else {
        listEl(kind, owner).appendChild(el);
      }
      el.querySelector('.b-row-label').focus();
      recalc();
      save();
    }
  });

  document.getElementById('resetBtn').addEventListener('click', function () {
    if (!confirm('Reset the budget to the example data? Your current rows will be replaced.')) return;
    state = defaultState();
    renderAll();
    refreshNames();
    save();
  });

  // Drag-and-drop joint cost rows between category cards (mouse/trackpad).
  var catsContainer = document.getElementById('jointCategories');
  if (catsContainer) {
    catsContainer.addEventListener('dragstart', function (e) {
      var handle = e.target.closest('.b-drag-handle');
      if (!handle) return;
      var row = handle.closest('.b-row');
      if (!row) return;
      draggedId = row.dataset.id;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', draggedId); } catch (_) {}
      if (e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(row, 12, 12);
    });
    catsContainer.addEventListener('dragend', function (e) {
      var row = e.target.closest('.b-row');
      if (row) row.classList.remove('dragging');
      draggedId = null;
      clearDragOver();
    });
    catsContainer.addEventListener('dragover', function (e) {
      if (!draggedId) return;
      var list = e.target.closest('.cat-list');
      if (!list) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDragOver();
      list.closest('.cat-card').classList.add('drag-over');
    });
    catsContainer.addEventListener('drop', function (e) {
      if (!draggedId) return;
      var list = e.target.closest('.cat-list');
      if (!list) return;
      e.preventDefault();
      var before = dragAfterRow(list, e.clientY);
      moveRowToCategory(list.dataset.catId, before ? before.dataset.id : null);
      clearDragOver();
    });
  }

  // ── Chart: fullscreen overlay ─────────────────────────────────────

  var chartOverlayOpen = false;
  var chartWrap     = document.getElementById('chartWrap');
  var expandBtn     = document.getElementById('chartExpandBtn');
  var overlay       = document.getElementById('chartOverlay');
  var overlayStage  = document.getElementById('chartOverlayStage');
  var overlayClose  = document.getElementById('chartOverlayClose');

  function onChartKey(e) { if (e.key === 'Escape') closeChart(); }

  function openChart() {
    if (!costChart) return;
    overlay.hidden = false;
    chartOverlayOpen = true;
    overlayStage.appendChild(costChart.canvas);
    costChart.resize();
    document.addEventListener('keydown', onChartKey);
    overlayClose.focus();
  }

  function closeChart() {
    if (!chartOverlayOpen) return;
    chartOverlayOpen = false;
    chartWrap.appendChild(costChart.canvas);
    costChart.resize();
    overlay.hidden = true;
    document.removeEventListener('keydown', onChartKey);
    if (expandBtn) expandBtn.focus();
  }

  if (expandBtn)    expandBtn.addEventListener('click', openChart);
  if (overlayClose) overlayClose.addEventListener('click', closeChart);
  if (overlay)      overlay.addEventListener('click', function (e) { if (e.target === overlay) closeChart(); });

  // ── Theme (same storage key as the rest of Hemma) ────────────────

  var THEME_KEY = 'bostadskalkyl_theme';
  var themeBtn = document.getElementById('themeToggleBtn');

  function applyThemeIcon() {
    themeBtn.textContent = document.documentElement.dataset.theme === 'dark' ? '☾' : '☀';
  }

  function syncThemeColor() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
  }

  themeBtn.addEventListener('click', function () {
    var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
    applyThemeIcon();
    syncThemeColor();
    recalc(); // re-reads tokens for the chart colours
  });

  // ── Init ─────────────────────────────────────────────────────────

  applyThemeIcon();
  syncThemeColor();
  renderAll();
  refreshNames();

  // No chart library? Hide the fullscreen button — the summary still works.
  if (!window.Chart && expandBtn) expandBtn.hidden = true;
}());
