import DialogShell from './DialogShell'

export interface ConfirmOptions {
  title: string
  /** Body text. Newlines render as paragraph breaks (unlike native confirm). */
  message?: string
  /** Optional pre-formatted lines shown as a list (rate-drift import case). */
  lines?: string[]
  confirmLabel?: string // default 'Ta bort'
  cancelLabel?: string // default 'Avbryt'
  /** Danger styling on the confirm button. Default true (most calls are deletes). */
  danger?: boolean
}

// Presentational themed replacement for native confirm(). State (open/options
// and the promise resolver) lives in ConfirmProvider; this only renders. Built
// on DialogShell, so focus-trap, Escape-to-cancel and backdrop-click-to-cancel
// come for free — all three route through onClose → onResolve(false).
export default function ConfirmDialog({
  open,
  options,
  onResolve,
}: {
  open: boolean
  options: ConfirmOptions | null
  onResolve: (ok: boolean) => void
}) {
  const o = options
  return (
    <DialogShell
      open={open}
      onClose={() => onResolve(false)}
      className="confirm-dialog"
      ariaLabel={o?.title}
    >
      {o && (
        <div className="confirm-body">
          <h2 className="confirm-title">{o.title}</h2>
          {o.message &&
            o.message.split('\n').map((p, i) => (
              <p key={i} className="confirm-message">
                {p}
              </p>
            ))}
          {o.lines && o.lines.length > 0 && (
            <ul className="confirm-lines">
              {o.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
          <div className="confirm-actions">
            <button type="button" className="btn btn-ghost" onClick={() => onResolve(false)}>
              {o.cancelLabel ?? 'Avbryt'}
            </button>
            <button
              type="button"
              className={o.danger === false ? 'btn btn-primary' : 'btn btn-primary confirm-danger'}
              autoFocus
              onClick={() => onResolve(true)}
            >
              {o.confirmLabel ?? 'Ta bort'}
            </button>
          </div>
        </div>
      )}
    </DialogShell>
  )
}
