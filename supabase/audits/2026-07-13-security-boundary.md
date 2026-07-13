# Deployed security-boundary verification — 2026-07-13

This report records sanitized, read-only evidence. It does **not** conclude that
the live project is secure: migration parity, supplied SQL Editor catalog
evidence, and the hosted Auth-hook inspection verify the areas stated below and
also establish concrete response-header failures. No household rows, user
records, project identifiers, URLs, keys, tokens, or emails were read or
recorded.

## Executive result

| Area | Result | Evidence |
|---|---|---|
| Repository migration replay | PASS | All 19 migrations, including the approved grant remediation, replayed successfully in a reset local Supabase database. |
| Live migration parity | PASS (owner-verified) | The owner confirmed all 19 repository versions are applied through the grant remediation migration. |
| Local table RLS and policy catalogs | PASS | 15/15 public tables have RLS; policy-shape checks passed. |
| Local SECURITY DEFINER owner/search path | PASS | 12/12 functions are owned by `postgres` and pin `search_path=""`. |
| Local function execute grants | PASS after remediation | The approved migration removes the four grant defects; the hard catalog gate passes 14/14. |
| Live table RLS and policies | PASS post-push | The owner re-ran the live audit after migration: 15/15 public tables retain RLS and all 18 policy rows retain the expected shapes. |
| Live function owners/search paths | PASS | 12/12 SECURITY DEFINER functions are owned by `postgres` and pin an empty search path. |
| Live function execute grants | PASS after remediation | Focused post-push rows match the intended four-function grant matrix exactly. |
| Live Before User Created hook target | PASS (owner-verified) | On 2026-07-13 the owner created and dashboard-verified a Before User Created registration targeting `public.hook_before_user_created`. No production signup test was run. |
| Private schema usage | PASS (local/live) | `anon` has no usage; `authenticated` has the policy-required usage. |
| Private schema client table grants | PASS (local/live) | Both catalog results establish a client table-grant count of zero. |
| Hostile two-user isolation | PASS (local) | A transactional pgTAP regression passed 133/133 across all 15 public tables using two fictional users and households. No hostile write was sent to production; deployed parity relies on 19/19 migrations plus the live catalog evidence. |
| Clean local build secret/source-map scan | PASS | Five emitted text assets; no privileged pattern, service-role JWT, or source map. |
| Deployed text-asset scan | PASS | HTML plus two same-origin JS/CSS assets; one publishable key, no service-role/JWT/private-key pattern. |
| Deployed security response headers | FAIL | All five reviewed response headers were absent. A meta CSP is present but cannot replace all headers. |
| Dependency audit | PASS | `npm audit` reported zero advisories at every severity. |

## Exact checks and safety controls

The following commands were run from the isolated Plan 96 worktree. Output
containing deployment identifiers was discarded before reporting.

```sh
supabase db reset --local
supabase test db --local supabase/tests/database/security_boundary_test.sql
supabase test db --local supabase/tests/database/household_isolation_test.sql
supabase migration list --linked
npm ci
npm run lint
npm run test
npm run build
npm run verify:build-security
npm audit --json
```

The deployed-page checks made only `GET`/`HEAD` requests. They retained only
HTTP status, the presence of five named security headers, sanitized CSP
directive names, and aggregate secret-scan counts. The live database attempts
confirmed exact migration-version parity. `supabase db query --linked` was then
used with SELECT-only catalog SQL passed as a command argument. It returned no
result, including for a minimal `select 1`, and was terminated rather than
falling back to a database password or interactive secret.

The owner then ran the consolidated, SELECT-only
`supabase/audit-live-security-metadata.sql` in the hosted SQL Editor and supplied
sanitized output. Unique table names establish all 15 public tables even though
the pasted Markdown split some rows. The output also establishes all 18 policy
rows, all 12 SECURITY DEFINER rows, the private-schema usage booleans, and a
private client-table grant count of zero.

The catalog assertions are executable pgTAP queries in
`supabase/tests/database/security_boundary_test.sql`; they inspect
`pg_class`, `pg_namespace`, `pg_attribute`, `pg_policies`, `pg_proc`,
`pg_roles`, privilege functions, and `information_schema.table_privileges`.
They fail CI rather than merely printing a verdict.

