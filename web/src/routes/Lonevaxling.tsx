import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTheme } from '../App'
import {
  type LonevaxlingInputs,
  type LonevaxlingResult,
  computeLonevaxling,
  defaultInputs,
} from '../lib/lonevaxling'

const STORAGE_KEY = 'bostadskalkyl_lonevaxling_v1'

function loadInputs(): LonevaxlingInputs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Record<string, unknown>
      const d = defaultInputs()
      for (const k of Object.keys(d) as Array<keyof LonevaxlingInputs>) {
        if (typeof saved[k] === 'number' && isFinite(saved[k] as number))
          (d as unknown as Record<string, number>)[k] = saved[k] as number
      }
      return d
    }
  } catch { /* private mode */ }
  return defaultInputs()
}

function formatWithSpaces(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}
function parseFormatted(s: string): number {
  return parseFloat(s.replace(/[ \s]/g, '').replace(',', '.')) || 0
}
function curStr(n: number): string { return formatWithSpaces(n) }
function numStr(n: number): string { return (Math.round(n * 100) / 100).toString().replace('.', ',') }
function money(n: number): string { return formatWithSpaces(Math.round(n)) + ' kr' }
function pct0(x: number): string { return Math.round(x) + ' %' }
function signedPct0(x: number): string {
  return (x >= 0 ? '+' : '−') + Math.abs(Math.round(x)) + ' %'
}

function buildWarnings(r: LonevaxlingResult): Array<{ cls: string; text: string }> {
  const items: Array<{ cls: string; text: string }> = []
  const f = r.flags
  if (f.notEligible) {
    items.push({
      cls: 'warn-amber',
      text:
        `Din lön (${money(r.grossSalary / 12)}/mån) ligger under pensionstaket ` +
        `${money(r.ceilingMonthly)}/mån. Löneväxling minskar då din allmänna pension — växla helst inte.`,
    })
  } else if (f.overSacrificed) {
    items.push({
      cls: 'warn-amber',
      text:
        `Du växlar ner under pensionstaket. Sänk växlingen till ` +
        `${money(r.suggestedSacrifice)}/mån för att behålla full allmän pension.`,
    })
  } else {
    items.push({
      cls: 'warn-good',
      text: `Lönen efter växling håller sig över pensionstaket ${money(r.ceilingMonthly)}/mån.`,
    })
  }
  if (f.belowSgi) {
    items.push({
      cls: 'warn-amber',
      text:
        `Lönen efter växling understiger taket för sjuk- och föräldrapenning ` +
        `(${money(r.sgiCeilingMonthly)}/mån) — det kan sänka de ersättningarna.`,
    })
  }
  if (f.belowBrytpunkt) {
    items.push({
      cls: 'warn-info',
      text:
        `En del av växlingen ligger under brytpunkten (${money(r.brytpunktMonthly)}/mån) — ` +
        `där sparar du bara kommunalskatt, inte den statliga skatten på 20 %.`,
    })
  }
  if (f.withdrawalNotBelowMarginal) {
    items.push({
      cls: 'warn-amber',
      text:
        `Skatten vid uttag (${pct0(r.withdrawalRate * 100)}) är minst lika hög som din ` +
        `marginalskatt nu (${pct0(r.marginalRateNow * 100)}). Vinsten kommer då bara från ` +
        `uppräkningen, inte skatteskillnaden.`,
    })
  }
  return items
}

