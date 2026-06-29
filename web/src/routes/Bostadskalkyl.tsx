import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { derive } from '../lib/calc'
import { useStore } from '../store/useStore'
import { useTheme } from '../App'
import InputsColumn from '../components/InputsColumn'
import SummaryColumn from '../components/SummaryColumn'
import SavePrompt from '../components/SavePrompt'
import DriftModal from '../components/DriftModal'
import SavingsModal from '../components/SavingsModal'
import ConstantsModal from '../components/ConstantsModal'
import { Money } from '../components/AnimatedNumber'

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

  return (
    <>
      <header className="page-header">
        <div className="header-brand">
          <Link className="hub-link" to="/bostadskalkyl">‹ Scenarios</Link>
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
            ⚙
          </button>
          <button
            className="btn btn-ghost theme-toggle-btn"
            title="Toggle dark mode"
            aria-label="Toggle dark mode"
            onClick={toggleTheme}
          >
            {theme === 'dark' ? '☾' : '☀'}
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
              Save scenario
            </button>
          )}
        </div>
      </header>

      <main className="layout">
        <InputsColumn inputs={inputs} setField={setField} figures={figures} constants={constants} onOpenDrift={() => setDriftOpen(true)} />
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
    </>
  )
}
