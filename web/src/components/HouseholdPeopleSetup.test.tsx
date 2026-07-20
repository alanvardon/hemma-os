// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../lib/testSupabaseMock'

// Real person-identity module + real sync scoping; supabase is the shared mock
// with a small stateful fake of the Stage 1/2 RPCs. Each test activates a fresh
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

type Person = { id: string; slot: 'a' | 'b'; display_name: string }
type ServerView = {
  household_id: string
  my_person_id: string | null
  people: Person[]
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

const ownerSelf = (email = 'me@x.se'): Member[] => [
  { user_id: 'u-me', role: 'owner', email, person_id: null, person_display_name: null },
]
const memberSelf = (email = 'me@x.se'): Member[] => [
  { user_id: 'u-me', role: 'member', email, person_id: null, person_display_name: null },
]

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
  mock().control.user = null
  serverView = { household_id: HH, my_person_id: null, people: [], bindings: {} }
  installFakeRpcs()
  vi.mocked(loadIdentitySuggestions).mockReset().mockResolvedValue([
    suggestion('bolanekoll', 'Bolånekoll', 'Alex', 'Sam'),
    suggestion('hushallsbudget', 'Hushållsbudget', 'Alex', 'Sam'),
    suggestion('manadsavslut', 'Månadsavslut', 'Alex', 'Sam'),
  ])
})

function renderSection(members: Member[] = [], onSaved = vi.fn(), myEmail: string | null = 'me@x.se') {
  render(<HouseholdPeopleSection members={members} myEmail={myEmail} onSaved={onSaved} />)
  return onSaved
}

async function openEditor(user: ReturnType<typeof userEvent.setup>, buttonName = 'Kom igång') {
  await user.click(await screen.findByRole('button', { name: buttonName }))
  await screen.findByRole('button', { name: 'Spara personer' })
}

describe('HouseholdPeopleSection — auto-bind by name', () => {
  it('shows a compact setup prompt and never an unverified Du', async () => {
    renderSection()
    expect(await screen.findByRole('button', { name: 'Kom igång' })).toBeInTheDocument()
    expect(screen.queryByText(/\(du\)/)).not.toBeInTheDocument()
  })

  it('has no separate email input — the login email is not typed', async () => {
    const user = userEvent.setup()
    renderSection(ownerSelf())
    await openEditor(user)
    expect(screen.queryByLabelText(/E-post/)).not.toBeInTheDocument()
  })

  it('auto-binds every tool when all names match and shows NO per-tool selector', async () => {
    const user = userEvent.setup()
    renderSection(ownerSelf())
    await openEditor(user)
    // Every tool matched the canonical names → summarised, never a selector.
    expect(screen.getByText('Verktyg kopplas automatiskt')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByText('Koppla verktygens namn')).not.toBeInTheDocument()
    // Save still gated on explicit review.
    expect(screen.getByRole('button', { name: 'Spara personer' })).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: /kontrollerat namnen/ }))
    expect(screen.getByRole('button', { name: 'Spara personer' })).toBeEnabled()
  })

  it('persists all three auto-resolved bindings and maps the caller by default', async () => {
    const user = userEvent.setup()
    renderSection(ownerSelf())
    await openEditor(user)
    // Owner defaults to Person A — no radio click needed.
    await user.click(screen.getByRole('checkbox', { name: /kontrollerat namnen/ }))
    await user.click(screen.getByRole('button', { name: 'Spara personer' }))
    expect(await screen.findByText('(du)')).toBeInTheDocument()
    expect(Object.keys(serverView.bindings).sort()).toEqual(['bolanekoll', 'hushallsbudget', 'manadsavslut'])
    expect(serverView.bindings.bolanekoll).toEqual({ a: PA, b: PB })
    expect(serverView.my_person_id).toBe(PA)
  })

  it('binds a reversed tool by name without a selector', async () => {
    vi.mocked(loadIdentitySuggestions).mockResolvedValue([
      suggestion('bolanekoll', 'Bolånekoll', 'Alex', 'Sam'),
      // Månadsavslut stores the two people in the opposite order.
      suggestion('manadsavslut', 'Månadsavslut', 'Sam', 'Alex'),
      suggestion('hushallsbudget', 'Hushållsbudget', 'Alex', 'Sam'),
    ])
    const user = userEvent.setup()
    renderSection(ownerSelf())
    await openEditor(user)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: /kontrollerat namnen/ }))
    await user.click(screen.getByRole('button', { name: 'Spara personer' }))
    await screen.findByRole('button', { name: 'Hantera personer' })
    // Reversed order: tool slot A is canonical B and vice versa.
    expect(serverView.bindings.manadsavslut).toEqual({ a: PB, b: PA })
  })
})

describe('HouseholdPeopleSection — conflict tools', () => {
  const conflictSuggestions = () => vi.mocked(loadIdentitySuggestions).mockResolvedValue([
    suggestion('bolanekoll', 'Bolånekoll', 'Alex', 'Sam'),
    suggestion('hushallsbudget', 'Hushållsbudget', 'Alan', 'Partner'),
    suggestion('manadsavslut', 'Månadsavslut', 'Alex', 'Sam'),
  ])

  it('renders exactly one conflict tool selector and blocks Save until resolved', async () => {
    conflictSuggestions()
    const user = userEvent.setup()
    renderSection(ownerSelf())
    await openEditor(user)
    // Only the mismatched tool renders selectors — its two slots, nothing more.
    expect(screen.getAllByRole('combobox')).toHaveLength(2)
    expect(screen.getByText(/Namnen i Hushållsbudget matchar inte/)).toBeInTheDocument()
    expect((screen.getByLabelText('A · Alan') as HTMLSelectElement).value).toBe('')

    await user.click(screen.getByRole('checkbox', { name: /kontrollerat namnen/ }))
    expect(screen.getByRole('button', { name: 'Spara personer' })).toBeDisabled()
    expect(screen.getByText('Välj en person för varje plats innan du sparar.')).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('A · Alan'), 'a')
    await user.selectOptions(screen.getByLabelText('B · Partner'), 'b')
    expect(screen.getByRole('button', { name: 'Spara personer' })).toBeEnabled()
  })

  it('blocks a duplicate mapping within a conflict tool', async () => {
    conflictSuggestions()
    const user = userEvent.setup()
    renderSection(ownerSelf())
    await openEditor(user)
    await user.click(screen.getByRole('checkbox', { name: /kontrollerat namnen/ }))
    await user.selectOptions(screen.getByLabelText('A · Alan'), 'a')
    await user.selectOptions(screen.getByLabelText('B · Partner'), 'a')
    expect(screen.getByText('Samma person kan inte ha båda platserna.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Spara personer' })).toBeDisabled()
  })
})

