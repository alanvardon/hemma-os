import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ChevronRight, Copy, EllipsisVertical, Pencil, Settings2, X } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import EquityStackChart, { type EquityPoint } from '../components/charts/EquityStackChart'
import RiksbankChart from '../components/charts/RiksbankChart'
import Collapse from '../components/Collapse'
import FileDropzone from '../components/FileDropzone'
import Icon from '../components/Icon'
import PageHeader from '../components/PageHeader'
import ThemeToggle from '../components/ThemeToggle'
import Segmented from '../components/Segmented'
import { usePersonNames } from '../components/usePersonNames'
import { useSaveFlash } from '../components/useSaveFlash'
import { useToast } from '../components/useToast'
import { persistenceErrorMessage } from '../lib/persistence-error'
import { useToolPageActive } from '../lib/toolTransition'
import {
  parseCsv, parseAmount, autoMapColumns, classifyKind,
  makePayment, flagDuplicates, assignPaymentsToPart,
  partBalance, totalBalance, totalAmortized, totalInterest, ranteavdrag, resolvePartBalance,
  propertyValue, equity, loanToValue,
  purchasePrice, costBasisEquity, costBasisOwnedPct, costBasisSplit, derivedDeposit,
  effectiveRatePeriod, groupLoanParts, weightedAvgRate, amorteringskravStatus,
  equityTimeline, equityBridge, projectMilestones, monthlyAmortizationRate, monthlyCost, rateWhatIf,
  expectedCharges, forecastInterest, reconcileCharge, matchPredictedRows, hasChargeInMonth, pendingChargeSeries, monthKey, stalePredictedRows,
  paymentsToCsv, headerSignature, mappingToNames, applyPreset, reconcileBalance,
  todayISO,
  bankForPart, suggestBankProfile, bankProfileDrift,
} from '../lib/mortgage'
import type { LoanPart, LoanPartGroup, RatePeriod, Payment, Valuation, Contribution, MortgageSettings, CsvResult, ColMapping, Owner, ExpectedCharge, Bank, Mortgage } from '../lib/mortgage'
import {
  fetchPolicyRate, nextDecision, lastDecision, decisionOutcome,
  detectChange, currentPoint, readAcknowledged, acknowledge, readSessionHidden, hideForSession,
  type PolicyRateData, type Acknowledged,
} from '../lib/riksbank'
import { daysUntil } from '../lib/date'
import * as Store from '../lib/mortgage-store'
import { loadBudget } from '../lib/hushallsbudget-store'
import { computeBudget } from '../lib/hushallsbudget'
import PartDialog from './bolanekoll/PartDialog'
import ValuationDialog from './bolanekoll/ValuationDialog'
import PaymentDialog from './bolanekoll/PaymentDialog'
import CopyToPartsDialog from './bolanekoll/CopyToPartsDialog'
import SettingsDialog from './bolanekoll/SettingsDialog'
import { CellReveal, kindLabel, PAY_PAGE, periodFrom, monthsToWhen, fmtMoney, fmtPct, M, P, currencyState, type TriageRow, type ImportCfg } from './bolanekoll/shared'

// The hero reprice notice appears only inside the final month before the
// villkorsändring — before that, the date lives in the Lånedelar ledger.
const REPRICE_NOTICE_DAYS = 31

// The kinds an expected-charge line item can log as: the ränta plus its
// companion — the bank's betalning (total debit) or a legacy amortering row.
type PendingKind = 'interest' | 'payment' | 'amortization'

/** "17 jun", or "1 okt 2025" when the date isn't in the current year — a bare
 * day+month for a past year reads as upcoming. Strips the trailing period
 * sv-SE puts on most abbreviated months ("1 okt.") so callers can add their
 * own sentence-final punctuation without doubling it. */
function fmtRateDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric'
  return d.toLocaleDateString('sv-SE', opts).replace(/\.( \d{4})?$/, '$1')
}

/** Month-and-year label for a not-yet-logged expected charge — the bank sets
 * the exact billing date, so a specific day would be false precision, but the
 * month alone is ambiguous across years. "sep 2026". Once the row is logged,
 * the ledger shows it with a concrete date. */
function fmtChargeMonth(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  return d
    .toLocaleDateString('sv-SE', { month: 'short', year: 'numeric' })
    .replace(/\./g, '')
}

// The change banner is a nudge about NEWS — after this many days the new rate
// is just "the rate" and the banner stays quiet even if never dismissed
// (a first visit shouldn't announce a nine-month-old cut).
const RATE_CHANGE_NEWS_DAYS = 60

// ── Main component ─────────────────────────────────────────────────────────

