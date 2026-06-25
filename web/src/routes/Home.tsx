import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import HeroCanvas from '../components/HeroCanvas'
import { useTheme } from '../App'

const fineHover =
  typeof window !== 'undefined' &&
  window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
  !window.matchMedia('(prefers-reduced-motion: reduce)').matches

export default function Home() {
  const { theme, toggleTheme } = useTheme()
  const [clock, setClock] = useState('')
  const [greeting, setGreeting] = useState('')
  const [dateLine, setDateLine] = useState('')

  // Allow body to scroll on the hub (overridden to hidden by the Bostadskalkyl route)
  useLayoutEffect(() => {
    document.documentElement.classList.remove('calc-layout')
  }, [])

  useEffect(() => {
    function render() {
      const now = new Date()
      const h = now.getHours()
      const g = h < 5 ? 'God natt' : h < 10 ? 'God morgon' : h < 18 ? 'God dag' : 'God kväll'
      setGreeting(g + ' —')
      setDateLine(now.toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'long' }))
      setClock(now.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' }))
    }
    render()
    const id = setInterval(render, 30000)
    return () => clearInterval(id)
  }, [])

  // Sync theme-color meta tag whenever theme changes on this route
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) {
      const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()
      meta.setAttribute('content', paper)
    }
    document.title = 'Hemma — family hub'
  }, [theme])

  // App-card spotlight + 3-D tilt via CSS custom properties
  const cardRef = useRef<EventTarget | null>(null)
  function onCardMove(e: React.PointerEvent<HTMLElement>) {
    if (!fineHover) return
    const card = e.currentTarget
    const r = card.getBoundingClientRect()
    const px = (e.clientX - r.left) / r.width
    const py = (e.clientY - r.top) / r.height
    card.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`)
    card.style.setProperty('--my', `${(py * 100).toFixed(1)}%`)
    card.style.setProperty('--tilt-x', `${((0.5 - py) * 4).toFixed(2)}deg`)
    card.style.setProperty('--tilt-y', `${((px - 0.5) * 5).toFixed(2)}deg`)
    cardRef.current = card
  }
  function onCardLeave(e: React.PointerEvent<HTMLElement>) {
    e.currentTarget.style.setProperty('--tilt-x', '0deg')
    e.currentTarget.style.setProperty('--tilt-y', '0deg')
  }

  return (
    <>
      <div className="orbs" aria-hidden="true">
        <div className="orb orb-a" />
        <div className="orb orb-b" />
        <div className="orb orb-c" />
      </div>

      <header className="site-header">
        <a className="wordmark" href="#/">Hemma<span className="dot">.</span></a>
        <div className="header-meta">
          <span className="clock">{clock}</span>
          <button
            className="theme-toggle-btn"
            title="Toggle dark mode"
            aria-label="Toggle dark mode"
            onClick={toggleTheme}
          >
            {theme === 'dark' ? '☾' : '☀'}
          </button>
        </div>
      </header>

      <HeroCanvas>
        <section className="hero">
          <p className="greeting reveal reveal-1">
            <span>{greeting}</span> <span className="date">{dateLine}</span>
          </p>
          <h1 className="reveal reveal-2">
            Everything for the household, <em>in one place.</em>
          </h1>
          <p className="sub reveal reveal-3">
            The family operating system — calculators, plans and shared tools that grow with us.
            Local-first today, synced everywhere tomorrow.
          </p>
        </section>
      </HeroCanvas>

      <main className="apps">
        <p className="apps-label reveal reveal-3">Tools</p>
        <div className="app-grid">

          <Link
            className="app-card reveal reveal-4"
            to="/bostadskalkyl"
            onPointerMove={onCardMove}
            onPointerLeave={onCardLeave}
          >
            <div className="app-card-head">
              <span className="app-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 10.5 12 3l9 7.5"/>
                  <path d="M5.5 9v11h13V9"/>
                  <path d="M9.5 20v-5.5h5V20"/>
                </svg>
              </span>
              <span className="chip chip-live">Live</span>
            </div>
            <span className="app-name">Bostadskalkyl</span>
            <span className="app-desc">House purchase calculator for Sweden — upfront costs, lagfart &amp; pantbrev, bank comparison, stress tests and saved scenarios.</span>
            <span className="app-cta">Open <span className="arrow">→</span></span>
          </Link>

          <a
            className="app-card reveal reveal-5"
            href="hushallsbudget.html"
            onPointerMove={onCardMove}
            onPointerLeave={onCardLeave}
          >
            <div className="app-card-head">
              <span className="app-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="6" width="18" height="13" rx="2.5"/>
                  <path d="M3 10h18"/>
                  <path d="M7 15h4"/>
                </svg>
              </span>
              <span className="chip chip-live">Live</span>
            </div>
            <span className="app-name">Hushållsbudget</span>
            <span className="app-desc">One pot, split evenly — pool both incomes, share joint costs 50/50 and see what each of you has left over.</span>
            <span className="app-cta">Open <span className="arrow">→</span></span>
          </a>

          <Link
            className="app-card reveal reveal-6"
            to="/konsultkalkyl"
            onPointerMove={onCardMove}
            onPointerLeave={onCardLeave}
          >
            <div className="app-card-head">
              <span className="app-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="7.5" width="18" height="12" rx="2.5"/>
                  <path d="M8.5 7.5V6a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v1.5"/>
                  <path d="M3 12.5h18"/>
                  <path d="M12 11.5v2"/>
                </svg>
              </span>
              <span className="chip chip-live">Live</span>
            </div>
            <span className="app-name">Konsultkalkyl</span>
            <span className="app-desc">What could it pay to go independent? Turn an hourly rate into salary, dividend and the tax in between — Sweden, 2026.</span>
            <span className="app-cta">Open <span className="arrow">→</span></span>
          </Link>

          <a
            className="app-card reveal reveal-7"
            href="manadsavslut.html"
            onPointerMove={onCardMove}
            onPointerLeave={onCardLeave}
          >
            <div className="app-card-head">
              <span className="app-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 5.5h16v13H4z"/>
                  <path d="M4 9.5h16"/>
                  <path d="M8 13h5"/>
                  <path d="M16.5 13.5 18 15l2.5-2.5"/>
                </svg>
              </span>
              <span className="chip chip-live">Live</span>
            </div>
            <span className="app-name">Månadsavslut</span>
            <span className="app-desc">The month-end close — import card statements, split shared spending and settle up who owes whom in one tap.</span>
            <span className="app-cta">Open <span className="arrow">→</span></span>
          </a>

          <a
            className="app-card reveal reveal-8"
            href="mortgagetracker.html"
            onPointerMove={onCardMove}
            onPointerLeave={onCardLeave}
          >
            <div className="app-card-head">
              <span className="app-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 10.5 12 3l9 7.5"/>
                  <path d="M5.5 9.5V20h13V9.5"/>
                  <path d="M8.5 16.5l2.5-2.5 2 1.5 2.5-3.5"/>
                </svg>
              </span>
              <span className="chip chip-live">Live</span>
            </div>
            <span className="app-name">Bolånekoll</span>
            <span className="app-desc">Track your mortgage — import the bank's payment CSV, follow each loan part down and watch your equity grow against the bank.</span>
            <span className="app-cta">Open <span className="arrow">→</span></span>
          </a>

          <Link
            className="app-card reveal reveal-9"
            to="/lonevaxling"
            onPointerMove={onCardMove}
            onPointerLeave={onCardLeave}
          >
            <div className="app-card-head">
              <span className="app-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 9h13l-3.5-3.5"/>
                  <path d="M20 15H7l3.5 3.5"/>
                </svg>
              </span>
              <span className="chip chip-live">Live</span>
            </div>
            <span className="app-name">Löneväxling</span>
            <span className="app-desc">Salary sacrifice into pension — at what salary it pays off, the tax you save now and what it's worth net at payout. Sweden, 2026.</span>
            <span className="app-cta">Open <span className="arrow">→</span></span>
          </Link>

          <div
            className="app-card soon reveal reveal-10"
            onPointerMove={onCardMove}
            onPointerLeave={onCardLeave}
          >
            <div className="app-card-head">
              <span className="app-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3.5" y="5" width="17" height="16" rx="2.5"/>
                  <path d="M3.5 10h17"/>
                  <path d="M8 3v4M16 3v4"/>
                </svg>
              </span>
              <span className="chip chip-soon">Soon</span>
            </div>
            <span className="app-name">Kalender</span>
            <span className="app-desc">The family calendar — school, work, trips and everything in between.</span>
          </div>

          <div
            className="app-card soon reveal reveal-11"
            onPointerMove={onCardMove}
            onPointerLeave={onCardLeave}
          >
            <div className="app-card-head">
              <span className="app-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M7 3v7a2.5 2.5 0 0 0 5 0V3"/>
                  <path d="M9.5 13v8"/>
                  <path d="M17 3c-1.7 1.5-2.5 3.8-2.5 6 0 1.5 1 2.5 2.5 2.5V21"/>
                </svg>
              </span>
              <span className="chip chip-soon">Soon</span>
            </div>
            <span className="app-name">Matplan</span>
            <span className="app-desc">Weekly meal planning and the shared shopping list that writes itself.</span>
          </div>

        </div>
      </main>

      <footer className="site-footer">
        <span className="footer-badge"><span className="pulse" />Local-first · Supabase-ready</span>
        <span>Hemma · built by the Vardon family</span>
      </footer>
    </>
  )
}
