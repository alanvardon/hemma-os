// supabase.ts — the single shared Supabase browser client for the whole app.
// The URL + publishable ("anon") key are injected at build time from Vite env
// vars: web/.env.local in dev, GitHub Actions secrets in the Pages build (see
// .github/workflows/deploy.yml). The publishable key is public by design —
// Row Level Security on every table is what actually guards the data.
import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!url || !key) {
  if (import.meta.env.PROD) {
    throw new Error(
      '[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY missing from the build',
    )
  }
  // Loud in dev if .env.local is missing/incomplete; harmless in prod where the
  // CI secrets are always set.
  console.warn(
    '[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY are not set — ' +
      'sign-in and cloud sync will fail. Copy web/.env.example to web/.env.local.',
  )
}

// Fall back to a syntactically-valid dummy when env is missing so importing this
// module never throws (createClient rejects empty strings). Prod always has the
// real CI secrets; this only bites in tests / dev-without-.env.local, where no
// request is actually made.
export const supabase = createClient(url || 'http://localhost:54321', key || 'anon-placeholder')
