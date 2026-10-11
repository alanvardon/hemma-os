/// <reference types="vitest/config" />
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { buildCsp, buildHeadersFile } from './src/lib/security-headers.ts'

// Injects a Content-Security-Policy <meta> as the first element after the
// <meta charset> in <head> (plan 54), and in a build also emits the Cloudflare
// `_headers` file (plan 130). Both come from buildCsp, so they can't drift; the
// meta tag stays as defence in depth and covers hosts that can't set headers.
// CSP is the cheap cap on what an injected script could do to the Supabase
// session token that lives in localStorage.
//
// The inline theme <script> (index.html) is allowed by the sha256 of its exact
// body, computed here so the hash never drifts when the snippet changes. Since
// that hash only exists at build time, `_headers` must be generated, not
// hand-written.
function cspMeta(isDev: boolean, supabaseOrigin: string): Plugin {
  let outDir = ''
  let isBuild = false
  // Captured in transformIndexHtml; read back when writing `_headers`.
  let headerCsp: string | null = null
  let buildFailed = false
  return {
    name: 'hemma-csp-meta',
    configResolved(config) {
      isBuild = config.command === 'build'
      outDir = resolve(config.root, config.build.outDir)
    },
    transformIndexHtml: {
      // Run last so the html we hash matches what ships (nothing rewrites the
      // inline script after us).
      order: 'post',
      handler(html) {
        // The theme snippet is the only attribute-less <script> in the head.
        const m = html.match(/<script>([\s\S]*?)<\/script>/)
        if (!m) throw new Error('[csp] inline theme script not found in index.html')
        const hash = createHash('sha256').update(m[1], 'utf8').digest('base64')

        const csp = buildCsp({ isDev, supabaseOrigin, themeScriptHash: hash })
        headerCsp = csp

        const tag = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`
        // Keep <meta charset> first; slot the CSP right after it, before the
        // theme script so the policy governs it.
        return html.replace(
          /(<meta charset=["']UTF-8["']\s*\/?>)/i,
          `$1\n    ${tag}`,
        )
      },
    },
    buildEnd(error) {
      if (error) buildFailed = true
    },
    // transformIndexHtml('post') can run after generateBundle, so the hash is
    // only guaranteed once the bundle is written — emit `_headers` here.
    closeBundle() {
      if (!isBuild || buildFailed) return
      if (headerCsp === null) {
        throw new Error('[csp] theme script hash was never captured; refusing to build without _headers')
      }
      writeFileSync(resolve(outDir, '_headers'), buildHeadersFile(headerCsp))
    },
  }
}

// Emits bk-assets/version.json next to the hashed bundles so the running app
// can ask "which build is deployed right now?" (plan 100). Only when the build
// carries a SHA — local builds stay stampless and the in-app checker disabled.
function emitVersion(sha: string): Plugin {
  return {
    name: 'hemma-emit-version',
    apply: 'build',
    generateBundle() {
      if (!sha) return
      this.emitFile({
        type: 'asset',
        fileName: 'bk-assets/version.json',
        source: JSON.stringify({ sha, builtAt: new Date().toISOString() }),
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  const isDev = command === 'serve'
  // loadEnv merges .env files + matching process.env (CI passes
  // VITE_SUPABASE_URL as a real env var), so this resolves in both.
  const env = loadEnv(mode, process.cwd(), '')
  // The deploy workflow passes the commit SHA; anywhere else this is ''.
  const buildSha = env.VITE_BUILD_SHA || ''
  const supabaseOrigin = (() => {
    try {
      return new URL(env.VITE_SUPABASE_URL || 'http://localhost:54321').origin
    } catch {
      return 'http://localhost:54321'
    }
  })()

  return {
    plugins: [react(), cspMeta(isDev, supabaseOrigin), emitVersion(buildSha)],
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
      // Node stays the default: the 17 existing lib/store tests don't touch the
      // DOM, so they don't pay jsdom's cost. Component tests opt in per-file with
      // a `// @vitest-environment jsdom` docblock (plan 78).
      environment: 'node',
      // Auto-run @testing-library/react's cleanup() between tests (it hooks the
      // global afterEach) so mounted DOM from one test doesn't leak into the
      // next. Harmless for the existing node tests, which import from 'vitest'
      // explicitly and don't rely on globals.
      globals: true,
      // .tsx so component tests are collected at all; setup.ts registers the
      // jest-dom matchers (toBeInTheDocument, etc.) for the jsdom files.
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['./src/test/setup.ts'],
    },
  }
})
