import { createContext, useContext, useEffect, useState } from 'react'
import { createHashRouter, Navigate, Outlet, RouterProvider, ScrollRestoration } from 'react-router-dom'
import AuthGate from './components/AuthGate'
import Home from './routes/Home'
import ScenariosDashboard from './routes/ScenariosDashboard'
import Bostadskalkyl from './routes/Bostadskalkyl'
import Konsultkalkyl from './routes/Konsultkalkyl'
import Lonevaxling from './routes/Lonevaxling'
import StudentLoan from './routes/StudentLoan'
import Bolanekoll from './routes/Bolanekoll'
import Manadsavslut from './routes/Manadsavslut'
import Hushallsbudget from './routes/Hushallsbudget'
import PersistenceNotice from './components/PersistenceNotice'

function Layout() {
  return (
    <>
      <ScrollRestoration getKey={(location) => location.pathname} />
      <Outlet />
    </>
  )
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

// A data router (not <HashRouter>) so React Router's View Transitions —
// `<Link viewTransition>` + useViewTransitionState — are available (plan 6).
// Still hash-based for GitHub Pages.
const router = createHashRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/bostadskalkyl', element: <ScenariosDashboard /> },
      { path: '/bostadskalkyl/new', element: <Bostadskalkyl /> },
      { path: '/bostadskalkyl/:id', element: <Bostadskalkyl /> },
      { path: '/konsultkalkyl', element: <Konsultkalkyl /> },
      { path: '/lonevaxling', element: <Lonevaxling /> },
      { path: '/student-loan', element: <StudentLoan /> },
      { path: '/bolanekoll', element: <Bolanekoll /> },
      { path: '/manadsavslut', element: <Manadsavslut /> },
      { path: '/hushallsbudget', element: <Hushallsbudget /> },
      // Catch-all: unknown hashes (incl. the magic-link `#access_token…`
      // callback, which supabase-js consumes on load) fall back to the hub
      // instead of React Router's error page — plan 16a.
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])

export default function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem(THEME_KEY, theme) } catch { /* private mode */ }
  }, [theme])

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      <AuthGate>
        <RouterProvider router={router} />
        <PersistenceNotice />
      </AuthGate>
    </ThemeContext.Provider>
  )
}
