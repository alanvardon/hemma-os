/* person-identity.ts — the client boundary for household person identity
   (plan 111, Stage 2). Wraps the three Stage 1 RPCs (household_identity,
   configure_household_people, set_my_household_person), parses the identity
   view defensively (malformed data is treated as unconfigured, never a crash),
   and keeps one account/household-scoped snapshot for the UI.

   Strict write contract: state only ever changes from a server response — no
   optimistic "Du" before an RPC succeeds, and a failed call leaves the prior
   snapshot intact. The offline cache stores the RAW server envelope under a
   syncCoordinator-scoped key, so it is namespaced by (userId, householdId) and
   quarantined/removed with the existing sign-out/household-transition flow;
   server state wins after every successful refresh. */

import { supabase } from './supabase'
import { syncCoordinator } from './sync'
import { toPersistenceError, persistenceErrorMessage } from './persistence-error'

export const IDENTITY_TOOLS = ['bolanekoll', 'hushallsbudget', 'manadsavslut'] as const
export type IdentityTool = (typeof IDENTITY_TOOLS)[number]
export type CanonicalSlot = 'a' | 'b'

export interface HouseholdPerson {
  id: string
  slot: CanonicalSlot
  /** The account email that auto-claims this person (server-normalized,
      lowercase); null when the person has no login email yet. */
  login_email: string | null
  display_name: string
}

/** Which canonical person each of a tool's legacy A/B slots represents. */
export interface ToolBinding {
  a: string
  b: string
}

export interface HouseholdIdentity {
  householdId: string
  /** The signed-in account's canonical person; null while unmapped. */
  myPersonId: string | null
  /** Both canonical people (slot order) when configured, [] when not. */
  people: HouseholdPerson[]
  /** Only bound tools have a key; a binding is always complete (a + b). */
  bindings: Partial<Record<IdentityTool, ToolBinding>>
}

// ── defensive parsing ────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

// Loose, server-aligned email shape (the DB constraint is `%_@_%`, no dot
// required). A value that is not a string or has no local@domain shape parses
// to null so a malformed login_email is treated as "no login email" rather
// than crashing or being surfaced as a bindable address.
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/

function parseLoginEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const email = raw.trim().toLowerCase()
  return EMAIL_RE.test(email) ? email : null
}

function parsePerson(raw: unknown): HouseholdPerson | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const person = raw as Record<string, unknown>
  if (!isUuid(person.id)) return null
  if (person.slot !== 'a' && person.slot !== 'b') return null
  if (typeof person.display_name !== 'string' || person.display_name.trim() === '') return null
  return {
    id: person.id,
    slot: person.slot,
    login_email: parseLoginEmail(person.login_email),
    display_name: person.display_name,
  }
}

/** Parse the household_identity() jsonb view. Returns null for SQL NULL (no
    household) or an unusable envelope. Malformed people make the household
    read as UNCONFIGURED (people [], bindings {}) rather than crash or guess;
    malformed binding entries are dropped individually. */
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

  const bindings: Partial<Record<IdentityTool, ToolBinding>> = {}
  const rawBindings = view.bindings
  if (rawBindings && typeof rawBindings === 'object' && !Array.isArray(rawBindings)) {
    for (const tool of IDENTITY_TOOLS) {
      const entry = (rawBindings as Record<string, unknown>)[tool]
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const { a, b } = entry as Record<string, unknown>
      if (isUuid(a) && isUuid(b) && a !== b && knownIds.has(a) && knownIds.has(b)) {
        bindings[tool] = { a, b }
      }
    }
  }

  return { householdId: view.household_id, myPersonId, people, bindings }
}

/**
 * The tool slot that represents the signed-in account's person — only when the
 * tool is bound AND the account is mapped to one of that binding's people.
 * Null in every other case (unmapped account, unbound tool, no identity), so
 * callers fall back to their legacy perspective and never guess "me".
 */
