// Spara: export (copy / download JSON), import by paste, and reset to the
// example layout. The plan itself is saved automatically for the household;
// this tab is for keeping a copy and for moving a plan in from the v41 artifact.

import { useState } from 'react'
import type { PlanV2 } from '../../lib/vindsplanen/plan'
import type { SaveState } from './usePlanEditor'
import { downloadJson, parsePlanText } from './importPlan'

const SAVE_TEXT: Record<SaveState, string> = {
  idle: 'Ändringar sparas automatiskt för hela hushållet.',
  saving: 'Sparar…',
  failed: 'Senaste ändringen är inte sparad. Den försöker sparas igen vid nästa ändring.',
  conflict: 'Planen har ändrats på en annan enhet. Välj version i rutan som visas.',
}

/** A paste box + "Läs in plan". Calls `onImport` with a valid plan; shows the reason otherwise. */
export function ImportBox({ onImport, id = 'vp-import' }: { onImport: (plan: PlanV2) => void; id?: string }) {
  const [text, setText] = useState('')
  const [msg, setMsg] = useState('')
  return (
    <div>
      <label className="vp-note" htmlFor={id}>
        Klistra in en kopierad plan här
      </label>
      <textarea id={id} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="vp-actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            const r = parsePlanText(text)
            if (!r.ok) {
              setMsg(r.message)
              return
            }
            setMsg('')
            setText('')
            onImport(r.plan)
          }}
        >
          Läs in plan
        </button>
      </div>
      <p className="vp-msg" role="status">
        {msg}
      </p>
    </div>
  )
}

export default function SavePanel({
  plan, saveState, onImport, onReset, onRetry,
}: {
  plan: PlanV2
  saveState: SaveState
  onImport: (plan: PlanV2) => void
  onReset: () => void
  onRetry: () => void
}) {
  const [msg, setMsg] = useState('')
  async function copy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(plan))
      setMsg('Planen kopierad. Klistra in den i en anteckning eller ett meddelande för att spara den.')
    } catch {
      setMsg('Kopiering är blockerad här. Använd Ladda ner i stället.')
    }
  }
  return (
    <div className="vp-pane">
      <div className="vp-group">
        <h2>Spara</h2>
        <p className="vp-note" role="status">
          {SAVE_TEXT[saveState]}
        </p>
        {saveState === 'failed' && (
          <div className="vp-actions">
            <button type="button" className="btn btn-primary" onClick={onRetry}>
              Försök igen
            </button>
          </div>
        )}
        <p className="vp-note">Vill du ha en egen kopia, eller flytta planen någonstans, kan du kopiera den som text eller ladda ner den som en fil.</p>
        <div className="vp-actions">
          <button type="button" className="btn btn-primary" onClick={() => void copy()}>
            Kopiera plan (JSON)
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => downloadJson('vindsplanen.json', plan)}>
            Ladda ner .json
          </button>
          <button type="button" className="btn btn-ghost vp-danger" onClick={onReset}>
            Börja om med exempel
          </button>
        </div>
        <p className="vp-msg" role="status">
          {msg}
        </p>
      </div>
      <div className="vp-group">
        <h2>Läs in en plan</h2>
        <p className="vp-note">Fungerar med en plan kopierad från artefakten (Copy plan) och med en export härifrån. Den ersätter den nuvarande planen, men du kan ångra.</p>
        <ImportBox onImport={onImport} />
      </div>
    </div>
  )
}
