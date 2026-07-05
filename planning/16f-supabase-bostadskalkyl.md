# Plan 16f — Bostadskalkyl scenarios + prefs → cloud (Phase C, PR 6)

**Parent:** [Plan 16](16-supabase-migration-auth.md) · **Branch:**
`ui/supabase-bostadskalkyl` · **Prerequisites:**
[16e](16e-supabase-bolanekoll.md) merged.

## Goal

Migrate saved scenarios + global prefs. **Good news confirmed in review:**
`useStore` (Zustand) already hydrates through the `storage.ts` facade via an
async `hydrate()` — so there is **NO Zustand middleware rework**. This is a
facade swap like the others, just with one casing quirk (`savedAt`).

## What moves vs. what stays (Decision 10)

`storage.ts` has many functions; only some sync:

| function(s) | destination |
|---|---|
| `loadScenarios` / `saveScenarios` | `scenarios` table |
| `loadGlobalConstants` / `saveGlobalConstants`, `loadDriftItems`/`saveDriftItems`, `loadSavingsItems`/`saveSavingsItems` | `tool_state` (`tool='bostadskalkyl-prefs'`, one blob `{ globalConstants, driftItems, savingsItems }`) |
| `loadSession`/`saveSession`/`clearSession`, `loadDraft`/`saveDraft`/`clearDraft`, `loadDraftConstants`/…, `loadTheme`/`saveTheme`, `loadDriftYearly`/`saveDriftYearly` | **stay localStorage** — scratch buffers + device state |

## The table (SQL Editor; also commit to `supabase/schema.sql`)

⚠ `Scenario` is the ONE non-snake_case-ready row type: `savedAt` (camelCase) +
camelCase keys inside `inputs`/`constants`. Only `savedAt` becomes a real column
(`saved_at`); the nested objects stay camelCase inside jsonb.

```sql
create table public.scenarios (
  id        text primary key default gen_random_uuid()::text,   -- ids here are DEFINITELY not UUIDs
  household_id uuid not null references public.households(id) default private.current_household(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name      text not null,
  saved_at  text not null,     -- TS field is `savedAt` (ISO string)
  inputs    jsonb not null,
  constants jsonb              -- optional per-scenario constants
);
```

Add the `hh_all` policy + `set_updated_at` trigger (as in 16b).

## The facade swap (`web/src/lib/storage.ts`)

Signatures unchanged, so `useStore.ts` is untouched. The one custom bit is the
`savedAt` ↔ `saved_at` mapping, kept **inside the facade only**:

```ts
const toRow  = (s: Scenario) => ({ id: s.id, name: s.name, saved_at: s.savedAt,
                                   inputs: s.inputs, constants: s.constants })
const fromRow = (r: any): Scenario => ({ id: r.id, name: r.name, savedAt: r.saved_at,
                                         inputs: r.inputs, constants: r.constants ?? undefined })

export async function loadScenarios(): Promise<Scenario[]> {
  const { data, error } = await supabase.from('scenarios').select('*').order('saved_at', { ascending: false })
  if (error) return _readCache()
  const rows = data.map(fromRow); _writeCache(rows); return rows
}
```

`saveScenarios(scenarios)` writes the WHOLE list today. Simplest correct port:
upsert all rows (`.upsert(scenarios.map(toRow))`) then delete ids no longer
present (`.delete().not('id', 'in', '(…)')`), all inside the facade. The prefs
blob is a `tool_state` upsert like 16d.

## First-login import

Flag `bostadskalkyl_scenarios_supabase_imported`. Upsert local
`bostadskalkyl_scenarios_v1` rows by id; upsert the prefs blob if absent.
Idempotent. (`importJSON`-style dedupe already lives in the store.)

## Verification gate / Definition of done

- **RLS acceptance check (before real data)** — see master §Risks. For
  `scenarios`: signed-in member INSERT→201 + reads back; `+test` outsider denied
  both ways; `supabase/audit-rls.sql` all ✓.

- Saved scenarios list syncs across devices.
- Draft/session/theme behave **unchanged per device** (they stayed local) —
  verify a draft on one device does NOT appear on the other, by design.
- The `savedAt`↔`saved_at` mapping round-trips (save, reload, ordering intact).
- The 51-test vitest suite still green (facade signatures unchanged; mock
  `lib/supabase` to test the mapping).
- `build` + `oxlint` green.

**Next:** [16g](16g-supabase-konsult-lonevaxling.md) — the last two tools.
