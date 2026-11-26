// @vitest-environment jsdom
// Plan 140, Stage 4 — the Vindsplanen route. Per AGENTS.md ("Writes, failures,
// and cache/cloud disagreement") the save paths are asserted on the store calls
// AND on what the user sees: a failed save shows a toast and keeps the edit for
// replay; an unreadable cloud row shows the read-error state and is never
// saved over; a cleared sync conflict reloads the plan. The 3D scene (three.js)
// and the store are mocked; the pure core is real.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmProvider } from '../components/useConfirm'
import { PersistenceError } from '../lib/persistence-error'
import ownerLike from '../lib/vindsplanen/__fixtures__/owner-like.json'
import { importV1 } from '../lib/vindsplanen/legacy'
import { examplePlan, type PlanV2 } from '../lib/vindsplanen/plan'
import * as store from '../lib/vindsplanen-store'
import Vindsplanen from './Vindsplanen'

const h = vi.hoisted(() => ({
  props: null as null | {
    plan: PlanV2
    onMoveItem: (id: string, patch: { x: number; z?: number }) => void
    onDragEnd: () => void
  },
  listener: null as null | ((c: unknown) => void),
  copies: 0,
}))

vi.mock('./vindsplanen/scene/Scene', () => ({
  default: (props: NonNullable<typeof h.props>) => {
    h.props = props
    return <div data-testid="scene" />
  },
}))
vi.mock('../lib/vindsplanen-store', () => ({
  MAX_PLAN_NAME: 80,
  loadPlans: vi.fn(),
  savePlan: vi.fn(),
  deletePlan: vi.fn(),
  pendingConflict: vi.fn(() => null),
  onConflictChange: vi.fn((l: (c: unknown) => void) => {
    h.listener = l
    return () => {}
  }),
  newPlanRow: vi.fn((plan: PlanV2) => ({ id: 'row-1', name: 'Vindsplanen', schema_version: 2, plan, created_at: '2026-11-25T10:00:00.000Z' })),
  duplicatePlanRow: vi.fn((src: { name: string; plan: PlanV2 }) => ({
    id: `copy-${++h.copies}`, name: `${src.name} (copy)`, schema_version: 2, plan: structuredClone(src.plan), created_at: '2026-11-26T10:00:00.000Z',
  })),
  normalizePlanName: vi.fn((s: string) => {
    const t = s.trim()
    return t && t.length <= 80 ? t : null
  }),
}))

const loadPlans = vi.mocked(store.loadPlans)
const deletePlan = vi.mocked(store.deletePlan)
const savePlan = vi.mocked(store.savePlan)

const row = (plan: PlanV2): store.AtticPlanRow => ({ id: 'row-1', name: 'Vindsplanen', schema_version: 2, plan, created_at: '2026-11-25T10:00:00.000Z' })
const bed = () => h.props!.plan.items.find((i) => i.id === 'b1') as { x: number; z: number }

function renderRoute() {
  const router = createMemoryRouter(
    [{ path: '/vindsplanen', element: <Vindsplanen /> }, { path: '/', element: <div>Home</div> }],
    { initialEntries: ['/vindsplanen'] },
  )
  return render(<ConfirmProvider><RouterProvider router={router} /></ConfirmProvider>)
}

/** Move the example bed and end the drag, as the scene does. */
function dragBed(x: number, z: number) {
  act(() => h.props!.onMoveItem('b1', { x, z }))
  act(() => h.props!.onDragEnd())
}
const hide = () => act(() => { window.dispatchEvent(new Event('pagehide')) })

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
})

beforeEach(() => {
  vi.clearAllMocks()
  h.props = null
  h.listener = null
  h.copies = 0
  localStorage.clear()
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never // WebGL "available"
  loadPlans.mockResolvedValue({ rows: [row(examplePlan())], fromCache: false, invalid: [] })
  savePlan.mockResolvedValue(undefined)
  deletePlan.mockResolvedValue(undefined)
})

