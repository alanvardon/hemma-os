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

type Person = { id: string; slot: 'a' | 'b'; display_name: string; login_email?: string | null }
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
      { id: PA, slot: 'a', display_name: String(args.p_person_a_name), login_email: args.p_person_a_email ?? null },
      { id: PB, slot: 'b', display_name: String(args.p_person_b_name), login_email: args.p_person_b_email ?? null },
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
  // Mirrors the server: map the caller to the person whose login_email equals
  // the caller's OWN auth email, only when unclaimed. Always returns the view.
  mock().control.rpcHandlers.claim_my_household_person_by_email = () => {
    const callerEmail = mock().control.user?.email?.toLowerCase()
    if (callerEmail && serverView.my_person_id === null) {
      const match = serverView.people.find((p) => (p.login_email ?? '').toLowerCase() === callerEmail)
      if (match) serverView.my_person_id = match.id
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

const emailInputs = () => screen.getAllByLabelText('E-post (valfritt)') as HTMLInputElement[]

describe('HouseholdPeopleSection — auto-bind by name', () => {
  it('shows a compact setup prompt and never an unverified Du', async () => {
    renderSection()
    expect(await screen.findByRole('button', { name: 'Kom igång' })).toBeInTheDocument()
    expect(screen.queryByText(/\(du\)/)).not.toBeInTheDocument()
  })

  it('auto-binds every tool when all names match and shows NO per-tool selector', async () => {
    const user = userEvent.setup()
    renderSection()
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

  it('persists all three auto-resolved bindings on save', async () => {
    const user = userEvent.setup()
    renderSection()
    await openEditor(user)
    await user.click(screen.getByRole('radio', { name: /^Alex$/ }))
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
    renderSection()
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
    renderSection()
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
    renderSection()
    await openEditor(user)
    await user.click(screen.getByRole('checkbox', { name: /kontrollerat namnen/ }))
    await user.selectOptions(screen.getByLabelText('A · Alan'), 'a')
    await user.selectOptions(screen.getByLabelText('B · Partner'), 'a')
    expect(screen.getByText('Samma person kan inte ha båda platserna.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Spara personer' })).toBeDisabled()
  })
})

describe('HouseholdPeopleSection — "Vem är du?" resolution', () => {
  it('resolves Du from a matching account email and hides the manual radio', async () => {
    mock().control.user = { id: 'u-me', email: 'me@x.se' }
    const user = userEvent.setup()
    renderSection([], vi.fn(), 'me@x.se')
    await openEditor(user)
    await user.type(emailInputs()[0], 'me@x.se')
    expect(await screen.findByText(/Du: Alex — via din e-post/)).toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: /kontrollerat namnen/ }))
    await user.click(screen.getByRole('button', { name: 'Spara personer' }))
    expect(await screen.findByText('(du)')).toBeInTheDocument()
    // Mapped by email, not by the manual radio.
    expect(serverView.my_person_id).toBe(PA)
    expect(serverView.people[0].login_email).toBe('me@x.se')
  })

  it('shows the manual radio when no entered email matches the account', async () => {
    const user = userEvent.setup()
    renderSection([], vi.fn(), 'me@x.se')
    await openEditor(user)
    expect(screen.getByRole('radio', { name: /^Alex$/ })).toBeInTheDocument()
    expect(screen.queryByText(/via din e-post/)).not.toBeInTheDocument()
  })
})

describe('HouseholdPeopleSection — email validation', () => {
  it('blocks Save and shows a Swedish error for an invalid email', async () => {
    const user = userEvent.setup()
    renderSection()
    await openEditor(user)
    await user.type(emailInputs()[0], 'not-an-email')
    await user.click(screen.getByRole('checkbox', { name: /kontrollerat namnen/ }))
    expect(screen.getByText('Ange en giltig e-postadress.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Spara personer' })).toBeDisabled()
  })

  it('blocks Save when both people share an email', async () => {
    const user = userEvent.setup()
    renderSection()
    await openEditor(user)
    await user.type(emailInputs()[0], 'shared@x.se')
    await user.type(emailInputs()[1], 'shared@x.se')
    await user.click(screen.getByRole('checkbox', { name: /kontrollerat namnen/ }))
    expect(screen.getByText('Personerna kan inte dela e-postadress.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Spara personer' })).toBeDisabled()
  })

  it('maps a server "email already used" rejection to Swedish and keeps the editor open', async () => {
    mock().control.failing.add('configure_household_people')
    mock().control.errors.configure_household_people = { message: 'email already used', code: 'P0001' }
    const user = userEvent.setup()
    const onSaved = renderSection()
    await openEditor(user)
    await user.type(emailInputs()[0], 'taken@x.se')
    await user.click(screen.getByRole('checkbox', { name: /kontrollerat namnen/ }))
    await user.click(screen.getByRole('button', { name: 'Spara personer' }))
    expect(await screen.findByText('E-postadressen används redan av en annan person.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Spara personer' })).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.queryByText(/\(du\)/)).not.toBeInTheDocument()
  })
})

describe('HouseholdPeopleSection — strict write contract', () => {
  it('keeps the editor open with a visible error on save failure and shows no Du', async () => {
    mock().control.failing.add('configure_household_people')
    mock().control.errors.configure_household_people = { message: 'person already claimed', code: 'P0001' }
    const user = userEvent.setup()
    const onSaved = renderSection()
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
        { id: PA, slot: 'a', display_name: 'Alex', login_email: null },
        { id: PB, slot: 'b', display_name: 'Sam', login_email: null },
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

  it('renders the mapped person as (du) and its email straight from the server view', async () => {
    serverView.my_person_id = PB
    serverView.people[1].login_email = 'sam@x.se'
    renderSection()
    expect(await screen.findByText('Sam')).toBeInTheDocument()
    expect(screen.getByText('(du)')).toBeInTheDocument()
    expect(screen.getByText(/sam@x\.se/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hantera personer' })).toBeInTheDocument()
  })
})
