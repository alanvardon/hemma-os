# Demo household — prod seeding runbook (Plan 85)

A **private** second account — a separate email the owner logs into via the
normal magic-link flow — that lands in its own household pre-populated with a
plausible lived-in Swedish couple ("Familjen Lundqvist"). It exists so the app
can be demoed fully-populated **without exposing or mutating the owner's real
household**. It is not public: no "try the demo" button, no shared password, no
anonymous route. Prod stays invite-only exactly as today.

Everything here is **owner-run against prod** — the agent cannot reach prod, and
the linked CLI / prod credentials live only in the owner's shell.

## Files

- [`seed_demo_household.sql`](./seed_demo_household.sql) — the data fixture.
  59 INSERTs (loan parts, valuations, a year of mortgage payments, a
  Bostadskalkyl scenario, three tool-state blobs, one settled month), every row
  scoped to a `:HID` psql variable. Captured by driving the real app against the
  isolated local Supabase, so every jsonb blob is shape-correct. **Not a
  migration** — never in `supabase/migrations/`, CI, or `db reset`.

## Before you touch anything

Confirm you are on **prod**, not local:

```sql
select current_database(), inet_server_addr();
```

The seed only ever writes to the one household `:HID` you create in step 1. There
is no bare `delete`/`update` anywhere. The one and only defence against touching
the real household is that `:HID` must be the **demo** household's id.

## 1. Create the demo household + invite

The invite does double duty: it lets the demo email past the signup hook
(`hook_before_user_created` 403s any email with no pending invite), and it makes
`claim_household()` attach the first login to this pre-seeded household instead
of creating a fresh empty one.

```sql
insert into public.households (name)
  values ('Demo · Familjen Lundqvist') returning id;   -- copy this uuid → :HID

insert into public.household_invites (household_id, email)
  values ('<:HID uuid>', 'demo.hemmaos@<your-domain>'); -- lowercase; must match the hook
```

Use a real inbox the owner controls, **different** from the owner's real account
email (the magic link is delivered there).

## 2. Load the fixture

RLS is bypassed by the `postgres`/dashboard superuser, and `household_id` is set
explicitly on every row, so the household needs no member yet.

**psql** (supports the `:'HID'` variable):

```sql
\set HID '<the uuid from step 1>'
\i supabase/demo/seed_demo_household.sql
```

or non-interactively:

```sh
psql "$PROD_URL" -v HID='<uuid>' -f supabase/demo/seed_demo_household.sql
```

The script refuses to run (and inserts nothing) if `:HID` is unset.

> **Supabase dashboard SQL editor** does not support psql variables. If you must
> use it, open the file and find-replace `:'HID'` with the quoted uuid first,
> and run it inside a single `begin; … commit;` (the file already wraps itself).

## 3. First login (owner, in a browser)

Open the **prod** app, enter the demo email, click "Skicka länk", open the magic
link on that device. The signup hook passes (the invite exists); `claim_household`
consumes the invite and adds the demo user to `:HID` as `member`. The seeded data
is now visible in every tool.

## 4. Optional — promote to owner

So the household menu shows full controls:

```sql
update public.household_members set role = 'owner' where household_id = :'HID';
```

## 5. Sanity checks

- Bolånekoll shows a mortgage with two loan parts, a year of payments and an
  equity/LTV hero (≈ 2.17 Mkr equity, 59.9 % LTV against a 5.4 Mkr valuation).
- Hushållsbudget, Konsultkalkyl and Löneväxling show saved inputs.
- Månadsavslut shows one settled month; Bostadskalkyl lists the "Radhus i
  Bromma" scenario.
- The owner's **real** household is unchanged — spot-check a `count(*)` on the
  real household before/after; every seed statement is scoped to `:HID`.
- Removing the invite (see reversal) makes the demo email invite-gated again:
  requesting a magic link returns the hook's "endast för inbjudna" 403.

## Reversal — remove every demo artefact

Data rows (also inside the seed file's header):

```sql
delete from public.monthend_payments   where household_id = :'HID';
delete from public.monthend_items       where household_id = :'HID';
delete from public.mortgage_payments    where household_id = :'HID';
delete from public.mortgage_valuations  where household_id = :'HID';
delete from public.mortgage_loan_parts  where household_id = :'HID';
delete from public.scenarios            where household_id = :'HID';
delete from public.tool_state           where household_id = :'HID';
```

Then the household/membership rows (created by this runbook, not the seed file):

```sql
delete from public.household_members    where household_id = :'HID';
delete from public.household_invites     where household_id = :'HID';
delete from public.households            where id = :'HID';
```

Re-running the reversal followed by the seed leaves the demo household in the
same state (verified against local: reversal → empty → seed → identical counts).

## Not included (deliberately)

- **mortgage_rate_periods / mortgage_contributions / salary_submissions** — the
  app renders the demo fully without them (kontantinsats is derived from
  purchase − original loan; Löneväxling state lives in `tool_state`). Add them
  later via the app + a fresh capture if a demo ever needs them.
- **Public / anonymous demo access** — the owner wants a private single-user
  account; no shared password, "Prova demon" button, or read-only demo route.
- **Automating the prod load / keeping demo data fresh** — run by hand,
  deliberately; drift is self-inflicted and irrelevant.
