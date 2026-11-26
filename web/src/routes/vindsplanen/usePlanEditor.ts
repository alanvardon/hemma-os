// The Vindsplanen document controller: load, edit with burst-merged undo,
// debounced saves and the reload that follows a resolved sync conflict. Since
// plan 149 the household can keep several plan variants (one attic_plans row
// each); this hook edits ONE open variant at a time and owns switching,
// duplicating, renaming and deleting variants.
//
// Data-safety rules (AGENTS.md "Writes, failures, and cache/cloud
// disagreement"; plan 140):
// * A save failure is never swallowed: the edit stays dirty, the caller shows
//   the message, and the next commit / flush / retry replays it.
// * An unreadable cloud row (`invalid`), or a read that could not confirm the
//   cloud is empty, never reaches an editable state — nothing is saved.
// * A revision conflict is surfaced by the app-wide PersistenceNotice modal;
//   this hook only reloads the plan once that conflict clears. Conflicts are
//   per variant: only the open variant's conflict pauses its saves.
// * Leaving a variant (switch, duplicate, delete) first settles its pending
//   save. If that save does not land, the variant stays open — an unsaved
//   edit is never dropped by switching away from it.
// * A delete is confirmed by the caller. A failed delete keeps the variant
//   listed; a late save refused because its variant was deleted is expected
//   and never reported as an error.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { persistenceErrorMessage, toPersistenceError } from '../../lib/persistence-error'
import { deriveGeometry } from '../../lib/vindsplanen/attic'
import * as H from '../../lib/vindsplanen/history'
import { withFittedClosets } from '../../lib/vindsplanen/items'
import type { PlanV2 } from '../../lib/vindsplanen/plan'
import {
  deletePlan, duplicatePlanRow, loadPlans, newPlanRow, normalizePlanName, onConflictChange, pendingConflict, savePlan,
  type AtticPlanRow,
} from '../../lib/vindsplanen-store'
import { activePlanId, resolveActivePlan, setActivePlanId } from './activePlan'

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

/** The household's variants as the editor knows them. */
export interface Variants {
  /** Valid variants, oldest first; the open one carries its latest saved name/plan. */
  rows: AtticPlanRow[]
  /** The last load was served from the cache: the cloud may hold rows we cannot see. */
  fromCache: boolean
  /** How many stored variants could not be read (never shown, saved over or deleted). */
  invalid: number
}

/** Shown when leaving a variant is refused because its latest edit is not saved. */
export const UNSAVED_LEAVE_TEXT = 'The latest change to this plan is not saved yet. Try saving again before switching plans.'

