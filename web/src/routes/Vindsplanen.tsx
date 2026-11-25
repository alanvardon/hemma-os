// Vindsplanen (plan 140): the attic planner. The household's plan is one
// document (PlanV2) loaded and saved through vindsplanen-store; this route is
// the shell around it — the lazy 3D scene, the panels, undo/redo, debounced
// saves and the read/empty/error states. Geometry and advice come from the
// pure core in lib/vindsplanen; nothing here computes them.

import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useToolPageActive } from '../lib/toolTransition'
import PageHeader from '../components/PageHeader'
import ThemeToggle from '../components/ThemeToggle'
import Segmented from '../components/Segmented'
import { useToast } from '../components/useToast'
import { useConfirm } from '../components/useConfirm'
import { useSaveFlash } from '../components/useSaveFlash'
import { deriveGeometry } from '../lib/vindsplanen/attic'
import { skyHolesOk } from '../lib/vindsplanen/items'
import { measureSteps } from '../lib/vindsplanen/measure'
import { examplePlan, type PlanV2, type ViewPrefs } from '../lib/vindsplanen/plan'
import { planWarnings } from '../lib/vindsplanen/warnings'
import { computeZones } from '../lib/vindsplanen/zones'
import type { CameraPresetId, MovePatch, SceneHandle } from './vindsplanen/scene/Scene'
import LayoutPanel from './vindsplanen/LayoutPanel'
import MaterialsPanel from './vindsplanen/MaterialsPanel'
import MeasurePanel, { MEASURE_END } from './vindsplanen/MeasurePanel'
import RoomPanel from './vindsplanen/RoomPanel'
import SavePanel, { ImportBox } from './vindsplanen/SavePanel'
import SceneHost from './vindsplanen/SceneHost'
import { fmt } from './vindsplanen/fmt'
import { downloadJson } from './vindsplanen/importPlan'
import { addItem, duplicateItem, newItemId, patchItem, removeItem } from './vindsplanen/planOps'
import { usePlanEditor } from './vindsplanen/usePlanEditor'
import { loadViewPrefs, saveViewPrefs } from './vindsplanen/viewPrefs'

// walk mode is its own small chunk, loaded the first time someone walks
const WalkMode = lazy(() => import('./vindsplanen/WalkMode'))

type Tab = 'plan' | 'material' | 'room' | 'measure' | 'save'
const TABS: { v: Tab; label: string }[] = [
  { v: 'plan', label: 'Planering' },
  { v: 'material', label: 'Material' },
  { v: 'room', label: 'Rummet' },
  { v: 'measure', label: 'Mät' },
  { v: 'save', label: 'Spara' },
]

const CAMERAS: { id: CameraPresetId; label: string }[] = [
  { id: 'overview', label: 'Överblick' },
  { id: 'plan', label: 'Planritning' },
  { id: 'east', label: 'Från öster' },
  { id: 'eye', label: 'Stående' },
  { id: 'below', label: 'Våningen under' },
  { id: 'section', label: 'Snitt' },
]

