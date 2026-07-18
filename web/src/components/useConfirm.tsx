import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import ConfirmDialog, { type ConfirmOptions } from './ConfirmDialog'

// Promise-based imperative confirm() so existing `if (confirm(...)) { … }`
// control flow converts one-for-one to `if (await confirm({ … }))` — the
// declarative alternative (useState + a rendered dialog at every call site)
// would rewrite the control flow at ~20 sites. A single ConfirmDialog is
// mounted app-wide by ConfirmProvider; confirm(opts) opens it and returns a
// Promise<boolean> that resolves when the user picks (or cancels via Escape /
// backdrop). Mirrors the ThemeContext/useTheme pattern in App.tsx.
//
// Caveat: the promise never rejects. If a caller unmounts while the dialog is
// open, its resolver is simply dropped — harmless, because the dialog state
// lives in the provider (which does not unmount), so there is no state update
// on an unmounted component.
type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>
const ConfirmContext = createContext<ConfirmFn>(async () => false)
export const useConfirm = () => useContext(ConfirmContext)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ open: boolean; options: ConfirmOptions | null }>({
    open: false,
    options: null,
  })
  const resolver = useRef<((ok: boolean) => void) | null>(null)

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve
      setState({ open: true, options })
    })
  }, [])

  const handleResolve = useCallback((ok: boolean) => {
    setState((s) => ({ ...s, open: false }))
    resolver.current?.(ok)
    resolver.current = null
  }, [])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog open={state.open} options={state.options} onResolve={handleResolve} />
    </ConfirmContext.Provider>
  )
}
