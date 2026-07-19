// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../lib/testSupabaseMock'

// Real person-identity module + real sync scoping; supabase is the shared mock
// with a small stateful fake of the Stage 1 RPCs. Each test activates a fresh
// (user, household) sync identity so module state can never leak across tests.
const holder = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof createSupabaseMock> }))
vi.mock('../lib/supabase', () => {
  holder.current = createSupabaseMock()
  return { supabase: holder.current.supabase }
})
const mock = () => holder.current

vi.mock('../lib/person-identity-suggestions', async () => {
  const actual = await vi.importActual<typeof import('../lib/person-identity-suggestions')>('../lib/person-identity-suggestions')
  return { IDENTITY_TOOL_LABELS: actual.IDENTITY_TOOL_LABELS, loadIdentitySuggestions: vi.fn() }
})

import HouseholdPeopleSection from './HouseholdPeopleSetup'
import { loadIdentitySuggestions } from '../lib/person-identity-suggestions'
import { activateSyncIdentity } from '../lib/sync'
import type { Member } from '../lib/household'

const HH = '00000000-aaaa-4aaa-8aaa-000000000001'
const PA = '11111111-1111-4111-8111-111111111111'
const PB = '22222222-2222-4222-8222-222222222222'

type ServerView = {
  household_id: string
  my_person_id: string | null
  people: { id: string; slot: 'a' | 'b'; display_name: string }[]
  bindings: Record<string, { a: string; b: string }>
}
let serverView: ServerView

function installFakeRpcs() {
  mock().control.rpcHandlers.household_identity = () => structuredClone(serverView)
  mock().control.rpcHandlers.configure_household_people = (raw) => {
    const args = raw as Record<string, string | null>
    serverView.people = [
      { id: PA, slot: 'a', display_name: String(args.p_person_a_name) },
      { id: PB, slot: 'b', display_name: String(args.p_person_b_name) },
    ]
    if (args.p_tool) {
      const idOf = (slot: string | null) => (slot === 'a' ? PA : PB)
      serverView.bindings[args.p_tool] = {
        a: idOf(args.p_tool_slot_a_person),
        b: idOf(args.p_tool_slot_b_person),
      }
    }
    return structuredClone(serverView)
  }
  mock().control.rpcHandlers.set_my_household_person = (raw) => {
    serverView.my_person_id = (raw as { p_person_id: string | null }).p_person_id
    return null
  }
}

const suggestion = (tool: 'bolanekoll' | 'hushallsbudget' | 'manadsavslut', label: string, a: string, b: string) =>
  ({ tool, label, a, b })

let sequence = 0
beforeEach(() => {
  localStorage.clear()
  sequence += 1
  activateSyncIdentity({ userId: `user-${sequence}`, householdId: `house-${sequence}` })
  Object.keys(mock().tables).forEach((k) => delete mock().tables[k])
  mock().control.fail = false
  mock().control.failing.clear()
  mock().control.errors = {}
  mock().control.rpcHandlers = {}
  serverView = { household_id: HH, my_person_id: null, people: [], bindings: {} }
  installFakeRpcs()
  vi.mocked(loadIdentitySuggestions).mockReset().mockResolvedValue([
    suggestion('bolanekoll', 'Bolånekoll', 'Alex', 'Sam'),
    suggestion('hushallsbudget', 'Hushållsbudget', 'Alex', 'Sam'),
    suggestion('manadsavslut', 'Månadsavslut', 'Alex', 'Sam'),
  ])
})

function renderSection(members: Member[] = [], onSaved = vi.fn()) {
  render(<HouseholdPeopleSection members={members} myEmail="me@x.se" onSaved={onSaved} />)
  return onSaved
}

async function openEditor(user: ReturnType<typeof userEvent.setup>, buttonName = 'Kom igång') {
  await user.click(await screen.findByRole('button', { name: buttonName }))
  await screen.findByRole('button', { name: 'Spara personer' })
}

