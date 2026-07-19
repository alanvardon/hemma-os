// HouseholdPeopleSetup — the "Personer i hushållet" section of the household
// dialog (plan 111, Stage 2). First-time reconciliation and later management:
// name the two canonical people (prefilled from current tool settings, with
// cross-tool conflicts shown explicitly), answer "Vem är du?", and bind each
// tool's legacy A/B slots to the canonical people. Exact-name matches are
// preselected but Save requires an explicit review; duplicate or incomplete
// mappings cannot be saved. Save is a sequence of idempotent server calls —
// no optimistic "Du" is ever rendered, a failure keeps the editor open with a
// retryable error, and identity setup never gates the rest of the app.
import { useId, useState } from 'react'
import type { Member } from '../lib/household'
import {
  IDENTITY_TOOLS,
  configureHouseholdPeople,
  identityErrorMessage,
  refreshHouseholdIdentity,
  setMyHouseholdPerson,
  type CanonicalSlot,
  type HouseholdIdentity,
  type IdentityTool,
} from '../lib/person-identity'
import { loadIdentitySuggestions, type ToolNameSuggestion } from '../lib/person-identity-suggestions'
import { usePersonIdentity } from './usePersonIdentity'

type SlotChoice = CanonicalSlot | ''
type ToolMap = Record<IdentityTool, { a: SlotChoice; b: SlotChoice }>
type WhoAmI = CanonicalSlot | 'skip'
type EditorPhase = 'closed' | 'loading' | 'open'

const normalize = (name: string) => name.trim().toLocaleLowerCase('sv-SE')

function validName(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length >= 1 && trimmed.length <= 60
}

function slotOfPerson(identity: HouseholdIdentity | null, personId: string | null | undefined): SlotChoice {
  if (!identity || !personId) return ''
  return identity.people.find((person) => person.id === personId)?.slot ?? ''
}

/** Preselect a tool slot only on an unambiguous exact (normalized) match. */
function matchSlot(toolName: string, nameA: string, nameB: string): SlotChoice {
  const a = normalize(nameA)
  const b = normalize(nameB)
  if (!a || !b || a === b) return ''
  const name = normalize(toolName)
  return name === a ? 'a' : name === b ? 'b' : ''
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
    // from Bolånekoll's current names (conflicts are surfaced below).
    const prefillA = identity?.people.find((p) => p.slot === 'a')?.display_name
      ?? loaded.find((s) => s.tool === 'bolanekoll')?.a ?? ''
    const prefillB = identity?.people.find((p) => p.slot === 'b')?.display_name
      ?? loaded.find((s) => s.tool === 'bolanekoll')?.b ?? ''
    setNameA(prefillA)
    setNameB(prefillB)

    // "Vem är du?" — my mapped slot; else, for an invited account, suggest the
    // one unclaimed person (still requires explicit review + save).
    const mySlot = slotOfPerson(identity, identity?.myPersonId)
    if (mySlot) setWhoAmI(mySlot)
    else {
      const free = (identity?.people ?? []).filter((p) => !claimedByOthers.has(p.id))
      setWhoAmI(identity && identity.people.length === 2 && free.length === 1 ? free[0].slot : 'skip')
    }

    // Tool mappings: an existing binding wins; else preselect exact matches.
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

  // Cross-tool conflict: tools whose (normalized, ordered) name pairs differ.
  const distinctPairs = new Set(suggestions.map((s) => `${normalize(s.a)} / ${normalize(s.b)}`))
  const hasNameConflict = distinctPairs.size > 1

  const incompleteTools = IDENTITY_TOOLS.filter((tool) => !toolMap[tool].a || !toolMap[tool].b)
  const duplicateTools = IDENTITY_TOOLS.filter(
    (tool) => toolMap[tool].a !== '' && toolMap[tool].a === toolMap[tool].b,
  )
  const namesValid = validName(nameA) && validName(nameB)
  const canSave = !saving && namesValid && reviewed
    && incompleteTools.length === 0 && duplicateTools.length === 0

  // Strict write contract: only server responses change identity state. Every
  // call is idempotent, so a retry after a mid-sequence failure is safe.
  async function onSave() {
    setSaving(true)
    setSaveError('')
    try {
      let latest: HouseholdIdentity | null = null
      for (const tool of IDENTITY_TOOLS) {
        latest = await configureHouseholdPeople({
          personAName: nameA,
          personBName: nameB,
          tool,
          toolSlotAPerson: toolMap[tool].a as CanonicalSlot,
          toolSlotBPerson: toolMap[tool].b as CanonicalSlot,
        })
      }
      if (whoAmI !== 'skip') {
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
          <div className="hh-people-names">
            <div className="hh-people-field">
              <label htmlFor={`${idPrefix}-name-a`}>Person A</label>
              <input
                id={`${idPrefix}-name-a`}
                className="hh-invite-input"
                type="text"
                maxLength={60}
                value={nameA}
                onChange={(e) => setNameA(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="hh-people-field">
              <label htmlFor={`${idPrefix}-name-b`}>Person B</label>
              <input
                id={`${idPrefix}-name-b`}
                className="hh-invite-input"
                type="text"
                maxLength={60}
                value={nameB}
                onChange={(e) => setNameB(e.target.value)}
                autoComplete="off"
              />
            </div>
          </div>
          {!namesValid && <p className="auth-error hh-error">Ange båda namnen (1–60 tecken).</p>}

          {hasNameConflict && (
            <div className="hh-people-conflict">
              <p className="modal-note">Verktygen använder olika namn — kontrollera kopplingen nedan.</p>
            </div>
          )}

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

          <div className="hh-people-tools">
            <p className="hh-people-subtitle">Koppla verktygens namn</p>
            {suggestions.map((suggestion) => {
              const duplicate = duplicateTools.includes(suggestion.tool)
              return (
                <div key={suggestion.tool} className="hh-people-tool">
                  <p className="hh-people-tool-name">{suggestion.label}</p>
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
            {incompleteTools.length > 0 && (
              <p className="modal-note hh-people-note">Välj en person för varje plats innan du sparar.</p>
            )}
          </div>

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
