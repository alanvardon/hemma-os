import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useNavigate, useViewTransitionState } from 'react-router-dom'
import { useStore, type DeletedInfo } from '../store/useStore'
import { useTheme } from '../App'
import { derive, type Inputs } from '../lib/calc'
import { fmt } from '../lib/format'
import UndoToast from '../components/UndoToast'
import ConstantsModal from '../components/ConstantsModal'

// Landing page for Bostadskalkyl (Phase: scenarios dashboard). You land on a
// grid of saved scenarios and open one to edit it at /bostadskalkyl/:id. An
// unsaved scratch draft (the "New scenario" buffer) surfaces here as its own
// card until you save or discard it.

function CardStats({ inputs, figures }: { inputs: Inputs; figures: ReturnType<typeof derive> }) {
  const cash = figures.cashBalance
  return (
    <div className="scenario-card-stats">
      <div className="scenario-stat">
        <span className="scenario-stat-label">New property</span>
        <span className="scenario-stat-val">{fmt(inputs.newPrice || 0)}</span>
      </div>
      <div className="scenario-stat">
        <span className="scenario-stat-label">Monthly cost</span>
        <span className="scenario-stat-val">{fmt(figures.totalMonthly)}</span>
      </div>
      <div className="scenario-stat">
        <span className="scenario-stat-label">Cash surplus / shortfall</span>
        <span className={`scenario-stat-val ${cash >= 0 ? 'pos' : 'neg'}`}>
          {(cash >= 0 ? '+' : '') + fmt(cash)}
        </span>
      </div>
    </div>
  )
}

export default function ScenariosDashboard() {
  const { theme, toggleTheme } = useTheme()
  const navigate = useNavigate()

  const scenarios = useStore((s) => s.scenarios)
  const draftInputs = useStore((s) => s.draftInputs)
  const draftConstants = useStore((s) => s.draftConstants)
  const globalConstants = useStore((s) => s.globalConstants)
  const setGlobalConstants = useStore((s) => s.setGlobalConstants)
  const hydrate = useStore((s) => s.hydrate)
  const duplicateScenario = useStore((s) => s.duplicateScenario)
  const deleteScenario = useStore((s) => s.deleteScenario)
  const restoreScenario = useStore((s) => s.restoreScenario)
  const discardDraft = useStore((s) => s.discardDraft)

  // The dashboard is a scrollable page (not the locked two-column calc layout).
  useLayoutEffect(() => {
    document.documentElement.classList.remove('calc-layout')
  }, [])

  useEffect(() => {
    hydrate()
  }, [hydrate])

  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) {
      meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--paper').trim())
    }
    document.title = 'Bostadskalkyl — Hemma'
  }, [theme])

  const [undo, setUndo] = useState<{ open: boolean; message: string; info: DeletedInfo | null }>({
    open: false,
    message: '',
    info: null,
  })
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

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

  const sorted = [...scenarios].sort((a, b) => +new Date(b.savedAt) - +new Date(a.savedAt))
  const draftFigures = draftInputs ? derive(draftInputs, draftConstants ?? globalConstants) : null
  // True while navigating to/from this page — the hub card morphs into this root.
  const bkTransitioning = useViewTransitionState('/bostadskalkyl')

  return (
    <>
      <div className={'bk-page-root' + (bkTransitioning ? ' bk-vt' : '')}>
        <header className="page-header">
          <div className="header-brand">
            <Link className="hub-link" to="/" viewTransition>‹ Hemma</Link>
          <div>
            <h1>Bostadskalkyl</h1>
            <p className="tagline">Your saved scenarios — open one to edit, or start a new calculation</p>
          </div>
        </div>
        <div className="header-actions">
          <button
            className="btn btn-ghost"
            title="Default calculation settings"
            aria-label="Default calculation settings"
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
          <button className="btn btn-primary" onClick={() => navigate('/bostadskalkyl/new')}>
            + New scenario
          </button>
        </div>
      </header>

      <main className="dashboard">
        {sorted.length === 0 && !draftFigures ? (
          <div className="dashboard-empty">
            <p>No saved scenarios yet.</p>
            <button className="btn btn-primary" onClick={() => navigate('/bostadskalkyl/new')}>
              Start your first calculation
            </button>
          </div>
        ) : (
          <div className="dashboard-grid">
            {draftFigures && draftInputs && (
              <div className="scenario-card draft-card">
                <div className="scenario-card-name">Unsaved draft</div>
                <div className="scenario-card-date">Not saved yet</div>
                <CardStats inputs={draftInputs} figures={draftFigures} />
                <div className="scenario-card-actions">
                  <button className="btn btn-primary" onClick={() => navigate('/bostadskalkyl/new')}>
                    Continue
                  </button>
                  <button className="btn btn-ghost" onClick={discardDraft}>
                    Discard
                  </button>
                </div>
              </div>
            )}
            {sorted.map((s) => {
              const dateStr = new Date(s.savedAt).toLocaleDateString('sv-SE', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })
              return (
                <div key={s.id} className="scenario-card">
                  <div className="scenario-card-name">{s.name || 'Untitled'}</div>
                  <div className="scenario-card-date">Saved {dateStr}</div>
                  <CardStats inputs={s.inputs} figures={derive(s.inputs, s.constants ?? globalConstants)} />
                  <div className="scenario-card-actions">
                    <button className="btn btn-primary" onClick={() => navigate(`/bostadskalkyl/${s.id}`)}>
                      Open
                    </button>
                    <button className="btn btn-ghost" onClick={() => duplicateScenario(s.id)}>
                      Duplicate
                    </button>
                    <button className="btn btn-danger" onClick={() => handleDelete(s.id)}>
                      Delete
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </main>
      </div>

      <UndoToast open={undo.open} message={undo.message} onUndo={handleUndo} />

      <ConstantsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        value={globalConstants}
        onChange={setGlobalConstants}
        title="Default calculation settings"
        subtitle="Seeds new scenarios — existing ones keep their own values"
      />
    </>
  )
}
