import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Moon, Settings2, Sun } from 'lucide-react'
import { derive } from '../lib/calc'
import { useStore } from '../store/useStore'
import { useTheme } from '../App'
import Icon from '../components/Icon'
import InputsColumn from '../components/InputsColumn'
import SummaryColumn from '../components/SummaryColumn'
import SavePrompt from '../components/SavePrompt'
import DriftModal from '../components/DriftModal'
import SavingsModal from '../components/SavingsModal'
import ConstantsModal from '../components/ConstantsModal'
import { Money } from '../components/AnimatedNumber'
import { loadMortgageBalanceSnapshot } from '../lib/mortgage-store'
import { activeAgreementBalance, activeAgreementMortgage } from '../lib/mortgage'

export type PullStatus = 'idle' | 'loading' | 'error' | 'empty'

export default function Bostadskalkyl() {
  const { theme, toggleTheme } = useTheme()
  const navigate = useNavigate()
  const { id } = useParams() // present on /bostadskalkyl/:id; absent on /new
  const isNew = !id

  // Lock viewport scroll for the two-column calculator layout
  useLayoutEffect(() => {
    document.documentElement.classList.add('calc-layout')
    return () => document.documentElement.classList.remove('calc-layout')
  }, [])

  // Store
  const inputs = useStore((s) => s.inputs)
  const setField = useStore((s) => s.setField)
  const constants = useStore((s) => s.constants)
  const setConstants = useStore((s) => s.setConstants)
  const mode = useStore((s) => s.mode)
  const scenarios = useStore((s) => s.scenarios)
  const activeScenarioId = useStore((s) => s.activeScenarioId)
  const hydrate = useStore((s) => s.hydrate)
  const openScenario = useStore((s) => s.openScenario)
  const openDraft = useStore((s) => s.openDraft)
  const saveDraftAsScenario = useStore((s) => s.saveDraftAsScenario)
  const renameScenario = useStore((s) => s.renameScenario)
  const duplicateScenario = useStore((s) => s.duplicateScenario)
  const savingsItems = useStore((s) => s.savingsItems)

  // Bind the calculator to the route: the scratch draft (/new) or a saved
  // scenario (/:id). Hydrate is idempotent, so this is safe on every mount.
  useEffect(() => {
    void hydrate().then(() => {
      if (isNew) openDraft()
      else if (id && !openScenario(id)) navigate('/bostadskalkyl', { replace: true })
    })
  }, [id, isNew, hydrate, openScenario, openDraft, navigate])

  // Sync theme-color meta + page title on this route
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) {
      const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()
      meta.setAttribute('content', paper)
    }
    document.title = 'Bostadskalkyl — Hemma·OS'
  }, [theme])

  const figures = useMemo(() => derive(inputs, constants), [inputs, constants])
  // Savings augment the cash surplus / shortfall (P&L + mobile bar), Phase 7.
  const savingsTotal = useMemo(() => savingsItems.reduce((s, i) => s + (i.amount || 0), 0), [savingsItems])
  const totalBalance = figures.cashBalance + savingsTotal

  const [driftOpen, setDriftOpen] = useState(false)
  const [savingsOpen, setSavingsOpen] = useState(false)
  const [savePromptOpen, setSavePromptOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const active = scenarios.find((s) => s.id === activeScenarioId)
  const isBound = mode === 'bound' && !!active

  // Plan 118 — explicit pull of Bolånekoll's current mortgage balance into this
  // scenario/draft. The store read guards household scope internally; the
  // request id below discards a stale result from a rapid re-click or a
  // household switch so it can never apply an outdated amount.
  const [pullStatus, setPullStatus] = useState<PullStatus>('idle')
  const [pullPreview, setPullPreview] = useState<number | null>(null)
  const pullReqRef = useRef(0)

  const handlePullMortgage = async () => {
    const reqId = ++pullReqRef.current
    setPullStatus('loading')
    setPullPreview(null)
    let snap: Awaited<ReturnType<typeof loadMortgageBalanceSnapshot>>
    try {
      snap = await loadMortgageBalanceSnapshot()
    } catch {
      snap = null
    }
    if (reqId !== pullReqRef.current) return // superseded — discard stale result
    if (!snap) { setPullStatus('error'); return }
    // Distinguish a genuine "no debt to pull" (no active agreement or no scoped
    // parts) from a positive balance. Never write 0 into the field.
    const hasAgreement = activeAgreementMortgage(snap.mortgages) != null
    const amount = activeAgreementBalance(snap.mortgages, snap.parts, snap.payments)
    if (!hasAgreement || snap.parts.length === 0 || amount <= 0) {
      setPullStatus('empty')
      setPullPreview(null)
      return
    }
    setPullStatus('idle')
    setPullPreview(amount)
  }

  const handleApplyPull = () => {
    if (pullPreview == null) return
    setField('currentMortgage', pullPreview)
    setPullPreview(null)
    setPullStatus('idle')
  }

  const handleDismissPull = () => {
    pullReqRef.current++ // cancel any in-flight read
    setPullPreview(null)
    setPullStatus('idle')
  }

  return (
    <div className="bostad-root">
      <header className="page-header">
        <div className="header-brand">
          <Link className="hub-link" to="/bostadskalkyl">‹<span className="hide-sm"> Scenarios</span></Link>
          <div>
            {isBound ? (
              <input
                className="scenario-title-input"
                value={active.name}
                aria-label="Scenario name"
                placeholder="Untitled scenario"
                onChange={(e) => renameScenario(active.id, e.target.value)}
              />
            ) : (
              <h1>New scenario</h1>
            )}
            <p className="tagline">
              {isBound ? (
                <span className="save-indicator">✓ All changes saved</span>
              ) : (
                'Unsaved draft — save it to keep it'
              )}
            </p>
          </div>
        </div>
        <div className="header-actions">
          <button
            className="btn btn-ghost"
            title="Calculation settings"
            aria-label="Calculation settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Icon icon={Settings2} size={18} />
          </button>
          <button
            className="btn btn-ghost theme-toggle-btn"
            title="Toggle dark mode"
            aria-label="Toggle dark mode"
            onClick={toggleTheme}
          >
            <Icon icon={theme === 'dark' ? Moon : Sun} size={18} />
          </button>
          {isBound ? (
            <button
              className="btn btn-ghost"
              onClick={() => {
                const copyId = duplicateScenario(active.id)
                if (copyId) navigate(`/bostadskalkyl/${copyId}`)
              }}
            >
              Duplicate
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => setSavePromptOpen(true)}>
              Save<span className="hide-sm"> scenario</span>
            </button>
          )}
        </div>
      </header>

      <main className="layout">
        <InputsColumn
          inputs={inputs}
          setField={setField}
          figures={figures}
          constants={constants}
          onOpenDrift={() => setDriftOpen(true)}
          onPullMortgage={handlePullMortgage}
          pullStatus={pullStatus}
          pullPreview={pullPreview}
          onApplyPull={handleApplyPull}
          onDismissPull={handleDismissPull}
        />
        <SummaryColumn
          inputs={inputs}
          setField={setField}
          figures={figures}
          constants={constants}
          savingsTotal={savingsTotal}
          onOpenSavings={() => setSavingsOpen(true)}
        />
      </main>

      {/* Mobile key-figures bar */}
      <div className="mobile-bar">
        <div className="mobile-bar-inner">
          <div className="mobile-stat">
            <span className="mobile-stat-label">Monthly</span>
            <span className="mobile-stat-val">
              <Money value={figures.totalMonthly} />
            </span>
          </div>
          <div className="mobile-stat">
            <span className="mobile-stat-label">Surplus / shortfall</span>
            <span className={`mobile-stat-val ${totalBalance >= 0 ? 'positive' : 'negative'}`}>
              <Money value={totalBalance} signed />
            </span>
          </div>
        </div>
      </div>

      <SavePrompt
        open={savePromptOpen}
        mode="new"
        activeName=""
        onOpenChange={setSavePromptOpen}
        onSaveNew={(name) => {
          const newScenarioId = saveDraftAsScenario(name)
          navigate(`/bostadskalkyl/${newScenarioId}`)
        }}
        onUpdate={() => {}}
      />

      <DriftModal open={driftOpen} onOpenChange={setDriftOpen} />
      <SavingsModal open={savingsOpen} onOpenChange={setSavingsOpen} />

      <ConstantsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        value={constants}
        onChange={setConstants}
        title="Calculation settings"
        subtitle={isBound ? 'Applies to this scenario' : 'Applies to this draft'}
      />
    </div>
  )
}
