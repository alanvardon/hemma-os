/// <reference types="vitest/config" />
import { createHash } from 'node:crypto'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Injects a Content-Security-Policy <meta> as the first element after the
// <meta charset> in <head> (plan 54). GitHub Pages can't set response headers,
// so a meta CSP is the only lever — it covers everything except
// frame-ancestors/reporting. CSP is the cheap cap on what an injected script
// could do to the Supabase session token that lives in localStorage.
//
// The inline theme <script> (index.html) is allowed by the sha256 of its exact
// body, computed here so the hash never drifts when the snippet changes. In dev
// we can't use the hash: Vite injects its own inline scripts (HMR client, React
// refresh preamble), and a hash/nonce makes the browser IGNORE 'unsafe-inline'
// — so dev uses 'unsafe-inline'/'unsafe-eval' and prod stays strict.
function cspMeta(isDev: boolean, supabaseOrigin: string): Plugin {
  return {
    name: 'hemma-csp-meta',
    transformIndexHtml: {
      // Run last so the html we hash matches what ships (nothing rewrites the
      // inline script after us).
      order: 'post',
      handler(html) {
        // The theme snippet is the only attribute-less <script> in the head.
        const m = html.match(/<script>([\s\S]*?)<\/script>/)
        if (!m) throw new Error('[csp] inline theme script not found in index.html')
        const hash = createHash('sha256').update(m[1], 'utf8').digest('base64')

        // Scheme-aware: prod → https://<ref>.supabase.co, a local prod build →
        // http://localhost:54321 (so the built app still reaches local Supabase
        // for verification). ws(s) variant covers any realtime socket.
        const supaHttp = supabaseOrigin
        const supaWs = supabaseOrigin.replace(/^http/, 'ws')
        const scriptSrc = isDev
          ? "'self' 'unsafe-inline' 'unsafe-eval'"
          : `'self' 'sha256-${hash}'`
        // Dev talks to a local Supabase (http) and needs ws HMR; prod pins the
        // baked Supabase origin (the key is in the bundle anyway).
        const connectSrc = isDev
          ? `'self' http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:* ${supaHttp} ${supaWs}`
          : `'self' ${supaHttp} ${supaWs}`

        const csp = [
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

        const tag = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`
        // Keep <meta charset> first; slot the CSP right after it, before the
        // theme script so the policy governs it.
        return html.replace(
          /(<meta charset=["']UTF-8["']\s*\/?>)/i,
          `$1\n    ${tag}`,
        )
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  const isDev = command === 'serve'
  // loadEnv merges .env files + matching process.env (CI passes
  // VITE_SUPABASE_URL as a real env var), so this resolves in both.
  const env = loadEnv(mode, process.cwd(), '')
  const supabaseOrigin = (() => {
    try {
      return new URL(env.VITE_SUPABASE_URL || 'http://localhost:54321').origin
    } catch {
      return 'http://localhost:54321'
    }
  })()

  return {
    plugins: [react(), cspMeta(isDev, supabaseOrigin)],
    // Served as bostadskalkyl.html alongside the hub + the other 5 calculators in
    // the Hemma site. Relative base ('./') makes every asset URL relative to the
    // html file, so the build works whether the site is published at the domain
    // root or under a subpath like GitHub Pages' /bostadskalkyl/. assetsDir keeps
    // the hashed bundle namespaced (/bk-assets/) so it stays collision-free at the
    // shared root as more tools migrate.
    base: './',
    build: { assetsDir: 'bk-assets' },
    server: { port: 5174 },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  }
})
