import { useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  getHouseholdIdentitySnapshot,
  myToolSlot,
  refreshHouseholdIdentity,
  subscribeHouseholdIdentity,
  type CanonicalSlot,
  type HouseholdIdentity,
  type HouseholdPerson,
  type IdentityStatus,
  type IdentityTool,
} from '../lib/person-identity'

// The React boundary the tools consume for person-aware presentation. Every
// answer is derived from the server-confirmed, (userId, householdId)-scoped
// snapshot in lib/person-identity. Tools map by position — tool slot A is always
// the household's Person A — so personFor ignores the tool. An unconfigured
// household, an unassigned account or a missing/failed load all answer with the
// safe legacy fallback (null / false), so no surface renders a wrong "Du".
export interface PersonIdentityView {
  status: IdentityStatus
  identity: HouseholdIdentity | null
  /** Both people exist. */
  configured: boolean
  people: HouseholdPerson[]
  /** The signed-in account's person; null while unassigned. */
  myPerson: HouseholdPerson | null
  /** The household person at a tool's A/B slot (position mapping); null when the
      household is unconfigured (legacy fallback: keep today's A/B display). */
  personFor: (tool: IdentityTool, toolSlot: CanonicalSlot) => HouseholdPerson | null
  /** True only when the account is the person at that slot — never guesses. */
  isMe: (tool: IdentityTool, toolSlot: CanonicalSlot) => boolean
  /** The tool slot that IS the signed-in person, else null so callers keep their
      legacy perspective. */
  myToolSlot: (tool: IdentityTool) => CanonicalSlot | null
  refresh: () => Promise<void>
}

export function usePersonIdentity(): PersonIdentityView {
  const state = useSyncExternalStore(
    subscribeHouseholdIdentity,
    getHouseholdIdentitySnapshot,
    getHouseholdIdentitySnapshot,
  )

  useEffect(() => {
    if (state.status === 'idle') void refreshHouseholdIdentity()
  }, [state.status])

  return useMemo(() => {
    const identity = state.identity
    const configured = !!identity && identity.people.length === 2
    const personFor = (_tool: IdentityTool, toolSlot: CanonicalSlot): HouseholdPerson | null => {
      if (!identity || !configured) return null
      // Position mapping: tool slot A ↔ household Person A.
      return identity.people.find((person) => person.slot === toolSlot) ?? null
    }
    return {
      status: state.status,
      identity,
      configured,
      people: identity?.people ?? [],
      myPerson: configured
        ? identity.people.find((person) => person.id === identity.myPersonId) ?? null
        : null,
      personFor,
      isMe: (tool, toolSlot) => {
        const person = personFor(tool, toolSlot)
        return !!person && !!identity?.myPersonId && person.id === identity.myPersonId
      },
      myToolSlot: (tool) => configured ? myToolSlot(identity, tool) : null,
      refresh: refreshHouseholdIdentity,
    }
  }, [state])
}
