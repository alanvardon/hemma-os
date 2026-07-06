import { useEffect, useRef, type ReactNode } from 'react'

// Wraps a native <dialog>, driving showModal()/close() off the `open` prop and
// closing on a backdrop click — the exact lifecycle every tool dialog
// hand-rolled (ref + effect + onClick backdrop check). The per-tool look is
// supplied via `className` (e.g. 'bk-dialog', 'ma-dialog'); the dialog body is
// the children.
export default function DialogShell({ open, onClose, className, children }: {
  open: boolean
  onClose: () => void
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close() }, [open])
  return (
    <dialog ref={ref} className={className} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      {children}
    </dialog>
  )
}
