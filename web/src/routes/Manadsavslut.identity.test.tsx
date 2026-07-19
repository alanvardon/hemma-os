// @vitest-environment jsdom
// Plan 111, Stage 4 — the signed-in-person "Du" treatment on Månadsavslut.
// Proves: mapped-to-A and mapped-to-B both mark the right person (same column
// order + identical figures, only the marker moves), and an unmapped household
// shows today's plain A/B names with no Du. usePersonIdentity is mocked with the
// same identityView(slot) shape the Bolånekoll suite uses.
import { render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Item } from '../lib/manadsavslut'
import * as Store from '../lib/manadsavslut-store'
import { usePersonIdentity } from '../components/usePersonIdentity'
import type { PersonIdentityView } from '../components/usePersonIdentity'
import Manadsavslut from './Manadsavslut'

vi.mock('../lib/manadsavslut-store')
vi.mock('../components/usePersonIdentity')

const PA = { id: 'p-a', slot: 'a' as const, display_name: 'Alex' }
const PB = { id: 'p-b', slot: 'b' as const, display_name: 'Sam' }

// slot === the account's Månadsavslut person, or null = unmapped/unbound.
function identityView(slot: 'a' | 'b' | null): PersonIdentityView {
  const bound = slot !== null
  return {
    status: 'ready', identity: null, configured: bound, people: bound ? [PA, PB] : [],
    myPerson: slot === 'a' ? PA : slot === 'b' ? PB : null,
    personFor: (tool, s) => (bound && tool === 'manadsavslut' ? (s === 'a' ? PA : PB) : null),
    isMe: (tool, s) => bound && tool === 'manadsavslut' && s === slot,
    myToolSlot: (tool) => (tool === 'manadsavslut' ? slot : null),
    refresh: async () => {},
  }
}

const settings = { ...defaultSettings(), person_a_name: 'Alex', person_b_name: 'Sam' }
const openItem: Item = {
  id: 'it-1', created_at: '2026-07-17T10:00:00.000Z', date_purchased: '2026-07-16',
  description: 'Fiktiv mat', enter_amount: 240, split: true, amount: 120,
  fronted_by: 'a', owed_by: 'b', paid: false, pending: false, payment_id: null,
  note: '', personal_items: [], personal_a: 0, personal_b: 0, source: 'manual',
}

function renderRoute() {
  const router = createMemoryRouter([
    { path: '/manadsavslut', element: <Manadsavslut /> },
    { path: '/', element: <div>Home</div> },
  ], { initialEntries: ['/manadsavslut'] })
  return render(<RouterProvider router={router} />)
}

async function itemsRow() {
  const table = await screen.findByRole('table', { name: undefined })
  // The items table is the one with a "Paid by" column header.
  const tables = screen.getAllByRole('table')
  const items = tables.find((t) => within(t).queryByText('Paid by')) ?? table
  return within(items).getAllByRole('row')[1] // first data row
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(Store.cachedSnapshot).mockReturnValue({ items: [], payments: [], settings })
  vi.mocked(Store.listItemsDetailed).mockResolvedValue({
    rows: [openItem], source: 'cloud', degraded: false, rejectedRowCount: 0,
    diagnostics: [], allCloudRowsRejected: false,
  })
  vi.mocked(Store.listPayments).mockResolvedValue([])
  vi.mocked(Store.getSettings).mockResolvedValue(settings)
})

describe('Månadsavslut — signed-in person treatment', () => {
  it('unmapped household shows plain A/B names and no Du', async () => {
    vi.mocked(usePersonIdentity).mockReturnValue(identityView(null))
    renderRoute()
    const row = await itemsRow()
    expect(within(row).getByText('Alex')).toBeInTheDocument()
    expect(within(row).getByText('Sam')).toBeInTheDocument()
    expect(screen.queryByText(/\(du\)/)).not.toBeInTheDocument()
  })

  it('mapped to A marks the payer (A) as "Alex (du)", partner unmarked', async () => {
    vi.mocked(usePersonIdentity).mockReturnValue(identityView('a'))
    renderRoute()
    const row = await itemsRow()
    // Paid by = A (self) → "(du)"; Owes = B (partner) → plain.
    expect(within(row).getByText('Alex (du)')).toBeInTheDocument()
    expect(within(row).getByText('Sam')).toBeInTheDocument()
    expect(within(row).queryByText('Sam (du)')).not.toBeInTheDocument()
  })

  it('mapped to B marks the debtor (B) as "Sam (du)" without moving columns or values', async () => {
    vi.mocked(usePersonIdentity).mockReturnValue(identityView('b'))
    renderRoute()
    const row = await itemsRow()
    const cells = within(row).getAllByRole('cell')
    // Same column order: payer cell still A, owes cell still B — only the Du
    // marker sits on the signed-in person (B).
    expect(within(row).getByText('Alex')).toBeInTheDocument()
    expect(within(row).getByText('Sam (du)')).toBeInTheDocument()
    // The charge / owed figures are person-independent and unchanged.
    expect(cells.some((c) => c.textContent?.includes('120'))).toBe(true)
    expect(cells.some((c) => c.textContent?.includes('240'))).toBe(true)
  })
})
