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
}))

vi.mock('./vindsplanen/scene/Scene', () => ({
  default: (props: NonNullable<typeof h.props>) => {
    h.props = props
    return <div data-testid="scene" />
  },
}))
vi.mock('../lib/vindsplanen-store', () => ({
  loadPlan: vi.fn(),
  savePlan: vi.fn(),
  pendingConflict: vi.fn(() => null),
  onConflictChange: vi.fn((l: (c: unknown) => void) => {
    h.listener = l
    return () => {}
  }),
  newPlanRow: vi.fn((plan: PlanV2) => ({ id: 'row-1', name: 'Vindsplanen', schema_version: 2, plan, created_at: '2026-11-25T10:00:00.000Z' })),
}))

const loadPlan = vi.mocked(store.loadPlan)
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
  localStorage.clear()
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never // WebGL "available"
  loadPlan.mockResolvedValue({ row: row(examplePlan()), fromCache: false })
  savePlan.mockResolvedValue(undefined)
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
    expect(screen.getByText('Senaste ändringen är inte sparad.')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Försök igen' }))
    await waitFor(() => expect(savePlan).toHaveBeenCalledTimes(2))
    const sent = savePlan.mock.calls[1][0]
    expect(sent.id).toBe('row-1')
    expect((sent.plan.items.find((i) => i.id === 'b1') as { x: number }).x).toBe(2.05)
    await waitFor(() => expect(screen.queryByText('Senaste ändringen är inte sparad.')).toBeNull())
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

      await userEvent.click(screen.getByRole('button', { name: /Ångra/ }))
      expect(bed().x).toBe(x0)
      await userEvent.click(screen.getByRole('button', { name: /Gör om/ }))
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
    await userEvent.click(screen.getByRole('radio', { name: 'Spara' }))
    const box = screen.getByLabelText('Klistra in en kopierad plan här')
    fireEvent.keyDown(box, { key: 'z', ctrlKey: true })
    expect(bed().x).toBe(2.05)
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(bed().x).toBe(x0))
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(bed().x).toBe(2.05))
  })

  it('shows the read-error state for an invalid cloud row and never saves', async () => {
    loadPlan.mockResolvedValue({ row: null, fromCache: false, invalid: { v: 2, junk: true } })
    renderRoute()
    expect(await screen.findByText('Planen kunde inte läsas')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ladda ner rådata (JSON)' })).toBeTruthy()
    expect(screen.queryByTestId('scene')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Börja med exempel' })).toBeNull()
    hide()
    document.dispatchEvent(new Event('visibilitychange'))
    expect(savePlan).not.toHaveBeenCalled()
  })

  it('never flashes the empty state while a saved plan is still being prepared', async () => {
    let flashed = false
    const obs = new MutationObserver(() => { if (document.body.textContent?.includes('Ingen plan ännu')) flashed = true })
    obs.observe(document.body, { childList: true, subtree: true, characterData: true })
    renderRoute()
    await screen.findByTestId('scene')
    obs.disconnect()
    expect(flashed).toBe(false)
  })

  it('does not offer a first plan when the cloud could not be read', async () => {
    loadPlan.mockResolvedValue({ row: null, fromCache: true })
    renderRoute()
    expect(await screen.findByText('Planen kunde inte hämtas')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Börja med exempel' })).toBeNull()
    hide()
    expect(savePlan).not.toHaveBeenCalled()
  })

  it('reloads the plan, with a fresh undo history, when a sync conflict clears', async () => {
    const theirs: PlanV2 = { ...examplePlan(), items: examplePlan().items.slice(0, 2) }
    renderRoute()
    await screen.findByTestId('scene')
    expect(h.props!.plan.items).toHaveLength(11)
    expect(h.listener).toBeTruthy()

    loadPlan.mockResolvedValue({ row: row(theirs), fromCache: false })
    act(() => h.listener!({ id: 'op-1', resource: 'attic_plans' }))
    expect(loadPlan).toHaveBeenCalledTimes(1) // nothing reloaded while the conflict is open
    act(() => h.listener!(null))

    await waitFor(() => expect(h.props!.plan.items).toHaveLength(2))
    expect(loadPlan).toHaveBeenCalledTimes(2)
    expect((screen.getByRole('button', { name: /Ångra/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps edits made after a conflict appeared (and saves them) when it clears', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    act(() => h.listener!({ id: 'op-1', resource: 'attic_plans' }))
    dragBed(2.05, 0.5)
    act(() => h.listener!(null))
    expect(loadPlan).toHaveBeenCalledTimes(1)
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
    loadPlan.mockResolvedValue({ row: row(theirs), fromCache: false })
    act(() => h.listener!(null))
    await waitFor(() => expect(h.props!.plan.items).toHaveLength(2))
    hide()
    expect(savePlan).not.toHaveBeenCalled()
  })

  describe('empty household', () => {
    beforeEach(() => { loadPlan.mockResolvedValue({ row: null, fromCache: false }) })

    it('offers import first, example second, and creates the plan from the example', async () => {
      renderRoute()
      expect(await screen.findByRole('button', { name: 'Importera plan' })).toBeTruthy()
      await userEvent.click(screen.getByRole('button', { name: 'Börja med exempel' }))
      await screen.findByTestId('scene')
      await waitFor(() => expect(savePlan).toHaveBeenCalledTimes(1))
      const sent = savePlan.mock.calls[0][0]
      expect(sent.plan.v).toBe(2)
      expect(sent.plan.items).toHaveLength(11)
    })

    it('imports a v41 export and saves it', async () => {
      renderRoute()
      await userEvent.click(await screen.findByRole('button', { name: 'Importera plan' }))
      fireEvent.change(screen.getByLabelText('Klistra in en kopierad plan här'), { target: { value: JSON.stringify(ownerLike.input) } })
      await userEvent.click(screen.getByRole('button', { name: 'Läs in plan' }))
      await screen.findByTestId('scene')
      expect(h.props!.plan.items).toHaveLength(ownerLike.input.items.length)
      await waitFor(() => expect(savePlan).toHaveBeenCalledTimes(1))
      expect(savePlan.mock.calls[0][0].plan.v).toBe(2)
    })

    it('rejects a pre-v11 export with the instruction, and saves nothing', async () => {
      const old = structuredClone(ownerLike.input) as { options: { below: { v: number } } }
      old.options.below.v = 10
      renderRoute()
      await userEvent.click(await screen.findByRole('button', { name: 'Importera plan' }))
      fireEvent.change(screen.getByLabelText('Klistra in en kopierad plan här'), { target: { value: JSON.stringify(old) } })
      await userEvent.click(screen.getByRole('button', { name: 'Läs in plan' }))
      expect(await screen.findByText('Öppna planen i artefakten först och kopiera den igen.')).toBeTruthy()
      expect(screen.queryByTestId('scene')).toBeNull()
      expect(savePlan).not.toHaveBeenCalled()
    })

    it('rejects text that is not a plan', async () => {
      renderRoute()
      await userEvent.click(await screen.findByRole('button', { name: 'Importera plan' }))
      fireEvent.change(screen.getByLabelText('Klistra in en kopierad plan här'), { target: { value: 'hej' } })
      await userEvent.click(screen.getByRole('button', { name: 'Läs in plan' }))
      expect(await screen.findByText(/Texten är ingen plan/)).toBeTruthy()
    })
  })

  it('replaces an existing plan on import only after confirming, and it can be undone', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    await userEvent.click(screen.getByRole('radio', { name: 'Spara' }))
    fireEvent.change(screen.getByLabelText('Klistra in en kopierad plan här'), { target: { value: JSON.stringify(ownerLike.input) } })
    await userEvent.click(screen.getByRole('button', { name: 'Läs in plan' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Ersätt planen' }))
    await waitFor(() => expect(h.props!.plan.items).toHaveLength(ownerLike.input.items.length))
    await waitFor(() => expect(savePlan).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByRole('button', { name: /Ångra/ }))
    await waitFor(() => expect(h.props!.plan.items).toHaveLength(11))
  })

  it('keeps the panels working, with a notice, when WebGL is unavailable', async () => {
    HTMLCanvasElement.prototype.getContext = (() => null) as never
    renderRoute()
    expect(await screen.findByText('3D-vyn kan inte visas i den här webbläsaren')).toBeTruthy()
    expect(screen.queryByTestId('scene')).toBeNull()
    expect(screen.getByText('I planen')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '+ Säng' }))
    expect(screen.getByRole('region', { name: 'Redigera säng' })).toBeTruthy()
    hide()
    await waitFor(() => expect(savePlan).toHaveBeenCalledTimes(1))
  })

  it('lists items with their warning counts and Swedish warning text', async () => {
    const r = ownerLike.input
    loadPlan.mockResolvedValue({ row: row(importOwnerLike(r)), fromCache: false })
    renderRoute()
    await screen.findByTestId('scene')
    expect(document.querySelectorAll('.vp-badge').length).toBeGreaterThan(0)
    await userEvent.click(screen.getAllByRole('button', { name: /^Säng/ })[0])
    expect(screen.getByText('Sticker ut bakom en knävägg eller genom en gavel.')).toBeTruthy()
  })

  it('persists view preferences per device in vp-view-v1', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    await userEvent.click(screen.getByRole('radio', { name: 'Rummet' }))
    await userEvent.click(screen.getByLabelText('Visa sparrar'))
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
      await userEvent.click(screen.getByRole('radio', { name: 'Rummet' }))
      await userEvent.click(screen.getByLabelText('Visa sparrar'))
      expect(screen.getByText('Vinden, mått')).toBeTruthy()
    } finally {
      get.mockRestore()
      set.mockRestore()
    }
  })

  it('changing an attic measurement updates the plan without a reload', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    await userEvent.click(screen.getByRole('radio', { name: 'Rummet' }))
    const len = screen.getByLabelText('A1 · Vindens längd, gavel till gavel')
    await userEvent.clear(len)
    await userEvent.type(len, '900')
    await userEvent.tab()
    expect(h.props!.plan.options.attic.len).toBe(9)
  })

  it('opens a measure step, validates the input and records it as measured', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    await userEvent.click(screen.getByRole('radio', { name: 'Mät' }))
    await userEvent.click(screen.getByRole('button', { name: /^A4, Nockhöjd/ }))
    const input = screen.getByLabelText('Golv till taket högst upp')
    await userEvent.clear(input)
    await userEvent.type(input, '9999')
    await userEvent.click(screen.getByRole('button', { name: 'Spara och gå vidare' }))
    expect(screen.getByRole('alert').textContent).toContain('Ange ett tal')
    expect(h.props!.plan.options.measured.A4).toBeUndefined()
    await userEvent.clear(input)
    await userEvent.type(input, '260')
    await userEvent.click(screen.getByRole('button', { name: 'Spara och gå vidare' }))
    expect(h.props!.plan.options.measured.A4).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

function importOwnerLike(input: unknown): PlanV2 {
  const r = importV1(input)
  if (!r.ok) throw new Error('fixture must import')
  return r.plan
}
