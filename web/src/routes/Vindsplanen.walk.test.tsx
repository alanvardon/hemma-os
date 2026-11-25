// @vitest-environment jsdom
// Plan 140, Stage 5 — walk mode and the measuring walkthrough, through the
// route with the 3D scene mocked down to its SceneHandle: "Gå runt" takes the
// camera (orbit off, a frame hook driving it from the pure walker) and Esc
// gives it back; the Mät steps fly the camera to each step, forwards and back.
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useImperativeHandle, type Ref } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { ConfirmProvider } from '../components/useConfirm'
import { deriveGeometry } from '../lib/vindsplanen/attic'
import { measureSteps } from '../lib/vindsplanen/measure'
import { examplePlan, type PlanV2 } from '../lib/vindsplanen/plan'
import * as store from '../lib/vindsplanen-store'
import type { SceneHandle } from './vindsplanen/scene/Scene'
import Vindsplanen from './Vindsplanen'

const h = vi.hoisted(() => ({
  camera: null as null | THREE.PerspectiveCamera,
  hook: null as null | ((dt: number, camera: THREE.PerspectiveCamera) => void),
  orbit: [] as boolean[],
  flights: [] as { p: number[]; t: number[]; instant?: boolean }[],
  props: null as null | { highlights?: unknown; shellToday?: boolean; plan: PlanV2 },
}))

vi.mock('./vindsplanen/scene/Scene', () => ({
  default: function MockScene(props: { ref?: Ref<SceneHandle>; plan: PlanV2; highlights?: unknown; shellToday?: boolean }) {
    h.props = props
    useImperativeHandle(props.ref, () => ({
      getCamera: () => h.camera,
      getCanvas: () => document.querySelector('[data-testid=scene]') as HTMLCanvasElement | null,
      flyTo: (c, o) => { h.flights.push({ ...c, instant: o?.instant }) },
      setOrbitEnabled: (on) => { h.orbit.push(on) },
      setFrameHook: (fn) => { h.hook = fn },
    }), [])
    return <canvas data-testid="scene" />
  },
}))
vi.mock('../lib/vindsplanen-store', () => ({
  loadPlan: vi.fn(),
  savePlan: vi.fn(),
  pendingConflict: vi.fn(() => null),
  onConflictChange: vi.fn(() => () => {}),
  newPlanRow: vi.fn(),
}))

const row = (plan: PlanV2): store.AtticPlanRow => ({ id: 'row-1', name: 'Vindsplanen', schema_version: 2, plan, created_at: '2026-11-25T10:00:00.000Z' })

function renderRoute() {
  const router = createMemoryRouter([{ path: '/vindsplanen', element: <Vindsplanen /> }], { initialEntries: ['/vindsplanen'] })
  return render(<ConfirmProvider><RouterProvider router={router} /></ConfirmProvider>)
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
})

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(h, { camera: new THREE.PerspectiveCamera(48), hook: null, orbit: [], flights: [], props: null })
  localStorage.clear()
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never // WebGL "available"
  vi.mocked(store.loadPlan).mockResolvedValue({ row: row(examplePlan()), fromCache: false })
  vi.mocked(store.savePlan).mockResolvedValue(undefined)
})

describe('Gå runt (walk mode)', () => {
  it('takes the camera with orbit off, walks with the keys, and Esc gives the orbit camera back', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    await userEvent.click(screen.getByRole('button', { name: 'Gå runt' }))
    await screen.findByRole('region', { name: 'Gå runt' })

    expect(h.orbit).toEqual([false])
    expect(h.hook).toBeTypeOf('function')
    expect(h.camera!.fov).toBe(70)
    // one frame: the camera stands at eye height in the hallway below (v41 starts downstairs)
    act(() => h.hook!(0.016, h.camera!))
    expect(h.camera!.position.y).toBeLessThan(0)
    expect(screen.getByText('Våningen under · hallen')).toBeTruthy()
    expect(screen.getByText(/^Fri höjd \d+ cm/)).toBeTruthy()
    // the camera buttons give way to the walk's own controls
    expect(screen.queryByRole('button', { name: 'Överblick' })).toBeNull()

    // W for a few frames walks forward (east, along the hallway)
    const x0 = h.camera!.position.x
    fireEvent.keyDown(document, { key: 'w' })
    act(() => { for (let i = 0; i < 10; i++) h.hook!(0.05, h.camera!) })
    fireEvent.keyUp(document, { key: 'w' })
    expect(h.camera!.position.x - x0).toBeCloseTo(0.65, 6)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Gå runt' })).toBeNull()
    expect(h.orbit).toEqual([false, true])
    expect(h.hook).toBeNull()
    expect(h.camera!.fov).toBe(48)
    // the orbit camera picks up where the walk left off, without a tween
    const exit = h.flights[h.flights.length - 1]
    expect(exit.instant).toBe(true)
    expect(exit.p[0]).toBeCloseTo(h.camera!.position.x, 6)
    expect(screen.getByRole('button', { name: 'Överblick' })).toBeTruthy()
  })

  it('keys typed into a field do not walk, and "Sluta gå" leaves too', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    await userEvent.click(screen.getByRole('button', { name: 'Gå runt' }))
    await screen.findByRole('region', { name: 'Gå runt' })
    act(() => h.hook!(0.016, h.camera!))
    const x0 = h.camera!.position.x
    const field = document.createElement('input')
    document.body.appendChild(field)
    fireEvent.keyDown(field, { key: 'w' })
    act(() => { for (let i = 0; i < 5; i++) h.hook!(0.05, h.camera!) })
    expect(h.camera!.position.x).toBeCloseTo(x0, 9)
    field.remove()
    await userEvent.click(screen.getByRole('button', { name: 'Sluta gå' }))
    expect(screen.queryByRole('region', { name: 'Gå runt' })).toBeNull()
    expect(h.orbit).toEqual([false, true])
  })

  it('opening a measuring step leaves walk mode', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    await userEvent.click(screen.getByRole('button', { name: 'Gå runt' }))
    await screen.findByRole('region', { name: 'Gå runt' })
    await userEvent.click(screen.getByRole('radio', { name: 'Mät' }))
    await userEvent.click(screen.getByRole('button', { name: /^B1, / }))
    expect(screen.queryByRole('region', { name: 'Gå runt' })).toBeNull()
    expect(h.orbit).toEqual([false, true])
  })
})

