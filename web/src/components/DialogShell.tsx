import { useEffect, useRef, type ReactNode } from 'react'

// Wraps a native <dialog>, driving showModal()/close() off the `open` prop and
// closing on a backdrop click — the exact lifecycle every tool dialog
// hand-rolled (ref + effect + onClick backdrop check). showModal() gives the
// focus trap, Escape-to-close and background inert-ing for free. The per-tool
// look is supplied via `className` (e.g. 'bk-dialog', 'ma-dialog'); the dialog
// body is the children. `ariaLabel` names the dialog when there's no visible
// heading to reference.
export default function DialogShell({ open, onClose, className, ariaLabel, children }: {
  open: boolean
  onClose: () => void
  className?: string
  ariaLabel?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close() }, [open])
  return (
    <dialog
      ref={ref}
      className={className}
      aria-label={ariaLabel}
      // Escape fires the native `cancel` event and closes the <dialog> in the
      // DOM; sync that back to React state so `open` doesn't get stuck true
      // (which would leave the dialog un-reopenable).
      onCancel={onClose}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      {children}
    </dialog>
  )
}
