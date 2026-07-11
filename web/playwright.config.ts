import { defineConfig } from '@playwright/test'

// E2E suite (plan 79): runs against the PRODUCTION bundle via `vite preview`,
// not the dev server — this exercises what actually ships (CSP meta, minified
// bundle, no devAuth). The network boundary is mocked per-test with page.route,
// so no Supabase instance (local or CI service container) is ever needed.
//
// The Supabase env is pinned here rather than read from .env.local: the bundle's
// CSP connect-src and the specs' route mask must agree on the origin, and a
// .env.local pointing elsewhere would silently break interception. The key is a
// placeholder — every request to this origin is intercepted before it leaves.
const SUPABASE_URL = 'http://localhost:54321'

export default defineConfig({
  testDir: './e2e',
  webServer: {
    command: 'npm run build && npm run preview -- --port 5175 --strictPort',
    port: 5175,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000, // includes the tsc -b + vite build
    env: {
      VITE_SUPABASE_URL: SUPABASE_URL,
      VITE_SUPABASE_PUBLISHABLE_KEY: 'e2e-placeholder-key',
    },
  },
  use: {
    baseURL: 'http://localhost:5175',
    // Headless Chrome needs software WebGL for the hero canvas — see
    // project_web_landmines.md; NOT --disable-gpu, that breaks the GL path.
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] },
  },
})
