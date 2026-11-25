// Save tab: export (copy / download JSON), import by paste, and reset to the
// example layout. The plan itself is saved automatically for the household;
// this tab is for keeping a copy and for moving a plan in from the v41 artifact.

import { useState } from 'react'
import type { PlanV2 } from '../../lib/vindsplanen/plan'
import type { SaveState } from './usePlanEditor'
import { downloadJson, parsePlanText } from './importPlan'

const SAVE_TEXT: Record<SaveState, string> = {
  idle: 'Changes are saved automatically for the whole household.',
  saving: 'Saving…',
  failed: 'The latest change is not saved. It will be retried with your next change.',
  conflict: 'The plan was changed on another device. Choose a version in the box that appears.',
}

/** A paste box + "Load plan". Calls `onImport` with a valid plan; shows the reason otherwise. */
export function ImportBox({ onImport, id = 'vp-import' }: { onImport: (plan: PlanV2) => void; id?: string }) {
  const [text, setText] = useState('')
  const [msg, setMsg] = useState('')
  return (
    <div>
      <label className="vp-note" htmlFor={id}>
        Paste a copied plan here
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
          Load plan
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
      setMsg('Plan copied. Paste it into a note or a message to keep it.')
    } catch {
      setMsg('Copying is blocked here. Use Download instead.')
    }
  }
  return (
    <div className="vp-pane">
      <div className="vp-group">
        <h2>Save</h2>
        <p className="vp-note" role="status">
          {SAVE_TEXT[saveState]}
        </p>
        {saveState === 'failed' && (
          <div className="vp-actions">
            <button type="button" className="btn btn-primary" onClick={onRetry}>
              Try again
            </button>
          </div>
        )}
        <p className="vp-note">To keep your own copy, or move the plan somewhere, copy it as text or download it as a file.</p>
        <div className="vp-actions">
          <button type="button" className="btn btn-primary" onClick={() => void copy()}>
            Copy plan (JSON)
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => downloadJson('vindsplanen.json', plan)}>
            Download .json
          </button>
          <button type="button" className="btn btn-ghost vp-danger" onClick={onReset}>
            Start over with the example
          </button>
        </div>
        <p className="vp-msg" role="status">
          {msg}
        </p>
      </div>
      <div className="vp-group">
        <h2>Load a plan</h2>
        <p className="vp-note">Works with a plan copied from the artifact (Copy plan) and with an export from here. It replaces the current plan, but you can undo.</p>
        <ImportBox onImport={onImport} />
      </div>
    </div>
  )
}
