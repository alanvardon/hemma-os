// @vitest-environment jsdom
// Plan 143 — photo mode through the route, with the 3D scene mocked down to
// its SceneHandle: "Photo mode" shows the status pill as the scene reports
// its phase and samples, Exit / Esc / the scene ending it give the camera
// buttons back, and a failed save tells the user.
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useImperativeHandle, type Ref } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmProvider } from '../components/useConfirm'
import { examplePlan, type PlanV2 } from '../lib/vindsplanen/plan'
import * as store from '../lib/vindsplanen-store'
import type { PhotoStartOptions, SceneHandle } from './vindsplanen/scene/Scene'
import Vindsplanen from './Vindsplanen'

const h = vi.hoisted(() => ({
  opts: null as null | PhotoStartOptions,
  starts: 0,
  stops: 0,
  save: null as null | (() => Promise<void>),
}))

vi.mock('./vindsplanen/scene/Scene', () => ({
  default: function MockScene(props: { ref?: Ref<SceneHandle> }) {
    useImperativeHandle(props.ref, () => ({
      getCamera: () => null,
      getCanvas: () => null,
      flyTo: () => {},
      setOrbitEnabled: () => {},
      setFrameHook: () => {},
      startPhoto: (o) => { h.starts++; h.opts = o; o.onPhase('preparing'); o.onSamples(0, 400) },
      stopPhoto: () => { h.stops++; h.opts?.onPhase('off') },
      savePhoto: () => h.save!(),
    }), [])
    return <canvas data-testid="scene" />
  },
}))
vi.mock('../lib/vindsplanen-store', () => ({
  MAX_PLAN_NAME: 80,
  loadPlans: vi.fn(),
  savePlan: vi.fn(),
  deletePlan: vi.fn(),
  pendingConflict: vi.fn(() => null),
  onConflictChange: vi.fn(() => () => {}),
  newPlanRow: vi.fn(),
  duplicatePlanRow: vi.fn(),
  normalizePlanName: vi.fn((s: string) => s.trim() || null),
}))

const row = (plan: PlanV2): store.AtticPlanRow => ({ id: 'row-1', name: 'Vindsplanen', schema_version: 2, plan, created_at: '2026-11-25T10:00:00.000Z' })

function renderRoute() {
  const router = createMemoryRouter([{ path: '/vindsplanen', element: <Vindsplanen /> }], { initialEntries: ['/vindsplanen'] })
  return render(<ConfirmProvider><RouterProvider router={router} /></ConfirmProvider>)
}

async function enter() {
  renderRoute()
  await screen.findByTestId('scene')
  await userEvent.click(screen.getByRole('button', { name: 'Photo mode' }))
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
})

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(h, { opts: null, starts: 0, stops: 0, save: () => Promise.resolve() })
  localStorage.clear()
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never // WebGL "available"
  vi.mocked(store.loadPlans).mockResolvedValue({ rows: [row(examplePlan())], fromCache: false, invalid: [] })
  vi.mocked(store.savePlan).mockResolvedValue(undefined)
})

describe('Photo mode', () => {
  it('shows the phase and samples in place of the camera buttons, and Exit gives them back', async () => {
    await enter()
    expect(h.starts).toBe(1)
    const pill = screen.getByRole('group', { name: 'Photo mode' })
    expect(pill.textContent).toContain('Preparing…')
    expect((screen.getByRole('button', { name: 'Save image' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Overview' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Photo mode' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Exit' }))

    act(() => { h.opts!.onPhase('rendering'); h.opts!.onSamples(120, 400) })
    expect(pill.textContent).toContain('Rendering…')
    expect(pill.textContent).toContain('120 / 400 samples')
    expect((screen.getByRole('button', { name: 'Save image' }) as HTMLButtonElement).disabled).toBe(false)
    act(() => { h.opts!.onSamples(400, 400); h.opts!.onPhase('done') })
    expect(pill.textContent).toContain('Done · 400 samples')

    await userEvent.click(screen.getByRole('button', { name: 'Exit' }))
    expect(h.stops).toBe(1)
    expect(screen.queryByRole('group', { name: 'Photo mode' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Overview' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Photo mode' }))
  })

  it('Esc exits, and so does the scene ending it (a press on the view, a plan change)', async () => {
    await enter()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(h.stops).toBe(1)
    expect(screen.queryByRole('group', { name: 'Photo mode' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Photo mode' }))
    expect(screen.getByRole('group', { name: 'Photo mode' })).toBeTruthy()
    act(() => h.opts!.onPhase('off'))
    expect(screen.queryByRole('group', { name: 'Photo mode' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Overview' })).toBeTruthy()
  })

  it('a tracer that cannot start leaves photo mode with a notice', async () => {
    await enter()
    act(() => h.opts!.onPhase('failed'))
    expect(screen.queryByRole('group', { name: 'Photo mode' })).toBeNull()
    expect(screen.getByText('Photo mode couldn’t start in this browser.')).toBeTruthy()
  })

  it('saves through the scene, and a failed save shows a toast and stays in photo mode', async () => {
    await enter()
    act(() => { h.opts!.onPhase('rendering'); h.opts!.onSamples(60, 400) })
    const save = vi.fn(() => Promise.resolve())
    h.save = save
    await userEvent.click(screen.getByRole('button', { name: 'Save image' }))
    expect(save).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Couldn’t save the image.')).toBeNull()

    h.save = () => Promise.reject(new Error('toBlob returned no image'))
    await userEvent.click(screen.getByRole('button', { name: 'Save image' }))
    expect(await screen.findByText('Couldn’t save the image.')).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Photo mode' })).toBeTruthy()
  })

  it('is not offered while a measuring step is open', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    await userEvent.click(screen.getByRole('radio', { name: 'Measure' }))
    await userEvent.click(screen.getByRole('button', { name: /^A1, / }))
    expect(screen.queryByRole('button', { name: 'Photo mode' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Overview' })).toBeTruthy()
  })
})