/** English toast text for a failed variant delete. */
export function deleteErrorMessage(err: unknown): string {
  const category = toPersistenceError(err).category
  if (category === 'conflict') return 'Someone else changed this plan — reload and try again.'
  if (category === 'validation') return 'This plan can’t be deleted right now. Nothing was removed.'
  return persistenceErrorMessage(err)
}

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
  const [variants, setVariantsState] = useState<Variants>({ rows: [], fromCache: false, invalid: 0 })
  const [openId, setOpenIdState] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const phaseRef = useRef<Phase>(phase)
  const histRef = useRef<H.History<PlanV2> | null>(null)
  /** The open variant's row (its latest name; `plan` is replaced by the history on save). */
  const rowRef = useRef<AtticPlanRow | null>(null)
  const variantsRef = useRef<Variants>(variants)
  /** The open variant's id, in memory: survives blocked localStorage across reloads. */
  const openIdRef = useRef<string | null>(null)
  /** Ids deleted (or being deleted) here: a save refused for them is not an error. */
  const deleted = useRef(new Set<string>())
  const inFlight = useRef<Promise<void> | null>(null)
  const busyRef = useRef(false)
  const dirty = useRef(false)
  const rev = useRef(0)
  // rev when the current conflict appeared: edits made after it are kept;
  // otherwise the resolution decides what is shown (see the conflict effect).
  const conflictRev = useRef(0)
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
  const setVariants = useCallback((v: Variants) => {
    variantsRef.current = v
    setVariantsState(v)
  }, [])
  /** Put `row` into the list (replacing the same id, else appending). */
  const upsertRow = useCallback((row: AtticPlanRow) => {
    const v = variantsRef.current
    const at = v.rows.findIndex((r) => r.id === row.id)
    const rows = at >= 0 ? v.rows.map((r, i) => (i === at ? row : r)) : [...v.rows, row]
    setVariants({ ...v, rows })
  }, [setVariants])
  const clearTimer = (t: { current: ReturnType<typeof setTimeout> | null }) => {
    if (t.current) clearTimeout(t.current)
    t.current = null
  }

  const scheduleSave = useCallback(() => {
    clearTimer(saveTimer)
    saveTimer.current = setTimeout(() => void persistRef.current(), SAVE_DEBOUNCE_MS)
  }, [])

  const persist = useCallback((): Promise<void> => {
    // One save at a time; edits that arrive meanwhile are saved right after it.
    if (inFlight.current) return inFlight.current
    const h = histRef.current
    if (!h || phaseRef.current.kind !== 'ready' || !dirty.current) return Promise.resolve()
    const row: AtticPlanRow = { ...(rowRef.current ?? newPlanRow(h.present)), plan: h.present }
    if (pendingConflict(row.id)) {
      // The PersistenceNotice modal owns the resolution; stay dirty until it clears.
      if (mounted.current) setSaveState('conflict')
      return Promise.resolve()
    }
    const first = !rowRef.current
    rowRef.current = row
    upsertRow(row)
    if (first) {
      openIdRef.current = row.id
      setOpenIdState(row.id)
      setActivePlanId(row.id)
    }
    const startRev = rev.current
    if (mounted.current) setSaveState('saving')
    const run = (async (): Promise<boolean> => {
      try {
        await savePlan(row)
      } catch (err) {
        if (deleted.current.has(row.id)) {
          // The variant was deleted meanwhile: its late save is moot, not a failure.
          if (rowRef.current?.id === row.id) dirty.current = false
          if (mounted.current) setSaveState('idle')
          return false
        }
        if (mounted.current) setSaveState(toPersistenceError(err).category === 'conflict' ? 'conflict' : 'failed')
        cbRef.current.onError(persistenceErrorMessage(err))
        return false
      }
      if (rev.current === startRev) dirty.current = false
      if (mounted.current) setSaveState('idle')
      cbRef.current.onSaved()
      return true
    })()
    const done = run.then((ok) => {
      inFlight.current = null
      if (ok && dirty.current) scheduleSave() // edits arrived while this save was in flight
    })
    inFlight.current = done
    return done
  }, [scheduleSave, upsertRow])
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

  /** Make `row` the open variant, with a fresh undo history. Remembered per device. */
  const openRow = useCallback(
    (row: AtticPlanRow) => {
      clearTimer(commitTimer)
      clearTimer(saveTimer)
      rowRef.current = row
      openIdRef.current = row.id
      dirty.current = false
      setOpenIdState(row.id)
      setActivePlanId(row.id)
      setHist(H.initHistory(row.plan))
      setSaveState('idle')
    },
    [setHist],
  )

  const load = useCallback(
    async (initial: boolean) => {
      if (initial) setPhase({ kind: 'loading' })
      let res: Awaited<ReturnType<typeof loadPlans>>
      try {
        res = await loadPlans()
      } catch {
        if (mounted.current) setPhase({ kind: 'error' })
        return
      }
      if (!mounted.current) return
      setVariants({ rows: res.rows, fromCache: res.fromCache, invalid: res.invalid.length })
      if (!res.rows.length) {
        setHist(null)
        rowRef.current = null
        if (res.invalid.length) {
          setPhase({ kind: 'invalid', raw: res.invalid[0].raw })
          return
        }
        // A cache-only read cannot prove the cloud is empty: never offer a second first save.
        setPhase(res.fromCache ? { kind: 'error' } : { kind: 'empty' })
        return
      }
      // the variant open here before, else the one this device chose, else the oldest
      const row = resolveActivePlan(res.rows, openIdRef.current ?? activePlanId())!
      openRow(row)
      setPhase({ kind: 'ready' })
    },
    [openRow, setHist, setPhase, setVariants],
  )

  /**
   * Land the open variant's pending edits: commit the burst, wait for a save
   * in flight, then save what is still dirty. True when nothing is left unsaved.
   */
  const settle = useCallback(async (): Promise<boolean> => {
    for (;;) {
      commit()
      clearTimer(saveTimer)
      if (inFlight.current) {
        await inFlight.current
        continue
      }
      if (!dirty.current || phaseRef.current.kind !== 'ready') return !dirty.current
      const before = rev.current
      await persistRef.current()
      // still dirty with no newer edit: the save failed or waits on a conflict
      if (dirty.current && rev.current === before) return false
    }
  }, [commit])

  /** Run one variant operation at a time; the bar is disabled meanwhile. */
  const exclusive = useCallback(async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    if (busyRef.current) return fallback
    busyRef.current = true
    setBusy(true)
    try {
      return await fn()
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }, [])

  const switchNow = useCallback(
    async (id: string): Promise<boolean> => {
      if (id === openIdRef.current) return true
      if (phaseRef.current.kind !== 'ready' || !variantsRef.current.rows.some((r) => r.id === id)) return false
      if (!(await settle())) {
        cbRef.current.onError(UNSAVED_LEAVE_TEXT)
        return false
      }
      const target = variantsRef.current.rows.find((r) => r.id === id)
      if (!mounted.current || !target) return false
      openRow(target)
      return true
    },
    [openRow, settle],
  )

  /** Open another variant. Its predecessor's pending save lands first. */
  const switchTo = useCallback((id: string) => exclusive(() => switchNow(id), false), [exclusive, switchNow])

  /** "New copy": save a copy of the open variant (with its latest edits) and open it. */
  const duplicate = useCallback(
    () =>
      exclusive(async () => {
        if (!rowRef.current || !histRef.current) return false
        if (!(await settle())) {
          cbRef.current.onError(UNSAVED_LEAVE_TEXT)
          return false
        }
        const copy = duplicatePlanRow({ ...rowRef.current, plan: histRef.current.present })
        try {
          await savePlan(copy)
        } catch (err) {
          cbRef.current.onError(persistenceErrorMessage(err))
          // The copy may still be queued for replay: list what the store now holds.
          try {
            const res = await loadPlans()
            const open = openIdRef.current
            if (mounted.current && open && res.rows.some((r) => r.id === open)) {
              setVariants({ rows: res.rows, fromCache: res.fromCache, invalid: res.invalid.length })
            }
          } catch { /* the toast already said it failed */ }
          return false
        }
        if (!mounted.current) return false
        upsertRow(copy)
        openRow(copy)
        cbRef.current.onSaved()
        return true
      }, false),
    [exclusive, openRow, settle, setVariants, upsertRow],
  )

  /**
   * Rename the open variant. Returns false (and saves nothing) for a name
   * that is empty or too long after trimming.
   */
  const rename = useCallback(
    (input: string): boolean => {
      const name = normalizePlanName(input)
      const row = rowRef.current
      const h = histRef.current
      if (!name || !row || !h) return false
      if (name === row.name) return true
      const next = { ...row, name }
      rowRef.current = next
      upsertRow({ ...next, plan: h.present })
      dirty.current = true
      rev.current++
      clearTimer(saveTimer)
      void persistRef.current()
      return true
    },
    [upsertRow],
  )

  /**
   * Delete a variant (the caller has confirmed). The last valid variant, or
   * any while the list came from the cache, is never deleted. An open variant
   * is left first. On failure the variant stays listed and the error is shown.
   */
  const deleteVariant = useCallback(
    (id: string) =>
      exclusive(async () => {
        const { rows, fromCache } = variantsRef.current
        const at = rows.findIndex((r) => r.id === id)
        if (at < 0 || rows.length < 2 || fromCache) return false
        if (id === openIdRef.current) {
          const next = rows[at - 1] ?? rows[at + 1]
          if (!(await switchNow(next.id))) return false
        }
        deleted.current.add(id)
        try {
          await deletePlan(id)
        } catch (err) {
          deleted.current.delete(id)
          cbRef.current.onError(deleteErrorMessage(err))
          return false
        }
        if (!mounted.current) return true
        const v = variantsRef.current
        setVariants({ ...v, rows: v.rows.filter((r) => r.id !== id) })
        return true
      }, false),
    [exclusive, setVariants, switchNow],
  )

  useEffect(() => {
    mounted.current = true
    void load(true)
    return () => {
      mounted.current = false
    }
  }, [load])

  // A sync conflict is resolved in the app-wide PersistenceNotice. When it
  // clears: with local edits made after the conflict appeared, keep them and
  // save again; otherwise reload the plan so the user sees what the resolution
  // left (their own version after "Behåll min", the cloud's after "Ladda
  // molnversionen"), with a fresh undo history. The conflicted save left the
  // plan dirty, so dirty alone cannot tell the two apart: "Ladda molnversionen"
  // dropped those edits and must not re-save them over the cloud. Only the
  // open variant's conflict counts (any variant's before one is open).
  useEffect(() => {
    const id = openId ?? undefined
    let had = !!pendingConflict(id)
    return onConflictChange((c) => {
      if (c) {
        if (!had) conflictRev.current = rev.current
        had = true
        setSaveState('conflict')
        return
      }
      if (!had) return
      had = false
      setSaveState('idle')
      if (rev.current !== conflictRev.current) scheduleSave()
      else {
        dirty.current = false
        clearTimer(commitTimer)
        void load(false)
      }
    }, id)
  }, [load, scheduleSave, openId])

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

  const present = hist ? hist.present : null
  const liveVariants = useMemo<Variants>(
    () => (present && openId ? { ...variants, rows: variants.rows.map((r) => (r.id === openId ? { ...r, plan: present } : r)) } : variants),
    [variants, openId, present],
  )

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
    /** Every valid variant (the open one with its live plan), oldest first. */
    variants: liveVariants,
    /** The open variant's row (latest name and live plan). */
    openRow: liveVariants.rows.find((r) => r.id === openId) ?? null,
    openId,
    /** True while a switch / copy / delete is running. */
    busy,
    /** Delete is offered only with two or more variants read from the cloud. */
    canDelete: variants.rows.length >= 2 && !variants.fromCache,
    switchTo,
    duplicate,
    rename,
    deleteVariant,
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
