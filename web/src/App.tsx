import { createContext, useContext, useEffect, useState } from 'react'
import { createHashRouter, Outlet, RouterProvider, ScrollRestoration } from 'react-router-dom'
import Home from './routes/Home'
import ScenariosDashboard from './routes/ScenariosDashboard'
import Bostadskalkyl from './routes/Bostadskalkyl'
import Konsultkalkyl from './routes/Konsultkalkyl'
import Lonevaxling from './routes/Lonevaxling'
import Bolanekoll from './routes/Bolanekoll'
import Manadsavslut from './routes/Manadsavslut'
import Hushallsbudget from './routes/Hushallsbudget'

function Layout() {
  return (
    <>
      <ScrollRestoration />
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
      { path: '/bolanekoll', element: <Bolanekoll /> },
      { path: '/manadsavslut', element: <Manadsavslut /> },
      { path: '/hushallsbudget', element: <Hushallsbudget /> },
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
      <RouterProvider router={router} />
    </ThemeContext.Provider>
  )
}