describe('HouseholdPeopleSection — unconfigured household', () => {
  it('shows a compact setup prompt and never an unverified Du', async () => {
    renderSection()
    expect(await screen.findByRole('button', { name: 'Kom igång' })).toBeInTheDocument()
    expect(screen.queryByText(/\(du\)/)).not.toBeInTheDocument()
  })

  it('preselects exact-name matches but requires explicit review before Save', async () => {
    const user = userEvent.setup()
    renderSection()
    await openEditor(user)
    // All three tools matched Alex/Sam exactly → preselected…
    for (const select of screen.getAllByRole('combobox')) {
      expect((select as HTMLSelectElement).value).not.toBe('')
    }
    // …but Save stays disabled until the review checkbox is ticked.
    expect(screen.getByRole('button', { name: 'Spara personer' })).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: /kontrollerat namnen/ }))
    expect(screen.getByRole('button', { name: 'Spara personer' })).toBeEnabled()
  })

  it('shows cross-tool name conflicts and leaves unmatched tools unselected', async () => {
    vi.mocked(loadIdentitySuggestions).mockResolvedValue([
      suggestion('bolanekoll', 'Bolånekoll', 'Alex', 'Sam'),
      suggestion('hushallsbudget', 'Hushållsbudget', 'Alan', 'Partner'),
      suggestion('manadsavslut', 'Månadsavslut', 'Alex', 'Sam'),
    ])
    const user = userEvent.setup()
    renderSection()
    await openEditor(user)
    expect(screen.getByText(/Verktygen använder olika namn/)).toBeInTheDocument()
    expect((screen.getByLabelText('A · Alan') as HTMLSelectElement).value).toBe('')
    expect((screen.getByLabelText('B · Partner') as HTMLSelectElement).value).toBe('')
    // Incomplete mapping cannot be saved even after review.
    await user.click(screen.getByRole('checkbox', { name: /kontrollerat namnen/ }))
    expect(screen.getByRole('button', { name: 'Spara personer' })).toBeDisabled()
    expect(screen.getByText('Välj en person för varje plats innan du sparar.')).toBeInTheDocument()
  })

  it('blocks saving a duplicate mapping and says why', async () => {
    const user = userEvent.setup()
    renderSection()
    await openEditor(user)
    await user.click(screen.getByRole('checkbox', { name: /kontrollerat namnen/ }))
    // Point Bolånekoll slot B at the same person as slot A.
    await user.selectOptions(screen.getAllByLabelText('B · Sam')[0], 'a')
    expect(screen.getByText('Samma person kan inte ha båda platserna.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Spara personer' })).toBeDisabled()
    // Fixing it re-enables Save.
    await user.selectOptions(screen.getAllByLabelText('B · Sam')[0], 'b')
    expect(screen.getByRole('button', { name: 'Spara personer' })).toBeEnabled()
  })

  it('keeps the editor open with a visible error on save failure and shows no Du', async () => {
    mock().control.failing.add('configure_household_people')
    mock().control.errors.configure_household_people = { message: 'person already claimed', code: 'P0001' }
    const user = userEvent.setup()
    const onSaved = renderSection()
    await openEditor(user)
    await user.click(screen.getByRole('checkbox', { name: /kontrollerat namnen/ }))
    await user.click(screen.getByRole('button', { name: 'Spara personer' }))

    expect(await screen.findByText('Personen är redan vald av en annan medlem.')).toBeInTheDocument()
    // The user actually sees the failure: dialog section still in edit mode…
    expect(screen.getByRole('button', { name: 'Spara personer' })).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
    // …and no optimistic mapped state anywhere.
    expect(screen.queryByText(/\(du\)/)).not.toBeInTheDocument()
  })

  it('shows no Du after a mid-sequence failure, then succeeds on idempotent retry', async () => {
    // People + bindings save, but claiming "who am I" fails.
    mock().control.failing.add('set_my_household_person')
    mock().control.errors.set_my_household_person = { message: 'mock: rpc failed' }
    const user = userEvent.setup()
    const onSaved = renderSection()
    await openEditor(user)
    await user.click(screen.getByRole('radio', { name: /^Alex$/ }))
    await user.click(screen.getByRole('checkbox', { name: /kontrollerat namnen/ }))
    await user.click(screen.getByRole('button', { name: 'Spara personer' }))

    expect(await screen.findByText('Kunde inte spara ändringen. Försök igen.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Spara personer' })).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.queryByText(/\(du\)/)).not.toBeInTheDocument()

    // Retry with the failure gone: the idempotent sequence completes and the
    // Du marker appears only from the server-confirmed view.
    mock().control.failing.delete('set_my_household_person')
    await user.click(screen.getByRole('button', { name: 'Spara personer' }))
    expect(await screen.findByText('(du)')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Spara personer' })).not.toBeInTheDocument()
    expect(screen.getByText('Alex')).toBeInTheDocument()
    expect(screen.getByText('Sam')).toBeInTheDocument()
    expect(onSaved).toHaveBeenCalledOnce()
    expect(serverView.my_person_id).toBe(PA)
    expect(Object.keys(serverView.bindings).sort()).toEqual(['bolanekoll', 'hushallsbudget', 'manadsavslut'])
  })
})

describe('HouseholdPeopleSection — configured household', () => {
  beforeEach(() => {
    serverView = {
      household_id: HH,
      my_person_id: null,
      people: [
        { id: PA, slot: 'a', display_name: 'Alex' },
        { id: PB, slot: 'b', display_name: 'Sam' },
      ],
      bindings: {
        bolanekoll: { a: PA, b: PB },
        hushallsbudget: { a: PA, b: PB },
        manadsavslut: { a: PA, b: PB },
      },
    }
    installFakeRpcs()
  })

  it('suggests the one unclaimed person to an invited account and blocks claimed people', async () => {
    const members: Member[] = [
      { user_id: 'u-me', role: 'member', email: 'me@x.se', person_id: null, person_display_name: null },
      { user_id: 'u-owner', role: 'owner', email: 'owner@x.se', person_id: PB, person_display_name: 'Sam' },
    ]
    const user = userEvent.setup()
    renderSection(members)
    expect(await screen.findByText('Du har inte valt vem du är ännu.')).toBeInTheDocument()
    await openEditor(user, 'Hantera personer')

    // Sam is claimed by the owner — not selectable; Alex is suggested, but
    // still requires review + save (confirmation) to take effect.
    const sam = screen.getByRole('radio', { name: /vald av annan medlem/ })
    expect(sam).toBeDisabled()
    expect(screen.getByRole('radio', { name: /^Alex$/ })).toBeChecked()
    expect(screen.queryByText(/\(du\)/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: /kontrollerat namnen/ }))
    await user.click(screen.getByRole('button', { name: 'Spara personer' }))
    expect(await screen.findByText('(du)')).toBeInTheDocument()
    expect(serverView.my_person_id).toBe(PA)
  })

  it('renders the mapped person as (du) straight from the server view', async () => {
    serverView.my_person_id = PB
    renderSection()
    expect(await screen.findByText('Sam')).toBeInTheDocument()
    expect(screen.getByText('(du)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hantera personer' })).toBeInTheDocument()
  })
})
