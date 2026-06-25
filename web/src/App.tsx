import { useEffect, useMemo, useRef, useState } from 'react'
import { derive } from './lib/calc'
import { useStore, type DeletedInfo } from './store/useStore'
import InputsColumn from './components/InputsColumn'
import SummaryColumn from './components/SummaryColumn'
import ScenariosModal from './components/ScenariosModal'
import SavePrompt from './components/SavePrompt'
import UndoToast from './components/UndoToast'
import DriftModal from './components/DriftModal'
import SavingsModal from './components/SavingsModal'
import { Money } from './components/AnimatedNumber'

type Theme = 'light' | 'dark'

// Shares the localStorage key with the vanilla app so a returning user's
// theme choice carries over (and the future suite stays in sync).
const THEME_KEY = 'bostadskalkyl_theme'

function getInitialTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)

  // Store
  const inputs = useStore((s) => s.inputs)
  const setField = useStore((s) => s.setField)
  const scenarios = useStore((s) => s.scenarios)
  const activeScenarioId = useStore((s) => s.activeScenarioId)
  const isDirty = useStore((s) => s.isDirty)
  const hydrate = useStore((s) => s.hydrate)
  const saveNewScenario = useStore((s) => s.saveNewScenario)
  const updateActiveScenario = useStore((s) => s.updateActiveScenario)
  const loadScenario = useStore((s) => s.loadScenario)
  const duplicateScenario = useStore((s) => s.duplicateScenario)
  const deleteScenario = useStore((s) => s.deleteScenario)
  const restoreScenario = useStore((s) => s.restoreScenario)
  const savingsItems = useStore((s) => s.savingsItems)

  const figures = useMemo(() => derive(inputs), [inputs])
  // Savings augment the cash surplus / shortfall (P&L + mobile bar), Phase 7.
  const savingsTotal = useMemo(() => savingsItems.reduce((s, i) => s + (i.amount || 0), 0), [savingsItems])
  const totalBalance = figures.cashBalance + savingsTotal

  // Restore the saved session + scenarios on first mount.
  useEffect(() => {
    hydrate()
  }, [hydrate])

  // ── Theme ──────────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* private mode / storage disabled — ignore */
    }
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) {
      const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()
      meta.setAttribute('content', paper)
    }
  }, [theme])

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))

  // ── Scenarios / save UI state ──────────────────────────────────
  const [scenariosOpen, setScenariosOpen] = useState(false)
  const [driftOpen, setDriftOpen] = useState(false)
  const [savingsOpen, setSavingsOpen] = useState(false)
  const [savePrompt, setSavePrompt] = useState<{ open: boolean; mode: 'new' | 'update'; activeName: string }>({
    open: false,
    mode: 'new',
    activeName: '',
  })
  const [undo, setUndo] = useState<{ open: boolean; message: string; info: DeletedInfo | null }>({
    open: false,
    message: '',
    info: null,
  })
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const active = scenarios.find((s) => s.id === activeScenarioId)
  const saveLabel = active ? (isDirty ? 'Update' : 'Save as new') : 'Save'

  const handleSave = () => {
    if (active && isDirty) setSavePrompt({ open: true, mode: 'update', activeName: active.name })
    else setSavePrompt({ open: true, mode: 'new', activeName: '' })
  }

  const handleDelete = (id: string) => {
    const info = deleteScenario(id)
    if (!info) return
    if (undoTimer.current) clearTimeout(undoTimer.current)
    setUndo({ open: true, message: `Deleted “${info.deleted.name}”`, info })
    undoTimer.current = setTimeout(() => setUndo((u) => ({ ...u, open: false })), 6000)
  }

  const handleUndo = () => {
    if (undo.info) restoreScenario(undo.info)
    if (undoTimer.current) clearTimeout(undoTimer.current)
    setUndo((u) => ({ ...u, open: false }))
  }

  return (
    <>
      <header className="page-header">
        <div className="header-brand">
          <a className="hub-link" href="../index.html">‹ Hemma</a>
          <div>
            <h1>Bostadskalkyl</h1>
            <p className="tagline">
              Swedish house purchase calculator — upfront costs &amp; monthly payments
            </p>
          </div>
        </div>
        <div className="header-actions">
          {active ? (
            <span className="active-scenario-label">
              <span className="active-scenario-name">{active.name}</span>
              {isDirty && <span className="unsaved-dot" title="Unsaved changes" />}
            </span>
          ) : isDirty ? (
            <span className="active-scenario-label">
              <span className="active-scenario-name">Unsaved</span>
              <span className="unsaved-dot" />
            </span>
          ) : null}
          <button
            className="btn btn-ghost theme-toggle-btn"
            title="Toggle dark mode"
            aria-label="Toggle dark mode"
            onClick={toggleTheme}
          >
            {theme === 'dark' ? '☾' : '☀'}
          </button>
          <button className="btn btn-ghost" onClick={() => setScenariosOpen(true)}>
            Scenarios
          </button>
          <button className="btn btn-primary" onClick={handleSave}>
            {saveLabel}
          </button>
        </div>
      </header>

      <main className="layout">
        <InputsColumn inputs={inputs} setField={setField} figures={figures} onOpenDrift={() => setDriftOpen(true)} />
        <SummaryColumn
          inputs={inputs}
          setField={setField}
          figures={figures}
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

      <ScenariosModal
        open={scenariosOpen}
        onOpenChange={setScenariosOpen}
        scenarios={scenarios}
        activeScenarioId={activeScenarioId}
        onLoad={(id) => {
          loadScenario(id)
          setScenariosOpen(false)
        }}
        onDuplicate={duplicateScenario}
        onDelete={handleDelete}
      />

      <SavePrompt
        open={savePrompt.open}
        mode={savePrompt.mode}
        activeName={savePrompt.activeName}
        onOpenChange={(o) => setSavePrompt((p) => ({ ...p, open: o }))}
        onSaveNew={saveNewScenario}
        onUpdate={updateActiveScenario}
      />

      <UndoToast open={undo.open} message={undo.message} onUndo={handleUndo} />

      <DriftModal open={driftOpen} onOpenChange={setDriftOpen} />
      <SavingsModal open={savingsOpen} onOpenChange={setSavingsOpen} />
    </>
  )
}