The behavioral assertions are in
`supabase/tests/database/household_isolation_test.sql`. Inside one rolled-back
transaction, two fictional Auth users each belong to a fictional household.
The test then switches to the `authenticated` role with user A's fictional JWT
claims. For every ordinary household store, it proves the own-row success path,
foreign `SELECT` invisibility, RLS-denied foreign `INSERT`, a successful own
`UPDATE`, RLS-denied movement into the foreign household, zero-row foreign
`UPDATE`/`DELETE`, and a successful own `DELETE`. Relationship/read-only tables
are checked through their intended direct-read and RPC/service-owned surfaces;
invites also prove the intentional recipient-read exception. Exact `42501` RLS
errors plus successful controls distinguish isolation from malformed fixtures.
The gate passed 133/133 after a clean migration replay.

## Public-table RLS and policy inventory (local replay + live catalog)

| Table | RLS | Expected client policy | Result |
|---|---:|---|---|
| `house_items` | on | authenticated `ALL`, household `USING` + `WITH CHECK` | PASS local/live |
| `household_invites` | on | scoped recipient/household reads, household insert/delete | PASS local/live |
| `household_members` | on | household-scoped `SELECT` only | PASS local/live |
| `households` | on | current-household `SELECT` only | PASS local/live |
| `mortgage_contributions` | on | authenticated `ALL`, household `USING` + `WITH CHECK` | PASS local/live |
| `mortgage_loan_parts` | on | authenticated `ALL`, household `USING` + `WITH CHECK` | PASS local/live |
| `mortgage_payments` | on | authenticated `ALL`, household `USING` + `WITH CHECK` | PASS local/live |
| `mortgage_rate_periods` | on | authenticated `ALL`, household `USING` + `WITH CHECK` | PASS local/live |
| `mortgage_valuations` | on | authenticated `ALL`, household `USING` + `WITH CHECK` | PASS local/live |
| `monthend_items` | on | authenticated `ALL`, household `USING` + `WITH CHECK` | PASS local/live |
| `monthend_payments` | on | authenticated `ALL`, household `USING` + `WITH CHECK` | PASS local/live |
| `notification_state` | on | household `SELECT`; no authenticated writes | PASS local/live |
| `salary_submissions` | on | authenticated `ALL`, household `USING` + `WITH CHECK` | PASS local/live |
| `scenarios` | on | authenticated `ALL`, household `USING` + `WITH CHECK` | PASS local/live |
| `tool_state` | on | authenticated `ALL`, household `USING` + `WITH CHECK` | PASS local/live |

The 18 supplied live policy rows match the same command, role, `USING`, and
`WITH CHECK` shape expectations as the local replay. Behavioral isolation is
PASS locally for all 15 tables. It was deliberately not re-executed against
production: production parity is supported by the confirmed 19/19 migration
versions and the post-push live policy catalog, not by hostile production
writes.

## SECURITY DEFINER inventory (local replay + live catalog)

All functions below are owned by `postgres` and set an empty search path in both
catalogs. “Observed execution” summarizes the matching local/live role grants.

| Function | Intended client execution | Observed local/live execution | Result |
|---|---|---|---|
| `private.current_household()` | authenticated, for policies | raw `PUBLIC`/anon/authenticated; anon lacks private-schema usage | PASS (effective boundary) |
| `private.household_has_persisted_data(uuid)` | none | none | PASS local/live |
| `private.invite_cap_ok(uuid)` | authenticated, for invite policy | raw `PUBLIC`/anon/authenticated; anon lacks private-schema usage | PASS (effective boundary) |
| `public.accept_invite()` | authenticated | authenticated | PASS local/live |
| `public.claim_household()` | authenticated | authenticated | PASS local/live |
| `public.delete_mortgage_loan_part(text)` | authenticated | authenticated | PASS local/live |
| `public.email_may_sign_in(text)` | none | none | PASS local/live post-push |
| `public.hook_before_user_created(jsonb)` | Auth administrator only | Auth administrator only | PASS local/live |
| `public.household_roster()` | authenticated | authenticated | PASS local/live post-push |
| `public.leave_household()` | authenticated | authenticated | PASS local/live |
| `public.settle_items(text,jsonb,text,text,numeric,text,text,timestamptz)` | authenticated | authenticated | PASS local/live post-push |
| `public.unsettle_payment(text)` | authenticated | authenticated | PASS local/live post-push |

