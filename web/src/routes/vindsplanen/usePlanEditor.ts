// The Vindsplanen document controller: load, edit with burst-merged undo,
// debounced saves and the reload that follows a resolved sync conflict.
//
// Data-safety rules (AGENTS.md "Writes, failures, and cache/cloud
// disagreement"; plan 140):
// * A save failure is never swallowed: the edit stays dirty, the caller shows
//   the message, and the next commit / flush / retry replays it.
// * An unreadable cloud row (`invalid`), or a read that could not confirm the
//   cloud is empty, never reaches an editable state — nothing is saved.
// * A revision conflict is surfaced by the app-wide PersistenceNotice modal;
//   this hook only reloads the plan once that conflict clears.

import { useCallback, useEffect, useRef, useState } from 'react'
import { persistenceErrorMessage, toPersistenceError } from '../../lib/persistence-error'
import { deriveGeometry } from '../../lib/vindsplanen/attic'
import * as H from '../../lib/vindsplanen/history'
import { withFittedClosets } from '../../lib/vindsplanen/items'
import type { PlanV2 } from '../../lib/vindsplanen/plan'
import { loadPlan, newPlanRow, onConflictChange, pendingConflict, savePlan, type AtticPlanRow } from '../../lib/vindsplanen-store'

/** Cloud save is debounced this long after the last committed edit. */
export const SAVE_DEBOUNCE_MS = 1500

export type Phase =
  | { kind: 'loading' }
  /** The cloud could not be read (or confirmed empty): nothing is editable or saved. */
  | { kind: 'error' }
  /** The household has no plan yet. */
  | { kind: 'empty' }
  /** A row exists but failed validation. `raw` is its stored `plan`; it is never overwritten. */
  | { kind: 'invalid'; raw: unknown }
  | { kind: 'ready' }

export type SaveState = 'idle' | 'saving' | 'failed' | 'conflict'

/** Cmd/Ctrl-Z must not steal undo from a field being typed in. */
export function isTextEntry(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  if (el.tagName !== 'INPUT') return false
  const t = (el as HTMLInputElement).type
  return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset'].includes(t)
}

const fitted = (p: PlanV2): PlanV2 => withFittedClosets(deriveGeometry(p.options.attic), p)

