# Plan 85 — Seed a private demo household with realistic data in prod

**Status:** plan · **Owner model:** Opus (small artefact, but it runs **one-off
SQL directly against the production Supabase project** next to the real
household — every statement must be household-scoped and reversible; a bare
`delete`/`update` or a wrong `household_id` corrupts live data. The blob shapes
must also be captured correctly or the app renders garbage. Stakes, not diff
size.) · **Source:** request 2026-07-10 (owner wants a populated account to
show the app off from) · **Touches:** new one-off script
`supabase/demo/seed_demo_household.sql` (NOT a migration — see below) + a short
runbook. No `web/` source changes; no schema changes.

## Goal

A second, **private** account — a separate email that only the owner logs into
via the normal magic-link flow — that lands in its own household pre-populated
with a plausible lived-in Swedish couple: an active mortgage, a monthly budget,
a couple of month-end settlements, a consultant calc and a salary-exchange
scenario, and one or two housing-purchase scenarios. It exists so the app can
be demoed fully populated without exposing or mutating the owner's real
household. It is **not** public: no "Try the demo" button, no shared password,
no anonymous route. Prod stays invite-only exactly as today.

## Why this is only a data + onboarding task, not a code change

Prod already has every mechanism needed. The two gates that would normally block
a new email turn out to be the exact tools that onboard the demo cleanly:

1. **Signup gate** — `public.hook_before_user_created`
   (`supabase/migrations/20260705210000_signup_hook_invite_gate.sql:31`) 403s
   any new user whose email has **no** matching `household_invites` row. So the
   demo email cannot sign up unless we insert an invite first.
2. **Household attach** — `public.claim_household()`
   (`supabase/migrations/20260708100000_one_household_per_user.sql`) runs on
   first sign-in. If it finds a pending invite for the email it **joins that
   invite's household and consumes the invite**; otherwise it creates a fresh
   empty "Mitt hushåll".

Therefore **one `household_invites` row pointing the demo email at a
pre-created, pre-seeded household** does both jobs at once: it lets the email
past the signup hook, and it makes `claim_household` attach the login to the
household that already holds the demo data. No hand-written `auth.users` row is
needed (unlike the local `supabase/seed.sql`, which only exists because
localhost has no email delivery). Everything is done with ordinary inserts the
RLS-bypassing `postgres` role can make in the SQL editor.

## Data model — what gets written to prod

Everything is scoped to a single new `households.id` (call it `:HID`). The rows,
by table:

| Table | Rows | Notes |
|---|---|---|
| `households` | 1 | `name = 'Demo · Familjen Lundqvist'` (any clearly-demo label) |
| `household_invites` | 1 | `email = <demo email>`, `household_id = :HID` — the gate/attach key |
| `household_members` | 0 at seed time | created by `claim_household` on first login (role `member`); optionally promoted to `owner` afterward |
| `mortgage_loan_parts` | 1–2 | e.g. one bunden + one rörlig part, `start_balance` ~3.5M total |
| `mortgage_rate_periods` | 2–3 | matching `loan_part_id`s; `rate_type` `rörlig`/`bunden` |
| `mortgage_payments` | ~12–24 | a year of interest/amortization rows, realistic `paid_by` mix |
| `mortgage_valuations` | 2 | one `is_purchase = true` (~5.0M), one recent valuation |
| `mortgage_contributions` | 1–2 | kontantinsats rows |
| `scenarios` | 1–2 | Bostadskalkyl purchase scenarios |
| `tool_state` | 3 | Konsultkalkyl, Löneväxling, Hushållsbudget blobs (one jsonb row per tool) |
| `salary_submissions` | a few | Löneväxling history if the tool stores it separately |
| `monthend_items` + `monthend_payments` | 1–2 months' worth | Månadsavslut settlements |

Exact column lists are in `supabase/migrations/20260705160000_bolanekoll_tables.sql`
(the five `mortgage_*` tables — all `id text`, `household_id uuid`, dates as
`text`) and the remote schema dump for `scenarios` / `tool_state` /
`salary_submissions` / `monthend_*`. **Do not hand-author the `tool_state` /
scenario / month-end blobs from the schema** — capture them from the app instead
(next section), because their jsonb shape is defined by the TS store code, not
the DB, and hand-written JSON drifts silently.

### Build the fixture by capturing from the isolated local dev env — do not hand-write it

The reliable way to get shape-correct rows for **every** tool, including the
jsonb blobs, is to enter the demo data through the real app against the
**isolated local Supabase** (plan 83 — `localhost:5174`, local DB, disposable,
already isolated from prod; see the dev-server memory), then dump those rows:

1. `supabase start` + `supabase db reset` (seeds the local `dev@local.test`
   household). Run the app at `localhost:5174`.
2. In the running app, fill in realistic demo data across **all** tools:
   Bolånekoll (loan parts, a year of payments, a valuation + purchase),
   Hushållsbudget, Konsultkalkyl, Löneväxling, Månadsavslut (settle a month or
   two), Bostadskalkyl (save 1–2 scenarios). This routes every write through the
   real store code, so the persisted rows/blobs are correct by construction.
3. Find the local dev household id:
   `select id from public.households where name = 'Dev household';` (from
   `supabase/seed.sql` it is `00000000-0000-0000-0000-0000000d00d0`).
4. Dump the data rows for that household from each data table listed above —
   `pg_dump --data-only --inserts` filtered per table, or a `copy (select …)`
   per table — into `supabase/demo/seed_demo_household.sql`.
