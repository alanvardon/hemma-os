import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import HeroCanvas from '../components/HeroCanvas'
import FlipClock from '../components/FlipClock'
import HubSparkline from '../components/HubSparkline'
import { Money, MoneyCompact, Num, Percent } from '../components/AnimatedNumber'
import { useTheme } from '../App'
import { markVtTransition } from '../lib/viewTransition'
import { timeBucket, greetingFor } from '../lib/heroScene'
import { useToolCardActive } from '../lib/toolTransition'
import { useStore } from '../store/useStore'
import * as mortgageStore from '../lib/mortgage-store'
import * as monthEndStore from '../lib/manadsavslut-store'
import { loadBudget } from '../lib/hushallsbudget-store'
import {
  mortgageStat,
  monthEndStat,
  budgetStat,
  scenarioStat,
  orderTools,
  markOpened,
  readLastOpened,
  type MortgageStat,
  type MonthEndStat,
  type BudgetStat,
} from '../lib/hub-stats'

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

const fineHover =
  typeof window !== 'undefined' &&
  window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
  !window.matchMedia('(prefers-reduced-motion: reduce)').matches

// ── The bento (plan 30) ──────────────────────────────────────────────────────
// Tools with persisted household data are WIDE cards showing the live figures;
// pure calculators stay standard. Wide cards are pinned to their row starts;
// the standard cards reorder by last-opened recency (orderTools).

interface ToolDef {
  path: string
  name: string
  desc: string
  icon: ReactNode
}

const BOLANEKOLL: ToolDef = {
  path: '/bolanekoll',
  name: 'Bolånekoll',
  desc: "Track your mortgage — import the bank's payment CSV, follow each loan part down and watch your equity grow against the bank.",
  icon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 10.5 12 3l9 7.5"/>
      <path d="M5.5 9.5V20h13V9.5"/>
      <path d="M8.5 16.5l2.5-2.5 2 1.5 2.5-3.5"/>
    </svg>
  ),
}

const MANADSAVSLUT: ToolDef = {
  path: '/manadsavslut',
  name: 'Månadsavslut',
  desc: 'The month-end close — import card statements, split shared spending and settle up who owes whom in one tap.',
  icon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 5.5h16v13H4z"/>
      <path d="M4 9.5h16"/>
      <path d="M8 13h5"/>
      <path d="M16.5 13.5 18 15l2.5-2.5"/>
    </svg>
  ),
}

const STANDARD_TOOLS: ToolDef[] = [
  {
    path: '/hushallsbudget',
    name: 'Hushållsbudget',
    desc: 'One pot, split evenly — pool both incomes, share joint costs 50/50 and see what each of you has left over.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="6" width="18" height="13" rx="2.5"/>
        <path d="M3 10h18"/>
        <path d="M7 15h4"/>
      </svg>
    ),
  },
  {
    path: '/bostadskalkyl',
    name: 'Bostadskalkyl',
    desc: 'House purchase calculator for Sweden — upfront costs, lagfart & pantbrev, bank comparison, stress tests and saved scenarios.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 10.5 12 3l9 7.5"/>
        <path d="M5.5 9v11h13V9"/>
        <path d="M9.5 20v-5.5h5V20"/>
      </svg>
    ),
  },
  {
    path: '/konsultkalkyl',
    name: 'Konsultkalkyl',
    desc: 'What could it pay to go independent? Turn an hourly rate into salary, dividend and the tax in between — Sweden, 2026.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="7.5" width="18" height="12" rx="2.5"/>
        <path d="M8.5 7.5V6a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v1.5"/>
        <path d="M3 12.5h18"/>
        <path d="M12 11.5v2"/>
      </svg>
    ),
  },
  {
    path: '/lonevaxling',
    name: 'Löneväxling',
    desc: "Salary sacrifice into pension — at what salary it pays off, the tax you save now and what it's worth net at payout. Sweden, 2026.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 9h13l-3.5-3.5"/>
        <path d="M20 15H7l3.5 3.5"/>
      </svg>
    ),
  },
]

interface HubStats {
  mortgage: MortgageStat | null
  monthEnd: MonthEndStat | null
  budget: BudgetStat | null
}

