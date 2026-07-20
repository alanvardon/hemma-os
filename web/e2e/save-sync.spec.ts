/* save-sync.spec.ts — the save/sync golden path for Bolånekoll (plan 79).
 *
 * Locks in, as a repeatable suite, the verification that was done by hand for
 * PR #237 (audit H2): a mutation that succeeds must survive a real reload, and
 * a mutation whose network write FAILS must surface a toast, keep the dialog
 * (and the user's input) open, survive reload from the dirty cache, and replay
 * after connectivity returns without an unhandled rejection.
 *
 * No live Supabase anywhere: the prod bundle is built with the Supabase origin
 * pinned to localhost:54321 (see playwright.config.ts) and every request to it
 * is intercepted with page.route. Auth is satisfied by seeding a far-future
 * supabase-js session into localStorage — getSession() restores it without a
 * network call — plus a mocked claim_household RPC.
 */
import { test, expect, type Page } from '@playwright/test'

const SUPABASE = 'http://localhost:54321'
// supabase-js derives its storage key from the URL hostname: sb-<host>-auth-token.
const AUTH_STORAGE_KEY = 'sb-localhost-auth-token'
// household_identity() returns a real uuid household_id; the client's defensive
// parser rejects a non-uuid envelope as unconfigured (the sync-scope claim id is
// separate and unvalidated).
const HH_UUID = '00000000-aaaa-4aaa-8aaa-000000000001'