export default function Lonevaxling() {
  const { theme, toggleTheme } = useTheme()
  const [inputs, setInputs] = useState<LonevaxlingInputs>(loadInputs)
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
    document.title = 'Löneväxling — Hemma'
  }, [theme])

  const result = useMemo(() => computeLonevaxling(inputs), [inputs])

  function saveToStorage(inp: LonevaxlingInputs) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(inp)) } catch { /* private mode */ }
    setSaveVisible(true)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => setSaveVisible(false), 1400)
  }

  function handleChange(key: keyof LonevaxlingInputs, raw: string) {
    const next = { ...inputs, [key]: parseFormatted(raw) }
    setInputs(next)
    saveToStorage(next)
  }

  function handleBlur(
    e: React.FocusEvent<HTMLInputElement>,
    key: keyof LonevaxlingInputs,
    kind: 'cur' | 'num',
  ) {
    e.target.value = kind === 'cur' ? curStr(inputs[key]) : numStr(inputs[key])
  }

  function handleSuggest() {
    const suggested = Math.round(result.suggestedSacrifice)
    const next = { ...inputs, sacrificeMonthly: suggested }
    setInputs(next)
    setResetKey((k) => k + 1)
    saveToStorage(next)
  }

  function handleReset() {
    const next = defaultInputs()
    setInputs(next)
    setResetKey((k) => k + 1)
    saveToStorage(next)
  }

  function field(
    id: string,
    label: string,
    en: string,
    key: keyof LonevaxlingInputs,
    kind: 'cur' | 'num',
    unit: string,
    wide?: boolean,
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

  const warnings = buildWarnings(result)
  const spread = (result.marginalRateNow - result.withdrawalRate) * 100
  const spreadStr = (Math.round(Math.abs(spread) * 10) / 10).toString().replace('.', ',')
  const spreadFormatted = (spread >= 0 ? '+' : '−') + spreadStr + ' pp'

  return (
    <>
      <div className="page-header">
        <div className="header-brand">
          <Link className="hub-link" to="/">‹ Hemma</Link>
          <div>
            <h1>Löneväxling</h1>
            <p className="tagline">Is it worth swapping salary for pension — and how much? Sweden, 2026</p>
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
          <button className="btn btn-ghost" title="Reset to the example" onClick={handleReset}>
            Reset
          </button>
        </div>
      </div>

      <div className="konsult-layout">
        {/* ── INPUTS (left rail) ───────────────────────────────── */}
        <div className="inputs-col">

          <div className="section">
            <div className="section-label">
              <span className="section-num">1</span>
              <span className="section-title">Lön · Salary</span>
            </div>
            <p className="section-note">
              Your monthly gross salary, and how much of it you want to{' '}
              <strong>löneväxla</strong> — swap into a pension premium each month.
            </p>
            <div className="field-grid">
              {field('in-gross', 'Bruttolön / mån', 'Gross/month', 'grossSalaryMonthly', 'cur', 'kr')}
              {field('in-sacrifice', 'Löneväxling / mån', 'Sacrifice', 'sacrificeMonthly', 'cur', 'kr')}
            </div>
            <button className="btn btn-suggest" type="button" onClick={handleSuggest}>
              Föreslå optimalt belopp ✦
            </button>
            <div className="mini-readout">
              <div className="mini-stat">
                <span className="mini-stat-label">Pensionstak / mån</span>
                <span className="mini-stat-val">{money(result.ceilingMonthly)}</span>
              </div>
              <div className="mini-stat">
                <span className="mini-stat-label">Växla max utan att tappa pension</span>
                <span className="mini-stat-val">{money(result.maxSafeSacrifice)}/mån</span>
              </div>
            </div>
          </div>

          <div className="section">
            <div className="section-label">
              <span className="section-num">2</span>
              <span className="section-title">Pension &amp; uttag · Payout</span>
            </div>
            <p className="section-note">
              The employer swaps 31,42{' '}% arbetsgivaravgift for 24,26{' '}% löneskatt — a{' '}
              <strong>~5,76{' '}% uppräkning</strong> good employers add to your premium. Tax at
              withdrawal is usually your future kommunalskatt as a pensioner.
            </p>
            <div className="field-grid">
              {field('in-uplift', 'Uppräkning', 'Employer uplift', 'upliftPct', 'num', '%')}
              {field('in-withdrawalTax', 'Skatt vid uttag', 'At payout', 'withdrawalTaxPct', 'num', '%')}
            </div>
          </div>

          <details className="section section-rates">
            <summary className="section-label section-label-summary">
              <span className="section-num">3</span>
              <span className="section-title">Skattesats · Rate 2026</span>
              <span className="summary-caret" aria-hidden="true">▾</span>
            </summary>
            <p className="section-note">
              Set your <strong>kommunalskatt</strong> to your municipality. The state tax
              (20{' '}% over the 643{' '}000{' '}kr brytpunkt) is fixed for 2026.
            </p>
            <div className="field-grid">
              {field('in-municipalTax', 'Kommunalskatt', 'Municipal', 'municipalTaxPct', 'num', '%')}
            </div>
          </details>

        </div>

        {/* ── LEDGER (right) ───────────────────────────────────── */}
        <div className="ledger-col">

          <div className="hero-card">
            <div className={`verdict ${result.eligible ? 'verdict-good' : 'verdict-warn'}`}>
              <span className="verdict-icon">{result.eligible ? '✓' : '⚠'}</span>
              <span>
                {result.eligible
                  ? `Du är över pensionstaket — du kan växla upp till ${money(result.maxSafeSacrifice)}/mån.`
                  : `Du behöver tjäna minst ${money(result.ceilingMonthly)}/mån innan löneväxling lönar sig.`}
              </span>
            </div>
            <div className="hero-label">Hävstång · what you give up vs get</div>
            <div className="hero-big">{result.leverage > 0 ? signedPct0(result.leveragePct) : '—'}</div>
            <div className="hero-sub">
              {result.netGivenUp > 0
                ? <>
                    Du avstår {money(result.netGivenUp / 12)} netto/mån och får{' '}
                    {money(result.netPensionValue / 12)} (efter skatt) till pension —{' '}
                    en nettovinst på {money(result.netBenefit)}/år i dagens kronor.
                  </>
                : 'Ange en löneväxling för att se hävstången.'}
            </div>
            <div className="hero-flow">
              <div className="flow-stat flow-give">
                <span className="flow-label">Du avstår netto/mån</span>
                <span className="flow-val">{money(result.netGivenUp / 12)}</span>
              </div>
              <span className="flow-arrow" aria-hidden="true">→</span>
              <div className="flow-stat flow-get">
                <span className="flow-label">Till pension netto/mån</span>
                <span className="flow-val">{money(result.netPensionValue / 12)}</span>
              </div>
            </div>
          </div>

          <div className="ledger">
            <div className="ledger-head">
              <span className="ledger-head-item">Line item</span>
              <span className="ledger-head-num">Per månad</span>
              <span className="ledger-head-num">Per år</span>
            </div>

            <div className="ledger-group">Nu · varje månad</div>
            <div className="lr lr-strong">
              <span className="lr-label">Löneväxling <span className="lr-en">Gross sacrificed</span></span>
              <span className="lr-num">{money(result.sacrifice / 12)}</span>
              <span className="lr-num">{money(result.sacrifice)}</span>
            </div>
            <div className="lr lr-minus">
              <span className="lr-label">Nettolön du avstår <span className="lr-en">Net salary given up</span></span>
              <span className="lr-num">{money(result.netGivenUp / 12)}</span>
              <span className="lr-num">{money(result.netGivenUp)}</span>
            </div>
            <div className="lr lr-plus">
              <span className="lr-label">Skatt du slipper nu <span className="lr-en">Tax saved now</span></span>
              <span className="lr-num">{money(result.taxSavedNow / 12)}</span>
              <span className="lr-num">{money(result.taxSavedNow)}</span>
            </div>
            <div className="lr lr-rate">
              <span className="lr-label">Marginalskatt nu <span className="lr-en">Marginal rate</span></span>
              <span className="lr-num lr-num-wide">{pct0(result.marginalRateNow * 100)}</span>
            </div>

            <div className="ledger-group">Till pensionen</div>
            <div className="lr">
              <span className="lr-label">Premie till pension <span className="lr-en">incl. uplift</span></span>
              <span className="lr-num">{money(result.premiumToPension / 12)}</span>
              <span className="lr-num">{money(result.premiumToPension)}</span>
            </div>
            <div className="lr lr-muted">
              <span className="lr-label">varav uppräkning <span className="lr-en">Employer uplift</span></span>
              <span className="lr-num">{money(result.upliftAmount / 12)}</span>
              <span className="lr-num">{money(result.upliftAmount)}</span>
            </div>

            <div className="ledger-group">Vid uttag · today's kronor</div>
            <div className="lr lr-rate">
              <span className="lr-label">Skatt vid uttag <span className="lr-en">Withdrawal tax</span></span>
              <span className="lr-num lr-num-wide">{pct0(result.withdrawalRate * 100)}</span>
            </div>
            <div className="lr lr-rate">
              <span className="lr-label">Skatteskillnad <span className="lr-en">Marginal now − payout</span></span>
              <span className="lr-num lr-num-wide">{spreadFormatted}</span>
            </div>
            <div className="lr lr-sub lr-good">
              <span className="lr-label">Netto till pension <span className="lr-en">Net pension value</span></span>
              <span className="lr-num">{money(result.netPensionValue / 12)}</span>
              <span className="lr-num">{money(result.netPensionValue)}</span>
            </div>
            <div className="lr lr-total">
              <span className="lr-label">Nettovinst vs kontant lön <span className="lr-en">Net gain, today's kronor</span></span>
              <span className="lr-num">{money(result.netBenefit / 12)}</span>
              <span className="lr-num">{money(result.netBenefit)}</span>
            </div>
          </div>

          <div className="warn-card">
            <div className="warn-card-label">Att tänka på · before you decide</div>
            <ul className="warn-list">
              {warnings.map((w, i) => (
                <li key={i} className={`warn-item ${w.cls}`}>
                  <span className="warn-dot" />
                  <span className="warn-text">{w.text}</span>
                </li>
              ))}
            </ul>
          </div>

          <p className="ledger-foot">
            Estimate for an employee under 66, income year 2026. The eligibility floor is the
            income-pension ceiling (8,07 × inkomstbasbelopp ÷ 12 ≈ 56{' '}087{' '}kr/mån).
            "Vid uttag" figures are in today's kronor — no investment growth is assumed. Not tax advice.
          </p>

        </div>
      </div>

      <div className="mobile-bar">
        <div className="mobile-bar-inner">
          <div className="mobile-stat">
            <span className="mobile-stat-label">Avstår netto/mån</span>
            <span className="mobile-stat-val">{money(result.netGivenUp / 12)}</span>
          </div>
          <div className="mobile-stat">
            <span className="mobile-stat-label">Hävstång</span>
            <span className="mobile-stat-val">
              {result.leverage > 0 ? signedPct0(result.leveragePct) : '—'}
            </span>
          </div>
        </div>
      </div>
    </>
  )
}
