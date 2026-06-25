import { useEffect, useState, type CSSProperties } from 'react'
import { stressAt, FASTIGHETSAVGIFT_CAP, type Inputs, type Figures, type BankFigures } from '../lib/calc'
import { fmt } from '../lib/format'
import { CurrencyInput, NumberInput, Field, DerivedRow } from './fields'
import { Money } from './AnimatedNumber'
import ExpandableChartCard from './charts/ExpandableChartCard'
import ChartLegend from './charts/ChartLegend'
import StressChart from './charts/StressChart'

interface Props {
  inputs: Inputs
  setField: <K extends keyof Inputs>(key: K, value: Inputs[K]) => void
  figures: Figures
  onOpenDrift: () => void
}

export default function InputsColumn({ inputs: i, setField, figures: f, onOpenDrift }: Props) {
  const [listingUrl, setListingUrl] = useState('')

  const bankAName = i.bankAName.trim() || 'Bank A'
  const bankBName = i.bankBName.trim() || 'Bank B'
  const diff = f.bankDiff
  const diffText =
    diff > 0
      ? `${bankBName} is cheaper by ${fmt(Math.abs(diff))}/mo`
      : diff < 0
        ? `${bankAName} is cheaper by ${fmt(Math.abs(diff))}/mo`
        : 'Same cost'

  const openListing = () => {
    const u = listingUrl.trim()
    if (u) window.open(u.startsWith('http') ? u : 'https://' + u, '_blank', 'noopener')
  }

  const overCap = i.propertyTax > FASTIGHETSAVGIFT_CAP

  return (
    <div className="inputs-col">
      {/* Section 1 — selling */}
      <div className="section">
        <div className="section-label">
          <span className="section-num">1</span>
          <span className="section-title">Selling your current property</span>
        </div>
        <div className="field-grid">
          <Field label="Sale price (prospective)">
            <CurrencyInput value={i.salePrice} onChange={(v) => setField('salePrice', v)} id="salePrice" ariaLabel="Sale price" />
          </Field>
          <Field label="Current mortgage balance">
            <CurrencyInput value={i.currentMortgage} onChange={(v) => setField('currentMortgage', v)} id="currentMortgage" ariaLabel="Current mortgage balance" />
          </Field>
          <Field label="Agent / selling cost">
            <CurrencyInput value={i.agentCost} onChange={(v) => setField('agentCost', v)} id="agentCost" ariaLabel="Agent cost" />
          </Field>
          <Field label="Moving cost">
            <CurrencyInput value={i.movingCost} onChange={(v) => setField('movingCost', v)} id="movingCost" ariaLabel="Moving cost" />
          </Field>
          <Field label="Current mortgage remaining term">
            <NumberInput value={i.currentTerm} onChange={(v) => setField('currentTerm', v)} suffix="yrs" min={1} max={100} step={1} id="currentTerm" ariaLabel="Current term" />
          </Field>
          <Field label="Current amortisation rate">
            <NumberInput value={i.currentAmortRate} onChange={(v) => setField('currentAmortRate', v)} suffix="%" min={0} max={10} step={0.1} id="currentAmortRate" ariaLabel="Current amortisation rate" />
          </Field>
        </div>
        <div className="derived-box">
          <DerivedRow label="Total takeaway (sale − mortgage)" value={<Money value={f.totalTakeaway} />} cls={f.totalTakeaway >= 0 ? 'positive' : 'negative'} />
          <DerivedRow label="Net proceeds (after agent & moving)" value={<Money value={f.netProceeds} />} cls={f.netProceeds >= 0 ? 'positive' : 'negative'} />
        </div>
      </div>

      {/* Section 2 — buying */}
      <div className="section">
        <div className="section-label">
          <span className="section-num">2</span>
          <span className="section-title">Buying your new property</span>
        </div>
        <div className="field-grid">
          <Field label="New property price">
            <CurrencyInput value={i.newPrice} onChange={(v) => setField('newPrice', v)} id="newPrice" ariaLabel="New property price" />
          </Field>
          <Field label="Deposit" hint={`${f.depositPct.toFixed(1)}% of purchase price`}>
            <CurrencyInput value={i.deposit} onChange={(v) => setField('deposit', v)} id="deposit" ariaLabel="Deposit" />
          </Field>
          <Field label="Current total pantbrev held" hint="Pantbrev already registered on property">
            <CurrencyInput value={i.existingPantbrev} onChange={(v) => setField('existingPantbrev', v)} id="existingPantbrev" ariaLabel="Existing pantbrev" />
          </Field>
          <Field label="Property listing URL" spanAll>
            <div className="listing-row">
              <input type="text" value={listingUrl} onChange={(e) => setListingUrl(e.target.value)} placeholder="https://www.hemnet.se/bostad/…" aria-label="Listing URL" />
              <button className="btn btn-ghost" onClick={openListing}>Open ›</button>
            </div>
          </Field>
        </div>
        <div className="derived-box">
          <DerivedRow label="Loan amount (price − deposit)" value={<Money value={f.loanAmount} />} />
          <DerivedRow label="Lagfart (1.5% of purchase price)" value={<Money value={f.lagfart} />} />
          <DerivedRow label="New pantbrev needed (loan − existing)" value={<Money value={f.newPantbrevNeeded} />} />
          <DerivedRow label="New pantbrev cost (2% of new amount)" value={<Money value={f.pantbrevCost} />} />
          <DerivedRow rowClass="derived-total" label="Total upfront cash needed" value={<Money value={f.totalUpfront} />} />
          <DerivedRow
            label={<span style={{ fontWeight: 550, color: 'var(--ink)' }}>Cash surplus / shortfall</span>}
            value={<Money value={f.cashBalance} signed />}
            cls={f.cashBalance >= 0 ? 'positive' : 'negative'}
          />
        </div>
      </div>

      {/* Section 3 — monthly costs */}
      <div className="section">
        <div className="section-label">
          <span className="section-num">3</span>
          <span className="section-title">Monthly costs</span>
        </div>
        <div className="field-grid" style={{ marginBottom: '1.25rem' }}>
          <Field label="Amortisation rate" hint="Annual % of loan repaid each year">
            <NumberInput value={i.amortRate} onChange={(v) => setField('amortRate', v)} suffix="%" min={0} max={10} step={0.1} id="amortRate" ariaLabel="Amortisation rate" />
          </Field>
          <Field
            label="Property tax (fastighetsavgift)"
            hint={overCap ? `Above the 2025 cap — houses pay max ${fmt(FASTIGHETSAVGIFT_CAP)}/yr` : `Capped at ${fmt(FASTIGHETSAVGIFT_CAP)}/yr (2025)`}
            hintWarn={overCap}
          >
            <CurrencyInput value={i.propertyTax} onChange={(v) => setField('propertyTax', v)} suffix="kr/yr" id="propertyTax" ariaLabel="Property tax" />
          </Field>
          <Field label="Driftkostnad (running costs)">
            <CurrencyInput value={i.driftkostnad} onChange={(v) => setField('driftkostnad', v)} suffix="kr/mo" id="driftkostnad" ariaLabel="Driftkostnad" />
            <button type="button" className="field-breakdown-btn" onClick={onOpenDrift}>
              Itemise breakdown ›
            </button>
          </Field>
        </div>

        <div className="bank-compare">
          <BankCol name={i.bankAName} onName={(v) => setField('bankAName', v)} rate={i.interestRateA} onRate={(v) => setField('interestRateA', v)} bank={f.bankA} idSuffix="A" />
          <div className="bank-divider" />
          <BankCol name={i.bankBName} onName={(v) => setField('bankBName', v)} rate={i.interestRateB} onRate={(v) => setField('interestRateB', v)} bank={f.bankB} idSuffix="B" />
        </div>
        <div className="bank-diff-row">
          <span className="derived-label">Difference ({bankAName} vs {bankBName})</span>
          <span className={diff !== 0 ? 'derived-value positive' : 'derived-value'}>{diffText}</span>
        </div>
      </div>

      {/* Section 4 — stress test */}
      <StressTest inputs={i} />
    </div>
  )
}

