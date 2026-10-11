// Shared Resend sender for Edge Functions (plan 131). Fail loud: every
// misconfiguration and non-2xx throws; callers decide per-recipient handling.
//
// No imports, so both Deno (edge functions) and Vitest (web/) can load this
// file directly — same rule plan 132's shared logic modules follow.

export interface Email { subject: string; text: string; html: string }

export function buildResendRequest(
  env: { apiKey?: string; from?: string },
  to: string[],
  email: Email,
): { url: string; init: RequestInit } {
  if (!env.apiKey || !env.from) throw new Error('RESEND_API_KEY / RESEND_FROM are not set')
  if (to.length === 0) throw new Error('sendEmail called with no recipients')
  return {
    url: 'https://api.resend.com/emails',
    init: {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.from, to, subject: email.subject, text: email.text, html: email.html }),
    },
  }
}

export async function sendEmail(
  env: { apiKey?: string; from?: string; dryRun?: boolean },
  to: string[],
  email: Email,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (env.dryRun) {
    // Never log addresses or bodies — they are household data.
    console.log(`[email dry-run] would send "${email.subject}" to ${to.length} recipient(s)`)
    return
  }
  const { url, init } = buildResendRequest(env, to, email)
  const res = await fetchImpl(url, init)
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable body>')
    throw new Error(`Resend send failed: ${res.status} ${body}`)
  }
}
