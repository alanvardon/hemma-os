import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { computeContracting, defaultInputs, type KonsultInputs } from '../lib/konsult'
import { useTheme } from '../App'

const STORAGE_KEY = 'bostadskalkyl_konsult_v1'

function formatWithSpaces(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}
function parseFormatted(v: string): number {
  return parseFloat(v.replace(/[\s ]/g, '').replace(',', '.')) || 0
}
function curStr(n: number): string {
  return formatWithSpaces(Math.round(n))
}
function numStr(n: number): string {
  return (Math.round(n * 100) / 100).toString().replace('.', ',')
}
function money(n: number): string {
  return formatWithSpaces(Math.round(n)) + ' kr'
}
function pct0(x: number): string {
  return Math.round(x) + ' %'
}

function loadInputs(): KonsultInputs {
  const d = defaultInputs()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Record<string, unknown>
      for (const k of Object.keys(d) as (keyof KonsultInputs)[]) {
        const v = saved[k]
        if (typeof v === 'number' && isFinite(v)) d[k] = v
      }
    }
  } catch {
    // private mode or bad data
  }
  return d
}

function saveInputs(inputs: KonsultInputs) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(inputs)) } catch { /* ignore */ }
}

type FieldKind = 'cur' | 'num'

export default function Konsultkalkyl() {
  const { theme, toggleTheme } = useTheme()
  const [inputs, setInputs] = useState<KonsultInputs>(loadInputs)
  const [saveVisible, setSaveVisible] = useState(false)
  const [resetKey, setResetKey] = useState(0)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useLayoutEffect(() => {
    document.documentElement.classList.add('calc-layout')
    return () => document.documentElement.classList.remove('calc-layout')
  }, [])

  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) {
      const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()
      meta.setAttribute('content', paper)
    }
    document.title = 'Konsultkalkyl — Hemma'
  }, [theme])

  const result = useMemo(() => computeContracting(inputs), [inputs])

  function handleChange(key: keyof KonsultInputs, value: string) {
    const next = { ...inputs, [key]: parseFormatted(value) }
    setInputs(next)
    saveInputs(next)
    setSaveVisible(true)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => setSaveVisible(false), 1400)
  }

  function handleBlur(e: React.FocusEvent<HTMLInputElement>, key: keyof KonsultInputs, kind: FieldKind) {
    e.target.value = kind === 'cur' ? curStr(inputs[key]) : numStr(inputs[key])
  }

  function handleReset() {
    const d = defaultInputs()
    setInputs(d)
    saveInputs(d)
    setResetKey((k) => k + 1)
  }

  function field(
    id: string,
    label: string,
    en: string,
    key: keyof KonsultInputs,
    kind: FieldKind,
    unit: string,
    wide = false,
  ) {
    return (
      <div className={`field${wide ? ' field-wide' : ''}`} key={id}>
        <label htmlFor={id}>
          {label} <span className="field-en">{en}</span>
        </label>
        <div className="input-wrap">
          <input
            type="text"
            id={id}
            inputMode="decimal"
            autoComplete="off"
            key={resetKey}
            defaultValue={kind === 'cur' ? curStr(inputs[key]) : numStr(inputs[key])}
            onChange={(e) => handleChange(key, e.target.value)}
            onBlur={(e) => handleBlur(e, key, kind)}
          />
          <span className="unit">{unit}</span>
        </div>
      </div>
    )
  }

  const net = result.totalNetIncome > 0 ? result.totalNetIncome : 1
  const salShare = Math.max(0, Math.min(100, (result.netSalary / net) * 100))

  return (
    <>
      <header className="page-header">
        <div className="header-brand">
          <Link className="hub-link" to="/">‹ Hemma</Link>
          <div>
            <h1>Konsultkalkyl</h1>
            <p className="tagline">What contracting through your own AB could pay — Sweden, 2026</p>
          </div>
        </div>
        <div className="header-actions">
          <span className={`save-state${saveVisible ? ' show' : ''}`}>Saved ✓</span>
          <button
            className="btn btn-ghost theme-toggle-btn"
            title="Toggle dark mode"
            aria-label="Toggle dark mode"
            onClick={toggleTheme}
          >
            {theme === 'dark' ? '☾' : '☀'}
          </button>
          <button className="btn btn-ghost" onClick={handleReset}>Reset</button>
        </div>
      </header>

      <div className="konsult-layout">

        {/* ── INPUTS (left rail) ─────────────────────── */}
        <div className="inputs-col">

          <div className="section">
            <div className="section-label">
              <span className="section-num">1</span>
              <span className="section-title">Debitering · Billing</span>
            </div>
            <div className="field-grid">
              {field('in-rate',     'Timpris',          'Rate',        'rate',          'cur', 'kr/h')}
              {field('in-hours',    'Timmar / vecka',   'Hours/week',  'hoursPerWeek',  'num', 'h')}
              {field('in-weeks',    'Veckor / år',      'Weeks/year',  'weeksPerYear',  'num', 'v')}
              {field('in-holidays', 'Semester',         'Holiday',     'holidayWeeks',  'num', 'v')}
              {field('in-sick',     'Sjuk / VAB',       'Sick',        'sickWeeks',     'num', 'v')}
            </div>
            <div className="mini-readout">
              <div className="mini-stat">
                <span className="mini-stat-label">Debiterbara timmar</span>
                <span className="mini-stat-val">{formatWithSpaces(result.billableHours)}&nbsp;h</span>
              </div>
              <div className="mini-stat">
                <span className="mini-stat-label">Omsättning / år</span>
                <span className="mini-stat-val">{money(result.revenue)}</span>
              </div>
            </div>
          </div>

          <div className="section">
            <div className="section-label">
              <span className="section-num">2</span>
              <span className="section-title">Lön · Salary</span>
            </div>
            <p className="section-note">
              The gross salary you draw each month. <strong>Löneväxling</strong> swaps part
              of it into a pension premium (lower tax), so cash salary = gross − löneväxling.
            </p>
            <div className="field-grid">
              {field('in-gross',       'Bruttolön / mån',    'Gross/month', 'grossSalaryMonthly', 'cur', 'kr')}
              {field('in-lonevaxling', 'Löneväxling / mån',  'To pension',  'lonevaxlingMonthly', 'cur', 'kr')}
            </div>
          </div>

          <div className="section">
            <div className="section-label">
              <span className="section-num">3</span>
              <span className="section-title">Företagskostnader · Costs</span>
            </div>
            <p className="section-note">
              Accountant, insurance, work computer, phone — everything the company pays for
              besides your salary.
            </p>
            <div className="field-grid">
              {field('in-other', 'Övriga kostnader / mån', 'Other costs/month', 'otherCostMonthly', 'cur', 'kr', true)}
            </div>
          </div>

          <details className="section section-rates">
            <summary className="section-label section-label-summary">
              <span className="section-num">4</span>
              <span className="section-title">Skattesatser · Rates 2026</span>
              <span className="summary-caret" aria-hidden="true">▾</span>
            </summary>
            <p className="section-note">
              Pre-filled with the correct 2026 figures. Adjust your <strong>kommunalskatt</strong>
              to your municipality — the rest rarely change.
            </p>
            <div className="field-grid">
              {field('in-employerFee',       'Arbetsgivaravgift', 'Employer fee',   'employerFeePct',       'num', '%')}
              {field('in-sarskild',          'Särskild löneskatt','On pension',     'sarskildLoneskattPct', 'num', '%')}
              {field('in-corpTax',           'Bolagsskatt',       'Corporate',      'corporateTaxPct',      'num', '%')}
              {field('in-municipalTax',      'Kommunalskatt',     'Municipal',      'municipalTaxPct',      'num', '%')}
              {field('in-dividendAllowance', 'Gränsbelopp',       '3:12 allowance', 'dividendAllowance',    'cur', 'kr')}
              {field('in-dividendTax',       'Utdelningsskatt',   'Dividend tax',   'dividendTaxPct',       'num', '%')}
            </div>
          </details>

        </div>

        {/* ── LEDGER (right) ────────────────────────── */}
        <div className="ledger-col">

          <div className="hero-card">
            <div className="hero-label">Total nettoinkomst · in your pocket</div>
            <div className="hero-big">{money(result.totalNetIncome / 12)}</div>
            <div className="hero-sub">per month · <span>{money(result.totalNetIncome)}</span> per year</div>
            <div className="hero-split" role="img" aria-label="Salary vs dividend split">
              <span className="hero-seg hero-salary" style={{ width: `${salShare.toFixed(1)}%` }} />
              <span className="hero-seg hero-dividend" style={{ width: `${(100 - salShare).toFixed(1)}%` }} />
            </div>
            <div className="hero-legend">
              <span className="hero-key">
                <span className="hero-dot hero-salary" />
                Nettolön <em>{money(result.netSalary / 12)}</em>
              </span>
              <span className="hero-key">
                <span className="hero-dot hero-dividend" />
                Utdelning <em>{money(result.netDividend / 12)}</em>
              </span>
            </div>
            <div className="hero-stats">
              <div className="hero-stat">
                <span className="hero-stat-val">{pct0(result.takeHomeRate * 100)}</span>
                <span className="hero-stat-label">av omsättningen<br />to you</span>
              </div>
              <div className="hero-stat">
                <span className="hero-stat-val">{money(result.retainedProfit / 12)}</span>
                <span className="hero-stat-label">kvar i bolaget<br />retained/month</span>
              </div>
              <div className="hero-stat">
                <span className="hero-stat-val">{pct0(result.effectiveTaxRate * 100)}</span>
                <span className="hero-stat-label">effektiv skatt<br />effective tax</span>
              </div>
            </div>
          </div>

          <div className="ledger">
            <div className="ledger-head">
              <span className="ledger-head-item">Line item</span>
              <span className="ledger-head-num">Per månad</span>
              <span className="ledger-head-num">Per år</span>
            </div>

            <div className="ledger-group">Intäkter</div>
            <div className="lr lr-strong">
              <span className="lr-label">Omsättning <span className="lr-en">Revenue</span></span>
              <span className="lr-num">{money(result.revenue / 12)}</span>
              <span className="lr-num">{money(result.revenue)}</span>
            </div>

            <div className="ledger-group">Lön</div>
            <div className="lr">
              <span className="lr-label">Bruttolön <span className="lr-en">Gross salary</span></span>
              <span className="lr-num">{money(result.grossSalary / 12)}</span>
              <span className="lr-num">{money(result.grossSalary)}</span>
            </div>
            <div className="lr lr-minus">
              <span className="lr-label">Löneväxling <span className="lr-en">to pension</span></span>
              <span className="lr-num">{money(result.lonevaxling / 12)}</span>
              <span className="lr-num">{money(result.lonevaxling)}</span>
            </div>
            <div className="lr lr-sub">
              <span className="lr-label">Kontant lön <span className="lr-en">Cash salary</span></span>
              <span className="lr-num">{money(result.cashSalary / 12)}</span>
              <span className="lr-num">{money(result.cashSalary)}</span>
            </div>

            <div className="ledger-group">Företagets kostnader</div>
            <div className="lr">
              <span className="lr-label">Arbetsgivaravgift <span className="lr-en">{numStr(inputs.employerFeePct)}&nbsp;%</span></span>
              <span className="lr-num">{money(result.employerFee / 12)}</span>
              <span className="lr-num">{money(result.employerFee)}</span>
            </div>
            <div className="lr">
              <span className="lr-label">Särskild löneskatt <span className="lr-en">{numStr(inputs.sarskildLoneskattPct)}&nbsp;%</span></span>
              <span className="lr-num">{money(result.sarskildLoneskatt / 12)}</span>
              <span className="lr-num">{money(result.sarskildLoneskatt)}</span>
            </div>
            <div className="lr">
              <span className="lr-label">Övriga kostnader <span className="lr-en">Other costs</span></span>
              <span className="lr-num">{money(result.otherCost / 12)}</span>
              <span className="lr-num">{money(result.otherCost)}</span>
            </div>
            <div className="lr lr-sub">
              <span className="lr-label">Total lönekostnad <span className="lr-en">Total salary cost</span></span>
              <span className="lr-num">{money(result.totalSalaryCost / 12)}</span>
              <span className="lr-num">{money(result.totalSalaryCost)}</span>
            </div>

            <div className="ledger-group">Resultat &amp; bolagsskatt</div>
            <div className="lr lr-strong">
              <span className="lr-label">Resultat före skatt <span className="lr-en">Profit before tax</span></span>
              <span className="lr-num">{money(result.profitBeforeTax / 12)}</span>
              <span className="lr-num">{money(result.profitBeforeTax)}</span>
            </div>
            <div className="lr">
              <span className="lr-label">Bolagsskatt <span className="lr-en">{numStr(inputs.corporateTaxPct)}&nbsp;%</span></span>
              <span className="lr-num">{money(result.corporateTax / 12)}</span>
              <span className="lr-num">{money(result.corporateTax)}</span>
            </div>
            <div className="lr lr-sub">
              <span className="lr-label">Resultat efter skatt <span className="lr-en">Profit after tax</span></span>
              <span className="lr-num">{money(result.profitAfterTax / 12)}</span>
              <span className="lr-num">{money(result.profitAfterTax)}</span>
            </div>

            <div className="ledger-group">Utdelning · 3:12</div>
            <div className="lr">
              <span className="lr-label">Utdelning inom gränsbelopp <span className="lr-en">Dividend</span></span>
              <span className="lr-num">{money(result.dividend / 12)}</span>
              <span className="lr-num">{money(result.dividend)}</span>
            </div>
            <div className="lr">
              <span className="lr-label">Skatt på utdelning <span className="lr-en">{numStr(inputs.dividendTaxPct)}&nbsp;%</span></span>
              <span className="lr-num">{money(result.dividendTax / 12)}</span>
              <span className="lr-num">{money(result.dividendTax)}</span>
            </div>
            <div className="lr lr-sub lr-good">
              <span className="lr-label">Netto utdelning <span className="lr-en">Net dividend</span></span>
              <span className="lr-num">{money(result.netDividend / 12)}</span>
              <span className="lr-num">{money(result.netDividend)}</span>
            </div>
            <div className="lr lr-muted">
              <span className="lr-label">Kvar i bolaget <span className="lr-en">Retained profit</span></span>
              <span className="lr-num">{money(result.retainedProfit / 12)}</span>
              <span className="lr-num">{money(result.retainedProfit)}</span>
            </div>

            <div className="ledger-group">Lön till dig</div>
            <div className="lr">
              <span className="lr-label">Kommunalskatt <span className="lr-en">{numStr(inputs.municipalTaxPct)}&nbsp;%</span></span>
              <span className="lr-num">{money(result.municipalTax / 12)}</span>
              <span className="lr-num">{money(result.municipalTax)}</span>
            </div>
            <div className="lr">
              <span className="lr-label">Statlig skatt <span className="lr-en">State 20&nbsp;% over 643&nbsp;000</span></span>
              <span className="lr-num">{money(result.stateTax / 12)}</span>
              <span className="lr-num">{money(result.stateTax)}</span>
            </div>
            <div className="lr lr-plus">
              <span className="lr-label">Jobbskatteavdrag <span className="lr-en">Work tax credit</span></span>
              <span className="lr-num">{money(result.workTaxCredit / 12)}</span>
              <span className="lr-num">{money(result.workTaxCredit)}</span>
            </div>
            <div className="lr lr-sub lr-good">
              <span className="lr-label">Nettolön <span className="lr-en">Net salary</span></span>
              <span className="lr-num">{money(result.netSalary / 12)}</span>
              <span className="lr-num">{money(result.netSalary)}</span>
            </div>

            <div className="lr lr-total">
              <span className="lr-label">Total nettoinkomst <span className="lr-en">Net salary + dividend</span></span>
              <span className="lr-num">{money(result.totalNetIncome / 12)}</span>
              <span className="lr-num">{money(result.totalNetIncome)}</span>
            </div>
          </div>

          <p className="ledger-foot">
            Estimate for a single-owner AB, owner under 66, income year 2026. Uses the new
            unified 3:12 rule (grundbelopp 4&nbsp;×&nbsp;inkomstbasbelopp). Pension (löneväxling) is
            deducted from profit and carries särskild löneskatt. Not tax advice.
          </p>
        </div>
      </div>

      <div className="mobile-bar">
        <div className="mobile-bar-inner">
          <div className="mobile-stat">
            <span className="mobile-stat-label">Netto / mån</span>
            <span className="mobile-stat-val">{money(result.totalNetIncome / 12)}</span>
          </div>
          <div className="mobile-stat">
            <span className="mobile-stat-label">Av omsättning</span>
            <span className="mobile-stat-val">{pct0(result.takeHomeRate * 100)}</span>
          </div>
        </div>
      </div>
    </>
  )
}
