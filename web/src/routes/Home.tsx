import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Moon, Sun } from 'lucide-react'
import HeroCanvas from '../components/HeroCanvas'
import Icon from '../components/Icon'
import FlipClock from '../components/FlipClock'
import HouseholdMenu from '../components/HouseholdMenu'
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
import * as houseStore from '../lib/huskalendern-store'
import { fetchPolicyRate, nextDecision, currentPoint, type PolicyRateData } from '../lib/riksbank'
import { todayISO } from '../lib/date'
import {
  mortgageStat,
  monthEndStat,
  budgetStat,
  scenarioStat,
  houseStat,
  orderTools,
  markOpened,
  readLastOpened,
  type MortgageStat,
  type MonthEndStat,
  type BudgetStat,
  type HouseStat,
} from '../lib/hub-stats'

/** "17 jun" — short sv-SE date for the styrränta stat line (plan 70). Strips
 * the trailing period sv-SE puts on most abbreviated months ("19 aug."). */
function fmtShortDate(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' }).replace(/\.$/, '')
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

const fineHover =
  typeof window !== 'undefined' &&
  window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
  !window.matchMedia('(prefers-reduced-motion: reduce)').matches

// ── The bento (plans 30, 68) ─────────────────────────────────────────────────
// The two wide-capable tools (rich live figures — mortgage sparkline, month-end
// countdown) claim the wide slots, but ONLY when their store has data: an empty
// store drops the tool to a standard card so the hero row never shows a dead
// half (plan 68 item 3). Standard cards reorder by last-opened recency
// (orderTools); wide cards anchor their row starts. Every card carries the same
// stat anatomy — micro-label + value (+ optional sub) — scaled to its size.

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
      <path d="M3 10.5 12 3l9 7.5" pathLength="1"/>
      <path d="M5.5 9.5V20h13V9.5" pathLength="1"/>
      <path d="M8.5 16.5l2.5-2.5 2 1.5 2.5-3.5" pathLength="1"/>
    </svg>
  ),
}

const MANADSAVSLUT: ToolDef = {
  path: '/manadsavslut',
  name: 'Månadsavslut',
  desc: 'The month-end close — import card statements, split shared spending and settle up who owes whom in one tap.',
  icon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 5.5h16v13H4z" pathLength="1"/>
      <path d="M4 9.5h16" pathLength="1"/>
      <path d="M8 13h5" pathLength="1"/>
      <path d="M16.5 13.5 18 15l2.5-2.5" pathLength="1"/>
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
        <rect x="3" y="6" width="18" height="13" rx="2.5" pathLength="1"/>
        <path d="M3 10h18" pathLength="1"/>
        <path d="M7 15h4" pathLength="1"/>
      </svg>
    ),
  },
  {
    path: '/bostadskalkyl',
    name: 'Bostadskalkyl',
    desc: 'House purchase calculator for Sweden — upfront costs, lagfart & pantbrev, bank comparison, stress tests and saved scenarios.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 10.5 12 3l9 7.5" pathLength="1"/>
        <path d="M5.5 9v11h13V9" pathLength="1"/>
        <path d="M9.5 20v-5.5h5V20" pathLength="1"/>
      </svg>
    ),
  },
  {
    path: '/konsultkalkyl',
    name: 'Konsultkalkyl',
    desc: 'What could it pay to go independent? Turn an hourly rate into salary, dividend and the tax in between — Sweden, 2026.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="7.5" width="18" height="12" rx="2.5" pathLength="1"/>
        <path d="M8.5 7.5V6a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v1.5" pathLength="1"/>
        <path d="M3 12.5h18" pathLength="1"/>
        <path d="M12 11.5v2" pathLength="1"/>
      </svg>
    ),
  },
  {
    path: '/huskalendern',
    name: 'Huskalendern',
    desc: "Husets minne — logga vad som gjorts och håll koll på när avtal och underhåll går ut, som en tidslinje runt idag.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 10.5 12 4l8 6.5" pathLength="1"/>
        <path d="M6 9.5V20h12V9.5" pathLength="1"/>
        <path d="M12 12v3.5" pathLength="1"/>
        <path d="M10 14.5l2 1.5 2-1.5" pathLength="1"/>
      </svg>
    ),
  },
  {
    path: '/lonevaxling',
    name: 'Löneväxling',
    desc: "Salary sacrifice into pension — at what salary it pays off, the tax you save now and what it's worth net at payout. Sweden, 2026.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 9h13l-3.5-3.5" pathLength="1"/>
        <path d="M20 15H7l3.5 3.5" pathLength="1"/>
      </svg>
    ),
  },
]