describe('Mät: the measuring walkthrough', () => {
  const steps = measureSteps(deriveGeometry(examplePlan().options.attic), examplePlan())

  it('flies to each step, back and forth, with the attic as it is today on A steps only, and ends with the end card', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    await userEvent.click(screen.getByRole('radio', { name: 'Mät' }))
    await userEvent.click(screen.getByRole('button', { name: 'Mät nästa' }))

    const last = () => h.flights[h.flights.length - 1]
    expect(screen.getByText(`1 av ${steps.length}`)).toBeTruthy()
    expect(last()).toMatchObject(steps[0].cam)
    expect(h.props!.shellToday).toBe(true)
    expect(h.props!.highlights).toMatchObject({ code: 'A1' })
    expect((screen.getByRole('button', { name: 'Tillbaka' }) as HTMLButtonElement).disabled).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: 'Hoppa över' }))
    expect(screen.getByText(`2 av ${steps.length}`)).toBeTruthy()
    expect(last()).toMatchObject(steps[1].cam)
    await userEvent.click(screen.getByRole('button', { name: 'Tillbaka' }))
    expect(screen.getByText(`1 av ${steps.length}`)).toBeTruthy()
    expect(last()).toMatchObject(steps[0].cam)

    // jump to the first floor-below step: furniture back, still highlighted
    const b1 = steps.findIndex((s) => s.code === 'B1')
    for (let i = 0; i < b1; i++) await userEvent.click(screen.getByRole('button', { name: 'Hoppa över' }))
    expect(screen.getByText(`${b1 + 1} av ${steps.length}`)).toBeTruthy()
    expect(last()).toMatchObject(steps[b1].cam)
    expect(h.props!.shellToday).toBe(false)
    expect(h.props!.highlights).toMatchObject({ code: 'B1' })

    // past the last step: the end card, no highlights
    for (let i = b1; i < steps.length; i++) await userEvent.click(screen.getByRole('button', { name: 'Hoppa över' }))
    expect(screen.getByText('Slutet av listan')).toBeTruthy()
    expect(screen.getByText(`${steps.length} kvar att mäta`)).toBeTruthy()
    expect(h.props!.highlights).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Stäng' }))
    expect(screen.getByRole('button', { name: 'Mät nästa' })).toBeTruthy()
  })

  it('saving an attic step stays in the walkthrough on the next step (no reload), and Esc closes it', async () => {
    renderRoute()
    await screen.findByTestId('scene')
    await userEvent.click(screen.getByRole('radio', { name: 'Mät' }))
    await userEvent.click(screen.getByRole('button', { name: /^A1, / }))
    const input = screen.getByRole('spinbutton')
    await userEvent.clear(input)
    await userEvent.type(input, '900')
    await userEvent.click(screen.getByRole('button', { name: 'Spara och gå vidare' }))
    expect(h.props!.plan.options.attic.len).toBe(9)
    expect(h.props!.plan.options.measured.A1).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(screen.getByText(`2 av ${steps.length}`)).toBeTruthy()
    // the flight follows the redrawn attic
    const A2 = measureSteps(deriveGeometry(h.props!.plan.options.attic), h.props!.plan)[1]
    expect(h.flights[h.flights.length - 1]).toMatchObject(A2.cam)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Mät nästa' })).toBeTruthy()
  })
})
