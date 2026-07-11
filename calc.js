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

  // Cap for småhus, income year 2025
  var FASTIGHETSAVGIFT_CAP = 9725;

  function fastighetsavgiftCap(propertyTax) {
    return Math.min(propertyTax, FASTIGHETSAVGIFT_CAP);
  }

  // Derived key figures from a raw inputs object (scenario previews,
  // future comparison views) — single source for the preview math
  function summarize(d) {
    d = d || {};
    var loanAmount  = (d.newPrice || 0) - (d.deposit || 0);
    var monthly     = (loanAmount * ((d.interestRateA || 0) / 100)) / 12
                    + (loanAmount * ((d.amortRate || 0) / 100)) / 12
                    + ((d.propertyTax || 0) / 12)
                    + (d.driftkostnad || 0);
    var takeaway    = (d.salePrice || 0) - (d.currentMortgage || 0);
    var netProceeds = takeaway - (d.agentCost || 0) - (d.movingCost || 0);
    var lagfartAmt  = lagfart(d.newPrice || 0);
    var pantbrev    = pantbrevCost(loanAmount, d.existingPantbrev || 0);
    var totalUpfront = (d.deposit || 0) + lagfartAmt + pantbrev;
    return {
      loanAmount:   loanAmount,
      monthly:      monthly,
      takeaway:     takeaway,
      netProceeds:  netProceeds,
      totalUpfront: totalUpfront,
      cashBalance:  netProceeds - totalUpfront,
    };
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
    FASTIGHETSAVGIFT_CAP: FASTIGHETSAVGIFT_CAP,
    summarize: summarize,
    equityPct: equityPct,
    buildAmortSchedule: buildAmortSchedule,
  };

  // Guarded CJS export for node --test (calc.test.js)
  if (typeof module !== 'undefined') module.exports = window.App.calc;
}());