// Wide-eligible tools, in priority order. A tool takes a wide slot only when its
// live stat has data; otherwise it falls back into the standard pool (plan 68).
const WIDE_CANDIDATES: ToolDef[] = [BOLANEKOLL, MANADSAVSLUT]

interface HubStats {
  mortgage: MortgageStat | null
  monthEnd: MonthEndStat | null
  budget: BudgetStat | null
  house: HouseStat | null
}

// One dismissal of the scroll cue holds for the whole session.
const CUE_KEY = 'hemma-hero-cue-dismissed'

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
  // Scroll cue (plan 31): never mounts for a returning user — back-whoosh
  // arrivals need no invitation, and one dismissal holds for the session.
  const [cueSuppressed] = useState(() => {
    if (viaBack) return true
    try { return sessionStorage.getItem(CUE_KEY) === '1' } catch { return false }
  })
  const [cueDismissed, setCueDismissed] = useState(false)
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
    '/huskalendern': useToolCardActive('/huskalendern'),
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
  // Seed the two WIDE-deciding stats (mortgage, month-end) synchronously from
  // each store's localStorage cache so the bento grid picks its wide/standard
  // layout on the FIRST render. Otherwise the grid mounts all-standard and
  // reflows once the async cloud read lands — the "split-second size decision",
  // and on a back-whoosh the View Transition captures the card at the wrong
  // size/position so the page doesn't zoom into its own slot. Budget stays null
  // (it only feeds a standard card's inner text, not the layout) and fills in
  // with the async read below. Cold cache → nulls, i.e. the genuine empty grid.
  const [stats, setStats] = useState<HubStats>(() => {
    try {
      const m = mortgageStore.cachedSnapshot()
      const me = monthEndStore.cachedSnapshot()
      return {
        mortgage: mortgageStat(m.loan_parts, m.payments, m.valuations),
        monthEnd: monthEndStat(me.items, me.payments, me.settings, new Date()),
        budget: null,
        house: houseStat(houseStore.cachedSnapshot().items, todayISO()),
      }
    } catch {
      return { mortgage: null, monthEnd: null, budget: null, house: null }
    }
  })
  useEffect(() => {
    useStore.getState().hydrate()
    let alive = true
    Promise.all([
      loadBudget(),
      mortgageStore.listLoanParts(),
      mortgageStore.listPayments(),
      mortgageStore.listValuations(),
      monthEndStore.listItems(),
      monthEndStore.listPayments(),
      monthEndStore.getSettings(),
      houseStore.listItems(),
    ]).then(([budget, parts, mortgagePays, valuations, items, monthEndPays, maSettings, houseItems]) => {
      if (!alive) return
      setStats({
        mortgage: mortgageStat(parts, mortgagePays, valuations),
        monthEnd: monthEndStat(items, monthEndPays, maSettings, new Date()),
        budget: budgetStat(budget),
        house: houseStat(houseItems, todayISO()),
      })
    })
    return () => { alive = false }
  }, [])

  // Styrränta live stat (plan 70) — best-effort, only fetched once the
  // Bolånekoll tile actually claims a wide slot; the sessionStorage cache in
  // fetchPolicyRate means this doesn't duplicate Bolånekoll's own fetch.
  const [policyRate, setPolicyRate] = useState<PolicyRateData | null>(null)
  useEffect(() => {
    if (!stats.mortgage) return
    let alive = true
    fetchPolicyRate().then((d) => { if (alive) setPolicyRate(d) }).catch(() => {})
    return () => { alive = false }
  }, [stats.mortgage])

  // Bostadskalkyl's scenarios live in the reactive store (hydrated above).
  const scenarios = useStore((s) => s.scenarios)
  const globalConstants = useStore((s) => s.globalConstants)
  const scStat = useMemo(() => scenarioStat(scenarios, globalConstants), [scenarios, globalConstants])

  // Standard cards sort by last-opened recency, frozen once per mount so the
  // grid never reshuffles under the pointer. Wide slots follow DATA, not names:
  // a wide-candidate with no live stat drops into the standard pool and the grid
  // rebalances — no giant half-empty hero card (plan 68). The stores hydrate
  // once at mount, so the layout settles a single time and then holds.
  const [lastOpened] = useState(() =>
    readLastOpened([...WIDE_CANDIDATES, ...STANDARD_TOOLS].map((t) => t.path)),
  )
  const grid: Array<{ tool: ToolDef; wide: boolean }> = useMemo(() => {
    const hasWide = (path: string) =>
      (path === '/bolanekoll' && !!stats.mortgage) ||
      (path === '/manadsavslut' && !!stats.monthEnd)
    const wide = WIDE_CANDIDATES.filter((t) => hasWide(t.path))
    const pool = orderTools(
      [...WIDE_CANDIDATES.filter((t) => !hasWide(t.path)), ...STANDARD_TOOLS],
      lastOpened,
    )
    // Each wide anchors a row: [wide, std, std] fills all four columns; leftover
    // standards flow after. 2 wide → the plan-30 two-shelf bento; 1 or 0 wide →
    // a naturally ragged tail rather than a dead half-card.
    const cells: Array<{ tool: ToolDef; wide: boolean }> = []
    let si = 0
    for (const w of wide) {
      cells.push({ tool: w, wide: true })
      if (si < pool.length) cells.push({ tool: pool[si++], wide: false })
      if (si < pool.length) cells.push({ tool: pool[si++], wide: false })
    }
    while (si < pool.length) cells.push({ tool: pool[si++], wide: false })
    return cells
  }, [stats, lastOpened])

  useEffect(() => {
    function render() {
      const now = new Date()
      // Shared bucket (lib/heroScene) — the WebGL scene lights itself from the
      // same function, so greeting text and terrain light can never disagree.
      const g = greetingFor(timeBucket(now.getHours()))
      setGreeting(g)
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

  // Dismiss the cue the first time the page actually scrolls; the listener
  // unbinds after firing once (cueDismissed flips → effect cleanup runs).
  useEffect(() => {
    if (cueSuppressed || cueDismissed) return
    const onScroll = () => {
      if (window.scrollY > 40) {
        setCueDismissed(true)
        try { sessionStorage.setItem(CUE_KEY, '1') } catch { /* private mode */ }
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [cueSuppressed, cueDismissed])

  // Clicking the cue smooth-scrolls to Tools — the plan-28b scroll dolly turns
  // this into the camera descent. Reduced motion: instant jump, still dismissed
  // (the scroll listener also fires, but set state directly so a sub-40px page
  // can't strand a visible cue).
  const onCueClick = () => {
    document.getElementById('tools')?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    setCueDismissed(true)
    try { sessionStorage.setItem(CUE_KEY, '1') } catch { /* private mode */ }
  }

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
          {policyRate && (
            <span className="stat-sub">
              Styrränta <Percent value={currentPoint(policyRate).value} decimals={2} space locale="sv-SE" />
              {(() => { const next = nextDecision(todayISO()); return next ? <> · nästa besked {fmtShortDate(next)}</> : null })()}
            </span>
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

  // The stat block on a STANDARD card — the same label + value anatomy as the
  // wide cards, scaled down and sitting ABOVE the footer (never inline with the
  // "Open →" cta). Returns null when the store has no real content, so the card
  // keeps its description prose (plan 68 item 1).
  function standardStatFor(path: string): ReactNode {
    if (path === '/hushallsbudget' && stats.budget) {
      const b = stats.budget
      return (
        <div className="card-stat">
          <span className="stat-label">{b.equal ? 'Kvar var' : 'Kvar'}</span>
          <span className="stat-value">
            {b.equal
              ? <Money value={b.a} signed />
              : <><MoneyCompact value={b.a} signed /> · <MoneyCompact value={b.b} signed /></>}
          </span>
        </div>
      )
    }
    if (path === '/huskalendern' && stats.house) {
      const h = stats.house
      if (h.attention > 0) {
        return (
          <div className="card-stat">
            <span className="stat-label">Behöver ses över</span>
            <span className="stat-value"><Num value={h.attention} /> {h.attention === 1 ? 'sak' : 'saker'}</span>
          </div>
        )
      }
      return (
        <div className="card-stat">
          <span className="stat-label">Nästa</span>
          <span className="stat-value">
            {h.next
              ? <>{h.next.title}{h.next.days === 0 ? ' · idag' : <> · om <Num value={h.next.days} /> {h.next.days === 1 ? 'dag' : 'dagar'}</>}</>
              : 'Inget planerat'}
          </span>
        </div>
      )
    }
    if (path === '/bostadskalkyl' && scStat) {
      return scStat.monthly != null ? (
        <div className="card-stat">
          <span className="stat-label">Månadskostnad</span>
          <span className="stat-value"><Money value={scStat.monthly} suffix="/mån" /></span>
        </div>
      ) : (
        <div className="card-stat">
          <span className="stat-label">Sparade scenarier</span>
          <span className="stat-value"><Num value={scStat.count} /></span>
        </div>
      )
    }
    return null
  }

  function renderCard({ tool, wide }: { tool: ToolDef; wide: boolean }, i: number) {
    const stat = wide ? wideStatFor(tool.path) : standardStatFor(tool.path)
    const cls =
      'app-card reveal reveal-' + (4 + i) +
      (wide ? ' wide' : '') +
      (stat ? ' has-stat' : '') +
      (active[tool.path] ? ' vt-card' : '')
    const inner = (
      <>
        <div className="app-card-head">
          <span className="app-icon">{tool.icon}</span>
        </div>
        <span className="app-name">{tool.name}</span>
        <span className="app-desc">{tool.desc}</span>
        {!wide && stat}
        <span className="app-foot">
          <span className="app-cta">Open <span className="arrow">→</span></span>
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
        <HouseholdMenu />
        <button
          className="theme-toggle-btn"
          title="Toggle dark mode"
          aria-label="Toggle dark mode"
          onClick={toggleTheme}
        >
          <Icon icon={theme === 'dark' ? Moon : Sun} size={18} />
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
            <span>{greeting}</span> <span className="date">— {dateLine}</span>
          </p>
          <h1 className="hero-h1">
            <span className="h1-line">Everything for the</span>
            <span className="h1-line">household, <em>in one</em></span>
            <span className="h1-line"><em className="h1-place">place.</em></span>
          </h1>
          <p className="sub reveal reveal-3">
            The family operating system — calculators, plans and shared tools that grow with us.
            Synced across the household.
          </p>
          {!cueSuppressed && (
            <button
              type="button"
              className={'hero-cue reveal reveal-3' + (cueDismissed ? ' is-dismissed' : '')}
              onClick={onCueClick}
            >
              Verktyg
              <svg className="hero-cue-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 9.5l6 6 6-6"/>
              </svg>
            </button>
          )}
        </section>
      </HeroCanvas>

      <main className="apps" id="tools">
        <p className="apps-label reveal reveal-3">Tools</p>
        <div className="app-grid">
          {grid.map((entry, i) => renderCard(entry, i))}
        </div>
      </main>

      <footer className="site-footer">
        <span className="footer-badge"><span className="pulse" />Local-first · Synced via Supabase</span>
        <span className="footer-soon">Kommer snart: Kalender · Matplan</span>
        <span>Hemma·OS · built by the Vardon family</span>
      </footer>
    </div>
    </>
  )
}
