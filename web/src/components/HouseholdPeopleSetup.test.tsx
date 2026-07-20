// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '../lib/testSupabaseMock'

// Real person-identity module + real sync scoping; supabase is the shared mock
// with a small stateful fake of the identity RPCs. Each test activates a fresh
// (user, household) sync identity so module state can never leak across tests.
const holder = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof createSupabaseMock> }))
vi.mock('../lib/supabase', () => {
  holder.current = createSupabaseMock()
  return { supabase: holder.current.supabase }
})
const mock = () => holder.current

import HouseholdPeopleSection from './HouseholdPeopleSetup'
import { activateSyncIdentity } from '../lib/sync'
import type { Invite, Member } from '../lib/household'

const HH = '00000000-aaaa-4aaa-8aaa-000000000001'
const PA = '11111111-1111-4111-8111-111111111111'
const PB = '22222222-2222-4222-8222-222222222222'

const NAMES: Record<string, string> = { 'me@x.se': 'Alan', 'partner@x.se': 'Sam' }
const nameFor = (email: string | null) => (email ? NAMES[email] ?? email : null)

type Person = { id: string; slot: 'a' | 'b'; display_name: string; assigned_email: string | null }
type ServerView = { household_id: string; my_person_id: string | null; my_profile_name: string | null; people: Person[] }
let serverView: ServerView
const callerEmail = 'me@x.se'

function installFakeRpcs() {
  mock().control.rpcHandlers.household_identity = () => structuredClone(serverView)
  mock().control.rpcHandlers.assign_household_people = (raw) => {
    const { p_slot_a_email, p_slot_b_email } = raw as Record<string, string | null>
    serverView.people = [
      { id: PA, slot: 'a', display_name: nameFor(p_slot_a_email) ?? 'Person A', assigned_email: p_slot_a_email ?? null },
      { id: PB, slot: 'b', display_name: nameFor(p_slot_b_email) ?? 'Person B', assigned_email: p_slot_b_email ?? null },
    ]
    serverView.my_person_id = p_slot_a_email === callerEmail ? PA : p_slot_b_email === callerEmail ? PB : null
    return structuredClone(serverView)
  }
}

const members: Member[] = [
  { user_id: 'u-me', role: 'owner', email: 'me@x.se', display_name: 'Alan', slot: null },
  { user_id: 'u-p', role: 'member', email: 'partner@x.se', display_name: 'Sam', slot: null },
]
const invites: Invite[] = [{ email: 'invitee@x.se', created_at: '2026-01-01' }]

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
  serverView = { household_id: HH, my_person_id: null, my_profile_name: null, people: [] }
  installFakeRpcs()
})

function renderSection(
  memberList: Member[] = members,
  inviteList: Invite[] = invites,
  onSaved = vi.fn(),
  myEmail: string | null = 'me@x.se',
) {
  render(<HouseholdPeopleSection members={memberList} invites={inviteList} myEmail={myEmail} onSaved={onSaved} />)
  return onSaved
}

async function openEditor(user: ReturnType<typeof userEvent.setup>, buttonName = 'Kom igång') {
  await user.click(await screen.findByRole('button', { name: buttonName }))
  await screen.findByRole('button', { name: 'Spara personer' })
}

