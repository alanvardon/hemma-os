/* person-identity.ts — the client boundary for household person identity
   (plan 111). The household has two people (slot 'a'/'b'); each slot is assigned
   an email from the household's members or pending invites, and the account that
   owns that email IS that person. The signed-in account is "du" for the slot
   carrying its own email. Tools map by position — tool slot A is always the
   household's Person A — so there is no per-tool binding.

   A person's display name resolves server-side to the assigned account's profile
   name, then its email, then "Person A"/"Person B"; it is always a usable string.

   Strict write contract: state only ever changes from a server response. The
   offline cache stores the RAW server envelope under a syncCoordinator-scoped
   key, so it is namespaced by (userId, householdId) and quarantined/removed with
   the existing sign-out/household-transition flow; server state wins after every
   successful refresh. */

import { supabase } from './supabase'
import { syncCoordinator } from './sync'
import { toPersistenceError, persistenceErrorMessage } from './persistence-error'

export const IDENTITY_TOOLS = ['bolanekoll', 'hushallsbudget', 'manadsavslut'] as const
export type IdentityTool = (typeof IDENTITY_TOOLS)[number]
export type CanonicalSlot = 'a' | 'b'

export interface HouseholdPerson {
  id: string
  slot: CanonicalSlot
  /** Always a usable label: profile name → assigned email → "Person A/B". */
  display_name: string
  /** The email assigned to this slot, or null while unassigned. */
  assigned_email: string | null
}

export interface HouseholdIdentity {
  householdId: string
  /** The slot carrying the signed-in account's email; null when unassigned. */
  myPersonId: string | null
  /** The caller's own raw profile name (null when unset), for the name editor. */
  myProfileName: string | null
  /** Both people (slot order) when configured, [] when not. */
  people: HouseholdPerson[]
}

// ── defensive parsing ────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

function parsePerson(raw: unknown): HouseholdPerson | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const person = raw as Record<string, unknown>
  if (!isUuid(person.id)) return null
  if (person.slot !== 'a' && person.slot !== 'b') return null
  const email = typeof person.assigned_email === 'string' && person.assigned_email.trim() !== ''
    ? person.assigned_email
    : null
  // The server always sends a resolved name; fall back defensively so a
  // malformed name can never render as blank or "null".
  const name = typeof person.display_name === 'string' && person.display_name.trim() !== ''
    ? person.display_name
    : `Person ${person.slot.toUpperCase()}`
  return { id: person.id, slot: person.slot, display_name: name, assigned_email: email }
}

/** Parse the household_identity() jsonb view. Returns null for SQL NULL (no
    household) or an unusable envelope. Malformed people make the household read
    as UNCONFIGURED (people []) rather than crash or guess. */
export function parseHouseholdIdentity(raw: unknown): HouseholdIdentity | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const view = raw as Record<string, unknown>
  if (!isUuid(view.household_id)) return null

  let people: HouseholdPerson[] = []
  if (Array.isArray(view.people)) {
    const parsed = view.people.map(parsePerson)
    if (parsed.length === 2 && parsed.every((p): p is HouseholdPerson => p !== null)) {
      const slots = new Set(parsed.map((p) => p.slot))
      const ids = new Set(parsed.map((p) => p.id))
      if (slots.size === 2 && ids.size === 2) {
        people = [...parsed].sort((a, b) => a.slot.localeCompare(b.slot))
      }
    }
  }
  const knownIds = new Set(people.map((p) => p.id))
  const myPersonId = isUuid(view.my_person_id) && knownIds.has(view.my_person_id)
    ? view.my_person_id
    : null
  const myProfileName = typeof view.my_profile_name === 'string' && view.my_profile_name.trim() !== ''
    ? view.my_profile_name
    : null

  return { householdId: view.household_id, myPersonId, myProfileName, people }
}

/**
 * The tool slot that represents the signed-in account. Tools map by position —
 * tool slot A is always the household's Person A — so this is simply the slot of
 * the account's own person, independent of the tool. Null when the account is
 * unassigned, so callers fall back to their legacy perspective and never guess.
 */
export function myToolSlot(identity: HouseholdIdentity | null, _tool: IdentityTool): CanonicalSlot | null {
  if (!identity?.myPersonId) return null
  return identity.people.find((p) => p.id === identity.myPersonId)?.slot ?? null
}

// ── error mapping (stable P0001 messages → concise Swedish) ──────────────────

/** A domain-rule rejection from an identity RPC, already user-worded. */
export class IdentityRuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdentityRuleError'
  }
}

const RULE_MESSAGES: [string, string][] = [
  ['unknown person email', 'E-postadressen tillhör inte hushållet.'],
  ['duplicate person email', 'Person A och Person B kan inte vara samma konto.'],
  ['invalid profile name', 'Namnet får vara högst 60 tecken.'],
]

function toIdentityError(error: unknown): Error {
  const raw = (error as { message?: unknown } | null)?.message
  const message = typeof raw === 'string' ? raw : ''
  for (const [needle, swedish] of RULE_MESSAGES) {
    if (message.includes(needle)) return new IdentityRuleError(swedish)
  }
  return toPersistenceError(error)
}

