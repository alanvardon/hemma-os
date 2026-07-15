# Plan 108 — Sanitised production snapshot for staging previews

**Status:** proposed · **Priority:** High (safe pre-merge testing) · **Depends
on:** none · **Effort:** L · **Owner model:** GPT-5.6 Sol · **Source:** owner
request 2026-07-15 to test PRs against representative household data without
merging to production · **Touches:** one new repeatable Supabase migration for
an export-only role; `scripts/staging/` sanitisation and refresh tooling;
`.github/workflows/refresh-staging.yml`; a staging/preview deployment workflow;
build-security checks; staging runbook; `planning/README.md`.

> **Security and infrastructure approval required before implementation.** This
> plan deliberately introduces a SELECT-only production database credential, a
> second Supabase environment, protected GitHub environment secrets and a
> separate preview deployment. The owner approved the sanitised-snapshot
> direction, but must approve the concrete Supabase project/branch and preview
> hosting choice before credentials or remote resources are created. Agents
> must never inspect, export or modify production data while implementing or
> verifying this plan.

## Goal

Allow the owner to test an unmerged branch against a recent, representative
copy of the household's data while making a write to production impossible
from the preview application.

The steady-state flow is one-way:

```text
production Supabase
  SELECT-only allow-listed export
             │
             ▼
  in-memory sanitisation + validation
             │
             ▼
isolated staging Supabase ◀── selected branch preview
             │
             └── writes stay in staging and are discarded on refresh

There is no staging → production path.
```

This is not continuous replication. The initial release provides an explicitly
approved **Refresh staging from production** action and records when the
snapshot was taken. A nightly schedule can be added only after the manual path
has proved reliable and the owner asks for it.

## Current gap

- Pull-request CI uses unit tests, local Supabase and Playwright with a mocked
  Supabase boundary. This is correct for automation but cannot reproduce every
  real household-data shape.
- `.github/workflows/deploy.yml` deploys only `main`, using the production
  Supabase URL and publishable key. The first owner-accessible cloud test is
  therefore after merge.
- `supabase/seed.sql` contains a fictional local user and household. It must
  remain local-only and must not become a production export mechanism.
- The production-only `policy-rate-notify` path can send email through Resend.
  No staging refresh may copy its state or enable its scheduler/secrets.

