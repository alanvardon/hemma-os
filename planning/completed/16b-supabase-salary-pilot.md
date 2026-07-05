# Plan 16b — Salary-store pilot (Phase A, PR 2)

**Parent:** [Plan 16](16-supabase-migration-auth.md) · **Branch:**
`ui/supabase-salary-pilot` · **Prerequisites:** [16a](16a-supabase-auth-gate.md)
merged (project, auth gate, seeded household).

## Goal

Migrate ONE tool end-to-end — `salary-store` (the smallest, append-only,
already-1:1-shaped store) — to prove the entire loop: auth → household → RLS →
cloud CRUD → local cache → first-login import. This is the pattern every later
phase copies, so get it clean here.

## The table (now captured in the baseline migration)

Mirrors `SalarySubmission` in `hushallsbudget.ts`. **`id` is `text`** (Decision
7: the store's fallback id isn't a UUID); **`equal_share` is `numeric`**, not a
boolean (it's a share *amount* in the TS type — the correction found in review).

```sql
create table public.salary_submissions (
  id              text primary key default gen_random_uuid()::text,
  household_id    uuid not null references public.households(id)
                  default private.current_household(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  month           text not null,               -- 'YYYY-MM'
  person_a_name   text,
  income_a        numeric,
  person_b_name   text,
  income_b        numeric,
  transfer_from   text,                         -- 'a' | 'b'
  transfer_to     text,
  transfer_amount numeric,
  equal_share     numeric,                      -- NOT boolean
  note            text,
  income_items    jsonb                         -- [{owner,label,amount}], never queried
);

alter table public.salary_submissions enable row level security;
create policy hh_all on public.salary_submissions for all to authenticated
  using      (household_id = (select private.current_household()))
  with check (household_id = (select private.current_household()));
create trigger set_updated_at before update on public.salary_submissions
  for each row execute procedure moddatetime (updated_at);
```

## The store swap (`web/src/lib/salary-store.ts`)

Keep every exported signature (`list/add/remove/exportJSON/importJSON/
exportCSV`) so `Hushallsbudget.tsx` call sites don't change. Replace `_read`/
`_write` bodies with Supabase queries. **Split the keys** (see the master plan's
key-split note): `STORAGE_KEY` (`bostadskalkyl_salary_log_v1`) stays a
**read-only legacy import source + backup**, and a **new**
`bostadskalkyl_salary_cache_v1` holds the write-through cache. Reusing one key
would let the cache write clobber the legacy history before the import reads it.

```ts
export async function list(): Promise<SalarySubmission[]> {
  const { data, error } = await supabase
    .from('salary_submissions')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) return _readCache()          // offline / down → cache
  _writeCache(data)
  return data
}

export async function add(record: SalarySubmission): Promise<SalarySubmission> {
  const saved = { ...record, id: record.id || _id(),
                  created_at: record.created_at || new Date().toISOString() }
  const { error } = await supabase.from('salary_submissions').insert(saved)
  _appendCache(saved)                     // optimistic
  if (error) throw error                  // today's store NEVER rejects — verify
  return saved                            // Hushallsbudget.tsx copes with a reject
}
```

- supabase-js returns `{ data, error }` — it does NOT throw; check `error`.
- Never send `household_id`/`updated_at` — column default + trigger handle both.
- Don't send `id` when you want the DB default; here the store supplies it, fine.
- Keep `_migrate` (v1→v2 income_items) running on the **cache/import** path;
  cloud rows are born with `income_items`.

## First-login import (one-time, idempotent)

Run at the start of `list()`, guarded by a flag, so imported rows appear in that
same call. On first authenticated load after the household exists, if
`localStorage['bostadskalkyl_salary_supabase_imported']` is unset: read the
legacy `bostadskalkyl_salary_log_v1` rows (the **read-only** key from the split,
never the cache) and `.upsert(rows)` (keyed on `id`, so re-running adds nothing),
then set the flag. On error, leave the flag unset to retry; dedupe concurrent
calls with an in-memory promise. Runs per-origin, per-device — both devices
import into the same household, deduped by id. (localStorage is per-origin: the
real history is on the live Pages site, not localhost.)

## Verification gate / Definition of done

- **RLS acceptance check (before real data)** — see master §Risks. Signed-in
  member: INSERT into `salary_submissions` returns 201 **and** reads back;
  `+test` outsider (no household): SELECT `[]` **and** INSERT rejected (403);
  `supabase/audit-rls.sql` returns all ✓. The positive round-trip is the part
  that catches a `for select`-only policy (the monthend bug).

- **RLS both directions, BEFORE real data:** sign in with a third
  `alan.vardon+test@proton.me` alias (a separate `auth.users` user, in no
  household). Confirm it (a) reads zero salary rows and (b) cannot insert one
  (the `with check` rejects it). Only after this passes, proceed.
- Salary log syncs between your two devices (add on one, see it on the other).
- Offline reload still renders history (DevTools → Network → Offline).
- Import ran once; re-triggering it adds nothing.
- `build` + `oxlint` + `vitest` green (mock `lib/supabase` with an in-memory
  double to test cache-fallback + import idempotency without a network).

**Next:** [16c](16c-supabase-manadsavslut.md) — Månadsavslut (Phase B begins).
