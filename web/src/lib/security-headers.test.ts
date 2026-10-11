import { describe, it, expect } from 'vitest'
import { buildCsp, buildHeadersFile } from './security-headers'

const SUPABASE = 'https://example-ref.supabase.co'
const HASH = 'H8hQrsUyZq7klPtt2rJC/OwFmawwNJ8ZIvjmI8Mr6ww='

// Captured from the plan-54 meta tag in dist/index.html (built before plan 130
// with VITE_SUPABASE_URL=https://example-ref.supabase.co), so the extraction
// into buildCsp is provably byte-identical.
const PROD_CSP =
  "default-src 'self'; " +
  `script-src 'self' 'sha256-${HASH}'; ` +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self'; " +
  "media-src 'self'; " +
  `connect-src 'self' ${SUPABASE} wss://example-ref.supabase.co; ` +
  "object-src 'none'; " +
  "base-uri 'self'"

// Captured from `vite` dev serve with the same env.
const DEV_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "font-src 'self'; " +
  "media-src 'self'; " +
  "connect-src 'self' http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:* " +
  `${SUPABASE} wss://example-ref.supabase.co; ` +
  "object-src 'none'; " +
  "base-uri 'self'"

function directives(csp: string): string[] {
  return csp.split(';').map((d) => d.trim()).filter(Boolean)
}

describe('buildCsp', () => {
  it('reproduces the plan-54 production policy exactly', () => {
    expect(buildCsp({ isDev: false, supabaseOrigin: SUPABASE, themeScriptHash: HASH })).toBe(PROD_CSP)
  })

  it('reproduces the dev policy exactly and ignores the hash', () => {
    expect(buildCsp({ isDev: true, supabaseOrigin: SUPABASE, themeScriptHash: HASH })).toBe(DEV_CSP)
    expect(buildCsp({ isDev: true, supabaseOrigin: SUPABASE, themeScriptHash: 'other' })).toBe(DEV_CSP)
  })

  it('derives the ws origin from a local http Supabase', () => {
    const csp = buildCsp({ isDev: false, supabaseOrigin: 'http://localhost:54321', themeScriptHash: HASH })
    expect(directives(csp)).toContain("connect-src 'self' http://localhost:54321 ws://localhost:54321")
  })
})

describe('buildHeadersFile', () => {
  const csp = buildCsp({ isDev: false, supabaseOrigin: SUPABASE, themeScriptHash: HASH })
  const file = buildHeadersFile(csp)

  it('adds frame-ancestors and the baseline security headers to every path', () => {
    expect(file.startsWith('/*\n')).toBe(true)
    expect(file).toContain("frame-ancestors 'none'")
    expect(file).toContain('  Strict-Transport-Security: max-age=31536000\n')
    expect(file).not.toMatch(/includeSubDomains|preload/)
    expect(file).toContain('  X-Content-Type-Options: nosniff\n')
    expect(file).toContain('  Referrer-Policy: strict-origin-when-cross-origin\n')
    expect(file).toContain('  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()\n')
  })

  it('never caches version.json at the edge', () => {
    expect(file).toContain('/bk-assets/version.json\n  Cache-Control: no-store\n')
  })

  it('keeps workers.dev URLs out of search engines', () => {
    expect(file).toContain('https://:version.:subdomain.workers.dev/*\n  X-Robots-Tag: noindex\n')
  })

  it('ends with a newline and indents every header line', () => {
    expect(file.endsWith('\n')).toBe(true)
    for (const line of file.trimEnd().split('\n')) {
      expect(line.startsWith('/') || line.startsWith('https://') || line.startsWith('  ')).toBe(true)
    }
  })

  it('header CSP equals the meta CSP plus frame-ancestors and nothing else', () => {
    const lines = file.split('\n').filter((l) => l.startsWith('  Content-Security-Policy: '))
    expect(lines).toHaveLength(1)
    const headerCsp = lines[0].slice('  Content-Security-Policy: '.length)
    expect(directives(headerCsp)).toEqual([...directives(csp), "frame-ancestors 'none'"])
  })
})
