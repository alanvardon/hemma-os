// Plan variants (plan 149): pick which of the household's plans is open, and
// copy, rename or delete it. A native <select> is the picker so any number of
// variants fits a 320 px phone. The data work (settling saves, the store
// calls, the delete confirmation) belongs to the route and usePlanEditor.

import { useEffect, useId, useRef, useState } from 'react'
import { MAX_PLAN_NAME, normalizePlanName } from '../../lib/vindsplanen-store'

export const NAME_INVALID_TEXT = `Give the plan a name of 1–${MAX_PLAN_NAME} characters.`

export default function VariantsBar({
  variants, openId, busy, canDelete, invalid, onSwitch, onDuplicate, onRename, onDelete,
}: {
  variants: { id: string; name: string }[]
  openId: string | null
  busy: boolean
  canDelete: boolean
  /** Stored variants that could not be read. */
  invalid: number
  onSwitch: (id: string) => void
  onDuplicate: () => void
  /** False when the name was refused (nothing saved). */
  onRename: (name: string) => boolean
  onDelete: () => void
}) {
  const id = useId()
  const open = variants.find((v) => v.id === openId) ?? null
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const renameBtn = useRef<HTMLButtonElement>(null)
  // set when the edit has ended (saved or cancelled), so the blur that follows is ignored
  const ended = useRef(false)

  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  function startRename() {
    if (!open) return
    ended.current = false
    setDraft(open.name)
    setError('')
    setEditing(true)
  }
  function stop() {
    ended.current = true
    setEditing(false)
    setError('')
    // focus back to the button that started it (after it re-renders)
    setTimeout(() => renameBtn.current?.focus(), 0)
  }
  function save() {
    if (ended.current) return
    if (!normalizePlanName(draft) || !onRename(draft)) {
      setError(NAME_INVALID_TEXT)
      return
    }
    stop()
  }

  return (
    <section className="vp-variants" aria-label="Plan variants">
      {editing ? (
        <div className="vp-variant-rename">
          <label htmlFor={`${id}-name`}>Plan name</label>
          <input
            ref={input}
            id={`${id}-name`}
            type="text"
            value={draft}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-err` : undefined}
            onChange={(e) => {
              setDraft(e.target.value)
              if (error) setError('')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                save()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                stop()
              }
            }}
            onBlur={save}
          />
          <p className="vp-variant-err" id={`${id}-err`} role="alert">
            {error}
          </p>
        </div>
      ) : (
        <div className="vp-variant-pick">
          <label htmlFor={`${id}-pick`}>Plan</label>
          <select id={`${id}-pick`} value={openId ?? ''} disabled={busy} onChange={(e) => onSwitch(e.target.value)}>
            {variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="vp-variant-acts" hidden={editing}>
        <button type="button" className="btn btn-ghost" onClick={onDuplicate} disabled={busy || !open}>
          New copy
        </button>
        <button ref={renameBtn} type="button" className="btn btn-ghost" onClick={startRename} disabled={busy || !open}>
          Rename
        </button>
        {canDelete && (
          <button type="button" className="btn btn-ghost vp-danger" onClick={onDelete} disabled={busy || !open}>
            Delete
          </button>
        )}
      </div>
      {invalid > 0 && (
        <p className="vp-note">
          {invalid === 1
            ? '1 saved plan can’t be read and is left untouched.'
            : `${invalid} saved plans can’t be read and are left untouched.`}
        </p>
      )}
    </section>
  )
}
