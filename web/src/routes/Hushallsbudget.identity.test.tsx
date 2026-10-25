// @vitest-environment jsdom
// Plan 111, Stage 4 — the signed-in-person "Du" treatment on Hushållsbudget.
// Proves mapped-to-A and mapped-to-B both mark the right comparison column
// (stable A-then-B order, self column tinted + "Du") and that an unmapped
// household shows plain A/B names with no Du. usePersonIdentity and the stores
// are mocked; computeBudget/defaultState stay real.
import { render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultState } from '../lib/hushallsbudget'
import * as budgetStore from '../lib/hushallsbudget-store'
import * as salaryStore from '../lib/salary-store'
import * as draftsStore from '../lib/salary-drafts-store'
import { usePersonIdentity } from '../components/usePersonIdentity'
import type { PersonIdentityView } from '../components/usePersonIdentity'
import Hushallsbudget from './Hushallsbudget'

vi.mock('../lib/hushallsbudget-store')
vi.mock('../lib/mortgage-store', () => ({ loadMortgageSyncSnapshot: () => Promise.resolve(null) }))
vi.mock('../lib/salary-store')
vi.mock('../lib/salary-drafts-store')
vi.mock('../components/usePersonIdentity')
// visx charts need a real ResizeObserver (absent in jsdom) — stub the donut.
vi.mock('../components/charts/BudgetDonutChart', () => ({ default: () => null }))

const PA = { id: 'p-a', slot: 'a' as const, display_name: 'Alex', assigned_email: null }
const PB = { id: 'p-b', slot: 'b' as const, display_name: 'Sam', assigned_email: null }

function identityView(slot: 'a' | 'b' | null): PersonIdentityView {
  const bound = slot !== null
  return {
    status: 'ready', identity: null, configured: bound, people: bound ? [PA, PB] : [],
    myPerson: slot === 'a' ? PA : slot === 'b' ? PB : null,
    personFor: (tool, s) => (bound && tool === 'hushallsbudget' ? (s === 'a' ? PA : PB) : null),
    isMe: (tool, s) => bound && tool === 'hushallsbudget' && s === slot,
    myToolSlot: (tool) => (tool === 'hushallsbudget' ? slot : null),
    refresh: async () => {},
  }
}

function renderRoute() {
  const router = createMemoryRouter([
    { path: '/hushallsbudget', element: <Hushallsbudget /> },
    { path: '/', element: <div>Home</div> },
  ], { initialEntries: ['/hushallsbudget'] })
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  const state = { ...defaultState(), people: ['Alex', 'Sam'] }
  vi.mocked(budgetStore.loadBudget).mockResolvedValue(state)
  vi.mocked(budgetStore.saveBudget).mockResolvedValue(undefined)
  vi.mocked(salaryStore.list).mockResolvedValue([])
  vi.mocked(draftsStore.listDrafts).mockResolvedValue([])
})

async function compareHead(pos: 0 | 1) {
  const heads = await screen.findAllByText((_c, el) => el?.classList.contains('compare-head') ?? false)
  return heads[pos] as HTMLElement
}

describe('Hushållsbudget — signed-in person treatment', () => {
  it('unmapped household shows plain A/B names and no Du', async () => {
    vi.mocked(usePersonIdentity).mockReturnValue(identityView(null))
    renderRoute()
    expect((await compareHead(0)).textContent).toContain('Alex')
    expect((await compareHead(1)).textContent).toContain('Sam')
    expect(screen.queryByText('Du')).not.toBeInTheDocument()
  })

  it('mapped to A tints + marks the A column, keeps A first', async () => {
    vi.mocked(usePersonIdentity).mockReturnValue(identityView('a'))
    renderRoute()
    const a = await compareHead(0)
    const b = await compareHead(1)
    expect(a.className).toContain('is-self')
    expect(a.textContent).toContain('Alex')
    expect(a.textContent).toContain('Du')
    expect(b.className).not.toContain('is-self')
    expect(b.textContent).toContain('Sam')
    expect(b.textContent).not.toContain('Du')
    expect(a.querySelector('.person-avatar')).not.toBeInTheDocument()
    expect(b.querySelector('.person-avatar')).not.toBeInTheDocument()
  })

  it('mapped to B marks the B column with the same treatment, no column move', async () => {
    vi.mocked(usePersonIdentity).mockReturnValue(identityView('b'))
    renderRoute()
    const a = await compareHead(0)
    const b = await compareHead(1)
    // A is still first and unmarked; B is the self column.
    expect(a.textContent).toContain('Alex')
    expect(a.className).not.toContain('is-self')
    expect(b.className).toContain('is-self')
    expect(b.textContent).toContain('Sam')
    expect(b.textContent).toContain('Du')
  })
})

// Plan 139: salaries moved to Löner; Hushållsbudget keeps a compact status row.
describe('Hushållsbudget — Löner link row', () => {
  it('links to /loner with the month status and no longer hosts the salary modal, history or reminder card', async () => {
    vi.mocked(usePersonIdentity).mockReturnValue(identityView(null))
    renderRoute()
    const row = (await screen.findByText(/^Löner för /)).closest('.salary-link-row') as HTMLElement
    expect(within(row).getByText('Ej inskickad')).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: 'Öppna Löner' })).toHaveAttribute('href', '/loner')
    expect(screen.queryByRole('button', { name: /submit this month/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'History' })).not.toBeInTheDocument()
    expect(screen.queryByText(/monthly salary reminder/i)).not.toBeInTheDocument()
  })

  it('shows who the month is waiting on once one half is in, never a transfer figure', async () => {
    vi.mocked(usePersonIdentity).mockReturnValue(identityView(null))
    vi.mocked(draftsStore.listDrafts).mockResolvedValue([{
      month: new Date().toISOString().slice(0, 7), slot: 'b', income_items: [{ label: 'Lön', amount: 38900 }],
      note: null, submitted_via: 'email', updated_at: '2026-10-03T08:00:00.123456+00:00',
    }])
    renderRoute()
    const row = (await screen.findByText(/^Löner för /)).closest('.salary-link-row') as HTMLElement
    expect(within(row).getByText('Väntar på Alex')).toBeInTheDocument()
  })
})
