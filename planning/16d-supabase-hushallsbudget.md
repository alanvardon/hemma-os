# Plan 16d — Hushållsbudget → cloud (Phase B, PR 4)

**Parent:** [Plan 16](16-supabase-migration-auth.md) · **Branch:**
`ui/supabase-hushallsbudget` · **Prerequisites:**
[16c](16c-supabase-manadsavslut.md) merged (`tool_state` table exists).

## Goal

Migrate the budget baseline. This is the **only sync→async refactor** in the
whole migration (`hushallsbudget-store.ts` exposes synchronous
`loadBudget()`/`saveBudget()`), so it's isolated as its own commit — done and
verified on localStorage *before* the cloud swap, so the two changes can't blame
each other. No new SQL table: the whole `BudgetState` is one `tool_state` blob
(Decision 9).

## Commit 1 — sync → async (still localStorage)

`hushallsbudget-store.ts`:
- `loadBudget(): BudgetState | null` → `Promise<BudgetState | null>`.
- `saveBudget(state): void` → `Promise<void>`.
- Keep the bodies (localStorage + the legacy joint→A + category-seed migration)
  exactly as-is for now; just wrap the returns in `Promise.resolve(...)`.

`Hushallsbudget.tsx` (the only caller): `await` the two calls. The load likely
sits in a mount effect already; make it async. **Verify the whole budget page
still works identically** (edit rows, categories, drag-drop, salary submissions,
chart) before writing commit 2. Ship this commit green on its own.

## Commit 2 — swap to the `tool_state` blob

`tool = 'hushallsbudget'`, `data` = the whole `BudgetState` object (camelCase
keys stay camelCase inside jsonb — only real columns are snake_case).

```ts
export async function loadBudget(): Promise<BudgetState | null> {
  const { data, error } = await supabase
    .from('tool_state').select('data')
    .eq('tool', 'hushallsbudget').maybeSingle()
  if (error) return _readCache()               // offline → cache
  if (!data) return null                        // no cloud budget yet
  const state = _migrate(data.data as BudgetState)  // keep the existing migration
  _writeCache(state)
  return state
}

export async function saveBudget(state: BudgetState): Promise<void> {
  _writeCache(state)                            // optimistic
  await supabase.from('tool_state')
    .upsert({ tool: 'hushallsbudget', data: state }, { onConflict: 'household_id,tool' })
  // household_id fills from the column default; upsert conflict key = (household_id, tool)
}
```

- Keep the existing `loadBudget` migration logic (joint→A fold, category seed)
  running on the loaded blob — old localStorage budgets and cloud blobs both
  pass through it.
- `.maybeSingle()` returns `null` (not an error) when there's no row yet.

## First-login import

Flag `bostadskalkyl_budget_supabase_imported`. If the local
`bostadskalkyl_budget_v1` exists and no cloud `tool_state` row does, upsert it
once. First member to log in seeds the shared budget (fine for two people).

## Verification gate / Definition of done

- **RLS acceptance check** — no new table (you write to the existing
  `tool_state`), but confirm the write path: signed-in member upsert of the
  `hushallsbudget` blob succeeds + reads back; `+test` outsider denied;
  `supabase/audit-rls.sql` all ✓ (see master §Risks).

- **Commit 1 shipped/verified independently** (budget page unchanged, still
  local) before commit 2 — this is the whole point of the split.
- Budget edits sync across both devices.
- **Salary submissions still land** — the budget page uses both
  `hushallsbudget-store` and `salary-store` (already migrated in 16b); confirm
  they coexist.
- Offline reload renders the cached budget.
- `build` + `oxlint` + `vitest` green.

**Watch-list note:** blob rows lose at whole-blob granularity under
last-write-wins (both edit the budget offline → one whole budget wins). Fine for
v1; the strongest future argument for normalizing the budget into real tables if
simultaneous editing becomes a habit.

**Next:** [16e](16e-supabase-bolanekoll.md) — Bolånekoll (Phase C begins).
