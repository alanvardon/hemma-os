// HouseholdPeopleSetup — the "Personer i hushållet" section of the household
// dialog (plan 111). The household's two people (Person A / Person B) are each
// assigned an account, chosen from a dropdown of the household's members and
// pending invites — no names are typed here (a person's name is their own
// profile name, set beside their email). Any member may assign both; the
// signed-in account is "du" for the slot carrying its own email. Tools map by
// position, so there is no per-tool step. Save is one idempotent server call —
// no optimistic "Du", a failure keeps the editor open with a retryable error.
import { useId, useState } from 'react'
import type { Invite, Member } from '../lib/household'
import {
  assignHouseholdPeople,
  identityErrorMessage,
  refreshHouseholdIdentity,
  type CanonicalSlot,
} from '../lib/person-identity'
import { usePersonIdentity } from './usePersonIdentity'

type EditorPhase = 'closed' | 'open'

interface Option { email: string; label: string }

interface Props {
  members: Member[]
  invites: Invite[]
  myEmail: string | null
  /** Called after a successful save so the parent can refresh the roster. */
  onSaved: () => void
}

export default function HouseholdPeopleSection({ members, invites, myEmail, onSaved }: Props) {
  const identityView = usePersonIdentity()
  const { identity, configured } = identityView
  const idPrefix = useId()

  const [editor, setEditor] = useState<EditorPhase>('closed')
  const [emailA, setEmailA] = useState('')
  const [emailB, setEmailB] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const callerEmail = (myEmail ?? '').trim().toLowerCase()

  // Assignable accounts: household members (with their resolved name) + pending
  // invites (email only, until they join). Deduped by email.
  const memberEmails = new Set(
    members.map((m) => (m.email ?? '').toLowerCase()).filter(Boolean),
  )
  const options: Option[] = [
    ...members
      .filter((m) => m.email)
      .map((m) => {
        const email = (m.email as string).toLowerCase()
        const name = m.display_name && m.display_name.trim() !== '' ? m.display_name : email
        return { email, label: email === callerEmail ? `${name} (du)` : name }
      }),
    ...invites
      .filter((i) => !memberEmails.has(i.email.toLowerCase()))
      .map((i) => ({ email: i.email.toLowerCase(), label: `${i.email} (inbjuden)` })),
  ]

  const emailOfSlot = (slot: CanonicalSlot) =>
    identity?.people.find((p) => p.slot === slot)?.assigned_email ?? ''

  function openEditor() {
    setSaveError('')
    setEmailA(emailOfSlot('a'))
    setEmailB(emailOfSlot('b'))
    setEditor('open')
  }

  function closeEditor() {
    setEditor('closed')
    setSaveError('')
  }

  const duplicate = emailA !== '' && emailA === emailB
  const canSave = !saving && !duplicate

  // The name shown for whichever slot the caller's email is in (their "Du").
  const labelFor = (email: string) =>
    options.find((o) => o.email === email)?.label.replace(/ \(du\)$/, '') ?? email
  const mySlot: CanonicalSlot | null =
    callerEmail !== '' && emailA === callerEmail ? 'a'
      : callerEmail !== '' && emailB === callerEmail ? 'b'
      : null

  async function onSave() {
    setSaving(true)
    setSaveError('')
    try {
      await assignHouseholdPeople(emailA || null, emailB || null)
      await refreshHouseholdIdentity()
      setEditor('closed')
      onSaved()
    } catch (error) {
      setSaveError(identityErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  // No household yet (provisioning) — nothing meaningful to show.
  if (identityView.status === 'ready' && identity === null) return null

  const slotSelect = (slot: CanonicalSlot, value: string, setValue: (v: string) => void) => (
    <div className="hh-people-field">
      <label htmlFor={`${idPrefix}-slot-${slot}`}>Person {slot.toUpperCase()}</label>
      <select
        id={`${idPrefix}-slot-${slot}`}
        className="hh-invite-input hh-people-select"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      >
        <option value="">Ingen än</option>
        {options.map((o) => (
          <option key={o.email} value={o.email}>{o.label}</option>
        ))}
      </select>
    </div>
  )

  return (
    <section className="hh-section">
      <p className="const-group-title">Personer i hushållet</p>

      {(identityView.status === 'loading' || identityView.status === 'idle') && !identity && editor === 'closed' && (
        <p className="modal-note">Hämtar personer …</p>
      )}
      {identityView.status === 'error' && !identity && editor === 'closed' && (
        <>
          <p className="auth-error hh-error">Kunde inte hämta hushållets personer.</p>
          <button type="button" className="btn btn-ghost hh-people-retry" onClick={() => void identityView.refresh()}>
            Försök igen
          </button>
        </>
      )}

      {editor === 'closed' && identity && configured && (
        <>
          <ul className="hh-list">
            {identityView.people.map((person) => (
              <li key={person.id} className="hh-list-row">
                <span className="hh-person-slot" aria-hidden="true">{person.slot.toUpperCase()}</span>
                <span className="hh-member-email">
                  {person.display_name}
                  {person.id === identity.myPersonId && <span className="hh-you"> (du)</span>}
                  {person.assigned_email && person.assigned_email !== person.display_name && (
                    <span className="hh-member-addr"> · {person.assigned_email}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn-ghost hh-people-manage" onClick={openEditor}>
            Hantera personer
          </button>
        </>
      )}

      {editor === 'closed' && identity && !configured && (
        <>
          <p className="modal-note hh-people-note">
            Koppla hushållets två personer till konton, så vet appen vem som är du.
          </p>
          <button type="button" className="btn btn-primary" onClick={openEditor}>
            Kom igång
          </button>
        </>
      )}

      {editor === 'open' && (
        <form className="hh-people-form" onSubmit={(e) => { e.preventDefault(); if (canSave) void onSave() }}>
          <p className="modal-note hh-people-note">
            Välj vilket konto som är varje person. En inbjuden partner visas med sin
            e-post tills de loggar in och anger sitt namn.
          </p>
          {slotSelect('a', emailA, setEmailA)}
          {slotSelect('b', emailB, setEmailB)}
          {duplicate && (
            <p className="auth-error hh-error">Person A och Person B kan inte vara samma konto.</p>
          )}
          {mySlot && (
            <p className="modal-note hh-people-addr">
              Du: {labelFor(mySlot === 'a' ? emailA : emailB)} — Person {mySlot.toUpperCase()}
            </p>
          )}
          {saveError && <p className="auth-error hh-error">{saveError}</p>}
          <div className="hh-people-actions">
            <button type="submit" className="btn btn-primary" disabled={!canSave}>
              {saving ? 'Sparar …' : 'Spara personer'}
            </button>
            <button type="button" className="btn btn-ghost" disabled={saving} onClick={closeEditor}>
              Avbryt
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
