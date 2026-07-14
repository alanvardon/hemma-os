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
  /** When true, INSERTs to mortgage_loan_parts die at the network layer. */
  failInserts: boolean
}

// Seed the auth session and mock the whole Supabase origin. Inserted loan
// parts are recorded and served back on subsequent GETs, so a reload proves
// the real save→read round trip (not just the localStorage write-through
// cache). Everything else reads empty and accepts writes.
async function mockBackend(page: Page): Promise<Backend> {
  const parts: Record<string, unknown>[] = []
  const backend: Backend = { failInserts: false }

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
    if (path === '/rest/v1/mortgage_loan_parts') {
      if (req.method() === 'POST') {
        if (backend.failInserts) return route.abort('failed')
        const body = req.postDataJSON()
        parts.push(...(Array.isArray(body) ? body : [body]))
        return route.fulfill({ status: 201, body: '' })
      }
      if (req.method() === 'GET') return route.fulfill({ json: parts })
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
