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

interface Backend {
  /** When true, revisioned mortgage writes die at the network layer. */
  failInserts: boolean
  /** Simulate a second device changing an already loaded loan part. */
  remoteUpdatePart(currentLabel: string, nextLabel: string): void
}

// Seed the auth session and mock the whole Supabase origin. Inserted loan
// parts are recorded and served back on subsequent GETs, so a reload proves
// the real save→read round trip (not just the localStorage write-through
// cache). Everything else reads empty and accepts writes.
async function mockBackend(page: Page): Promise<Backend> {
  const parts: Record<string, unknown>[] = []
  const payments: Record<string, unknown>[] = []
  const resources: Record<string, Record<string, unknown>[]> = {
    mortgage_loan_parts: parts,
    mortgage_payments: payments,
  }
  const receipts = new Map<string, unknown>()
  const backend: Backend = {
    failInserts: false,
    remoteUpdatePart(currentLabel, nextLabel) {
      const part = parts.find((row) => row.label === currentLabel)
      if (!part) throw new Error(`Missing mocked loan part: ${currentLabel}`)
      part.label = nextLabel
      part.revision = Number(part.revision) + 1
    },
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
        const saved = { ...row, revision }
        if (index < 0) collection.push(saved); else if (!body.p_seed) collection[index] = saved
        revisions[`${body.p_resource}:${String(row.id)}`] = index >= 0 && body.p_seed
          ? Number(collection[index].revision) : revision
      }
      const response = { status: 'applied', revisions }
      receipts.set(body.p_operation_id, response)
      return route.fulfill({ json: response })
    }
    if (path === '/rest/v1/mortgage_loan_parts') {
      if (req.method() === 'GET') return route.fulfill({ json: parts })
    }
    if (path === '/rest/v1/mortgage_payments') {
      if (req.method() === 'GET') return route.fulfill({ json: payments })
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

async function openAddLoanPartDialog(page: Page) {
  // Fresh household → the empty-hero is the entry point.
  await page.locator('.empty-hero').getByRole('button', { name: '+ Add loan part' }).click()
  // Every tool dialog is a <dialog class="bk-dialog"> in the DOM — [open]
  // selects the one showModal() actually opened.
  const dialog = page.locator('dialog.bk-dialog[open]')
  await expect(dialog.getByRole('heading', { name: 'Add loan part' })).toBeVisible()
  return dialog
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

test('an extra amortering is one canonical payment and one linked Insatser row after reload', async ({ page }) => {
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
  // A Saldo/origination balance is post-transaction for its own date. Log the
  // extra amortering on the following day so this test asserts the required
  // post-anchor debt propagation rather than a same-day snapshot rule.
  const nextDay = new Date()
  nextDay.setDate(nextDay.getDate() + 1)
  await paymentDialog.getByLabel('Datum').fill(nextDay.toISOString().slice(0, 10))
  await paymentDialog.getByLabel('Belopp').fill('20000')
  await paymentDialog.getByRole('button', { name: 'Spara' }).click()

  await expect(page.locator('.bk-toast.show')).toHaveText('Payment saved.')
  await expect(paymentDialog).not.toBeVisible()
  const remainingDebt = page.locator('.metric-chip', { hasText: 'Remaining debt' })
  // NumberFlow exposes each rolling digit to the DOM, so visible text is not a
  // stable financial assertion. The metric's canonical current-debt attribute
  // is the exact resolved value used for the hero/KPI.
  await expect(remainingDebt).toHaveAttribute('data-current-debt', '980000')
  await expect(page.locator('#betalningar').locator('..')).toContainText(/20\s*000 kr/)
  await expect(page.locator('#insatser')).toContainText('Extra amortering / Insats')
  await expect(page.locator('#insatser')).toContainText(/20\s*000 kr/)

  await page.reload()
  await expect(page.locator('.metric-chip', { hasText: 'Remaining debt' })).toHaveAttribute('data-current-debt', '980000')
  await expect(page.locator('#betalningar').locator('..')).toContainText(/20\s*000 kr/)
  await expect(page.locator('#insatser')).toContainText('Extra amortering / Insats')
  await expect(page.locator('#insatser')).toContainText(/20\s*000 kr/)
  expect(errors).toEqual([])
})

test('a failed save survives reload and replays after connectivity returns', async ({ page }) => {
  const errors = trackPageErrors(page)
  const backend = await mockBackend(page)
  backend.failInserts = true
  await page.goto('/#/bolanekoll')

  const dialog = await openAddLoanPartDialog(page)
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

  // `online` is a retry hint; only the now-successful request produces Sparat.
  backend.failInserts = false
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.locator('.persistence-notice')).toContainText('Sparat')
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