function BankCol({
  name,
  onName,
  rate,
  onRate,
  bank,
  idSuffix,
}: {
  name: string
  onName: (v: string) => void
  rate: number
  onRate: (v: number) => void
  bank: BankFigures
  idSuffix: string
}) {
  return (
    <div className="bank-col">
      <div className="bank-header">
        <input className="bank-name-input" value={name} onChange={(e) => onName(e.target.value)} placeholder="Bank name" aria-label={`Bank ${idSuffix} name`} />
      </div>
      <Field label="Interest rate">
        <NumberInput value={rate} onChange={onRate} suffix="%" min={0} max={20} step={0.1} ariaLabel={`Interest rate ${idSuffix}`} />
      </Field>
      <div className="bank-breakdown">
        <DerivedRow label="Monthly interest" value={<Money value={bank.interest} />} />
        <DerivedRow label="Amortisation" value={<Money value={bank.amort} />} />
        <DerivedRow label="Property tax" value={<Money value={bank.tax} />} />
        <DerivedRow label="Driftkostnad" value={<Money value={bank.drift} />} />
        <DerivedRow rowClass="bank-total-row" label="Total monthly" value={<Money value={bank.total} />} />
        <DerivedRow rowClass="derived-relief" label="Ränteavdrag relief" value={<Money value={bank.relief / 12} prefix="−" />} cls="positive" />
        <DerivedRow rowClass="derived-effective" label="Effective monthly" value={<Money value={bank.effective} />} cls="positive" />
      </div>
    </div>
  )
}

