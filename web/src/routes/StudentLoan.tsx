import { useEffect, useLayoutEffect, useMemo, useState, type CSSProperties } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import {
  computeStudentLoan,
  defaultStudentLoanInputs,
  type StudentLoanInputs,
} from '../lib/studentloan'
import * as studentLoanStore from '../lib/studentloan-store'
import { Money, Num } from '../components/AnimatedNumber'
import ExpandableChartCard from '../components/charts/ExpandableChartCard'
import ChartLegend from '../components/charts/ChartLegend'
import StudentLoanChart from '../components/charts/StudentLoanChart'
import { useTheme } from '../App'
import { useToolPageActive } from '../lib/toolTransition'
import { parseFormatted } from '../lib/format'
import Collapse from '../components/Collapse'
import PageHeader from '../components/PageHeader'
import ThemeToggle from '../components/ThemeToggle'
import { useSaveFlash } from '../components/useSaveFlash'
import { reportPersistenceError } from '../lib/persistence-error'

// NOTE: uses U+00A0 no-break space so amounts don't wrap mid-number; no
// Math.round in the helper — every call site pre-rounds. Comma decimals kept
// for consistency with the app's other numeric inputs even though this
// route's copy is English (the UK-loan exception to the Swedish-copy rule).
function formatWithSpaces(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}
function curStr(n: number): string {
  return formatWithSpaces(Math.round(n))
}
function numStr(n: number): string {
  return (Math.round(n * 100) / 100).toString().replace('.', ',')
}
function yearStr(n: number): string {
  return Math.round(n).toString()
}
function gbp(n: number, rollIn?: boolean) {
  return <Money value={n} currencySuffix="£" rollIn={rollIn} />
}
function sek(n: number, rollIn?: boolean) {
  return <Money value={n} rollIn={rollIn} />
}

type FieldKind = 'gbp' | 'sek' | 'num' | 'year'

// All the plain-number fields — excludes the boolean toggle and the optional
// SLC sanity-check figure, which get their own handlers (mixed value types on
// StudentLoanInputs would otherwise widen a generic-key computed assignment
// past what the interface allows).
type NumericInputKey = Exclude<keyof StudentLoanInputs, 'hold_threshold_flat' | 'slc_monthly_gbp'>

const RATE_STRESS_MIN = 0
const RATE_STRESS_MAX = 5

interface HydratedTextInputProps {
  id: string
  display: string
  disabled: boolean
  placeholder?: string
  onChange: (value: string) => void
}

// The persisted model is numeric, but the editing buffer deliberately remains
// text. This keeps partially typed values such as `3.` visible until blur while
// still letting a completed external hydrate replace every unfocused field.
function HydratedTextInput({ id, display, disabled, placeholder, onChange }: HydratedTextInputProps) {
  const [editing, setEditing] = useState(false)
  const [buffer, setBuffer] = useState('')

  return (
    <input
      type="text"
      id={id}
      inputMode="decimal"
      autoComplete="off"
      disabled={disabled}
      placeholder={placeholder}
      value={editing ? buffer : display}
      onFocus={() => {
        setBuffer(display)
        setEditing(true)
      }}
      onChange={(e) => {
        const next = e.target.value
        setBuffer(next)
        onChange(next)
      }}
      onBlur={() => setEditing(false)}
    />
  )
}