export function myToolSlot(identity: HouseholdIdentity | null, tool: IdentityTool): CanonicalSlot | null {
  if (!identity?.myPersonId) return null
  const binding = identity.bindings[tool]
  if (!binding) return null
  if (binding.a === identity.myPersonId) return 'a'
  if (binding.b === identity.myPersonId) return 'b'
  return null
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
  ['person already claimed', 'Personen är redan vald av en annan medlem.'],
  ['person not in household', 'Personen finns inte i hushållet. Ladda om och försök igen.'],
  ['incomplete tool binding', 'Välj en person för båda platserna innan du sparar.'],
  ['duplicate tool binding', 'Samma person kan inte ha båda platserna i ett verktyg.'],
  ['invalid tool', 'Verktyget kunde inte kopplas. Ladda om och försök igen.'],
  ['invalid person name', 'Namnen måste vara 1–60 tecken.'],
  ['invalid person email', 'Ange en giltig e-postadress.'],
  ['email already used', 'E-postadressen används redan av en annan person.'],
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

/** The snapshot for the ACTIVE (userId, householdId) only. Another account's
    or household's state is never returned — a scope change reads as idle until
    that scope refreshes, so stale identity can never flash after sign-in or a
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

/** Claim-first load: map the caller to the household person whose login_email
    equals their OWN verified auth email (only when unclaimed) AND return the
    full identity view in one call, so an invited partner auto-claims on their
    first load. The RPC is idempotent and no-ops when already mapped or when no
    email matches. Falls back to a plain household_identity() read when the
    claim RPC is unavailable or yields no usable envelope, so a load never fails
    just because auto-claim could not run. */
async function rpcClaimIdentityView(): Promise<unknown> {
  try {
    const { data, error } = await supabase.rpc('claim_my_household_person_by_email')
    if (error) throw toIdentityError(error)
    if (data !== null && data !== undefined) return data
  } catch {
    // claim unavailable/failed — fall through to a plain read.
  }
  return rpcIdentityView()
}

/** Read the current identity view. Throws a user-worded error on failure. */
export async function fetchHouseholdIdentity(): Promise<HouseholdIdentity | null> {
  return parseHouseholdIdentity(await rpcIdentityView())
}

/** Claim the caller's own household person by their verified email, returning
    the resulting identity view. Never throws (mirrors refresh's error
    tolerance): a non-match, an unavailable RPC or a transient failure resolves
    to null rather than surfacing an error — auto-claim is best-effort and the
    scoped snapshot stays the source of truth. */
export async function claimHouseholdPersonByEmail(): Promise<HouseholdIdentity | null> {
  try {
    const { data, error } = await supabase.rpc('claim_my_household_person_by_email')
    if (error) throw toIdentityError(error)
    return parseHouseholdIdentity(data)
  } catch {
    return null
  }
}

/** Refresh the scoped snapshot from the server. Never throws — failures leave
    the previous snapshot (seeded from the scoped cache when the scope is new)
    with status 'error' so the UI can offer retry; a successful response wins
    and rewrites the cache. */
export async function refreshHouseholdIdentity(): Promise<void> {
  const scope = tryCaptureScope()
  if (!scope) return
  const key = scopeKey(scope)
  const prior = stateKey === key ? state.identity : readCachedIdentity(scope)
  setState(key, { status: 'loading', identity: prior })
  try {
    const rawView = await rpcClaimIdentityView()
    if (!scope.isActive()) return
    writeCachedIdentity(scope, rawView)
    setState(key, { status: 'ready', identity: parseHouseholdIdentity(rawView) })
  } catch {
    if (!scope.isActive()) return
    setState(key, { status: 'error', identity: prior })
  }
}

export interface ConfigurePeopleInput {
  personAName: string
  personBName: string
  /** Optional login email for each person (auto-claim address). Empty/undefined
      clears it. The server lowercases/trims and maps empty → null. */
  personAEmail?: string
  personBEmail?: string
  tool?: IdentityTool
  /** Which canonical slot the tool's legacy slot A/B represents. */
  toolSlotAPerson?: CanonicalSlot
  toolSlotBPerson?: CanonicalSlot
}

/** Empty/whitespace/undefined → null; otherwise the trimmed value (the server
    lowercases and re-validates). */
function emailArg(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/** Upsert the two canonical people and optionally one complete tool binding
    (idempotent server-side). On success the returned server view becomes the
    new snapshot + cache; on failure nothing changes locally. */
export async function configureHouseholdPeople(input: ConfigurePeopleInput): Promise<HouseholdIdentity | null> {
  const scope = tryCaptureScope()
  const { data, error } = await supabase.rpc('configure_household_people', {
    p_person_a_name: input.personAName.trim(),
    p_person_b_name: input.personBName.trim(),
    p_person_a_email: emailArg(input.personAEmail),
    p_person_b_email: emailArg(input.personBEmail),
    p_tool: input.tool ?? null,
    p_tool_slot_a_person: input.toolSlotAPerson ?? null,
    p_tool_slot_b_person: input.toolSlotBPerson ?? null,
  })
  if (error) throw toIdentityError(error)
  const parsed = parseHouseholdIdentity(data)
  if (scope && scope.isActive()) {
    writeCachedIdentity(scope, data)
    setState(scopeKey(scope), { status: 'ready', identity: parsed })
  }
  return parsed
}

/** Set or clear (null) the CALLER'S own person mapping. The snapshot is not
    touched here — callers refresh so the marker only ever renders from a
    server-confirmed view. */
export async function setMyHouseholdPerson(personId: string | null): Promise<void> {
  const { error } = await supabase.rpc('set_my_household_person', { p_person_id: personId })
  if (error) throw toIdentityError(error)
}