export function usePlanEditor(cb: { onSaved(): void; onError(message: string): void }) {
  const [phase, setPhaseState] = useState<Phase>({ kind: 'loading' })
  const [hist, setHistState] = useState<H.History<PlanV2> | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')

  const phaseRef = useRef<Phase>(phase)
  const histRef = useRef<H.History<PlanV2> | null>(null)
  const rowRef = useRef<AtticPlanRow | null>(null)
  const dirty = useRef(false)
  const rev = useRef(0)
  const saving = useRef(false)
  const mounted = useRef(true)
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistRef = useRef<() => Promise<void>>(async () => {})
  const cbRef = useRef(cb)
  useEffect(() => {
    cbRef.current = cb
  })

  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p
    setPhaseState(p)
  }, [])
  const setHist = useCallback((h: H.History<PlanV2> | null) => {
    histRef.current = h
    setHistState(h)
  }, [])
  const clearTimer = (t: { current: ReturnType<typeof setTimeout> | null }) => {
    if (t.current) clearTimeout(t.current)
    t.current = null
  }

  const scheduleSave = useCallback(() => {
    clearTimer(saveTimer)
    saveTimer.current = setTimeout(() => void persistRef.current(), SAVE_DEBOUNCE_MS)
  }, [])

  const persist = useCallback(async () => {
    const h = histRef.current
    if (!h || phaseRef.current.kind !== 'ready' || !dirty.current || saving.current) return
    if (pendingConflict()) {
      // The PersistenceNotice modal owns the resolution; stay dirty until it clears.
      if (mounted.current) setSaveState('conflict')
      return
    }
    saving.current = true
    const startRev = rev.current
    const row: AtticPlanRow = { ...(rowRef.current ?? newPlanRow(h.present)), plan: h.present }
    rowRef.current = row
    if (mounted.current) setSaveState('saving')
    try {
      await savePlan(row)
    } catch (err) {
      saving.current = false
      if (mounted.current) setSaveState(toPersistenceError(err).category === 'conflict' ? 'conflict' : 'failed')
      cbRef.current.onError(persistenceErrorMessage(err))
      return
    }
    saving.current = false
    if (rev.current === startRev) dirty.current = false
    if (mounted.current) setSaveState('idle')
    cbRef.current.onSaved()
    if (dirty.current) scheduleSave() // edits arrived while this save was in flight
  }, [scheduleSave])
  useEffect(() => {
    persistRef.current = persist
  }, [persist])

  const commit = useCallback(() => {
    clearTimer(commitTimer)
    const h = histRef.current
    if (!h) return
    const next = H.commit(h)
    if (next !== h) setHist(next)
    if (dirty.current) scheduleSave()
  }, [scheduleSave, setHist])

  /** Save now: commit any pending burst, then persist without waiting for the debounce. */
  const flush = useCallback(() => {
    commit()
    clearTimer(saveTimer)
    void persistRef.current()
  }, [commit])

  /** A change to the plan. Recorded as one undo step once the burst settles. */
  const edit = useCallback(
    (next: PlanV2) => {
      const h = histRef.current
      if (!h) return
      setHist(H.edit(h, fitted(next)))
      dirty.current = true
      rev.current++
      clearTimer(commitTimer)
      commitTimer.current = setTimeout(commit, H.BURST_MS)
    },
    [commit, setHist],
  )

  /** Edit from the latest plan, so two changes before a render never overwrite each other. */
  const update = useCallback(
    (fn: (p: PlanV2) => PlanV2) => {
      const h = histRef.current
      if (h) edit(fn(h.present))
    },
    [edit],
  )

  const step = useCallback(
    (fn: typeof H.undo) => {
      const h = histRef.current
      if (!h) return
      clearTimer(commitTimer)
      const next = fn(h)
      if (next === h) return
      setHist(next)
      dirty.current = true
      rev.current++
      scheduleSave()
    },
    [scheduleSave, setHist],
  )
  const undo = useCallback(() => step(H.undo), [step])
  const redo = useCallback(() => step(H.redo), [step])

  /** Replace the whole plan as one undoable step and save at once (import, reset). */
  const replacePlan = useCallback(
    (plan: PlanV2) => {
      edit(plan)
      flush()
    },
    [edit, flush],
  )

  /** First plan for a household with none: start the history and create the row. */
  const begin = useCallback(
    (plan: PlanV2) => {
      rowRef.current = null
      setHist(H.initHistory(fitted(plan)))
      setPhase({ kind: 'ready' })
      dirty.current = true
      rev.current++
      void persistRef.current()
    },
    [setHist, setPhase],
  )

  const load = useCallback(
    async (initial: boolean) => {
      if (initial) setPhase({ kind: 'loading' })
      let res: Awaited<ReturnType<typeof loadPlan>>
      try {
        res = await loadPlan()
      } catch {
        if (mounted.current) setPhase({ kind: 'error' })
        return
      }
      if (!mounted.current) return
      if ('invalid' in res) {
        setHist(null)
        setPhase({ kind: 'invalid', raw: res.invalid })
        return
      }
      if (!res.row) {
        // A cache-only read cannot prove the cloud is empty: never offer a second first save.
        setPhase(res.fromCache ? { kind: 'error' } : { kind: 'empty' })
        return
      }
      rowRef.current = res.row
      dirty.current = false
      setHist(H.initHistory(res.row.plan))
      setPhase({ kind: 'ready' })
    },
    [setHist, setPhase],
  )

  useEffect(() => {
    mounted.current = true
    void load(true)
    return () => {
      mounted.current = false
    }
  }, [load])

  // A sync conflict is resolved in the app-wide PersistenceNotice. When it
  // clears: with unsaved local edits, keep them and save again; otherwise
  // reload the plan so the user sees what the resolution left, with a fresh
  // undo history.
  useEffect(() => {
    let had = !!pendingConflict()
    return onConflictChange((c) => {
      if (c) {
        had = true
        setSaveState('conflict')
        return
      }
      if (!had) return
      had = false
      setSaveState('idle')
      if (dirty.current) scheduleSave()
      else {
        clearTimer(commitTimer)
        void load(false)
      }
    })
  }, [load, scheduleSave])

  // Flush on hide / page close / leaving the route.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    const onPageHide = () => flush()
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onPageHide)
      flush()
      clearTimer(commitTimer)
      clearTimer(saveTimer)
    }
  }, [flush])

  // Cmd/Ctrl-Z, Shift-Cmd/Ctrl-Z (not while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'z') return
      if (isTextEntry(e.target)) return
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  return {
    phase,
    plan: hist ? hist.present : null,
    canUndo: !!hist && (H.canUndo(hist) || hist.pending),
    canRedo: !!hist && H.canRedo(hist),
    saveState,
    edit,
    update,
    commit,
    undo,
    redo,
    replacePlan,
    begin,
    retrySave: flush,
    reload: () => load(true),
  }
}
