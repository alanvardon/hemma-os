// HouseholdPeopleSetup — the "Personer i hushållet" section of the household
// dialog (plan 111, Stage 2). The owner names the two canonical people ONCE
// (name + optional login email) and the three tools bind by name automatically:
// when a tool's stored A/B names match the two canonical names (in order or
// reversed) it is auto-bound and only summarised; a tool whose names match
// neither person is a CONFLICT and is the only case that still shows the manual
// per-slot selectors. "Vem är du?" resolves from the caller's own account email
// when it matches an entered email; otherwise the manual radio is the fallback.
// Save is a sequence of idempotent server calls — no optimistic "Du" is ever
// rendered, a failure keeps the editor open with a retryable error, and identity
// setup never gates the rest of the app.
import { useId, useState } from 'react'
import type { Member } from '../lib/household'
import {
  IDENTITY_TOOLS,
  claimHouseholdPersonByEmail,
  configureHouseholdPeople,
  identityErrorMessage,
  refreshHouseholdIdentity,
  setMyHouseholdPerson,
  type CanonicalSlot,
  type HouseholdIdentity,
  type IdentityTool,
} from '../lib/person-identity'
import { loadIdentitySuggestions, IDENTITY_TOOL_LABELS, type ToolNameSuggestion } from '../lib/person-identity-suggestions'
import { usePersonIdentity } from './usePersonIdentity'

type SlotChoice = CanonicalSlot | ''
type ToolMap = Record<IdentityTool, { a: SlotChoice; b: SlotChoice }>
type WhoAmI = CanonicalSlot | 'skip'
type EditorPhase = 'closed' | 'loading' | 'open'
/** How a tool's legacy A/B names map onto the canonical people. */
type ToolBind = { a: CanonicalSlot; b: CanonicalSlot } | 'conflict'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const normalize = (name: string) => name.trim().toLocaleLowerCase('sv-SE').replace(/\s+/g, ' ')

function validName(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length >= 1 && trimmed.length <= 60
}

/** A blank email is allowed (optional); a non-blank one must look like an email. */
function validEmail(value: string): boolean {
  const trimmed = value.trim()
  return trimmed === '' || EMAIL_RE.test(trimmed)
}

function slotOfPerson(identity: HouseholdIdentity | null, personId: string | null | undefined): SlotChoice {
  if (!identity || !personId) return ''
  return identity.people.find((person) => person.id === personId)?.slot ?? ''
}

/** Preselect a single tool slot only on an unambiguous exact (normalized) match. */
function matchSlot(toolName: string, nameA: string, nameB: string): SlotChoice {
  const a = normalize(nameA)
  const b = normalize(nameB)
  if (!a || !b || a === b) return ''
  const name = normalize(toolName)
  return name === a ? 'a' : name === b ? 'b' : ''
}

/** Auto-bind a tool by comparing its stored A/B names to the canonical names:
    an exact ordered match binds slot A→A / B→B; an exact reversed match binds
    A→B / B→A; anything else (a name matching neither, both, or ambiguous) is a
    conflict that must be resolved by hand. */
function classifyTool(suggestion: ToolNameSuggestion, nameA: string, nameB: string): ToolBind {
  const canonA = normalize(nameA)
  const canonB = normalize(nameB)
  const toolA = normalize(suggestion.a)
  const toolB = normalize(suggestion.b)
  if (!canonA || !canonB || !toolA || !toolB) return 'conflict'
  const order = toolA === canonA && toolB === canonB
  const reverse = toolA === canonB && toolB === canonA
  if (order && !reverse) return { a: 'a', b: 'b' }
  if (reverse && !order) return { a: 'b', b: 'a' }
  return 'conflict'
}

interface Props {
  members: Member[]
  myEmail: string | null
  /** Called after a fully successful save so the parent can refresh the roster. */
  onSaved: () => void
}

