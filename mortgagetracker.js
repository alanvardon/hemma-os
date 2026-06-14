/* mortgagetracker.js — Bolånekoll: the mortgage tracker.

   You download a CSV of mortgage transactions from the bank every so often and
   today paste it into a Google Sheet to watch how much of the home you own
   versus how much the bank still owns. This tool replaces that: import the CSV,
   track each loan part (lånedel), enter the property's value over time, and see
   the equity split between both owners — at a glance and over the months.

   The bank export is a LEDGER: one row per entry, with a type column
   (Specifikation: "Betalning", "Ränta", "Amortering", "Lån"…), a single signed
   amount (Belopp) and a running balance (Saldo). An interest-only month shows a
   Ränta charge and an equal Betalning that cancel out, so the principal is flat;
   an amortising month shows the Saldo step down. We therefore trust the Saldo
   column as the source of truth for the outstanding balance when it's present,
   and fall back to start-balance-minus-amortisation when it isn't.

   This file is the PURE core — CSV parsing, column auto-mapping, row
   classification and the balance/equity math. No DOM dependency; shared 1:1
   between the browser (window.App.mortgage) and the node tests (module.exports).
   The page controller is below the document guard; persistence is in
   mortgagetracker-store.js. Owners are keys 'a' and 'b' with editable names. */
