# Plan 16g — Konsult + Löneväxling → cloud (Phase C, PR 7)

**Parent:** [Plan 16](16-supabase-migration-auth.md) · **Branch:**
`ui/supabase-konsult-lonevaxling` · **Prerequisites:**
[16f](16f-supabase-bostadskalkyl.md) merged.

## Goal

Migrate the last two tools, both single-settings-blob shapes. **Quirk found in
review:** neither has a store file — persistence is currently INLINE in the
route components. So each is two commits: extract, then swap. No new SQL table
(both reuse `tool_state`).

Keys today: `bostadskalkyl_konsult_v1` (`Konsultkalkyl.tsx:37/52`),
`bostadskalkyl_lonevaxling_v1` (`Lonevaxling.tsx:21/123`).

## Commit 1 — extract inline persistence into tiny stores

Create `web/src/lib/konsult-store.ts` and `web/src/lib/lonevaxling-store.ts`,
each exposing the same Promise shape as the other stores:

```ts
export async function load(): Promise<Inputs | null> { /* localStorage read */ }
export async function save(inputs: Inputs): Promise<void> { /* localStorage write */ }
```

Move the `getItem`/`setItem` bodies out of the route files; the routes now
`await load()` on mount and `save()` on change. **Still localStorage** — ship
and verify this commit unchanged-behaviour first (same as 16d's split
discipline).

## Commit 2 — swap to `tool_state`

`tool = 'konsultkalkyl'` and `tool = 'lonevaxling'`; `data` = the whole inputs
object (camelCase inside jsonb is fine). Same load/save shape as the budget blob
in 16d:

```ts
export async function load(): Promise<Inputs | null> {
  const { data, error } = await supabase.from('tool_state')
    .select('data').eq('tool', 'konsultkalkyl').maybeSingle()
  if (error) return _readCache()
  return data ? (data.data as Inputs) : null
}
export async function save(inputs: Inputs): Promise<void> {
  _writeCache(inputs)
  await supabase.from('tool_state')
    .upsert({ tool: 'konsultkalkyl', data: inputs }, { onConflict: 'household_id,tool' })
}
```

## First-login import

Flags `bostadskalkyl_konsult_supabase_imported` /
`bostadskalkyl_lonevaxling_supabase_imported`. Upsert each local blob into
`tool_state` if no cloud row exists. Idempotent.

## Verification gate / Definition of done

- **RLS acceptance check** — no new table (both blobs live in the existing
  `tool_state`), but confirm the write path for each: signed-in member upsert
  succeeds + reads back; `+test` outsider denied; `supabase/audit-rls.sql` all ✓
  (see master §Risks).

- **Commit 1 shipped/verified independently** (extraction, still local) before
  commit 2.
- Both tools' inputs persist across devices.
- Offline reload renders cached inputs.
- Imports run once each; re-runs add nothing.
- `build` + `oxlint` + `vitest` green.

**Milestone:** with 16g merged, **every tool is cloud-backed.** Only the invite
UX (16h) remains — until then the SQL-seeded household from 16a is the join
mechanism.

**Next:** [16h](16h-supabase-invites.md) — invite UI + hardening (Phase D).
