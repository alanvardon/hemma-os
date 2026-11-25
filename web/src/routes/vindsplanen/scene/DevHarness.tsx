// TEMPORARY (plan 140 Stage 3): a dev-only page that mounts the lazy scene
// with a golden fixture so it can be screenshotted against v41. Registered in
// AppShell behind import.meta.env.DEV; Stage 4 replaces it with the real route.
//
//   #/dev/vindsplanen-scene?fx=owner-like&cam=overview&w=1000&h=700

import { lazy, Suspense, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { importV1 } from '../../../lib/vindsplanen/legacy'
import type { PlanV2, ViewPrefs } from '../../../lib/vindsplanen/plan'
import type { CameraPresetId, MovePatch } from './Scene'

const Scene = lazy(() => import('./Scene'))

const FIXTURES = import.meta.glob('../../../lib/vindsplanen/__fixtures__/*.json', { eager: true, import: 'default' }) as Record<string, { input?: unknown }>

function load(name: string): { plan: PlanV2; view: ViewPrefs } | null {
  const fx = Object.entries(FIXTURES).find(([k]) => k.endsWith(`/${name}.json`))?.[1]
  const r = fx?.input ? importV1(fx.input) : null
  return r && r.ok ? { plan: r.plan, view: r.view } : null
}

export default function DevHarness() {
  const [q] = useSearchParams()
  const fx = q.get('fx') ?? 'owner-like'
  const w = Number(q.get('w')) || 1000
  const h = Number(q.get('h')) || 700
  const initial = useMemo(() => load(fx), [fx])
  const [plan, setPlan] = useState(initial?.plan ?? null)
  const [view, setView] = useState<ViewPrefs | null>(() => {
    if (!initial) return null
    const v = { ...initial.view }
    if (q.get('dims') === '1') v.dims = true
    if (q.get('quality') === 'fast') v.quality = 'fast'
    return v
  })
  const [selected, setSelected] = useState<string | null>(null)
  const [cam, setCam] = useState<CameraPresetId | null>((q.get('cam') as CameraPresetId) || null)
  const [today, setToday] = useState(false)
  if (!plan || !view) return <p style={{ padding: 16 }}>Okänd fixtur: {fx}</p>
  const move = (id: string, patch: MovePatch) =>
    setPlan((p) => (p ? { ...p, items: p.items.map((i) => (i.id === id ? ({ ...i, ...patch } as typeof i) : i)) } : p))
  return (
    <div style={{ padding: 8, display: 'grid', gap: 8 }}>
      <div id="vp-harness-bar" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 13 }}>
        {(['overview', 'plan', 'east', 'eye', 'below', 'section'] as const).map((c) => (
          <button key={c} type="button" className="btn" data-cam={c} onClick={() => setCam(c)}>
            {c}
          </button>
        ))}
        <button type="button" className="btn" onClick={() => setView({ ...view, dims: !view.dims })}>
          mått
        </button>
        <button type="button" className="btn" onClick={() => setView({ ...view, quality: view.quality === 'nice' ? 'fast' : 'nice' })}>
          {view.quality}
        </button>
        <button type="button" className="btn" onClick={() => setToday(!today)}>
          idag
        </button>
        <span>vald: {selected ?? '–'}</span>
      </div>
      <div id="vp-harness-view" style={{ width: w, height: h, maxWidth: '100%', background: '#c9d6e2', borderRadius: 14 }}>
        <Suspense fallback={null}>
          <Scene
            plan={plan}
            view={view}
            selectedId={selected}
            onSelect={setSelected}
            onMoveItem={move}
            onDragEnd={() => {}}
            camera={cam}
            onCameraDone={() => setCam(null)}
            shellToday={today}
          />
        </Suspense>
      </div>
    </div>
  )
}
