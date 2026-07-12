# Plan 96 — Verify the deployed Supabase security boundary

**Status:** proposed verification plan · **Priority:** Medium · **Effort:** M ·
**Owner model:** GPT-5.6 Sol — owns adversarial security analysis, live-vs-repo
parity assessment, and evidence-backed reporting · **Requires approval:**
read-only access to the live project/security settings

## Goal

Close the review's remaining verification gaps. The migration history appears
household-safe, but checked-in SQL is not proof that production has the same
schema, grants, Auth hook, exposed schemas, or deployment headers.

## Current code-level conclusion

- All 13 application tables enable RLS.
- Household-data `FOR ALL` policies have both `USING` and `WITH CHECK` against
  `private.current_household()`.
- `households`/`household_members` intentionally expose SELECT only; invite
  operations are separately scoped.
- Every reviewed SECURITY DEFINER function pins `search_path=''`.
- signup-hook execution is revoked from `public`, `anon`, and `authenticated`.
- no service-role key pattern was found in source or the existing build output.
- no application `dangerouslySetInnerHTML`/`innerHTML` sink was found.
- `npm audit` reported zero advisories on 2026-07-12; this is a point-in-time
  result, not a permanent guarantee.

## Verification checklist

### Live database — read only

- Compare applied migration versions with the repository.
- Run/adapt `supabase/audit-rls.sql` against every public table.
- Enumerate policies by command, role, `qual`, and `with_check`.
- Enumerate SECURITY DEFINER functions, owners, `proconfig` search paths, execute
  grants, and exposed schemas.
- Verify `private` grants contain only the intended schema/function access and no
  table access.
- Verify `email_may_sign_in(text)` remains non-executable by `anon`,
  `authenticated`, and `public`.
- Verify the Before User Created hook points to `hook_before_user_created`.
- Exercise hostile two-user requests with fictional accounts: cross-household
  SELECT/INSERT/UPDATE/move/DELETE must fail for every table.

### Built static application

- Build from a clean environment and search emitted assets for service-role,
  secret-key, token, and source-map leakage patterns.
- Confirm only the publishable key is injected.
- Inspect the deployed GitHub Pages response headers and document effective CSP,
  framing, referrer, MIME-sniffing, and permissions policies. Do not claim GitHub
  Pages can set a header it cannot actually set.

### Dependency and regression gate

- Run full `npm audit` and record date/lockfile commit.
- Add CI checks for secret patterns and migration/RLS drift where practical,
  avoiding false confidence from regex-only scanning.

## Safety constraints

- No production writes, user records, household data, tokens, or sensitive logs.
- Use fictional test users/data in an approved non-production project for
  hostile request tests.
- Do not change Auth, RLS, schema, or GitHub settings during verification; open
  separate implementation plans for confirmed drift.

## Deliverable and acceptance criteria

- A dated report containing exact queries/checks, sanitized results, and a
  pass/fail row for every table/function/grant/header.
- Any production drift is a confirmed finding with a minimal new-migration fix;
  no applied migration is edited.
- No statement says “production is secure” solely from repository inspection.