export default function Bolanekoll() {
  const active = useToolPageActive('/bolanekoll')
  useLayoutEffect(() => { document.documentElement.classList.remove('calc-layout') }, [])

  // Seed initial state synchronously from the store's localStorage cache so a
  // returning user sees their populated dashboard on the FIRST paint instead of
  // the empty-hero flashing for a frame before the async cloud read lands. The
  // snapshot is sorted to match what refresh() will return, so nothing reorders.
  // Cold cache → empty arrays (a genuine first-time user), and the `loaded` flag
  // below holds back the empty-hero until we actually know it's empty.
  const [seed] = useState(Store.cachedSnapshot)
  const [banks, setBanks] = useState<Bank[]>(seed.banks)
  const [mortgages, setMortgages] = useState<Mortgage[]>(seed.mortgages)
  const [parts, setParts] = useState<LoanPart[]>(seed.loan_parts)
  const [payments, setPayments] = useState<Payment[]>(seed.payments)
  const [valuations, setValuations] = useState<Valuation[]>(seed.valuations)
  const [periods, setPeriods] = useState<RatePeriod[]>(seed.rate_periods)
  const [contributions, setContributions] = useState<Contribution[]>(seed.contributions)
  const [settings, setSettings] = useState<MortgageSettings>(seed.settings)
  // False until the first cloud refresh resolves — distinguishes "still loading"
  // from "loaded and genuinely empty" so the empty-hero only shows for the latter.
  const [loaded, setLoaded] = useState(false)

  const { toast, showToast } = useToast()
  const { saveVisible: saved, flashSaved } = useSaveFlash()
  // mortgage-store.ts throws on write errors so the UI can react — every
  // mutation below must catch and surface it, or a failed save looks
  // successful (optimistic cache) until the next cloud read silently drops it.
  function saveErr(err: unknown) {
    showToast(persistenceErrorMessage(err))
  }
  const [bridgePeriod, setBridgePeriod] = useState<'ytd' | '12m' | 'all'>('ytd')
  const [extraAmort, setExtraAmort] = useState('')
  // Rate what-if: null means "untouched" (field shows the live blended prefill).
  const [whatIfRate, setWhatIfRate] = useState<string | null>(null)
  // Whole-household shared costs (joint costs only) pulled from Hushållsbudget,
  // for the rate what-if's "total per month" chips. null until loaded / no budget.
  const [householdCosts, setHouseholdCosts] = useState<number | null>(null)
  const [paymentFilter, setPaymentFilter] = useState('all')
  const [payVisible, setPayVisible] = useState(PAY_PAGE)
  const [isDragging, setIsDragging] = useState(false)
  const [importCfg, setImportCfg] = useState<ImportCfg | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [partDlg, setPartDlg] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  const [valDlg, setValDlg] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  const [payDlg, setPayDlg] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  const [copyDlg, setCopyDlg] = useState<{ open: boolean; source: Payment | null }>({ open: false, source: null })
  const [expandedPays, setExpandedPays] = useState<Set<string>>(new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const groupsSeeded = useRef(false)
  const [avslutadeOpen, setAvslutadeOpen] = useState(false)
  const reduceMotion = useReducedMotion()
  const [settingsDlg, setSettingsDlg] = useState(false)

  // ── Riksbank policy-rate watcher (plan 70) ──────────────────────────────
  // Best-effort only: the fetch never blocks the calculator, and a failure
  // just quietly drops the strip/banner/chart rather than surfacing an error.
  const [policyRate, setPolicyRate] = useState<PolicyRateData | null>(null)
  const [rateFailed, setRateFailed] = useState(false)
  const [rateAck, setRateAck] = useState<Acknowledged | null>(() => readAcknowledged())
  const [rateHidden, setRateHidden] = useState<Acknowledged | null>(() => readSessionHidden())
  const [rateRange, setRateRange] = useState<'5y' | 'all'>('5y')
  useEffect(() => {
    let cancelled = false
    fetchPolicyRate().then((d) => { if (!cancelled) setPolicyRate(d) }).catch(() => { if (!cancelled) setRateFailed(true) })
    return () => { cancelled = true }
  }, [])
  const rateNow = useMemo(() => policyRate ? currentPoint(policyRate) : null, [policyRate])
  // Two dismissal depths (deliberately asymmetric): the easy-to-fat-finger ×
  // only hides for this session; the read-and-aim "visa inte igen" link is the
  // permanent ack. An accidental × costs one visit, never the news window.
  const hideRateChangeForNow = useCallback(() => {
    if (!rateNow) return
    hideForSession(rateNow)
    setRateHidden({ date: rateNow.date, value: rateNow.value })
  }, [rateNow])
  const dismissRateChange = useCallback(() => {
    if (!rateNow) return
    acknowledge(rateNow)
    setRateAck({ date: rateNow.date, value: rateNow.value })
  }, [rateNow])

  currencyState.current = settings.currency || 'SEK'

  const refresh = useCallback(async () => {
    const [ps, pays, vals, pers, contribs, sett, bnks, morts] = await Promise.all([
      Store.listLoanParts(), Store.listPayments(), Store.listValuations(),
      Store.listRatePeriods(), Store.listContributions(), Store.getSettings(),
      Store.listBanks(), Store.listMortgages(),
    ])
    setParts(ps); setPayments(pays); setValuations(vals); setPeriods(pers); setContributions(contribs); setSettings(sett)
    setBanks(bnks); setMortgages(morts)
    setLoaded(true)
  }, [])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { document.title = (settings.property_name || 'Bolånekoll') + ' · Hemma·OS' }, [settings.property_name])
  // Pull the household's shared-cost total from Hushållsbudget once, for the
  // rate what-if's "total per month" chips. Read-only: never writes the budget.
  useEffect(() => { let live = true; loadBudget().then(b => { if (live && b) setHouseholdCosts(computeBudget(b).costsJoint) }); return () => { live = false } }, [])
  // Collapse the ledger back to the first page whenever the part filter changes.
  useEffect(() => { setPayVisible(PAY_PAGE) }, [paymentFilter])

  const { nameOf } = usePersonNames(settings.owner_a_name, settings.owner_b_name)

  // ── Derived data ───────────────────────────────────────────────────────────
  const today = todayISO()
  const balance = useMemo(() => totalBalance(parts, payments), [parts, payments])
  // The balance resolver is also the provenance source for the dashboard: a
  // provisional Betalning must never look like an observed Saldo result.
  const balanceResolutions = useMemo(
    () => new Map(parts.filter(p => !p.archived).map(p => [p.id, resolvePartBalance(p, payments)])),
    [parts, payments],
  )
  const estimatedPartIds = useMemo(
    () => new Set([...balanceResolutions.entries()]
      .filter(([, result]) => result.warnings.includes('missing-interest'))
      .map(([id]) => id)),
    [balanceResolutions],
  )
  const estimatedPaymentIds = useMemo(() => new Set(payments
    .filter(p => p.kind === 'payment' && p.loan_part_id && estimatedPartIds.has(p.loan_part_id))
    .filter(p => {
      const resolution = balanceResolutions.get(p.loan_part_id!)
      if (!resolution || p.date <= resolution.anchor.date) return false
      const hasInterest = payments.some(other => other.loan_part_id === p.loan_part_id
        && other.kind === 'interest' && other.date?.slice(0, 7) === p.date?.slice(0, 7))
      return !hasInterest
    })
    .map(p => p.id)), [payments, estimatedPartIds, balanceResolutions])
  const value = useMemo(() => propertyValue(valuations), [valuations])
  const eq = useMemo(() => equity(value, balance), [value, balance])
  const ltv = useMemo(() => loanToValue(balance, value), [balance, value])
  const amortized = useMemo(() => totalAmortized(parts, payments), [parts, payments])
  const interest = useMemo(() => totalInterest(payments), [payments])
  const deduction = useMemo(() => ranteavdrag(interest), [interest])
  const hasValuation = valuations.length > 0

  // Cost-basis equity: valuation-independent, anchored on the flagged köpeskilling.
  const price = useMemo(() => purchasePrice(valuations), [valuations])
  const hasPurchase = price > 0
  const costBasisEq = useMemo(() => costBasisEquity(price, balance), [price, balance])
  const ownedPct = useMemo(() => costBasisOwnedPct(price, balance), [price, balance])
  const cbSplit = useMemo(() => costBasisSplit(price, balance, payments, contributions, settings), [price, balance, payments, contributions, settings])
  const deposit = useMemo(() => derivedDeposit(price, parts, payments), [price, parts, payments])
  const downPayments = useMemo(() => payments.filter(p => p.kind === 'down_payment'), [payments])
  const extraAmortizationPayments = useMemo(
    () => payments.filter(p => p.kind === 'amortization' && p.is_insats),
    [payments],
  )
  const timeline = useMemo(() => equityTimeline(parts, payments, valuations, settings), [parts, payments, valuations, settings])

  const loanGroups = useMemo(() => groupLoanParts(parts, periods, payments, today), [parts, periods, payments, today])
  // Next villkorsändring for the hero note: the soonest dated group. loanGroups
  // is already ordered expired-first then by ascending end_date, so the first
  // dated group IS the next (or most-overdue) reprice — and it carries what the
  // bare date can't: how much of the loan moves, and off which rate.
  const nextReprice = useMemo(() => loanGroups.find(g => !g.is_catchall && g.days_left != null) ?? null, [loanGroups])
  const archivedParts = useMemo(() => parts.filter(p => p.archived), [parts])

  // Plan 103 — the active mortgage the UI surfaces (the model supports many; we
  // show one). First non-archived, else the first. Legacy data with no mortgage
  // → null, and the Lånedelar list renders flat, exactly as before.
  const activeMortgage = useMemo<Mortgage | null>(() => mortgages.find(m => m && !m.archived) ?? mortgages[0] ?? null, [mortgages])
  const activeBank = useMemo<Bank | null>(() => activeMortgage?.bank_id ? (banks.find(b => b.id === activeMortgage.bank_id) ?? null) : null, [activeMortgage, banks])

  const nextBesked = useMemo(() => nextDecision(today), [today])
  const nextBeskedDays = useMemo(() => nextBesked ? daysUntil(nextBesked, today) : null, [nextBesked, today])
  const rateChangeAge = rateNow ? daysUntil(today, rateNow.date) : null
  const showRateChangeBanner =
    detectChange(rateNow, rateAck) && detectChange(rateNow, rateHidden) &&
    rateChangeAge != null && rateChangeAge <= RATE_CHANGE_NEWS_DAYS

  // Senaste besked — the most recent announcement and what it did. Most
  // beskeds are holds, so this is the cell that says "they met in June and
  // did nothing", which the change-based "sedan {date}" can't express.
  const lastBesked = useMemo(() => lastDecision(today), [today])
  const lastBeskedOutcome = useMemo(() => {
    if (!lastBesked || !policyRate) return null
    const point = decisionOutcome(lastBesked, policyRate.changes)
    if (!point) return 'oförändrad'
    const idx = policyRate.changes.findIndex((c) => c.date === point.date)
    const prev = policyRate.changes[idx - 1]
    const verb = !prev ? 'ändrade till' : point.value < prev.value ? 'sänkte till' : 'höjde till'
    return verb + ' ' + fmtPct(point.value)
  }, [lastBesked, policyRate])

  useEffect(() => {
    if (groupsSeeded.current || !loanGroups.length) return
    groupsSeeded.current = true
    setExpandedGroups(new Set(loanGroups.filter(g => g.is_catchall || g.expired).map(g => g.key)))
  }, [loanGroups])

  function toggleGroup(key: string) {
    setExpandedGroups(prev => { const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s })
  }
  function repriceLabel(days: number | null, expired: boolean): string {
    if (days == null) return ''
    if (expired) return Math.abs(days) + ' d overdue'
    if (days <= 60) return 'in ' + days + ' d'
    return 'in ' + Math.round(days / 30.44) + ' mo'
  }
  const repriceMeta = (g: LoanPartGroup) => (
    <span className="ld-meta">
      <span className="ld-date">{g.end_date}</span>
      {g.days_left != null && <span className={'ld-countdown' + (g.expired ? ' is-expired' : '')}>{repriceLabel(g.days_left, g.expired)}</span>}
    </span>
  )
  // Rate pill.
  const rateBadge = (rate: number | null, type: 'rörlig' | 'bunden' | null) =>
    rate == null ? null : (
      <span className={'ld-rate' + (type === 'bunden' ? ' is-bunden' : '')}>
        {fmtPct(rate)}{type ? ' · ' + (type === 'bunden' ? 'bunden' : 'rörlig') : ''}
      </span>
    )
  const partActs = (p: LoanPart) => (
    <>
      <button type="button" className="icon-btn" title="Edit" aria-label="Edit" onClick={() => setPartDlg({ open: true, id: p.id })}><Icon icon={Pencil} /></button>
      <button type="button" className="icon-btn" data-del-part title="Ta bort" aria-label="Ta bort" onClick={() => { if (confirm('Ta bort lånedelen och alla dess betalningar och ränteperioder? Det går inte att ångra.')) handleDeletePart(p.id) }}><Icon icon={X} /></button>
    </>
  )

  const bridgeFrom = useMemo(() => {
    const from = periodFrom(bridgePeriod)
    if (from != null) return from
    const dates: string[] = []
    valuations.forEach(v => { if (v.date) dates.push(String(v.date)) })
    payments.forEach(p => { if (p.date) dates.push(String(p.date)) })
    dates.sort()
    return dates.length ? dates[0] : today
  }, [bridgePeriod, valuations, payments, today])
  const bridge = useMemo(() => equityBridge(parts, payments, valuations, bridgeFrom, today), [parts, payments, valuations, bridgeFrom, today])

  const costRows = useMemo(() => monthlyCost(payments, { ranteavdrag: settings.ranteavdrag }), [payments, settings.ranteavdrag])
  const blended = useMemo(() => weightedAvgRate(parts, periods, payments), [parts, periods, payments])
  const krav = useMemo(() => amorteringskravStatus(parts, payments, valuations, settings), [parts, payments, valuations, settings])

  const extra = Math.max(0, parseAmount(extraAmort) || 0)
  const base = useMemo(() => monthlyAmortizationRate(parts, payments), [parts, payments])
  const ms = useMemo(() => projectMilestones(parts, payments, valuations, settings, { extraMonthly: extra }), [parts, payments, valuations, settings, extra])
  // Rate what-if — derive the hypothetical rate rather than seeding via effect, so
  // the prefill tracks the async-loaded blended rate. Takes `base` (observed
  // amortization), NOT `extra`: the rate comparison ignores the extra-amortering
  // input (plan 82, decision 7).
  const hypRate = whatIfRate == null ? blended : (() => { const n = parseAmount(whatIfRate); return isFinite(n) && n >= 0 ? n : 0 })()
  // Amortering in the what-if = observed monthly amortering + whatever's typed in
  // "Extra amortering", so nu/vid read as the full monthly payment (interest +
  // amortering), not interest alone.
  const whatIf = useMemo(() => rateWhatIf(balance, blended, hypRate, base + extra, householdCosts ?? 0), [balance, blended, hypRate, base, extra, householdCosts])

  // Expected next charge (plan 23): arithmetic from stored data — balance ×
  // rate × days/365 — calibrated against the real charge history. Read-only
  // here; writes happen only via the explicit log button / import supersede.
  // Plan 104 — thread the bank entities (and the full part list) into the
  // forecast so a declared lock overrides detection AND the year-basis learner
  // can pool evidence across all of a bank's parts (phase 2).
  const forecastOpts = useMemo(() => ({ banks, mortgages, parts }), [banks, mortgages, parts])
  const prognos = useMemo(() => expectedCharges(parts, periods, payments, forecastOpts), [parts, periods, payments, forecastOpts])
  // Plan 104 (phase 2) — the parts on the active bank, the learner's suggestion
  // for them, and any drift between a declared lock and the fresh evidence.
  const activeBankParts = useMemo(
    () => activeBank ? parts.filter(p => bankForPart(p, mortgages, banks)?.id === activeBank.id) : [],
    [activeBank, parts, mortgages, banks])
  const bankSuggestion = useMemo(
    () => activeBank ? suggestBankProfile(activeBankParts, periods, payments) : null,
    [activeBank, activeBankParts, periods, payments])
  const bankDrift = useMemo(
    () => bankProfileDrift(activeBank, activeBankParts, periods, payments),
    [activeBank, activeBankParts, periods, payments])
  const forecast = useMemo(() => forecastInterest(parts, periods, payments), [parts, periods, payments])
  // The next UNCOVERED charge per part: once a month is fully logged (or
  // imported), the Nästa avisering block rolls forward to the following month
  // rather than going quiet — there is always a next avisering to look at.
  const pendingSeries = useMemo(
    () => parts.filter(p => !p.archived)
      .map(p => pendingChargeSeries(p, periods, payments, 12, forecastOpts))
      .filter(s => s.length > 0 && s[0].interest > 0),
    [parts, periods, payments, forecastOpts])
  const pendingCharges = useMemo(() => pendingSeries.map(s => s[0]), [pendingSeries])
  // Flattened to ONE entry per upcoming transaction, mirroring the bank's avi:
  // per part a Ränta row and — when the ledger has betalning history — the
  // bank's Betalning row (the TOTAL debit, ränta + amortering; equal to the
  // ränta on an interest-only part). Ledgers without betalning rows keep the
  // legacy separate amortering line. Each line is individually loggable and
  // individually guarded.
  const chargeEntries = (r: ExpectedCharge): Array<{ charge: ExpectedCharge; kind: PendingKind; amount: number }> => {
    const out: Array<{ charge: ExpectedCharge; kind: PendingKind; amount: number }> = []
    if (r.interest > 0) out.push({ charge: r, kind: 'interest', amount: r.interest })
    if (r.betalning != null) {
      if (r.betalning > 0) out.push({ charge: r, kind: 'payment', amount: r.betalning })
    } else if (r.amortization > 0) out.push({ charge: r, kind: 'amortization', amount: r.amortization })
    return out
  }
  const pendingEntries = useMemo(() => pendingCharges.flatMap(r =>
    chargeEntries(r).filter(e => !hasChargeInMonth(payments, r.loan_part_id, r.next_date, e.kind))),
  [pendingCharges, payments])  // eslint-disable-line react-hooks/exhaustive-deps -- chargeEntries is pure
  // The months AFTER the loggable one — a read-only preview of the coming
  // year's avier (rate held flat, balance stepping down each period).
  const futureEntries = useMemo(() => pendingSeries.flatMap(s => s.slice(1))
    .flatMap(chargeEntries)
    .sort((a, b) => a.charge.next_date.localeCompare(b.charge.next_date)
      || a.charge.loan_part_id.localeCompare(b.charge.loan_part_id)
      || (a.kind === b.kind ? 0 : a.kind === 'interest' ? -1 : 1)),
  [pendingSeries])  // eslint-disable-line react-hooks/exhaustive-deps -- chargeEntries is pure
  const [showFuture, setShowFuture] = useState(false)
  // Loan-part filter for the expected-charge block — only the parts that
  // actually have an upcoming charge appear as options (a part with nothing
  // pending would filter to an empty list).
  const [prognosFilter, setPrognosFilter] = useState<string>('all')
  const prognosParts = useMemo(() => {
    const ids = new Set(pendingSeries.map(s => s[0].loan_part_id))
    return parts.filter(p => ids.has(p.id))
  }, [pendingSeries, parts])
  // A part can drop out once its charge is logged — fall back to All so the
  // toggle never points at a part that has vanished from the options.
  const effPrognosFilter = prognosParts.some(p => p.id === prognosFilter) ? prognosFilter : 'all'
  const shownPending = useMemo(
    () => effPrognosFilter === 'all' ? pendingEntries : pendingEntries.filter(e => e.charge.loan_part_id === effPrognosFilter),
    [pendingEntries, effPrognosFilter])
  const shownFuture = useMemo(
    () => effPrognosFilter === 'all' ? futureEntries : futureEntries.filter(e => e.charge.loan_part_id === effPrognosFilter),
    [futureEntries, effPrognosFilter])
  // The headline figure comes from the underlying charges, not the loggable
  // entries — betalning already CONTAINS the ränta, so summing the visible
  // rows would double-count it (and partial logging would wobble the total).
  const shownCharges = useMemo(
    () => effPrognosFilter === 'all' ? pendingCharges : pendingCharges.filter(r => r.loan_part_id === effPrognosFilter),
    [pendingCharges, effPrognosFilter])

  // Förväntade rows logged with an OLDER model keep their logged amounts —
  // nothing rewrites ledger rows on visit. Surface the drift with an explicit
  // one-click refresh instead (each entry carries the corrected values).
  const staleRows = useMemo(() => stalePredictedRows(parts, periods, payments), [parts, periods, payments])

  const reconcile = useMemo(() => reconcileBalance(parts, payments).filter(r => {
    if (r.drift == null || r.start_balance == null) return false
    return Math.abs(r.drift) >= Math.max(r.start_balance * 0.01, 5000)
  }), [parts, payments])

  const insightsReady = parts.length > 0 && valuations.length > 0 && payments.length > 0

  // ── Chart data (stacked area: my equity → partner → bank) ────────────────────
  // Resolve the timeline into display-ordered bands; negatives clip to 0 so the
  // stack never inverts (matches the old Chart.js Math.max(0, …)).
  const me: Owner = settings.i_am === 'b' ? 'b' : 'a'
  const other: Owner = me === 'a' ? 'b' : 'a'
  const chartData = useMemo<EquityPoint[]>(
    () => timeline.map(r => ({
      label: r.label,
      mine: Math.max(0, me === 'a' ? r.a_equity : r.b_equity),
      partner: Math.max(0, me === 'a' ? r.b_equity : r.a_equity),
      bank: Math.max(0, r.bank),
    })),
    [timeline, me],
  )

  // ── Import ───────────────────────────────────────────────────────────────
  function buildTriage(parsed: CsvResult, mapping: ColMapping, importPart: string): TriageRow[] {
    const auto = importPart === '__auto__' && mapping.loan_number != null
    const fallback = auto ? (parts[0]?.id || null) : (importPart || null)
    const loanNumbers = parsed.rows.map(r => mapping.loan_number == null ? null : (r[mapping.loan_number] ?? ''))
    const assigns = assignPaymentsToPart(loanNumbers, parts, { selectedPartId: fallback, auto })
    const candidates = parsed.rows.map((row, i) => {
      const specText = (mapping.specification != null ? row[mapping.specification] : '')?.trim() || ''
      const date = (mapping.date != null ? row[mapping.date] : '')?.trim() || ''
      const amt = mapping.amount == null ? NaN : parseAmount(row[mapping.amount])
      const bal = mapping.balance == null ? NaN : parseAmount(row[mapping.balance])
      const amount = isFinite(amt) ? Math.abs(amt) : 0
      const balance_after = isFinite(bal) ? Math.abs(bal) : null
      const hasAmount = amount > 0 || balance_after != null
      const a = assigns[i]
      return { specText, date, kind: classifyKind(specText), amount, balance_after, hasAmount, loan_part_id: a?.loan_part_id ?? null, partMatched: a?.matched ?? false }
    })
    const dupInput = candidates.map(c => ({ date: '', loan_part_id: c.loan_part_id, kind: c.kind, amount: c.amount }))
    const dups = flagDuplicates(payments, dupInput)
    // Reconcile incoming interest rows against the forecast (plan 23): a row
    // that pairs with a logged predicted row gets the supersede badge; without
    // one, an interest row landing in the expected month still gets a
    // read-only ✓ matched / ⚠ drift check against expectedCharge.
    const predMatches = new Map(matchPredictedRows(payments,
      candidates.map(c => ({ loan_part_id: c.loan_part_id, date: c.date, kind: c.kind, amount: c.amount })),
    ).map(m => [m.draftIndex, m]))
    const expByPart = new Map(prognos.rows.map(r => [r.loan_part_id, r]))
    return candidates.map((c, i) => {
      let recon: TriageRow['recon'] = null
      const pm = predMatches.get(i)
      const exp = c.loan_part_id ? expByPart.get(c.loan_part_id) : undefined
      if (pm) recon = { drift: pm.recon.drift, ok: pm.recon.ok, predicted: true }
      else if (c.kind === 'interest' && c.amount > 0 && exp && exp.interest > 0 && monthKey(c.date) === monthKey(exp.next_date)) {
        const r = reconcileCharge(exp, c.amount)
        recon = { drift: r.drift, ok: r.ok, predicted: false }
      } else if (c.kind === 'payment' && c.amount > 0 && exp?.betalning != null && exp.betalning > 0 && monthKey(c.date) === monthKey(exp.next_date)) {
        // The bank's betalning row (total debit) checks against the predicted
        // betalning the same way the ränta row checks against the interest.
        const r = reconcileCharge(exp.betalning, c.amount)
        recon = { drift: r.drift, ok: r.ok, predicted: false }
      }
      return { ...c, recon, duplicate: !!dups[i], classification: (dups[i] || !c.hasAmount ? 'skip' : 'include') as 'include' | 'skip' }
    })
  }
  async function loadFile(file: File): Promise<ImportCfg> {
    const text = await file.text()
    const parsed = parseCsv(text)
    let mapping = autoMapColumns(parsed.headers)
    const sig = headerSignature(parsed.headers)
    if (settings.import_presets[sig]) mapping = applyPreset(parsed.headers, settings.import_presets[sig])
    const importPart = mapping.loan_number != null ? '__auto__' : (parts[0]?.id || '')
    return { file, parsed, mapping, importPart, triage: buildTriage(parsed, mapping, importPart), queue: [], qIdx: 0 }
  }
  async function handleFiles(files: FileList | File[]) {
    const arr = Array.from(files).filter(f => f.name.endsWith('.csv') || f.type.includes('csv') || f.type.includes('text'))
    if (!arr.length) return
    if (!parts.length) { showToast('Add a loan part first, then import.'); return }
    const cfg = await loadFile(arr[0])
    setImportCfg({ ...cfg, queue: arr.slice(1), qIdx: 0 })
  }
  function reTriage(patch: Partial<Pick<ImportCfg, 'mapping' | 'importPart'>>) {
    setImportCfg(p => {
      if (!p) return p
      const mapping = patch.mapping ?? p.mapping
      const importPart = patch.importPart ?? p.importPart
      return { ...p, mapping, importPart, triage: buildTriage(p.parsed, mapping, importPart) }
    })
  }
  async function confirmImport() {
    if (!importCfg) return
    const drafts = importCfg.triage
      .filter(t => t.hasAmount && t.classification === 'include')
      .map((t, i) => {
        const row = importCfg.parsed.rows[importCfg.triage.indexOf(t)] || importCfg.parsed.rows[i]
        return makePayment({ loan_part_id: t.loan_part_id, date: (importCfg.mapping.date != null ? row[importCfg.mapping.date] : '')?.trim() || '', kind: t.kind, description: t.specText, amount: t.amount, balance_after: t.balance_after, source: 'import:' + importCfg.file.name })
      })
    if (!drafts.length) { showToast('Nothing selected to add.'); return }
    // Supersede (plan 23): actuals always win. A predicted row matched within
    // tolerance is replaced silently; drift outside it requires an explicit
    // go-ahead — the drift itself is the alarm (rate reset, fee, extra
    // amortering) — and on confirm the actual still replaces the prediction.
    const matches = matchPredictedRows(payments, drafts)
    const drifted = matches.filter(m => !m.recon.ok)
    if (drifted.length) {
      const lines = drifted.map(m =>
        (partNameById(m.predicted.loan_part_id) + ': förväntad ' + fmtMoney(m.recon.expected) + ' → faktisk ' + fmtMoney(m.recon.actual) + ' (drift ' + fmtMoney(Math.abs(m.recon.drift)) + ')'))
      if (!confirm('Räntan avviker från prognosen — ränteändring, avgift eller extra amortering?\n\n' + lines.join('\n') + '\n\nErsätt de förväntade raderna med de importerade beloppen?')) return
    }
    const predictedIds = [...new Set(matches.map(m => m.predicted.id))]
    try {
      const sig = headerSignature(importCfg.parsed.headers)
      await Store.saveSettings({ import_presets: { ...settings.import_presets, [sig]: mappingToNames(importCfg.parsed.headers, importCfg.mapping) } })
      if (predictedIds.length) await Store.removePayments(predictedIds)
      const savedRows = await Store.addPayments(drafts)
      await refresh(); flashSaved()
      showToast('Added ' + savedRows.length + ' row' + (savedRows.length === 1 ? '' : 's')
        + (predictedIds.length ? ' · replaced ' + predictedIds.length + ' predicted row' + (predictedIds.length === 1 ? '' : 's') : '')
        + ' from “' + importCfg.file.name + '”.')
      if (importCfg.queue.length) { const cfg = await loadFile(importCfg.queue[0]); setImportCfg({ ...cfg, queue: importCfg.queue.slice(1), qIdx: importCfg.qIdx + 1 }) }
      else setImportCfg(null)
    } catch (err) { saveErr(err) }
  }
  const triageSummary = useMemo(() => {
    if (!importCfg) return ''
    let add = 0, skip = 0, invalid = 0, dup = 0, ints = 0, matched = 0, drifted = 0
    importCfg.triage.forEach(t => {
      if (!t.hasAmount) { invalid++; return }
      if (t.classification === 'skip') { skip++; return }
      add++; if (t.kind === 'interest') ints++; if (t.duplicate) dup++
      if (t.recon) { if (t.recon.ok) matched++; else drifted++ }
    })
    const out = [add + ' row' + (add === 1 ? '' : 's') + ' to add']
    if (ints) out.push(ints + ' ränta')
    if (matched) out.push('✓ ' + matched + ' matchar prognosen')
    if (drifted) out.push('⚠ ' + drifted + ' med drift')
    if (dup) out.push(dup + ' possible duplicate' + (dup === 1 ? '' : 's'))
    if (skip) out.push(skip + ' skipped')
    if (invalid) out.push(invalid + ' without an amount')
    return out.join(' · ')
  }, [importCfg])
  const addCount = importCfg ? importCfg.triage.filter(t => t.hasAmount && t.classification === 'include').length : 0

  // ── Handlers ─────────────────────────────────────────────────────────────
  async function handleSavePart(data: Omit<LoanPart, 'id' | 'created_at'>) {
    try {
      // Plan 103 — a new part associates with the active mortgage (edits keep
      // their existing link). Legacy data with no mortgage leaves it null.
      if (partDlg.id) await Store.updateLoanPart(partDlg.id, data)
      else await Store.addLoanPart({ ...data, mortgage_id: activeMortgage?.id ?? null })
      await refresh(); flashSaved(); setPartDlg({ open: false, id: null }); showToast(partDlg.id ? 'Loan part updated.' : 'Loan part added.')
    } catch (err) { saveErr(err) }
  }
  async function handleDeletePart(id: string) {
    try { await Store.removeLoanPart(id); await refresh(); flashSaved(); setPartDlg({ open: false, id: null }); showToast('Loan part deleted.') }
    catch (err) { saveErr(err) }
  }
  // Plan 104 — lock (or clear) the active bank's day-count year. A declared lock
  // (source 'declared') makes that basis authoritative for the bunden forecast;
  // clearing it (basis null, source null) hands the decision back to detection.
  async function handleSetBankYearBasis(basis: 360 | 365 | null) {
    if (!activeBank) return
    try {
      await Store.updateBank(activeBank.id, {
        year_basis: basis,
        year_basis_source: basis == null ? null : 'declared',
      })
      await refresh(); flashSaved()
      showToast(basis == null ? 'Bankår återställt till auto.' : `Bankår låst till faktisk/${basis}.`)
    } catch (err) { saveErr(err) }
  }
  // Plan 104 (phase 2) — pin (or clear) the active bank's billing cadence.
  async function handleSetBankBilling(billing: 'month-end' | 'fixed' | null) {
    if (!activeBank) return
    try {
      await Store.updateBank(activeBank.id, { billing, billing_source: billing == null ? null : 'declared' })
      await refresh(); flashSaved()
      showToast(billing == null ? 'Aviseringsdag återställd till auto.'
        : billing === 'month-end' ? 'Aviseringsdag låst till månadsslut.' : 'Aviseringsdag låst till fast dag.')
    } catch (err) { saveErr(err) }
  }
  async function handleSavePeriod(partId: string, data: Omit<RatePeriod, 'id' | 'created_at'>, existingId?: string) {
    try {
      if (existingId) await Store.updateRatePeriod(existingId, data); else await Store.addRatePeriod({ ...data, loan_part_id: partId })
      await refresh(); flashSaved(); showToast(existingId ? 'Rate period updated.' : 'Rate period added.')
    } catch (err) { saveErr(err) }
  }
  async function handleDeletePeriod(id: string) {
    try { await Store.removeRatePeriod(id); await refresh(); flashSaved() }
    catch (err) { saveErr(err) }
  }
  // Turning tracking on is always an explicit user action; it never rewrites
  // existing source records or opens a second contribution editor.
  async function handleEnableTracking() {
    try {
      await Store.saveSettings({ track_contributions: true })
      await refresh(); flashSaved()
      showToast('Ägarfördelning från insatt kapital är påslagen.')
    } catch (err) { saveErr(err) }
  }
  async function handleSaveVal(data: Omit<Valuation, 'id' | 'created_at'>) {
    try {
      let savedId = valDlg.id
      if (valDlg.id) await Store.updateValuation(valDlg.id, data)
      else { const v = await Store.addValuation(data); savedId = v.id }
      // Only one valuation can be the köpeskilling — clear the flag on the rest.
      if (data.is_purchase && savedId) {
        for (const v of valuations) if (v.id !== savedId && v.is_purchase) await Store.updateValuation(v.id, { is_purchase: false })
      }
      await refresh(); flashSaved(); setValDlg({ open: false, id: null }); showToast(data.is_purchase ? 'Köpeskilling set.' : 'Valuation saved.')
    } catch (err) { saveErr(err) }
  }
  function toggleExpandPay(id: string) {
    setExpandedPays(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })
  }
  async function handleDeleteVal(id: string) {
    try { await Store.removeValuation(id); await refresh(); flashSaved(); setValDlg({ open: false, id: null }); showToast('Valuation deleted.') }
    catch (err) { saveErr(err) }
  }
  async function handleSavePay(data: Omit<Payment, 'id' | 'created_at'>) {
    try {
      if (payDlg.id) await Store.updatePayment(payDlg.id, data); else await Store.addPayment(data)
      await refresh(); flashSaved(); setPayDlg({ open: false, id: null }); showToast('Payment saved.')
    } catch (err) { saveErr(err) }
  }
  async function handleDeletePay(id: string) {
    try { await Store.removePayment(id); await refresh(); flashSaved(); setPayDlg({ open: false, id: null }); showToast('Payment deleted.') }
    catch (err) { saveErr(err) }
  }
  async function handleCopyToParts(source: Payment, targetIds: string[]) {
    try {
      await Store.addPayments(targetIds.map(partId => makePayment({ ...source, loan_part_id: partId, balance_after: null })))
      await refresh(); flashSaved(); setCopyDlg({ open: false, source: null })
      showToast(`Copied to ${targetIds.length} part${targetIds.length === 1 ? '' : 's'}.`)
    } catch (err) { saveErr(err) }
  }
  async function handleSaveSettings(patch: Partial<MortgageSettings>) {
    try { await Store.saveSettings(patch); await refresh(); flashSaved(); setSettingsDlg(false); showToast('Settings saved.') }
    catch (err) { saveErr(err) }
  }

  // Confirm-to-log (plan 23, decision 5): one click logs ONE expected
  // transaction (a ränta, the bank's betalning, or a legacy amortering line)
  // as a source:'predicted' row — the "stop typing" deliverable. The next
  // real import replaces it (or prompts on drift). Rows only ever enter the
  // ledger on this explicit click, never on visit.
  async function handleLogPredicted(entries: Array<{ charge: ExpectedCharge; kind: PendingKind; amount: number }>) {
    const toLog = entries.filter(e => e.amount > 0 && !hasChargeInMonth(payments, e.charge.loan_part_id, e.charge.next_date, e.kind))
    if (!toLog.length) return
    try {
      await Store.addPayments(toLog.map(e => makePayment({
        loan_part_id: e.charge.loan_part_id, date: e.charge.next_date, kind: e.kind,
        description: 'Förväntad avi', amount: e.amount,
        // Post-charge saldo: the month's amortering (if any) has landed by statement time.
        balance_after: e.charge.balance - e.charge.amortization,
        source: 'predicted',
      })))
      await refresh(); flashSaved()
      showToast(toLog.length === 1
        ? 'Förväntad rad loggad — nästa import ersätter den med bankens rad.'
        : toLog.length + ' förväntade rader loggade — nästa import ersätter dem.')
    } catch (err) { saveErr(err) }
  }

  // Rewrite each stale förväntad row to the current forecast's amount and
  // post-charge saldo. Explicit click only — same principle as logging.
  async function handleRefreshPredicted() {
    if (!staleRows.length) return
    try {
      for (const s of staleRows)
        await Store.updatePayment(s.payment.id, { amount: s.amount, balance_after: s.balance_after })
      await refresh(); flashSaved()
      showToast(staleRows.length === 1
        ? '1 förväntad rad uppdaterad till aktuell prognos.'
        : staleRows.length + ' förväntade rader uppdaterade till aktuell prognos.')
    } catch (err) { saveErr(err) }
  }

  async function clearPayments() {
    const scoped = paymentFilter === 'all' ? payments : payments.filter(p => p.loan_part_id === paymentFilter)
    if (!scoped.length) return
    if (!confirm('Delete ' + scoped.length + ' payment' + (scoped.length === 1 ? '' : 's') + '? This can’t be undone.')) return
    try {
      for (const p of scoped) await Store.removePayment(p.id)
      await refresh(); flashSaved(); showToast('Payments deleted.')
    } catch (err) { saveErr(err) }
  }

  function handleExportCSV() {
    const csv = paymentsToCsv(payments, parts)
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'bolanekoll-betalningar.csv'; a.click(); URL.revokeObjectURL(url)
  }
  async function handleExportJSON() {
    const json = await Store.exportJSON()
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'bolanekoll-backup.json'; a.click(); URL.revokeObjectURL(url)
  }
  async function handleImportJSON(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    try { const added = await Store.importJSON(await file.text()); await refresh(); flashSaved(); showToast('Restored ' + Object.values(added).reduce((a, b) => a + b, 0) + ' rows.') }
    catch (err) { saveErr(err) }
    e.target.value = ''
  }

  // ── Derived display values ───────────────────────────────────────────────
  const dashSub = !parts.length
    ? 'Add a loan part and a property value to get started.'
    : !hasValuation
      ? 'Add a property value to see equity · ' + fmtMoney(balance) + ' owed across ' + parts.length + ' part' + (parts.length === 1 ? '' : 's') + '.'
      : fmtPct(ltv) + ' loan-to-value · ' + fmtMoney(balance) + ' still owed to the bank.'

  const bridgeLabel = bridgePeriod === 'ytd' ? 'i år' : bridgePeriod === '12m' ? 'senaste 12 mån' : 'sedan start'
  const wsum = Math.abs(bridge.amortization_gain) + Math.abs(bridge.appreciation_gain)
  const pa = wsum > 0 ? Math.round(Math.abs(bridge.amortization_gain) / wsum * 100) : 0

  const lastCost = costRows.length ? costRows[costRows.length - 1] : null
  const partsTotal = balance

  const chronVals = useMemo(() => valuations.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))), [valuations])
  const maxVal = chronVals.reduce((mx, v) => Math.max(mx, Number(v.value) || 0), 0)

  const filteredPayments = paymentFilter === 'all' ? payments : payments.filter(p => p.loan_part_id === paymentFilter)
  const shownPayments = filteredPayments.slice(0, payVisible)
  const hiddenPayCount = filteredPayments.length - shownPayments.length
  const partNameById = (pid: string | null) => parts.find(p => p.id === pid)?.label || '—'

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className={'bk-root' + (active ? ' vt-page' : '')}>
      <PageHeader
        backTo="/bolanekoll"
        title={settings.property_name || 'Bolånekoll'}
        tagline="Track your mortgage — how much of the home you own vs the bank"
        saveVisible={saved}
        actions={<>
          <button className="btn btn-ghost theme-toggle-btn" onClick={() => setSettingsDlg(true)} title="Settings" aria-label="Settings"><Icon icon={Settings2} size={18} /></button>
          <ThemeToggle />
        </>}
      />

      <main className="wrap">

        {!parts.length ? (
        // Hold the empty-hero back until the cloud read has resolved: on a cold
        // cache with cloud data, showing it before `loaded` would flash the
        // first-run screen for a frame before the dashboard appears.
        !loaded ? null : (
        <section className="card">
          <div className="empty-hero">
            <p className="empty-hero-eyebrow">Bolånekoll</p>
            <h2 className="empty-hero-title">See how much of your home you own</h2>
            <p className="empty-hero-text">Track your mortgage part by part — remaining debt, equity, loan-to-value and the road to payoff. Add your first loan part to begin; you can import statements as a CSV once it exists.</p>
            <div className="empty-hero-actions">
              <button type="button" className="btn btn-primary" onClick={() => setPartDlg({ open: true, id: null })}>+ Add loan part</button>
            </div>
          </div>
        </section>
        )
        ) : (<>

        {/* ── Dashboard: one hero (market equity), cost-basis as a secondary row ── */}
        <section className="card dashboard-card">
          <div className="dash-main">
            <p className="dash-label">Marknadsvärde · How much of the home is yours</p>
            {hasValuation ? (
              <>
                <p className="dash-headline">{M(eq, false, true)}</p>
                <p className="dash-sub">{dashSub}</p>
              </>
            ) : (
              <div className="market-empty">
                <p className="dash-sub">Add what the home is worth today to see how much of it is yours vs the bank.</p>
                <button type="button" className="btn btn-primary" onClick={() => setValDlg({ open: true, id: null })}>+ Add value</button>
              </div>
            )}
          </div>
          {estimatedPartIds.size > 0 && (
            <div className="payment-estimate-warning dashboard-estimate-warning" role="alert">
              <b>Uppskattat saldo.</b> Ränta saknas för en eller flera betalningar — ägandet kan vara överskattat.
              {' '}<a href="#betalningar">Visa berörda betalningar</a>
              <span className="dashboard-estimate-parts"> · {parts.filter(p => estimatedPartIds.has(p.id)).map(p => p.label || p.id).join(', ')}</span>
            </div>
          )}
          {/* The ownership split is ONE fact (contributionSplit) applied to two
              bases below — market equity here, cost-basis further down. Each
              card carries "NAME · %" next to its figure (same pattern as the
              Insatser cards); the head-note is the connective tying the two
              rows to the one split (plan 86). */}
          {hasValuation && settings.track_contributions && (
            <>
              <div className="split-head">
                <span className="split-head-label">Ägarandel · Ownership split</span>
                {hasPurchase && <span className="split-head-note">One split, applied to today’s equity here and to what’s been paid in below.</span>}
              </div>
              <div className="split-row">
                <div className={'split-card' + (me === 'a' ? ' is-accent' : '')}>
                  <span className="split-name">{nameOf('a')} · {fmtPct(cbSplit.a_pct)}</span>
                  <span className="split-val">{M(eq * cbSplit.a_pct / 100, false, true)}</span>
                  <span className="split-sub">equity share</span>
                </div>
                <div className={'split-card' + (me === 'b' ? ' is-accent' : '')}>
                  <span className="split-name">{nameOf('b')} · {fmtPct(cbSplit.b_pct)}</span>
                  <span className="split-val">{M(eq * cbSplit.b_pct / 100, false, true)}</span>
                  <span className="split-sub">equity share</span>
                </div>
              </div>
            </>
          )}
          {/* Front door into contribution tracking (plan 87) — a quiet CTA where
              the split would render, so the feature is discovered here (the
              decision) rather than via the ledger ★ (the data). */}
          {hasValuation && !settings.track_contributions && (
            <div className="split-head split-head-cta">
              <span className="split-head-label">Ägarandel · Ownership split</span>
              <button type="button" className="link-btn split-cta" onClick={() => handleEnableTracking()}>
                Visa ägarfördelning från insatt kapital →
              </button>
            </div>
          )}

          {/* Cost-basis equity — what you've actually paid in. A secondary row
              inside the same card (label + number + explainer), paired with the
              market-equity headline above rather than competing with it. */}
          <div className="costbasis-row">
            {hasPurchase ? (
              <>
                <div className="cb-line">
                  <span className="cb-label">Insatt kapital · Cost-basis equity</span>
                  <span className="cb-val">{M(costBasisEq, false, true)}</span>
                </div>
                <p className="cb-sub">{P(ownedPct, true)} of the köpeskilling ({M(price, false, true)}) paid in — kontantinsats {M(deposit, false, true)} plus amortised.</p>
                {settings.track_contributions && (
                  <div className="split-row">
                    <div className={'split-card' + (me === 'a' ? ' is-accent' : '')}>
                      <span className="split-name">{nameOf('a')} · {fmtPct(cbSplit.a_pct)}</span>
                      <span className="split-val">{M(cbSplit.a, false, true)}</span>
                      <span className="split-sub">paid in · insatt</span>
                    </div>
                    <div className={'split-card' + (me === 'b' ? ' is-accent' : '')}>
                      <span className="split-name">{nameOf('b')} · {fmtPct(cbSplit.b_pct)}</span>
                      <span className="split-val">{M(cbSplit.b, false, true)}</span>
                      <span className="split-sub">paid in · insatt</span>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="cb-sub"><span className="cb-label">Insatt kapital · Cost-basis equity</span> — flag your köpeskilling in Bostadens värde to see how much of the home you’ve actually paid for.</p>
            )}
          </div>

          <div className="metric-row">
            <div className="metric-chip" data-current-debt={String(Math.round(balance))}><span className="metric-label">Remaining debt</span><span className="metric-val">{M(balance, false, true)}</span></div>
            <div className="metric-chip"><span className="metric-label">Property value</span><span className="metric-val">{hasValuation ? M(value, false, true) : '—'}</span></div>
            <div className="metric-chip"><span className="metric-label">Loan-to-value</span><span className="metric-val">{hasValuation ? P(ltv, true) : '—'}</span></div>
            <div className="metric-chip"><span className="metric-label">Total amortised</span><span className="metric-val">{M(amortized, false, true)}</span></div>
          </div>
          {/* Reprice notice — deliberately absent until it's actionable: the
              date always lives in the Lånedelar ledger; this only surfaces in
              the hero once the villkorsändring is a month out (or overdue). */}
          {nextReprice && (nextReprice.expired || nextReprice.days_left! <= REPRICE_NOTICE_DAYS) && (
            <div className="reprice-note">
              <span className="reprice-count">{repriceLabel(nextReprice.days_left, nextReprice.expired)}</span>
              <span className="reprice-text">
                Nästa villkorsändring <span className="card-en">· next reprice</span> <b>{nextReprice.end_date}</b>
                {' — '}{M(nextReprice.total_balance, false, true)}
                {nextReprice.share_pct < 100 && <> ({P(nextReprice.share_pct, true)} of the loan)</>}
                {nextReprice.rate != null && <> now at {fmtPct(nextReprice.rate)}{nextReprice.rate_type ? ' ' + nextReprice.rate_type : ''}</>}
                {' — '}time to talk to the bank about rebinding.
              </span>
            </div>
          )}
          {reconcile.length > 0 && (
            <div className="reconcile-banner">
              Start-balance check — your entered start balance doesn’t match where the imported ledger begins (a partial import, or a start balance to update — today’s balance still tracks the Saldo correctly):
              <ul>{reconcile.map(r => <li key={r.loan_part_id}>{r.label || 'Loan part'}: start balance {fmtMoney(r.start_balance!)} vs the ledger’s earliest Saldo {fmtMoney(r.start_saldo!)} — off by {fmtMoney(Math.abs(r.drift!))}</li>)}</ul>
            </div>
          )}
        </section>

        {/* ── Ownership vs bank over time ── */}
        <section className="card">
          <div className="card-head"><h2>Ägande över tid <span className="card-en">· Ownership vs bank</span></h2></div>
          {valuations.length === 0 ? (
            <div className="empty-stub">
              <p>Add a property value to chart your equity vs the bank.</p>
              <button type="button" className="btn btn-ghost" onClick={() => setValDlg({ open: true, id: null })}>+ Add value</button>
            </div>
          ) : (
            <div className="chart-wrap">
              {timeline.length >= 2
                ? <EquityStackChart data={chartData}
                    mineLabel={nameOf(me) + '’s equity'} partnerLabel={nameOf(other) + '’s equity'}
                    bankLabel="Banken · Bank" formatMoney={fmtMoney} />
                : <p className="chart-empty">Import a few months of payments to see the trend.</p>}
            </div>
          )}
        </section>

        {/* ── Insights ── */}
        <section className="card">
          <div className="card-head">
            <h2>Insikter <span className="card-en">· Insights</span></h2>
            <div className="card-actions">
              <Segmented value={bridgePeriod} onChange={setBridgePeriod}
                options={[{ v: 'ytd', label: 'I år' }, { v: '12m', label: '12 mån' }, { v: 'all', label: 'Allt' }]} />
            </div>
          </div>
          {!insightsReady ? (
            <p className="insights-empty">Add a property value and a few months of payments to see how your equity is growing.</p>
          ) : (
            <>
              <div className="bridge">
                <div className="bridge-head">
                  <span className="bridge-title">Förändring eget kapital · equity change {bridgeLabel}</span>
                  <span className={'bridge-total' + (bridge.total_gain < 0 ? ' is-neg' : '')}>{M(bridge.total_gain, true)}</span>
                </div>
                <div className="bridge-bar">
                  <span className={'bridge-seg is-amort' + (bridge.amortization_gain < 0 ? ' is-neg' : '')} style={{ width: pa + '%' }} />
                  <span className={'bridge-seg is-appr' + (bridge.appreciation_gain < 0 ? ' is-neg' : '')} style={{ width: (100 - pa) + '%' }} />
                </div>
                <div className="bridge-legend">
                  <span className="bridge-key"><span className="bridge-dot is-amort" />Amortering <b>{M(bridge.amortization_gain, true)}</b></span>
                  <span className="bridge-key"><span className="bridge-dot is-appr" />Värdeökning · appreciation <b>{M(bridge.appreciation_gain, true)}</b></span>
                </div>
              </div>
              <div className="metric-row">
                {lastCost && <div className="metric-chip"><span className="metric-label">{settings.ranteavdrag ? 'Latest month · net' : 'Latest month'}</span><span className="metric-val">{M(lastCost.net)}</span></div>}
                {blended > 0 && <div className="metric-chip is-accent"><span className="metric-label">Blended rate</span><span className="metric-val">{P(blended)}</span></div>}
                {krav.has_value && <div className="metric-chip"><span className="metric-label">Amort.krav (est.)</span><span className="metric-val">{krav.exempt ? 'None · LTV ≤ 50 %' : <>{krav.required_pct + ' % · '}<span className="nobr">{fmtMoney(krav.required_annual) + '/år'}</span></>}</span></div>}
                <div className="metric-chip"><span className="metric-label">Interest paid</span><span className="metric-val">{M(interest, false, true)}</span></div>
                {settings.ranteavdrag && <div className="metric-chip"><span className="metric-label">Ränteavdrag (est.)</span><span className="metric-val">{M(deduction, false, true)}</span></div>}
              </div>
            </>
          )}
        </section>

        {/* ── Styrränta (plan 70) — a small card, not a new hero: plan 64 owns
            hero hierarchy. Best-effort only — a failed fetch quietly drops the
            whole card rather than showing an error next to the calculator. */}
        {!rateFailed && (
          <section className="card rate-card">
            <div className="card-head">
              <h2>Styrränta <span className="card-en">· Policy rate</span></h2>
              {policyRate && policyRate.changes.length >= 2 && (
                <div className="card-actions">
                  <Segmented value={rateRange} onChange={setRateRange}
                    options={[{ v: '5y', label: '5 år' }, { v: 'all', label: 'Allt' }]} />
                </div>
              )}
            </div>
            {!policyRate || !rateNow ? (
              <p className="rate-loading">Hämtar styrräntan…</p>
            ) : (
              <>
                {showRateChangeBanner && (() => {
                  const prev = policyRate.changes[policyRate.changes.length - 2]
                  const verb = !prev ? 'ändrades' : rateNow.value < prev.value ? 'sänktes' : 'höjdes'
                  return (
                    <div className="rate-change-banner">
                      <span>
                        Styrräntan {verb}{prev && <> {fmtPct(prev.value)} → {fmtPct(rateNow.value)}</>} den {fmtRateDate(rateNow.date)}.
                      </span>
                      <span className="rate-banner-actions">
                        <button type="button" className="link-btn rate-banner-never" onClick={dismissRateChange}>visa inte igen</button>
                        <button type="button" className="icon-btn rate-banner-dismiss" title="Dölj för nu" aria-label="Dölj för nu" onClick={hideRateChangeForNow}>
                          <Icon icon={X} size={14} />
                        </button>
                      </span>
                    </div>
                  )
                })()}
                <div className="rate-strip">
                  <div className="rate-strip-cell">
                    <span className="rate-strip-label">Aktuell nivå</span>
                    <span className="rate-strip-value">{fmtPct(rateNow.value)}</span>
                    <span className="rate-strip-sub">sedan {fmtRateDate(rateNow.date)}</span>
                  </div>
                  {lastBesked && lastBeskedOutcome && (
                    <div className="rate-strip-cell">
                      <span className="rate-strip-label">Senaste besked</span>
                      <span className="rate-strip-value">{fmtRateDate(lastBesked)}</span>
                      <span className="rate-strip-sub">{lastBeskedOutcome}</span>
                    </div>
                  )}
                  <div className="rate-strip-cell">
                    <span className="rate-strip-label">Nästa räntebesked</span>
                    {nextBesked ? (
                      <>
                        <span className="rate-strip-value">{fmtRateDate(nextBesked)}</span>
                        {nextBeskedDays != null && nextBeskedDays >= 0 && (
                          <span className="rate-strip-sub">om {nextBeskedDays} {nextBeskedDays === 1 ? 'dag' : 'dagar'}</span>
                        )}
                      </>
                    ) : (
                      <span className="rate-strip-sub">se riksbank.se</span>
                    )}
                  </div>
                </div>
                {policyRate.changes.length >= 2 && (
                  <div className="chart-wrap rate-chart-wrap">
                    <RiksbankChart changes={policyRate.changes} range={rateRange} reduceMotion={!!reduceMotion} />
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {/* ── Projection ── */}
        <section className="card">
          <div className="card-head">
            <h2>Prognos <span className="card-en">· Projection</span></h2>
            <div className="card-actions">
              <label className="proj-field" htmlFor="extraAmort">Extra amortering / mån</label>
              <input type="text" id="extraAmort" className="proj-input" inputMode="decimal" autoComplete="off" placeholder="0" value={extraAmort} onChange={e => setExtraAmort(e.target.value)} />
              {whatIf && (
                <>
                  <label className="proj-field" htmlFor="whatIfRate">Ränta i scenariot / %</label>
                  <div className="rate-stepper">
                    <button type="button" className="rate-step" aria-label="−0,01 procentenheter"
                      onClick={() => setWhatIfRate(Math.max(0, hypRate - 0.01).toFixed(2))}>−</button>
                    <input type="text" id="whatIfRate" className="proj-input rate-input" inputMode="decimal" autoComplete="off"
                      value={whatIfRate ?? blended.toFixed(2)} onChange={e => setWhatIfRate(e.target.value)} />
                    <button type="button" className="rate-step" aria-label="+0,01 procentenheter"
                      onClick={() => setWhatIfRate((hypRate + 0.01).toFixed(2))}>+</button>
                  </div>
                </>
              )}
            </div>
          </div>
          {!parts.length ? (
            <p className="proj-note">Add a loan part to project your payoff.</p>
          ) : (
            <>
              <p className="proj-note">
                {ms.flat && extra <= 0
                  ? 'Interest-only — the balance stays flat. Enter an extra monthly amortering above to see a payoff date.'
                  : 'At ' + fmtMoney(ms.per_month) + '/mo (' + fmtMoney(base) + ' observed + ' + fmtMoney(extra) + ' extra), property value held flat.'}
              </p>
              {prognos.rows.length > 0 && (
                <>
                  <p className="proj-note prognos-forward">
                    ~{fmtMoney(forecast.interest)} ränta över 12 mån
                    {settings.ranteavdrag && <> · ~{fmtMoney(forecast.net)} efter avdrag</>}
                    {forecast.assumed && <span className="prognos-assumed"> (förutsatt oförändrade räntor)</span>}
                  </p>
                  <hr className="whatif-divider" />
                </>
              )}
              <p className="whatif-group-label">Amorteringsplan</p>
              <div className="metric-row">
                <div className={'metric-chip' + (ms.payoff_months != null ? ' is-accent' : '')}><span className="metric-label">Payoff</span><span className="metric-val">{ms.payoff_months == null ? 'Never' : monthsToWhen(ms.payoff_months)}</span></div>
                {valuations.length > 0 && <div className="metric-chip"><span className="metric-label">70 % LTV</span><span className="metric-val">{monthsToWhen(ms.ltv70_months)}</span></div>}
                {valuations.length > 0 && <div className="metric-chip"><span className="metric-label">50 % LTV</span><span className="metric-val">{monthsToWhen(ms.ltv50_months)}</span></div>}
              </div>
              {whatIf && (
                <>
                  <hr className="whatif-divider" />
                  <p className="whatif-group-label">Betalning till banken</p>
                  <div className="metric-row whatif-row">
                    <div className="metric-chip"><span className="metric-label">Nu ({fmtPct(blended)})</span>
                      <span className="metric-val">{M(whatIf.now.gross)}</span>
                      {settings.ranteavdrag && <span className="metric-sub">{fmtMoney(whatIf.now.net)} netto</span>}</div>
                    <div className="metric-chip is-accent"><span className="metric-label">Vid {fmtPct(hypRate)}</span>
                      <span className="metric-val">{M(whatIf.hyp.gross)}</span>
                      {settings.ranteavdrag && <span className="metric-sub">{fmtMoney(whatIf.hyp.net)} netto</span>}</div>
                    <div className={'metric-chip' + (whatIf.delta_month > 0 ? ' is-warn' : whatIf.delta_month < 0 ? ' is-good' : '')}>
                      <span className="metric-label">Skillnad</span>
                      <span className="metric-val">{M(whatIf.delta_month, true)}/mån</span>
                      <span className="metric-sub">{fmtMoney(whatIf.delta_year)} /år</span></div>
                  </div>
                </>
              )}
              {whatIf?.household && (
                <>
                  <hr className="whatif-divider" />
                  <p className="whatif-group-label">Din andel av hushållets delade kostnader</p>
                  <div className="metric-row whatif-row">
                    <div className="metric-chip"><span className="metric-label">Hushåll nu ({fmtPct(blended)})</span>
                      <span className="metric-val">{M(whatIf.household.now / 2)}</span>
                      <span className="metric-sub">din andel / mån</span></div>
                    <div className="metric-chip is-accent"><span className="metric-label">Hushåll vid {fmtPct(hypRate)}</span>
                      <span className="metric-val">{M(whatIf.household.hyp / 2)}</span>
                      <span className="metric-sub">din andel / mån</span></div>
                    <div className={'metric-chip' + (whatIf.delta_month > 0 ? ' is-warn' : whatIf.delta_month < 0 ? ' is-good' : '')}>
                      <span className="metric-label">Skillnad</span>
                      <span className="metric-val">{M(whatIf.delta_month / 2, true)}/mån</span>
                      <span className="metric-sub">{fmtMoney(whatIf.delta_year / 2)} /år</span></div>
                  </div>
                  <p className="proj-note whatif-note">Delade kostnader från Hushållsbudget (individuella kostnader och sparande exkluderade). Bolåneraden lämnas orörd — endast ränteskillnaden läggs på.</p>
                </>
              )}
            </>
          )}
        </section>

        {/* ── Import payments ── */}
        <section className="card import-card">
          <div className="card-head"><h2>Importera betalningar <span className="card-en">· Import payments</span></h2></div>
          {!parts.length ? (
            <div className="import-guard">
              <p>Add a loan part first — then import its payment CSV.</p>
              <button type="button" className="btn btn-primary" onClick={() => setPartDlg({ open: true, id: null })}>+ Add loan part</button>
            </div>
          ) : !importCfg ? (
            <FileDropzone isDragging={isDragging} onDragChange={setIsDragging} inputRef={fileInputRef}
              onFiles={handleFiles} accept=".csv,text/csv,text/plain" multiple>
              <p className="dropzone-lead">Drop one or more mortgage <strong>.csv</strong> files here, or <span className="link-btn">browse</span>.</p>
              <p className="dropzone-hint">One file per loan part · we map the columns and step through them one at a time.</p>
            </FileDropzone>
          ) : (
            <div className="import-config">
              <div className="import-filebar">
                <span className="file-pill">{importCfg.file.name} · {importCfg.parsed.rows.length} rows</span>
                {importCfg.queue.length > 0 && <span className="queue-info">+{importCfg.queue.length} file{importCfg.queue.length === 1 ? '' : 's'} queued</span>}
                <button type="button" className="link-btn" onClick={() => { setImportCfg(null); if (fileInputRef.current) fileInputRef.current.value = '' }}>Choose other files</button>
              </div>
              <div className="config-grid">
                {([['date', 'Date column'], ['specification', 'Type column (Specifikation)'], ['amount', 'Amount column (Belopp)']] as const).map(([k, lbl]) => (
                  <div key={k} className="config-field">
                    <label>{lbl}</label>
                    <select className="select" value={importCfg.mapping[k] ?? ''} onChange={e => reTriage({ mapping: { ...importCfg.mapping, [k]: e.target.value !== '' ? Number(e.target.value) : null } })}>
                      <option value="">— none —</option>
                      {importCfg.parsed.headers.map((h, i) => <option key={i} value={i}>{h || 'Column ' + (i + 1)}</option>)}
                    </select>
                  </div>
                ))}
              </div>
              <div className="config-grid">
                {([['balance', 'Balance column (Saldo)'], ['loan_number', 'Loan # column (optional)']] as const).map(([k, lbl]) => (
                  <div key={k} className="config-field">
                    <label>{lbl}</label>
                    <select className="select" value={importCfg.mapping[k] ?? ''} onChange={e => reTriage({ mapping: { ...importCfg.mapping, [k]: e.target.value !== '' ? Number(e.target.value) : null } })}>
                      <option value="">— none —</option>
                      {importCfg.parsed.headers.map((h, i) => <option key={i} value={i}>{h || 'Column ' + (i + 1)}</option>)}
                    </select>
                  </div>
                ))}
                <div className="config-field">
                  <label>Which loan part is this file for?</label>
                  <select className="select" value={importCfg.importPart} onChange={e => reTriage({ importPart: e.target.value })}>
                    {importCfg.mapping.loan_number != null && <option value="__auto__">Auto-detect from loan #</option>}
                    {parts.map(p => <option key={p.id} value={p.id}>{p.label || '(loan part)'}</option>)}
                  </select>
                </div>
              </div>
              <div className="triage-bar">
                <span className="triage-summary">{triageSummary}</span>
                <span className="triage-toggle">
                  <button type="button" className="link-btn" onClick={() => setImportCfg(p => p ? { ...p, triage: p.triage.map(t => t.hasAmount ? { ...t, classification: 'include' } : t) } : p)}>Include all</button>
                  <span className="triage-sep" aria-hidden="true">·</span>
                  <button type="button" className="link-btn" onClick={() => setImportCfg(p => p ? { ...p, triage: p.triage.map(t => ({ ...t, classification: 'skip' })) } : p)}>Skip all</button>
                </span>
              </div>
              <div className="table-wrap triage-wrap">
                <table className="data-table table-cards triage-table">
                  <thead><tr><th className="col-treat">Treatment</th><th className="col-date">Date</th><th>Type</th><th className="num">Amount</th><th className="num">Balance</th></tr></thead>
                  <tbody>
                    {importCfg.triage.map((t, i) => {
                      const row = importCfg.parsed.rows[i]
                      const cls = t.classification === 'skip' ? 'skip' : 'include'
                      const rowClass = !t.hasAmount ? 'is-excluded' : t.duplicate ? 'is-dup' : cls === 'skip' ? 'is-excluded' : ''
                      const auto = importCfg.importPart === '__auto__'
                      return (
                        <tr key={i} className={rowClass}>
                          <td className="col-treat">
                            {t.hasAmount ? (
                              <Segmented small value={cls} onChange={v => setImportCfg(p => p ? { ...p, triage: p.triage.map((r, j) => j === i ? { ...r, classification: v } : r) } : p)}
                                options={[{ v: 'include', label: 'Include' }, { v: 'skip', label: 'Skip' }]} />
                            ) : <span className="treat-na">no amount</span>}
                          </td>
                          <td className="col-date">{importCfg.mapping.date != null ? row[importCfg.mapping.date] : ''}</td>
                          <td className="col-desc">
                            {t.specText || kindLabel(t.kind)}
                            {t.duplicate && <span className="row-flag">possible duplicate</span>}
                            {t.recon && (t.recon.ok
                              ? <span className="row-flag row-flag-match">✓ {t.recon.predicted ? 'ersätter förväntad avi' : 'matchar prognosen'}</span>
                              : <span className="row-flag row-flag-drift">⚠ drift {fmtMoney(Math.abs(t.recon.drift))}{t.recon.predicted ? ' (förväntad ' + fmtMoney(t.amount - t.recon.drift) + ')' : ''}</span>)}
                            {auto && t.hasAmount && <span className={'row-flag' + (t.partMatched ? ' row-flag-refund' : '')}>{(t.partMatched ? '→ ' : 'no loan # → ') + partNameById(t.loan_part_id)}</span>}
                          </td>
                          <td className="num col-amt">{t.hasAmount && t.amount ? fmtMoney(t.amount) : '—'}</td>
                          <td className="num col-bal">{t.balance_after != null ? fmtMoney(t.balance_after) : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="import-actions">
                <button type="button" className="btn btn-ghost" onClick={() => { setImportCfg(null); if (fileInputRef.current) fileInputRef.current.value = '' }}>Cancel</button>
                <button type="button" className="btn btn-primary" disabled={addCount === 0} onClick={confirmImport}>{addCount ? 'Add ' + addCount + ' row' + (addCount === 1 ? '' : 's') : 'Nothing to add'}</button>
              </div>
            </div>
          )}
        </section>

        {/* ── Loan parts ── */}
        <section className="card">
          <div className="card-head">
            <h2>Lånedelar <span className="card-en">· Loan parts</span></h2>
            <span className="count-pill">{parts.length}</span>
            <div className="card-actions"><button type="button" className="btn btn-ghost" onClick={() => setPartDlg({ open: true, id: null })}>+ Add loan part</button></div>
          </div>
          {!parts.length ? <p className="empty">No loan parts yet. Add your lånedelar — one per loan account — to begin.</p> : (
            <div className="table-wrap">
              {/* Plan 103 — the parts sit under the active mortgage (bank → lån).
                  Only shown once the household has one; legacy data stays flat. */}
              {activeMortgage && (
                <div className="ld-mortgage-head">
                  <span className="ld-bank">{activeBank?.label || 'Okänd bank'}</span>
                  <span className="ld-mortgage-sep">·</span>
                  <span className="ld-mortgage-name">{activeMortgage.label || 'Bolån'}</span>
                  {/* Plan 104 — Bankvillkor: the bank's day-count year and billing
                      cadence, each Auto (detected) or locked. A confident learner
                      offers a lock (suggest → confirm); a lock that no longer matches
                      the ledger surfaces a drift warning. */}
                  {activeBank && (() => {
                    const ybLocked = activeBank.year_basis_source === 'declared'
                      && (activeBank.year_basis === 360 || activeBank.year_basis === 365)
                    const billLocked = activeBank.billing_source === 'declared'
                      && (activeBank.billing === 'month-end' || activeBank.billing === 'fixed')
                    const ybSug = bankSuggestion?.year_basis
                    return (
                      <span className="ld-bankvillkor">
                        <span className="ld-bankvillkor-row">
                          <span className="ld-bankvillkor-label">Bankår</span>
                          <span className={'ld-bankvillkor-state' + (ybLocked ? ' is-locked' : '')}>
                            {ybLocked ? `Låst faktisk/${activeBank.year_basis}` : 'Auto (upptäck)'}
                          </span>
                          <button type="button" className="btn btn-ghost btn-xs"
                            aria-pressed={ybLocked && activeBank.year_basis === 360}
                            onClick={() => handleSetBankYearBasis(360)}>Lås faktisk/360</button>
                          <button type="button" className="btn btn-ghost btn-xs"
                            aria-pressed={ybLocked && activeBank.year_basis === 365}
                            onClick={() => handleSetBankYearBasis(365)}>Lås 365</button>
                          {ybLocked && (
                            <button type="button" className="btn btn-ghost btn-xs"
                              onClick={() => handleSetBankYearBasis(null)}>Auto</button>
                          )}
                        </span>
                        {!ybLocked && ybSug?.confident && ybSug.value === 360 && (
                          <span className="ld-bankvillkor-suggest">
                            Historiken tyder på faktisk/360.
                            <button type="button" className="btn btn-ghost btn-xs"
                              onClick={() => handleSetBankYearBasis(360)}>Lås detta</button>
                          </span>
                        )}
                        {bankDrift && (
                          <span className="ld-bankvillkor-drift" role="status">
                            ⚠ Låst faktisk/{bankDrift.declared}, men färsk data tyder på faktisk/{bankDrift.learned}. Kontrollera villkoret.
                          </span>
                        )}
                        <span className="ld-bankvillkor-row">
                          <span className="ld-bankvillkor-label">Avisering</span>
                          <span className={'ld-bankvillkor-state' + (billLocked ? ' is-locked' : '')}>
                            {billLocked ? (activeBank.billing === 'month-end' ? 'Låst månadsslut' : 'Låst fast dag') : 'Auto (upptäck)'}
                          </span>
                          <button type="button" className="btn btn-ghost btn-xs"
                            aria-pressed={billLocked && activeBank.billing === 'month-end'}
                            onClick={() => handleSetBankBilling('month-end')}>Månadsslut</button>
                          <button type="button" className="btn btn-ghost btn-xs"
                            aria-pressed={billLocked && activeBank.billing === 'fixed'}
                            onClick={() => handleSetBankBilling('fixed')}>Fast dag</button>
                          {billLocked && (
                            <button type="button" className="btn btn-ghost btn-xs"
                              onClick={() => handleSetBankBilling(null)}>Auto</button>
                          )}
                        </span>
                      </span>
                    )
                  })()}
                </div>
              )}
              <table className="data-table table-cards lanedelar-table">
                <thead><tr><th>Lånedel <span className="th-en">· part</span></th><th className="num">Balance</th><th className="num">Share</th><th className="col-act"></th></tr></thead>
                <tbody>
                  {loanGroups.map(g => {
                    // Every date+rate group is a uniform collapsible folder — even a
                    // one-part group — so the list reads consistently.
                    const isExp = expandedGroups.has(g.key)
                    return (
                      <Fragment key={g.key}>
                        <tr className={'ld-group' + (g.expired ? ' is-expired' : '') + (g.is_catchall ? ' is-catchall' : '') + (isExp ? ' is-open' : '')}>
                          <td>
                            <button type="button" className="ld-disclose" aria-expanded={isExp} title={isExp ? 'Collapse' : 'Expand'} onClick={() => toggleGroup(g.key)}>
                              <motion.span
                                className="ld-tri"
                                animate={{ rotate: isExp ? 90 : 0 }}
                                transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                              ><Icon icon={ChevronRight} size={12} /></motion.span>
                              {g.is_catchall
                                ? <span className="ld-needs">No reprice date set</span>
                                : <>{repriceMeta(g)}{rateBadge(g.rate, g.rate_type)}</>}
                              <span className="ld-count">{g.parts.length} part{g.parts.length === 1 ? '' : 's'}</span>
                            </button>
                          </td>
                          <td className="num ld-sum">{fmtMoney(g.total_balance)}</td>
                          <td className="num ld-sum">{fmtPct(g.share_pct)}</td>
                          <td className="col-act"></td>
                        </tr>
                        <AnimatePresence initial={false}>
                          {isExp && g.parts.map(p => {
                            const bal = partBalance(p, payments)
                            const share = partsTotal > 0 ? bal / partsTotal * 100 : 0
                            const per = effectiveRatePeriod(p, periods)
                            return (
                              <motion.tr key={p.id} className="ld-member">
                                <td>
                                  <CellReveal reduce={reduceMotion}>
                                    <span className="ld-member-label">
                                      <span className="ld-name">{p.label || '(no name)'}{p.loan_number && <span className="ld-loanno">#{p.loan_number}</span>}</span>
                                      {rateBadge(per?.rate ?? null, per?.rate_type ?? null)}
                                    </span>
                                  </CellReveal>
                                </td>
                                <td className="num"><CellReveal reduce={reduceMotion}>{fmtMoney(bal)}</CellReveal></td>
                                <td className="num"><CellReveal reduce={reduceMotion}>{fmtPct(share)}</CellReveal></td>
                                <td className="col-act"><CellReveal reduce={reduceMotion}>{partActs(p)}</CellReveal></td>
                              </motion.tr>
                            )
                          })}
                        </AnimatePresence>
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
              {archivedParts.length > 0 && (
                <div className="avslutade-section">
                  <button type="button" className="avslutade-toggle" aria-expanded={avslutadeOpen} onClick={() => setAvslutadeOpen(v => !v)}>
                    <motion.span
                      className="expand-btn"
                      animate={{ rotate: avslutadeOpen ? 90 : 0 }}
                      transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                    ><Icon icon={ChevronRight} size={12} /></motion.span> Avslutade <span className="count-pill">{archivedParts.length}</span>
                  </button>
                  <Collapse open={avslutadeOpen}>
                    <table className="data-table avslutade-table">
                      <tbody>
                        {archivedParts.map(p => {
                          const bal = partBalance(p, payments)
                          return (
                            <tr key={p.id} className="is-settled">
                              <td><span className="ld-name">{p.label || '(no name)'}{p.loan_number && <span className="ld-loanno">#{p.loan_number}</span>}</span></td>
                              <td className="num">{fmtMoney(bal)}</td>
                              <td className="col-act">{partActs(p)}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </Collapse>
                </div>
              )}
            </div>
          )}
        </section>

        {/* ── Property value ── */}
        <section className="card">
          <div className="card-head">
            <h2>Bostadens värde <span className="card-en">· Property value</span></h2>
            <span className="count-pill">{valuations.length}</span>
            <div className="card-actions"><button type="button" className="btn btn-ghost" onClick={() => setValDlg({ open: true, id: null })}>+ Add value</button></div>
          </div>
          {!valuations.length ? <p className="empty">No valuations yet. Add what the home is worth today — update it whenever you re-value.</p> : (
            <>
              {chronVals.length > 1 && (
                <div className="bars">
                  {chronVals.map(v => {
                    const w = maxVal > 0 ? Math.max(2, Math.round((Number(v.value) || 0) / maxVal * 100)) : 0
                    return (
                      <div key={v.id} className="bar-row is-groceries">
                        <span className="bar-label">{v.date || '—'}</span>
                        <span className="bar-track"><span className="bar-fill" style={{ width: w + '%' }} /></span>
                        <span className="bar-val num">{fmtMoney(v.value)}</span>
                      </div>
                    )
                  })}
                </div>
              )}
              <div className="table-wrap">
                <table className="data-table table-cards valuations-table">
                  <thead><tr><th className="col-date">Date</th><th className="num">Value</th><th>Note</th><th className="col-act"></th></tr></thead>
                  <tbody>
                    {valuations.map(v => (
                      <tr key={v.id} className={v.is_purchase ? 'is-purchase' : ''}>
                        <td className="col-date">{v.date || '—'}</td>
                        <td className="num col-amt">{fmtMoney(v.value)}</td>
                        <td className="col-note">{v.note || ''}{v.is_purchase && <span className="row-flag row-flag-kop">köpeskilling</span>}</td>
                        <td className="col-act">
                          <button type="button" className="icon-btn" title="Edit" aria-label="Edit" onClick={() => setValDlg({ open: true, id: v.id })}><Icon icon={Pencil} /></button>
                          <button type="button" className="icon-btn" data-del-val title="Delete" aria-label="Delete" onClick={() => { if (confirm('Delete this valuation?')) handleDeleteVal(v.id) }}><Icon icon={X} /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

        {/* ── Payments ── */}
        <section className="card">
          {/* Nästa avisering (plan 23): the upcoming charge lives with the
              transactions it becomes, and leads the card — the Betalningar
              header and its controls sit further down, directly above the
              ledger they act on. Only parts NOT yet covered by a row for that
              month show — logging (or importing) makes a part drop out. */}
          {/* Förväntade rows in the ledger that no longer match the current
              forecast (logged with an older model). Refresh is an explicit
              click — the app never rewrites ledger rows on visit. */}
          {staleRows.length > 0 && (
            <div className="reconcile-banner">
              {staleRows.length === 1
                ? '1 förväntad rad i liggaren beräknades med en äldre prognosmodell och stämmer inte längre med aktuell prognos.'
                : staleRows.length + ' förväntade rader i liggaren beräknades med en äldre prognosmodell och stämmer inte längre med aktuell prognos.'}
              {' '}
              <button type="button" className="btn btn-ghost" onClick={handleRefreshPredicted}>
                Uppdatera förväntade rader
              </button>
            </div>
          )}
          {pendingEntries.length > 0 && (
            <div className="prognos-block">
              <div className="card-head">
                <h2>Nästa avisering <span className="card-en">· expected next charge</span></h2>
                <span className="count-pill">{shownPending.length}</span>
                {prognosParts.length > 1 && (
                  <div className="card-actions">
                    <Segmented value={effPrognosFilter} onChange={setPrognosFilter} ariaLabel="Filter expected charges"
                      options={[{ v: 'all', label: 'All' }, ...prognosParts.map(p => ({ v: p.id, label: p.label || 'part' }))]} />
                  </div>
                )}
              </div>
              <div className="prognos-head">
                {/* Total = what actually leaves the account: the betalningar
                    (each already contains its ränta) plus any legacy separate
                    amortering — i.e. Σ gross per part, never entry amounts,
                    which would double-count the ränta inside betalningen. */}
                <div className="metric-chip is-accent">
                  <span className="metric-label">Nästa avisering</span>
                  <span className="metric-val">~{fmtMoney(shownCharges.reduce((s, r) => s + r.gross, 0))}</span>
                  <span className="metric-sub">
                    varav ränta {fmtMoney(shownCharges.reduce((s, r) => s + r.interest, 0))}
                    {' · amortering '}{fmtMoney(shownCharges.reduce((s, r) => s + r.amortization, 0))}
                  </span>
                </div>
                {shownPending.length > 1 && (
                  <button type="button" className="btn btn-ghost prognos-log-btn prognos-log-all" onClick={() => handleLogPredicted(shownPending)}>
                    Logga alla förväntade rader
                  </button>
                )}
              </div>
              {/* Same table shell as Betalningar below: every upcoming
                  transaction is its own row — the ränta and its companion
                  (the bank's betalning, or a legacy amortering) stand alone,
                  each with its own log button and double-log guard. The
                  coming-months preview appends read-only rows to the SAME
                  tbody when expanded. */}
              <div className="table-wrap">
                <table className="data-table table-cards prognos-table">
                  <thead><tr><th className="col-date">Månad</th><th>Lånedel</th><th>Typ</th><th className="num">Sats</th><th className="num">Belopp</th><th>Status</th><th className="col-act"></th></tr></thead>
                  <tbody>
                    {shownPending.map(e => {
                      const r = e.charge
                      const isInterest = e.kind === 'interest'
                      const miscalibrated = isInterest && r.calibration_gap != null && Math.abs(r.calibration_gap) > 0.1
                      // Amorteringsgrad: annualized amortering as % of the loan's
                      // ORIGINAL size — amorteringskravets bas. Dividing by the
                      // current balance would drift the 1/2/3 % tiers upward as
                      // the loan amortizes.
                      const amortPct = r.original_balance > 0 ? (r.amortization / r.period_months) * 12 / r.original_balance * 100 : 0
                      const pct = isInterest ? r.rate : (amortPct > 0 ? amortPct : null)
                      return (
                        <Fragment key={r.loan_part_id + ':' + e.kind}>
                          <tr className="prognos-row">
                            <td className="col-date">{fmtChargeMonth(r.next_date)}</td>
                            <td className="col-part">{partNameById(r.loan_part_id)}</td>
                            <td className="col-kind">
                              <span className={'kind-tag kind-' + e.kind}>{kindLabel(e.kind)}</span>
                            </td>
                            <td className="num col-rate">{pct != null ? fmtPct(pct) : '—'}</td>
                            <td className="num col-amount">~{fmtMoney(e.amount)}</td>
                            <td className="col-status">
                              {isInterest ? (
                                <span className={'conf-badge' + (r.confidence === 'exact' ? ' is-exact' : r.confidence === 'unknown' ? ' is-unknown' : '')}>
                                  {r.confidence === 'exact' ? '≈ exakt' : r.confidence === 'assumed' ? '≈ est.' : '≈ okalibrerad'}
                                </span>
                              ) : r.amortization_source === 'declared' && (
                                <span className="conf-badge is-exact" title="Planerad amortering — deklarerad, inte framräknad ur historiken">deklarerad</span>
                              )}
                            </td>
                            <td className="col-act">
                              <button type="button" className="btn btn-ghost prognos-log-btn" onClick={() => handleLogPredicted([e])}>
                                Logga förväntad rad
                              </button>
                            </td>
                          </tr>
                          {miscalibrated && (
                            <tr className="prognos-detail">
                              <td colSpan={7}>
                                listad {fmtPct(r.rate! + r.calibration_gap!)} vs debiterad {fmtPct(r.rate!)} — day-count eller ologgad ränteändring
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                    {/* Read-only preview of the coming year's avier: rate held
                        flat, balance stepping down by amorteringen each period.
                        Nothing here is loggable — only the next month is due. */}
                    {showFuture && shownFuture.map(e => {
                      const r = e.charge
                      const isInterest = e.kind === 'interest'
                      const amortPct = r.original_balance > 0 ? (r.amortization / r.period_months) * 12 / r.original_balance * 100 : 0
                      const pct = isInterest ? r.rate : (amortPct > 0 ? amortPct : null)
                      return (
                        <tr key={r.loan_part_id + ':' + e.kind + ':' + r.next_date} className="prognos-row is-future">
                          <td className="col-date">{fmtChargeMonth(r.next_date)}</td>
                          <td className="col-part">{partNameById(r.loan_part_id)}</td>
                          <td className="col-kind">
                            <span className={'kind-tag kind-' + e.kind}>{kindLabel(e.kind)}</span>
                          </td>
                          <td className="num col-rate">{pct != null ? fmtPct(pct) : '—'}</td>
                          <td className="num col-amount">~{fmtMoney(e.amount)}</td>
                          <td className="col-status">
                            {!isInterest && r.amortization_source === 'declared' && (
                              <span className="conf-badge is-exact" title="Planerad amortering — deklarerad, inte framräknad ur historiken">deklarerad</span>
                            )}
                          </td>
                          <td className="col-act" />
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {shownFuture.length > 0 && (
                <button type="button" className="btn btn-ghost prognos-more-btn" onClick={() => setShowFuture(v => !v)}>
                  {showFuture ? 'Dölj kommande månader' : `Visa kommande månader (${shownFuture.length})`}
                </button>
              )}
            </div>
          )}
          <div className="card-head" id="betalningar">
            <h2>Betalningar <span className="card-en">· Payments</span></h2>
            <span className="count-pill">{filteredPayments.length}</span>
            <div className="card-actions">
              <Segmented value={paymentFilter} onChange={setPaymentFilter} ariaLabel="Filter payments"
                options={[{ v: 'all', label: 'All' }, ...parts.map(p => ({ v: p.id, label: p.label || 'part' }))]} />
              <button type="button" className="btn btn-ghost" onClick={() => setPayDlg({ open: true, id: null })}>+ Lägg till</button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger className="icon-btn" aria-label="More payment actions" title="More actions">
                  <Icon icon={EllipsisVertical} size={16} />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="kebab-menu" align="end" sideOffset={6}>
                    <DropdownMenu.Item className="kebab-item kebab-danger" disabled={!filteredPayments.length} onSelect={clearPayments}>
                      {paymentFilter === 'all' ? 'Delete all' : 'Delete ' + partNameById(paymentFilter)}
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
          </div>
          <p className="contrib-note">Saldo är utgångspunkten för lånedelen. Bara betalningar och amorteringar med senare datum ändrar visad skuld; samma dags eller äldre rader kan redan ingå i Saldo.</p>
          <motion.div key={paymentFilter} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.13, ease: [0.22, 1, 0.36, 1] }}>
            {!filteredPayments.length ? (
              <p className="empty">{payments.length ? 'No payments for this loan part.' : 'No payments yet. Import a statement above, or add one manually.'}</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table table-cards payments-table">
                  <thead><tr><th className="col-date">Date</th><th>Loan part</th><th>Type</th><th className="num">Amount</th><th className="num">Balance</th><th className="col-act"></th></tr></thead>
                  <tbody>
                    {shownPayments.map(p => {
                      const isExp = expandedPays.has(p.id)
                      return (
                      <Fragment key={p.id}>
                        <tr className={(p.is_insats ? 'is-insats' : '') + (isExp ? ' is-expanded' : '')}>
                          <td className="col-date">
                            {/* The chevron slot is reserved on EVERY row (empty
                                on non-insats rows) so the date text always
                                starts at the same x — insats rows no longer
                                shunt their date to the right. */}
                            <span className="pay-date-slot">
                              {p.is_insats && (
                                <motion.button
                                  type="button"
                                  className="icon-btn expand-btn"
                                  title={isExp ? 'Hide allocation' : 'Show allocation'}
                                  aria-expanded={isExp}
                                  onClick={() => toggleExpandPay(p.id)}
                                  animate={{ rotate: isExp ? 90 : 0 }}
                                  transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
                                ><Icon icon={ChevronRight} size={12} /></motion.button>
                              )}
                            </span>
                            {p.date || '—'}
                          </td>
                          <td className="col-part">{partNameById(p.loan_part_id)}</td>
                          <td className="col-kind"><span className={'kind-tag kind-' + (p.kind || 'other')}>{kindLabel(p.kind)}</span>{p.source === 'predicted' && <span className="row-flag row-flag-predicted">förväntad</span>}{p.kind === 'amortization' && p.is_insats && <span className="row-flag row-flag-insats">extra amortering</span>}{estimatedPaymentIds.has(p.id) && <span className="row-flag row-flag-estimated">ränta saknas · uppskattat</span>}</td>
                          <td className="num col-amount">{fmtMoney(p.amount)}</td>
                          <td className="num col-balance">{p.balance_after != null ? fmtMoney(p.balance_after) : '—'}</td>
                          <td className="col-act">
                            <button type="button" className="icon-btn" title="Edit" aria-label="Edit" onClick={() => setPayDlg({ open: true, id: p.id })}><Icon icon={Pencil} /></button>
                            {parts.length > 1 && (
                              <button type="button" className="icon-btn" title="Copy to parts" aria-label="Copy to parts" onClick={() => setCopyDlg({ open: true, source: p })}><Icon icon={Copy} /></button>
                            )}
                            <button type="button" className="icon-btn" data-del-pay title="Delete" aria-label="Delete" onClick={() => { if (confirm('Delete this payment?')) handleDeletePay(p.id) }}><Icon icon={X} /></button>
                          </td>
                        </tr>
                        <AnimatePresence initial={false}>
                          {p.is_insats && isExp && (
                            <motion.tr key="detail" className="pay-detail">
                              <td colSpan={6}>
                                <CellReveal reduce={reduceMotion}>
                                <div className="pay-detail-inner">
                                  <span className="pay-detail-label">Betalad av</span>
                                  {p.paid_split ? (
                                    <>
                                      <span className="alloc-chip"><b>{nameOf('a')}</b> {fmtMoney(p.paid_split.a)}</span>
                                      <span className="alloc-chip"><b>{nameOf('b')}</b> {fmtMoney(p.paid_split.b)}</span>
                                    </>
                                  ) : (
                                    <span className="alloc-chip">{p.paid_by === 'joint'
                                      ? 'Gemensamt · enligt ägarfördelning'
                                      : <><b>{nameOf(p.paid_by === 'b' ? 'b' : 'a')}</b> {fmtMoney(p.amount)}</>}</span>
                                  )}
                                  {p.description && <span className="pay-detail-note">{p.description}</span>}
                                </div>
                                </CellReveal>
                              </td>
                            </motion.tr>
                          )}
                        </AnimatePresence>
                      </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </motion.div>
          {(hiddenPayCount > 0 || payVisible > PAY_PAGE) && (
            <div className="table-more">
              {hiddenPayCount > 0 && (
                <button type="button" className="btn btn-ghost" onClick={() => setPayVisible(v => v + PAY_PAGE)}>
                  Visa fler <span className="card-en">· Show {Math.min(PAY_PAGE, hiddenPayCount)} more</span>
                  <span className="more-count">{hiddenPayCount} left</span>
                </button>
              )}
              {payVisible > PAY_PAGE && (
                <button type="button" className="link-btn" onClick={() => setPayVisible(PAY_PAGE)}>Show less</button>
              )}
            </div>
          )}
        </section>

        {/* ── Linked canonical projections — neither section owns its own data. */}
        <section className="card" id="kontantinsatser">
          <div className="card-head">
            <h2>Kontantinsatser</h2>
            <span className="count-pill">{downPayments.length}</span>
            <div className="card-actions"><a className="btn btn-ghost" href="#betalningar">Öppna Betalningar</a></div>
          </div>
          <p className="contrib-note">Källposter av typen Kontantinsats. Redigera eller ta bort dem i samma Betalningar-liggare.</p>
          {!downPayments.length ? <p className="empty">Inga kontantinsatser ännu.</p> : (
            <div className="table-wrap">
              <table className="data-table table-cards insats-table">
                <thead><tr><th className="col-date">Datum</th><th>Betalad av</th><th>Lånedel</th><th className="num">Belopp</th><th className="col-act" /></tr></thead>
                <tbody>{downPayments.map(p => (
                  <tr key={p.id} data-source-payment-id={p.id}>
                    <td className="col-date">{p.date || '—'}</td>
                    <td className="col-owner">{p.paid_split ? `${nameOf('a')} ${fmtMoney(p.paid_split.a)} · ${nameOf('b')} ${fmtMoney(p.paid_split.b)}` : p.paid_by === 'joint' ? 'Gemensamt' : nameOf(p.paid_by)}</td>
                    <td className="col-part">—</td>
                    <td className="num col-amt">{fmtMoney(p.amount)}</td>
                    <td className="col-act"><button type="button" className="icon-btn" title="Redigera i Betalningar" aria-label="Redigera i Betalningar" onClick={() => setPayDlg({ open: true, id: p.id })}><Icon icon={Pencil} /></button><button type="button" className="icon-btn" title="Ta bort" aria-label="Ta bort" onClick={() => { if (confirm('Ta bort betalningen?')) handleDeletePay(p.id) }}><Icon icon={X} /></button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card" id="extra-amorteringar">
          <div className="card-head">
            <h2>Extra amorteringar</h2>
            <span className="count-pill">{extraAmortizationPayments.length}</span>
            <div className="card-actions"><a className="btn btn-ghost" href="#betalningar">Öppna Betalningar</a></div>
          </div>
          <p className="contrib-note">Källposter av typen Extra amortering. Vanliga amorteringar visas bara i Betalningar.</p>
          {!extraAmortizationPayments.length ? <p className="empty">Inga extra amorteringar ännu.</p> : (
            <div className="table-wrap">
              <table className="data-table table-cards insats-table">
                <thead><tr><th className="col-date">Datum</th><th>Betalad av</th><th>Lånedel</th><th className="num">Belopp</th><th className="col-act" /></tr></thead>
                <tbody>{extraAmortizationPayments.map(p => (
                  <tr key={p.id} data-source-payment-id={p.id}>
                    <td className="col-date">{p.date || '—'}</td>
                    <td className="col-owner">{p.paid_split ? `${nameOf('a')} ${fmtMoney(p.paid_split.a)} · ${nameOf('b')} ${fmtMoney(p.paid_split.b)}` : p.paid_by === 'joint' ? 'Gemensamt' : nameOf(p.paid_by)}</td>
                    <td className="col-part">{partNameById(p.loan_part_id)}</td>
                    <td className="num col-amt">{fmtMoney(p.amount)}</td>
                    <td className="col-act"><button type="button" className="icon-btn" title="Redigera i Betalningar" aria-label="Redigera i Betalningar" onClick={() => setPayDlg({ open: true, id: p.id })}><Icon icon={Pencil} /></button><button type="button" className="icon-btn" title="Ta bort" aria-label="Ta bort" onClick={() => { if (confirm('Ta bort betalningen?')) handleDeletePay(p.id) }}><Icon icon={X} /></button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>

        </>)}

      </main>

      {/* ── Dialogs ── */}
      <PartDialog open={partDlg.open} id={partDlg.id} parts={parts} periods={periods} payments={payments}
        onSave={handleSavePart} onDelete={handleDeletePart} onClose={() => setPartDlg({ open: false, id: null })}
        onSavePeriod={handleSavePeriod} onDeletePeriod={handleDeletePeriod} />
      <ValuationDialog open={valDlg.open} id={valDlg.id} valuations={valuations} onSave={handleSaveVal} onDelete={handleDeleteVal} onClose={() => setValDlg({ open: false, id: null })} />
      <PaymentDialog open={payDlg.open} id={payDlg.id} payments={payments} parts={parts} settings={settings} onSave={handleSavePay} onDelete={handleDeletePay} onClose={() => setPayDlg({ open: false, id: null })} />
      <CopyToPartsDialog open={copyDlg.open} source={copyDlg.source} parts={parts} onConfirm={ids => copyDlg.source && handleCopyToParts(copyDlg.source, ids)} onClose={() => setCopyDlg({ open: false, source: null })} />
      <SettingsDialog open={settingsDlg} settings={settings} onSave={handleSaveSettings} onClose={() => setSettingsDlg(false)}
        onExportJSON={handleExportJSON} onExportCSV={handleExportCSV} onImportJSON={handleImportJSON} />

      {/* ── Toast ── */}
      <div className={'bk-toast' + (toast.show ? ' show' : '')} role="status" aria-live="polite">{toast.msg}</div>
    </div>
  )
}
