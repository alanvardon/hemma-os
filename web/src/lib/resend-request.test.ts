// Tests the shared Resend helper (plan 131) by importing the Deno edge
// function module directly by relative path. The module has no imports of
// its own, so it loads cleanly under Vitest too (see that file's header
// comment).
import { describe, expect, it, vi } from 'vitest'
import { buildResendRequest, sendEmail } from '../../../supabase/functions/_shared/resend.ts'

const email = { subject: 'Riksbanken ändrade styrräntan till 2,75 %', text: 'body text', html: '<p>body text</p>' }

describe('buildResendRequest', () => {
  it('throws when the API key is missing', () => {
    expect(() => buildResendRequest({ from: 'Hemma OS <notiser@mail.vardon-family.se>' }, ['a@example.com'], email)).toThrow(
      /RESEND_API_KEY/,
    )
  })

  it('throws when the sender is missing', () => {
    expect(() => buildResendRequest({ apiKey: 're_123' }, ['a@example.com'], email)).toThrow(/RESEND_FROM/)
  })

  it('throws when there are no recipients', () => {
    expect(() =>
      buildResendRequest({ apiKey: 're_123', from: 'Hemma OS <notiser@mail.vardon-family.se>' }, [], email),
    ).toThrow(/no recipients/)
  })

  it('builds a body with exactly {from, to, subject, text, html} — no tracking or reply_to', () => {
    const { url, init } = buildResendRequest(
      { apiKey: 're_123', from: 'Hemma OS <notiser@mail.vardon-family.se>' },
      ['a@example.com', 'b@example.com'],
      email,
    )
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      Authorization: 'Bearer re_123',
      'Content-Type': 'application/json',
    })
    const body = JSON.parse(init.body as string)
    expect(Object.keys(body).sort()).toEqual(['from', 'html', 'subject', 'text', 'to'])
    expect(body).toEqual({
      from: 'Hemma OS <notiser@mail.vardon-family.se>',
      to: ['a@example.com', 'b@example.com'],
      subject: email.subject,
      text: email.text,
      html: email.html,
    })
  })
})

describe('sendEmail', () => {
  it('in dry-run mode never calls fetchImpl and logs neither addresses nor body', async () => {
    const fetchImpl = vi.fn()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await sendEmail(
      { apiKey: 're_123', from: 'Hemma OS <notiser@mail.vardon-family.se>', dryRun: true },
      ['secret-person@example.com'],
      email,
      fetchImpl,
    )

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledTimes(1)
    const logged = logSpy.mock.calls[0].join(' ')
    expect(logged).not.toContain('@')
    expect(logged).not.toContain(email.text)
    expect(logged).not.toContain(email.html)
    expect(logged).toContain(email.subject)
    expect(logged).toContain('1 recipient')

    logSpy.mockRestore()
  })

  it('in dry-run mode does not throw even without an API key or sender', async () => {
    const fetchImpl = vi.fn()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(sendEmail({ dryRun: true }, ['a@example.com'], email, fetchImpl)).resolves.toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()

    logSpy.mockRestore()
  })

  it('throws (including the status) when fetchImpl returns non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 422, text: () => Promise.resolve('bad request') })

    await expect(
      sendEmail({ apiKey: 're_123', from: 'Hemma OS <notiser@mail.vardon-family.se>' }, ['a@example.com'], email, fetchImpl),
    ).rejects.toThrow(/422/)
  })

  it('resolves when fetchImpl returns 2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') })

    await expect(
      sendEmail({ apiKey: 're_123', from: 'Hemma OS <notiser@mail.vardon-family.se>' }, ['a@example.com'], email, fetchImpl),
    ).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
