// HouseholdPeopleSetup — the "Personer i hushållet" section of the household
// dialog (plan 111, Stage 2). The owner names the two canonical people ONCE and
// the three tools bind by name automatically: when a tool's stored A/B names
// match the two canonical names (in order or reversed) it is auto-bound and only
// summarised; a tool whose names match neither person is a CONFLICT and is the
// only case that still shows the manual per-slot selectors. A person's login
// email is NOT typed — it is shown automatically from the account mapped to that
// person (via the roster); the partner's email appears once they log in and are
// identified as Person B. "Vem är du?" defaults to Person A for the household
// owner and Person B for a member, and stays overridable. Save is a sequence of
// idempotent server calls — no optimistic "Du" is ever rendered, a failure keeps
// the editor open with a retryable error, and identity setup never gates the app.
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
import { loadIdentitySuggestions, IDENTITY_TOOL_LABELS, type ToolNameSuggestion } from '../lib/person-identity-suggestions'
import { usePersonIdentity } from './usePersonIdentity'

type SlotChoice = CanonicalSlot | ''
type ToolMap = Record<IdentityTool, { a: SlotChoice; b: SlotChoice }>
type WhoAmI = CanonicalSlot | 'skip'
type EditorPhase = 'closed' | 'loading' | 'open'
/** How a tool's legacy A/B names map onto the canonical people. */
type ToolBind = { a: CanonicalSlot; b: CanonicalSlot } | 'conflict'

const normalize = (name: string) => name.trim().toLocaleLowerCase('sv-SE').replace(/\s+/g, ' ')

