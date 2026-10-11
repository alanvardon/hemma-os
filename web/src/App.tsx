import { createContext, lazy, Suspense, useContext, useEffect, useState } from 'react'
import SalarySubmitPage from './routes/SalarySubmitPage'

// AppShell — the router, AuthGate, Supabase, every tool store — is
// lazy-imported (plan 132). A dynamic `import()` only runs when the component
// requesting it actually renders; the public `#/lon/<token>` branch below
// never renders <AppShell/>, so it never evaluates `lib/supabase`, the
// Zustand store or any `*-store.ts`. See AppShell.tsx and
// SalarySubmitPage.test.tsx's import-boundary test.
const AppShell = lazy(() => import('./AppShell'))

// `#/lon/<token>` — the public salary-submission link emailed to each person
// (plan 132). Checked before AuthGate/the router render at all. The token is
// 32 random bytes as base64url (43 chars); `{20,}` only sets a cheap lower
// bound here — the Edge Function is the real validator.
const SALARY_LINK_RE = /^#\/lon\/([A-Za-z0-9_-]{20,})$/

function matchSalaryToken(hash: string): string | null {
  const m = SALARY_LINK_RE.exec(hash)
  return m ? m[1] : null
}

type Theme = 'light' | 'dark'
const THEME_KEY = 'bostadskalkyl_theme'

interface ThemeCtx {
  theme: Theme
  toggleTheme: () => void
}

export const ThemeContext = createContext<ThemeCtx>({ theme: 'light', toggleTheme: () => {} })
export const useTheme = () => useContext(ThemeContext)

function getInitialTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  // Read once at mount: a hash-router navigation never changes which branch
  // this page is (the token page is never linked to from inside the app, and
  // the app is never linked to from this page without a full reload).
  const [salaryToken] = useState<string | null>(() => matchSalaryToken(window.location.hash))

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem(THEME_KEY, theme) } catch { /* private mode */ }
  }, [theme])

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {salaryToken
        ? <SalarySubmitPage token={salaryToken} />
        : (
          <Suspense fallback={<div className="auth-splash" aria-hidden="true" />}>
            <AppShell />
          </Suspense>
        )}
    </ThemeContext.Provider>
  )
}