/** User-facing Swedish message for any identity load/save failure. */
export function identityErrorMessage(error: unknown): string {
  if (error instanceof IdentityRuleError) return error.message
  return persistenceErrorMessage(error)
}

// ── account/household-scoped snapshot + raw-envelope cache ───────────────────

const CACHE_KEY = 'household_identity_cache_v1'

export type IdentityStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface IdentityState {
  status: IdentityStatus
  identity: HouseholdIdentity | null
}

const IDLE_STATE: IdentityState = { status: 'idle', identity: null }

type Scope = ReturnType<typeof syncCoordinator.captureScope>

let state: IdentityState = IDLE_STATE
let stateKey: string | null = null

const listeners = new Set<() => void>()

function scopeKey(scope: Scope): string {
  return `${scope.identity.userId}|${scope.identity.householdId}`
}

function tryCaptureScope(): Scope | null {
  try {
    return syncCoordinator.captureScope()
  } catch {
    return null // signed out / no active sync identity
  }
}

function setState(key: string, next: IdentityState): void {
  stateKey = key
  state = next
  listeners.forEach((listener) => listener())
}

export function subscribeHouseholdIdentity(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The snapshot for the ACTIVE (userId, householdId) only. Another account's or
    household's state is never returned — a scope change reads as idle until that
    scope refreshes, so stale identity can never flash after sign-in or a
    household switch. */
export function getHouseholdIdentitySnapshot(): IdentityState {
  const active = syncCoordinator.getActiveIdentity()
  if (!active) return IDLE_STATE
  const key = `${active.userId}|${active.householdId}`
  return stateKey === key ? state : IDLE_STATE
}

function readCachedIdentity(scope: Scope): HouseholdIdentity | null {
  try {
    const raw = scope.read(CACHE_KEY)
    if (!raw) return null
    return parseHouseholdIdentity(JSON.parse(raw))
  } catch {
    return null
  }
}

function writeCachedIdentity(scope: Scope, rawView: unknown): void {
  // Cache the RAW server envelope (parsed defensively on every read) — never a
  // salvaged/derived shape (see the PR #332 cache landmine).
  try {
    if (rawView === null || rawView === undefined) scope.remove(CACHE_KEY)
    else scope.write(CACHE_KEY, JSON.stringify(rawView))
  } catch {
    // The cache is an offline-rendering convenience only.
  }
}

// ── RPC wrappers ─────────────────────────────────────────────────────────────

async function rpcIdentityView(): Promise<unknown> {
  const { data, error } = await supabase.rpc('household_identity')
  if (error) throw toIdentityError(error)
  return data
}

/** Read the current identity view. Throws a user-worded error on failure. */
export async function fetchHouseholdIdentity(): Promise<HouseholdIdentity | null> {
  return parseHouseholdIdentity(await rpcIdentityView())
}

/** Refresh the scoped snapshot from the server. Never throws — failures leave
    the previous snapshot (seeded from the scoped cache when the scope is new)
    with status 'error' so the UI can offer retry; a successful response wins and
    rewrites the cache. */
export async function refreshHouseholdIdentity(): Promise<void> {
  const scope = tryCaptureScope()
  if (!scope) return
  const key = scopeKey(scope)
  const prior = stateKey === key ? state.identity : readCachedIdentity(scope)
  setState(key, { status: 'loading', identity: prior })
  try {
    const rawView = await rpcIdentityView()
    if (!scope.isActive()) return
    writeCachedIdentity(scope, rawView)
    setState(key, { status: 'ready', identity: parseHouseholdIdentity(rawView) })
  } catch {
    if (!scope.isActive()) return
    setState(key, { status: 'error', identity: prior })
  }
}

/** Assign the two people to emails (member or pending-invite emails). null
    clears a slot. On success the returned server view becomes the new snapshot +
    cache; on failure nothing changes locally. */
export async function assignHouseholdPeople(
  slotAEmail: string | null,
  slotBEmail: string | null,
): Promise<HouseholdIdentity | null> {
  const scope = tryCaptureScope()
  const norm = (v: string | null) => {
    const t = (v ?? '').trim()
    return t === '' ? null : t
  }
  const { data, error } = await supabase.rpc('assign_household_people', {
    p_slot_a_email: norm(slotAEmail),
    p_slot_b_email: norm(slotBEmail),
  })
  if (error) throw toIdentityError(error)
  const parsed = parseHouseholdIdentity(data)
  if (scope && scope.isActive()) {
    writeCachedIdentity(scope, data)
    setState(scopeKey(scope), { status: 'ready', identity: parsed })
  }
  return parsed
}

/** Set or clear (blank) the caller's own profile name. The snapshot is not
    touched here — callers refresh so a new name only ever renders from a
    server-confirmed view. */
export async function setMyProfileName(name: string | null): Promise<void> {
  const trimmed = (name ?? '').trim()
  const { error } = await supabase.rpc('set_my_profile_name', { p_name: trimmed === '' ? null : trimmed })
  if (error) throw toIdentityError(error)
}
