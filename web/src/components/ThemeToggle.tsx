import { Moon, Sun } from 'lucide-react'
import { useTheme } from '../App'
import Icon from './Icon'

// The dark/light toggle button in every tool-page header. Self-contained: reads
// the theme context itself, so headers just drop in <ThemeToggle />.
export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  return (
    <button
      className="btn btn-ghost theme-toggle-btn"
      title="Toggle dark mode"
      aria-label="Toggle dark mode"
      onClick={toggleTheme}
    >
      <Icon icon={theme === 'dark' ? Moon : Sun} size={18} />
    </button>
  )
}
