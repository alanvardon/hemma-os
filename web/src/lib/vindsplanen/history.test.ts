import { describe, expect, it } from 'vitest'
import { canRedo, canUndo, commit, edit, HISTORY_LIMIT, initHistory, redo, undo, type History } from './history'

type S = { x: number }
const s = (x: number): S => ({ x })

describe('history — v41 commit semantics', () => {
  it('a burst of edits (a slider drag) becomes one undo step on commit', () => {
    let h: History<S> = initHistory(s(0))
    for (let x = 1; x <= 20; x++) h = edit(h, s(x))
    expect(canUndo(h)).toBe(false) // nothing recorded until the burst settles
    h = commit(h)
    expect(h.undo).toEqual([s(0)])
    expect(h.committed).toEqual(s(20))
    h = undo(h)
    expect(h.present).toEqual(s(0))
  })

  it('a commit that changed nothing records nothing', () => {
    let h = initHistory(s(0))
    h = commit(edit(edit(h, s(5)), s(0)))
    expect(canUndo(h)).toBe(false)
    expect(h.pending).toBe(false)
  })

  it('undo and redo flush a pending edit first (v41 flushSave)', () => {
    let h = commit(edit(initHistory(s(0)), s(1)))
    h = edit(h, s(2)) // not yet committed
    h = undo(h) // commits 2, then undoes it
    expect(h.present).toEqual(s(1))
    expect(h.redo).toEqual([s(2)])
    h = redo(h)
    expect(h.present).toEqual(s(2))
    expect(h.undo).toEqual([s(0), s(1)])
  })

  it('a new edit after undo clears redo', () => {
    let h = commit(edit(commit(edit(initHistory(s(0)), s(1))), s(2)))
    h = undo(h)
    expect(canRedo(h)).toBe(true)
    h = commit(edit(h, s(9)))
    expect(canRedo(h)).toBe(false)
    expect(h.undo).toEqual([s(0), s(1)])
  })

  it('undo/redo on empty stacks change nothing', () => {
    const h = initHistory(s(0))
    expect(undo(h)).toEqual(h)
    expect(redo(h)).toEqual(h)
  })

  it(`keeps at most ${HISTORY_LIMIT} steps, dropping the oldest`, () => {
    let h = initHistory(s(0))
    for (let x = 1; x <= HISTORY_LIMIT + 10; x++) h = commit(edit(h, s(x)))
    expect(h.undo).toHaveLength(HISTORY_LIMIT)
    expect(h.undo[0]).toEqual(s(10))
  })

  it('compares snapshots by value (JSON), not identity', () => {
    let h = initHistory(s(1))
    h = commit(edit(h, { x: 1 }))
    expect(canUndo(h)).toBe(false)
  })

  it('accepts a custom equality', () => {
    let h = initHistory(s(1))
    h = commit(edit(h, s(2)), () => true)
    expect(canUndo(h)).toBe(false)
  })
})