// A structurally valid (unverified — the client never checks the signature)
// JWT + session envelope that supabase-js accepts from storage. expires_at in
// 2100 keeps the client from ever attempting a token refresh over the network.
function fakeSession(): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const exp = 4102444800 // 2100-01-01
  const user = {
    id: 'user-e2e',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'e2e@local.test',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
  }
  const jwt = [
    b64({ alg: 'HS256', typ: 'JWT' }),
    b64({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', exp }),
    'e2e-signature',
  ].join('.')
  return JSON.stringify({
    access_token: jwt,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: exp,
    refresh_token: 'e2e-refresh',
    user,
  })
}

// A minimal stand-in for the plan-111 household_identity jsonb view, mutated by
// the three identity RPCs so a real setup → reload round trip can be verified.
interface IdentityView {
  household_id: string | null
  my_person_id: string | null
  people: { id: string; slot: 'a' | 'b'; display_name: string; login_email?: string | null }[]
  bindings: Record<string, { a: string; b: string }>
}

interface Backend {
  /** When true, revisioned mortgage writes die at the network layer. */
  failInserts: boolean
  /** Simulate a second device changing an already loaded loan part. */
  remoteUpdatePart(currentLabel: string, nextLabel: string): void
  /** The current household identity view the RPCs read/write (plan 111). */
  identity: IdentityView
}

// Seed the auth session and mock the whole Supabase origin. Inserted loan
// parts are recorded and served back on subsequent GETs, so a reload proves
// the real save→read round trip (not just the localStorage write-through
// cache). Everything else reads empty and accepts writes.
//
// Plan 109c additions: banks/mortgages/rate periods join the generic
// sync_apply_rows table map (agreement creation, bank-profile edits, rate
// periods all go through the same outbox RPC as loan parts), plus two
// hand-written mocks for the atomic bank-change/revert RPCs
// (sync_change_mortgage_bank / sync_revert_mortgage_bank_change) that mirror
// the real migration's request/response contract
// (supabase/migrations/20260716100000_mortgage_agreement_lifecycle.sql) —
// archive-then-insert for a switch, delete-then-reactivate for a revert.
async function mockBackend(page: Page): Promise<Backend> {
  const parts: Record<string, unknown>[] = []
  const payments: Record<string, unknown>[] = []
  const banks: Record<string, unknown>[] = []
  const mortgages: Record<string, unknown>[] = []
  const periods: Record<string, unknown>[] = []
  const resources: Record<string, Record<string, unknown>[]> = {
    mortgage_loan_parts: parts,
    mortgage_payments: payments,
    mortgage_banks: banks,
    mortgages,
    mortgage_rate_periods: periods,
  }
  const receipts = new Map<string, unknown>()
  const PERSON_A = '11111111-1111-4111-8111-111111111111'
  const PERSON_B = '22222222-2222-4222-8222-222222222222'
  const backend: Backend = {
    failInserts: false,
    remoteUpdatePart(currentLabel, nextLabel) {
      const part = parts.find((row) => row.label === currentLabel)
      if (!part) throw new Error(`Missing mocked loan part: ${currentLabel}`)
      part.label = nextLabel
      part.revision = Number(part.revision) + 1
    },
    // Starts as a provisioned-but-unconfigured household (people: []), which is
    // what household_identity() returns before "Personer i hushållet" is saved.
    identity: { household_id: HH_UUID, my_person_id: null, people: [], bindings: {} },
  }

  await page.addInitScript(
    ([key, session]) => window.localStorage.setItem(key, session),
    [AUTH_STORAGE_KEY, fakeSession()] as const,
  )

  await page.route(`${SUPABASE}/**`, async (route) => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    // Riksbank proxy is best-effort in the app — a 503 quietly drops the card.
    if (path.startsWith('/functions/')) return route.fulfill({ status: 503, body: '' })
    if (path === '/rest/v1/rpc/claim_household') return route.fulfill({ json: 'hh-e2e' })
    // Defensive: the seeded session shouldn't trigger auth traffic, but if a
    // future supabase-js version phones home, don't let it hang the test.
    if (path.startsWith('/auth/')) return route.fulfill({ json: {} })
    if (path === '/rest/v1/rpc/sync_apply_rows' && req.method() === 'POST') {
      if (backend.failInserts) return route.abort('failed')
      const body = req.postDataJSON() as {
        p_operation_id: string
        p_resource: string
        p_rows: Record<string, unknown>[]
        p_expected_revisions: Record<string, number | null>
        p_seed: boolean
      }
      const prior = receipts.get(body.p_operation_id)
      if (prior) return route.fulfill({ json: prior })
      const collection = resources[body.p_resource]
      if (!collection) return route.fulfill({ status: 400, json: {} })
      const current = Object.fromEntries(body.p_rows.map((row) => {
        const existing = collection.find((entry) => entry.id === row.id)
        return [`${body.p_resource}:${String(row.id)}`, existing ? Number(existing.revision) : null]
      }))
      const conflict = Object.entries(current).some(([key, revision]) =>
        !(body.p_seed && revision !== null) && body.p_expected_revisions[key] !== revision)
      if (conflict) return route.fulfill({ json: { status: 'conflict', revisions: current } })
      const revisions: Record<string, number> = {}
      for (const row of body.p_rows) {
        const index = collection.findIndex((entry) => entry.id === row.id)
        const revision = index < 0 ? 1 : Number(collection[index].revision) + 1
        // The real sync_apply_rows UPDATE only assigns the keys present in the
        // payload (mortgage-store.ts's NULLABLE_EXPLICIT comment) — an omitted
        // nullable column (e.g. a part edit that never threads mortgage_id
        // through) leaves the DB value untouched. Merge onto the existing row
        // rather than replacing it, or an update would silently null out any
        // column the client didn't resend.
        const saved = index < 0 ? { ...row, revision } : { ...collection[index], ...row, revision }
        if (index < 0) collection.push(saved); else if (!body.p_seed) collection[index] = saved
        revisions[`${body.p_resource}:${String(row.id)}`] = index >= 0 && body.p_seed
          ? Number(collection[index].revision) : revision
      }
      const response = { status: 'applied', revisions }
      receipts.set(body.p_operation_id, response)
      return route.fulfill({ json: response })
    }
    // Atomic bank change: archive the old agreement and insert the new
    // agreement + parts in one step, mirroring sync_change_mortgage_bank.
    if (path === '/rest/v1/rpc/sync_change_mortgage_bank' && req.method() === 'POST') {
      const body = req.postDataJSON() as {
        p_operation_id: string
        p_old_mortgage_id: string
        p_expected_old_revision: number | null
        p_new_mortgage: { id: string; label: string; bank_id: string }
        p_new_parts: Array<{ id: string; label: string; balance: number; planned_amortization?: number | null }>
        p_effective_date: string
      }
      const prior = receipts.get(body.p_operation_id)
      if (prior) return route.fulfill({ json: prior })
      const oldRow = mortgages.find((m) => m.id === body.p_old_mortgage_id)
      const oldRevision = oldRow ? Number(oldRow.revision) : null
      if (!oldRow || oldRow.archived || oldRevision !== body.p_expected_old_revision) {
        return route.fulfill({
          json: { status: 'conflict', revisions: { [`mortgages:${body.p_old_mortgage_id}`]: oldRevision } },
        })
      }
      oldRow.archived = true
      oldRow.end_date = body.p_effective_date
      oldRow.revision = oldRevision + 1
      const newMortgage: Record<string, unknown> = {
        id: body.p_new_mortgage.id, bank_id: body.p_new_mortgage.bank_id, label: body.p_new_mortgage.label,
        start_date: body.p_effective_date, archived: false, end_date: null,
        revision: 1, created_at: new Date().toISOString(),
      }
      mortgages.push(newMortgage)
      const newParts = body.p_new_parts.map((part) => ({
        id: part.id, label: part.label, loan_number: '',
        start_balance: part.balance, start_date: body.p_effective_date, archived: false,
        mortgage_id: newMortgage.id, original_balance: part.balance, original_date: body.p_effective_date,
        planned_amortization: part.planned_amortization ?? null,
        planned_amortization_start: part.planned_amortization != null ? body.p_effective_date : null,
        planned_amortization_end: null, revision: 1, created_at: new Date().toISOString(),
      }))
      parts.push(...newParts)
      const revisions: Record<string, number | null> = {
        [`mortgages:${oldRow.id}`]: Number(oldRow.revision),
        [`mortgages:${newMortgage.id}`]: 1,
      }
      for (const p of newParts) revisions[`mortgage_loan_parts:${p.id}`] = 1
      const response = { status: 'applied', mortgage: newMortgage, old_mortgage: oldRow, parts: newParts, revisions }
      receipts.set(body.p_operation_id, response)
      return route.fulfill({ json: response })
    }
    // Ångra bankbyte: delete the pristine new agreement + its parts and
    // reactivate the predecessor, mirroring sync_revert_mortgage_bank_change.
    if (path === '/rest/v1/rpc/sync_revert_mortgage_bank_change' && req.method() === 'POST') {
      const body = req.postDataJSON() as {
        p_operation_id: string
        p_mortgage_id: string
        p_expected_revisions: Record<string, number | null>
      }
      const prior = receipts.get(body.p_operation_id)
      if (prior) return route.fulfill({ json: prior })
      const target = mortgages.find((m) => m.id === body.p_mortgage_id)
      if (!target) {
        return route.fulfill({ json: { status: 'conflict', revisions: { [`mortgages:${body.p_mortgage_id}`]: null } } })
      }
      const previous = mortgages.find((m) =>
        m.id !== target.id && m.archived && (m.end_date ?? null) === (target.start_date ?? null))
      if (!previous) return route.fulfill({ status: 400, json: {} })
      const partIds = parts.filter((p) => p.mortgage_id === target.id).map((p) => String(p.id))
      const current: Record<string, number | null> = {
        [`mortgages:${target.id}`]: Number(target.revision),
        [`mortgages:${previous.id}`]: Number(previous.revision),
      }
      for (const id of partIds) {
        const p = parts.find((row) => row.id === id)
        current[`mortgage_loan_parts:${id}`] = p ? Number(p.revision) : null
      }
      const mismatch = Object.entries(current).some(([key, rev]) => body.p_expected_revisions[key] !== rev)
      if (mismatch) return route.fulfill({ json: { status: 'conflict', revisions: current } })
      for (const id of partIds) {
        const index = parts.findIndex((p) => p.id === id)
        if (index >= 0) parts.splice(index, 1)
      }
      const targetIndex = mortgages.findIndex((m) => m.id === target.id)
      if (targetIndex >= 0) mortgages.splice(targetIndex, 1)
      previous.archived = false
      previous.end_date = null
      previous.revision = Number(previous.revision) + 1
      const revisions: Record<string, number | null> = {
        [`mortgages:${target.id}`]: null, [`mortgages:${previous.id}`]: Number(previous.revision),
      }
      for (const id of partIds) revisions[`mortgage_loan_parts:${id}`] = null
      const response = { status: 'applied', mortgage: previous, revisions }
      receipts.set(body.p_operation_id, response)
      return route.fulfill({ json: response })
    }
    // ── Plan 111 identity RPCs (stateful, keyed to the seeded household) ──
    if (path === '/rest/v1/rpc/household_identity' && req.method() === 'POST') {
      // SQL NULL (no household) reads as an unusable envelope on the client; a
      // configured household returns its full view.
      return route.fulfill({ json: backend.identity.household_id ? backend.identity : null })
    }
    // Claim-first load path: map the caller (e2e@local.test) to the person whose
    // login_email matches, when still unclaimed, then return the identity view.
    if (path === '/rest/v1/rpc/claim_my_household_person_by_email' && req.method() === 'POST') {
      if (backend.identity.household_id && backend.identity.my_person_id === null) {
        const match = backend.identity.people.find((p) => (p.login_email ?? '') === 'e2e@local.test')
        if (match) backend.identity.my_person_id = match.id
      }
      return route.fulfill({ json: backend.identity.household_id ? backend.identity : null })
    }
    if (path === '/rest/v1/rpc/configure_household_people' && req.method() === 'POST') {
      const b = req.postDataJSON() as Record<string, string | null>
      backend.identity.household_id = HH_UUID
      backend.identity.people = [
        { id: PERSON_A, slot: 'a', display_name: String(b.p_person_a_name), login_email: b.p_person_a_email ?? null },
        { id: PERSON_B, slot: 'b', display_name: String(b.p_person_b_name), login_email: b.p_person_b_email ?? null },
      ]
      if (b.p_tool) {
        const idOf = (slot: string | null) => (slot === 'a' ? PERSON_A : PERSON_B)
        backend.identity.bindings[b.p_tool] = { a: idOf(b.p_tool_slot_a_person), b: idOf(b.p_tool_slot_b_person) }
      }
      return route.fulfill({ json: backend.identity })
    }
    if (path === '/rest/v1/rpc/set_my_household_person' && req.method() === 'POST') {
      const b = req.postDataJSON() as { p_person_id: string | null }
      backend.identity.my_person_id = b.p_person_id
      return route.fulfill({ json: null })
    }
    if (path === '/rest/v1/rpc/household_roster' && req.method() === 'POST') {
      const me = backend.identity.people.find((p) => p.id === backend.identity.my_person_id)
      return route.fulfill({ json: [{
        user_id: 'user-e2e', role: 'owner', email: 'e2e@local.test',
        person_id: backend.identity.my_person_id, person_display_name: me?.display_name ?? null,
      }] })
    }
    if (resources[path.slice('/rest/v1/'.length)] && req.method() === 'GET') {
      return route.fulfill({ json: resources[path.slice('/rest/v1/'.length)] })
    }
    if (path.startsWith('/rest/')) {
      if (req.method() === 'GET') return route.fulfill({ json: [] })
      return route.fulfill({ status: 201, body: '' })
    }
    return route.fulfill({ status: 404, body: '' })
  })

  return backend
}

