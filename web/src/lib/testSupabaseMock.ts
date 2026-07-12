// testSupabaseMock.ts — shared in-memory stand-in for the supabase-js fluent
// chain (`from().select().eq().order().maybeSingle()`, insert/upsert/update/
// delete, rpc), used by the row-store test suites (mortgage/manadsavslut/
// salary/household). One instance per test file, wired in with
// `vi.mock('./supabase', () => ({ supabase: mock.supabase }))`.
//
// Deliberately coarse: no column projection, no real SQL semantics — just
// enough fidelity (per-table rows, eq/in filters, order, upsert conflict
// keys, scriptable failures) to exercise each store's read-fallback /
// write-throws / cache-patch-ordering logic.

export interface SupabaseMockControl {
  /** Fail every operation on every table/rpc. */
  fail: boolean
  /** Fail operations only on these table names / rpc names. */
  failing: Set<string>
  /** Scripted return values for `.rpc(name, args)`, keyed by rpc name. */
  rpcHandlers: Record<string, (args: unknown) => unknown>
  /** The signed-in user returned by `auth.getUser()`; null when signed out. */
  user: { id?: string; email?: string } | null
}

type Row = Record<string, unknown>
type Filter = { type: 'eq' | 'in' | 'ilike'; col: string; val: unknown }

function matchRow(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.type === 'in') return Array.isArray(f.val) && (f.val as unknown[]).includes(row[f.col])
    if (f.type === 'ilike') {
      // No-wildcard ilike is case-insensitive equality (all we use it for).
      return String(row[f.col]).toLowerCase() === String(f.val).toLowerCase()
    }
    return row[f.col] === f.val
  })
}

export function createSupabaseMock() {
  const tables: Record<string, Row[]> = {}
  const control: SupabaseMockControl = { fail: false, failing: new Set(), rpcHandlers: {}, user: null }

  function rowsOf(table: string): Row[] {
    if (!tables[table]) tables[table] = []
    return tables[table]
  }

  function shouldFail(key: string): boolean {
    return control.fail || control.failing.has(key)
  }

  function from(table: string) {
    let op: 'select' | 'insert' | 'upsert' | 'update' | 'delete' | null = null
    let payload: Row | Row[] | null = null
    let onConflict = 'id'
    const filters: Filter[] = []
    let orderCol: string | null = null
    let orderAsc = true
    let single = false
    let selectAfterWrite = false

    const exec = (): { data: unknown; error: { message: string } | null } => {
      if (shouldFail(table)) return { data: null, error: { message: `mock: ${table} ${op} failed` } }
      const rows = rowsOf(table)

      if (op === 'insert') {
        const incoming = Array.isArray(payload) ? payload : payload ? [payload] : []
        incoming.forEach((r) => rows.push({ ...r }))
        return { data: null, error: null }
      }
      if (op === 'upsert') {
        const incoming = Array.isArray(payload) ? payload : payload ? [payload] : []
        const conflictCols = onConflict.split(',').map((s) => s.trim()).filter((c) => c !== 'household_id')
        incoming.forEach((r) => {
          const idx = rows.findIndex((x) => conflictCols.every((c) => x[c] === r[c]))
          if (idx >= 0) rows[idx] = { ...rows[idx], ...r }
          else rows.push({ ...r })
        })
        return { data: null, error: null }
      }
      if (op === 'update') {
        let updated: Row | null = null
        for (let i = 0; i < rows.length; i++) {
          if (matchRow(rows[i], filters)) {
            rows[i] = { ...rows[i], ...(payload as Row) }
            updated = rows[i]
          }
        }
        if (!selectAfterWrite) return { data: null, error: null }
        const matches = rows.filter((r) => matchRow(r, filters))
        return { data: single ? updated : matches.map((r) => ({ ...r })), error: null }
      }
      if (op === 'delete') {
        tables[table] = rows.filter((r) => !matchRow(r, filters))
        return { data: null, error: null }
      }
      // select
      let result = rows.filter((r) => matchRow(r, filters))
      if (orderCol) {
        const col = orderCol
        result = result.slice().sort((a, b) => {
          const av = a[col], bv = b[col]
          const cmp = av === bv ? 0 : (av as string | number) < (bv as string | number) ? -1 : 1
          return orderAsc ? cmp : -cmp
        })
      }
      if (single) return { data: result[0] ? { ...result[0] } : null, error: null }
      return { data: result.map((r) => ({ ...r })), error: null }
    }

    const builder = {
      select(_cols?: string) {
        if (op === null) op = 'select'
        else selectAfterWrite = true
        return builder
      },
      insert(rows: Row | Row[]) { op = 'insert'; payload = rows; return builder },
      upsert(rows: Row | Row[], opts?: { onConflict?: string }) {
        op = 'upsert'; payload = rows; if (opts?.onConflict) onConflict = opts.onConflict
        return builder
      },
      update(patch: Row) { op = 'update'; payload = patch; return builder },
      delete() { op = 'delete'; return builder },
      eq(col: string, val: unknown) { filters.push({ type: 'eq', col, val }); return builder },
      in(col: string, vals: unknown[]) { filters.push({ type: 'in', col, val: vals }); return builder },
      ilike(col: string, val: unknown) { filters.push({ type: 'ilike', col, val }); return builder },
      order(col: string, opts?: { ascending?: boolean }) {
        orderCol = col; orderAsc = opts?.ascending !== false; return builder
      },
      maybeSingle() { single = true; return Promise.resolve(exec()) },
      then<T1, T2>(
        onFulfilled?: ((value: { data: unknown; error: { message: string } | null }) => T1) | null,
        onRejected?: ((reason: unknown) => T2) | null,
      ) {
        return Promise.resolve(exec()).then(onFulfilled, onRejected)
      },
    }
    return builder
  }

  function rpc(name: string, args?: unknown) {
    if (shouldFail(name)) return Promise.resolve({ data: null, error: { message: `mock: rpc ${name} failed` } })
    const handler = control.rpcHandlers[name]
    return Promise.resolve({ data: handler ? handler(args) : null, error: null })
  }

  const supabase = {
    from,
    rpc,
    auth: {
      signOut: async () => shouldFail('signOut')
        ? { error: { message: 'mock: sign out failed' } }
        : { error: null },
      getUser: async () => ({ data: { user: control.user }, error: null }),
    },
  }
  return { supabase, tables, control }
}