(function () {
  'use strict';

  function _round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  // ── Settings ────────────────────────────────────────────────────────────
  function defaultSettings() {
    return {
      property_name: '',
      owner_a_name: 'Alex',
      owner_b_name: 'Sam',
      my_ownership_pct: 50,
      i_am: 'a',
      currency: 'SEK',
      ranteavdrag: true,
      household_income_yearly: null,
      import_presets: {},
      track_contributions: false
    };
  }
  function otherOwner(p) { return p === 'a' ? 'b' : 'a'; }

  // ── CSV parsing (shared, identical to Månadsavslut's battle-tested layer) ──
  function detectDelimiter(text) {
    var firstLine = String(text || '').split(/\r?\n/)[0] || '';
    var candidates = [',', ';', '\t'];
    var best = ',', bestCount = -1;
    candidates.forEach(function (d) {
      var count = firstLine.split(d).length - 1;
      if (count > bestCount) { bestCount = count; best = d; }
    });
    return best;
  }

  function parseCsv(text, opts) {
    opts = opts || {};
    if (text == null) return { delimiter: ',', headers: [], rows: [] };
    var s = String(text);
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // strip BOM
    var delim = opts.delimiter || detectDelimiter(s);

    var all = [];
    var field = '';
    var row = [];
    var inQuotes = false;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (inQuotes) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else { field += c; }
        continue;
      }
      if (c === '"') { inQuotes = true; }
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\r') { /* swallow; the \n closes the row */ }
      else if (c === '\n') { row.push(field); all.push(row); field = ''; row = []; }
      else { field += c; }
    }
    row.push(field);
    all.push(row);
    all = all.filter(function (r) { return !(r.length === 1 && r[0].trim() === ''); });

    return { delimiter: delim, headers: all.length ? all[0] : [], rows: all.slice(1) };
  }

  // Parse a money string into a number, robust to locale (space/dot thousands,
  // comma OR dot decimals, currency suffixes, accounting parens, unicode minus).
  function parseAmount(raw) {
    if (raw == null) return NaN;
    var s = String(raw).trim();
    if (!s) return NaN;
    var neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/−/g, '-');
    if (s.indexOf('-') !== -1) neg = true;
    s = s.replace(/[^0-9.,]/g, '');
    if (!s) return NaN;
    var lastComma = s.lastIndexOf(',');
    var lastDot = s.lastIndexOf('.');
    var decSep = lastComma > lastDot ? ',' : (lastDot > -1 ? '.' : '');
    if (decSep) {
      var thouSep = decSep === ',' ? '.' : ',';
      s = s.split(thouSep).join('').replace(decSep, '.');
    }
    var n = parseFloat(s);
    if (isNaN(n)) return NaN;
    return neg ? -n : n;
  }

  // Majority sign of the non-zero amounts. Exported as part of the shared CSV
  // toolkit; the importer normalises with abs() since amounts are magnitudes.
  function inferSpendSign(amounts) {
    var pos = 0, neg = 0;
    (amounts || []).forEach(function (n) {
      n = Number(n);
      if (!isFinite(n) || n === 0) return;
      if (n > 0) pos++; else neg++;
    });
    return neg > pos ? -1 : 1;
  }

  // ── Column auto-mapping ─────────────────────────────────────────────────
  // The ledger export has a date, a TYPE column (Specifikation), a single signed
  // amount (Belopp) and a running balance (Saldo). Returns the matched column
  // INDEX for each (or null), pre-filling the dropdowns; everything is overridable.
  function autoMapColumns(headers) {
    var H = (headers || []).map(function (h) { return String(h == null ? '' : h).toLowerCase().trim(); });
    function find(re, avoid) {
      for (var i = 0; i < H.length; i++) {
        if (re.test(H[i]) && !(avoid && avoid.test(H[i]))) return i;
      }
      return null;
    }
    return {
      date: find(/(date|datum|bokf|transaktionsdat|betald|betalningsdag)/),
      specification: find(/(specifikation|transaktionstyp|\btyp\b|type|kind|slag|text|beskriv|händelse|handelse)/),
      amount: find(/(belopp|amount|summa|transaktionsbelopp|debet|kredit)/, /(saldo|balance)/),
      balance: find(/(saldo|kvar|restskuld|aktuell skuld|balance|återstå|aterstå)/),
      loan_number: find(/(lånenummer|lanenummer|lånenr|lanenr|kontonummer|account)/)
    };
  }

  // Classify a ledger row by its type/Specifikation text. Order matters:
  // amortisation ("avbetalning") is checked before the looser "betalning".
  function classifyKind(text) {
    var s = String(text == null ? '' : text).toLowerCase();
    if (/ränta|ranta|interest/.test(s)) return 'interest';
    if (/amorter|amort|principal|avbetal/.test(s)) return 'amortization';
    if (/betalning|payment|inbet|överför|overfor|insättning|insattning/.test(s)) return 'payment';
    if (/\blån\b|\blan\b|utbetalning|disburs|loan|uttag|nyutl/.test(s)) return 'loan';
    if (/avgift|fee|aviavgift/.test(s)) return 'fee';
    return 'other';
  }

  // ── Row builders ────────────────────────────────────────────────────────
  function makeLoanPart(partial) {
    partial = partial || {};
    var rate = partial.interest_rate;
    var rt = partial.rate_type === 'bunden' ? 'bunden' : 'rörlig';
    return {
      label: partial.label || '',
      loan_number: partial.loan_number || '',
      start_balance: _round2(Number(partial.start_balance) || 0),
      start_date: partial.start_date || '',
      interest_rate: (rate == null || rate === '') ? null : Number(rate),
      rate_type: rt,
      // Only a bound (bunden) rate carries an expiry — the villkorsändringsdag.
      rate_binding_until: (rt === 'bunden' && partial.rate_binding_until) ? String(partial.rate_binding_until) : null,
      archived: !!partial.archived
    };
  }

  // Normalise a ledger entry. `kind` classifies the row; `amount` and
  // `balance_after` are stored as positive magnitudes (the bank exports debt as
  // a negative Saldo — we keep the outstanding debt as a positive number).
  function makePayment(partial) {
    partial = partial || {};
    var kind = partial.kind || classifyKind(partial.description || partial.specification || '');
    var amount = _round2(Math.abs(Number(partial.amount) || 0));
    var bal = partial.balance_after;
    return {
      loan_part_id: partial.loan_part_id || null,
      date: partial.date || '',
      kind: kind,
      description: partial.description || '',
      amount: amount,
      balance_after: (bal == null || bal === '') ? null : _round2(Math.abs(Number(bal) || 0)),
      // Who paid this row. Amortering attributed to a single owner builds that
      // owner's contribution share; 'joint' (the default) splits by ownership %.
      paid_by: normPaidBy(partial.paid_by),
      source: partial.source || 'manual'
    };
  }
  function normPaidBy(v) { return v === 'a' ? 'a' : (v === 'b' ? 'b' : 'joint'); }

  // ── Duplicate spotting on re-import ───────────────────────────────────────
  function paymentFingerprint(p) {
    p = p || {};
    var date = String(p.date == null ? '' : p.date).trim();
    var part = p.loan_part_id || '';
    var kind = p.kind || '';
    var amount = Math.round((Number(p.amount) || 0) * 100) / 100;
    return date + '|' + part + '|' + kind + '|' + amount;
  }
  function flagDuplicates(existing, candidates) {
    var counts = {};
    (existing || []).forEach(function (p) {
      if (!p) return;
      var k = paymentFingerprint(p);
      counts[k] = (counts[k] || 0) + 1;
    });
    return (candidates || []).map(function (c) {
      if (!c) return false;
      var k = paymentFingerprint(c);
      if (counts[k] > 0) { counts[k]--; return true; }
      return false;
    });
  }

  // ── Assigning imported rows to a loan part ────────────────────────────────
  function _normNum(s) { return String(s == null ? '' : s).toLowerCase().replace(/[\s-]/g, ''); }
  function assignPaymentsToPart(loanNumbers, parts, opts) {
    opts = opts || {};
    var fallback = opts.selectedPartId || null;
    var auto = !!opts.auto;
    var byNumber = {};
    (parts || []).forEach(function (p) {
      if (p && p.loan_number != null && String(p.loan_number).trim() !== '') {
        byNumber[_normNum(p.loan_number)] = p.id;
      }
    });
    return (loanNumbers || []).map(function (raw) {
      if (auto && raw != null && String(raw).trim() !== '') {
        var hit = byNumber[_normNum(raw)];
        if (hit) return { loan_part_id: hit, matched: true };
      }
      return { loan_part_id: fallback, matched: false };
    });
  }

  // ── Mortgage math ─────────────────────────────────────────────────────────
  // A part's outstanding balance. When the ledger carries a Saldo (balance_after)
  // we trust it — taking the latest date's SETTLED (post-payment, i.e. smallest)
  // balance, so an interest-charge row doesn't inflate the figure. Without any
  // Saldo we fall back to start balance minus booked amortisation.
  function partBalance(part, payments) {
    if (!part) return 0;
    var entries = (payments || []).filter(function (p) { return p && p.loan_part_id === part.id; });
    var withBal = entries.filter(function (p) { return p.balance_after != null; });
    if (withBal.length) {
      var latestDate = withBal.reduce(function (mx, p) { var d = String(p.date || ''); return d > mx ? d : mx; }, '');
      var sameDate = withBal.filter(function (p) { return String(p.date || '') === latestDate; });
      var bal = sameDate.reduce(function (mn, p) { var b = Number(p.balance_after) || 0; return (mn == null || b < mn) ? b : mn; }, null);
      return Math.max(0, _round2(bal));
    }
    var start = Number(part.start_balance) || 0;
    var startDate = String(part.start_date || '');
    var amort = 0;
    entries.forEach(function (p) {
      if (p.kind !== 'amortization') return;
      if (startDate && p.date && String(p.date) < startDate) return;
      amort += Number(p.amount) || 0;
    });
    return Math.max(0, _round2(start - amort));
  }

  // The part's original principal: the user's start balance if set, else the
  // "Lån" disbursement amount, else the earliest settled balance seen.
  function partOriginal(part, payments) {
    if (part && Number(part.start_balance) > 0) return _round2(Number(part.start_balance));
    var entries = (payments || []).filter(function (p) { return p && p.loan_part_id === (part && part.id); });
    var loans = entries.filter(function (p) { return p.kind === 'loan'; });
    if (loans.length) return _round2(Math.max.apply(null, loans.map(function (p) { return Number(p.amount) || 0; })));
    var withBal = entries.filter(function (p) { return p.balance_after != null; });
    if (withBal.length) {
      var earliest = withBal.reduce(function (mn, p) { var d = String(p.date || ''); return (mn == null || d < mn) ? d : mn; }, null);
      var same = withBal.filter(function (p) { return String(p.date || '') === earliest; });
      return _round2(Math.max.apply(null, same.map(function (p) { return Number(p.balance_after) || 0; })));
    }
    return partBalance(part, payments);
  }
  function partAmortized(part, payments) { return Math.max(0, _round2(partOriginal(part, payments) - partBalance(part, payments))); }

  function totalBalance(parts, payments) {
    return _round2((parts || []).reduce(function (s, p) {
      return (!p || p.archived) ? s : s + partBalance(p, payments);
    }, 0));
  }
  function totalAmortized(parts, payments) {
    return _round2((parts || []).reduce(function (s, p) {
      return (!p || p.archived) ? s : s + partAmortized(p, payments);
    }, 0));
  }
  // Interest paid = sum of the interest-kind ("Ränta") rows.
  function totalInterest(payments, opts) {
    opts = opts || {};
    var sum = 0;
    (payments || []).forEach(function (p) {
      if (!p || p.kind !== 'interest') return;
      if (opts.loan_part_id && p.loan_part_id !== opts.loan_part_id) return;
      if (opts.from && p.date && String(p.date) < opts.from) return;
      if (opts.to && p.date && String(p.date) > opts.to) return;
      sum += Number(p.amount) || 0;
    });
    return _round2(sum);
  }

  // Swedish ränteavdrag: 30% of interest up to 100 000 kr, 21% on the part above.
  function ranteavdrag(annualInterest) {
    var n = Number(annualInterest) || 0;
    if (n <= 0) return 0;
    var lower = Math.min(n, 100000);
    var upper = Math.max(0, n - 100000);
    return _round2(lower * 0.30 + upper * 0.21);
  }

  function latestValuation(valuations, asOf) {
    var best = null;
    (valuations || []).forEach(function (v) {
      if (!v) return;
      var d = String(v.date || '');
      if (!d) return;
      if (asOf && d > asOf) return;
      if (!best || d > String(best.date || '')) best = v;
    });
    return best;
  }
  function propertyValue(valuations, asOf) {
    var v = latestValuation(valuations, asOf);
    return v ? (Number(v.value) || 0) : 0;
  }

  function equity(value, balance) { return _round2((Number(value) || 0) - (Number(balance) || 0)); }
  function loanToValue(balance, value) {
    var v = Number(value) || 0;
    if (v <= 0) return 0;
    return _round2((Number(balance) || 0) / v * 100);
  }
  function _clampPct(pct, dflt) {
    var p = Number(pct);
    if (!isFinite(p)) p = dflt;
    return Math.max(0, Math.min(100, p));
  }
  function myShareEquity(equityVal, pct) {
    return _round2((Number(equityVal) || 0) * _clampPct(pct, 0) / 100);
  }
  // Split equity between the two owners by the stored ownership %. Returns { a, b }.
  function ownerSplit(equityVal, settings) {
    settings = settings || {};
    var me = settings.i_am === 'b' ? 'b' : 'a';
    var myPct = _clampPct(settings.my_ownership_pct, 50);
    var mine = _round2((Number(equityVal) || 0) * myPct / 100);
    var res = {};
    res[me] = mine;
    res[otherOwner(me)] = _round2((Number(equityVal) || 0) - mine);
    return res;
  }
  // Each owner's ownership percentage, as { a, b }.
  function ownerPercents(settings) {
    settings = settings || {};
    var me = settings.i_am === 'b' ? 'b' : 'a';
    var myPct = _clampPct(settings.my_ownership_pct, 50);
    var res = {};
    res[me] = myPct;
    res[otherOwner(me)] = _round2(100 - myPct);
    return res;
  }

  // ── Month helpers (for the timeline) ──────────────────────────────────────
  function monthKey(dateStr) {
    var s = String(dateStr == null ? '' : dateStr).trim();
    var m = /(\d{4})[-/](\d{2})/.exec(s);
    if (m) return m[1] + '-' + m[2];
    m = /(\d{2})[./](\d{2})[./](\d{4})/.exec(s);
    if (m) return m[3] + '-' + m[2];
    return '';
  }
  function monthLabel(mk) {
    if (!mk) return 'Utan datum · No date';
    var m = /^(\d{4})-(\d{2})$/.exec(mk);
    if (!m) return mk;
    try {
      var s = new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString('sv-SE', { month: 'long', year: 'numeric' });
      return s.charAt(0).toUpperCase() + s.slice(1);
    } catch (_) { return mk; }
  }
  function _enumerateMonths(startMk, endMk) {
    var out = [];
    var y = Number(startMk.slice(0, 4)), mo = Number(startMk.slice(5, 7));
    var endY = Number(endMk.slice(0, 4)), endMo = Number(endMk.slice(5, 7));
    var guard = 0;
    while ((y < endY || (y === endY && mo <= endMo)) && guard < 1200) {
      out.push(y + '-' + (mo < 10 ? '0' : '') + mo);
      mo++; if (mo > 12) { mo = 1; y++; }
      guard++;
    }
    return out;
  }
  function _monthRange(parts, payments) {
    var keys = [];
    (parts || []).forEach(function (p) { var k = monthKey(p && p.start_date); if (k) keys.push(k); });
    (payments || []).forEach(function (p) { var k = monthKey(p && p.date); if (k) keys.push(k); });
    if (!keys.length) return [];
    keys.sort();
    return _enumerateMonths(keys[0], keys[keys.length - 1]);
  }
  // A part's settled balance as of month `mk`: the latest Saldo on/before mk
  // (carried forward), else start-minus-amortisation. Mirrors partBalance.
  function _partBalanceAsOf(part, payments, mk) {
    var entries = (payments || []).filter(function (p) { return p && p.loan_part_id === part.id; });
    var withBal = entries.filter(function (p) {
      var pmk = monthKey(p.date);
      return p.balance_after != null && pmk && pmk <= mk;
    });
    if (withBal.length) {
      var latestMonth = withBal.reduce(function (mx, p) { var k = monthKey(p.date); return k > mx ? k : mx; }, '');
      var inMonth = withBal.filter(function (p) { return monthKey(p.date) === latestMonth; });
      var latestDate = inMonth.reduce(function (mx, p) { var d = String(p.date || ''); return d > mx ? d : mx; }, '');
      var sameDate = inMonth.filter(function (p) { return String(p.date || '') === latestDate; });
      var bal = sameDate.reduce(function (mn, p) { var b = Number(p.balance_after) || 0; return (mn == null || b < mn) ? b : mn; }, null);
      return Math.max(0, _round2(bal));
    }
    var start = Number(part.start_balance) || 0;
    var startDate = String(part.start_date || '');
    var amort = 0;
    entries.forEach(function (p) {
      if (p.kind !== 'amortization') return;
      var pmk = monthKey(p.date);
      if (!pmk || pmk > mk) return;
      if (startDate && p.date && String(p.date) < startDate) return;
      amort += Number(p.amount) || 0;
    });
    return Math.max(0, _round2(start - amort));
  }
  function balanceTimeline(parts, payments) {
    var active = (parts || []).filter(function (p) { return p && !p.archived; });
    if (!active.length) return [];
    return _monthRange(active, payments).map(function (mk) {
      var bal = 0;
      active.forEach(function (part) { bal += _partBalanceAsOf(part, payments, mk); });
      return { month: mk, label: monthLabel(mk), balance: _round2(bal) };
    });
  }
  function equityTimeline(parts, payments, valuations, settings) {
    settings = settings || {};
    var myPct = _clampPct(settings.my_ownership_pct, 50);
    var me = settings.i_am === 'b' ? 'b' : 'a';
    return balanceTimeline(parts, payments).map(function (row) {
      var asOf = row.month + '-31';
      var value = propertyValue(valuations, asOf);
      var eq = _round2(value - row.balance);
      var mine = _round2(eq * myPct / 100);
      var partner = _round2(eq - mine);
      return {
        month: row.month, label: row.label, value: value, balance: row.balance, bank: row.balance,
        equity: eq, my_equity: mine,
        a_equity: me === 'a' ? mine : partner,
        b_equity: me === 'a' ? partner : mine,
        partner_equity: partner
      };
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // Roadmap features — equity bridge, projection, cost, bound rates, rate
  // history, amorteringskrav, import presets, CSV export, reconciliation and
  // contribution-based ownership. All pure; each is unit-tested.
  // ════════════════════════════════════════════════════════════════════════

  // ── Date helpers (browser uses new Date(); tests pass explicit dates) ──────
  function _todayISO() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function _daysBetween(fromISO, toISO) {
    var a = new Date(String(fromISO) + 'T00:00:00');
    var b = new Date(String(toISO) + 'T00:00:00');
    if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  }

  // ── A part's balance as of a date (mirrors partBalance, date-bounded) ──────
  // Used by the equity bridge and the blended-rate / projection helpers, where
  // we need the outstanding debt at a point in time, not just today's.
  function partBalanceAsOf(part, payments, asOf) {
    if (!part) return 0;
    var entries = (payments || []).filter(function (p) {
      if (!p || p.loan_part_id !== part.id) return false;
      if (asOf && p.date && String(p.date) > asOf) return false;
      return true;
    });
    var withBal = entries.filter(function (p) { return p.balance_after != null && p.date; });
    if (withBal.length) {
      var latestDate = withBal.reduce(function (mx, p) { var d = String(p.date || ''); return d > mx ? d : mx; }, '');
      var sameDate = withBal.filter(function (p) { return String(p.date || '') === latestDate; });
      var bal = sameDate.reduce(function (mn, p) { var b = Number(p.balance_after) || 0; return (mn == null || b < mn) ? b : mn; }, null);
      return Math.max(0, _round2(bal));
    }
    var start = Number(part.start_balance) || 0;
    var startDate = String(part.start_date || '');
    var amort = 0;
    entries.forEach(function (p) {
      if (p.kind !== 'amortization') return;
      if (startDate && p.date && String(p.date) < startDate) return;
      amort += Number(p.amount) || 0;
    });
    return Math.max(0, _round2(start - amort));
  }
  function totalBalanceAsOf(parts, payments, asOf) {
    return _round2((parts || []).reduce(function (s, p) {
      return (!p || p.archived) ? s : s + partBalanceAsOf(p, payments, asOf);
    }, 0));
  }

  // #1 — Equity bridge. Decomposes the change in equity over a window into the
  // part you paid down (amortisation) and the part the market gave you
  // (appreciation). The two reconcile exactly to Δequity:
  //   Δequity = (value_to − value_from) + (balance_from − balance_to).
  function equityBridge(parts, payments, valuations, fromDate, toDate) {
    var balFrom = totalBalanceAsOf(parts, payments, fromDate);
    var balTo = totalBalanceAsOf(parts, payments, toDate);
    var valFrom = propertyValue(valuations, fromDate);
    var valTo = propertyValue(valuations, toDate);
    var startEq = _round2(valFrom - balFrom);
    var endEq = _round2(valTo - balTo);
    return {
      from: fromDate || '', to: toDate || '',
      start_value: _round2(valFrom), end_value: _round2(valTo),
      start_balance: balFrom, end_balance: balTo,
      start_equity: startEq, end_equity: endEq,
      amortization_gain: _round2(balFrom - balTo),
      appreciation_gain: _round2(valTo - valFrom),
      total_gain: _round2(endEq - startEq)
    };
  }

  // #2 — Projection. The average monthly principal reduction observed so far,
  // read off the balance timeline. Interest-only loans return 0 (flat).
  function monthlyAmortizationRate(parts, payments) {
    var tl = balanceTimeline(parts, payments);
    if (tl.length < 2) return 0;
    var drop = tl[0].balance - tl[tl.length - 1].balance;
    var months = tl.length - 1;
    if (drop <= 0 || months <= 0) return 0;
    return _round2(drop / months);
  }
  // Project the outstanding balance forward at a chosen monthly amortisation
  // (observed baseline + any extra). `flat` means the balance never moves —
  // the honest verdict for an interest-only loan with no extra payment.
  function projectBalance(parts, payments, opts) {
    opts = opts || {};
    var balance = opts.startBalance != null ? Number(opts.startBalance) : totalBalance(parts, payments);
    var base = opts.monthlyAmortization != null ? Number(opts.monthlyAmortization) : monthlyAmortizationRate(parts, payments);
    var perMonth = _round2((Number(base) || 0) + (Number(opts.extraMonthly) || 0));
    var horizon = opts.maxMonths || 1200;
    if (perMonth <= 0) return { flat: true, per_month: perMonth, months: null, start_balance: _round2(balance), schedule: [] };
    var schedule = [];
    var b = balance, months = 0;
    while (b > 0 && months < horizon) {
      b = _round2(b - perMonth);
      months++;
      if (b < 0) b = 0;
      schedule.push({ month_index: months, balance: b });
    }
    // months is the payoff month only if the balance actually reached zero;
    // hitting the horizon with debt left means "not within the horizon".
    return { flat: false, per_month: perMonth, months: b <= 0 ? months : null, start_balance: _round2(balance), schedule: schedule };
  }
  // Months until 70% / 50% LTV and full payoff, at the chosen amortisation.
  // Property value is held flat (future appreciation is unknown).
  function projectMilestones(parts, payments, valuations, settings, opts) {
    opts = opts || {};
    var value = propertyValue(valuations);
    var proj = projectBalance(parts, payments, opts);
    var startBal = proj.start_balance;
    function monthsToLtv(target) {
      if (value <= 0) return null;
      var targetBal = value * target / 100;
      if (startBal <= targetBal) return 0;
      if (proj.flat) return null;
      for (var i = 0; i < proj.schedule.length; i++) {
        if (proj.schedule[i].balance <= targetBal) return proj.schedule[i].month_index;
      }
      return null;
    }
    return {
      flat: proj.flat, per_month: proj.per_month,
      payoff_months: proj.flat ? null : proj.months,
      ltv70_months: monthsToLtv(70),
      ltv50_months: monthsToLtv(50),
      current_ltv: loanToValue(startBal, value)
    };
  }

  // #3 — Real monthly cost: what actually leaves the account each month
  // (interest + amortering), and the same net of the estimated ränteavdrag.
  function monthlyCost(payments, opts) {
    opts = opts || {};
    var useDeduction = opts.ranteavdrag !== false;
    var byMonth = {};
    (payments || []).forEach(function (p) {
      if (!p) return;
      var mk = monthKey(p.date);
      if (!mk) return;
      if (!byMonth[mk]) byMonth[mk] = { interest: 0, amortization: 0 };
      if (p.kind === 'interest') byMonth[mk].interest += Number(p.amount) || 0;
      else if (p.kind === 'amortization') byMonth[mk].amortization += Number(p.amount) || 0;
    });
    return Object.keys(byMonth).sort().map(function (mk) {
      var r = byMonth[mk];
      var gross = _round2(r.interest + r.amortization);
      // A single month's interest is well under the 100k threshold, so the
      // estimate is the 30% band — computed via ranteavdrag for consistency.
      var deduction = useDeduction ? ranteavdrag(r.interest) : 0;
      return {
        month: mk, label: monthLabel(mk),
        interest: _round2(r.interest), amortization: _round2(r.amortization),
        gross: gross, deduction: deduction, net: _round2(gross - deduction)
      };
    });
  }

  // #4 — Fixed-rate (bunden) expiry. Days until the villkorsändringsdag.
  function bindingStatus(part, asOf) {
    var res = { bound: false, until: null, days_left: null, expired: false };
    if (!part || part.rate_type !== 'bunden' || !part.rate_binding_until) return res;
    res.bound = true;
    res.until = String(part.rate_binding_until);
    var days = _daysBetween(asOf || _todayISO(), res.until);
    res.days_left = days;
    res.expired = days != null && days < 0;
    return res;
  }

  // #5 — Rate history. A part's effective rate on a date is the latest rate
  // change on/before it, falling back to the part's own interest_rate.
  function effectiveRate(part, rateChanges, asOf) {
    var pid = part && part.id;
    var changes = (rateChanges || []).filter(function (c) {
      return c && c.loan_part_id === pid && c.rate != null && (!asOf || !c.date || String(c.date) <= asOf);
    });
    if (changes.length) {
      changes = changes.slice().sort(function (a, b) { return String(a.date || '').localeCompare(String(b.date || '')); });
      return Number(changes[changes.length - 1].rate);
    }
    return part && part.interest_rate != null ? Number(part.interest_rate) : null;
  }
  // Blended rate across active parts, weighted by each part's balance.
  function weightedAvgRate(parts, rateChanges, payments, asOf) {
    var num = 0, den = 0;
    (parts || []).forEach(function (p) {
      if (!p || p.archived) return;
      var bal = asOf ? partBalanceAsOf(p, payments, asOf) : partBalance(p, payments);
      var rate = effectiveRate(p, rateChanges, asOf);
      if (rate == null || bal <= 0) return;
      num += rate * bal; den += bal;
    });
    return den > 0 ? _round2(num / den) : 0;
  }

  // #6 — Amorteringskrav. Sweden's required amortisation as a % of the loan per
  // year: >70% LTV → 2%, 50–70% → 1%, plus 1% if debt exceeds 4.5× gross income.
  function amorteringskrav(ltv, debtToIncome) {
    var l = Number(ltv) || 0;
    var required = 0;
    if (l > 70) required = 2;
    else if (l > 50) required = 1;
    if (Number(debtToIncome) > 4.5) required += 1;
    return required;
  }
  function amorteringskravStatus(parts, payments, valuations, settings) {
    settings = settings || {};
    var balance = totalBalance(parts, payments);
    var value = propertyValue(valuations);
    var ltv = loanToValue(balance, value);
    var income = Number(settings.household_income_yearly) || 0;
    var dti = income > 0 ? _round2(balance / income) : 0;
    var requiredPct = amorteringskrav(ltv, income > 0 ? dti : 0);
    var requiredAnnual = _round2(balance * requiredPct / 100);
    var actualAnnual = _round2(monthlyAmortizationRate(parts, payments) * 12);
    return {
      ltv: ltv, dti: dti, required_pct: requiredPct,
      required_annual: requiredAnnual, actual_annual: actualAnnual,
      meets: actualAnnual + 0.5 >= requiredAnnual,
      exempt: requiredPct === 0,
      has_income: income > 0, has_value: value > 0
    };
  }

  // #7 — Import presets. A header signature keys a remembered column mapping so
  // a recurring bank export re-maps itself. Mappings are stored by header NAME
  // (order-independent) and resolved back to indices against a given header row.
  function headerSignature(headers) {
    return (headers || []).map(function (h) { return String(h == null ? '' : h).toLowerCase().trim(); })
      .filter(Boolean).sort().join('|');
  }
  function mappingToNames(headers, mapping) {
    mapping = mapping || {};
    function nm(i) { return (i == null || headers[i] == null) ? null : String(headers[i]); }
    return { date: nm(mapping.date), specification: nm(mapping.specification), amount: nm(mapping.amount), balance: nm(mapping.balance), loan_number: nm(mapping.loan_number) };
  }
  function applyPreset(headers, names) {
    names = names || {};
    var lower = (headers || []).map(function (h) { return String(h == null ? '' : h).toLowerCase().trim(); });
    function idx(name) { if (name == null) return null; var i = lower.indexOf(String(name).toLowerCase().trim()); return i < 0 ? null : i; }
    return { date: idx(names.date), specification: idx(names.specification), amount: idx(names.amount), balance: idx(names.balance), loan_number: idx(names.loan_number) };
  }

  // #8 — CSV export. Semicolon-delimited, the Swedish-locale default that the
  // importer round-trips, so it re-opens cleanly in Excel/Sheets.
  function _csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function paymentsToCsv(payments, parts) {
    var nameById = {};
    (parts || []).forEach(function (p) { if (p) nameById[p.id] = p.label || ''; });
    var rows = [['Date', 'Loan part', 'Type', 'Amount', 'Balance after', 'Paid by', 'Source']];
    (payments || []).forEach(function (p) {
      if (!p) return;
      rows.push([
        p.date || '', nameById[p.loan_part_id] || p.loan_part_id || '', p.kind || '',
        (p.amount != null ? p.amount : ''), (p.balance_after != null ? p.balance_after : ''),
        p.paid_by || 'joint', p.source || ''
      ]);
    });
    return rows.map(function (r) { return r.map(_csvCell).join(';'); }).join('\n');
  }

  // #9 — Reconciliation. The Saldo is trusted for the CURRENT balance, so the
  // meaningful cross-check is the manual start balance against where the imported
  // ledger actually begins (the earliest settled Saldo on/after start_date). A
  // drift means a partial import or a start balance that needs updating — NOT a
  // loan that simply amortises via Saldo steps (which is the normal case and must
  // stay silent). Only evaluated when a start balance is set.
  function _settledAtEdge(rows, newest) {
    if (!rows.length) return null;
    var edge = rows.reduce(function (acc, x) {
      var d = String(x.date || '');
      if (acc == null) return d;
      return newest ? (d > acc ? d : acc) : (d < acc ? d : acc);
    }, null);
    var same = rows.filter(function (x) { return String(x.date || '') === edge; });
    return same.reduce(function (mn, x) { var b = Number(x.balance_after) || 0; return (mn == null || b < mn) ? b : mn; }, null);
  }
  function reconcileBalance(parts, payments) {
    return (parts || []).filter(function (p) { return p && !p.archived; }).map(function (p) {
      var entries = (payments || []).filter(function (x) { return x && x.loan_part_id === p.id; });
      var withBal = entries.filter(function (x) { return x.balance_after != null && x.date; });
      var startDate = String(p.start_date || '');
      var scoped = startDate ? withBal.filter(function (x) { return String(x.date || '') >= startDate; }) : withBal;
      if (!scoped.length) scoped = withBal;
      var current = withBal.length ? _round2(_settledAtEdge(withBal, true)) : null;
      var startSaldo = scoped.length ? _round2(_settledAtEdge(scoped, false)) : null;
      var hasStart = Number(p.start_balance) > 0;
      var drift = (hasStart && startSaldo != null) ? _round2(Number(p.start_balance) - startSaldo) : null;
      return {
        loan_part_id: p.id, label: p.label || '',
        current: current,
        start_balance: hasStart ? _round2(Number(p.start_balance)) : null,
        start_saldo: startSaldo, drift: drift
      };
    });
  }

  // #10 — Contribution-based ownership. Amortering (and lump-sum contributions)
  // attributed to one owner build that owner's share; 'joint' rows split by the
  // ownership %. Interest is a cost, not equity, so it never counts here.
  function contributionSplit(payments, contributions, settings) {
    settings = settings || {};
    var totals = { a: 0, b: 0, joint: 0 };
    (contributions || []).forEach(function (c) {
      if (!c) return;
      totals[normPaidBy(c.owner)] += Number(c.amount) || 0;
    });
    (payments || []).forEach(function (p) {
      if (!p || p.kind !== 'amortization') return;
      totals[normPaidBy(p.paid_by)] += Number(p.amount) || 0;
    });
    var pct = ownerPercents(settings);
    var aShareJoint = _round2(totals.joint * (pct.a || 50) / 100);
    var aTotal = _round2(totals.a + aShareJoint);
    var bTotal = _round2(totals.b + (totals.joint - aShareJoint));
    var sum = _round2(aTotal + bTotal);
    return {
      a: aTotal, b: bTotal, joint: _round2(totals.joint), total: sum,
      a_pct: sum > 0 ? _round2(aTotal / sum * 100) : (pct.a || 50),
      b_pct: sum > 0 ? _round2(bTotal / sum * 100) : (pct.b || 50)
    };
  }
  // Who owes whom to bring contributions back to the target ownership split.
  function settlement(payments, contributions, settings) {
    settings = settings || {};
    var split = contributionSplit(payments, contributions, settings);
    var pct = ownerPercents(settings);
    var targetA = _round2(split.total * (pct.a || 50) / 100);
    var aOver = _round2(split.a - targetA);
    return {
      a_contributed: split.a, b_contributed: split.b, total: split.total,
      target_a: targetA, a_over: aOver,
      owes: aOver > 0.005 ? 'b' : (aOver < -0.005 ? 'a' : null),
      amount: _round2(Math.abs(aOver))
    };
  }

  var api = {
    defaultSettings: defaultSettings,
    otherOwner: otherOwner,
    detectDelimiter: detectDelimiter,
    parseCsv: parseCsv,
    parseAmount: parseAmount,
    inferSpendSign: inferSpendSign,
    autoMapColumns: autoMapColumns,
    classifyKind: classifyKind,
    makeLoanPart: makeLoanPart,
    makePayment: makePayment,
    normPaidBy: normPaidBy,
    paymentFingerprint: paymentFingerprint,
    flagDuplicates: flagDuplicates,
    assignPaymentsToPart: assignPaymentsToPart,
    partBalance: partBalance,
    partBalanceAsOf: partBalanceAsOf,
    totalBalanceAsOf: totalBalanceAsOf,
    partOriginal: partOriginal,
    partAmortized: partAmortized,
    totalBalance: totalBalance,
    totalAmortized: totalAmortized,
    totalInterest: totalInterest,
    ranteavdrag: ranteavdrag,
    latestValuation: latestValuation,
    propertyValue: propertyValue,
    equity: equity,
    loanToValue: loanToValue,
    myShareEquity: myShareEquity,
    ownerSplit: ownerSplit,
    ownerPercents: ownerPercents,
    monthKey: monthKey,
    monthLabel: monthLabel,
    balanceTimeline: balanceTimeline,
    equityTimeline: equityTimeline,
    equityBridge: equityBridge,
    monthlyAmortizationRate: monthlyAmortizationRate,
    projectBalance: projectBalance,
    projectMilestones: projectMilestones,
    monthlyCost: monthlyCost,
    bindingStatus: bindingStatus,
    effectiveRate: effectiveRate,
    weightedAvgRate: weightedAvgRate,
    amorteringskrav: amorteringskrav,
    amorteringskravStatus: amorteringskravStatus,
    headerSignature: headerSignature,
    mappingToNames: mappingToNames,
    applyPreset: applyPreset,
    paymentsToCsv: paymentsToCsv,
    reconcileBalance: reconcileBalance,
    contributionSplit: contributionSplit,
    settlement: settlement
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') { window.App = window.App || {}; window.App.mortgage = api; }

  // ════════════════════════════════════════════════════════════════════════
  // DOM controller — everything below runs only in the browser.
  // ════════════════════════════════════════════════════════════════════════
  if (typeof document === 'undefined') return;

  var store = window.App.mortgageStore;

  // ── tiny helpers ─────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clean(v) { return String(v == null ? '' : v).trim(); }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  var CURRENCY_SUFFIX = { SEK: 'kr', NOK: 'kr', DKK: 'kr', EUR: '€', USD: '$', GBP: '£' };
  // Exact balances (and percentages) show two decimals.
  function formatMoney(n) {
    var suffix = CURRENCY_SUFFIX[settings && settings.currency] || 'kr';
    return (Number(n) || 0).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + suffix;
  }
  // Whole kronor — for summary/estimate figures (interest paid, ränteavdrag,
  // monthly cost) where the öre is just noise.
  function formatMoney0(n) {
    var suffix = CURRENCY_SUFFIX[settings && settings.currency] || 'kr';
    return Math.round(Number(n) || 0).toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' ' + suffix;
  }
  function formatPct(n) {
    return (Number(n) || 0).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' %';
  }
  function todayISO() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  // The start date for an equity-bridge window. 'all' returns null — the caller
  // substitutes the earliest known date in the data.
  function periodFrom(period) {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    if (period === 'ytd') return d.getFullYear() + '-01-01';
    if (period === '12m') { d.setFullYear(d.getFullYear() - 1); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
    return null;
  }
  // A month count from today, rendered as a Swedish "Mar 2031"-style label.
  function monthsToWhen(months) {
    if (months == null) return '—';
    if (months <= 0) return 'nu · now';
    var d = new Date();
    d.setMonth(d.getMonth() + months);
    var s = d.toLocaleDateString('sv-SE', { month: 'short', year: 'numeric' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  var KIND_LABELS = { interest: 'Ränta', amortization: 'Amortering', payment: 'Betalning', loan: 'Lån', fee: 'Avgift', other: 'Övrigt' };
  function kindLabel(k) { return KIND_LABELS[k] || k || '—'; }

  var toastEl = $('toast');
  var toastTimer = null;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.hidden = false;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
  }
  var saveStateEl = $('saveState');
  function flashSaved() {
    if (!saveStateEl) return;
    saveStateEl.classList.add('show');
    setTimeout(function () { saveStateEl.classList.remove('show'); }, 1400);
  }

  // ── state ────────────────────────────────────────────────────────────────
  var settings = defaultSettings();
  var parsed = null;
  var triage = [];
  var fileName = '';
  var importParts = [];
  var importExisting = [];
  var currentPaymentFilter = 'all';
  var importQueue = [];   // selected files, processed one at a time
  var queueIndex = 0;
  var bridgePeriod = 'ytd';   // equity-bridge window: 'ytd' | '12m' | 'all'

  function nameOf(p) { return p === 'b' ? settings.owner_b_name : settings.owner_a_name; }

  // ── segmented control helpers ─────────────────────────────────────────────
  function segVal(b) {
    return b.getAttribute('data-person') || b.getAttribute('data-class') || b.getAttribute('data-filter')
      || b.getAttribute('data-rt') || b.getAttribute('data-period');
  }
  function setSeg(container, val) {
    Array.prototype.forEach.call(container.querySelectorAll('.seg'), function (b) {
      var on = segVal(b) === val;
      b.classList.toggle('is-active', on);
      if (b.hasAttribute('aria-checked')) b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
  function segValue(container) { var b = container.querySelector('.seg.is-active'); return b ? segVal(b) : null; }
  function wireSeg(container, onChange) {
    container.addEventListener('click', function (e) {
      var b = e.target.closest('.seg');
      if (!b || !container.contains(b)) return;
      var v = segVal(b);
      setSeg(container, v);
      if (onChange) onChange(v);
    });
  }

  // ── element refs: import ──────────────────────────────────────────────────
  var dropzone = $('dropzone'), fileInput = $('fileInput');
  var importGuard = $('importGuard'), importConfig = $('importConfig');
  var elDate = $('mapDate'), elType = $('mapType'), elAmount = $('mapAmount'), elBalance = $('mapBalance'), elLoanNo = $('mapLoanNo');
  var mapSelects = [elDate, elType, elAmount, elBalance, elLoanNo];
  var importPartSel = $('importPart');
  var triageBody = $('triageBody'), triageSummary = $('triageSummary');
  var confirmBtn = $('confirmImport');

  function readFileAsText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Could not read that file.')); };
      reader.onload = function () {
        var buf = reader.result, text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
        catch (_) {
          try { text = new TextDecoder('windows-1252').decode(buf); }
          catch (__) { text = new TextDecoder('utf-8').decode(buf); }
        }
        resolve(text);
      };
      reader.readAsArrayBuffer(file);
    });
  }

  // Take a list of dropped/browsed files and walk them one at a time. Each file
  // keeps its own column mapping and loan-part assignment; dedup carries across
  // the batch because every file re-reads the store (incl. rows just imported).
  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(Boolean);
    if (!files.length) return;
    importQueue = files;
    queueIndex = 0;
    loadQueueFile();
  }
  function loadQueueFile() {
    if (queueIndex < importQueue.length) handleFile(importQueue[queueIndex]);
  }
  function advanceQueue() {
    queueIndex++;
    if (queueIndex < importQueue.length) loadQueueFile();
    else finishQueue();
  }
  function finishQueue() {
    importQueue = [];
    queueIndex = 0;
    resetWizard();
  }
  function updateQueueInfo() {
    var multi = importQueue.length > 1;
    var q = $('queueInfo');
    if (q) { q.hidden = !multi; if (multi) q.textContent = 'File ' + (queueIndex + 1) + ' of ' + importQueue.length; }
    var skip = $('skipFileBtn');
    if (skip) skip.hidden = !multi;
  }

  function handleFile(file) {
    if (!file) return;
    Promise.all([store.listLoanParts(), store.listPayments()]).then(function (res) {
      importParts = res[0];
      importExisting = res[1];
      if (!importParts.length) { toast('Add a loan part first, then import.'); return; }
      readFileAsText(file).then(function (text) {
        var p = parseCsv(text);
        if (!p.headers.length || !p.rows.length) {
          toast('“' + (file.name || 'file') + '” has no rows to import.');
          if (importQueue.length > 1) advanceQueue();
          return;
        }
        parsed = p;
        fileName = file.name || 'statement.csv';
        triage = p.rows.map(function () { return { classification: 'include' }; });

        populateSelects();
        var auto = autoMapColumns(p.headers);
        // A remembered mapping for this exact header set wins over the heuristic.
        var presets = settings.import_presets || {};
        var preset = presets[headerSignature(p.headers)];
        var mapped = preset ? applyPreset(p.headers, preset) : auto;
        setSelect(elDate, mapped.date);
        setSelect(elType, mapped.specification);
        setSelect(elAmount, mapped.amount);
        setSelect(elBalance, mapped.balance);
        setSelect(elLoanNo, mapped.loan_number);
        rebuildImportPartSelect();
        if (preset) toast('Reused your saved column mapping for this file.');

        $('fileName').textContent = fileName;
        $('fileMeta').textContent = p.rows.length + ' rows · “' + (p.delimiter === '\t' ? 'tab' : p.delimiter) + '” delimited';
        if (dropzone) dropzone.hidden = true;
        if (importGuard) importGuard.hidden = true;
        importConfig.hidden = false;
        updateQueueInfo();

        computeTriageMeta();
        triage.forEach(function (t) { t.classification = t.duplicate ? 'skip' : 'include'; });
        renderTriage();
      }).catch(function (e) { toast(e.message || 'Could not read that file.'); });
    });
  }

  // ── column-mapping selects ────────────────────────────────────────────────
  function populateSelects() {
    var opts = '<option value="">— none —</option>' + parsed.headers.map(function (h, i) {
      return '<option value="' + i + '">' + escapeHtml(h || ('Column ' + (i + 1))) + '</option>';
    }).join('');
    mapSelects.forEach(function (sel) { sel.innerHTML = opts; });
  }
  function setSelect(sel, idx) { sel.value = idx == null ? '' : String(idx); }
  function selectedMapping() {
    function v(sel) { return sel.value === '' ? null : parseInt(sel.value, 10); }
    return { date: v(elDate), specification: v(elType), amount: v(elAmount), balance: v(elBalance), loan_number: v(elLoanNo) };
  }
  function cellAt(row, idx) { return idx == null ? '' : (row[idx] == null ? '' : row[idx]); }

  function rebuildImportPartSelect() {
    var map = selectedMapping();
    var hasLoanNo = map.loan_number != null;
    var prev = importPartSel.value;
    var opts = '';
    if (hasLoanNo) opts += '<option value="__auto__">Auto-detect from loan #</option>';
    opts += importParts.map(function (p) {
      return '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.label || '(loan part)') + '</option>';
    }).join('');
    importPartSel.innerHTML = opts;
    var keep = prev && Array.prototype.some.call(importPartSel.options, function (o) { return o.value === prev; });
    importPartSel.value = keep ? prev : (importPartSel.options[0] ? importPartSel.options[0].value : '');
  }

  // ── triage ────────────────────────────────────────────────────────────────
  function resolveAssignments() {
    var map = selectedMapping();
    var auto = importPartSel.value === '__auto__' && map.loan_number != null;
    var fallback = auto ? (importParts[0] && importParts[0].id) || null : importPartSel.value;
    var loanNumbers = parsed.rows.map(function (r) { return map.loan_number == null ? null : cellAt(r, map.loan_number); });
    return assignPaymentsToPart(loanNumbers, importParts, { selectedPartId: fallback, auto: auto });
  }
  function autoMode() { return importPartSel.value === '__auto__'; }
  function partLabelById(id) {
    for (var i = 0; i < importParts.length; i++) { if (importParts[i].id === id) return importParts[i].label || '(loan part)'; }
    return '';
  }

  function computeTriageMeta() {
    var map = selectedMapping();
    var assigns = resolveAssignments();
    var candidates = parsed.rows.map(function (r, i) {
      var t = triage[i];
      var specText = clean(cellAt(r, map.specification));
      var amt = map.amount == null ? NaN : parseAmount(r[map.amount]);
      var bal = map.balance == null ? NaN : parseAmount(r[map.balance]);
      t.specText = specText;
      t.kind = classifyKind(specText);
      t.amount = isFinite(amt) ? round2(Math.abs(amt)) : 0;
      t.balance_after = isFinite(bal) ? round2(Math.abs(bal)) : null;
      t.hasAmount = t.amount > 0 || t.balance_after != null;
      t.loan_part_id = assigns[i] ? assigns[i].loan_part_id : null;
      t.partMatched = assigns[i] ? assigns[i].matched : false;
      if (!t.hasAmount) return null;
      return { date: clean(cellAt(r, map.date)), loan_part_id: t.loan_part_id, kind: t.kind, amount: t.amount };
    });
    flagDuplicates(importExisting, candidates).forEach(function (f, i) { triage[i].duplicate = !!f; });
  }

  function seg(c, label, active) {
    return '<button type="button" class="seg' + (c === active ? ' is-active' : '') + '" data-class="' + c + '">' + label + '</button>';
  }
  function renderTriage() {
    var map = selectedMapping();
    var html = '';
    parsed.rows.forEach(function (row, i) {
      var t = triage[i];
      var treat, rowClass = '';
      if (t.hasAmount) {
        var cls = t.classification === 'skip' ? 'skip' : 'include';
        treat = '<div class="segmented segmented-sm" data-index="' + i + '">' + seg('include', 'Include', cls) + seg('skip', 'Skip', cls) + '</div>';
        if (t.duplicate) rowClass = ' is-dup';
        else if (cls === 'skip') rowClass = ' is-excluded';
      } else {
        treat = '<span class="treat-na">no amount</span>';
        rowClass = ' is-excluded';
      }
      var badges = '';
      if (t.duplicate) badges += ' <span class="row-flag">possible duplicate</span>';
      if (autoMode() && t.hasAmount) badges += ' <span class="row-flag' + (t.partMatched ? ' row-flag-refund' : '') + '">'
        + (t.partMatched ? '→ ' + escapeHtml(partLabelById(t.loan_part_id)) : 'no loan # → ' + escapeHtml(partLabelById(t.loan_part_id))) + '</span>';
      html += '<tr' + (rowClass ? ' class="' + rowClass.trim() + '"' : '') + '>'
        + '<td class="col-treat">' + treat + '</td>'
        + '<td class="col-date">' + escapeHtml(cellAt(row, map.date)) + '</td>'
        + '<td>' + escapeHtml(t.specText || kindLabel(t.kind)) + badges + '</td>'
        + '<td class="num">' + (t.hasAmount && t.amount ? formatMoney(t.amount) : '—') + '</td>'
        + '<td class="num">' + (t.balance_after != null ? formatMoney(t.balance_after) : '—') + '</td>'
        + '</tr>';
    });
    triageBody.innerHTML = html;
    updateSummary();
  }
  function updateSummary() {
    var add = 0, skip = 0, invalid = 0, dup = 0, interest = 0;
    triage.forEach(function (t) {
      if (!t.hasAmount) { invalid++; return; }
      if (t.classification === 'skip') { skip++; return; }
      add++;
      if (t.kind === 'interest') interest++;
      if (t.duplicate) dup++;
    });
    var parts = [add + ' row' + (add === 1 ? '' : 's') + ' to add'];
    if (interest) parts.push(interest + ' ränta');
    if (dup) parts.push(dup + ' possible duplicate' + (dup === 1 ? '' : 's'));
    if (skip) parts.push(skip + ' skipped');
    if (invalid) parts.push(invalid + ' without an amount');
    triageSummary.textContent = parts.join(' · ');
    confirmBtn.textContent = add ? ('Add ' + add + ' row' + (add === 1 ? '' : 's')) : 'Nothing to add';
    confirmBtn.disabled = add === 0;
  }

  function confirmImport() {
    var map = selectedMapping();
    var drafts = [];
    parsed.rows.forEach(function (row, i) {
      var t = triage[i];
      if (!t.hasAmount || t.classification === 'skip') return;
      drafts.push(makePayment({
        loan_part_id: t.loan_part_id,
        date: clean(cellAt(row, map.date)),
        kind: t.kind,
        description: t.specText,
        amount: t.amount,
        balance_after: t.balance_after,
        source: 'import:' + fileName
      }));
    });
    if (!drafts.length) { toast('Nothing selected to add.'); return; }
    // Remember this column mapping for the file's header signature, so the next
    // export from the same bank re-maps itself.
    var presets = Object.assign({}, settings.import_presets || {});
    presets[headerSignature(parsed.headers)] = mappingToNames(parsed.headers, map);
    store.saveSettings({ import_presets: presets }).then(function (s) { settings = s; });
    store.addPayments(drafts).then(function (saved) {
      flashSaved();
      toast('Added ' + saved.length + ' row' + (saved.length === 1 ? '' : 's') + ' from “' + fileName + '”.');
      refresh();
      advanceQueue();
    });
  }
  function resetWizard() {
    parsed = null; triage = []; fileName = '';
    importConfig.hidden = true;
    fileInput.value = '';
    refreshImportAvailability();
  }
  function refreshImportAvailability() {
    return store.listLoanParts().then(function (parts) {
      var none = parts.length === 0;
      if (importGuard) importGuard.hidden = !none || !importConfig.hidden;
      if (dropzone) dropzone.hidden = none || !importConfig.hidden;
    });
  }

  // ── dashboard ──────────────────────────────────────────────────────────────
  var dashHeadline = $('dashHeadline'), dashHeadlineLabel = $('dashHeadlineLabel'),
      dashSub = $('dashSub'), dashSplit = $('dashSplit'), dashChips = $('dashChips');

  function chip(label, value, accent, warn) {
    return '<div class="metric-chip' + (accent ? ' is-accent' : '') + (warn ? ' is-warn' : '') + '">'
      + '<span class="metric-label">' + escapeHtml(label) + '</span>'
      + '<span class="metric-val">' + value + '</span></div>';
  }
  function splitCard(person, share, pct, hasValuation, accent) {
    return '<div class="split-card' + (accent ? ' is-accent' : '') + '">'
      + '<span class="split-name">' + escapeHtml(nameOf(person)) + ' · ' + formatPct(pct) + '</span>'
      + '<span class="split-val">' + (hasValuation ? formatMoney(share) : '—') + '</span>'
      + '<span class="split-sub">equity share</span></div>';
  }

  function renderDashboard() {
    return Promise.all([store.listLoanParts(), store.listPayments(), store.listValuations()]).then(function (res) {
      var parts = res[0], pays = res[1], vals = res[2];
      var balance = totalBalance(parts, pays);
      var value = propertyValue(vals);
      var eq = equity(value, balance);
      var split = ownerSplit(eq, settings);
      var pct = ownerPercents(settings);
      var ltv = loanToValue(balance, value);
      var amortized = totalAmortized(parts, pays);
      var interest = totalInterest(pays);
      var deduction = ranteavdrag(interest);
      var hasValuation = vals.length > 0;

      dashHeadlineLabel.textContent = 'Eget kapital · Total equity';
      dashHeadline.textContent = hasValuation ? formatMoney(eq) : '—';
      if (!parts.length) {
        dashSub.textContent = 'Add a loan part and a property value to get started.';
      } else if (!hasValuation) {
        dashSub.textContent = 'Add a property value to see equity · ' + formatMoney(balance) + ' owed across ' + parts.length + ' part' + (parts.length === 1 ? '' : 's') + '.';
      } else {
        dashSub.textContent = formatPct(ltv) + ' loan-to-value · ' + formatMoney(balance) + ' still owed to the bank.';
      }

      dashSplit.innerHTML = splitCard('a', split.a, pct.a, hasValuation, true) + splitCard('b', split.b, pct.b, hasValuation, false);

      var chips = '';
      chips += chip('Remaining debt', formatMoney(balance), true);
      chips += chip('Property value', hasValuation ? formatMoney(value) : '—');
      chips += chip('Loan-to-value', hasValuation ? formatPct(ltv) : '—');
      chips += chip('Total amortised', formatMoney(amortized));
      chips += chip('Interest paid', formatMoney0(interest));
      if (settings.ranteavdrag) chips += chip('Ränteavdrag (est.)', formatMoney0(deduction));
      // Soonest bound-rate (bunden) expiry across the parts — the next omförhandling.
      var soon = null;
      parts.forEach(function (p) {
        var bs = bindingStatus(p);
        if (bs.bound && bs.days_left != null && (soon == null || bs.days_left < soon.days)) {
          soon = { days: bs.days_left, until: bs.until };
        }
      });
      if (soon) chips += chip('Bound rate ends', soon.until, false, soon.days <= 90);
      dashChips.innerHTML = chips;
    });
  }

  // ── ownership-vs-bank chart (Chart.js) ────────────────────────────────────
  var chartInstance = null;
  function getChartColors() {
    var style = getComputedStyle(document.documentElement);
    var get = function (v) { return style.getPropertyValue(v).trim(); };
    return {
      grid: get('--rule'), tick: get('--ink-soft'),
      tooltipBg: get('--paper-card'), tooltipBorder: get('--rule'),
      tooltipTitle: get('--ink'), tooltipBody: get('--ink-mid'), legend: get('--ink-mid'),
      a: get('--accent'), b: get('--accent-light'), bank: get('--warn-light')
    };
  }
  function hexToRgba(hex, alpha) {
    hex = String(hex || '').replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var n = parseInt(hex, 16);
    if (isNaN(n)) return 'rgba(0,0,0,' + alpha + ')';
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  function renderChart() {
    var canvas = $('equityChart'), empty = $('chartEmpty');
    if (!canvas) return Promise.resolve();
    return Promise.all([store.listLoanParts(), store.listPayments(), store.listValuations()]).then(function (res) {
      var parts = res[0], pays = res[1], vals = res[2];
      var timeline = equityTimeline(parts, pays, vals, settings);
      var renderable = typeof window.Chart !== 'undefined' && timeline.length >= 2 && vals.length > 0;
      if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
      if (!renderable) {
        canvas.hidden = true;
        empty.hidden = false;
        empty.textContent = typeof window.Chart === 'undefined'
          ? 'Chart unavailable offline.'
          : (vals.length === 0 ? 'Add a property value to chart your equity vs the bank.'
                               : 'Import a few months of payments to see the trend.');
        return;
      }
      canvas.hidden = false;
      empty.hidden = true;
      var cc = getChartColors();
      var ds = function (label, key, color) {
        return {
          label: label,
          data: timeline.map(function (r) { return Math.max(0, r[key]); }),
          borderColor: color, backgroundColor: hexToRgba(color, 0.28),
          borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 10, tension: 0.25, fill: true
        };
      };
      var datasets = [
        ds(nameOf('a') + '’s equity', 'a_equity', cc.a),
        ds(nameOf('b') + '’s equity', 'b_equity', cc.b),
        ds('Banken · Bank', 'bank', cc.bank)
      ];
      chartInstance = new window.Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { labels: timeline.map(function (r) { return r.label; }), datasets: datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          animation: { duration: 600, easing: 'easeOutQuart' },
          plugins: {
            legend: { position: 'top', labels: { font: { family: 'Inter', size: 12 }, color: cc.legend, boxWidth: 14, padding: 14, usePointStyle: true, pointStyle: 'rectRounded' } },
            tooltip: {
              backgroundColor: cc.tooltipBg, borderColor: cc.tooltipBorder, borderWidth: 1,
              titleColor: cc.tooltipTitle, bodyColor: cc.tooltipBody,
              titleFont: { family: 'Inter', size: 12, weight: '500' }, bodyFont: { family: 'Inter', size: 12 },
              padding: 10, cornerRadius: 10, boxPadding: 4,
              callbacks: { label: function (item) { return ' ' + item.dataset.label + ': ' + Number(item.raw).toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kr'; } }
            }
          },
          scales: {
            x: { grid: { color: cc.grid, lineWidth: 0.5 }, ticks: { font: { family: 'Inter', size: 11 }, color: cc.tick, maxTicksLimit: 12 } },
            y: { stacked: true, grid: { color: cc.grid, lineWidth: 0.5 }, ticks: { font: { family: 'Inter', size: 11 }, color: cc.tick, callback: function (v) { return Math.round(v / 1000) + 'k'; } } }
          }
        }
      });
    });
  }

  // ── loan parts ──────────────────────────────────────────────────────────────
  var partsHost = $('partsHost'), partsCount = $('partsCount');
  function renderParts() {
    return Promise.all([store.listLoanParts(), store.listPayments()]).then(function (res) {
      var parts = res[0], pays = res[1];
      partsCount.textContent = parts.length;
      if (!parts.length) {
        partsHost.innerHTML = '<p class="empty">No loan parts yet. Add your lånedelar — one per loan account — to begin.</p>';
        return;
      }
      var total = totalBalance(parts, pays);
      var body = parts.map(function (p) {
        var bal = partBalance(p, pays);
        var pct = total > 0 ? bal / total * 100 : 0;
        var rate = p.interest_rate == null ? '—' : formatPct(p.interest_rate);
        return '<tr' + (p.archived ? ' class="is-settled"' : '') + '>'
          + '<td>' + escapeHtml(p.label || '(no name)') + (p.loan_number ? ' <span class="row-note">#' + escapeHtml(p.loan_number) + '</span>' : '') + '</td>'
          + '<td class="num">' + formatMoney(bal) + '</td>'
          + '<td class="num">' + formatPct(pct) + '</td>'
          + '<td>' + rate + '</td>'
          + '<td class="col-act">'
          + '<button type="button" class="icon-btn" data-edit-part="' + escapeHtml(p.id) + '" title="Edit" aria-label="Edit">✎</button>'
          + '<button type="button" class="icon-btn" data-del-part="' + escapeHtml(p.id) + '" title="Delete" aria-label="Delete">✕</button>'
          + '</td></tr>';
      }).join('');
      partsHost.innerHTML = '<div class="table-wrap"><table class="data-table">'
        + '<thead><tr><th>Loan part</th><th class="num">Balance</th><th class="num">Share</th><th>Rate</th><th class="col-act"></th></tr></thead>'
        + '<tbody>' + body + '</tbody></table></div>';
    });
  }

  // ── property valuations ───────────────────────────────────────────────────
  var valuationsHost = $('valuationsHost'), valuationsCount = $('valuationsCount');
  function renderValuations() {
    return store.listValuations().then(function (vals) {
      valuationsCount.textContent = vals.length;
      if (!vals.length) {
        valuationsHost.innerHTML = '<p class="empty">No valuations yet. Add what the home is worth today — update it whenever you re-value.</p>';
        return;
      }
      var chron = vals.slice().sort(function (a, b) { return String(a.date || '').localeCompare(String(b.date || '')); });
      var max = chron.reduce(function (mx, v) { return Math.max(mx, Number(v.value) || 0); }, 0);
      var barsHtml = '';
      if (chron.length > 1) {
        barsHtml = '<div class="bars">' + chron.map(function (v) {
          var pct = max > 0 ? Math.max(2, Math.round((Number(v.value) || 0) / max * 100)) : 0;
          return '<div class="bar-row is-groceries">'
            + '<span class="bar-label">' + escapeHtml(v.date || '—') + '</span>'
            + '<span class="bar-track"><span class="bar-fill" style="width:' + pct + '%"></span></span>'
            + '<span class="bar-val num">' + formatMoney(v.value) + '</span></div>';
        }).join('') + '</div>';
      }
      var body = vals.map(function (v) {
        return '<tr>'
          + '<td class="col-date">' + escapeHtml(v.date || '—') + '</td>'
          + '<td class="num">' + formatMoney(v.value) + '</td>'
          + '<td>' + escapeHtml(v.note || '') + '</td>'
          + '<td class="col-act">'
          + '<button type="button" class="icon-btn" data-edit-val="' + escapeHtml(v.id) + '" title="Edit" aria-label="Edit">✎</button>'
          + '<button type="button" class="icon-btn" data-del-val="' + escapeHtml(v.id) + '" title="Delete" aria-label="Delete">✕</button>'
          + '</td></tr>';
      }).join('');
      valuationsHost.innerHTML = barsHtml + '<div class="table-wrap"><table class="data-table">'
        + '<thead><tr><th class="col-date">Date</th><th class="num">Value</th><th>Note</th><th class="col-act"></th></tr></thead>'
        + '<tbody>' + body + '</tbody></table></div>';
    });
  }

  // ── payments ledger ──────────────────────────────────────────────────────
  var paymentsHost = $('paymentsHost'), paymentsCount = $('paymentsCount'),
      paymentFilterEl = $('paymentFilter'), clearPaymentsBtn = $('clearPaymentsBtn');
  function buildPaymentFilter(parts) {
    var html = '<button type="button" class="seg' + (currentPaymentFilter === 'all' ? ' is-active' : '') + '" data-filter="all" role="radio">All</button>';
    parts.forEach(function (p) {
      html += '<button type="button" class="seg' + (currentPaymentFilter === p.id ? ' is-active' : '') + '" data-filter="' + escapeHtml(p.id) + '" role="radio">' + escapeHtml(p.label || 'part') + '</button>';
    });
    paymentFilterEl.innerHTML = html;
  }
  function renderPayments() {
    return Promise.all([store.listPayments(), store.listLoanParts()]).then(function (res) {
      var pays = res[0], parts = res[1];
      buildPaymentFilter(parts);
      var partName = {};
      parts.forEach(function (p) { partName[p.id] = p.label || '(part)'; });
      var filtered = currentPaymentFilter === 'all' ? pays : pays.filter(function (p) { return p.loan_part_id === currentPaymentFilter; });
      paymentsCount.textContent = filtered.length;
      // "Delete all" is scoped to the active filter: a single loan part when one
      // is selected, everything under "All".
      clearPaymentsBtn.textContent = currentPaymentFilter === 'all' ? 'Delete all' : 'Delete ' + (partName[currentPaymentFilter] || 'part');
      clearPaymentsBtn.disabled = filtered.length === 0;
      if (!filtered.length) {
        paymentsHost.innerHTML = '<p class="empty">' + (pays.length
          ? 'No payments for this loan part.'
          : 'No payments yet. Import a statement above, or add one manually.') + '</p>';
        return;
      }
      var body = filtered.map(function (p) {
        return '<tr>'
          + '<td class="col-date">' + escapeHtml(p.date || '—') + '</td>'
          + '<td>' + escapeHtml(partName[p.loan_part_id] || '—') + '</td>'
          + '<td><span class="kind-tag kind-' + escapeHtml(p.kind || 'other') + '">' + escapeHtml(kindLabel(p.kind)) + '</span></td>'
          + '<td class="num">' + formatMoney(p.amount) + '</td>'
          + '<td class="num">' + (p.balance_after != null ? formatMoney(p.balance_after) : '—') + '</td>'
          + '<td class="col-act">'
          + '<button type="button" class="icon-btn" data-edit-pay="' + escapeHtml(p.id) + '" title="Edit" aria-label="Edit">✎</button>'
          + '<button type="button" class="icon-btn" data-del-pay="' + escapeHtml(p.id) + '" title="Delete" aria-label="Delete">✕</button>'
          + '</td></tr>';
      }).join('');
      paymentsHost.innerHTML = '<div class="table-wrap"><table class="data-table">'
        + '<thead><tr><th class="col-date">Date</th><th>Loan part</th><th>Type</th><th class="num">Amount</th><th class="num">Balance</th><th class="col-act"></th></tr></thead>'
        + '<tbody>' + body + '</tbody></table></div>';
    });
  }

  // ── reconciliation banner ─────────────────────────────────────────────────
  function renderReconcile() {
    return Promise.all([store.listLoanParts(), store.listPayments()]).then(function (res) {
      var banner = $('reconcileBanner');
      // Only flag a MATERIAL start-vs-ledger gap. A hairline difference just means
      // the import starts a month or two after origination (normal) — a real
      // partial import is large. Threshold: ≥1% of the loan, and ≥5 000 kr.
      var rows = reconcileBalance(res[0], res[1]).filter(function (r) {
        if (r.drift == null || r.start_balance == null) return false;
        return Math.abs(r.drift) >= Math.max(r.start_balance * 0.01, 5000);
      });
      if (!rows.length) { banner.hidden = true; banner.innerHTML = ''; return; }
      var items = rows.map(function (r) {
        return '<li>' + escapeHtml(r.label || 'Loan part') + ': start balance ' + formatMoney(r.start_balance)
          + ' vs the ledger’s earliest Saldo ' + formatMoney(r.start_saldo) + ' — off by ' + formatMoney(Math.abs(r.drift)) + '</li>';
      }).join('');
      banner.innerHTML = 'Start-balance check — your entered start balance doesn’t match where the imported ledger begins '
        + '(a partial import, or a start balance to update — today’s balance still tracks the Saldo correctly):<ul>' + items + '</ul>';
      banner.hidden = false;
    });
  }

  // ── insights: equity bridge + cost / blended rate / amorteringskrav chips ──
  function renderBridge(b) {
    var amort = b.amortization_gain, appr = b.appreciation_gain, total = b.total_gain;
    var wsum = Math.abs(amort) + Math.abs(appr);
    var pa = wsum > 0 ? Math.round(Math.abs(amort) / wsum * 100) : 0;
    var label = bridgePeriod === 'ytd' ? 'i år' : (bridgePeriod === '12m' ? 'senaste 12 mån' : 'sedan start');
    function signed(n) { return (n >= 0 ? '+' : '−') + formatMoney(Math.abs(n)); }
    $('bridgeHost').innerHTML = '<div class="bridge-head">'
      + '<span class="bridge-title">Förändring eget kapital · equity change ' + escapeHtml(label) + '</span>'
      + '<span class="bridge-total' + (total < 0 ? ' is-neg' : '') + '">' + signed(total) + '</span></div>'
      + '<div class="bridge-bar">'
      + '<span class="bridge-seg is-amort' + (amort < 0 ? ' is-neg' : '') + '" style="width:' + pa + '%"></span>'
      + '<span class="bridge-seg is-appr' + (appr < 0 ? ' is-neg' : '') + '" style="width:' + (100 - pa) + '%"></span></div>'
      + '<div class="bridge-legend">'
      + '<span class="bridge-key"><span class="bridge-dot is-amort"></span>Amortering <b>' + signed(amort) + '</b></span>'
      + '<span class="bridge-key"><span class="bridge-dot is-appr"></span>Värdeökning · appreciation <b>' + signed(appr) + '</b></span></div>';
  }
  function renderInsights() {
    return Promise.all([store.listLoanParts(), store.listPayments(), store.listValuations(), store.listRateChanges()]).then(function (res) {
      var parts = res[0], pays = res[1], vals = res[2], rates = res[3];
      var emptyEl = $('insightsEmpty'), body = $('insightsBody');
      if (!parts.length || !vals.length || !pays.length) { emptyEl.hidden = false; body.hidden = true; return; }
      emptyEl.hidden = true; body.hidden = false;

      var to = todayISO();
      var from = periodFrom(bridgePeriod);
      if (from == null) {
        var dates = [];
        vals.forEach(function (v) { if (v.date) dates.push(String(v.date)); });
        pays.forEach(function (p) { if (p.date) dates.push(String(p.date)); });
        dates.sort();
        from = dates.length ? dates[0] : to;
      }
      renderBridge(equityBridge(parts, pays, vals, from, to));

      var chips = '';
      var costRows = monthlyCost(pays, { ranteavdrag: settings.ranteavdrag });
      if (costRows.length) {
        var last = costRows[costRows.length - 1];
        chips += chip(settings.ranteavdrag ? 'Latest mo · net cost' : 'Latest mo · cost', formatMoney0(last.net));
      }
      var blended = weightedAvgRate(parts, rates, pays);
      if (blended > 0) chips += chip('Blended rate', formatPct(blended), true);
      // Amorteringskrav as a REFERENCE, not a compliance verdict: the tool can't
      // see grandfathering/nyproduktion exemptions, and the observed amortisation
      // from a partial import is too noisy to judge "met/below" reliably. Show the
      // bracket the LTV implies and the annual amount it works out to.
      var krav = amorteringskravStatus(parts, pays, vals, settings);
      if (krav.has_value) {
        if (krav.exempt) chips += chip('Amorteringskrav (est.)', 'None · LTV ≤ 50 %');
        else chips += chip('Amorteringskrav (est.)', krav.required_pct + ' % · ' + formatMoney(krav.required_annual) + '/år');
      }
      $('insightChips').innerHTML = chips;
    });
  }

  // ── projection: payoff / LTV milestones + what-if extra amortering ────────
  function renderProjection() {
    return Promise.all([store.listLoanParts(), store.listPayments(), store.listValuations()]).then(function (res) {
      var parts = res[0], pays = res[1], vals = res[2];
      var note = $('projNote'), chipsHost = $('projChips');
      if (!parts.length) { note.textContent = 'Add a loan part to project your payoff.'; chipsHost.innerHTML = ''; return; }
      var extra = parseAmount($('extraAmort').value);
      if (!isFinite(extra) || extra < 0) extra = 0;
      var base = monthlyAmortizationRate(parts, pays);
      var ms = projectMilestones(parts, pays, vals, settings, { extraMonthly: extra });
      if (ms.flat && extra <= 0) {
        note.textContent = 'Interest-only — the balance stays flat. Enter an extra monthly amortering above to see a payoff date.';
      } else {
        note.textContent = 'At ' + formatMoney(ms.per_month) + '/mo (' + formatMoney(base) + ' observed + ' + formatMoney(extra)
          + ' extra), property value held flat.';
      }
      var chips = chip('Payoff', ms.payoff_months == null ? 'Never' : monthsToWhen(ms.payoff_months), ms.payoff_months != null);
      if (vals.length) {
        chips += chip('70 % LTV', monthsToWhen(ms.ltv70_months));
        chips += chip('50 % LTV', monthsToWhen(ms.ltv50_months));
      }
      chipsHost.innerHTML = chips;
    });
  }

  // ── rate history ──────────────────────────────────────────────────────────
  function renderRateHistory() {
    return Promise.all([store.listRateChanges(), store.listLoanParts(), store.listPayments()]).then(function (res) {
      var rates = res[0], parts = res[1], pays = res[2];
      $('rateCount').textContent = rates.length;
      var partName = {};
      parts.forEach(function (p) { partName[p.id] = p.label || '(part)'; });
      var blended = weightedAvgRate(parts, rates, pays);
      var head = blended > 0 ? '<p class="contrib-note">Blended rate now: <b>' + formatPct(blended) + '</b> — weighted by each part’s balance.</p>' : '';
      if (!rates.length) {
        $('rateHost').innerHTML = head + '<p class="empty">No rate changes logged. Add one whenever a part’s rate moves — the blended rate and cost view follow it.</p>';
        return;
      }
      var body = rates.map(function (r) {
        return '<tr>'
          + '<td class="col-date">' + escapeHtml(r.date || '—') + '</td>'
          + '<td>' + escapeHtml(partName[r.loan_part_id] || '—') + '</td>'
          + '<td class="num">' + (r.rate != null ? formatPct(r.rate) : '—') + '</td>'
          + '<td class="col-act">'
          + '<button type="button" class="icon-btn" data-edit-rate="' + escapeHtml(r.id) + '" title="Edit" aria-label="Edit">✎</button>'
          + '<button type="button" class="icon-btn" data-del-rate="' + escapeHtml(r.id) + '" title="Delete" aria-label="Delete">✕</button>'
          + '</td></tr>';
      }).join('');
      $('rateHost').innerHTML = head + '<div class="table-wrap"><table class="data-table">'
        + '<thead><tr><th class="col-date">Date</th><th>Loan part</th><th class="num">Rate</th><th class="col-act"></th></tr></thead>'
        + '<tbody>' + body + '</tbody></table></div>';
    });
  }

  // ── contributions (only when tracking is on) ──────────────────────────────
  function contribSplitCard(person, amount, pct, accent) {
    return '<div class="split-card' + (accent ? ' is-accent' : '') + '">'
      + '<span class="split-name">' + escapeHtml(nameOf(person)) + ' · ' + formatPct(pct) + '</span>'
      + '<span class="split-val">' + formatMoney(amount) + '</span>'
      + '<span class="split-sub">contributed</span></div>';
  }
  function renderContributions() {
    var card = $('contribCard');
    if (!settings.track_contributions) { card.hidden = true; return Promise.resolve(); }
    card.hidden = false;
    return Promise.all([store.listContributions(), store.listPayments()]).then(function (res) {
      var contribs = res[0], pays = res[1];
      $('contribCount').textContent = contribs.length;
      var split = contributionSplit(pays, contribs, settings);
      var setl = settlement(pays, contribs, settings);
      $('contribSplit').innerHTML = contribSplitCard('a', split.a, split.a_pct, settings.i_am !== 'b')
        + contribSplitCard('b', split.b, split.b_pct, settings.i_am === 'b');
      if (setl.owes && setl.amount > 0) {
        $('contribNote').textContent = nameOf(setl.owes) + ' owes ' + nameOf(otherOwner(setl.owes)) + ' '
          + formatMoney(setl.amount) + ' to reach the target ownership split.';
      } else if (split.total > 0) {
        $('contribNote').textContent = 'Contributions are in line with the target ownership split.';
      } else {
        $('contribNote').textContent = 'Log who paid each amortering (in a payment) and any lump sums to build contribution-based ownership.';
      }
      if (!contribs.length) {
        $('contribHost').innerHTML = '<p class="empty">No lump sums yet. Per-owner amortering is counted automatically from the payments above; add down payments here.</p>';
        return;
      }
      var ownerLabel = function (o) { return o === 'joint' ? 'Gemensam · Joint' : nameOf(o === 'b' ? 'b' : 'a'); };
      var body = contribs.map(function (c) {
        return '<tr>'
          + '<td class="col-date">' + escapeHtml(c.date || '—') + '</td>'
          + '<td>' + escapeHtml(ownerLabel(c.owner)) + '</td>'
          + '<td class="num">' + formatMoney(c.amount) + '</td>'
          + '<td>' + escapeHtml(c.note || '') + '</td>'
          + '<td class="col-act">'
          + '<button type="button" class="icon-btn" data-edit-contrib="' + escapeHtml(c.id) + '" title="Edit" aria-label="Edit">✎</button>'
          + '<button type="button" class="icon-btn" data-del-contrib="' + escapeHtml(c.id) + '" title="Delete" aria-label="Delete">✕</button>'
          + '</td></tr>';
      }).join('');
      $('contribHost').innerHTML = '<div class="table-wrap"><table class="data-table">'
        + '<thead><tr><th class="col-date">Date</th><th>Owner</th><th class="num">Amount</th><th>Note</th><th class="col-act"></th></tr></thead>'
        + '<tbody>' + body + '</tbody></table></div>';
    });
  }

  function refresh() {
    renderDashboard();
    renderReconcile();
    renderChart();
    renderInsights();
    renderProjection();
    renderParts();
    renderRateHistory();
    renderValuations();
    renderPayments();
    renderContributions();
    refreshImportAvailability();
  }

  // ── loan-part dialog ──────────────────────────────────────────────────────
  var partDialog = $('partDialog'), partForm = $('partForm'), partDialogTitle = $('partDialogTitle');
  var pLabel = $('p-label'), pLoanNo = $('p-loanno'), pStart = $('p-start'), pStartDate = $('p-startdate'), pRate = $('p-rate');
  var pRateType = $('p-ratetype'), pBindingField = $('p-binding-field'), pBinding = $('p-binding');
  var editingPartId = null;
  function updateBindingField() { pBindingField.hidden = segValue(pRateType) !== 'bunden'; }
  function openPartDialog(id) {
    editingPartId = id || null;
    partDialogTitle.textContent = id ? 'Edit loan part' : 'Add loan part';
    function show(p) {
      pLabel.value = (p && p.label) || '';
      pLoanNo.value = (p && p.loan_number) || '';
      pStart.value = p && p.start_balance ? String(p.start_balance) : '';
      pStartDate.value = (p && p.start_date) || todayISO();
      pRate.value = p && p.interest_rate != null ? String(p.interest_rate) : '';
      setSeg(pRateType, (p && p.rate_type) === 'bunden' ? 'bunden' : 'rörlig');
      pBinding.value = (p && p.rate_binding_until) || '';
      updateBindingField();
      partDialog.showModal();
    }
    if (id) store.listLoanParts().then(function (parts) { var p = parts.filter(function (x) { return x.id === id; })[0]; if (p) show(p); });
    else show(null);
  }
  function submitPart(e) {
    e.preventDefault();
    var startRaw = clean(pStart.value);
    var rec = makeLoanPart({
      label: clean(pLabel.value) || 'Lånedel',
      loan_number: clean(pLoanNo.value),
      start_balance: startRaw === '' ? 0 : parseAmount(startRaw),
      start_date: clean(pStartDate.value),
      interest_rate: clean(pRate.value) === '' ? null : parseAmount(pRate.value),
      rate_type: segValue(pRateType) === 'bunden' ? 'bunden' : 'rörlig',
      rate_binding_until: clean(pBinding.value) || null
    });
    var op = editingPartId ? store.updateLoanPart(editingPartId, rec) : store.addLoanPart(rec);
    op.then(function () { partDialog.close(); refresh(); flashSaved(); toast(editingPartId ? 'Loan part updated.' : 'Loan part added.'); });
  }
  function deletePart(id) {
    if (!window.confirm('Delete this loan part and all its payments? This can’t be undone.')) return;
    store.removeLoanPart(id).then(function () { refresh(); flashSaved(); toast('Loan part deleted.'); });
  }

  // ── valuation dialog ──────────────────────────────────────────────────────
  var valuationDialog = $('valuationDialog'), valuationForm = $('valuationForm'), valuationDialogTitle = $('valuationDialogTitle');
  var vDate = $('v-date'), vValue = $('v-value'), vNote = $('v-note');
  var editingValId = null;
  function openValuationDialog(id) {
    editingValId = id || null;
    valuationDialogTitle.textContent = id ? 'Edit valuation' : 'Add property value';
    function show(v) {
      vDate.value = (v && v.date) || todayISO();
      vValue.value = v && v.value != null ? String(v.value) : '';
      vNote.value = (v && v.note) || '';
      valuationDialog.showModal();
    }
    if (id) store.listValuations().then(function (vals) { var v = vals.filter(function (x) { return x.id === id; })[0]; if (v) show(v); });
    else show(null);
  }
  function submitValuation(e) {
    e.preventDefault();
    var value = parseAmount(vValue.value);
    if (!isFinite(value) || value <= 0) { toast('Enter the property value.'); return; }
    var rec = { date: clean(vDate.value), value: round2(value), note: clean(vNote.value) };
    var op = editingValId ? store.updateValuation(editingValId, rec) : store.addValuation(rec);
    op.then(function () { valuationDialog.close(); refresh(); flashSaved(); toast(editingValId ? 'Valuation updated.' : 'Valuation added.'); });
  }
  function deleteValuation(id) {
    if (!window.confirm('Delete this valuation?')) return;
    store.removeValuation(id).then(function () { refresh(); flashSaved(); toast('Valuation deleted.'); });
  }

  // ── payment dialog ────────────────────────────────────────────────────────
  var paymentDialog = $('paymentDialog'), paymentForm = $('paymentForm'), paymentDialogTitle = $('paymentDialogTitle');
  var payPart = $('pay-part'), payDate = $('pay-date'), payType = $('pay-type'), payAmount = $('pay-amount'), payBalance = $('pay-balance'), payHint = $('pay-hint');
  var payPaidBy = $('pay-paidby'), payPaidByField = $('pay-paidby-field');
  var editingPayId = null;
  function fillPayHint() {
    var amt = parseAmount(payAmount.value);
    var kind = payType.value;
    var av = isFinite(amt) ? Math.abs(amt) : 0;
    if (!av) { payHint.textContent = ''; return; }
    if (kind === 'interest') payHint.textContent = formatMoney(av) + ' interest — does not reduce the balance.';
    else if (kind === 'amortization') payHint.textContent = formatMoney(av) + ' amortering — reduces the balance.';
    else if (kind === 'loan') payHint.textContent = formatMoney(av) + ' disbursed — sets the part’s original principal.';
    else payHint.textContent = formatMoney(av) + ' ' + kindLabel(kind).toLowerCase() + '.';
  }
  function openPaymentDialog(id) {
    editingPayId = id || null;
    paymentDialogTitle.textContent = id ? 'Edit payment' : 'Add payment';
    store.listLoanParts().then(function (parts) {
      if (!parts.length) { toast('Add a loan part first.'); return; }
      payPart.innerHTML = parts.map(function (p) { return '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.label || '(loan part)') + '</option>'; }).join('');
      function show(p) {
        payPart.value = (p && p.loan_part_id) || parts[0].id;
        payDate.value = (p && p.date) || todayISO();
        payType.value = (p && p.kind) || 'interest';
        payAmount.value = p && p.amount != null ? String(p.amount) : '';
        payBalance.value = p && p.balance_after != null ? String(p.balance_after) : '';
        payPaidBy.value = (p && p.paid_by) || 'joint';
        payPaidByField.hidden = !settings.track_contributions;
        fillPayHint();
        paymentDialog.showModal();
      }
      if (id) store.listPayments().then(function (pays) { var p = pays.filter(function (x) { return x.id === id; })[0]; if (p) show(p); });
      else show(null);
    });
  }
  function submitPayment(e) {
    e.preventDefault();
    var rec = makePayment({
      loan_part_id: payPart.value,
      date: clean(payDate.value),
      kind: payType.value,
      description: kindLabel(payType.value),
      amount: parseAmount(payAmount.value),
      balance_after: clean(payBalance.value) === '' ? null : parseAmount(payBalance.value),
      paid_by: payPaidBy.value
    });
    if (rec.amount === 0 && rec.balance_after == null) { toast('Enter an amount or a balance.'); return; }
    var op = editingPayId
      ? store.updatePayment(editingPayId, { loan_part_id: rec.loan_part_id, date: rec.date, kind: rec.kind, description: rec.description, amount: rec.amount, balance_after: rec.balance_after, paid_by: rec.paid_by })
      : store.addPayment(rec);
    op.then(function () { paymentDialog.close(); refresh(); flashSaved(); toast(editingPayId ? 'Payment updated.' : 'Payment added.'); });
  }
  function deletePayment(id) {
    if (!window.confirm('Delete this payment?')) return;
    store.removePayment(id).then(function () { refresh(); flashSaved(); toast('Payment deleted.'); });
  }

  // ── rate-change dialog ────────────────────────────────────────────────────
  var rateDialog = $('rateDialog'), rateForm = $('rateForm'), rateDialogTitle = $('rateDialogTitle');
  var rPart = $('r-part'), rDate = $('r-date'), rRate = $('r-rate');
  var editingRateId = null;
  function openRateDialog(id) {
    editingRateId = id || null;
    rateDialogTitle.textContent = id ? 'Edit rate change' : 'Add rate change';
    store.listLoanParts().then(function (parts) {
      if (!parts.length) { toast('Add a loan part first.'); return; }
      rPart.innerHTML = parts.map(function (p) { return '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.label || '(loan part)') + '</option>'; }).join('');
      function show(r) {
        rPart.value = (r && r.loan_part_id) || parts[0].id;
        rDate.value = (r && r.date) || todayISO();
        rRate.value = r && r.rate != null ? String(r.rate) : '';
        rateDialog.showModal();
      }
      if (id) store.listRateChanges().then(function (rs) { var r = rs.filter(function (x) { return x.id === id; })[0]; if (r) show(r); });
      else show(null);
    });
  }
  function submitRate(e) {
    e.preventDefault();
    var rate = parseAmount(rRate.value);
    if (!isFinite(rate)) { toast('Enter the new rate.'); return; }
    var rec = { loan_part_id: rPart.value, date: clean(rDate.value), rate: round2(rate) };
    var op = editingRateId ? store.updateRateChange(editingRateId, rec) : store.addRateChange(rec);
    op.then(function () { rateDialog.close(); refresh(); flashSaved(); toast(editingRateId ? 'Rate change updated.' : 'Rate change added.'); });
  }
  function deleteRate(id) {
    if (!window.confirm('Delete this rate change?')) return;
    store.removeRateChange(id).then(function () { refresh(); flashSaved(); toast('Rate change deleted.'); });
  }

  // ── contribution dialog ───────────────────────────────────────────────────
  var contribDialog = $('contribDialog'), contribForm = $('contribForm'), contribDialogTitle = $('contribDialogTitle');
  var cOwner = $('c-owner'), cDate = $('c-date'), cAmount = $('c-amount'), cNote = $('c-note');
  var editingContribId = null;
  function openContribDialog(id) {
    editingContribId = id || null;
    contribDialogTitle.textContent = id ? 'Edit contribution' : 'Add contribution';
    applyNames();
    function show(c) {
      setSeg(cOwner, (c && c.owner) === 'b' ? 'b' : 'a');
      cDate.value = (c && c.date) || todayISO();
      cAmount.value = c && c.amount != null ? String(c.amount) : '';
      cNote.value = (c && c.note) || '';
      contribDialog.showModal();
    }
    if (id) store.listContributions().then(function (cs) { var c = cs.filter(function (x) { return x.id === id; })[0]; if (c) show(c); });
    else show(null);
  }
  function submitContrib(e) {
    e.preventDefault();
    var amt = parseAmount(cAmount.value);
    if (!isFinite(amt) || amt <= 0) { toast('Enter the amount.'); return; }
    var rec = { owner: segValue(cOwner) === 'b' ? 'b' : 'a', date: clean(cDate.value), amount: round2(amt), note: clean(cNote.value) };
    var op = editingContribId ? store.updateContribution(editingContribId, rec) : store.addContribution(rec);
    op.then(function () { contribDialog.close(); refresh(); flashSaved(); toast(editingContribId ? 'Contribution updated.' : 'Contribution added.'); });
  }
  function deleteContrib(id) {
    if (!window.confirm('Delete this contribution?')) return;
    store.removeContribution(id).then(function () { refresh(); flashSaved(); toast('Contribution deleted.'); });
  }

  // ── settings dialog ────────────────────────────────────────────────────────
  var settingsDialog = $('settingsDialog'), settingsForm = $('settingsForm'), settingsBtn = $('settingsBtn');
  var sPropName = $('s-propname'), sNameA = $('s-nameA'), sNameB = $('s-nameB'), sMyPct = $('s-mypct'),
      sIam = $('s-iam'), sCurrency = $('s-currency'), sRanteavdrag = $('s-ranteavdrag'),
      sIncome = $('s-income'), sTrackContrib = $('s-track-contrib');
  var exportBtn = $('exportBtn'), exportCsvBtn = $('exportCsvBtn'), importBtn = $('importBtn'), importInput = $('importInput');
  var sMyPctLabel = $('s-mypct-label');
  function refreshPctLabel() {
    if (!sMyPctLabel) return;
    var who = segValue(sIam) === 'b' ? clean(sNameB.value) || 'B' : clean(sNameA.value) || 'A';
    sMyPctLabel.textContent = who + '’s ownership %';
  }
  function openSettings() {
    sPropName.value = settings.property_name || '';
    sNameA.value = settings.owner_a_name;
    sNameB.value = settings.owner_b_name;
    sMyPct.value = settings.my_ownership_pct != null ? String(settings.my_ownership_pct) : '50';
    setSeg(sIam, settings.i_am === 'b' ? 'b' : 'a');
    if (sCurrency) sCurrency.value = settings.currency || 'SEK';
    sRanteavdrag.checked = settings.ranteavdrag !== false;
    sIncome.value = settings.household_income_yearly != null ? String(settings.household_income_yearly) : '';
    sTrackContrib.checked = !!settings.track_contributions;
    applyNames();
    refreshPctLabel();
    settingsDialog.showModal();
  }
  function submitSettings(e) {
    e.preventDefault();
    var pct = parseAmount(sMyPct.value);
    var income = parseAmount(sIncome.value);
    store.saveSettings({
      property_name: clean(sPropName.value),
      owner_a_name: clean(sNameA.value) || 'Alex',
      owner_b_name: clean(sNameB.value) || 'Sam',
      my_ownership_pct: isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 50,
      i_am: (segValue(sIam) || 'a') === 'b' ? 'b' : 'a',
      currency: (sCurrency && sCurrency.value) || 'SEK',
      ranteavdrag: !!sRanteavdrag.checked,
      household_income_yearly: isFinite(income) && income > 0 ? round2(income) : null,
      track_contributions: !!sTrackContrib.checked
    }).then(function (s) {
      settings = s;
      applyNames();
      settingsDialog.close(); flashSaved(); toast('Settings saved.'); refresh();
    });
  }

  // ── JSON backup ─────────────────────────────────────────────────────────────
  function downloadText(filename, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  function exportBackup() {
    store.exportJSON().then(function (text) {
      downloadText('bolanekoll-backup-' + todayISO() + '.json', text);
      toast('Backup downloaded.');
    });
  }
  function exportCsv() {
    Promise.all([store.listPayments(), store.listLoanParts()]).then(function (res) {
      if (!res[0].length) { toast('No payments to export yet.'); return; }
      var blob = new Blob([paymentsToCsv(res[0], res[1])], { type: 'text/csv' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'bolanekoll-payments-' + todayISO() + '.csv';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('Payments CSV downloaded.');
    });
  }
  function importBackup(file) {
    var reader = new FileReader();
    reader.onload = function () {
      store.importJSON(String(reader.result)).then(function (added) {
        toast('Imported ' + added.loan_parts + ' part' + (added.loan_parts === 1 ? '' : 's') + ', ' + added.payments + ' payment' + (added.payments === 1 ? '' : 's') + ', ' + added.valuations + ' valuation' + (added.valuations === 1 ? '' : 's') + '.');
        return store.getSettings().then(function (s) { settings = s; applyNames(); refresh(); flashSaved(); });
      }).catch(function (e) { toast(e.message || 'Could not import that file.'); });
    };
    reader.onerror = function () { toast('Could not read that file.'); };
    reader.readAsText(file);
  }

  function applyNames() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-name="a"]'), function (el) { el.textContent = settings.owner_a_name; });
    Array.prototype.forEach.call(document.querySelectorAll('[data-name="b"]'), function (el) { el.textContent = settings.owner_b_name; });
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  $('browseBtn').addEventListener('click', function () { fileInput.click(); });
  $('changeFileBtn').addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () { if (fileInput.files && fileInput.files.length) handleFiles(fileInput.files); });
  $('cancelImport').addEventListener('click', function () { importQueue = []; queueIndex = 0; resetWizard(); });
  $('skipFileBtn').addEventListener('click', advanceQueue);
  confirmBtn.addEventListener('click', confirmImport);
  $('guardAddPartBtn').addEventListener('click', function () { openPartDialog(null); });

  ['dragover', 'dragenter'].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.add('is-drag'); });
  });
  ['dragleave', 'dragend'].forEach(function (ev) {
    dropzone.addEventListener(ev, function () { dropzone.classList.remove('is-drag'); });
  });
  dropzone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropzone.classList.remove('is-drag');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  mapSelects.forEach(function (sel) {
    sel.addEventListener('change', function () {
      if (!parsed) return;
      if (sel === elLoanNo) rebuildImportPartSelect();
      computeTriageMeta(); renderTriage();
    });
  });
  importPartSel.addEventListener('change', function () { if (parsed) { computeTriageMeta(); renderTriage(); } });

  triageBody.addEventListener('click', function (e) {
    var b = e.target.closest('.seg'); if (!b) return;
    var wrap = b.closest('.segmented-sm'); if (!wrap) return;
    var i = parseInt(wrap.getAttribute('data-index'), 10);
    triage[i].classification = b.getAttribute('data-class');
    renderTriage();
  });
  // Bulk-set every row at once. Amount-less rows can't be included, so only
  // rows with an amount flip to "include".
  function setAllTriage(classification) {
    triage.forEach(function (t) { if (t.hasAmount) t.classification = classification; });
    renderTriage();
  }
  $('triageIncludeAll').addEventListener('click', function () { setAllTriage('include'); });
  $('triageSkipAll').addEventListener('click', function () { setAllTriage('skip'); });

  $('addPartBtn').addEventListener('click', function () { openPartDialog(null); });
  $('addValuationBtn').addEventListener('click', function () { openValuationDialog(null); });
  $('addPaymentBtn').addEventListener('click', function () { openPaymentDialog(null); });
  $('addRateBtn').addEventListener('click', function () { openRateDialog(null); });
  $('addContribBtn').addEventListener('click', function () { openContribDialog(null); });
  clearPaymentsBtn.addEventListener('click', function () {
    Promise.all([store.listPayments(), store.listLoanParts()]).then(function (res) {
      var pays = res[0], parts = res[1];
      var scopeAll = currentPaymentFilter === 'all';
      var target = scopeAll ? pays : pays.filter(function (p) { return p.loan_part_id === currentPaymentFilter; });
      if (!target.length) { toast('No payments to delete.'); return; }
      var count = target.length, plural = count === 1 ? '' : 's';
      var what;
      if (scopeAll) {
        what = 'all ' + count + ' payment' + plural;
      } else {
        var part = parts.filter(function (p) { return p.id === currentPaymentFilter; })[0];
        what = count + ' payment' + plural + ' for ' + (part ? (part.label || 'this loan part') : 'this loan part');
      }
      if (!window.confirm('Delete ' + what + '? Loan parts and valuations are kept. This can’t be undone.')) return;
      store.removePayments(target.map(function (p) { return p.id; })).then(function (n) {
        refresh(); flashSaved(); toast('Deleted ' + n + ' payment' + (n === 1 ? '' : 's') + '.');
      });
    });
  });

  partsHost.addEventListener('click', function (e) {
    var ed = e.target.closest('[data-edit-part]'); if (ed) { openPartDialog(ed.getAttribute('data-edit-part')); return; }
    var dl = e.target.closest('[data-del-part]'); if (dl) { deletePart(dl.getAttribute('data-del-part')); }
  });
  valuationsHost.addEventListener('click', function (e) {
    var ed = e.target.closest('[data-edit-val]'); if (ed) { openValuationDialog(ed.getAttribute('data-edit-val')); return; }
    var dl = e.target.closest('[data-del-val]'); if (dl) { deleteValuation(dl.getAttribute('data-del-val')); }
  });
  paymentsHost.addEventListener('click', function (e) {
    var ed = e.target.closest('[data-edit-pay]'); if (ed) { openPaymentDialog(ed.getAttribute('data-edit-pay')); return; }
    var dl = e.target.closest('[data-del-pay]'); if (dl) { deletePayment(dl.getAttribute('data-del-pay')); }
  });
  $('rateHost').addEventListener('click', function (e) {
    var ed = e.target.closest('[data-edit-rate]'); if (ed) { openRateDialog(ed.getAttribute('data-edit-rate')); return; }
    var dl = e.target.closest('[data-del-rate]'); if (dl) { deleteRate(dl.getAttribute('data-del-rate')); }
  });
  $('contribHost').addEventListener('click', function (e) {
    var ed = e.target.closest('[data-edit-contrib]'); if (ed) { openContribDialog(ed.getAttribute('data-edit-contrib')); return; }
    var dl = e.target.closest('[data-del-contrib]'); if (dl) { deleteContrib(dl.getAttribute('data-del-contrib')); }
  });
  paymentFilterEl.addEventListener('click', function (e) {
    var b = e.target.closest('.seg'); if (!b) return;
    currentPaymentFilter = b.getAttribute('data-filter');
    renderPayments();
  });

  partForm.addEventListener('submit', submitPart);
  valuationForm.addEventListener('submit', submitValuation);
  paymentForm.addEventListener('submit', submitPayment);
  rateForm.addEventListener('submit', submitRate);
  contribForm.addEventListener('submit', submitContrib);
  payAmount.addEventListener('input', fillPayHint);
  payType.addEventListener('change', fillPayHint);
  wireSeg(pRateType, updateBindingField);

  // Insights period + projection what-if
  wireSeg($('bridgePeriod'), function (v) { bridgePeriod = v; renderInsights(); });
  $('extraAmort').addEventListener('input', renderProjection);

  settingsBtn.addEventListener('click', openSettings);
  settingsForm.addEventListener('submit', submitSettings);
  wireSeg(sIam, refreshPctLabel);
  sNameA.addEventListener('input', function () { var el = sIam.querySelector('[data-person="a"]'); if (el) el.textContent = clean(sNameA.value) || 'A'; refreshPctLabel(); });
  sNameB.addEventListener('input', function () { var el = sIam.querySelector('[data-person="b"]'); if (el) el.textContent = clean(sNameB.value) || 'B'; refreshPctLabel(); });
  exportBtn.addEventListener('click', exportBackup);
  exportCsvBtn.addEventListener('click', exportCsv);
  importBtn.addEventListener('click', function () { importInput.click(); });
  importInput.addEventListener('change', function () { if (importInput.files[0]) { importBackup(importInput.files[0]); importInput.value = ''; } });

  Array.prototype.forEach.call(document.querySelectorAll('dialog [data-close]'), function (b) {
    b.addEventListener('click', function () { b.closest('dialog').close(); });
  });

  // ── theme toggle (shared key with the rest of Hemma) ──
  var THEME_KEY = 'bostadskalkyl_theme';
  var themeBtn = $('themeToggleBtn');
  function applyThemeIcon() { if (themeBtn) themeBtn.textContent = document.documentElement.dataset.theme === 'dark' ? '☾' : '☀'; }
  function syncThemeColor() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
  }
  if (themeBtn) themeBtn.addEventListener('click', function () {
    document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, document.documentElement.dataset.theme); } catch (_) {}
    applyThemeIcon(); syncThemeColor();
    renderChart();
  });
  applyThemeIcon(); syncThemeColor();

  // ── boot ──
  store.getSettings().then(function (s) {
    settings = s;
    applyNames();
    refresh();
  });
}());
