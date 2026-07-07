# Plan 56 — Fail loud when Supabase env is missing in a prod build

**Status:** plan · **Owner model:** Haiku-suitable (two guard snippets, both
written out in the plan; smallest change in the batch — just confirm the test
suite stays green without env vars) ·
**Severity: LOW (L5)** · **Source:** repo audit 2026-07-06 ·
**Req:** 14 of the audit batch (smallest — good gap-filler PR) ·
Touches `web/src/lib/supabase.ts` (+ optionally `.github/workflows/deploy.yml`).

## Finding

`supabase.ts:11–24` warns to the console and falls back to a dummy client
(`http://localhost:54321` / `anon-placeholder`) when `VITE_SUPABASE_URL` /
`VITE_SUPABASE_PUBLISHABLE_KEY` are unset. Right call for dev/tests — but a
misconfigured PROD build (secret renamed, fork without secrets, CI change)
ships a login screen that can never work, discovered only when someone can't
sign in. The console.warn is invisible on Pages.

## Fix

Two layers, both tiny:

**1. Build-time guard (primary — fails the deploy, not the user):** in
`deploy.yml`, before the build step:

```yaml
- name: Require Supabase env
  run: |
    test -n "${{ secrets.SUPABASE_URL }}" || { echo '::error::SUPABASE_URL secret is unset'; exit 1; }
    test -n "${{ secrets.SUPABASE_PUBLISHABLE_KEY }}" || { echo '::error::SUPABASE_PUBLISHABLE_KEY secret is unset'; exit 1; }
```

**2. Runtime guard (belt-and-braces):** in supabase.ts, keep the dev fallback
but throw in prod:

```ts
if (!url || !key) {
  if (import.meta.env.PROD) {
    throw new Error('[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY missing from the build')
  }
  console.warn('…existing dev message…')
}
```

Note: the throw happens at module-eval → blank page instead of a dead login
screen. That's the point (fail loud), and the CI guard means it should never
actually be reached. Vitest runs with PROD=false, so tests keep the dummy
client (verify: the suite must stay green with no .env.local present).

## Acceptance criteria

- Deploy workflow fails fast with a clear error when either secret is blanked
  (test on a branch via workflow_dispatch if easy, else reason it through).
- Local dev without `.env.local` still boots with the existing warning.
- Full test suite green without env vars set.