// Collect uncaught page exceptions (incl. unhandled promise rejections) — the
// pre-#237 bug's signature. Asserted empty at the end of every test.
function trackPageErrors(page: Page): Error[] {
  const errors: Error[] = []
  page.on('pageerror', (e) => errors.push(e))
  return errors
}

// Every tool dialog is a <dialog class="bk-dialog"> in the DOM — [open]
// selects the one showModal() actually opened. Plan 109c can have two native
// <dialog>s open at once (e.g. editing an archived part from inside Tidigare
// avtal opens PartDialog on top of the still-open history dialog, or adding a
// rate period from inside the part dialog), so a plain hasText filter is
// unreliable — e.g. PartDialog's own "+ Add rate period" trigger button text
// also matches a hasText filter meant for the nested PeriodDialog. Filter by
// the dialog's <h3 class="dialog-title"> HEADING instead — exactly one per
// dialog, so a substring match against just that element is unambiguous.
function dialogWithHeading(page: Page, heading: string) {
  return page.locator('dialog.bk-dialog[open]').filter({ has: page.locator('.dialog-title', { hasText: heading }) })
}

// BankPicker's <select> is wrapped by FormField's `<label><span>Bank</span>
// <select>…</select></label>`. Its computed accessible name is "Bank" PLUS the
// currently selected option's own text (the label wraps the control, and a
// <select>'s rendered option is real DOM text), so getByLabel('Bank') never
// matches a stable, exact string. Target the field structurally instead: the
// <label> whose caption <span> is exactly "Bank".
function bankSelect(dialog: import('@playwright/test').Locator) {
  return dialog.locator('label.form-field:has(span:text-is("Bank")) select')
}