The captured pre-push `email_may_sign_in` failure contradicted the earlier
code-level conclusion: revoking `anon` and `authenticated` did not remove
PostgreSQL's default `PUBLIC` execute privilege. The other three public RPCs
performed their own authentication/household checks, so the audit did not
demonstrate a cross-household bypass, but their grants were broader than
intended.

The owner approved the smallest corrective migration. It is included as
`20260713110000_restrict_public_function_execute.sql` with these exact
operations:

```sql
revoke execute on function public.email_may_sign_in(text)
  from public, anon, authenticated;

revoke execute on function public.household_roster() from public, anon;
grant execute on function public.household_roster() to authenticated;

revoke execute on function public.settle_items(
  text, jsonb, text, text, numeric, text, text, timestamp with time zone
) from public, anon;
grant execute on function public.settle_items(
  text, jsonb, text, text, numeric, text, text, timestamp with time zone
) to authenticated;

revoke execute on function public.unsettle_payment(text) from public, anon;
grant execute on function public.unsettle_payment(text) to authenticated;
```

The private helpers are unchanged. Their schema/function ACL interaction
supports RLS policy evaluation and needs separate analysis before any change.
The migration replayed locally and the pgTAP catalog gate passed 14/14. The
owner subsequently confirmed it is applied in production with 19/19 migration
parity. Focused post-push rows from
`supabase/verify-live-function-grants.sql` now confirm `email_may_sign_in` is
executable by none of the three client roles, while `household_roster`,
`settle_items`, and `unsettle_payment` are executable by `authenticated` only.
The full 12-function inventory still reports owner `postgres` and an empty
search path throughout; the hook and private-helper controls are unchanged and
pass.

## Hosted Auth hook

The repository-local ACL for `hook_before_user_created(jsonb)` is correct: the
Auth administrator can execute it and `PUBLIC`, `anon`, and `authenticated`
cannot. Live catalog evidence independently verifies that the function exists,
is owned by `postgres`, pins an empty search path, and has the intended execute
ACL. The initial dashboard inspection found Authentication > Hooks blank, which
left the invite-only signup gate inactive. The owner then performed the exact
manual remediation on 2026-07-13:

1. Open Dashboard > Authentication > Hooks.
2. Choose Add hook, then Before User Created.
3. Select Postgres function `public.hook_before_user_created`.

The owner confirmed in the dashboard that the hook was created with that target.
This is owner-supplied dashboard evidence, not an independent API read of the
hosted Auth configuration. No production signup attempt was performed, so the
registration check does not independently exercise allow/deny behavior.

## Built and deployed application

The local production build passed the semantic artifact scanner. The scanner
decodes JWT-shaped values and rejects a `service_role` payload; it also rejects
Supabase secret-key prefixes, service-role environment names, private-key
material, common cloud-token prefixes, source-map files, and source-map
references. It reports categories and counts only, never matching values.

The deployed read-only scan found exactly one `sb_publishable_` value, no
JWT-shaped value, and no privileged pattern in the HTML and same-origin JS/CSS.
This confirms the currently emitted client credential is publishable; it does
not make that credential an authorization boundary—RLS remains the boundary.

## Deployed response policy

The deployed document returned HTTP 200. Results below are the observed
response, not assumptions about hosting defaults.

| Control | Response header | Result | Effective fallback |
|---|---|---|---|
| Content Security Policy | `Content-Security-Policy` | ABSENT / FAIL | A meta CSP is present with default, script, style, image, font, media, connect, object, and base directives. |
| Framing | `X-Frame-Options` or CSP `frame-ancestors` | ABSENT / FAIL | None; `frame-ancestors` is not provided by the meta policy. |
| Referrer | `Referrer-Policy` | ABSENT / FAIL | Browser default. |
| MIME sniffing | `X-Content-Type-Options` | ABSENT / FAIL | None. |
| Permissions | `Permissions-Policy` | ABSENT / FAIL | Browser defaults. |

The meta CSP limits script execution and network destinations, but it cannot be
reported as equivalent to all missing response headers. Any header remediation
requires a separately approved hosting/security change.

## Dependency result

On 2026-07-13, `npm audit --json` reported 0 info, low, moderate, high,
critical, and total advisories for `web/package-lock.json` at repository
baseline commit `209c767`. This is point-in-time evidence only.

## Remaining verification work

1. Treat the response-header gaps as a separate hosting/security decision.
2. If a separately approved remote non-production project becomes available,
   the local two-user regression may be repeated there for an additional
   environment-parity check. Never run hostile writes against production.