export default function Home() {
  const { theme, toggleTheme } = useTheme()
  const navigate = useNavigate()
  // Wraps the whole hub so we can pan it as a "camera" before the zoom.
  const panRef = useRef<HTMLDivElement>(null)
  // When the hub re-mounts as the destination of the BACK whoosh, skip the
  // `reveal` rise-in entrance: the View Transition freezes the cards at opacity 0
  // (the reveal's `backwards` fill) and they'd pop in after the zoom. Captured
  // once at mount; on a normal page load `data-vt-dir` is unset so reveals play.
  const [viaBack] = useState(
    () => typeof document !== 'undefined' && document.documentElement.dataset.vtDir === 'back',
  )
  // Each live card claims `tool-card` only while a whoosh to/from its path is
  // active. Hooks must be called unconditionally (rules-of-hooks) — one call per
  // card at the top of the component, regardless of the render order below.
  const active: Record<string, boolean> = {
    '/bostadskalkyl': useToolCardActive('/bostadskalkyl'),
    '/hushallsbudget': useToolCardActive('/hushallsbudget'),
    '/konsultkalkyl': useToolCardActive('/konsultkalkyl'),
    '/manadsavslut': useToolCardActive('/manadsavslut'),
    '/bolanekoll': useToolCardActive('/bolanekoll'),
    '/lonevaxling': useToolCardActive('/lonevaxling'),
  }

  // Two-beat open: PAN the clicked card to the centre of the screen, THEN start
  // the View-Transition whoosh (which now grows from the centre, since the card
  // is captured centred). The pan translates the whole hub like a camera move.
  const startWhoosh = (path: string) => {
    // The OS learns the household: remember the open so the standard cards can
    // sort by recency on the next hub visit.
    markOpened(path, Date.now())
    markVtTransition(path, 'forward')
    navigate(path, { viewTransition: true })
  }
  const onToolCardClick = (e: React.MouseEvent<HTMLAnchorElement>, path: string) => {
    // Let modified / non-primary clicks open normally (new tab, etc.).
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    e.preventDefault()
    const pan = panRef.current
    const isMobilePush = typeof window !== 'undefined' && window.matchMedia('(max-width: 600px)').matches
    if (prefersReducedMotion() || isMobilePush || !pan) {
      startWhoosh(path)
      return
    }
    const r = e.currentTarget.getBoundingClientRect()
    const dx = window.innerWidth / 2 - (r.left + r.width / 2)
    const dy = window.innerHeight / 2 - (r.top + r.height / 2)
    pan
      .animate(
        [{ transform: 'translate(0px, 0px)' }, { transform: `translate(${dx}px, ${dy}px) scale(1.04)` }],
        { duration: 760, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' },
      )
      .finished.then(() => startWhoosh(path), () => startWhoosh(path))
  }
  const [greeting, setGreeting] = useState('')
  const [dateLine, setDateLine] = useState('')

  // Allow body to scroll on the hub (overridden to hidden by the Bostadskalkyl route)
  useLayoutEffect(() => {
    document.documentElement.classList.remove('calc-layout')
  }, [])

  // Warm every store while on the hub so the bento stats AND the dashboard are
  // fully populated before a whoosh — a first-visit hydrate that lands
  // mid-transition would otherwise snapshot an empty page and pop content in
  // afterward. All reads are idempotent localStorage loads.
  const [stats, setStats] = useState<HubStats>({ mortgage: null, monthEnd: null, budget: null })
  useEffect(() => {
    useStore.getState().hydrate()
    const budget = budgetStat(loadBudget())
    let alive = true
    Promise.all([
      mortgageStore.listLoanParts(),
      mortgageStore.listPayments(),
      mortgageStore.listValuations(),
      monthEndStore.listItems(),
      monthEndStore.listPayments(),
      monthEndStore.getSettings(),
    ]).then(([parts, mortgagePays, valuations, items, monthEndPays, maSettings]) => {
      if (!alive) return
      setStats({
        mortgage: mortgageStat(parts, mortgagePays, valuations),
        monthEnd: monthEndStat(items, monthEndPays, maSettings, new Date()),
        budget,
      })
    })
    return () => { alive = false }
  }, [])

  // Bostadskalkyl's scenarios live in the reactive store (hydrated above).
  const scenarios = useStore((s) => s.scenarios)
  const globalConstants = useStore((s) => s.globalConstants)
  const scStat = useMemo(() => scenarioStat(scenarios, globalConstants), [scenarios, globalConstants])

  // Standard cards sort by last-opened recency, frozen once per mount so the
  // grid never reshuffles under the pointer; wide cards are pinned to their
  // row starts so the layout keeps its anchors.
  const [lastOpened] = useState(() => readLastOpened(STANDARD_TOOLS.map((t) => t.path)))
  const standard = useMemo(() => orderTools(STANDARD_TOOLS, lastOpened), [lastOpened])
  const grid: Array<{ tool: ToolDef; wide: boolean }> = [
    { tool: BOLANEKOLL, wide: true },
    { tool: standard[0], wide: false },
    { tool: standard[1], wide: false },
    { tool: MANADSAVSLUT, wide: true },
    { tool: standard[2], wide: false },
    { tool: standard[3], wide: false },
  ]

  useEffect(() => {
    function render() {
      const now = new Date()
      // Shared bucket (lib/heroScene) — the WebGL scene lights itself from the
      // same function, so greeting text and terrain light can never disagree.
      const g = greetingFor(timeBucket(now.getHours()))
      setGreeting(g + ' —')
      setDateLine(now.toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'long' }))
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
    document.title = 'Hemma·OS — family hub'
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

  // The stat block on a WIDE card — rendered only when the store has real
  // content (empty store → the card keeps its description, never 0 kr).
  function wideStatFor(path: string): ReactNode {
    if (path === '/bolanekoll' && stats.mortgage) {
      const m = stats.mortgage
      return (
        <div className="card-stat">
          <span className="stat-label">Kvar på lånet</span>
          <span className="stat-value"><Money value={m.debt} rollIn /></span>
          <HubSparkline values={m.spark} />
          {m.ownedPct != null && (
            <span className="stat-sub">Ni äger <Percent value={m.ownedPct} decimals={1} space locale="sv-SE" /></span>
          )}
        </div>
      )
    }
    if (path === '/manadsavslut' && stats.monthEnd) {
      const me = stats.monthEnd
      return (
        <div className="card-stat">
          <span className="stat-label">Nästa avslut</span>
          <span className="stat-value">
            {me.days === 0 ? 'idag' : <>om <Num value={me.days} /> {me.days === 1 ? 'dag' : 'dagar'}</>}
          </span>
          {me.settle && (
            <span className="stat-sub">{me.settle.from} → {me.settle.to} · <Money value={me.settle.amount} /></span>
          )}
        </div>
      )
    }
    return null
  }

  // The one-line stat on a STANDARD card, sitting on the footer row.
  function statLineFor(path: string): ReactNode {
    if (path === '/hushallsbudget' && stats.budget) {
      const b = stats.budget
      return b.equal
        ? <Money value={b.a} signed suffix=" var" />
        : <><MoneyCompact value={b.a} signed /> · <MoneyCompact value={b.b} signed /></>
    }
    if (path === '/bostadskalkyl' && scStat) {
      return scStat.monthly != null
        ? <Money value={scStat.monthly} suffix="/mån" />
        : <><Num value={scStat.count} /> sparade scenarier</>
    }
    return null
  }

  function renderCard({ tool, wide }: { tool: ToolDef; wide: boolean }, i: number) {
    const stat = wide ? wideStatFor(tool.path) : statLineFor(tool.path)
    const cls =
      'app-card reveal reveal-' + (4 + i) +
      (wide ? ' wide' : '') +
      (stat ? ' has-stat' : '') +
      (active[tool.path] ? ' vt-card' : '')
    const inner = (
      <>
        <div className="app-card-head">
          <span className="app-icon">{tool.icon}</span>
          <span className="chip chip-live">Live</span>
        </div>
        <span className="app-name">{tool.name}</span>
        <span className="app-desc">{tool.desc}</span>
        <span className="app-foot">
          <span className="app-cta">Open <span className="arrow">→</span></span>
          {!wide && stat ? <span className="stat-line">{stat}</span> : null}
        </span>
      </>
    )
    return (
      <Link
        key={tool.path}
        className={cls}
        to={tool.path}
        onClick={(e) => onToolCardClick(e, tool.path)}
        onPointerMove={onCardMove}
        onPointerLeave={onCardLeave}
      >
        {wide ? <div className="app-card-main">{inner}</div> : inner}
        {wide ? stat : null}
      </Link>
    )
  }

  return (
    <>
    {/* The header sits OUTSIDE .hub-pan: the camera pan transforms .hub-pan, and a
        transform on a sticky element's ancestor changes its containing block,
        dragging the pinned header into the scene (most visible when scrolled to
        the bottom — the pan translates downward and freezes the bar mid-screen
        via fill:forwards). Kept as a sibling, the header stays pinned chrome and
        is simply covered by the growing dashboard at any scroll position. */}
    <a className="skip-link" href="#tools">Skip to tools</a>

    <header className="site-header">
      <a className="wordmark" href="#/">Hemma<span className="dot">·</span>OS</a>
      <div className="header-meta">
        <div className="flip-clock-header">
          <FlipClock reduce={prefersReducedMotion()} instant={viaBack} />
        </div>
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

    <div className={'hub-pan' + (viaBack ? ' no-reveal' : '')} ref={panRef}>
      <div className="orbs" aria-hidden="true">
        <div className="orb orb-a" />
        <div className="orb orb-b" />
        <div className="orb orb-c" />
      </div>

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

      <main className="apps" id="tools">
        <p className="apps-label reveal reveal-3">Tools</p>
        <div className="app-grid">
          {grid.map((entry, i) => renderCard(entry, i))}
        </div>
      </main>

      <footer className="site-footer">
        <span className="footer-badge"><span className="pulse" />Local-first · Supabase-ready</span>
        <span className="footer-soon">Kommer snart: Kalender · Matplan</span>
        <span>Hemma·OS · built by the Vardon family</span>
      </footer>
    </div>
    </>
  )
}