// Plan 109c — a mortgage agreement is the parent of the loan parts; the first
// empty-hero action creates it (label/start date + a bank) before any loan
// part can be added. The picker only offers "Egen bank…" in a fresh household
// (no catalogue rows are seeded and no household bank exists yet).
async function createAgreement(page: Page, opts: { label?: string; bankLabel?: string } = {}) {
  await page.locator('.empty-hero').getByRole('button', { name: 'Skapa bolåneavtal' }).click()
  const dialog = dialogWithHeading(page, 'Skapa bolåneavtal')
  await expect(dialog.getByRole('heading', { name: 'Skapa bolåneavtal', exact: false })).toBeVisible()
  if (opts.label) await dialog.getByLabel('Namn').fill(opts.label)
  await bankSelect(dialog).selectOption({ label: 'Egen bank…' })
  await dialog.getByLabel('Bankens namn').fill(opts.bankLabel ?? 'E2E Bank')
  await dialog.getByRole('button', { name: 'Skapa' }).click()
  await expect(dialog).not.toBeVisible()
}

async function openAddLoanPartDialog(page: Page) {
  // Fresh household → the empty-hero is the entry point, but a loan part now
  // requires an agreement to exist first (plan 109c).
  await createAgreement(page)
  await page.locator('.empty-hero').getByRole('button', { name: '+ Lägg till lånedel' }).click()
  const dialog = page.locator('dialog.bk-dialog[open]')
  await expect(dialog.getByRole('heading', { name: 'Add loan part' })).toBeVisible()
  return dialog
}

// Adds the FIRST loan part of a freshly created (empty) agreement — the
// empty-hero's "+ Lägg till lånedel" CTA, same dialog as openAddLoanPartDialog
// uses but without also creating the agreement (the caller already did that).
async function addFirstLoanPart(page: Page, label: string, startBalance: string) {
  await page.locator('.empty-hero').getByRole('button', { name: '+ Lägg till lånedel' }).click()
  const dialog = page.locator('dialog.bk-dialog[open]')
  await expect(dialog.getByRole('heading', { name: 'Add loan part' })).toBeVisible()
  await dialog.getByLabel('Label').fill(label)
  await dialog.getByLabel('Start balance').fill(startBalance)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).not.toBeVisible()
}

// Drives the Byt bank wizard end to end (Bank → Lånedelar → Granska →
// Bekräfta) to a brand-new custom bank, optionally renaming the (single)
// copied draft loan part. Assumes no total mismatch (default balances), so
// the sum-mismatch acknowledgement checkbox never appears.
async function switchBank(page: Page, opts: { newAgreementLabel: string; newBankLabel: string; renameDraft?: string }) {
  await page.getByRole('button', { name: 'Byt bank' }).click()
  const dialog = dialogWithHeading(page, 'Byt bank')
  await expect(dialog.getByRole('heading', { name: 'Byt bank', exact: false })).toBeVisible()
  await dialog.getByLabel('Namn på nytt avtal').fill(opts.newAgreementLabel)
  await bankSelect(dialog).selectOption({ label: 'Egen bank…' })
  await dialog.getByLabel('Bankens namn').fill(opts.newBankLabel)
  await dialog.getByRole('button', { name: 'Nästa' }).click() // → step 2, Lånedelar
  // exact: true — a substring match also catches the draft's "Ta bort lånedel" button.
  if (opts.renameDraft) await dialog.getByLabel('Lånedel', { exact: true }).fill(opts.renameDraft)
  await dialog.getByRole('button', { name: 'Nästa' }).click() // → step 3, Granska
  await dialog.getByRole('button', { name: 'Nästa' }).click() // → step 4, Bekräfta
  await dialog.getByRole('button', { name: 'Byt bank' }).click() // atomic confirm
  await expect(dialog).not.toBeVisible()
}

test('a saved loan part survives a real reload (save → cloud → re-read)', async ({ page }) => {
  const errors = trackPageErrors(page)
  await mockBackend(page)
  await page.goto('/#/bolanekoll')

  const dialog = await openAddLoanPartDialog(page)
  await dialog.getByLabel('Label').fill('E2E Testlån')
  await dialog.getByLabel('Start balance').fill('1000000')
  await dialog.getByRole('button', { name: 'Save' }).click()

  await expect(page.locator('.bk-toast.show')).toHaveText('Loan part added.')
  await expect(dialog).not.toBeVisible()
  await expect(page.locator('.ld-name', { hasText: 'E2E Testlån' })).toBeVisible()

  // page.reload(), NOT a same-hash page.goto — that's a same-document nav and
  // wouldn't actually reload (project_web_landmines.md). The row must come back
  // from the (mocked) backend read on a cold mount.
  await page.reload()
  await expect(page.locator('.ld-name', { hasText: 'E2E Testlån' })).toBeVisible()

  expect(errors).toEqual([])
})

