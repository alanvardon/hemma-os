import { useMemo, useState } from 'react'
import type { Inputs, LumpPayment } from '../../lib/calc'
import { fmt, formatWithSpaces } from '../../lib/format'
import { CurrencyInput, NumberInput, Field } from '../fields'
import { amortSeries, solveTargetLumpSum, type TargetSolution } from './chartData'
import AmortChart from './AmortChart'
import ChartLegend from './ChartLegend'

// The fullscreen amort view: meta stats, the payoff chart, and the two
// planning tools ported from the legacy charts.js — a lump-sum list (extra
// one-off payments applied to the new mortgage) and a target-payoff solver.
interface Props {
  inputs: Inputs
  lumps: LumpPayment[]
  setLumps: (lumps: LumpPayment[]) => void
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="amort-stat">
      <span className="amort-stat-label">{label}</span>
      <span className="amort-stat-val">{value}</span>
    </div>
  )
}

export default function AmortPlanner({ inputs, lumps, setLumps }: Props) {
  const data = useMemo(() => amortSeries(inputs, lumps), [inputs, lumps])
  const newBalance = Math.max(0, inputs.newPrice - inputs.deposit)

  const addLump = () => setLumps([...lumps, { year: 5, amount: 100_000 }])
  const removeLump = (idx: number) => setLumps(lumps.filter((_, n) => n !== idx))
  const updateLump = (idx: number, patch: Partial<LumpPayment>) =>
    setLumps(lumps.map((l, n) => (n === idx ? { ...l, ...patch } : l)))

  // Target-payoff calculator (lump paid in year 1).
  const [targetStr, setTargetStr] = useState('')
  const [solution, setSolution] = useState<TargetSolution | null>(null)
  const calcTarget = () => setSolution(solveTargetLumpSum(inputs, parseInt(targetStr, 10) || 0))

  return (
    <>
      <div className="amort-meta">
        <div className="amort-meta-row">
          <Stat label="Current balance" value={fmt(inputs.currentMortgage)} />
          <Stat label="Amort rate" value={`${inputs.currentAmortRate}%`} />
          <Stat label="Payoff" value={data.currentPayoff != null ? `${data.currentPayoff} yrs` : '—'} />
        </div>
        <div className="amort-meta-row">
          <Stat label="New balance" value={fmt(newBalance)} />
          <Stat label="Amort rate" value={`${inputs.amortRate}%`} />
          <Stat label="Payoff" value={data.nextPayoff != null ? `${data.nextPayoff} yrs` : '—'} />
        </div>
      </div>

      <div className="chart-overlay-chart amort">
        <AmortChart inputs={inputs} lumps={lumps} />
      </div>
      <ChartLegend
        items={[
          { label: 'New mortgage', token: 'accent' },
          { label: 'Current mortgage', token: 'warnLight', dashed: true },
        ]}
      />

      <div className="amort-lump-section">
        <div className="amort-two-col">
          <div className="amort-lump-col">
            <div className="amort-lump-title">Lump sum payments</div>
            <div className="amort-lump-hint">Add one-off payments to see how they accelerate payoff</div>
            {lumps.map((ls, idx) => (
              <div className="lump-row" key={idx}>
                <Field label="Year">
                  <NumberInput
                    value={ls.year}
                    onChange={(v) => updateLump(idx, { year: Math.max(1, Math.round(v)) })}
                    min={1}
                    max={100}
                    step={1}
                    ariaLabel={`Lump payment ${idx + 1} year`}
                  />
                </Field>
                <Field label="Amount">
                  <CurrencyInput value={ls.amount} onChange={(v) => updateLump(idx, { amount: v })} ariaLabel={`Lump payment ${idx + 1} amount`} />
                </Field>
                <button className="lump-remove" title="Remove" aria-label={`Remove lump payment ${idx + 1}`} onClick={() => removeLump(idx)}>
                  ×
                </button>
              </div>
            ))}
            <button className="btn btn-ghost amort-add-btn" onClick={addLump}>
              + Add payment
            </button>
          </div>

          <div className="amort-lump-divider" />

          <div className="amort-lump-col">
            <div className="amort-lump-title">Calculate lump sum for target payoff</div>
            <div className="amort-lump-hint">Enter a target year to find the required lump sum (paid in year 1)</div>
            <div className="amort-target-fields single">
              <div className="field">
                <label>Target payoff year</label>
                <div className="input-wrap has-suffix">
                  <input
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    placeholder="e.g. 25"
                    value={targetStr}
                    onChange={(e) => setTargetStr(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') calcTarget()
                    }}
                    aria-label="Target payoff year"
                  />
                  <span className="suffix">yrs</span>
                </div>
              </div>
            </div>
            <div className="field amort-field">
              <label>Lump sum required</label>
              <div className="input-wrap has-suffix">
                <input
                  type="text"
                  readOnly
                  className="lump-result-input"
                  placeholder="—"
                  value={solution?.amount != null ? formatWithSpaces(solution.amount) : ''}
                  aria-label="Lump sum required"
                />
                <span className="suffix">kr</span>
              </div>
            </div>
            {solution && (
              <div className={solution.kind === 'no-solution' ? 'amort-target-result no-solution' : 'amort-target-result has-result'}>
                {solution.kind === 'has-result' && solution.amount != null && (
                  <span className="result-amount">{fmt(solution.amount)}</span>
                )}
                {solution.message}
              </div>
            )}
            <button className="btn btn-ghost amort-add-btn" onClick={calcTarget}>
              Calculate
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
