import { useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  getHouseholdIdentitySnapshot,
  refreshHouseholdIdentity,
  subscribeHouseholdIdentity,
  type CanonicalSlot,
  type HouseholdIdentity,
  type HouseholdPerson,
  type IdentityStatus,
  type IdentityTool,
} from '../lib/person-identity'

// The React boundary Stage 3/4 consume for person-aware presentation. Every
// answer is derived from the server-confirmed, (userId, householdId)-scoped
// snapshot in lib/person-identity — an unmapped account, an unbound tool or a
// missing/failed load all answer with the safe legacy fallback (null / false),
// so no surface can render a potentially wrong "Du".
export interface PersonIdentityView {
  status: IdentityStatus
  identity: HouseholdIdentity | null
  /** Both canonical people exist. */
  configured: boolean
  people: HouseholdPerson[]
  /** The signed-in account's canonical person; null while unmapped. */
  myPerson: HouseholdPerson | null
  /** The canonical person a tool's legacy A/B slot represents; null when the
      tool is unbound (legacy fallback: keep today's A/B display). */
  personFor: (tool: IdentityTool, toolSlot: CanonicalSlot) => HouseholdPerson | null
  /** True only when the tool is bound AND the account is mapped to that slot's
      person — never guesses. */
  isMe: (tool: IdentityTool, toolSlot: CanonicalSlot) => boolean
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
    const personFor = (tool: IdentityTool, toolSlot: CanonicalSlot): HouseholdPerson | null => {
      if (!identity || !configured) return null
      const binding = identity.bindings[tool]
      if (!binding) return null
      return identity.people.find((person) => person.id === binding[toolSlot]) ?? null
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
      refresh: refreshHouseholdIdentity,
    }
  }, [state])
}