export default function Vindsplanen() {
  const active = useToolPageActive('/vindsplanen')
  useLayoutEffect(() => { document.documentElement.classList.remove('calc-layout') }, [])
  useEffect(() => { document.title = 'Vindsplanen — Hemma·OS' }, [])

  const { toast, showToast } = useToast(4200)
  const { saveVisible: saved, flashSaved } = useSaveFlash()
  const confirm = useConfirm()
  const editor = usePlanEditor({ onSaved: flashSaved, onError: showToast })
  const { phase, plan, update } = editor

  const [view, setViewState] = useState<ViewPrefs>(loadViewPrefs)
  const setView = useCallback((v: ViewPrefs) => { setViewState(v); saveViewPrefs(v) }, [])
  const [tab, setTab] = useState<Tab>('plan')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [cam, setCam] = useState<CameraPresetId | null>(null)
  const [activeStep, setActiveStep] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [walking, setWalking] = useState(false)
  const sceneRef = useRef<SceneHandle>(null)

  // Everything derived comes from the pure core. The heavy parts follow a
  // deferred copy so dragging stays smooth.
  const geo = useMemo(() => (plan ? deriveGeometry(plan.options.attic) : null), [plan])
  const lag = useDeferredValue(plan)
  const lagGeo = useMemo(() => (lag ? deriveGeometry(lag.options.attic) : null), [lag])
  const derived = useMemo(() => {
    if (!lag || !lagGeo) return null
    return { warnings: planWarnings(lagGeo, lag), holesOk: skyHolesOk(lagGeo, lag.items), zones: computeZones(lagGeo, lag) }
  }, [lag, lagGeo])
  const steps = useMemo(() => (plan && geo ? measureSteps(geo, plan) : []), [plan, geo])
  const step = tab === 'measure' && activeStep && activeStep !== MEASURE_END ? steps.find((s) => s.code === activeStep) ?? null : null

  // Opening a step: fly the camera to where the tape goes, and make sure the
  // floor below is visible for a floor-below step.
  useEffect(() => {
    if (!step) return
    sceneRef.current?.flyTo(step.cam)
    if (!step.attic) update((p) => (p.options.below.show ? p : { ...p, options: { ...p.options, below: { ...p.options.below, show: true } } }))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fly once per step, not on every plan edit
  }, [step?.code])

  // Esc closes the measuring walkthrough (v41 `endWalk`); walk mode handles its own Esc
  useEffect(() => {
    if (tab !== 'measure' || !activeStep || walking) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setActiveStep(null) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [tab, activeStep, walking])

  const changeTab = (t: Tab) => { setTab(t); if (t !== 'measure') setActiveStep(null) }
  // opening a measuring step leaves walk mode, and starting a walk closes the step (v41 openStep / fpStart)
  const openStep = (code: string | null) => { if (code) setWalking(false); setActiveStep(code) }
  const openMeasure = (code: string | null) => { setTab('measure'); openStep(code) }
  const startWalk = () => { setActiveStep(null); setSelectedId(null); setCam(null); setWalking(true) }
  const goCamera = (id: CameraPresetId) => { setWalking(false); setCam(id) }

  function addNew(type: Parameters<typeof addItem>[1]) {
    const id = newItemId()
    update((p) => addItem(p, type, id).plan)
    setSelectedId(id)
  }
  function duplicate(srcId: string) {
    const id = newItemId()
    update((p) => duplicateItem(p, srcId, id)?.plan ?? p)
    setSelectedId(id)
  }
  function remove(id: string) {
    update((p) => removeItem(p, id))
    setSelectedId(null)
    showToast('Borttaget. Ångra med Ångra-knappen.')
  }
  async function importPlan(next: PlanV2) {
    if (plan && !(await confirm({
      title: 'Ersätta planen?',
      message: 'Den nuvarande planen ersätts av den inlästa. Du kan ångra direkt efteråt.',
      confirmLabel: 'Ersätt planen',
    }))) return
    if (plan) editor.replacePlan(next)
    else editor.begin(next)
    setSelectedId(null)
    showToast('Planen inläst.')
  }
  async function resetToExample() {
    if (!plan) return
    if (!(await confirm({
      title: 'Börja om med exempel?',
      message: 'Planen ersätts av exempelplanen. Uppmätta mått på vinden (A) behålls. Du kan ångra direkt efteråt.',
      confirmLabel: 'Ersätt planen',
    }))) return
    const ex = examplePlan(plan.options.attic)
    const keep = Object.fromEntries(Object.entries(plan.options.measured).filter(([k]) => k[0] === 'A'))
    editor.replacePlan({ ...ex, options: { ...ex.options, measured: keep } })
    setSelectedId(null)
    showToast('Exempelplanen inläst.')
  }

  let body
  if (phase.kind === 'loading') {
    body = <p className="vp-state" role="status">Läser planen…</p>
  } else if (phase.kind === 'error') {
    body = (
      <section className="vp-card vp-state-card">
        <h2>Planen kunde inte hämtas</h2>
        <p className="vp-note">Det gick inte att läsa hushållets plan just nu. Inget har ändrats. Kontrollera anslutningen och försök igen.</p>
        <div className="vp-actions">
          <button type="button" className="btn btn-primary" onClick={() => void editor.reload()}>Försök igen</button>
        </div>
      </section>
    )
  } else if (phase.kind === 'invalid') {
    body = (
      <section className="vp-card vp-state-card">
        <h2>Planen kunde inte läsas</h2>
        <p className="vp-note">Den sparade planen har ett format som inte går att läsa. Inget skrivs över och inget sparas härifrån. Ladda ner den som den är, så kan den rättas till.</p>
        <div className="vp-actions">
          <button type="button" className="btn btn-primary" onClick={() => downloadJson('vindsplanen-raw.json', phase.raw)}>
            Ladda ner rådata (JSON)
          </button>
        </div>
      </section>
    )
  } else if (phase.kind === 'empty') {
    body = (
      <section className="vp-card vp-state-card">
        <h2>Ingen plan ännu</h2>
        <p className="vp-note">Planera vinden i 3D: placera trappor, fönster, förråd och möbler och se direkt om det får plats. Börja med att läsa in en plan du redan har, eller med ett exempel.</p>
        <div className="vp-actions">
          <button type="button" className="btn btn-primary" onClick={() => setShowImport((v) => !v)} aria-expanded={showImport}>
            Importera plan
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => editor.begin(examplePlan())}>
            Börja med exempel
          </button>
        </div>
        {showImport && <ImportBox id="vp-import-empty" onImport={(p) => void importPlan(p)} />}
      </section>
    )
  } else if (!plan || !geo || !derived) {
    // ready, but the deferred copy the derived numbers follow has not caught up yet (first render)
    body = <p className="vp-state" role="status">Läser planen…</p>
  } else {
    const z = derived.zones
    const area = (n: number) => fmt(n * z.cellArea, 1)
    body = (
      <main className="vp-main">
        <section className="vp-stage" aria-label="3D-vy">
          <SceneHost
            sceneRef={sceneRef}
            plan={plan}
            view={view}
            selectedId={selectedId}
            onSelect={(id) => { if (walking) return; setSelectedId(id); if (id) changeTab('plan') }}
            onMoveItem={(id, patch: MovePatch) => update((p) => patchItem(p, id, patch))}
            onDragEnd={editor.commit}
            camera={cam}
            onCameraDone={() => setCam(null)}
            highlights={step}
            shellToday={!!step?.attic}
          />
          {walking && (
            <Suspense fallback={null}>
              <WalkMode sceneRef={sceneRef} geo={geo} plan={plan} onExit={() => setWalking(false)} />
            </Suspense>
          )}
          <div className="vp-hist" role="group" aria-label="Historik" hidden={walking}>
            <button type="button" className="btn btn-ghost" onClick={editor.undo} disabled={!editor.canUndo} title="Ångra (Cmd/Ctrl+Z)">
              ↶ Ångra
            </button>
            <button type="button" className="btn btn-ghost" onClick={editor.redo} disabled={!editor.canRedo} title="Gör om (Skift+Cmd/Ctrl+Z)">
              ↷ Gör om
            </button>
            <button type="button" className="btn btn-ghost" aria-pressed={view.dims} onClick={() => setView({ ...view, dims: !view.dims })} title="Visa måtten på modellen">
              Mått
            </button>
          </div>
          <div className="vp-cams" role="group" aria-label="Kamera" hidden={walking}>
            <button type="button" className="btn btn-ghost vp-walk-btn" aria-pressed={walking} onClick={startWalk} title="Gå genom planen i ögonhöjd">
              Gå runt
            </button>
            {CAMERAS.map((c) => (
              <button key={c.id} type="button" className="btn btn-ghost" onClick={() => goCamera(c.id)}>
                {c.label}
              </button>
            ))}
          </div>
          {view.zones && !walking && (
            <div className="vp-legend" aria-label="Förklaring">
              <span><i className="vp-sw vp-sw-stand" aria-hidden="true" />Stående höjd, ≥ 1,90 m</span>
              <span><i className="vp-sw vp-sw-boa" aria-hidden="true" />Räknas också som boarea (+60 cm)</span>
            </div>
          )}
        </section>

        <aside className="vp-panel" aria-label="Plan och inställningar">
          <div className="vp-stats">
            <div><b>{area(z.floor)}</b><small>m² golv innanför knävägg</small></div>
            <div><b>{area(z.stand)}</b><small>m² med stående höjd</small></div>
            <div><b>{area(z.boa)}</b><small>m² boarea, ungefär</small></div>
          </div>
          <p className="vp-sub">
            {fmt(geo.L)} × {fmt(geo.W)} m · nock {fmt(geo.H)} m · taklutning ≈ {Math.round((geo.THETA * 180) / Math.PI)}°
          </p>
          {(editor.saveState === 'failed' || editor.saveState === 'conflict') && (
            <div className="vp-savebar" role="status">
              <span>{editor.saveState === 'failed' ? 'Senaste ändringen är inte sparad.' : 'Planen har ändrats på en annan enhet.'}</span>
              {editor.saveState === 'failed' && (
                <button type="button" className="btn btn-ghost" onClick={editor.retrySave}>Försök igen</button>
              )}
            </div>
          )}
          <div className="vp-tabs">
            <Segmented value={tab} options={TABS} onChange={changeTab} ariaLabel="Avsnitt" />
          </div>

          {tab === 'plan' && (
            <LayoutPanel
              geo={geo}
              plan={plan}
              zones={z}
              warnings={derived.warnings}
              holesOk={derived.holesOk}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onAdd={addNew}
              onPatch={(id, patch) => update((p) => patchItem(p, id, patch))}
              onDuplicate={duplicate}
              onDelete={remove}
            />
          )}
          {tab === 'material' && <MaterialsPanel plan={plan} onChange={editor.edit} />}
          {tab === 'room' && <RoomPanel geo={geo} plan={plan} view={view} onView={setView} onChange={editor.edit} onMeasure={openMeasure} />}
          {tab === 'measure' && (
            <MeasurePanel geo={geo} plan={plan} steps={steps} activeCode={activeStep} onOpen={openStep} onChange={editor.edit} onToast={showToast} />
          )}
          {tab === 'save' && (
            <SavePanel plan={plan} saveState={editor.saveState} onImport={(p) => void importPlan(p)} onReset={() => void resetToExample()} onRetry={editor.retrySave} />
          )}
        </aside>
      </main>
    )
  }

  return (
    <div className={'vp-root' + (active ? ' vt-page' : '')}>
      <PageHeader backTo="/vindsplanen" title="Vindsplanen" tagline="Planera vinden i 3D" saveVisible={saved} actions={<ThemeToggle />} />
      {body}
      <div className={'vp-toast' + (toast.show ? ' show' : '')} role="status" aria-live="polite">{toast.msg}</div>
    </div>
  )
}
