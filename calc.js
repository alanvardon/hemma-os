(function () {
  'use strict';

  window.App = window.App || {};

  // ── Formatters ────────────────────────────────────────────────────
  function fmt(n) {
    return Math.round(n).toLocaleString('sv-SE') + ' kr';
  }

  function pct(n) {
    return n.toFixed(1) + '%';
  }

  function formatWithSpaces(n) {
    return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  function parseFormatted(str) {
    return parseFloat(String(str).replace(/\s/g, '').replace(/,/g, '.')) || 0;
  }

  // ── Pure calculation functions ───────────────────────────────────
  function lagfart(price) {
    return price * 0.015;
  }

  function pantbrevCost(loan, existingPantbrev) {
    return Math.max(0, loan - existingPantbrev) * 0.02;
  }

  function ranteavdrag(annualInterest) {
    var threshold = 100000;
    if (annualInterest <= threshold) return annualInterest * 0.30;
    return threshold * 0.30 + (annualInterest - threshold) * 0.21;
  }

  function fastighetsavgiftCap(propertyTax) {
    return Math.min(propertyTax, 9287);
  }

  function equityPct(loanAmount, price) {
    if (price === 0) return 0;
    return (loanAmount / price) * 100;
  }

  function buildAmortSchedule(startBalance, annualAmortRate, lumpPayments, termCap) {
    var yearlyAmort = startBalance * (annualAmortRate / 100);
    var balance = startBalance;
    var points = [{ year: 0, balance: balance }];
    var year = 0;
    var limit = termCap || 200;
    while (balance > 0 && year < limit) {
      year++;
      var lump = lumpPayments
        .filter(function (p) { return p.year === year; })
        .reduce(function (s, p) { return s + p.amount; }, 0);
      balance = Math.max(0, balance - yearlyAmort - lump);
      points.push({ year: year, balance: balance });
      if (balance === 0) break;
    }
    return points;
  }

  // ── Export ───────────────────────────────────────────────────────
  window.App.calc = {
    fmt: fmt,
    pct: pct,
    formatWithSpaces: formatWithSpaces,
    parseFormatted: parseFormatted,
    lagfart: lagfart,
    pantbrevCost: pantbrevCost,
    ranteavdrag: ranteavdrag,
    fastighetsavgiftCap: fastighetsavgiftCap,
    equityPct: equityPct,
    buildAmortSchedule: buildAmortSchedule,
  };

  // Guarded CJS export for node --test (calc.test.js)
  if (typeof module !== 'undefined') module.exports = window.App.calc;
}());
