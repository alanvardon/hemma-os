import { createContext, useContext, useEffect, useState } from 'react'
import { HashRouter, Routes, Route } from 'react-router-dom'
import Home from './routes/Home'
import Bostadskalkyl from './routes/Bostadskalkyl'
import Konsultkalkyl from './routes/Konsultkalkyl'
import Lonevaxling from './routes/Lonevaxling'

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

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem(THEME_KEY, theme) } catch { /* private mode */ }
  }, [theme])

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      <HashRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/bostadskalkyl" element={<Bostadskalkyl />} />
          <Route path="/konsultkalkyl" element={<Konsultkalkyl />} />
          <Route path="/lonevaxling" element={<Lonevaxling />} />
        </Routes>
      </HashRouter>
    </ThemeContext.Provider>
  )
}
