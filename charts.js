(function () {
  'use strict';

  window.App = window.App || {};

  const Chart = window.Chart; // FUTURE: replace with ESM import

  // Helpers
  var fmt            = function () { return App.calc.fmt.apply(null, arguments); };
  var formatWithSpaces = function () { return App.calc.formatWithSpaces.apply(null, arguments); };
  var val            = function (id) { return App.dom.val(id); };

  // ── Module state ──────────────────────────────────────────────────
  var amortChartInstance      = null;
  var fullscreenChartInstance = null;
  var lumpSums                = []; // [{year, amount}]
  var lastChartData           = null; // {years, currentData, newData} for the fullscreen rebuild

  // ── Chart colour helper ───────────────────────────────────────────
  function getChartColors() {
    var style = getComputedStyle(document.documentElement);
    var get   = function (v) { return style.getPropertyValue(v).trim(); };
    return {
      grid:          get('--rule'),
      tick:          get('--ink-soft'),
      tooltipBg:     get('--paper-card'),
      tooltipBorder: get('--rule'),
      tooltipTitle:  get('--ink'),
      tooltipBody:   get('--ink-mid'),
      legend:        get('--ink-mid'),
      accent:        get('--accent'),
      warnLight:     get('--warn-light'),
    };
  }

  function hexToRgba(hex, alpha) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var n = parseInt(hex, 16);
    if (isNaN(n)) return 'rgba(0,0,0,' + alpha + ')';
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  // Scriptable background: vertical gradient fading the accent into the page
  function accentGradient(hex, topAlpha) {
    return function (context) {
      var area = context.chart.chartArea;
      if (!area) return hexToRgba(hex, 0.05);
      var g = context.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
      g.addColorStop(0, hexToRgba(hex, topAlpha));
      g.addColorStop(1, hexToRgba(hex, 0));
      return g;
    };
  }

  // Shared dataset/options builders — used by both the modal chart and the
  // fullscreen chart so gradients and theme colours never go stale
  function buildDatasets(cc, currentData, newData) {
    return [
      {
        label: 'Current mortgage',
        data: currentData,
        borderColor: cc.warnLight,
        backgroundColor: accentGradient(cc.warnLight, 0.10),
        borderWidth: 2,
        borderDash: [6, 4],
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHitRadius: 12,
        tension: 0.3,
        fill: true,
      },
      {
        label: 'New mortgage',
        data: newData,
        borderColor: cc.accent,
        backgroundColor: accentGradient(cc.accent, 0.22),
        borderWidth: 2.5,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHitRadius: 12,
        pointHoverBackgroundColor: cc.accent,
        tension: 0.3,
        fill: true,
      }
    ];
  }

  function buildOptions(cc) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      animation: { duration: 650, easing: 'easeOutQuart' },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            font: { family: 'Inter', size: 12 },
            color: cc.legend,
            boxWidth: 14,
            padding: 16,
            usePointStyle: true,
            pointStyle: 'line',
          }
        },
        tooltip: {
          backgroundColor: cc.tooltipBg,
          borderColor: cc.tooltipBorder,
          borderWidth: 1,
          titleColor: cc.tooltipTitle,
          bodyColor: cc.tooltipBody,
          titleFont: { family: 'Inter', size: 12, weight: '500' },
          bodyFont: { family: 'Inter', size: 12 },
          padding: 10,
          cornerRadius: 10,
          boxPadding: 4,
          callbacks: {
            title: function (items) { return 'Year ' + items[0].label; },
            label: function (item) {
              var v = item.raw;
              if (v === null || v === undefined) return null;
              return ' ' + item.dataset.label + ': ' + Math.round(v).toLocaleString('sv-SE') + ' kr';
            }
          }
        }
      },
      scales: {
        x: {
          title: { display: true, text: 'Years from now', font: { family: 'Inter', size: 12 }, color: cc.tick },
          grid: { color: cc.grid, lineWidth: 0.5 },
          ticks: { font: { family: 'Inter', size: 11 }, color: cc.tick, maxTicksLimit: 15 }
        },
        y: {
          title: { display: true, text: 'Remaining balance (kr)', font: { family: 'Inter', size: 12 }, color: cc.tick },
          grid: { color: cc.grid, lineWidth: 0.5 },
          ticks: {
            font: { family: 'Inter', size: 11 },
            color: cc.tick,
            callback: function (v) { return (v / 1000000).toFixed(1) + ' Mkr'; }
          }
        }
      }
    };
  }

  // ── Amort chart ───────────────────────────────────────────────────
  function renderAmortChart() {
    var currentBalance  = val('currentMortgage');
    var currentAmort    = val('currentAmortRate');
    var currentTerm     = val('currentTerm');
    var newBalance      = val('newPrice') - val('deposit');
    var newAmortRate    = val('amortRate');

    if (newAmortRate <= 0 || currentAmort <= 0) return;

    // Build schedules
    var currentSchedule = App.calc.buildAmortSchedule(currentBalance, currentAmort, [], currentTerm);
    var newSchedule     = App.calc.buildAmortSchedule(newBalance, newAmortRate, lumpSums);

    // X axis: union of all years up to max
    var maxYear = Math.max(
      currentSchedule[currentSchedule.length - 1].year,
      newSchedule[newSchedule.length - 1].year
    );
    var years = Array.from({ length: maxYear + 1 }, function (_, i) { return i; });

    function getBalance(schedule, year) {
      var pt = schedule.find(function (p) { return p.year === year; });
      if (pt) return pt.balance;
      return schedule[schedule.length - 1].year < year ? 0 : null;
    }

    var currentData = years.map(function (y) { return getBalance(currentSchedule, y); });
    var newData     = years.map(function (y) { return getBalance(newSchedule, y); });

    var currentPayoffPt = currentSchedule.find(function (p) { return p.balance === 0; });
    var currentPayoff   = currentPayoffPt
      ? currentPayoffPt.year
      : (currentTerm > 0 ? currentTerm : null);
    var newPayoffPt = newSchedule.find(function (p) { return p.balance === 0; });
    var newPayoff   = newPayoffPt ? newPayoffPt.year : undefined;

    // Meta stats
    document.getElementById('amortMeta').innerHTML =
      '<div class="amort-meta-row">' +
        '<div class="amort-stat"><span class="amort-stat-label">Current balance</span><span class="amort-stat-val">' + fmt(currentBalance) + '</span></div>' +
        '<div class="amort-stat"><span class="amort-stat-label">Amort rate</span><span class="amort-stat-val">' + currentAmort + '%</span></div>' +
        '<div class="amort-stat"><span class="amort-stat-label">Payoff</span><span class="amort-stat-val">' + (currentPayoff != null ? currentPayoff + ' yrs' : '—') + '</span></div>' +
      '</div>' +
      '<div class="amort-meta-row">' +
        '<div class="amort-stat"><span class="amort-stat-label">New balance</span><span class="amort-stat-val">' + fmt(newBalance) + '</span></div>' +
        '<div class="amort-stat"><span class="amort-stat-label">Amort rate</span><span class="amort-stat-val">' + newAmortRate + '%</span></div>' +
        '<div class="amort-stat"><span class="amort-stat-label">Payoff</span><span class="amort-stat-val">' + (newPayoff != null ? newPayoff + ' yrs' : '—') + '</span></div>' +
      '</div>';

    var ctx = document.getElementById('amortChart').getContext('2d');
    if (amortChartInstance) amortChartInstance.destroy();

    var cc = getChartColors();
    lastChartData = { years: years, currentData: currentData, newData: newData };

    amortChartInstance = new Chart(ctx, {
      type: 'line',
      data: { labels: years, datasets: buildDatasets(cc, currentData, newData) },
      options: buildOptions(cc)
    });
  }

  // ── Lump sums ─────────────────────────────────────────────────────
  function addLumpSum() {
    lumpSums.push({ year: 5, amount: 100000 });
    renderLumpSums();
    renderAmortChart();
  }

  function removeLumpSum(i) {
    lumpSums.splice(i, 1);
    renderLumpSums();
    renderAmortChart();
  }

  function renderLumpSums() {
    var list = document.getElementById('lumpSumList');
    list.innerHTML = '';
    lumpSums.forEach(function (ls, i) {
      var row = document.createElement('div');
      row.className = 'lump-row';

      // Year field
      var yearField = document.createElement('div');
      yearField.className = 'field';
      var yearLabel = document.createElement('label');
      yearLabel.textContent = 'Year';
      var yearWrap = document.createElement('div');
      yearWrap.className = 'input-wrap';
      var yearInput = document.createElement('input');
      yearInput.type = 'number';
      yearInput.min = '1';
      yearInput.max = '100';
      yearInput.step = '1';
      yearInput.value = ls.year;
      yearInput.addEventListener('change', function () {
        lumpSums[i].year = Math.max(1, parseInt(this.value) || 1);
        renderAmortChart();
      });
      yearWrap.appendChild(yearInput);
      yearField.appendChild(yearLabel);
      yearField.appendChild(yearWrap);

      // Amount field
      var amtField = document.createElement('div');
      amtField.className = 'field';
      var amtLabel = document.createElement('label');
      amtLabel.textContent = 'Amount';
      var amtWrap = document.createElement('div');
      amtWrap.className = 'input-wrap has-suffix';
      var amtInput = document.createElement('input');
      amtInput.type = 'text';
      amtInput.inputMode = 'numeric';
      amtInput.value = App.calc.formatWithSpaces(ls.amount);
      amtInput.addEventListener('focus', function () {
        this.value = App.calc.parseFormatted(this.value) || '';
      });
      amtInput.addEventListener('blur', function () {
        this.value = App.calc.formatWithSpaces(App.calc.parseFormatted(this.value) || 0);
        lumpSums[i].amount = App.calc.parseFormatted(this.value);
        renderAmortChart();
      });
      amtInput.addEventListener('input', function () {
        lumpSums[i].amount = App.calc.parseFormatted(this.value);
        renderAmortChart();
      });
      var amtSuffix = document.createElement('span');
      amtSuffix.className = 'suffix';
      amtSuffix.textContent = 'kr';
      amtWrap.appendChild(amtInput);
      amtWrap.appendChild(amtSuffix);
      amtField.appendChild(amtLabel);
      amtField.appendChild(amtWrap);

      // Remove button
      var removeBtn = document.createElement('button');
      removeBtn.className = 'lump-remove';
      removeBtn.title = 'Remove';
      removeBtn.textContent = '\xd7';
      removeBtn.addEventListener('click', function () {
        removeLumpSum(i);
      });

      row.appendChild(yearField);
      row.appendChild(amtField);
      row.appendChild(removeBtn);
      list.appendChild(row);
    });
  }

  function calcTargetLumpSum() {
    var newBalance   = val('newPrice') - val('deposit');
    var newAmortRate = val('amortRate');
    var targetYear   = parseInt(document.getElementById('targetPayoffYear').value) || 0;
    var paymentYear  = 1;
    var resultEl     = document.getElementById('targetResult');
    var lumpField    = document.getElementById('targetLumpResult');

    lumpField.value = '';
    resultEl.className = 'amort-target-result';
    resultEl.innerHTML = '';

    if (!targetYear || targetYear <= 0) {
      resultEl.className = 'amort-target-result no-solution';
      resultEl.innerHTML = 'Enter a target payoff year.';
      return;
    }

    function testSchedule(candidate) {
      return App.calc.buildAmortSchedule(
        newBalance, newAmortRate, [{ year: paymentYear, amount: candidate }]
      );
    }

    // Check if no lump sum already achieves it
    var noLumpSchedule = App.calc.buildAmortSchedule(newBalance, newAmortRate, []);
    var noLumpPayoffPt = noLumpSchedule.find(function (p) { return p.balance === 0; });
    var noLumpPayoff   = noLumpPayoffPt ? noLumpPayoffPt.year : undefined;
    if (noLumpPayoff && noLumpPayoff <= targetYear) {
      lumpField.value = '0';
      resultEl.className = 'amort-target-result has-result';
      resultEl.innerHTML = 'Already paid off by year ' + noLumpPayoff + ' — no lump sum needed.';
      return;
    }

    // Check if even full balance pays off in time
    var fullPayoff     = testSchedule(newBalance);
    var fullPayoffPt   = fullPayoff.find(function (p) { return p.balance === 0; });
    var fullPayoffYear = fullPayoffPt ? fullPayoffPt.year : undefined;
    if (!fullPayoffYear || fullPayoffYear > targetYear) {
      resultEl.className = 'amort-target-result no-solution';
      resultEl.innerHTML = 'Not achievable — try a later target year or earlier payment year.';
      return;
    }

    // Binary search
    var lo = 0, hi = newBalance, mid, found = null;
    for (var iter = 0; iter < 60; iter++) {
      mid = (lo + hi) / 2;
      var sched  = testSchedule(mid);
      var payoffPt = sched.find(function (p) { return p.balance === 0; });
      var payoff = payoffPt ? payoffPt.year : undefined;
      if (payoff && payoff <= targetYear) { found = mid; hi = mid; }
      else lo = mid;
    }

    if (found === null) {
      resultEl.className = 'amort-target-result no-solution';
      resultEl.innerHTML = 'Could not find a solution. Try a later target year.';
      return;
    }

    var lumpAmount = Math.ceil(found / 1000) * 1000;
    var annualExtra = Math.round(lumpAmount / targetYear);
    lumpField.value = formatWithSpaces(lumpAmount);
    resultEl.className = 'amort-target-result has-result';
    resultEl.innerHTML = 'Pay in year 1 → mortgage-free by year ' + targetYear +
      '. That’s an extra ' + fmt(annualExtra) + ' / year spread over the term.';
  }

  // ── Fullscreen chart ──────────────────────────────────────────────
  function openFullscreenChart() {
    if (!lastChartData) return;
    var backdrop = document.getElementById('chartFullscreen');
    backdrop.classList.add('open');

    var ctx = document.getElementById('amortChartFull').getContext('2d');
    if (fullscreenChartInstance) fullscreenChartInstance.destroy();

    // Rebuild from raw data with fresh theme-aware colours — a JSON clone of
    // the modal chart would drop the scriptable gradient functions
    var cc = getChartColors();
    fullscreenChartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: lastChartData.years,
        datasets: buildDatasets(cc, lastChartData.currentData, lastChartData.newData)
      },
      options: buildOptions(cc)
    });
  }

  function closeFullscreenChart() {
    var backdrop = document.getElementById('chartFullscreen');
    backdrop.classList.remove('open');
    setTimeout(function () {
      if (fullscreenChartInstance) { fullscreenChartInstance.destroy(); fullscreenChartInstance = null; }
    }, 250);
  }

  document.getElementById('chartFullscreen').addEventListener('click', function (e) {
    if (e.target === this) closeFullscreenChart();
  });

  // ── Static button event wiring ────────────────────────────────────
  document.getElementById('amortChartWrap').addEventListener('click', openFullscreenChart);
  document.getElementById('addLumpSumBtn').addEventListener('click', addLumpSum);
  document.getElementById('calcTargetBtn').addEventListener('click', calcTargetLumpSum);
  document.getElementById('fullscreenCloseBtn').addEventListener('click', closeFullscreenChart);

  // ── Export ────────────────────────────────────────────────────────
  window.App.charts = {
    lumpSums:                lumpSums,
    getChartColors:          getChartColors,
    renderAmortChart:        renderAmortChart,
    addLumpSum:              addLumpSum,
    removeLumpSum:           removeLumpSum,
    renderLumpSums:          renderLumpSums,
    calcTargetLumpSum:       calcTargetLumpSum,
    openFullscreenChart:     openFullscreenChart,
    closeFullscreenChart:    closeFullscreenChart,
  };
}());