5. In that dumped SQL, **replace the local household id with `:HID`** (a psql
   variable, so the same script works for any target household) and drop any
   `household_members` / `households` rows the dump captured (those come from
   steps in the runbook, not the data load). Leave the `text` primary keys as
   captured — they are `Date.now().toString(36)`-style and globally unique; a
   collision with an existing prod row is astronomically unlikely, but the load
   is `insert` (not upsert) so a collision would fail loud rather than clobber.

The result is a single idempotent-ish `seed_demo_household.sql` that inserts
only into the demo household, parameterised on `:HID`.

## Runbook — applying it to prod (owner runs these; agent cannot reach prod)

Prod SQL is run from the **owner's interactive shell** (`supabase db execute
--linked` / `--project-ref …`) or the Supabase dashboard SQL editor — the agent
Bash PATH has neither the linked CLI nor prod credentials. Order:

1. **Create the household + invite** (capture the returned id as `:HID`):
   ```sql
   insert into public.households (name)
     values ('Demo · Familjen Lundqvist') returning id;   -- copy this uuid → :HID
   insert into public.household_invites (household_id, email)
     values (:'HID', 'demo.hemmaos@<your-domain>');        -- lowercase; matches hook
   ```
2. **Load the fixture** (household still empty of a member — fine, RLS is bypassed
   by the `postgres` role, and `household_id` is set explicitly on every row):
   ```sql
   \set HID '…the uuid from step 1…'
   \i supabase/demo/seed_demo_household.sql
   ```
3. **First login (owner, in a browser):** open the prod app, enter the demo
   email, click "Skicka länk", open the magic link on that device. The signup
   hook passes (invite exists); `claim_household` consumes the invite and adds
   the demo user to `:HID` as `member`. The seeded data is now visible.
4. **Optional polish:** promote to owner so the household menu shows full
   controls:
   ```sql
   update public.household_members set role = 'owner' where household_id = :'HID';
   ```
5. **Sanity check** the demo email is a real inbox the owner controls (magic
   link is delivered there) and that it is **different** from the owner's real
   account email.

### Reversal (must be documented at the top of the script)

Every demo artefact is removable, demo-scoped, and touches nothing else:
```sql
delete from public.monthend_payments   where household_id = :'HID';
delete from public.monthend_items       where household_id = :'HID';
delete from public.salary_submissions   where household_id = :'HID';
delete from public.mortgage_payments    where household_id = :'HID';
delete from public.mortgage_rate_periods where household_id = :'HID';
delete from public.mortgage_contributions where household_id = :'HID';
delete from public.mortgage_valuations  where household_id = :'HID';
delete from public.mortgage_loan_parts  where household_id = :'HID';
delete from public.scenarios            where household_id = :'HID';
delete from public.tool_state           where household_id = :'HID';
delete from public.household_members    where household_id = :'HID';
delete from public.household_invites    where household_id = :'HID';
delete from public.households           where id = :'HID';
```

## Guardrails (call these out in the script header)

- **Never a bare `delete`/`update`.** Every statement carries
  `where household_id = :'HID'` (or `id = :'HID'` for `households`). This is the
  one and only defence against touching the real household.
- **This file is NOT a migration.** It must not live in `supabase/migrations/`
  and must never run in CI or on `db reset` — it is a manual, prod-only, one-off.
  Put it under `supabase/demo/` with a header saying so.
- **Confirm the target before running.** `select current_database(), inet_server_addr();`
  and verify you are on the linked prod project, not local, before step 1 — mirror
  the "verify the active Supabase target before any write" rule from the dev-server
  incident.
- **RLS is bypassed only for `postgres`.** The seed works because the dashboard/CLI
  superuser bypasses RLS; the demo *user* still only ever sees `:HID` via
  `private.current_household()`. No policy changes required or wanted.

## Acceptance criteria

- Logging into prod with the demo email lands in a household named
  `Demo · Familjen Lundqvist` with data visible in **every** tool that was
  populated locally (Bolånekoll shows a mortgage with a year of payments and an
  equity/LTV hero; Hushållsbudget shows a budget; Månadsavslut shows ≥1 settled
  month; Konsultkalkyl and Löneväxling show saved inputs; Bostadskalkyl lists
  ≥1 scenario).
- The owner's **real** household is byte-for-byte unchanged — verified by
  confirming every seed statement is scoped to `:HID` and by a `select count(*)`
  spot-check on the real household before/after.
- `supabase/demo/seed_demo_household.sql` exists, is parameterised on `:HID`,
  is not under `migrations/`, carries the reversal block and guardrail header,
  and re-running the reversal + seed leaves the demo household in the same state.
- The demo email is invite-gated in exactly the same way as any user: without
  the `household_invites` row, requesting a magic link returns the hook's
  "endast för inbjudna" 403 (confirm by testing the reversal removes access).

## Out of scope

- **Public / anonymous demo access** (shared password, "Prova demon" button,
  client-side fixture mode, RLS read-only demo household, scheduled reseed). The
  owner explicitly wants a private single-user account — none of that infra is
  built. Parked; revisit only if the demo later needs to be visitor-facing.
- **Automating the prod load.** The agent cannot reach prod; the CLI lives in the
  owner's shell. The runbook is executed by hand, deliberately.
- **Keeping demo data "fresh."** Since only the owner touches it, drift is
  self-inflicted and irrelevant; no reset job.