describe('Vindsplanen route', () => {
  it('shows a failed save as a toast, keeps the edit and replays it on retry', async () => {
    savePlan.mockRejectedValueOnce(new PersistenceError('offline'))
    renderRoute()
    await screen.findByTestId('scene')

    dragBed(2.05, 0.5)
    hide()

    expect(await screen.findByText('Ingen anslutning. Ändringen sparades inte i molnet.')).toBeTruthy()
    expect(savePlan).toHaveBeenCalledTimes(1)
    // the edit is still in the document the user sees
    expect(bed()).toMatchObject({ x: 2.05, z: 0.5 })
    expect(screen.getByText('The latest change is not saved.')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(savePlan).toHaveBeenCalledTimes(2))
    const sent = savePlan.mock.calls[1][0]
    expect(sent.id).toBe('row-1')
    expect((sent.plan.items.find((i) => i.id === 'b1') as { x: number }).x).toBe(2.05)
    await waitFor(() => expect(screen.queryByText('The latest change is not saved.')).toBeNull())
  })

  it('saves a committed edit after the debounce, and undo/redo walk the history', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      renderRoute()
      await screen.findByTestId('scene')
      const x0 = bed().x
      dragBed(2.05, 0.5)
      expect(savePlan).not.toHaveBeenCalled()
      await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
      expect(savePlan).toHaveBeenCalledTimes(1)

      await userEvent.click(screen.getByRole('button', { name: /Undo/ }))
      expect(bed().x).toBe(x0)
      await userEvent.click(screen.getByRole('button', { name: /Redo/ }))
      expect(bed().x).toBe(2.05)
    } finally {
      vi.useRealTimers()
    }
  })

  it('undoes with Ctrl-Z, but not while typing in a field', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    const x0 = bed().x
    dragBed(2.05, 0.5)
    await userEvent.click(screen.getByRole('radio', { name: 'Save' }))
    const box = screen.getByLabelText('Paste a copied plan here')
    fireEvent.keyDown(box, { key: 'z', ctrlKey: true })
    expect(bed().x).toBe(2.05)
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(bed().x).toBe(x0))
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(bed().x).toBe(2.05))
  })

  it('shows the read-error state for an invalid cloud row and never saves', async () => {
    loadPlans.mockResolvedValue({ rows: [], fromCache: false, invalid: [{ id: 'row-1', raw: { v: 2, junk: true } }] })
    renderRoute()
    expect(await screen.findByText('The plan could not be read')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Download raw data (JSON)' })).toBeTruthy()
    expect(screen.queryByTestId('scene')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start with the example' })).toBeNull()
    hide()
    document.dispatchEvent(new Event('visibilitychange'))
    expect(savePlan).not.toHaveBeenCalled()
  })

  it('never flashes the empty state while a saved plan is still being prepared', async () => {
    let flashed = false
    const obs = new MutationObserver(() => { if (document.body.textContent?.includes('No plan yet')) flashed = true })
    obs.observe(document.body, { childList: true, subtree: true, characterData: true })
    renderRoute()
    await screen.findByTestId('scene')
    obs.disconnect()
    expect(flashed).toBe(false)
  })

  it('does not offer a first plan when the cloud could not be read', async () => {
    loadPlans.mockResolvedValue({ rows: [], fromCache: true, invalid: [] })
    renderRoute()
    expect(await screen.findByText('The plan could not be fetched')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Start with the example' })).toBeNull()
    hide()
    expect(savePlan).not.toHaveBeenCalled()
  })

  it('reloads the plan, with a fresh undo history, when a sync conflict clears', async () => {
    const theirs: PlanV2 = { ...examplePlan(), items: examplePlan().items.slice(0, 2) }
    renderRoute()
    await screen.findByTestId('scene')
    expect(h.props!.plan.items).toHaveLength(11)
    expect(h.listener).toBeTruthy()

    loadPlans.mockResolvedValue({ rows: [row(theirs)], fromCache: false, invalid: [] })
    act(() => h.listener!({ id: 'op-1', resource: 'attic_plans' }))
    expect(loadPlans).toHaveBeenCalledTimes(1) // nothing reloaded while the conflict is open
    act(() => h.listener!(null))

    await waitFor(() => expect(h.props!.plan.items).toHaveLength(2))
    expect(loadPlans).toHaveBeenCalledTimes(2)
    expect((screen.getByRole('button', { name: /Undo/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps edits made after a conflict appeared (and saves them) when it clears', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    act(() => h.listener!({ id: 'op-1', resource: 'attic_plans' }))
    dragBed(2.05, 0.5)
    act(() => h.listener!(null))
    expect(loadPlans).toHaveBeenCalledTimes(1)
    expect(bed().x).toBe(2.05)
    hide()
    await waitFor(() => expect(savePlan).toHaveBeenCalledTimes(1))
  })

  it('never re-saves the edit that conflicted: after "Ladda molnversionen" the cloud plan is shown and nothing is written', async () => {
    const theirs: PlanV2 = { ...examplePlan(), items: examplePlan().items.slice(0, 2) }
    renderRoute()
    await screen.findByTestId('scene')
    dragBed(2.05, 0.5)
    act(() => h.listener!({ id: 'op-1', resource: 'attic_plans' }))
    loadPlans.mockResolvedValue({ rows: [row(theirs)], fromCache: false, invalid: [] })
    act(() => h.listener!(null))
    await waitFor(() => expect(h.props!.plan.items).toHaveLength(2))
    hide()
    expect(savePlan).not.toHaveBeenCalled()
  })

  describe('empty household', () => {
    beforeEach(() => { loadPlans.mockResolvedValue({ rows: [], fromCache: false, invalid: [] }) })

    it('offers import first, example second, and creates the plan from the example', async () => {
      renderRoute()
      expect(await screen.findByRole('button', { name: 'Import plan' })).toBeTruthy()
      await userEvent.click(screen.getByRole('button', { name: 'Start with the example' }))
      await screen.findByTestId('scene')
      await waitFor(() => expect(savePlan).toHaveBeenCalledTimes(1))
      const sent = savePlan.mock.calls[0][0]
      expect(sent.plan.v).toBe(2)
      expect(sent.plan.items).toHaveLength(11)
    })

    it('imports a v41 export and saves it', async () => {
      renderRoute()
      await userEvent.click(await screen.findByRole('button', { name: 'Import plan' }))
      fireEvent.change(screen.getByLabelText('Paste a copied plan here'), { target: { value: JSON.stringify(ownerLike.input) } })
      await userEvent.click(screen.getByRole('button', { name: 'Load plan' }))
      await screen.findByTestId('scene')
      expect(h.props!.plan.items).toHaveLength(ownerLike.input.items.length)
      await waitFor(() => expect(savePlan).toHaveBeenCalledTimes(1))
      expect(savePlan.mock.calls[0][0].plan.v).toBe(2)
    })

    it('rejects a pre-v11 export with the instruction, and saves nothing', async () => {
      const old = structuredClone(ownerLike.input) as { options: { below: { v: number } } }
      old.options.below.v = 10
      renderRoute()
      await userEvent.click(await screen.findByRole('button', { name: 'Import plan' }))
      fireEvent.change(screen.getByLabelText('Paste a copied plan here'), { target: { value: JSON.stringify(old) } })
      await userEvent.click(screen.getByRole('button', { name: 'Load plan' }))
      expect(await screen.findByText('Open the plan in the artifact first and copy it again.')).toBeTruthy()
      expect(screen.queryByTestId('scene')).toBeNull()
      expect(savePlan).not.toHaveBeenCalled()
    })

    it('rejects text that is not a plan', async () => {
      renderRoute()
      await userEvent.click(await screen.findByRole('button', { name: 'Import plan' }))
      fireEvent.change(screen.getByLabelText('Paste a copied plan here'), { target: { value: 'hej' } })
      await userEvent.click(screen.getByRole('button', { name: 'Load plan' }))
      expect(await screen.findByText(/This text is not a Vindsplanen plan/)).toBeTruthy()
    })
  })

  it('replaces an existing plan on import only after confirming, and it can be undone', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    await userEvent.click(screen.getByRole('radio', { name: 'Save' }))
    fireEvent.change(screen.getByLabelText('Paste a copied plan here'), { target: { value: JSON.stringify(ownerLike.input) } })
    await userEvent.click(screen.getByRole('button', { name: 'Load plan' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Replace the plan' }))
    await waitFor(() => expect(h.props!.plan.items).toHaveLength(ownerLike.input.items.length))
    await waitFor(() => expect(savePlan).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByRole('button', { name: /Undo/ }))
    await waitFor(() => expect(h.props!.plan.items).toHaveLength(11))
  })

  it('keeps the panels working, with a notice, when WebGL is unavailable', async () => {
    HTMLCanvasElement.prototype.getContext = (() => null) as never
    renderRoute()
    expect(await screen.findByText('The 3D view cannot be shown in this browser')).toBeTruthy()
    expect(screen.queryByTestId('scene')).toBeNull()
    expect(screen.getByText('In the plan')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '+ Bed' }))
    expect(screen.getByRole('region', { name: 'Edit bed' })).toBeTruthy()
    hide()
    await waitFor(() => expect(savePlan).toHaveBeenCalledTimes(1))
  })

  it('lists items with their warning counts and English warning text', async () => {
    const r = ownerLike.input
    loadPlans.mockResolvedValue({ rows: [row(importOwnerLike(r))], fromCache: false, invalid: [] })
    renderRoute()
    await screen.findByTestId('scene')
    expect(document.querySelectorAll('.vp-badge').length).toBeGreaterThan(0)
    await userEvent.click(screen.getAllByRole('button', { name: /^Bed/ })[0])
    expect(screen.getByText('Sticks out behind a knee wall or through a gable.')).toBeTruthy()
  })

  it('persists view preferences per device in vp-view-v1', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    await userEvent.click(screen.getByRole('radio', { name: 'Room' }))
    await userEvent.click(screen.getByLabelText('Show rafters'))
    expect(JSON.parse(localStorage.getItem('vp-view-v1')!)).toMatchObject({ rafters: false })
    // the plan itself is untouched by a view change
    expect(savePlan).not.toHaveBeenCalled()
  })

  it('survives blocked localStorage', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    try {
      renderRoute()
      await screen.findByTestId('scene')
      await userEvent.click(screen.getByRole('radio', { name: 'Room' }))
      await userEvent.click(screen.getByLabelText('Show rafters'))
      expect(screen.getByText('Attic measurements')).toBeTruthy()
    } finally {
      get.mockRestore()
      set.mockRestore()
    }
  })

  it('changing an attic measurement updates the plan without a reload', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    await userEvent.click(screen.getByRole('radio', { name: 'Room' }))
    const len = screen.getByLabelText('A1 · Attic length, gable to gable')
    await userEvent.clear(len)
    await userEvent.type(len, '900')
    await userEvent.tab()
    expect(h.props!.plan.options.attic.len).toBe(9)
  })

  it('opens a measure step, validates the input and records it as measured', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    await userEvent.click(screen.getByRole('radio', { name: 'Measure' }))
    await userEvent.click(screen.getByRole('button', { name: /^A4, Ridge height/ }))
    const input = screen.getByLabelText('Floor to ceiling at the top')
    await userEvent.clear(input)
    await userEvent.type(input, '9999')
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
    expect(screen.getByRole('alert').textContent).toContain('Enter a number')
    expect(h.props!.plan.options.measured.A4).toBeUndefined()
    await userEvent.clear(input)
    await userEvent.type(input, '260')
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
    expect(h.props!.plan.options.measured.A4).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('Plan variants (plan 149)', () => {
  const planA = examplePlan()
  const planB: PlanV2 = { ...examplePlan(), items: examplePlan().items.slice(0, 3) }
  const rowA: store.AtticPlanRow = { ...row(planA), id: 'row-a', name: 'Plan A' }
  const rowB: store.AtticPlanRow = { id: 'row-b', name: 'Plan B', schema_version: 2, plan: planB, created_at: '2026-11-25T11:00:00.000Z' }
  const picker = () => screen.getByLabelText('Plan') as HTMLSelectElement
  const optionNames = () => Array.from(picker().options).map((o) => o.textContent)

  beforeEach(() => {
    loadPlans.mockResolvedValue({ rows: [rowA, rowB], fromCache: false, invalid: [] })
  })

  it('opens the variant this device chose, and the oldest (remembered) when that one is gone', async () => {
    localStorage.setItem('vp-active-plan-v1', 'row-b')
    const first = renderRoute()
    await screen.findByTestId('scene')
    expect(picker().value).toBe('row-b')
    expect(h.props!.plan.items).toHaveLength(3)
    first.unmount()

    localStorage.setItem('vp-active-plan-v1', 'row-gone')
    renderRoute()
    await screen.findByTestId('scene')
    expect(picker().value).toBe('row-a')
    expect(localStorage.getItem('vp-active-plan-v1')).toBe('row-a')
  })

  it('switching saves the previous variant\'s pending edit first, then opens the other with a fresh history', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    dragBed(2.05, 0.5)
    expect(savePlan).not.toHaveBeenCalled() // still inside the debounce
    await userEvent.selectOptions(picker(), 'row-b')
    await waitFor(() => expect(h.props!.plan.items).toHaveLength(3))
    expect(savePlan).toHaveBeenCalledTimes(1)
    const sent = savePlan.mock.calls[0][0]
    expect(sent.id).toBe('row-a')
    expect((sent.plan.items.find((i) => i.id === 'b1') as { x: number }).x).toBe(2.05)
    expect(localStorage.getItem('vp-active-plan-v1')).toBe('row-b')
    expect((screen.getByRole('button', { name: /Undo/ }) as HTMLButtonElement).disabled).toBe(true)
    // conflicts are watched for the open variant only
    expect(vi.mocked(store.onConflictChange)).toHaveBeenLastCalledWith(expect.any(Function), 'row-b')
    // back again: the saved edit is what Plan A shows
    await userEvent.selectOptions(picker(), 'row-a')
    await waitFor(() => expect(bed().x).toBe(2.05))
  })

  it('stays on a variant whose pending edit could not be saved', async () => {
    savePlan.mockRejectedValueOnce(new PersistenceError('offline'))
    renderRoute()
    await screen.findByTestId('scene')
    dragBed(2.05, 0.5)
    await userEvent.selectOptions(picker(), 'row-b')
    expect(await screen.findByText(/not saved yet/)).toBeTruthy()
    expect(picker().value).toBe('row-a')
    expect(bed().x).toBe(2.05)
  })

  it('"New copy" saves a copy of the open variant and opens it', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    dragBed(2.05, 0.5)
    await userEvent.click(screen.getByRole('button', { name: 'New copy' }))
    await waitFor(() => expect(picker().value).toBe('copy-1'))
    expect(optionNames()).toEqual(['Plan A', 'Plan B', 'Plan A (copy)'])
    // the open variant's edit lands first, then the copy (with that edit)
    expect(savePlan.mock.calls.map((c) => c[0].id)).toEqual(['row-a', 'copy-1'])
    expect((savePlan.mock.calls[1][0].plan.items.find((i) => i.id === 'b1') as { x: number }).x).toBe(2.05)
    expect(bed().x).toBe(2.05)
  })

  it('renames the open variant with a trimmed name, refuses an empty one, and Esc cancels', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByLabelText('Plan name')
    await userEvent.clear(input)
    await userEvent.type(input, '   {Enter}')
    expect(screen.getByRole('alert').textContent).toBe('Give the plan a name of 1–80 characters.')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(savePlan).not.toHaveBeenCalled()

    await userEvent.type(input, '{Escape}')
    expect(screen.queryByLabelText('Plan name')).toBeNull()
    expect(optionNames()).toEqual(['Plan A', 'Plan B'])
    expect(savePlan).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await userEvent.clear(screen.getByLabelText('Plan name'))
    await userEvent.type(screen.getByLabelText('Plan name'), '  Two rooms  {Enter}')
    await waitFor(() => expect(savePlan).toHaveBeenCalledTimes(1))
    expect(savePlan.mock.calls[0][0]).toMatchObject({ id: 'row-a', name: 'Two rooms' })
    expect(optionNames()).toEqual(['Two rooms', 'Plan B'])
  })

  it('deletes the open variant after confirming: it leaves the list and the other one opens', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('Delete “Plan A”?')).toBeTruthy()
    expect(screen.getByText('This can’t be undone.')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Delete plan' }))
    await waitFor(() => expect(deletePlan).toHaveBeenCalledWith('row-a'))
    await waitFor(() => expect(optionNames()).toEqual(['Plan B']))
    expect(picker().value).toBe('row-b')
    expect(h.props!.plan.items).toHaveLength(3)
    expect(await screen.findByText('“Plan A” deleted.')).toBeTruthy()
    // one variant left: delete is no longer offered
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('cancelling the confirmation deletes nothing', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(deletePlan).not.toHaveBeenCalled()
    expect(optionNames()).toEqual(['Plan A', 'Plan B'])
  })

  it('shows a failed delete as a toast and keeps the variant listed', async () => {
    deletePlan.mockRejectedValueOnce(new PersistenceError('offline'))
    renderRoute()
    await screen.findByTestId('scene')
    await userEvent.selectOptions(picker(), 'row-b')
    await waitFor(() => expect(picker().value).toBe('row-b'))
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Delete plan' }))
    expect(await screen.findByText('Ingen anslutning. Ändringen sparades inte i molnet.')).toBeTruthy()
    expect(deletePlan).toHaveBeenCalledWith('row-b')
    expect(optionNames()).toEqual(['Plan A', 'Plan B'])
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy()
  })

  it('words a refused delete (server without the delete arm) and a conflicted one in English', async () => {
    deletePlan.mockRejectedValueOnce(new PersistenceError('validation')).mockRejectedValueOnce(new PersistenceError('conflict'))
    renderRoute()
    await screen.findByTestId('scene')
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Delete plan' }))
    expect(await screen.findByText('This plan can’t be deleted right now. Nothing was removed.')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Delete plan' }))
    expect(await screen.findByText('Someone else changed this plan — reload and try again.')).toBeTruthy()
    expect(optionNames()).toEqual(['Plan A', 'Plan B'])
  })

  it('does not offer delete with a single variant, nor for a list served from the cache', async () => {
    loadPlans.mockResolvedValue({ rows: [rowA], fromCache: false, invalid: [{ id: 'row-x', raw: {} }] })
    const first = renderRoute()
    await screen.findByTestId('scene')
    expect(screen.getByRole('button', { name: 'New copy' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
    expect(screen.getByText('1 saved plan can’t be read and is left untouched.')).toBeTruthy()
    first.unmount()

    loadPlans.mockResolvedValue({ rows: [rowA, rowB], fromCache: true, invalid: [] })
    renderRoute()
    await screen.findByTestId('scene')
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('compares the variants side by side on the Save tab', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    await userEvent.click(screen.getByRole('radio', { name: 'Save' }))
    const table = screen.getByRole('region', { name: 'Compare variants' })
    const heads = Array.from(table.querySelectorAll('thead th')).map((t) => t.textContent)
    expect(heads).toEqual(['Plan Aopen', 'Plan B'])
    const windows = Array.from(table.querySelectorAll('tbody tr')).find((tr) => tr.textContent?.startsWith('Roof windows'))!
    expect(Array.from(windows.querySelectorAll('td')).map((td) => td.textContent)).toEqual(['3', '0'])
  })
})

function importOwnerLike(input: unknown): PlanV2 {
  const r = importV1(input)
  if (!r.ok) throw new Error('fixture must import')
  return r.plan
}
