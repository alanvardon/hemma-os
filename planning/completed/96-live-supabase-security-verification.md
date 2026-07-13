# Plan 96 — Verify the deployed Supabase security boundary

**Status:** completed · **Priority:** Medium · **Effort:** M ·
**Owner model:** GPT-5.6 Sol — owns adversarial security analysis, live-vs-repo
parity assessment, and evidence-backed reporting · **Requires approval:**
read-only access to the live project/security settings

## Goal

Close the review's remaining verification gaps. The migration history appears
household-safe, but checked-in SQL is not proof that production has the same
schema, grants, Auth hook, exposed schemas, or deployment headers.

## Review starting point

These pre-verification observations are retained for context and are
superseded where the dated report has stronger evidence.

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

## Progress — 2026-07-13

The sanitized report is
`supabase/audits/2026-07-13-security-boundary.md`.

- Local migration replay, catalog assertions, build/deployed-asset scans,
  response-header inspection, dependency audit, and a transactional two-user
  household-isolation regression are complete.
- The approved `20260713110000_restrict_public_function_execute.sql` migration
  fixes the confirmed function-grant defects; the hard local catalog gate passes
  14/14, and the owner confirmed the post-push live grant matrix.
- Baseline live migration parity was verified at 18/18 before adding the
  approved 19th migration. Supplied SQL Editor evidence also
  verifies 15/15 table RLS flags, all 18 policy shapes, all 12 function
  owner/search-path rows, matching function-grant defects, and private-schema
  usage plus a zero private client-table grant count.
- The owner applied the approved grant migration and confirmed 19/19 live
  migration parity. A post-push audit also reconfirmed 15/15 RLS flags and all
  18 policy shapes. Focused post-push verification confirms all four changed
  function grants match the intended matrix; all 12 SECURITY DEFINER functions
  remain owned by `postgres` with empty search paths.
- The owner remediated the initially blank hosted Authentication > Hooks setting
  on 2026-07-13 and dashboard-verified a Before User Created registration
  targeting `public.hook_before_user_created`. Function metadata/ACL is
  independently live-catalog verified; no production signup test was run.
- The local-only hostile two-user regression passes 133/133 across every public
  table using fictional users and households. It covers cross-household reads,
  inserts, updates, moves, deletes, success controls, read-only/RPC surfaces,
  and the intended invite-recipient exception. No hostile write was sent to
  production; deployed parity relies on 19/19 migrations and live catalog
  evidence. The documented response-header gaps remain a separate hosting
  decision.
- No production data was read or changed. The owner changed only the hosted
  hook registration described above; the agent made no production change.
