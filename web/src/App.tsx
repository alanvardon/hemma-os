import { useEffect, useState } from 'react'

type Theme = 'light' | 'dark'

// Shares the localStorage key with the vanilla app so a returning user's
// theme choice carries over (and the future suite stays in sync).
const THEME_KEY = 'bostadskalkyl_theme'

function getInitialTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

const SECTIONS = [
  { num: 1, title: 'Selling your current property' },
  { num: 2, title: 'Buying your new property' },
  { num: 3, title: 'Monthly costs' },
] as const

const SUMMARY_CARDS = [
  'Cash surplus / shortfall',
  'Net from sale',
  'Total upfront needed',
  'New mortgage',
] as const

export default function App() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* private mode / storage disabled — ignore */
    }
    // Browser chrome follows the page background (matches the vanilla app)
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) {
      const paper = getComputedStyle(document.documentElement)
        .getPropertyValue('--paper')
        .trim()
      meta.setAttribute('content', paper)
    }
  }, [theme])

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))

  return (
    <>
      <header className="page-header">
        <div className="header-brand">
          <a className="hub-link" href="../index.html">‹ Hemma</a>
          <div>
            <h1>Bostadskalkyl</h1>
            <p className="tagline">
              Swedish house purchase calculator — upfront costs &amp; monthly payments
            </p>
          </div>
        </div>
        <div className="header-actions">
          <button
            className="btn btn-ghost theme-toggle-btn"
            title="Toggle dark mode"
            aria-label="Toggle dark mode"
            onClick={toggleTheme}
          >
            {theme === 'dark' ? '☾' : '☀'}
          </button>
          <button className="btn btn-ghost" disabled>Scenarios</button>
          <button className="btn btn-primary" disabled>Save</button>
        </div>
      </header>

      <div className="layout">
        <div className="inputs-col">
          {SECTIONS.map((s) => (
            <section className="section" key={s.num}>
              <div className="section-label">
                <span className="section-num">{s.num}</span>
                <span className="section-title">{s.title}</span>
              </div>
              <p className="shell-placeholder">Inputs arrive in Phase 2.</p>
            </section>
          ))}
        </div>

        <aside className="summary-col">
          <h2 className="summary-title">Summary</h2>
          {SUMMARY_CARDS.map((label) => (
            <div className="sum-card" key={label}>
              <span className="sum-card-label">{label}</span>
              <span className="sum-card-figure">— kr</span>
            </div>
          ))}
        </aside>
      </div>
    </>
  )
}
