/* household.ts — client helpers for the household / invite layer (plan 16h).
   All membership writes live in the security-definer `claim_household` RPC; the
   client only ever touches `household_invites` (scoped by RLS to the caller's
   household / own email) and calls the two RPCs. supabase-js never throws — it
   returns { data, error } — so every helper resolves and callers check `error`. */

import { supabase } from './supabase'

export interface Member {
  user_id: string
  role: string
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

// Anon-callable gate: may this email create an account? True only when it has a
// pending invite. Drives `shouldCreateUser` on the magic-link request so
// strangers can't sign up while invited partners still self-onboard. Defaults to
// false on error (fail closed).
export async function emailMaySignIn(addr: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('email_may_sign_in', { addr })
  if (error) return false
  return data === true
}

// The current household's members (RLS scopes this to your household).
export async function listMembers(): Promise<Member[]> {
  const { data, error } = await supabase.from('household_members').select('user_id, role')
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

export async function signOut(): Promise<void> {
  try { await supabase.auth.signOut() } catch { /* already gone */ }
}