export default function HouseholdPeopleSection({ members, myEmail, onSaved }: Props) {
  const identityView = usePersonIdentity()
  const { identity, configured } = identityView
  const idPrefix = useId()

  const [editor, setEditor] = useState<EditorPhase>('closed')
  const [suggestions, setSuggestions] = useState<ToolNameSuggestion[]>([])
  const [nameA, setNameA] = useState('')
  const [nameB, setNameB] = useState('')
  const [emailA, setEmailA] = useState('')
  const [emailB, setEmailB] = useState('')
  const [whoAmI, setWhoAmI] = useState<WhoAmI>('skip')
  const [toolMap, setToolMap] = useState<ToolMap>({
    bolanekoll: { a: '', b: '' },
    hushallsbudget: { a: '', b: '' },
    manadsavslut: { a: '', b: '' },
  })
  const [reviewed, setReviewed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  // Person ids claimed by OTHER members (the roster exposes each member's
  // mapped person since Stage 1) — those cannot be picked as "du".
  const claimedByOthers = new Set(
    members
      .filter((member) => member.person_id
        && (member.email ?? '').toLowerCase() !== (myEmail ?? '').toLowerCase())
      .map((member) => member.person_id as string),
  )

  async function openEditor() {
    setEditor('loading')
    setSaveError('')
    setReviewed(false)
    const loaded = await loadIdentitySuggestions()
    setSuggestions(loaded)

    // Canonical-name prefill: existing people win; a fresh household starts
    // from Bolånekoll's current names.
    const personA = identity?.people.find((p) => p.slot === 'a')
    const personB = identity?.people.find((p) => p.slot === 'b')
    const prefillA = personA?.display_name ?? loaded.find((s) => s.tool === 'bolanekoll')?.a ?? ''
    const prefillB = personB?.display_name ?? loaded.find((s) => s.tool === 'bolanekoll')?.b ?? ''
    setNameA(prefillA)
    setNameB(prefillB)
    // Emails prefill only from an existing configured login email, else blank.
    setEmailA(personA?.login_email ?? '')
    setEmailB(personB?.login_email ?? '')

    // "Vem är du?" — my mapped slot; else, for an invited account, suggest the
    // one unclaimed person (still requires explicit review + save). Only used
    // when the caller's email does not resolve them.
    const mySlot = slotOfPerson(identity, identity?.myPersonId)
    if (mySlot) setWhoAmI(mySlot)
    else {
      const free = (identity?.people ?? []).filter((p) => !claimedByOthers.has(p.id))
      setWhoAmI(identity && identity.people.length === 2 && free.length === 1 ? free[0].slot : 'skip')
    }

    // Conflict tools' manual mapping: an existing binding wins; else preselect
    // exact per-slot matches. Auto-bound tools ignore this map on save.
    const nextMap = {} as ToolMap
    for (const tool of IDENTITY_TOOLS) {
      const binding = identity?.bindings[tool]
      const names = loaded.find((s) => s.tool === tool)
      nextMap[tool] = binding
        ? { a: slotOfPerson(identity, binding.a), b: slotOfPerson(identity, binding.b) }
        : {
            a: names ? matchSlot(names.a, prefillA, prefillB) : '',
            b: names ? matchSlot(names.b, prefillA, prefillB) : '',
          }
    }
    setToolMap(nextMap)
    setEditor('open')
  }

  function closeEditor() {
    setEditor('closed')
    setSaveError('')
  }

  // ── derived binding + validation state (recomputed each render) ────────────
  const bindOf: Record<IdentityTool, ToolBind> = {
    bolanekoll: 'conflict', hushallsbudget: 'conflict', manadsavslut: 'conflict',
  }
  for (const suggestion of suggestions) bindOf[suggestion.tool] = classifyTool(suggestion, nameA, nameB)
  const autoTools = suggestions.filter((s) => bindOf[s.tool] !== 'conflict')
  const conflictTools = suggestions.filter((s) => bindOf[s.tool] === 'conflict')

  // A conflict tool must have both slots chosen and not point at the same person.
  const unresolvedConflicts = conflictTools.filter((s) => !toolMap[s.tool].a || !toolMap[s.tool].b)
  const duplicateConflicts = conflictTools.filter(
    (s) => toolMap[s.tool].a !== '' && toolMap[s.tool].a === toolMap[s.tool].b,
  )

  const namesValid = validName(nameA) && validName(nameB)
  const emailsValid = validEmail(emailA) && validEmail(emailB)
  const emailDuplicate = emailA.trim() !== '' && emailB.trim() !== ''
    && emailA.trim().toLowerCase() === emailB.trim().toLowerCase()

  // Who am I resolves from the caller's account email when it matches an entered
  // email; otherwise the manual radio is the fallback.
  const callerEmail = (myEmail ?? '').trim().toLowerCase()
  const emailResolvedSlot: CanonicalSlot | null = !emailDuplicate && callerEmail
    ? callerEmail === emailA.trim().toLowerCase() && emailA.trim() !== '' ? 'a'
      : callerEmail === emailB.trim().toLowerCase() && emailB.trim() !== '' ? 'b'
      : null
    : null

  const canSave = !saving && namesValid && emailsValid && !emailDuplicate && reviewed
    && unresolvedConflicts.length === 0 && duplicateConflicts.length === 0

  // Strict write contract: only server responses change identity state. Every
  // call is idempotent, so a retry after a mid-sequence failure is safe.
  async function onSave() {
    setSaving(true)
    setSaveError('')
    try {
      let latest: HouseholdIdentity | null = null
      for (const tool of IDENTITY_TOOLS) {
        const bind = bindOf[tool]
        const slots = bind === 'conflict'
          ? { a: toolMap[tool].a as CanonicalSlot, b: toolMap[tool].b as CanonicalSlot }
          : bind
        latest = await configureHouseholdPeople({
          personAName: nameA,
          personBName: nameB,
          personAEmail: emailA,
          personBEmail: emailB,
          tool,
          toolSlotAPerson: slots.a,
          toolSlotBPerson: slots.b,
        })
      }
      // Map the caller: by their own verified email (no-op when no match), and
      // via the manual radio when the email did not resolve them.
      await claimHouseholdPersonByEmail()
      if (emailResolvedSlot === null && whoAmI !== 'skip') {
        const person = latest?.people.find((p) => p.slot === whoAmI)
        if (!person) throw new Error('Kunde inte läsa personerna efter sparning. Försök igen.')
        await setMyHouseholdPerson(person.id)
      }
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
                  {person.login_email && <span className="hh-member-addr"> · {person.login_email}</span>}
                </span>
              </li>
            ))}
          </ul>
          {!identity.myPersonId && (
            <p className="modal-note hh-people-note">Du har inte valt vem du är ännu.</p>
          )}
          <button type="button" className="btn btn-ghost hh-people-manage" onClick={() => void openEditor()}>
            Hantera personer
          </button>
        </>
      )}

      {editor === 'closed' && identity && !configured && (
        <>
          <p className="modal-note hh-people-note">
            Koppla hushållets två personer till verktygen och ditt konto, så vet
            appen vem som är du.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => void openEditor()}>
            Kom igång
          </button>
        </>
      )}

      {editor === 'loading' && <p className="modal-note">Hämtar namn från verktygen …</p>}

      {editor === 'open' && (
        <form
          className="hh-people-form"
          onSubmit={(e) => { e.preventDefault(); if (canSave) void onSave() }}
        >
          {(['a', 'b'] as const).map((slot) => {
            const name = slot === 'a' ? nameA : nameB
            const email = slot === 'a' ? emailA : emailB
            const setName = slot === 'a' ? setNameA : setNameB
            const setEmail = slot === 'a' ? setEmailA : setEmailB
            return (
              <div key={slot} className="hh-people-person">
                <div className="hh-people-field">
                  <label htmlFor={`${idPrefix}-name-${slot}`}>Person {slot.toUpperCase()}</label>
                  <input
                    id={`${idPrefix}-name-${slot}`}
                    className="hh-invite-input"
                    type="text"
                    maxLength={60}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="hh-people-field">
                  <label htmlFor={`${idPrefix}-email-${slot}`}>E-post (valfritt)</label>
                  <input
                    id={`${idPrefix}-email-${slot}`}
                    className="hh-invite-input"
                    type="email"
                    inputMode="email"
                    maxLength={254}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="off"
                  />
                  {!validEmail(email) && <p className="auth-error hh-error">Ange en giltig e-postadress.</p>}
                </div>
              </div>
            )
          })}
          {myEmail && (
            <p className="modal-note hh-people-note">Din inloggning: {myEmail}</p>
          )}
          {!namesValid && <p className="auth-error hh-error">Ange båda namnen (1–60 tecken).</p>}
          {emailDuplicate && <p className="auth-error hh-error">Personerna kan inte dela e-postadress.</p>}

          {emailResolvedSlot ? (
            <p className="modal-note hh-people-resolved">
              Du: {((emailResolvedSlot === 'a' ? nameA : nameB).trim() || `Person ${emailResolvedSlot.toUpperCase()}`)}
              {' '}— via din e-post
            </p>
          ) : (
            <fieldset className="hh-people-whoami">
              <legend>Vem är du?</legend>
              {(['a', 'b'] as const).map((slot) => {
                const person = identity?.people.find((p) => p.slot === slot)
                const claimed = !!person && claimedByOthers.has(person.id)
                const label = (slot === 'a' ? nameA : nameB).trim() || `Person ${slot.toUpperCase()}`
                return (
                  <label key={slot} className="hh-people-radio" data-disabled={claimed || undefined}>
                    <input
                      type="radio"
                      name={`${idPrefix}-whoami`}
                      checked={whoAmI === slot}
                      disabled={claimed}
                      onChange={() => setWhoAmI(slot)}
                    />
                    <span>
                      {label}
                      {claimed && <span className="hh-you"> (vald av annan medlem)</span>}
                    </span>
                  </label>
                )
              })}
              <label className="hh-people-radio">
                <input
                  type="radio"
                  name={`${idPrefix}-whoami`}
                  checked={whoAmI === 'skip'}
                  onChange={() => setWhoAmI('skip')}
                />
                <span>Väljer senare</span>
              </label>
            </fieldset>
          )}

          {autoTools.length > 0 && (
            <div className="hh-people-auto">
              <p className="hh-people-subtitle">Verktyg kopplas automatiskt</p>
              <ul className="hh-people-auto-list">
                {autoTools.map((s) => (
                  <li key={s.tool} className="hh-people-auto-row">{IDENTITY_TOOL_LABELS[s.tool]}</li>
                ))}
              </ul>
            </div>
          )}

          {conflictTools.length > 0 && (
            <div className="hh-people-tools">
              <p className="hh-people-subtitle">Koppla verktygens namn</p>
              {conflictTools.map((suggestion) => {
                const duplicate = duplicateConflicts.includes(suggestion)
                return (
                  <div key={suggestion.tool} className="hh-people-tool">
                    <p className="hh-people-tool-name">{suggestion.label}</p>
                    <p className="modal-note hh-people-conflict-note">
                      Namnen i {suggestion.label} matchar inte — välj vem varje plats är.
                    </p>
                    {(['a', 'b'] as const).map((toolSlot) => (
                      <div key={toolSlot} className="hh-people-field hh-people-map-row">
                        <label htmlFor={`${idPrefix}-${suggestion.tool}-${toolSlot}`}>
                          {toolSlot.toUpperCase()} · {suggestion[toolSlot]}
                        </label>
                        <select
                          id={`${idPrefix}-${suggestion.tool}-${toolSlot}`}
                          className="hh-invite-input hh-people-select"
                          value={toolMap[suggestion.tool][toolSlot]}
                          onChange={(e) => {
                            const value = e.target.value as SlotChoice
                            setToolMap((prev) => ({
                              ...prev,
                              [suggestion.tool]: { ...prev[suggestion.tool], [toolSlot]: value },
                            }))
                          }}
                        >
                          <option value="">Välj person …</option>
                          <option value="a">{nameA.trim() || 'Person A'}</option>
                          <option value="b">{nameB.trim() || 'Person B'}</option>
                        </select>
                      </div>
                    ))}
                    {duplicate && (
                      <p className="auth-error hh-error">Samma person kan inte ha båda platserna.</p>
                    )}
                  </div>
                )
              })}
              {unresolvedConflicts.length > 0 && (
                <p className="modal-note hh-people-note">Välj en person för varje plats innan du sparar.</p>
              )}
            </div>
          )}

          <label className="hh-people-review">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            <span>Jag har kontrollerat namnen och kopplingarna.</span>
          </label>

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