Supabase persistent branches are intended for staging/QA and have independent
database, API and Auth credentials. They start without production data by
default, which is the boundary this plan retains while importing only a
sanitised allow-list. See the official [Supabase Branching
documentation](https://supabase.com/docs/guides/deployment/branching).

## Decisions locked

### 1. Separate environments, never split reads and writes

- The preview bundle receives only `STAGING_SUPABASE_URL` and the staging
  publishable key. It never receives a production URL, key or database
  credential.
- The app reads and writes one environment for its whole session. Do not route
  reads to production and writes to staging; that would create inconsistent
  identities, revisions, RLS decisions and mutation targets.
- Production and staging keep independent Auth, storage, Edge Function secrets,
  cron jobs and API keys.
- Automated CI remains local/mocked. Manual staging is additional evidence, not
  a replacement for calculation, persistence or RLS tests.

### 2. Production access is structurally read-only

Add a repeatable migration defining a `staging_export_reader` **NOLOGIN** role
and a narrow `staging_export` schema:

- expose security-definer, security-barrier export views/functions that resolve
  one configured household server-side and return only its allow-listed rows;
- keep the login→household mapping in a private configuration table that the
  export role cannot read or change; the owner configures that mapping out of
  band rather than committing a production household ID;
- grant connection/schema usage and `SELECT` only on that export interface,
  never on the underlying public tables;
- grant no access to `auth`, `storage`, `vault`, `private`, functions, sequences
  or future tables;
- do not use `ALTER DEFAULT PRIVILEGES` to grant future tables automatically;
- explicitly revoke insert, update, delete, truncate, references, trigger,
  execute and role membership that could escalate privileges;
- add database tests proving a representative `SELECT` succeeds and every
  mutation fails.

The owner creates a separate LOGIN principal that inherits only this NOLOGIN
role, maps it to the selected household in the private configuration, and
stores its connection string in the protected GitHub `staging-refresh`
environment. Its password and household mapping are never committed or
printed. Rotation and revocation commands belong in the runbook.

The refresh workflow must use this restricted credential for production. It
must fail closed if its current user has unexpected write privileges or if the
source database/project identity does not equal the configured production
identity.

### 3. Export an allow-list, not a database dump

Never clone or dump the complete production database. A full Supabase restore
copies Auth records, password hashes, roles and encrypted data, and can retain
extensions that perform external operations; Supabase explicitly calls these
risks out in its [restore-to-new-project
documentation](https://supabase.com/docs/guides/platform/clone-project).

The first allow-list is limited to product state needed to reproduce the UI:

- `households`;
- `tool_state`;
- `scenarios`;
- `monthend_items`, `monthend_payments`, `salary_submissions`;
- `house_items`;
- `mortgage_banks`, `mortgages`, `mortgage_loan_parts`;
- `mortgage_rate_periods`, `mortgage_payments`, `mortgage_valuations` and the
  legacy `mortgage_contributions` table while it still exists.

Explicitly exclude:

- every `auth`, `storage`, `vault` and `private` table;
- `household_members` and `household_invites`;
- `notification_state`;
- sync-operation receipts, secrets, database roles and migration history;
- cron/net configuration, Edge Function configuration and external-service
  credentials.

The allow-list is code-reviewed and versioned. A newly added table is excluded
until its fields, relationships and sanitisation rule are intentionally added.

### 4. Preserve financial behaviour while removing identity

The sanitiser operates on typed rows before anything reaches staging:

- select only the configured source household;
- replace its household UUID with a fixed staging household UUID across every
  included table;
- retain financial amounts, dates, rates, categories and record relationships,
  because these are what make the snapshot useful for calculation testing;
- replace household display names, person labels and free-text descriptions or
  notes with deterministic neutral values while preserving null/empty/length
  characteristics needed by the UI;
- remap primary/foreign UUIDs deterministically with a keyed one-way mapping so
  joins remain valid but production identifiers are absent;
- reject unknown columns, invalid relationships, duplicate mapped IDs,
  malformed JSON and any email/token/URL-shaped value in the sanitised output;
- never write the unsanitised export or mapping key to disk, workflow artifacts,
  logs or caches.

The mapping key is a staging-refresh secret. Deterministic mapping keeps record
identity stable between refreshes, which makes before/after testing easier,
without publishing production IDs.

`tool_state` JSON needs a per-tool schema-aware sanitiser. A blanket string
replacement is not acceptable: it could miss nested identity data or corrupt
financial values. Unknown tool keys block the refresh until reviewed.

### 5. Staging owns its users and can be mutated freely

- Create two staging-only Auth users and a staging-only
  `household_members` roster after the snapshot import. Do not copy Auth users,
  emails, password hashes, identities, sessions, MFA factors or magic links.
- The staging users belong to the fixed staging household and exercise the same
  RLS policies and owner/member roles as production.
- Use credentials that cannot authenticate to production. Keep them out of the
  repository and browser bundle.
- Staging writes, deletes and imports are expected. The next refresh replaces
  all allow-listed product state and clearly warns that staging changes will be
  lost.
- Outbound email, notification schedules and production-facing functions stay
  absent or disabled. Use no Resend key in staging.

### 6. Refresh is replace-all, transactional and observable

Add a trusted `workflow_dispatch` workflow on the default branch. It accepts a
typed confirmation and a target (`persistent-staging` initially), then:

1. requires approval through the protected GitHub `staging-refresh`
   environment before either source or target database secrets are exposed;
2. validates source and target project identities and proves they differ;
3. verifies the source session is read-only and the target is staging;
4. exports the configured household through the allow-list;
5. sanitises and validates in memory, printing counts and schema names only;
6. starts a target transaction, deletes existing allow-listed staging rows in
   foreign-key order, imports the sanitised rows and recreates staging-only
   membership;
7. rolls back the entire target update on any error;
8. runs referential-integrity, row-count, RLS and secret-pattern checks;
9. records only non-sensitive metadata such as source snapshot time, target
   migration version, row counts and workflow SHA.

Do not use `pull_request_target`, do not execute scripts checked out from the
selected feature branch with production credentials, and do not upload the
snapshot as an Actions artifact. GitHub environments can hold secrets behind
deployment protection rules; see [GitHub's environment
documentation](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

Repeated refreshes with unchanged production data must create the same staged
IDs and values. A failed refresh leaves the previous complete snapshot usable.

### 7. One selected branch is published to a separate staging URL

Add a second manually triggered workflow that builds a requested branch or PR
commit using only the staging Supabase URL and publishable key.

- The staging site must have a visibly different title/banner and show branch,
  commit and snapshot age.
- The emitted bundle must fail verification if it contains the production
  Supabase project ref or production origin.
- The deployment cannot overwrite the production GitHub Pages environment or
  production custom domain.
- Only one shared staging preview needs to be active initially. Deploying a new
  branch replaces the previous preview and records exactly which SHA is live.
- Access should be restricted at the hosting layer if the chosen host supports
  it; Supabase authentication and RLS remain mandatory either way.

**Owner setup decision before this stage:** choose the separate preview host.
The lowest-change default is a second GitHub Pages repository/site; a host with
native protected PR previews is also valid but is a separate dependency and
cost decision. Do not add a hosting vendor implicitly. The plan's data and
credential boundaries are the same either way.

### 8. Schema-changing PRs get an isolated target

The persistent staging database tracks the schema on `main`. A frontend-only or
backward-compatible PR may use it directly.

A PR whose migrations are not already on `main` must not mutate the shared
staging schema. For those PRs:

- create an isolated Supabase preview branch/project;
- apply that PR's migrations there without production credentials present;
- run the trusted sanitised refresh into that isolated target;
- point that PR's frontend preview at the isolated publishable credentials;
- destroy the target when the PR closes or testing finishes.

This extension may use Supabase preview branches if available on the owner's
plan. It is implemented only after the persistent-staging path ships, so the
first PR does not grow into a full environment orchestrator.

## Files and implementation shape

Expected additions/changes:

```text
supabase/migrations/<timestamp>_staging_export_reader.sql
supabase/tests/database/staging_export_reader_test.sql
scripts/staging/export-allowlist.*
scripts/staging/sanitise-snapshot.*
scripts/staging/refresh-target.*
scripts/staging/verify-target.*
.github/workflows/refresh-staging.yml
.github/workflows/deploy-staging-preview.yml
web/src/components/StagingBanner.tsx (or a small environment-aware equivalent)
web/src/lib/build-security.* and focused tests
docs/staging-refresh.md
planning/README.md
```

Prefer existing Node/TypeScript and PostgreSQL tooling. Ask before adding a
runtime dependency. Keep all transformation logic pure and testable; workflow
YAML should coordinate scripts, not contain the sanitisation rules.

## Verification gates

### Sanitiser tests with fictional fixtures

- golden fixture covering every allow-listed table and nested `tool_state` key;
- stable ID mapping and preserved foreign keys across repeated runs;
- financial amounts/dates/rates remain exact;
- names, notes, emails, URLs, tokens and original UUIDs cannot survive;
- unknown table/column/tool key fails closed;
- malformed JSON, orphaned foreign keys and mapping collisions fail closed;
- source rows remain unchanged.

No real household row may appear in a test fixture, snapshot or test output.

### Database and workflow tests

- export role can read each allow-listed export relation for only its configured
  household and cannot read base tables, another household, excluded schemas or
  mutate any table;
- staging user can read/write only its staging household through normal RLS;
- replace-all import succeeds atomically and rollback preserves the old snapshot;
- two identical refreshes produce identical staged records;
- source/target equality and unexpected source write privileges abort before
  export;
- workflow logs and artifacts contain no snapshot content or secrets;
- notification function, cron/net jobs and external credentials are absent.

### Preview checks

- selected unmerged SHA is visible on the staging URL;
- preview reads and writes staging data, then a refresh removes those writes;
- production remains unchanged, verified through the read-only export role and
  environment identity—not by attempting a hostile production write;
- emitted preview assets contain the staging project ref and reject the
  production ref;
- production deploy still points only to production and is unchanged by a
  staging deployment;
- interactive review at 390×844 and desktop confirms the staging banner,
  snapshot age and normal save/reload behaviour.

Run the repository's ordinary `npm run lint`, `npm run test` and `npm run build`
gates when implementing. This plan does not add static-check tooling.

## Execution

1. **[GPT-5.6 Sol] Security boundary and fictional proof** — implement the
   export-role migration/tests and pure allow-list/sanitiser with exhaustive
   fictional fixtures. Gate: database security tests plus focused sanitiser
   tests; owner reviews the exact field allow-list before any remote setup.
2. **[GPT-5.6 Sol] Protected one-way refresh** — implement the transactional
   staging importer, validation and manual workflow/runbook. Gate: run entirely
   between local fictional source/target databases first; then stop for owner
   approval and owner-managed remote secret/project setup.
3. **[GPT-5.6 Terra] Staging preview deployment** — after the owner chooses the
   host, add the selected-branch deploy, staging banner/build metadata and
   production-ref rejection. Gate: staging build/security tests and proof that
   production deployment configuration is unchanged.
4. **[GPT-5.6 Sol] Remote acceptance and schema-PR extension** — owner triggers
   the first approved remote refresh; verify only sanitised outputs and metadata,
   then add the isolated target path for schema-changing PRs. Gate: manual
   staging save/reload/reset review and documented credential rotation/teardown.

Each stage keeps production writes prohibited. The orchestrating agent owns the
security review and final report and must stop rather than weaken a boundary if
the chosen Supabase/GitHub plan cannot provide it.

## Completion criteria

- The owner can choose an unmerged commit, refresh representative sanitised
  data and test it at a staging URL.
- The preview bundle has no production endpoint or credential.
- The only production credential used by automation is demonstrably SELECT-only
  and available only to a protected trusted workflow.
- No Auth data, identity, free text, notification state, secret, original UUID
  or outbound integration crosses into staging.
- Staging mutations work and are erased by the next atomic refresh.
- CI remains deterministic and independent of remote staging.
- The runbook covers setup, refresh, failure recovery, credential rotation,
  snapshot age, staging reset and complete teardown.

## Out of scope

- two-way or row-by-row production/staging synchronisation;
- writing, seeding, migrating or testing against production from an agent run;
- copying Auth users, sessions, storage objects or secrets;
- automatic refresh on every PR or exposing production credentials to PR code;
- using staging as backup or disaster recovery;
- nightly refresh until the manual workflow has shipped and been reviewed;
- multiple simultaneous frontend previews in the first release.