function validName(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length >= 1 && trimmed.length <= 60
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

/** Auto-bind a tool by comparing its stored A/B names to the canonical names.
    Only a real name match anchors — never position: a wrong slot would mislabel
    whose figures are whose (the column names come from the binding). But in a
    two-person household ONE anchor is enough — if one slot matches a canonical
    name, the other slot is forced by elimination whatever it is called (so a
    generic "Partner" beside a matched "Alan" resolves to Person B without a
    guess). A tool resolves when at least one slot matches; it stays a conflict
    only when neither slot matches, or both match the same person. */
function classifyTool(suggestion: ToolNameSuggestion, nameA: string, nameB: string): ToolBind {
  const canonA = normalize(nameA)
  const canonB = normalize(nameB)
  const toolA = normalize(suggestion.a)
  const toolB = normalize(suggestion.b)
  if (!canonA || !canonB || canonA === canonB) return 'conflict'
  // Which canonical person each tool slot matches by name ('a' | 'b' | null).
  const mA = toolA === canonA ? 'a' : toolA === canonB ? 'b' : null
  const mB = toolB === canonA ? 'a' : toolB === canonB ? 'b' : null
  if (mA && mB) return mA !== mB ? { a: mA, b: mB } : 'conflict'
  if (mA) return { a: mA, b: mA === 'a' ? 'b' : 'a' }
  if (mB) return { a: mB === 'a' ? 'b' : 'a', b: mB }
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
  const [whoAmI, setWhoAmI] = useState<WhoAmI>('skip')
  const [toolMap, setToolMap] = useState<ToolMap>({
    bolanekoll: { a: '', b: '' },
    hushallsbudget: { a: '', b: '' },
    manadsavslut: { a: '', b: '' },
  })
  const [reviewed, setReviewed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  const callerEmail = (myEmail ?? '').trim().toLowerCase()

  // Person ids claimed by OTHER members (the roster exposes each member's mapped
  // person since Stage 1) — those cannot be picked as "du".
  const claimedByOthers = new Set(
    members
      .filter((member) => member.person_id
        && (member.email ?? '').toLowerCase() !== callerEmail)
      .map((member) => member.person_id as string),
  )

  // The login email shown for a canonical slot: the email of the account mapped
  // to that person (from the roster). When no account is mapped yet, the caller's
  // own email is shown on the slot they will claim ("din inloggning"); the other
  // slot has none until the partner logs in.
  function emailOfSlot(slot: CanonicalSlot): { email: string | null; mine: boolean } {
    const person = identity?.people.find((p) => p.slot === slot)
    const mapped = person ? (members.find((m) => m.person_id === person.id)?.email ?? null) : null
    if (mapped) return { email: mapped, mine: mapped.toLowerCase() === callerEmail }
    if (whoAmI === slot && myEmail) return { email: myEmail, mine: true }
    return { email: null, mine: false }
  }

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

    // "Vem är du?": my existing mapped slot wins; else, for an invited account,
    // the single unclaimed person; else default by role — the household owner is
    // Person A, a member is Person B. Still overridable and gated by review.
    const myRole = members.find((m) => (m.email ?? '').toLowerCase() === callerEmail)?.role
    const roleDefault: WhoAmI = myRole === 'owner' ? 'a' : 'b'
    const mySlot = slotOfPerson(identity, identity?.myPersonId)
    if (mySlot) setWhoAmI(mySlot)
    else {
      const free = (identity?.people ?? []).filter((p) => !claimedByOthers.has(p.id))
      setWhoAmI(identity && identity.people.length === 2 && free.length === 1 ? free[0].slot : roleDefault)
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
  // A tool already has a valid saved binding (by person id, so it survives a
  // name mismatch) — that resolves it without re-asking, even when its stored
  // names differ from the canonical ones.
  function savedBind(tool: IdentityTool): ToolBind {
    const binding = identity?.bindings[tool]
    if (!binding) return 'conflict'
    const a = slotOfPerson(identity, binding.a)
    const b = slotOfPerson(identity, binding.b)
    if (a === '' || b === '' || a === b) return 'conflict'
    return { a, b }
  }
  const bindOf: Record<IdentityTool, ToolBind> = {
    bolanekoll: 'conflict', hushallsbudget: 'conflict', manadsavslut: 'conflict',
  }
  for (const suggestion of suggestions) {
    // A name match binds automatically; otherwise an existing saved binding
    // still counts as resolved so a confirmed tool is never re-asked.
    const byName = classifyTool(suggestion, nameA, nameB)
    bindOf[suggestion.tool] = byName !== 'conflict' ? byName : savedBind(suggestion.tool)
  }
  const autoTools = suggestions.filter((s) => bindOf[s.tool] !== 'conflict')
  const conflictTools = suggestions.filter((s) => bindOf[s.tool] === 'conflict')

  // A conflict tool must have both slots chosen and not point at the same person.
  const unresolvedConflicts = conflictTools.filter((s) => !toolMap[s.tool].a || !toolMap[s.tool].b)
  const duplicateConflicts = conflictTools.filter(
    (s) => toolMap[s.tool].a !== '' && toolMap[s.tool].a === toolMap[s.tool].b,
  )

  const namesValid = validName(nameA) && validName(nameB)

  const canSave = !saving && namesValid && reviewed
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
          tool,
          toolSlotAPerson: slots.a,
          toolSlotBPerson: slots.b,
        })
      }
      // Map the caller to the person they picked (owner→A / member→B by default).
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
            {identityView.people.map((person) => {
              const addr = members.find((m) => m.person_id === person.id)?.email ?? null
              return (
                <li key={person.id} className="hh-list-row">
                  <span className="hh-person-slot" aria-hidden="true">{person.slot.toUpperCase()}</span>
                  <span className="hh-member-email">
                    {person.display_name}
                    {person.id === identity.myPersonId && <span className="hh-you"> (du)</span>}
                    {addr && <span className="hh-member-addr"> · {addr}</span>}
                  </span>
                </li>
              )
            })}
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
            const setName = slot === 'a' ? setNameA : setNameB
            const linked = emailOfSlot(slot)
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
                {linked.email ? (
                  <p className="modal-note hh-people-addr">
                    {linked.email}{linked.mine && <span className="hh-people-addr-tag"> (din inloggning)</span>}
                  </p>
                ) : (
                  <p className="modal-note hh-people-addr hh-people-addr-empty">
                    Kopplas när personen loggar in
                  </p>
                )}
              </div>
            )
          })}
          {!namesValid && <p className="auth-error hh-error">Ange båda namnen (1–60 tecken).</p>}

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
