import type { Inputs, Figures } from '../lib/calc'
import { Money, Percent } from './AnimatedNumber'
import ExpandableChartCard from './charts/ExpandableChartCard'
import ChartLegend from './charts/ChartLegend'
import AmortChartCard from './charts/AmortChartCard'
import EquityChart from './charts/EquityChart'

interface Props {
  inputs: Inputs
  setField: <K extends keyof Inputs>(key: K, value: Inputs[K]) => void
  figures: Figures
  savingsTotal: number
  onOpenSavings: () => void
}

export default function SummaryColumn({ inputs: i, setField, figures: f, savingsTotal, onOpenSavings }: Props) {
  // Phase 7: savings entries augment the cash surplus / shortfall.
  const totalBalance = f.cashBalance + savingsTotal
  const pnlClass =
    totalBalance > 0
      ? 'sum-card sum-card-clickable pnl-positive'
      : totalBalance < 0
        ? 'sum-card sum-card-clickable pnl-negative'
        : 'sum-card sum-card-clickable'
  const equity = Math.min(Math.max(f.equityShare, 0), 100)
  const ltvColor =
    f.equityShare < 15 ? 'var(--warn)' : f.equityShare < 30 ? 'var(--warn-light)' : 'var(--accent)'

  return (
    <div className="summary-col">
      <p className="summary-title">Summary</p>

      {/* Cash surplus / shortfall (P&L) — click to edit savings */}
      <div
        className={pnlClass}
        role="button"
        tabIndex={0}
        aria-label="Edit savings entries"
        onClick={onOpenSavings}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onOpenSavings()
          }
        }}
      >
        <div className="sum-card-title-row">
          <div className="sum-card-title">Cash surplus / shortfall</div>
          <span className="sum-card-hint">Edit savings ›</span>
        </div>
        <div className={`sum-big ${totalBalance >= 0 ? 'positive' : 'negative'}`}>
          <Money value={totalBalance} signed />
        </div>
        <div className="sum-rows">
          <div className="sum-row">
            <span className="sum-row-label">Net from sale</span>
            <span className="sum-row-val">
              <Money value={f.netProceeds} />
            </span>
          </div>
          <div className="sum-row">
            <span className="sum-row-label">Less upfront costs</span>
            <span className="sum-row-val">
              <Money value={f.totalUpfront} prefix="−" />
            </span>
          </div>
          {savingsTotal > 0 && (
            <div className="sum-row">
              <span className="sum-row-label">Savings</span>
              <span className="sum-row-val positive">
                <Money value={savingsTotal} signed />
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Net from sale */}
      <div className="sum-card">
        <div className="sum-card-title">Net from sale</div>
        <div className="sum-big positive">
          <Money value={f.netProceeds} />
        </div>
        <div className="sum-rows">
          <div className="sum-row">
            <span className="sum-row-label">Total takeaway</span>
            <span className="sum-row-val">
              <Money value={f.totalTakeaway} />
            </span>
          </div>
          <div className="sum-row">
            <span className="sum-row-label">Less agent &amp; moving</span>
            <span className="sum-row-val">
              <Money value={i.agentCost + i.movingCost} prefix="−" />
            </span>
          </div>
        </div>
      </div>

      {/* Total upfront needed */}
      <div className="sum-card">
        <div className="sum-card-title">Total upfront needed</div>
        <div className="sum-big">
          <Money value={f.totalUpfront} />
        </div>
        <div className="sum-rows">
          <div className="sum-row">
            <span className="sum-row-label">Deposit</span>
            <span className="sum-row-val">
              <Money value={i.deposit} />
            </span>
          </div>
          <div className="sum-row">
            <span className="sum-row-label">Lagfart</span>
            <span className="sum-row-val">
              <Money value={f.lagfart} />
            </span>
          </div>
          <div className="sum-row">
            <span className="sum-row-label">Pantbrev cost</span>
            <span className="sum-row-val">
              <Money value={f.pantbrevCost} />
            </span>
          </div>
        </div>
      </div>

      {/* New mortgage + equity bar */}
      <div className="sum-card">
        <div className="sum-card-title">New mortgage</div>
        <div className="sum-big">
          <Money value={f.loanAmount} />
        </div>
        <div className="ltv-bar-wrap">
          <div className="ltv-bar-bg">
            <div className="ltv-bar-fill" style={{ width: `${equity}%`, background: ltvColor }} />
          </div>
          <div className="ltv-labels">
            <span>
              Equity:{' '}
              <strong>
                <Percent value={f.equityShare} />
              </strong>
            </span>
            <span>15% min</span>
          </div>
        </div>
      </div>

      {/* Payoff comparison + lump-sum / target-payoff planner */}
      <AmortChartCard inputs={i} />

      <hr className="sum-divider" />

      {/* Total monthly cost */}
      <div className="sum-card">
        <div className="sum-card-title">Total monthly cost</div>
        <div className="sum-big">
          <Money value={f.totalMonthly} />
        </div>
        <div className="sum-rows">
          <div className="sum-row">
            <span className="sum-row-label">Interest</span>
            <span className="sum-row-val">
              <Money value={f.bankA.interest} />
            </span>
          </div>
          <div className="sum-row">
            <span className="sum-row-label">Amortisation</span>
            <span className="sum-row-val">
              <Money value={f.monthlyAmort} />
            </span>
          </div>
          <div className="sum-row">
            <span className="sum-row-label">Property tax</span>
            <span className="sum-row-val">
              <Money value={f.taxMonthly} />
            </span>
          </div>
          <div className="sum-row">
            <span className="sum-row-label">Driftkostnad</span>
            <span className="sum-row-val">
              <Money value={i.driftkostnad} />
            </span>
          </div>
        </div>
      </div>

      {/* Ränteavdrag */}
      <div className="sum-card">
        <div className="sum-card-title">Ränteavdrag (tax relief)</div>
        <div className="sum-big positive">
          <Money value={f.relief / 12} suffix="/mo" />
        </div>
        <div className="sum-rows">
          <div className="sum-row">
            <span className="sum-row-label">Annual interest</span>
            <span className="sum-row-val">
              <Money value={f.bankA.annualInterest} suffix="/yr" />
            </span>
          </div>
          <div className="sum-row">
            <span className="sum-row-label">Back from Skatteverket</span>
            <span className="sum-row-val positive">
              <Money value={f.relief} suffix="/yr" />
            </span>
          </div>
          <div className="sum-row">
            <span className="sum-row-label">Effective monthly</span>
            <span className="sum-row-val">
              <Money value={f.effectiveMonthly} />
            </span>
          </div>
        </div>
      </div>

      <hr className="sum-divider" />

      {/* Affordability */}
      <div className="sum-card">
        <div className="sum-card-title">Affordability</div>
        <div className="sum-big">
          <Money value={f.reqSalaryMonthly} suffix="/mo" />
        </div>
        <div className="sum-card-subtitle">gross monthly salary needed</div>
        <div className="sum-rows" style={{ marginTop: '0.5rem' }}>
          <div className="sum-row afford-row" style={{ borderTop: 'none', paddingTop: 6 }}>
            <span className="sum-row-label">Threshold</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <input
                type="number"
                className="afford-input"
                value={i.affordThreshold}
                min={1}
                max={100}
                step={1}
                onChange={(e) => setField('affordThreshold', parseInt(e.target.value, 10) || 0)}
                aria-label="Affordability threshold"
              />
              <span className="afford-unit">% of gross salary</span>
            </span>
          </div>
          <div className="sum-row afford-row" style={{ paddingTop: 6 }}>
            <span className="sum-row-label">Include ränteavdrag</span>
            <label className="toggle" style={{ marginLeft: 'auto' }}>
              <input
                type="checkbox"
                checked={i.ranteavdrag}
                onChange={(e) => setField('ranteavdrag', e.target.checked)}
                aria-label="Include ränteavdrag in affordability"
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
      </div>

      {/* Equity projection */}
      <div className="sum-card">
        <div className="sum-card-title">Equity after 10 years</div>
        <div className="sum-big positive">
          <Money value={f.equity.y10} />
        </div>
        <div className="sum-rows">
          <div className="sum-row">
            <span className="sum-row-label">Equity at year 5</span>
            <span className="sum-row-val">
              <Money value={f.equity.y5} />
            </span>
          </div>
          <div className="sum-row">
            <span className="sum-row-label">Equity at year 20</span>
            <span className="sum-row-val">
              <Money value={f.equity.y20} />
            </span>
          </div>
        </div>
      </div>

      {/* Equity growth chart */}
      <ExpandableChartCard
        title="Equity growth"
        subtitle="Equity building as the mortgage amortises"
        preview={<EquityChart inputs={i} compact />}
      >
        <div className="chart-overlay-chart">
          <EquityChart inputs={i} />
        </div>
        <ChartLegend items={[{ label: 'Equity (deposit + amortised principal)', token: 'accent' }]} />
      </ExpandableChartCard>
    </div>
  )
}
