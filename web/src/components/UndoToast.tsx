interface Props {
  open: boolean
  message: string
  onUndo: () => void
}

export default function UndoToast({ open, message, onUndo }: Props) {
  return (
    <div className={open ? 'undo-toast open' : 'undo-toast'} role="status" aria-live="polite">
      <span>{message}</span>
      <button className="btn btn-ghost" onClick={onUndo}>
        Undo
      </button>
    </div>
  )
}
