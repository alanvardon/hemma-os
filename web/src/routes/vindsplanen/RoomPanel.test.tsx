// @vitest-environment jsdom
// Plan 144: the Room tab's sun controls. Choosing "Real sun" turns the real
// sun on (today's date) and shows the date/time control; the site fields edit
// the shared plan; the preset options keep working and switch the mode back.
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deriveGeometry } from '../../lib/vindsplanen/attic'
import { defaultViewPrefs, examplePlan, type PlanV2, type ViewPrefs } from '../../lib/vindsplanen/plan'
import RoomPanel from './RoomPanel'
import SunControl from './SunControl'
import { todayMonthDay } from './viewPrefs'

afterEach(cleanup)

const geo = deriveGeometry(examplePlan().options.attic)

/** RoomPanel plus the stage's sun control, wired like the route wires them. */
function Harness({ onPlan }: { onPlan?: (p: PlanV2) => void }) {
  const [plan, setPlan] = useState(examplePlan())
  const [view, setView] = useState<ViewPrefs>(defaultViewPrefs(false, '01-15'))
  return (
    <>
      <RoomPanel
        geo={geo}
        plan={plan}
        view={view}
        onView={setView}
        onChange={(p) => {
          setPlan(p)
          onPlan?.(p)
        }}
        onMeasure={() => {}}
      />
      {view.sunMode === 'real' && <SunControl view={view} site={plan.options.site} onView={setView} />}
      <output data-testid="view">{`${view.sunMode}|${view.sun}|${view.sunDate}`}</output>
    </>
  )
}

describe('Real sun in the Room tab', () => {
  it('lists the real sun after the presets and keeps the date/time control hidden until chosen', () => {
    render(<Harness />)
    const select = screen.getByLabelText('Lighting') as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(['morning', 'midday', 'evening', 'overcast', 'night', 'real'])
    expect(screen.queryByLabelText('Time')).toBeNull()
  })

  it('choosing Real sun shows the slider, starting at today’s date', async () => {
    render(<Harness />)
    await userEvent.selectOptions(screen.getByLabelText('Lighting'), 'real')
    expect(screen.getByLabelText('Time')).toHaveAttribute('step', '15')
    expect(screen.getByTestId('view')).toHaveTextContent(`real|morning|${todayMonthDay()}`)
    expect(screen.getByText(/^\d+ \w{3} 12:00 · /)).toBeInTheDocument()
  })

  it('the slider and the date picker move the sun', () => {
    render(<Harness />)
    fireEvent.change(screen.getByLabelText('Lighting'), { target: { value: 'real' } })
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '780' } })
    expect(screen.getByText(/13:00 · /)).toBeInTheDocument()
    const year = new Date().getFullYear()
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: `${year}-12-21` } })
    expect(screen.getByTestId('view')).toHaveTextContent('real|morning|12-21')
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '720' } })
    expect(screen.getByText('21 Dec 12:00 · sun 7° high')).toBeInTheDocument()
    expect(screen.getByText('Sunrise 08:43 · Sunset 14:48')).toBeInTheDocument()
  })

  it('choosing a preset leaves the real sun and hides the control', async () => {
    render(<Harness />)
    await userEvent.selectOptions(screen.getByLabelText('Lighting'), 'real')
    await userEvent.selectOptions(screen.getByLabelText('Lighting'), 'evening')
    expect(screen.getByTestId('view')).toHaveTextContent(/^preset\|evening\|/)
    expect(screen.queryByLabelText('Time')).toBeNull()
  })
})

describe('Sun and site fields', () => {
  it('shows the default house orientation with a compass label', () => {
    render(<Harness />)
    expect(screen.getByLabelText('House orientation')).toHaveValue(90)
    expect(screen.getByLabelText('Latitude')).toHaveValue(59.3)
    expect(screen.getByLabelText('Longitude')).toHaveValue(18)
    expect(screen.getByRole('img', { name: 'The ridge points E' })).toBeInTheDocument()
  })

  it('editing the orientation updates the shared plan once, on commit', async () => {
    const onPlan = vi.fn()
    render(<Harness onPlan={onPlan} />)
    const input = screen.getByLabelText('House orientation')
    await userEvent.clear(input)
    await userEvent.type(input, '0')
    expect(onPlan).not.toHaveBeenCalled() // typing alone is not a change
    await userEvent.tab()
    expect(onPlan).toHaveBeenCalledTimes(1)
    expect(onPlan.mock.calls[0][0].options.site).toEqual({ ridgeBearing: 0, lat: 59.3, lon: 18 })
    expect(screen.getByRole('img', { name: 'The ridge points N' })).toBeInTheDocument()
  })

  it('clamps latitude to one decimal in range and ignores garbage', async () => {
    const onPlan = vi.fn()
    render(<Harness onPlan={onPlan} />)
    const lat = screen.getByLabelText('Latitude')
    await userEvent.clear(lat)
    await userEvent.type(lat, '72.46')
    await userEvent.tab()
    expect(onPlan.mock.calls[0][0].options.site.lat).toBe(69)
    const lon = screen.getByLabelText('Longitude')
    await userEvent.clear(lon)
    await userEvent.tab()
    expect(onPlan).toHaveBeenCalledTimes(1)
    await userEvent.clear(lon)
    await userEvent.type(lon, '17.54{Enter}')
    expect(onPlan.mock.calls[1][0].options.site.lon).toBe(17.5)
  })
})