test('an extra amortering is one canonical payment and one linked Extra amorteringar row after reload', async ({ page }) => {
  const errors = trackPageErrors(page)
  await mockBackend(page)
  await page.goto('/#/bolanekoll')

  const partDialog = await openAddLoanPartDialog(page)
  await partDialog.getByLabel('Label').fill('E2E amortering')
  await partDialog.getByLabel('Start balance').fill('1000000')
  await partDialog.getByRole('button', { name: 'Save' }).click()
  await expect(partDialog).not.toBeVisible()

  const paymentCard = page.locator('#betalningar').locator('..')
  await paymentCard.getByRole('button', { name: '+ Lägg till' }).click()
  const paymentDialog = page.locator('dialog.bk-dialog[open]')
  await expect(paymentDialog.getByRole('heading', { name: 'Lägg till betalning' })).toBeVisible()
  await paymentDialog.getByLabel('Typ').selectOption('extra_amortization')
  // Same-day rows need the bank's post-amortering Saldo to establish ordering
  // against the origination snapshot. This is the manual entry path that was
  // previously unavailable.
  await paymentDialog.getByLabel('Belopp').fill('20000')
  await paymentDialog.getByLabel('Saldo efteråt (valfritt)').fill('980000')
  await paymentDialog.getByRole('button', { name: 'Spara' }).click()

  await expect(page.locator('.bk-toast.show')).toHaveText('Payment saved.')
  await expect(paymentDialog).not.toBeVisible()
  const remainingDebt = page.locator('.metric-chip', { hasText: 'Remaining debt' })
  // NumberFlow exposes each rolling digit to the DOM, so visible text is not a
  // stable financial assertion. The metric's canonical current-debt attribute
  // is the exact resolved value used for the hero/KPI.
  await expect(remainingDebt).toHaveAttribute('data-current-debt', '980000')
  await expect(page.locator('#betalningar').locator('..')).toContainText(/20\s*000 kr/)
  await expect(page.locator('#extra-amorteringar')).toContainText(/20\s*000 kr/)

  await page.reload()
  await expect(page.locator('.metric-chip', { hasText: 'Remaining debt' })).toHaveAttribute('data-current-debt', '980000')
  await expect(page.locator('#betalningar').locator('..')).toContainText(/20\s*000 kr/)
  await expect(page.locator('#extra-amorteringar')).toContainText(/20\s*000 kr/)
  expect(errors).toEqual([])
})

test('a failed save survives reload and replays after connectivity returns', async ({ page }) => {
  const errors = trackPageErrors(page)
  const backend = await mockBackend(page)
  await page.goto('/#/bolanekoll')
  // Create the agreement (a normal, succeeding write) before flipping
  // failInserts — this test is specifically about a loan-part save failing,
  // not about the agreement itself failing to create.
  await createAgreement(page)
  backend.failInserts = true

  await page.locator('.empty-hero').getByRole('button', { name: '+ Lägg till lånedel' }).click()
  const dialog = page.locator('dialog.bk-dialog[open]')
  await expect(dialog.getByRole('heading', { name: 'Add loan part' })).toBeVisible()
  await dialog.getByLabel('Label').fill('Spöklån')
  await dialog.getByRole('button', { name: 'Save' }).click()

  // The user must SEE the failure…
  await expect(page.locator('.bk-toast.show')).toHaveText(
    'Ingen anslutning. Ändringen sparades inte i molnet.',
  )
  // …the dialog must stay open with the typed data intact (nothing lost)…
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Label')).toHaveValue('Spöklån')
  // The current form stays authoritative until reload; it is not falsely
  // presented as cloud-saved in the ledger yet.
  await expect(page.locator('.ld-name', { hasText: 'Spöklån' })).toHaveCount(0)
  await expect(page.locator('.persistence-notice')).toContainText('Väntar på anslutning')

  // The queued row is durable and wins the older empty cloud read on reload.
  await page.reload()
  await expect(page.locator('.ld-name', { hasText: 'Spöklån' })).toBeVisible()
  await expect(page.locator('.persistence-notice')).toContainText('Väntar på anslutning')

  // `online` is a retry hint; only the now-successful request confirms the
  // recovery. A queue that passed through waiting/failed keeps a truthful
  // completion message (routine saves stay silent — plan 113).
  backend.failInserts = false
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.locator('.persistence-notice')).toContainText('Väntande ändringar sparade')
  await page.reload()
  await expect(page.locator('.ld-name', { hasText: 'Spöklån' })).toBeVisible()

  expect(errors).toEqual([])
})