describe('HouseholdPeopleSection — assignment via dropdown', () => {
  it('shows a compact prompt and no Du before anyone is assigned', async () => {
    renderSection()
    expect(await screen.findByRole('button', { name: 'Kom igång' })).toBeInTheDocument()
    expect(screen.queryByText('(du)')).not.toBeInTheDocument()
  })

  it('lists members and pending invites as options, and no typed name field', async () => {
    const user = userEvent.setup()
    renderSection()
    await openEditor(user)
    expect(screen.getByLabelText('Person A')).toBeInTheDocument()
    expect(screen.getByLabelText('Person B')).toBeInTheDocument()
    // Options include the caller (marked du), the partner, and the invite —
    // each present in both slot selects.
    expect(screen.getAllByRole('option', { name: 'Alan (du)' })).toHaveLength(2)
    expect(screen.getAllByRole('option', { name: 'Sam' })).toHaveLength(2)
    expect(screen.getAllByRole('option', { name: 'invitee@x.se (inbjuden)' })).toHaveLength(2)
    // No free-text name inputs any more.
    expect(screen.queryByLabelText(/namn/i)).not.toBeInTheDocument()
  })

  it('assigns the two accounts and marks the caller as Du', async () => {
    const user = userEvent.setup()
    const onSaved = renderSection()
    await openEditor(user)
    await user.selectOptions(screen.getByLabelText('Person A'), 'me@x.se')
    await user.selectOptions(screen.getByLabelText('Person B'), 'partner@x.se')
    // The resolved-Du line appears live.
    expect(screen.getByText(/Du: Alan — Person A/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Spara personer' }))

    expect(await screen.findByText('(du)')).toBeInTheDocument()
    expect(serverView.people.map((p) => p.assigned_email)).toEqual(['me@x.se', 'partner@x.se'])
    expect(serverView.my_person_id).toBe(PA)
    expect(onSaved).toHaveBeenCalled()
  })

  it('can pre-assign an invited email to Person B', async () => {
    const user = userEvent.setup()
    renderSection()
    await openEditor(user)
    await user.selectOptions(screen.getByLabelText('Person A'), 'me@x.se')
    await user.selectOptions(screen.getByLabelText('Person B'), 'invitee@x.se')
    await user.click(screen.getByRole('button', { name: 'Spara personer' }))
    await screen.findByRole('button', { name: 'Hantera personer' })
    expect(serverView.people[1].assigned_email).toBe('invitee@x.se')
  })

  it('blocks Save when both slots are the same account', async () => {
    const user = userEvent.setup()
    renderSection()
    await openEditor(user)
    await user.selectOptions(screen.getByLabelText('Person A'), 'me@x.se')
    await user.selectOptions(screen.getByLabelText('Person B'), 'me@x.se')
    expect(screen.getByText('Person A och Person B kan inte vara samma konto.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Spara personer' })).toBeDisabled()
  })
})

describe('HouseholdPeopleSection — strict write contract', () => {
  it('keeps the editor open with a visible error on save failure and shows no Du', async () => {
    mock().control.failing.add('assign_household_people')
    mock().control.errors.assign_household_people = { message: 'unknown person email', code: 'P0001' }
    const user = userEvent.setup()
    const onSaved = renderSection()
    await openEditor(user)
    await user.selectOptions(screen.getByLabelText('Person A'), 'me@x.se')
    await user.click(screen.getByRole('button', { name: 'Spara personer' }))

    expect(await screen.findByText('E-postadressen tillhör inte hushållet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Spara personer' })).toBeInTheDocument()
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.queryByText('(du)')).not.toBeInTheDocument()
  })
})

describe('HouseholdPeopleSection — configured summary', () => {
  beforeEach(() => {
    serverView = {
      household_id: HH,
      my_person_id: PB,
      my_profile_name: 'Sam',
      people: [
        { id: PA, slot: 'a', display_name: 'Alan', assigned_email: 'me@x.se' },
        { id: PB, slot: 'b', display_name: 'Sam', assigned_email: 'partner@x.se' },
      ],
    }
    installFakeRpcs()
  })

  it('renders both people, the caller as (du), and the assigned email', async () => {
    renderSection(members, invites, vi.fn(), 'partner@x.se')
    expect(await screen.findByText('Alan')).toBeInTheDocument()
    expect(screen.getByText('Sam')).toBeInTheDocument()
    expect(screen.getByText('(du)')).toBeInTheDocument()
    expect(screen.getByText(/partner@x\.se/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hantera personer' })).toBeInTheDocument()
  })
})
