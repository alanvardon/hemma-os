// Undo/redo as a pure reducer, with v41's commit semantics (lines 529–541,
// 2124–2135):
//
// - every edit marks the present dirty; nothing is recorded yet;
// - `commit` (v41: 300 ms after the last edit, so a slider drag merges into
//   one step) pushes the last committed snapshot onto the undo stack only if
//   the present differs from it, caps the stack at 150 and clears redo;
// - undo/redo first commit any pending edit, then swap snapshots.
//
// The debounce timer belongs to the caller: call `edit` on every change and
// `commit` when the burst settles (BURST_MS) or before undo, save or unload.

export const HISTORY_LIMIT = 150
export const BURST_MS = 300

export interface History<T> {
  /** What the user sees now. */
  present: T
  /** The last committed snapshot: the state undo returns from. */
  committed: T
  undo: T[]
  redo: T[]
  /** An edit is waiting for `commit`. */
  pending: boolean
}

export type Same<T> = (a: T, b: T) => boolean

const sameJson = <T>(a: T, b: T): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

/** Start (or restart, after a load or reset) with no history. */
export function initHistory<T>(present: T): History<T> {
  return { present, committed: present, undo: [], redo: [], pending: false }
}

/** v41 `save()`: a change happened; it is recorded on the next commit. */
export function edit<T>(h: History<T>, present: T): History<T> {
  return { ...h, present, pending: true }
}

/** v41 `commit()`: record the burst as one undo step if it changed anything. */
export function commit<T>(h: History<T>, same: Same<T> = sameJson): History<T> {
  if (same(h.present, h.committed)) return h.pending ? { ...h, pending: false } : h
  const undo = [...h.undo, h.committed]
  if (undo.length > HISTORY_LIMIT) undo.shift()
  return { present: h.present, committed: h.present, undo, redo: [], pending: false }
}

export function undo<T>(h: History<T>, same: Same<T> = sameJson): History<T> {
  const c = commit(h, same)
  if (!c.undo.length) return c
  const undoStack = c.undo.slice(0, -1)
  const prev = c.undo[c.undo.length - 1]
  return { present: prev, committed: prev, undo: undoStack, redo: [...c.redo, c.committed], pending: false }
}

export function redo<T>(h: History<T>, same: Same<T> = sameJson): History<T> {
  const c = commit(h, same)
  if (!c.redo.length) return c
  const redoStack = c.redo.slice(0, -1)
  const next = c.redo[c.redo.length - 1]
  return { present: next, committed: next, undo: [...c.undo, c.committed], redo: redoStack, pending: false }
}

/** Undo/redo button state, as v41 `updateUndoButtons` (which ran after a commit). */
export const canUndo = <T>(h: History<T>): boolean => h.undo.length > 0
export const canRedo = <T>(h: History<T>): boolean => h.redo.length > 0
