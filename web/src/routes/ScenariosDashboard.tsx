import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useNavigate, useViewTransitionState } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'motion/react'
import { useStore, type DeletedInfo } from '../store/useStore'
import { useTheme } from '../App'
import { derive } from '../lib/calc'
import { filterScenarios, sortScenarios, SORT_OPTIONS, type SortKey } from '../lib/scenarioList'
import ScenarioCard from '../components/ScenarioCard'
import UndoToast from '../components/UndoToast'
import ConstantsModal from '../components/ConstantsModal'

// Per-card entrance (fade+rise), orchestrated by the grid's staggerChildren.
// Reduced motion collapses it to a no-op so cards appear instantly.
const cardVariants = (reduce: boolean): Variants =>
  reduce
    ? { hidden: { opacity: 1 }, show: { opacity: 1 } }
    : {
        hidden: { opacity: 0, y: 8 },
        show: { opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] } },
      }

// Landing page for Bostadskalkyl — a purpose-built launcher (not the retired
// modal cards stretched onto a page). You land on a grid of saved scenarios and
// open one to edit it at /bostadskalkyl/:id. The first cell is always the add
// tile; an unsaved scratch draft, if any, pins right after it.

export default function ScenariosDashboard() {
  const { theme, toggleTheme } = useTheme()
  const navigate = useNavigate()
  const reduce = useReducedMotion() ?? false

  const scenarios = useStore((s) => s.scenarios)
  const draftInputs = useStore((s) => s.draftInputs)
  const draftConstants = useStore((s) => s.draftConstants)
  const globalConstants = useStore((s) => s.globalConstants)
  const setGlobalConstants = useStore((s) => s.setGlobalConstants)
  const hydrate = useStore((s) => s.hydrate)
  const duplicateScenario = useStore((s) => s.duplicateScenario)
  const renameScenario = useStore((s) => s.renameScenario)
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
  const [sortKey, setSortKey] = useState<SortKey>('recent')
  const [query, setQuery] = useState('')

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

  // Add-tile + draft are pinned and excluded from sort/filter; only saved cards
  // are sorted and name-filtered.
  const visible = sortScenarios(filterScenarios(scenarios, query), sortKey, globalConstants)
  const draftFigures = draftInputs ? derive(draftInputs, draftConstants ?? globalConstants) : null
  const noMatches = scenarios.length > 0 && visible.length === 0
  const isEmpty = scenarios.length === 0 && !draftFigures

  // True while navigating to/from this page — the hub card morphs into this root.
  const bkTransitioning = useViewTransitionState('/bostadskalkyl')

  const variants = cardVariants(reduce)
  const container = {
    hidden: {},
    show: { transition: { staggerChildren: reduce ? 0 : 0.03 } },
  }

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

        <div className="dashboard">
          <div className="dashboard-toolbar">
            <input
              className="dashboard-search"
              type="search"
              value={query}
              placeholder="Search scenarios…"
              aria-label="Search scenarios by name"
              onChange={(e) => setQuery(e.target.value)}
            />
            <label className="dashboard-sort">
              <span>Sort</span>
              <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} aria-label="Sort scenarios">
                {SORT_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <span className="dashboard-count">
              {noMatches
                ? 'No matches'
                : `${visible.length} ${visible.length === 1 ? 'scenario' : 'scenarios'}`}
            </span>
          </div>

          <motion.div className="dashboard-list" variants={container} initial="hidden" animate="show">
            <motion.button
              type="button"
              className="dashboard-add-row"
              variants={variants}
              onClick={() => navigate('/bostadskalkyl/new')}
            >
              <span className="add-plus" aria-hidden="true">+</span>
              <span>New scenario</span>
            </motion.button>

            {draftFigures && draftInputs && (
              <ScenarioCard
                draft
                name="Unsaved draft"
                dateLabel="Not saved yet"
                inputs={draftInputs}
                figures={draftFigures}
                reduce={reduce}
                variants={variants}
                onOpen={() => navigate('/bostadskalkyl/new')}
                onContinue={() => navigate('/bostadskalkyl/new')}
                onDiscard={discardDraft}
              />
            )}

            <AnimatePresence>
              {visible.map((s) => {
                const dateStr = new Date(s.savedAt).toLocaleDateString('sv-SE', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })
                return (
                  <ScenarioCard
                    key={s.id}
                    name={s.name}
                    dateLabel={`Saved ${dateStr}`}
                    inputs={s.inputs}
                    figures={derive(s.inputs, s.constants ?? globalConstants)}
                    reduce={reduce}
                    variants={variants}
                    onOpen={() => navigate(`/bostadskalkyl/${s.id}`)}
                    onDuplicate={() => duplicateScenario(s.id)}
                    onRename={(name) => renameScenario(s.id, name)}
                    onDelete={() => handleDelete(s.id)}
                  />
                )
              })}
            </AnimatePresence>
          </motion.div>

          {isEmpty && <p className="dashboard-hint">No scenarios yet — start your first calculation.</p>}
          {noMatches && <p className="dashboard-hint">No scenarios match “{query.trim()}”.</p>}
        </div>
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
