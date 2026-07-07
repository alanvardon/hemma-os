import { useEffect, useRef, useState } from 'react'

// ── Editable name — locked as plain text until you click the pen ─────────────
// Names (line-item labels, category names) read as text with a pen button; the
// pen turns just that one name into an input. Enter / blur commit & re-lock,
// Esc cancels. Only one is ever open at a time: focusing another field's input
// blurs (and commits) the current one. `inputClassName` reuses the field's own
// input styling so the editing state looks identical to before; `autoEdit`
// opens a freshly-added row/category straight into edit mode.
export default function EditableName({ value, placeholder, ariaLabel, inputClassName, autoEdit, onCommit }: {
  value: string; placeholder: string; ariaLabel: string; inputClassName: string
  autoEdit?: boolean; onCommit: (v: string) => void
}) {
  const [editing, setEditing] = useState(!!autoEdit)
  const [buf, setBuf] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  // Resync the buffer to external changes only while locked (never clobber a
  // value the user is mid-edit on).
  useEffect(() => { if (!editing) setBuf(value) }, [value, editing])
  useEffect(() => { if (editing) inputRef.current?.select() }, [editing])

  function commit() { onCommit(buf.trim()); setEditing(false) }
  function cancel() { setBuf(value); setEditing(false) }

  if (editing) {
    return (
      <input
        ref={inputRef} type="text" className={inputClassName} value={buf}
        placeholder={placeholder} aria-label={ariaLabel} autoFocus
        onChange={(e) => setBuf(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit() }
          else if (e.key === 'Escape') { e.preventDefault(); cancel() }
        }}
      />
    )
  }
  return (
    <span className="name-display">
      <span className={'name-text' + (value ? '' : ' is-placeholder')}>{value || placeholder}</span>
      <button type="button" className="name-edit-btn" aria-label={`Rename ${value || placeholder}`}
        onClick={() => setEditing(true)}>
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </button>
    </span>
  )
}