test('a stale device can reload the cloud version or keep its own version', async ({ page }) => {
  const errors = trackPageErrors(page)
  const backend = await mockBackend(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/bolanekoll')

  const addDialog = await openAddLoanPartDialog(page)
  await addDialog.getByLabel('Label').fill('Gemensam grund')
  await addDialog.getByRole('button', { name: 'Save' }).click()
  await expect(addDialog).not.toBeVisible()

  // This tab loaded revision 1. Another device advances the row to revision 2.
  backend.remoteUpdatePart('Gemensam grund', 'Molnversion')
  const row = page.locator('tr.ld-member', { hasText: 'Gemensam grund' })
  await row.getByRole('button', { name: 'Edit' }).click()
  const editDialog = page.locator('dialog.bk-dialog[open]')
  await editDialog.getByLabel('Label').fill('Min första version')
  await editDialog.getByRole('button', { name: 'Save' }).click()

  await expect(page.locator('.persistence-conflict')).toContainText('Det här ändrades på en annan enhet.')
  await page.getByRole('button', { name: 'Ladda molnversionen' }).click()
  await expect(page.locator('.ld-name', { hasText: 'Molnversion' })).toBeVisible()
  await expect(page.locator('.ld-name', { hasText: 'Min första version' })).toHaveCount(0)

  // Repeat from the now-current revision 2, choosing the local version. The
  // coordinator retries it against revision 3 and the backend issues revision 4.
  backend.remoteUpdatePart('Molnversion', 'Ny molnversion')
  const currentRow = page.locator('tr.ld-member', { hasText: 'Molnversion' })
  await currentRow.getByRole('button', { name: 'Edit' }).click()
  const secondEditDialog = page.locator('dialog.bk-dialog[open]')
  await secondEditDialog.getByLabel('Label').fill('Behåll min version')
  await secondEditDialog.getByRole('button', { name: 'Save' }).click()

  await expect(page.locator('.persistence-conflict')).toBeVisible()
  await page.getByRole('button', { name: 'Behåll min version' }).click()
  await expect(page.locator('.persistence-conflict')).not.toBeVisible()
  await page.reload()
  await expect(page.locator('.ld-name', { hasText: 'Behåll min version' })).toBeVisible()
  await expect(page.locator('.ld-name', { hasText: 'Ny molnversion' })).toHaveCount(0)

  expect(errors).toEqual([])
})

// ── Plan 109c — bank change / Ångra bankbyte / history (acceptance criteria) ──

test('a bank switch survives reload with clean parts and a missing-rate prompt', async ({ page }) => {
  const errors = trackPageErrors(page)
  await mockBackend(page)
  await page.goto('/#/bolanekoll')

  await createAgreement(page, { label: 'Bolån hos Gamla banken', bankLabel: 'Gamla banken' })
  await addFirstLoanPart(page, 'Del 1', '500000')

  await switchBank(page, {
    newAgreementLabel: 'Bolån hos Nya banken', newBankLabel: 'Nya banken', renameDraft: 'Del 1 (ny bank)',
  })

  await expect(page.locator('.bk-toast.show')).toHaveText(
    'Bankbyte genomfört. Lägg till räntevillkor för de nya lånedelarna.',
  )
  await expect(page.locator('.agreement-name')).toHaveText('Bolån hos Nya banken')
  await expect(page.locator('.agreement-bank')).toHaveText('Nya banken')
  // Rates are deliberately never copied — the fresh agreement's part(s) must
  // prompt for räntevillkor instead of silently forecasting at 0 %.
  await expect(page.locator('.missing-rate-prompt')).toBeVisible()
  await expect(page.getByRole('button', { name: '+ Lägg till räntevillkor: Del 1 (ny bank)' })).toBeVisible()
  await expect(page.locator('.ld-name', { hasText: 'Del 1 (ny bank)' })).toBeVisible()
  // The bank change archives the AGREEMENT, not the old parts, so the ACTIVE
  // ledger scopes by the mortgage link: ONLY the new agreement's part shows and
  // the remaining debt is the new agreement's alone (500 000) — the old
  // agreement's 500 000 is NOT merged in. Before the fix the ledger filtered by
  // the part's own `!archived` flag and rendered both parts / a doubled balance.
  await expect(page.locator('tr.ld-member')).toHaveCount(1)
  await expect(page.locator('tr.ld-member .ld-name')).toHaveText(/Del 1 \(ny bank\)/)
  await expect(page.locator('.metric-chip', { hasText: 'Remaining debt' }))
    .toHaveAttribute('data-current-debt', '500000')

  await page.getByRole('button', { name: 'Tidigare avtal' }).click()
  const history = dialogWithHeading(page, 'Tidigare avtal')
  await expect(history.locator('.agreement-status.is-closed')).toHaveText('Avslutat')
  await expect(history.locator('.history-detail-bank')).toHaveText('Gamla banken')
  await expect(history.locator('.history-parts')).toContainText('Del 1')
  await history.getByRole('button', { name: 'Stäng' }).click()
  await expect(history).not.toBeVisible()

  // page.reload(), NOT a same-hash page.goto — see project_web_landmines.md.
  await page.reload()

  await expect(page.locator('.agreement-name')).toHaveText('Bolån hos Nya banken')
  await expect(page.locator('.agreement-bank')).toHaveText('Nya banken')
  await expect(page.locator('.missing-rate-prompt')).toBeVisible()
  await expect(page.getByRole('button', { name: '+ Lägg till räntevillkor: Del 1 (ny bank)' })).toBeVisible()

  await page.getByRole('button', { name: 'Tidigare avtal' }).click()
  const historyAfterReload = dialogWithHeading(page, 'Tidigare avtal')
  await expect(historyAfterReload.locator('.agreement-status.is-closed')).toHaveText('Avslutat')
  await expect(historyAfterReload.locator('.history-detail-bank')).toHaveText('Gamla banken')
  await expect(historyAfterReload.locator('.history-parts')).toContainText('Del 1')

  expect(errors).toEqual([])
})

test('Ångra bankbyte reverts a pristine switch, survives reload, and disappears once the new agreement has a transaction', async ({ page }) => {
  const errors = trackPageErrors(page)
  await mockBackend(page)
  await page.goto('/#/bolanekoll')

  await createAgreement(page, { label: 'Bolån A', bankLabel: 'Bank A' })
  await addFirstLoanPart(page, 'Del 1', '400000')

  await switchBank(page, { newAgreementLabel: 'Bolån B', newBankLabel: 'Bank B', renameDraft: 'Del 1 hos Bank B' })
  await expect(page.locator('.agreement-bank')).toHaveText('Bank B')

  await page.getByRole('button', { name: 'Tidigare avtal' }).click()
  const history = dialogWithHeading(page, 'Tidigare avtal')
  await expect(history.getByRole('group', { name: 'Ångra bankbyte' })).toBeVisible()

  await history.getByRole('button', { name: 'Ångra bankbyte' }).click()

  // The revert guard is now a themed ConfirmDialog (plan 91), not a native
  // confirm(): confirm it to fire the RPC.
  const revertConfirm = page.getByRole('dialog', { name: 'Ångra bankbytet?' })
  await revertConfirm.getByRole('button', { name: 'Ångra bankbyte' }).click()

  await expect(page.locator('.bk-toast.show')).toHaveText('Bankbytet ångrades.')
  await expect(history).not.toBeVisible()
  await expect(page.locator('.agreement-name')).toHaveText('Bolån A')
  await expect(page.locator('.agreement-bank')).toHaveText('Bank A')

  await page.reload()
  await expect(page.locator('.agreement-name')).toHaveText('Bolån A')
  await expect(page.locator('.agreement-bank')).toHaveText('Bank A')

  // Switch again, then record a transaction on the new agreement — Ångra
  // bankbyte must disappear permanently once history exists (plan acceptance).
  await switchBank(page, { newAgreementLabel: 'Bolån C', newBankLabel: 'Bank C', renameDraft: 'Del 1 hos Bank C' })
  await expect(page.locator('.agreement-bank')).toHaveText('Bank C')

  const paymentCard = page.locator('#betalningar').locator('..')
  await paymentCard.getByRole('button', { name: '+ Lägg till' }).click()
  const paymentDialog = page.locator('dialog.bk-dialog[open]')
  await expect(paymentDialog.getByRole('heading', { name: 'Lägg till betalning' })).toBeVisible()
  await paymentDialog.getByLabel('Typ').selectOption('extra_amortization')
  await paymentDialog.getByLabel('Lånedel').selectOption({ label: 'Del 1 hos Bank C' })
  await paymentDialog.getByLabel('Belopp').fill('5000')
  await paymentDialog.getByLabel('Saldo efteråt (valfritt)').fill('395000')
  await paymentDialog.getByRole('button', { name: 'Spara' }).click()
  await expect(paymentDialog).not.toBeVisible()

  await page.getByRole('button', { name: 'Tidigare avtal' }).click()
  const historyAfterTransaction = dialogWithHeading(page, 'Tidigare avtal')
  await expect(historyAfterTransaction.getByRole('group', { name: 'Ångra bankbyte' })).toHaveCount(0)

  expect(errors).toEqual([])
})

// ── Plan 111 — signed-in household person identity ───────────────────────────

test('identity setup marks the signed-in person "Du", persists across reload, and clears on household transition', async ({ page }) => {
  const errors = trackPageErrors(page)
  const backend = await mockBackend(page)
  await page.goto('/#/')

  // The homepage trigger is the anonymous two-person icon until a mapping exists.
  await page.getByRole('button', { name: 'Hushåll' }).click()
  await expect(page.locator('.household-btn-avatar')).toHaveCount(0)

  // Personer i hushållet → run first-time setup with the prefilled defaults.
  await page.getByRole('button', { name: 'Kom igång' }).click()
  await expect(page.getByRole('button', { name: 'Spara personer' })).toBeVisible()
  await page.getByLabel('Person A').fill('Alex')
  await page.getByLabel('Person B').fill('Sam')
  // Bind every tool's A/B slots (A→a, B→b) so no tool is left incomplete.
  const selects = page.locator('select.hh-people-select')
  const count = await selects.count()
  for (let i = 0; i < count; i++) await selects.nth(i).selectOption(i % 2 === 0 ? 'a' : 'b')
  // "Vem är du?" → Alex (slot A), then confirm the review gate and save.
  await page.getByRole('radio', { name: 'Alex' }).check()
  await page.getByRole('checkbox', { name: /kontrollerat namnen/ }).check()
  await page.getByRole('button', { name: 'Spara personer' }).click()

  // The Du marker renders only from the server-confirmed view.
  await expect(page.getByText('(du)')).toBeVisible()
  await page.getByRole('button', { name: 'Stäng' }).click()

  // Mapped → the trigger becomes the current person's initial avatar (still
  // labelled "Hushåll"), and it survives a real reload from the server view.
  await expect(page.locator('.household-btn-avatar')).toHaveText('AL')
  await expect(page.getByRole('button', { name: 'Hushåll' })).toBeVisible()
  await page.reload()
  await expect(page.locator('.household-btn-avatar')).toHaveText('AL')

  // A household transition (server now reports no household) must not leave a
  // stale identity avatar behind — it reverts to the anonymous icon.
  backend.identity = { household_id: null, my_person_id: null, people: [], bindings: {} }
  await page.reload()
  await expect(page.locator('.household-btn-avatar')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Hushåll' })).toBeVisible()

  expect(errors).toEqual([])
})

test('a second account mapped to the other person sees ITS OWN perspective as Du', async ({ page }) => {
  const errors = trackPageErrors(page)
  const backend = await mockBackend(page)
  // The invited partner is canonical person B and is mapped to B — their view
  // must mark Sam (not the household creator, Alex) as "Du".
  backend.identity = {
    household_id: HH_UUID,
    my_person_id: '22222222-2222-4222-8222-222222222222',
    people: [
      { id: '11111111-1111-4111-8111-111111111111', slot: 'a', display_name: 'Alex' },
      { id: '22222222-2222-4222-8222-222222222222', slot: 'b', display_name: 'Sam' },
    ],
    bindings: { bolanekoll: { a: '11111111-1111-4111-8111-111111111111', b: '22222222-2222-4222-8222-222222222222' } },
  }
  await page.goto('/#/')

  // Partner's initial avatar (Sam → SA), not the creator's.
  await expect(page.locator('.household-btn-avatar')).toHaveText('SA')
  await page.getByRole('button', { name: 'Hushåll' }).click()

  // In the people list, Sam is (du) and Alex is not.
  const samRow = page.locator('.hh-list-row', { hasText: 'Sam' })
  await expect(samRow).toContainText('(du)')
  const alexRow = page.locator('.hh-list-row', { hasText: 'Alex' })
  await expect(alexRow).not.toContainText('(du)')

  expect(errors).toEqual([])
})

test('archived rate periods and transactions stay editable and attached to the archived agreement after reload', async ({ page }) => {
  const errors = trackPageErrors(page)
  await mockBackend(page)
  await page.goto('/#/bolanekoll')

  await createAgreement(page, { label: 'Bolån hos Första banken', bankLabel: 'Första banken' })
  await addFirstLoanPart(page, 'Ursprunglig del', '300000')

  // Give the original part a rate period and a logged transaction before the
  // bank change, so history has real data to keep, edit and re-verify.
  const row = page.locator('tr.ld-member', { hasText: 'Ursprunglig del' })
  await row.getByRole('button', { name: 'Edit' }).click()
  const partDialog = dialogWithHeading(page, 'Edit loan part')
  await partDialog.getByRole('button', { name: '+ Add rate period' }).click()
  const periodDialog = dialogWithHeading(page, 'Add rate period')
  await periodDialog.getByLabel('Interest rate %').fill('3.5')
  await periodDialog.getByRole('button', { name: 'Save' }).click()
  await expect(periodDialog).not.toBeVisible()
  await partDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(partDialog).not.toBeVisible()

  const paymentCard = page.locator('#betalningar').locator('..')
  await paymentCard.getByRole('button', { name: '+ Lägg till' }).click()
  const paymentDialog = page.locator('dialog.bk-dialog[open]')
  await expect(paymentDialog.getByRole('heading', { name: 'Lägg till betalning' })).toBeVisible()
  await paymentDialog.getByLabel('Typ').selectOption('extra_amortization')
  await paymentDialog.getByLabel('Belopp').fill('10000')
  await paymentDialog.getByLabel('Saldo efteråt (valfritt)').fill('290000')
  await paymentDialog.getByRole('button', { name: 'Spara' }).click()
  await expect(paymentDialog).not.toBeVisible()

  await switchBank(page, {
    newAgreementLabel: 'Bolån hos Andra banken', newBankLabel: 'Andra banken', renameDraft: 'Ny del',
  })

  await page.getByRole('button', { name: 'Tidigare avtal' }).click()
  const history = dialogWithHeading(page, 'Tidigare avtal')
  await expect(history.locator('.history-parts')).toContainText('Ursprunglig del')
  await expect(history.locator('.history-periods')).toContainText('3,50 %')
  await expect(history.locator('.history-payments')).toContainText(/10\s*000 kr/)

  // Edit the archived part's label from history — this must not reactivate it
  // or move it to the active agreement.
  await history.getByRole('button', { name: 'Redigera lånedel' }).click()
  const archivedPartDialog = dialogWithHeading(page, 'Edit loan part')
  await archivedPartDialog.getByLabel('Label').fill('Ursprunglig del (redigerad)')
  await archivedPartDialog.getByRole('button', { name: 'Save' }).click()
  await expect(archivedPartDialog).not.toBeVisible()

  await expect(history.locator('.history-parts')).toContainText('Ursprunglig del (redigerad)')
  await expect(page.locator('.agreement-name')).toHaveText('Bolån hos Andra banken')
  // The history edit must not move the archived part into the ACTIVE ledger:
  // the main loan-part list shows only the new agreement's part, never the
  // edited old one — active scoping goes through the mortgage link, not the
  // part's own `archived` flag.
  await expect(page.locator('tr.ld-member')).toHaveCount(1)
  await expect(page.locator('tr.ld-member .ld-name')).toHaveText(/Ny del/)
  await expect(page.locator('.lanedelar-table')).not.toContainText('Ursprunglig del')

  await history.getByRole('button', { name: 'Stäng' }).click()
  await page.reload()

  await page.getByRole('button', { name: 'Tidigare avtal' }).click()
  const historyAfterReload = dialogWithHeading(page, 'Tidigare avtal')
  await expect(historyAfterReload.locator('.history-parts')).toContainText('Ursprunglig del (redigerad)')
  await expect(historyAfterReload.locator('.history-periods')).toContainText('3,50 %')
  await expect(historyAfterReload.locator('.history-payments')).toContainText(/10\s*000 kr/)
  await expect(page.locator('.agreement-name')).toHaveText('Bolån hos Andra banken')

  expect(errors).toEqual([])
})
