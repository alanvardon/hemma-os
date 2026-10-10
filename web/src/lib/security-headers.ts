// Single source of the app's Content-Security-Policy (plans 54 + 130). The
// meta tag injected by vite.config.ts and the Cloudflare `_headers` file are
// both built from buildCsp, so the two policies can never drift (D5).
//
// Pure on purpose: no node/vite imports, so it is unit-testable and the
// sha256 of the inline theme script is computed by the caller.

export interface CspOptions {
  isDev: boolean
  // Scheme-aware: prod → https://<ref>.supabase.co, a local prod build →
  // http://localhost:54321 (so the built app still reaches local Supabase for
  // verification).
  supabaseOrigin: string
  // base64 sha256 of the inline theme <script> body (ignored in dev).
  themeScriptHash: string
}

// In dev we can't use the hash: Vite injects its own inline scripts (HMR
// client, React refresh preamble), and a hash/nonce makes the browser IGNORE
// 'unsafe-inline' — so dev uses 'unsafe-inline'/'unsafe-eval' and prod stays
// strict.
export function buildCsp({ isDev, supabaseOrigin, themeScriptHash }: CspOptions): string {
  // ws(s) variant covers any realtime socket.
  const supaHttp = supabaseOrigin
  const supaWs = supabaseOrigin.replace(/^http/, 'ws')
  const scriptSrc = isDev
    ? "'self' 'unsafe-inline' 'unsafe-eval'"
    : `'self' 'sha256-${themeScriptHash}'`
  // Dev talks to a local Supabase (http) and needs ws HMR; prod pins the
  // baked Supabase origin (the key is in the bundle anyway).
  const connectSrc = isDev
    ? `'self' http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:* ${supaHttp} ${supaWs}`
    : `'self' ${supaHttp} ${supaWs}`

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    // Motion/visx/NumberFlow inject inline styles + style attrs — style
    // injection is far lower risk than script, so 'unsafe-inline' stays.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    // Aurora video + posters are bundled assets.
    "media-src 'self'",
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ')
}

// The Cloudflare Workers static-assets `_headers` file (plan 130). The header
// CSP is the meta CSP plus frame-ancestors, which a meta tag can't express.
export function buildHeadersFile(csp: string): string {
  const rules: Array<[pattern: string, headers: string[]]> = [
    [
      '/*',
      [
        `Content-Security-Policy: ${csp}; frame-ancestors 'none'`,
        // No includeSubDomains/preload: preload is hard to undo, and
        // includeSubDomains would commit mail. (Resend) and any future
        // subdomain to HTTPS. Revisit once the domain is settled.
        'Strict-Transport-Security: max-age=31536000',
        'X-Content-Type-Options: nosniff',
        'Referrer-Policy: strict-origin-when-cross-origin',
        'Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()',
      ],
    ],
    // The update notice (plan 100) must never see a stale edge copy.
    ['/bk-assets/version.json', ['Cache-Control: no-store']],
    // Keep preview/version URLs on workers.dev out of search engines.
    ['https://:version.:subdomain.workers.dev/*', ['X-Robots-Tag: noindex']],
  ]
  return rules
    .map(([pattern, headers]) => [pattern, ...headers.map((h) => `  ${h}`)].join('\n'))
    .join('\n') + '\n'
}
