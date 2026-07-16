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
  /** Optional exact error returned for a failing table/rpc key. */
  errors: Record<string, { message: string; code?: string; status?: number }>
  /** Scripted return values for `.rpc(name, args)`, keyed by rpc name. */
  rpcHandlers: Record<string, (args: unknown) => unknown>
  /** Commit once, but return a network error; the receipt serves the retry. */
  lostResponseOnce: Set<string>
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
  const control: SupabaseMockControl = {
    fail: false, failing: new Set(), errors: {}, rpcHandlers: {}, lostResponseOnce: new Set(), user: null,
  }
  const receipts = new Map<string, unknown>()

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
    let ignoreDuplicates = false
    const filters: Filter[] = []
    let orderCol: string | null = null
    let orderAsc = true
    let single = false
    let selectAfterWrite = false

    const exec = (): { data: unknown; error: { message: string } | null } => {
      if (shouldFail(table)) return { data: null, error: control.errors[table] ?? { message: `mock: ${table} ${op} failed` } }
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
          if (idx >= 0 && !ignoreDuplicates) rows[idx] = { ...rows[idx], ...r }
          else if (idx < 0) rows.push({ ...r })
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
      upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        op = 'upsert'; payload = rows; if (opts?.onConflict) onConflict = opts.onConflict
        ignoreDuplicates = opts?.ignoreDuplicates === true
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
    const deleteArgs = name === 'delete_household_rows' || name === 'sync_delete_rows'
      ? args as { p_resource?: string; p_ids?: string[] } | undefined
      : undefined
    const resourceArg = (name === 'sync_apply_rows' || name === 'sync_delete_rows')
      ? (args as { p_resource?: string } | undefined)?.p_resource : deleteArgs?.p_resource
    const failureKey = resourceArg && shouldFail(resourceArg) ? resourceArg : name
    if (shouldFail(failureKey)) return Promise.resolve({
      data: null,
      error: control.errors[failureKey] ?? { message: `mock: rpc ${name} failed` },
    })
    const handler = control.rpcHandlers[name]
    if (handler) return Promise.resolve({ data: handler(args), error: null })
    const operationId = (args as { p_operation_id?: unknown } | undefined)?.p_operation_id
    const receiptKey = typeof operationId === 'string' ? `${name}:${operationId}` : null
    if (receiptKey && receipts.has(receiptKey)) return Promise.resolve({ data: receipts.get(receiptKey), error: null })

    let data: unknown = null
    if (name === 'sync_apply_rows') {
      const input = args as {
        p_resource: string; p_rows: Row[]; p_expected_revisions: Record<string, number | null>; p_seed?: boolean
      }
      const current: Record<string, number | null> = {}
      let conflict = false
      for (const incoming of input.p_rows) {
        const id = String(incoming.id)
        const key = `${input.p_resource}:${id}`
        const existing = rowsOf(input.p_resource).find((row) => row.id === incoming.id)
        const revision = existing ? Number(existing.revision ?? 1) : null
        current[key] = revision
        if (!(input.p_seed && revision !== null) && input.p_expected_revisions?.[key] !== revision) conflict = true
      }
      if (conflict) data = { status: 'conflict', revisions: current }
      else {
        // Plan 109a payment-provenance trigger parity (the two rules a client
        // write can violate): a NEW partless down payment must carry a
        // mortgage_id unless its id has the reserved legacy-contribution
        // prefix, and an assigned down-payment mortgage_id cannot be cleared.
        if (input.p_resource === 'mortgage_payments') {
          for (const incoming of input.p_rows) {
            if (incoming.kind !== 'down_payment') continue
            const partless = incoming.loan_part_id == null || incoming.loan_part_id === ''
            if (!partless) continue
            const existing = rowsOf(input.p_resource).find((row) => row.id === incoming.id)
            const clearedNull = 'mortgage_id' in incoming && incoming.mortgage_id == null
            const violates = existing
              ? existing.mortgage_id != null && clearedNull
              : incoming.mortgage_id == null && !String(incoming.id).startsWith('legacy-contribution:')
            if (violates) return Promise.resolve({
              data: null,
              error: { message: 'down payment requires a mortgage agreement', code: '22023' },
            })
          }
        }
        const revisions: Record<string, number> = {}
        for (const incoming of input.p_rows) {
          const id = String(incoming.id)
          const key = `${input.p_resource}:${id}`
          const existing = rowsOf(input.p_resource).findIndex((row) => row.id === incoming.id)
          if (input.p_seed && existing >= 0) revisions[key] = Number(rowsOf(input.p_resource)[existing].revision ?? 1)
          else if (existing >= 0) {
            const revision = Number(rowsOf(input.p_resource)[existing].revision ?? 1) + 1
            rowsOf(input.p_resource)[existing] = { ...rowsOf(input.p_resource)[existing], ...incoming, revision }
            revisions[key] = revision
          } else {
            rowsOf(input.p_resource).push({ ...incoming, revision: 1 })
            revisions[key] = 1
          }
        }
        data = { status: 'applied', revisions }
      }
    } else if (name === 'sync_apply_tool_state') {
      const input = args as { p_tool: string; p_data: unknown; p_expected_revision: number | null; p_seed?: boolean }
      const key = `tool_state:${input.p_tool}`
      const index = rowsOf('tool_state').findIndex((row) => row.tool === input.p_tool)
      const current = index >= 0 ? Number(rowsOf('tool_state')[index].revision ?? 1) : null
      if (!(input.p_seed && current !== null) && input.p_expected_revision !== current) {
        data = { status: 'conflict', revisions: { [key]: current } }
      } else if (input.p_seed && current !== null) data = { status: 'applied', revisions: { [key]: current } }
      else {
        const revision = current === null ? 1 : current + 1
        const row = { tool: input.p_tool, data: input.p_data, revision }
        if (index >= 0) rowsOf('tool_state')[index] = row
        else rowsOf('tool_state').push(row)
        data = { status: 'applied', revisions: { [key]: revision } }
      }
    } else if (name === 'sync_delete_rows' && deleteArgs?.p_resource && Array.isArray(deleteArgs.p_ids)) {
      const input = args as { p_resource: string; p_ids: string[]; p_expected_revisions: Record<string, number | null> }
      const current: Record<string, number | null> = {}
      let conflict = false
      for (const id of input.p_ids) {
        const key = `${input.p_resource}:${id}`
        const existing = rowsOf(input.p_resource).find((row) => String(row.id) === id)
        const revision = existing ? Number(existing.revision ?? 1) : null
        current[key] = revision
        if (input.p_expected_revisions?.[key] !== revision) conflict = true
      }
      if (conflict) data = { status: 'conflict', revisions: current }
      else {
        const ids = new Set(input.p_ids)
        tables[input.p_resource] = rowsOf(input.p_resource).filter((row) => !ids.has(String(row.id)))
        data = { status: 'applied', revisions: Object.fromEntries(input.p_ids.map((id) => [`${input.p_resource}:${id}`, null])) }
      }
    } else if (name === 'sync_settle_items') {
      const input = args as { p_payment: Row; p_expected_revisions: Record<string, number | null> }
      const payment = input.p_payment
      const paymentId = String(payment.id)
      const itemIds = Array.isArray(payment.item_ids) ? payment.item_ids.map(String) : []
      const current: Record<string, number | null> = {
        [`monthend_payments:${paymentId}`]: rowsOf('monthend_payments').some((row) => row.id === payment.id) ? 1 : null,
      }
      for (const id of itemIds) {
        const row = rowsOf('monthend_items').find((candidate) => String(candidate.id) === id)
        current[`monthend_items:${id}`] = row ? Number(row.revision ?? 1) : null
      }
      const conflict = Object.entries(current).some(([key, revision]) => input.p_expected_revisions?.[key] !== revision)
      if (conflict) data = { status: 'conflict', revisions: current }
      else {
        rowsOf('monthend_payments').push({ ...payment, revision: 1 })
        const revisions: Record<string, number> = { [`monthend_payments:${paymentId}`]: 1 }
        for (const id of itemIds) {
          const index = rowsOf('monthend_items').findIndex((row) => String(row.id) === id)
          if (index < 0) continue
          const revision = Number(rowsOf('monthend_items')[index].revision ?? 1) + 1
          rowsOf('monthend_items')[index] = { ...rowsOf('monthend_items')[index], paid: true, payment_id: paymentId, revision }
          revisions[`monthend_items:${id}`] = revision
        }
        data = { status: 'applied', revisions }
      }
    } else if (name === 'sync_unsettle_payment') {
      const input = args as { p_id: string; p_expected_revisions: Record<string, number | null> }
      const payment = rowsOf('monthend_payments').find((row) => String(row.id) === input.p_id)
      const items = rowsOf('monthend_items').filter((row) => row.payment_id === input.p_id)
      const current: Record<string, number | null> = {
        [`monthend_payments:${input.p_id}`]: payment ? Number(payment.revision ?? 1) : null,
      }
      for (const row of items) current[`monthend_items:${String(row.id)}`] = Number(row.revision ?? 1)
      const conflict = Object.keys(current).length !== Object.keys(input.p_expected_revisions ?? {}).length
        || Object.entries(current).some(([key, revision]) => input.p_expected_revisions?.[key] !== revision)
      if (conflict) data = { status: 'conflict', revisions: current }
      else {
        tables.monthend_payments = rowsOf('monthend_payments').filter((row) => String(row.id) !== input.p_id)
        const revisions: Record<string, number | null> = { [`monthend_payments:${input.p_id}`]: null }
        for (const row of items) {
          const revision = Number(row.revision ?? 1) + 1
          Object.assign(row, { paid: false, payment_id: null, revision })
          revisions[`monthend_items:${String(row.id)}`] = revision
        }
        data = { status: 'applied', revisions }
      }
    } else if (name === 'sync_change_mortgage_bank') {
      // Mirrors the plan-109a RPC: validation failures are SQL errors
      // (errcode 22023), a revision mismatch is a data-level conflict, and the
      // client-generated new-agreement id is the idempotence key — a replay
      // that finds it already created returns the existing payload as success.
      const input = args as {
        p_operation_id: string; p_old_mortgage_id: string; p_expected_old_revision: number
        p_new_mortgage: Row; p_new_parts: Row[]; p_effective_date: string
      }
      const sqlError = (message: string) => Promise.resolve({ data: null, error: { message, code: '22023' } })
      const mortgages = rowsOf('mortgages')
      const newM = input.p_new_mortgage as { id?: unknown; label?: unknown; bank_id?: unknown } | null
      if (!newM || typeof newM !== 'object'
        || typeof newM.id !== 'string' || !newM.id || newM.id === input.p_old_mortgage_id
        || typeof newM.label !== 'string' || typeof newM.bank_id !== 'string' || !newM.bank_id
        || Object.keys(newM).some((key) => !['id', 'label', 'bank_id'].includes(key))) {
        return sqlError('invalid mortgage payload')
      }
      if (!Array.isArray(input.p_new_parts) || input.p_new_parts.some((part) =>
        !part || typeof part !== 'object'
        || typeof part.id !== 'string' || !part.id
        || typeof part.label !== 'string'
        || typeof part.balance !== 'number' || (part.balance as number) < 0
        || ('planned_amortization' in part && part.planned_amortization !== null
          && (typeof part.planned_amortization !== 'number' || (part.planned_amortization as number) < 0))
        || Object.keys(part).some((key) => !['id', 'label', 'balance', 'planned_amortization'].includes(key)))) {
        return sqlError('invalid loan part payload')
      }
      const partsPayload = input.p_new_parts.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)))
      if (new Set(partsPayload.map((part) => part.id)).size !== partsPayload.length) return sqlError('invalid loan part payload')
      const respond = (created: Row, old: Row): void => {
        const partsJson = rowsOf('mortgage_loan_parts')
          .filter((row) => row.mortgage_id === newM.id)
          .sort((a, b) => String(a.id).localeCompare(String(b.id)))
          .map((row) => ({ ...row }))
        const revisions: Record<string, number | null> = {
          [`mortgages:${String(old.id)}`]: Number(old.revision ?? 1),
          [`mortgages:${String(created.id)}`]: Number(created.revision ?? 1),
        }
        for (const row of partsJson) revisions[`mortgage_loan_parts:${String(row.id)}`] = Number(row.revision ?? 1)
        data = { status: 'applied', mortgage: { ...created }, old_mortgage: { ...old }, parts: partsJson, revisions }
      }
      const existingNew = mortgages.find((row) => row.id === newM.id)
      const old = mortgages.find((row) => row.id === input.p_old_mortgage_id)
      if (existingNew) {
        if (existingNew.archived || existingNew.bank_id !== newM.bank_id
          || existingNew.start_date !== input.p_effective_date
          || !old || !old.archived || old.end_date !== input.p_effective_date) {
          return sqlError('bank change replay mismatch')
        }
        respond(existingNew, old)
      } else if (!old || old.archived || Number(old.revision ?? 1) !== input.p_expected_old_revision) {
        data = {
          status: 'conflict',
          revisions: { [`mortgages:${input.p_old_mortgage_id}`]: old ? Number(old.revision ?? 1) : null },
        }
      } else if (!rowsOf('mortgage_banks').some((row) => row.id === newM.bank_id)) {
        return sqlError('bank is not in caller household')
      } else if (typeof old.start_date === 'string' && old.start_date !== ''
        && input.p_effective_date < old.start_date) {
        return sqlError('effective date precedes agreement start')
      } else {
        old.archived = true
        old.end_date = input.p_effective_date
        old.revision = Number(old.revision ?? 1) + 1
        const created: Row = {
          id: newM.id, created_at: new Date().toISOString(), bank_id: newM.bank_id, label: newM.label,
          start_date: input.p_effective_date, archived: false, end_date: null, revision: 1,
        }
        mortgages.push(created)
        for (const part of partsPayload) {
          rowsOf('mortgage_loan_parts').push({
            id: part.id, created_at: new Date().toISOString(), mortgage_id: newM.id,
            label: part.label, loan_number: '',
            start_balance: part.balance, start_date: input.p_effective_date, archived: false,
            original_balance: part.balance, original_date: input.p_effective_date,
            planned_amortization: (part.planned_amortization as number | null | undefined) ?? null,
            planned_amortization_start: part.planned_amortization != null ? input.p_effective_date : null,
            planned_amortization_end: null,
            revision: 1,
          })
        }
        respond(created, old)
      }
    } else if (name === 'sync_revert_mortgage_bank_change') {
      const input = args as { p_operation_id: string; p_mortgage_id: string; p_expected_revisions: Record<string, number | null> }
      const sqlError = (message: string) => Promise.resolve({ data: null, error: { message, code: '22023' } })
      const mortgages = rowsOf('mortgages')
      const target = mortgages.find((row) => row.id === input.p_mortgage_id)
      if (!target) {
        data = { status: 'conflict', revisions: { [`mortgages:${input.p_mortgage_id}`]: null } }
      } else if (target.archived) {
        return sqlError('mortgage agreement is not active')
      } else {
        const previousMatches = mortgages.filter((row) => row.archived && row.end_date === target.start_date)
        if (previousMatches.length !== 1) return sqlError('no unambiguous previous agreement')
        const previous = previousMatches[0]
        const parts = rowsOf('mortgage_loan_parts').filter((row) => row.mortgage_id === input.p_mortgage_id)
        const partIds = new Set(parts.map((row) => String(row.id)))
        const hasTransactions = rowsOf('mortgage_payments').some((row) =>
          row.mortgage_id === input.p_mortgage_id || (row.loan_part_id != null && partIds.has(String(row.loan_part_id))))
          || rowsOf('mortgage_rate_periods').some((row) => row.loan_part_id != null && partIds.has(String(row.loan_part_id)))
        if (hasTransactions) return sqlError('mortgage agreement has recorded transactions')
        const current: Record<string, number | null> = {
          [`mortgages:${input.p_mortgage_id}`]: Number(target.revision ?? 1),
          [`mortgages:${String(previous.id)}`]: Number(previous.revision ?? 1),
        }
        for (const row of parts) current[`mortgage_loan_parts:${String(row.id)}`] = Number(row.revision ?? 1)
        const expected = input.p_expected_revisions ?? {}
        const conflict = Object.keys(current).length !== Object.keys(expected).length
          || Object.entries(current).some(([key, revision]) => expected[key] !== revision)
        if (conflict) data = { status: 'conflict', revisions: current }
        else {
          tables.mortgage_loan_parts = rowsOf('mortgage_loan_parts').filter((row) => row.mortgage_id !== input.p_mortgage_id)
          tables.mortgages = mortgages.filter((row) => row.id !== input.p_mortgage_id)
          previous.archived = false
          previous.end_date = null
          previous.revision = Number(previous.revision ?? 1) + 1
          const revisions: Record<string, number | null> = {
            [`mortgages:${input.p_mortgage_id}`]: null,
            [`mortgages:${String(previous.id)}`]: Number(previous.revision),
          }
          for (const id of partIds) revisions[`mortgage_loan_parts:${id}`] = null
          data = { status: 'applied', mortgage: { ...previous }, revisions }
        }
      }
    } else if (name === 'sync_delete_mortgage_loan_part') {
      const input = args as { p_loan_part_id: string; p_expected_revisions: Record<string, number | null> }
      const part = rowsOf('mortgage_loan_parts').find((row) => String(row.id) === input.p_loan_part_id)
      const payments = rowsOf('mortgage_payments').filter((row) => row.loan_part_id === input.p_loan_part_id)
      const periods = rowsOf('mortgage_rate_periods').filter((row) => row.loan_part_id === input.p_loan_part_id)
      const current: Record<string, number | null> = {
        [`mortgage_loan_parts:${input.p_loan_part_id}`]: part ? Number(part.revision ?? 1) : null,
      }
      for (const row of payments) current[`mortgage_payments:${String(row.id)}`] = Number(row.revision ?? 1)
      for (const row of periods) current[`mortgage_rate_periods:${String(row.id)}`] = Number(row.revision ?? 1)
      const conflict = Object.keys(current).length !== Object.keys(input.p_expected_revisions ?? {}).length
        || Object.entries(current).some(([key, revision]) => input.p_expected_revisions?.[key] !== revision)
      if (conflict) data = { status: 'conflict', revisions: current }
      else {
        tables.mortgage_payments = rowsOf('mortgage_payments').filter((row) => row.loan_part_id !== input.p_loan_part_id)
        tables.mortgage_rate_periods = rowsOf('mortgage_rate_periods').filter((row) => row.loan_part_id !== input.p_loan_part_id)
        tables.mortgage_loan_parts = rowsOf('mortgage_loan_parts').filter((row) => String(row.id) !== input.p_loan_part_id)
        data = { status: 'applied', revisions: Object.fromEntries(Object.keys(current).map((key) => [key, null])) }
      }
    }
    if (receiptKey && (data as { status?: unknown } | null)?.status === 'applied') receipts.set(receiptKey, data)
    if (receiptKey && (control.lostResponseOnce.delete(receiptKey) || control.lostResponseOnce.delete(name))) {
      return Promise.resolve({ data: null, error: { message: 'Failed to fetch', status: 0 } })
    }
    if (data !== null) return Promise.resolve({ data, error: null })
    if (deleteArgs?.p_resource && Array.isArray(deleteArgs.p_ids)) {
      const ids = new Set(deleteArgs.p_ids)
      tables[deleteArgs.p_resource] = rowsOf(deleteArgs.p_resource).filter((row) => !ids.has(String(row.id)))
    }
    return Promise.resolve({ data: null, error: null })
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
  return { supabase, tables, control, receipts }
}
