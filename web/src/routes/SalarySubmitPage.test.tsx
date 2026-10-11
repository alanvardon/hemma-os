// @vitest-environment jsdom
// Plan 132, Stage 4 — the public `#/lon/<token>` page. `fetch` is mocked (the
// page never touches Supabase); every state the plan lists is covered,
// including the two requirements AGENTS.md calls out for a save path: a
// failure must be VISIBLE to the user and typed values must survive it.
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SalarySubmitPage from './SalarySubmitPage'

const TOKEN = 'a'.repeat(43)

interface MockResponse { status: number; body: unknown }

function jsonResponse({ status, body }: MockResponse): Response {
  return { status, json: async () => body } as unknown as Response
}

function mockFetchSequence(responses: MockResponse[]): ReturnType<typeof vi.fn> {
  let i = 0
  const fn = vi.fn(async () => {
    const next = responses[Math.min(i, responses.length - 1)]
    i++
    return jsonResponse(next)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

const OPEN_CONTEXT = {
  status: 200,
  body: {
    month: '2026-10',
    slot: 'a' as const,
    displayName: 'Alex',
    status: 'open' as const,
    items: [{ label: 'Lön', amount: 42350 }],
    note: null,
    expiresAt: '2026-12-01T00:00:00.000Z',
  },
}

beforeEach(() => {
  vi.stubEnv('VITE_SUPABASE_URL', 'http://localhost:54321')
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'anon-test-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('SalarySubmitPage', () => {
  it('loading, then the form with prefilled items — no "0 kr" flash', async () => {
    mockFetchSequence([OPEN_CONTEXT])
    render(<SalarySubmitPage token={TOKEN} />)

    // Still loading: a skeleton, not the form, and never a flashed amount.
    expect(screen.queryByText('Confirm & save')).not.toBeInTheDocument()
    expect(screen.queryByText('0 kr')).not.toBeInTheDocument()

    await screen.findByText('Confirm & save')
    expect(screen.getByText('Alex · October 2026')).toBeInTheDocument()
    const labelInput = screen.getByDisplayValue('Lön') as HTMLInputElement
    expect(labelInput).toBeInTheDocument()
    const amountInput = screen.getByLabelText('Amount, kr') as HTMLInputElement
    expect(amountInput.value).toContain('42')
  })

  it('invalid_link: 404 shows the expired-link message with a link to the app', async () => {
    mockFetchSequence([{ status: 404, body: { error: 'invalid_link' } }])
    render(<SalarySubmitPage token={TOKEN} />)
    await screen.findByText(/This link has expired or is no longer valid/)
    expect(screen.getByRole('link', { name: /Hemma OS/ })).toHaveAttribute('href', './')
  })

  it('already_logged: shows the month is already logged', async () => {
    mockFetchSequence([{ status: 200, body: { status: 'already_logged', month: '2026-10' } }])
    render(<SalarySubmitPage token={TOKEN} />)
    await screen.findByText('October 2026 is already logged.')
  })

  it('submitted (a draft already exists): the form stays and is editable', async () => {
    mockFetchSequence([{
      status: 200,
      body: { ...OPEN_CONTEXT.body, status: 'submitted', items: [{ label: 'Lön', amount: 10000 }] },
    }])
    render(<SalarySubmitPage token={TOKEN} />)
    await screen.findByText('Confirm & save')
    expect(screen.getByText(/Waiting for your partner/)).toBeInTheDocument()
    const labelInput = screen.getByDisplayValue('Lön') as HTMLInputElement
    fireEvent.change(labelInput, { target: { value: 'Lön (ändrad)' } })
    expect(labelInput.value).toBe('Lön (ändrad)')
  })

  it('finalized: the form is replaced by a confirmation', async () => {
    mockFetchSequence([OPEN_CONTEXT, { status: 200, body: { status: 'finalized' } }])
    render(<SalarySubmitPage token={TOKEN} />)
    await screen.findByText('Confirm & save')
    fireEvent.click(screen.getByText('Confirm & save'))
    await screen.findByText(/Both salaries are in — October 2026 is logged\./)
    expect(screen.queryByText('Confirm & save')).not.toBeInTheDocument()
  })

  it('zero_total: an inline message, form stays (the link is still editable)', async () => {
    mockFetchSequence([OPEN_CONTEXT, { status: 200, body: { status: 'zero_total' } }])
    render(<SalarySubmitPage token={TOKEN} />)
    await screen.findByText('Confirm & save')
    fireEvent.click(screen.getByText('Confirm & save'))
    await screen.findByText(/Both entries are 0 kr/)
    expect(screen.getByText('Confirm & save')).toBeInTheDocument()
  })

  it('save failure (network reject): shows an error AND the typed values survive; retry works', async () => {
    mockFetchSequence([OPEN_CONTEXT])
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => jsonResponse(OPEN_CONTEXT))
      .mockImplementationOnce(async () => { throw new TypeError('network down') })
      .mockImplementationOnce(async () => jsonResponse({ status: 200, body: { status: 'finalized' } }))
    vi.stubGlobal('fetch', fetchMock)

    render(<SalarySubmitPage token={TOKEN} />)
    await screen.findByText('Confirm & save')
    const labelInput = screen.getByDisplayValue('Lön') as HTMLInputElement
    fireEvent.change(labelInput, { target: { value: 'Lön + bonus' } })

    fireEvent.click(screen.getByText('Confirm & save'))
    await screen.findByText(/Could not save/)
    // The value the user typed must still be there — nothing was cleared.
    expect(screen.getByDisplayValue('Lön + bonus')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Retry'))
    await screen.findByText(/Both salaries are in/)
  })

  it('save failure (500): shows an error AND the typed values survive', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => jsonResponse(OPEN_CONTEXT))
      .mockImplementationOnce(async () => jsonResponse({ status: 500, body: { error: 'server_error' } }))
    vi.stubGlobal('fetch', fetchMock)

    render(<SalarySubmitPage token={TOKEN} />)
    await screen.findByText('Confirm & save')
    const labelInput = screen.getByDisplayValue('Lön') as HTMLInputElement
    fireEvent.change(labelInput, { target: { value: 'Lön (kvar)' } })

    fireEvent.click(screen.getByText('Confirm & save'))
    await screen.findByText(/Could not save/)
    expect(screen.getByDisplayValue('Lön (kvar)')).toBeInTheDocument()
  })

  it('422: shows the field message and preserves the typed values', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => jsonResponse(OPEN_CONTEXT))
      .mockImplementationOnce(async () => jsonResponse({
        status: 422,
        body: { error: 'invalid', field: 'items[0].label', message: 'Income name must be at most 80 characters.' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    render(<SalarySubmitPage token={TOKEN} />)
    await screen.findByText('Confirm & save')
    const labelInput = screen.getByDisplayValue('Lön') as HTMLInputElement
    fireEvent.change(labelInput, { target: { value: 'x'.repeat(90) } })

    fireEvent.click(screen.getByText('Confirm & save'))
    await screen.findByText('Income name must be at most 80 characters.')
    expect(screen.getByDisplayValue('x'.repeat(90))).toBeInTheDocument()
  })

  it('the context request body is exactly {action, token} — no extra fields leak out', async () => {
    const fetchMock = mockFetchSequence([OPEN_CONTEXT])
    render(<SalarySubmitPage token={TOKEN} />)
    await screen.findByText('Confirm & save')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://localhost:54321/functions/v1/salary-reminder')
    expect(JSON.parse(init.body as string)).toEqual({ action: 'context', token: TOKEN })
  })

  it('renders only the recipient\'s own column — no partner name, items or status', async () => {
    mockFetchSequence([OPEN_CONTEXT])
    render(<SalarySubmitPage token={TOKEN} />)
    await screen.findByText('Confirm & save')

    // Exactly one income column (own slot only — D5).
    expect(document.querySelectorAll('.income-col')).toHaveLength(1)
    expect(document.querySelectorAll('.sal-row')).toHaveLength(1)
    // The response never carries another slot's name or amounts, and the
    // page never invents one.
    expect(screen.queryByText(/Person B/)).not.toBeInTheDocument()
    expect(screen.queryByText('waiting for', { exact: false })).not.toBeInTheDocument()
  })
})