function StressTest({ inputs }: { inputs: Inputs }) {
  const [rate, setRate] = useState(inputs.interestRateA)
  // Re-sync the slider to Bank A's rate whenever it changes (mirrors the
  // vanilla dataset.syncedRate behaviour in app.js).
  useEffect(() => {
    setRate(inputs.interestRateA)
  }, [inputs.interestRateA])

  const s = stressAt(inputs, rate)
  const fill = (((rate - 0.5) / 11.5) * 100).toFixed(1) + '%'

  return (
    <div className="section">
      <div className="section-label">
        <span className="section-num">4</span>
        <span className="section-title">Interest rate stress test</span>
      </div>
      <div className="stress-slider-wrap">
        <div className="stress-slider-header">
          <span className="stress-slider-label">Interest rate</span>
          <span className="stress-slider-rate">{rate.toFixed(2)}%</span>
        </div>
        <input
          type="range"
          className="stress-slider-input"
          min={0.5}
          max={12}
          step={0.01}
          value={rate}
          style={{ '--fill': fill } as CSSProperties}
          onChange={(e) => setRate(parseFloat(e.target.value))}
          aria-label="Stress test interest rate"
        />
        <div className="stress-slider-bounds">
          <span>0.5%</span>
          <span>12%</span>
        </div>
        <div className="stress-results">
          <div className="stress-result-row">
            <span className="stress-result-label">Monthly interest</span>
            <span className="stress-result-value">
              <Money value={s.monthlyInterest} />
            </span>
          </div>
          <div className="stress-result-row">
            <span className="stress-result-label">Total monthly</span>
            <span className="stress-result-value" style={{ color: rate > 6 ? 'var(--warn)' : undefined }}>
              <Money value={s.total} />
            </span>
          </div>
          <div className="stress-result-row">
            <span className="stress-result-label">After ränteavdrag</span>
            <span className="stress-result-value stress-result-relief">
              <Money value={s.afterRelief} />
            </span>
          </div>
        </div>
      </div>

      {/* Stress curve — total monthly cost across the rate range */}
      <ExpandableChartCard
        title="Stress curve"
        subtitle="Total monthly cost across interest rates · marker = slider"
        preview={<StressChart inputs={inputs} rate={rate} compact />}
      >
        <div className="chart-overlay-chart">
          <StressChart inputs={inputs} rate={rate} />
        </div>
        <ChartLegend
          items={[
            { label: 'Total monthly', token: 'accent' },
            { label: 'After ränteavdrag', token: 'accentLight', dashed: true },
          ]}
        />
      </ExpandableChartCard>
    </div>
  )
}