describe('HouseholdPeopleSection — who am I default + linked email', () => {
  it('defaults the household owner to Person A', async () => {
    const user = userEvent.setup()
    renderSection(ownerSelf())
    await openEditor(user)
    expect(screen.getByRole('radio', { name: /^Alex$/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /^Sam$/ })).not.toBeChecked()
  })

  it('defaults a member to Person B', async () => {
    const user = userEvent.setup()
    renderSection(memberSelf())
    await openEditor(user)
    expect(screen.getByRole('radio', { name: /^Sam$/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /^Alex$/ })).not.toBeChecked()
  })

  it("shows the caller's login email on their slot and a placeholder on the other", async () => {
    const user = userEvent.setup()
    renderSection(ownerSelf('me@x.se'), vi.fn(), 'me@x.se')
    await openEditor(user)
    // Owner defaults to Person A → their login email is shown there.
    expect(screen.getByText(/me@x\.se/)).toBeInTheDocument()
    expect(screen.getByText(/din inloggning/)).toBeInTheDocument()
    // Person B has no account yet.
    expect(screen.getByText('Kopplas när personen loggar in')).toBeInTheDocument()
  })
})

describe('HouseholdPeopleSection — strict write contract', () => {
  it('keeps the editor open with a visible error on save failure and shows no Du', async () => {
    mock().control.failing.add('configure_household_people')
    mock().control.errors.configure_household_people = { message: 'person already claimed', code: 'P0001' }
    const user = userEvent.setup()
    const onSaved = renderSection(ownerSelf())
    await openEditor(user)
    await user.click(screen.getByRole('checkbox', { name: /kontrollerat namnen/ }))
    await user.click(screen.getByRole('button', { name: 'Spara personer' }))

    expect(await screen.findByText('Personen är redan vald av en annan medlem.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Spara personer' })).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.queryByText(/\(du\)/)).not.toBeInTheDocument()
  })

  it('shows no Du after a mid-sequence failure, then succeeds on idempotent retry', async () => {
    // People + bindings save, but claiming "who am I" fails.
    mock().control.failing.add('set_my_household_person')
    mock().control.errors.set_my_household_person = { message: 'mock: rpc failed' }
    const user = userEvent.setup()
    const onSaved = renderSection(ownerSelf())
    await openEditor(user)
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

    const sam = screen.getByRole('radio', { name: /vald av annan medlem/ })
    expect(sam).toBeDisabled()
    expect(screen.getByRole('radio', { name: /^Alex$/ })).toBeChecked()
    expect(screen.queryByText(/\(du\)/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: /kontrollerat namnen/ }))
    await user.click(screen.getByRole('button', { name: 'Spara personer' }))
    expect(await screen.findByText('(du)')).toBeInTheDocument()
    expect(serverView.my_person_id).toBe(PA)
  })

  it('does not re-ask for a tool that is already bound, even when its names differ', async () => {
    // Hushållsbudget stores "Alan/Partner" (≠ canonical Alex/Sam) but already has
    // a saved binding from an earlier setup — it must be treated as resolved.
    vi.mocked(loadIdentitySuggestions).mockResolvedValue([
      suggestion('bolanekoll', 'Bolånekoll', 'Alex', 'Sam'),
      suggestion('hushallsbudget', 'Hushållsbudget', 'Alan', 'Partner'),
      suggestion('manadsavslut', 'Månadsavslut', 'Alex', 'Sam'),
    ])
    const members: Member[] = [
      { user_id: 'u-me', role: 'owner', email: 'me@x.se', person_id: PA, person_display_name: 'Alex' },
    ]
    serverView.my_person_id = PA
    const user = userEvent.setup()
    renderSection(members)
    await openEditor(user, 'Hantera personer')
    // No conflict selector — the saved binding resolved it; it is summarised.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByText('Koppla verktygens namn')).not.toBeInTheDocument()
    expect(screen.getByText('Verktyg kopplas automatiskt')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Spara personer' })).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: /kontrollerat namnen/ }))
    expect(screen.getByRole('button', { name: 'Spara personer' })).toBeEnabled()
  })

  it('renders the mapped person as (du) and its login email from the roster', async () => {
    serverView.my_person_id = PB
    const members: Member[] = [
      { user_id: 'u-me', role: 'member', email: 'sam@x.se', person_id: PB, person_display_name: 'Sam' },
    ]
    renderSection(members, vi.fn(), 'sam@x.se')
    expect(await screen.findByText('Sam')).toBeInTheDocument()
    expect(screen.getByText('(du)')).toBeInTheDocument()
    // Email comes from the roster (the account mapped to Person B), not a typed field.
    expect(screen.getByText(/sam@x\.se/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hantera personer' })).toBeInTheDocument()
  })
})
