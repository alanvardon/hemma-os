/* devAuth.ts — localhost-only convenience so the dev server skips the magic-link
   screen. STRICTLY dev-only AND local-only, double-gated so it can never run
   against production:

     1. The one call site (AuthGate) is behind `import.meta.env.DEV` and uses a
        dynamic import(), so this module is tree-shaken out of the production
        bundle entirely — the dev credentials never ship.
     2. isLocalSupabase() requires the configured Supabase URL to be localhost,
        so even a dev server accidentally pointed at a remote/prod project won't
        auto-sign-in.

   It signs in a throwaway local test user (creating it on the first run after a
   `supabase db reset`); the app's existing claim_household RPC then gives that
   user its own fresh, empty LOCAL household. Nothing here ever touches the
   production database. */

import { supabase } from './supabase'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

// True only when VITE_SUPABASE_URL points at a local Supabase instance.
export function isLocalSupabase(): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(import.meta.env.VITE_SUPABASE_URL ?? '').hostname)
  } catch {
    return false
  }
}

const DEV_EMAIL = import.meta.env.VITE_DEV_EMAIL ?? 'dev@local.test'
const DEV_PASSWORD = import.meta.env.VITE_DEV_PASSWORD ?? 'local-dev-password'

// Establish a session for the seeded dev user so AuthGate falls straight through
// to the app. No-op if not local, or if a session already exists.
export async function maybeDevSignIn(): Promise<void> {
  if (!isLocalSupabase()) return
  const { data } = await supabase.auth.getSession()
  if (data.session) return
  const creds = { email: DEV_EMAIL, password: DEV_PASSWORD }
  const { error } = await supabase.auth.signInWithPassword(creds)
  if (error) {
    // First run after a fresh `supabase db reset`: the user doesn't exist yet.
    // Create it (auto-confirmed locally — enable_confirmations = false in
    // supabase/config.toml), which also signs it in.
    const { error: signUpError } = await supabase.auth.signUp(creds)
    if (signUpError) throw signUpError
  }
}
