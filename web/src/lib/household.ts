/* household.ts — client helpers for the household / invite layer (plan 16h).
   All membership writes live in the security-definer `claim_household` RPC; the
   client only ever touches `household_invites` (scoped by RLS to the caller's
   household / own email) and calls the two RPCs. supabase-js never throws — it
   returns { data, error } — so every helper resolves and callers check `error`. */

import { supabase } from './supabase'

export interface Member {
  user_id: string
  role: string
  email: string | null
}

export interface Invite {
  email: string
  created_at: string
}

// Ensure the signed-in user has a household: join a pending invite, else create
// their own. Idempotent — safe to call on every sign-in. Returns the household
// id, or null on error (caller can still render; stores fall back to cache).
export async function claimHousehold(): Promise<string | null> {
  const { data, error } = await supabase.rpc('claim_household')
  if (error) return null
  return (data as string | null) ?? null
}

// The current household's members WITH their emails, via the security-definer
// household_roster RPC (auth.users isn't readable from the client). Owners first.
export async function listMembers(): Promise<Member[]> {
  const { data, error } = await supabase.rpc('household_roster')
  if (error || !data) return []
  return data as Member[]
}

// Pending invites for the current household (via the inv_read_household policy).
export async function listInvites(): Promise<Invite[]> {
  const { data, error } = await supabase
    .from('household_invites')
    .select('email, created_at')
    .order('created_at', { ascending: true })
  if (error || !data) return []
  return data as Invite[]
}

// Invite an email into the current household. household_id is filled by the
// column default (current_household()); the inv_write with_check re-pins it.
// Returns an error message on failure, or null on success.
export async function createInvite(email: string): Promise<string | null> {
  const { error } = await supabase.from('household_invites').insert({ email: email.trim().toLowerCase() })
  return error ? error.message : null
}

// Withdraw a pending invite (inv_delete policy scopes it to your household).
export async function removeInvite(email: string): Promise<string | null> {
  const { error } = await supabase.from('household_invites').delete().eq('email', email)
  return error ? error.message : null
}

// Is there a pending invite addressed to ME, for a household I'm NOT already in?
// This is the "signed in before being invited" case (plan 50): claim_household
// won't touch me because I already have a household, so the invite sits pending
// until I accept it explicitly. Uses the inv_read_own policy (invites to my
// email) and hh_read (my own household row) — both RLS-scoped to me.
export async function pendingInviteToJoin(): Promise<boolean> {
  const { data: me } = await supabase.auth.getUser()
  const email = me.user?.email?.toLowerCase()
  if (!email) return false
  const [{ data: hh }, { data: inv, error }] = await Promise.all([
    supabase.from('households').select('id'),
    supabase.from('household_invites').select('household_id').ilike('email', email),
  ])
  if (error || !inv) return false
  const mine = new Set((hh ?? []).map((h) => h.id as string))
  return inv.some((i) => !mine.has(i.household_id as string))
}

// Move me into the household that invited my email (accept_invite RPC). The old
// household is abandoned in place, not purged. Returns an error message on
// failure, or null on success — callers should then fully reload so every store
// re-reads under the new household.
export async function acceptInvite(): Promise<string | null> {
  const { error } = await supabase.rpc('accept_invite')
  return error ? error.message : null
}

// Leave my current household (leave_household RPC). Refused for the last member.
// Returns an error message on failure, or null on success; on next sign-in
// claim_household provisions a fresh private household.
export async function leaveHousehold(): Promise<string | null> {
  const { error } = await supabase.rpc('leave_household')
  return error ? error.message : null
}

export async function signOut(): Promise<void> {
  try { await supabase.auth.signOut() } catch { /* already gone */ }
}