export default function StudentLoan() {
  const { theme } = useTheme()
  const active = useToolPageActive('/student-loan')
  const [inputs, setInputs] = useState<StudentLoanInputs>(defaultStudentLoanInputs)
  const [hydrated, setHydrated] = useState(false)

  // Load persisted inputs once on mount (async — localStorage today, cloud
  // after the swap). Saves are imperative (in the handlers), so there's no
  // save-on-change effect to race with this hydrate.
  useEffect(() => {
    let alive = true
    void studentLoanStore.load().then(
      (saved) => {
        if (!alive) return
        if (saved) setInputs(saved)
        setHydrated(true)
      },
      () => { if (alive) setHydrated(true) },
    )
    return () => { alive = false }
  }, [])

  const { saveVisible, flashSaved } = useSaveFlash()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const reduceMotion = useReducedMotion()

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
    document.title = 'Student Loan — Hemma·OS'
  }, [theme])

  const result = useMemo(() => computeStudentLoan(inputs), [inputs])

  function saveToStorage(next: StudentLoanInputs) {
    void studentLoanStore.save(next).then(flashSaved).catch(reportPersistenceError)
  }

  function handleChange(key: NumericInputKey, value: string) {
    const parsed = parseFormatted(value)
    const next = { ...inputs, [key]: parsed }
    setInputs(next)
    saveToStorage(next)
  }

  function handleSlcChange(value: string) {
    const trimmed = value.trim()
    const next = { ...inputs, slc_monthly_gbp: trimmed === '' ? undefined : parseFormatted(value) }
    setInputs(next)
    saveToStorage(next)
  }

  function handleToggleFlat(checked: boolean) {
    const next = { ...inputs, hold_threshold_flat: checked }
    setInputs(next)
    saveToStorage(next)
  }

  function handleRateStress(value: number) {
    const next = { ...inputs, rate_stress: value }
    setInputs(next)
    saveToStorage(next)
  }

  function handleReset() {
    const d = defaultStudentLoanInputs()
    setInputs(d)
    saveToStorage(d)
  }

  function field(
    id: string,
    label: string,
    key: NumericInputKey,
    kind: FieldKind,
    unit: string,
    wide = false,
  ) {
    const v = inputs[key]
    const display = kind === 'gbp' || kind === 'sek' ? curStr(v) : kind === 'year' ? yearStr(v) : numStr(v)
    return (
      <div className={`field${wide ? ' field-wide' : ''}`} key={id}>
        <label htmlFor={id}>{label}</label>
        <div className="input-wrap">
          <HydratedTextInput
            id={id}
            display={hydrated ? display : ''}
            disabled={!hydrated}
            placeholder={hydrated ? undefined : 'Loading…'}
            onChange={(value) => handleChange(key, value)}
          />
          <span className="unit">{unit}</span>
        </div>
      </div>
    )
  }

  const stressFill = (((inputs.rate_stress - RATE_STRESS_MIN) / (RATE_STRESS_MAX - RATE_STRESS_MIN)) * 100).toFixed(1) + '%'
  const effectiveRate = inputs.interest_rate + inputs.rate_stress

  const verdictText = (() => {
    if (result.recommendation === 'never') {
      return (
        <>
          Don't pay it off — written off <strong>{result.writeoff_year}</strong>. Clearing it now would waste{' '}
          {gbp(result.savings_gbp)} ({sek(result.savings_sek)}) in present-value terms.
        </>
      )
    }
    if (result.recommendation === 'pay_now') {
      return (
        <>
          Clear it now — you'll pay it off before write-off, saving {gbp(result.savings_gbp)} ({sek(result.savings_sek)}
          ) versus riding it out.
        </>
      )
    }
    return (
      <>
        Clear it in <strong>{result.optimal_year}</strong> — saving {gbp(result.savings_gbp)} ({sek(result.savings_sek)}
        ) versus riding it out to write-off in {result.writeoff_year}.
      </>
    )
  })()

  const heroLabel =
    result.recommendation === 'never' ? "Don't pay off — at stake" : 'Pay off — savings at stake'

  const showPvNominalInsight = result.nominal_winner !== result.recommendation
  const nominalWinnerLabel: Record<typeof result.nominal_winner, string> = {
    never: 'riding it out',
    pay_now: 'paying off now',
    pay_at: 'paying off at a later date',
  }
  const recommendationLabel: Record<typeof result.recommendation, string> = {
    never: 'riding it out',
    pay_now: 'paying off now',
    pay_at: 'paying off at the optimal date',
  }

  return (
    <div className={'sl-root' + (active ? ' vt-page' : '')}>
      <PageHeader
        backTo="/student-loan"
        title="Student Loan"
        tagline="When, if ever, is it worth clearing your UK Plan 1 loan? — Sweden overseas repayment"
        saveVisible={saveVisible}
        actions={<>
          <ThemeToggle />
          <button className="btn btn-ghost" onClick={handleReset} disabled={!hydrated}>Reset</button>
        </>}
      />

      <div className="konsult-layout">

        {/* ── INPUTS (left rail) ─────────────────────── */}
        <div className="inputs-col">

          <div className="section">
            <div className="section-label">
              <span className="section-num">1</span>
              <span className="section-title">Loan</span>
            </div>
            <div className="field-grid">
              {field('in-balance', 'Current balance', 'balance_gbp', 'gbp', '£')}
              {field('in-firstdue', 'First due (April)', 'first_due_year', 'year', 'yr')}
              {field('in-rate', 'Base interest rate', 'interest_rate', 'num', '%')}
            </div>
            <div className="mini-readout">
              <div className="mini-stat">
                <span className="mini-stat-label">Written off</span>
                <span className="mini-stat-val">{hydrated ? <Num value={result.writeoff_year} /> : '—'}</span>
              </div>
              <div className="mini-stat">
                <span className="mini-stat-label">Effective rate</span>
                <span className="mini-stat-val">{hydrated ? <>{numStr(effectiveRate)}&nbsp;%</> : '—'}</span>
              </div>
            </div>
          </div>

          <div className="section">
            <div className="section-label">
              <span className="section-num">2</span>
              <span className="section-title">Interest rate stress test</span>
            </div>
            <p className="section-note">
              Plan 1 interest is the lower of RPI or (BoE base + 1{' '}%). Stress-test a higher rate on top of
              the base rate above.
            </p>
            <div className="stress-slider-wrap">
              <div className="stress-slider-header">
                <span className="stress-slider-label">Rate stress</span>
                <span className="stress-slider-rate">+{inputs.rate_stress.toFixed(2)}%</span>
              </div>
              <input
                type="range"
                className="stress-slider-input"
                min={RATE_STRESS_MIN}
                max={RATE_STRESS_MAX}
                step={0.05}
                value={inputs.rate_stress}
                disabled={!hydrated}
                style={{ '--fill': stressFill } as CSSProperties}
                onChange={(e) => handleRateStress(parseFloat(e.target.value))}
                aria-label="Interest rate stress"
              />
              <div className="stress-slider-bounds">
                <span>{RATE_STRESS_MIN}%</span>
                <span>{RATE_STRESS_MAX}%</span>
              </div>
            </div>
          </div>

          <div className="section">
            <div className="section-label">
              <span className="section-num">3</span>
              <span className="section-title">Income &amp; FX</span>
            </div>
            <p className="section-note">
              Overseas repayment is assessed on GBP income against a Sweden-adjusted threshold. The projection
              assumes a <strong>flat FX rate</strong> — SEK weakening would raise the true GBP cost of riding it out.
            </p>
            <div className="field-grid">
              {field('in-income', 'Gross income', 'income_sek', 'sek', 'kr/yr')}
              {field('in-fx', 'FX rate', 'fx_sek_per_gbp', 'num', 'kr/£')}
              {field('in-growth', 'Salary growth', 'salary_growth_pct', 'num', '%/yr')}
            </div>
            <div className="mini-readout">
              <div className="mini-stat">
                <span className="mini-stat-label">Income in £</span>
                <span className="mini-stat-val">{hydrated ? gbp(result.income_gbp) : '—'}</span>
              </div>
              <div className="mini-stat">
                <span className="mini-stat-label">Mandated monthly</span>
                <span className="mini-stat-val">{hydrated ? gbp(result.monthly_repayment_gbp) : '—'}</span>
              </div>
            </div>
          </div>

          <div className="section">
            <div className="section-label">
              <span className="section-num">4</span>
              <span className="section-title">Sweden overseas threshold</span>
            </div>
            <p className="section-note">
              SLC sets this per country, yearly — verify the exact figure on your own overseas income-assessment
              letter.
            </p>
            <div className="field-grid">
              {field('in-threshold', 'Threshold', 'se_threshold_gbp', 'gbp', '£/yr')}
            </div>
            <div className="toggle-row">
              <span className="toggle-row-label">Hold threshold flat <span className="toggle-row-sub">(pessimistic — normally it uprates with salary)</span></span>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={inputs.hold_threshold_flat}
                  disabled={!hydrated}
                  onChange={(e) => handleToggleFlat(e.target.checked)}
                  aria-label="Hold Sweden threshold flat instead of growing with salary"
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>

          <div className={'section section-rates' + (advancedOpen ? ' is-open' : '')}>
            <button type="button" className="section-label section-label-summary rates-toggle" aria-expanded={advancedOpen} disabled={!hydrated} onClick={() => setAdvancedOpen(v => !v)}>
              <span className="section-num">5</span>
              <span className="section-title">Advanced</span>
              <motion.span
                className="summary-caret"
                aria-hidden="true"
                animate={{ rotate: advancedOpen ? 180 : 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.2 }}
              >▾</motion.span>
            </button>
            <Collapse open={advancedOpen}>
              <p className="section-note">
                The opportunity rate discounts future repayments to present value — what a lump sum would earn
                instead (savings, investments, mortgage offset). Optionally enter the fixed monthly figure from your
                SLC assessment letter for a sanity check against the model.
              </p>
              <div className="field-grid">
                {field('in-opportunity', 'Opportunity rate', 'opportunity_rate_pct', 'num', '%')}
                <div className="field" key="in-slc">
                  <label htmlFor="in-slc">SLC letter monthly (optional)</label>
                  <div className="input-wrap">
                    <HydratedTextInput
                      id="in-slc"
                      display={hydrated && inputs.slc_monthly_gbp != null ? curStr(inputs.slc_monthly_gbp) : ''}
                      disabled={!hydrated}
                      placeholder={hydrated ? '—' : 'Loading…'}
                      onChange={handleSlcChange}
                    />
                    <span className="unit">£/mo</span>
                  </div>
                </div>
              </div>
            </Collapse>
          </div>

        </div>

        {/* ── VERDICT + CHART (right) ───────────────── */}
        <div className="ledger-col">
          {!hydrated ? (
            <div className="hero-card" style={{ minHeight: 340 }} role="status">Loading saved loan…</div>
          ) : <>
          <div className="hero-card">
            <div className={`verdict ${result.recommendation === 'never' ? 'verdict-good' : 'verdict-warn'}`}>
              <span className="verdict-icon">{result.recommendation === 'never' ? '✓' : '⚠'}</span>
              <span>{verdictText}</span>
            </div>
            <div className="hero-label">{heroLabel}</div>
            <div className="hero-big">{gbp(result.savings_gbp, true)}</div>
            <div className="hero-sub"><span>{sek(result.savings_sek)}</span> present value</div>

            <div className="hero-stats">
              <div className="hero-stat">
                <span className="hero-stat-val">{gbp(result.ride_it_out.nominal_gbp)}</span>
                <span className="hero-stat-label">Ride it out<br />nominal total</span>
              </div>
              <div className="hero-stat">
                <span className="hero-stat-val">{gbp(result.pay_off_now.nominal_gbp)}</span>
                <span className="hero-stat-label">Pay off now<br />nominal total</span>
              </div>
              <div className="hero-stat">
                <span className="hero-stat-val">
                  {result.pay_off_at_optimal.payoff_year ?? '—'}
                </span>
                <span className="hero-stat-label">Optimal payoff<br />year</span>
              </div>
            </div>

            {showPvNominalInsight && (
              <p className="sl-insight">
                Comparing nominal totals alone would favour <strong>{nominalWinnerLabel[result.nominal_winner]}</strong>
                {' '}— but discounted to today's money, <strong>{recommendationLabel[result.recommendation]}</strong>{' '}
                actually costs less. Later pounds are cheaper than today's, which is why the verdict runs on present
                value, not the raw nominal sum.
              </p>
            )}

            {inputs.slc_monthly_gbp != null && (
              <p className="sl-sanity">
                Model predicts {gbp(result.monthly_repayment_gbp)}/mo · your SLC letter says {gbp(inputs.slc_monthly_gbp)}/mo
                {Math.abs(result.monthly_repayment_gbp - inputs.slc_monthly_gbp) > inputs.slc_monthly_gbp * 0.15
                  ? ' — that gap is large; double-check the threshold and income inputs above.'
                  : '.'}
              </p>
            )}
          </div>

          <ExpandableChartCard
            title="Balance over time"
            subtitle="Ride it out vs pay off now vs pay off at the optimal date · write-off year marked"
            preview={<StudentLoanChart inputs={inputs} result={result} compact />}
          >
            <div className="chart-overlay-chart">
              <StudentLoanChart inputs={inputs} result={result} />
            </div>
            <ChartLegend
              items={[
                { label: 'Ride it out', token: 'accent' },
                { label: 'Pay off now', token: 'warn', dashed: true },
                { label: 'Pay off at optimal date', token: 'accentLight', dashed: true },
              ]}
            />
          </ExpandableChartCard>

          <div className="ledger">
            <div className="ledger-head">
              <span className="ledger-head-item">Strategy</span>
              <span className="ledger-head-num">Nominal</span>
              <span className="ledger-head-num">Present value</span>
            </div>

            <div className="lr">
              <span className="lr-label">Ride it out <span className="lr-en">{result.outcome === 'written_off' ? 'written off' : 'clears naturally'}</span></span>
              <span className="lr-num">{gbp(result.ride_it_out.nominal_gbp)}</span>
              <span className="lr-num">{gbp(result.ride_it_out.pv_gbp)}</span>
            </div>
            <div className="lr">
              <span className="lr-label">Pay off now</span>
              <span className="lr-num">{gbp(result.pay_off_now.nominal_gbp)}</span>
              <span className="lr-num">{gbp(result.pay_off_now.pv_gbp)}</span>
            </div>
            <div className={'lr' + (result.recommendation !== 'never' ? ' lr-sub lr-good' : '')}>
              <span className="lr-label">
                Pay off at optimal date{' '}
                <span className="lr-en">{result.pay_off_at_optimal.payoff_year ?? '—'}</span>
              </span>
              <span className="lr-num">{gbp(result.pay_off_at_optimal.nominal_gbp)}</span>
              <span className="lr-num">{gbp(result.pay_off_at_optimal.pv_gbp)}</span>
            </div>
          </div>

          <p className="ledger-foot">
            UK Plan 1 (Post-2006, England/Wales), overseas Sweden-resident repayment. Write-off = first due
            (April) + 25 years, no age-65 path. FX rate held flat for the projection. Not financial advice.
          </p>
          </>}
        </div>
      </div>

      <div className="mobile-bar">
        <div className="mobile-bar-inner">
          <div className="mobile-stat">
            <span className="mobile-stat-label">{hydrated ? heroLabel : 'Loading saved loan…'}</span>
            <span className="mobile-stat-val">{hydrated ? gbp(result.savings_gbp) : '—'}</span>
          </div>
          <div className="mobile-stat">
            <span className="mobile-stat-label">Written off</span>
            <span className="mobile-stat-val">{hydrated ? <Num value={result.writeoff_year} /> : '—'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
