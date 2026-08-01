import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ChevronRight, Copy, EllipsisVertical, Pencil, Percent, Settings2, X } from 'lucide-react'
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
import { usePersonIdentity } from '../components/usePersonIdentity'
import { PersonLabel } from '../components/PersonBadge'
import { openHouseholdDialog } from '../components/HouseholdMenu'
import { useConfirm } from '../components/useConfirm'
import { useToolPageActive } from '../lib/toolTransition'
import {
  parseCsv, parseAmount, autoMapColumns, classifyKind,
  makePayment, flagDuplicates, assignPaymentsToPart,
  partBalance, totalBalance, totalAmortized, totalInterest, ranteavdrag, resolvePartBalance,
  propertyValue, equity, loanToValue,
  purchasePrice, costBasisEquity, costBasisOwnedPct, costBasisSplit, marketEquitySplit, derivedDeposit,
  effectiveRatePeriod, groupLoanParts, weightedAvgRate, amorteringskravStatus,
  partsForMortgage, paymentsForMortgage, partsMissingRateTerms, partsMissingCurrentRateTerms,
  activeAgreementParts as activeAgreementPartsScope, activeAgreementPayments as activeAgreementPaymentsScope,
  equityTimeline, equityBridge, projectMilestones, monthlyAmortizationRate, monthlyCost, rateWhatIf,
  expectedCharges, forecastInterest, reconcileCharge, matchPredictedRows, hasChargeInMonth, pendingChargeSeries, monthKey, stalePredictedRows,
  paymentsToCsv, headerSignature, mappingToNames, applyPreset, reconcileBalance,
  todayISO,
  bankForPart, suggestBankProfile, effectiveBankProfile,
  isExtraAmortering, extraAmorteringAllocation,
  upcomingRatePeriods,
} from '../lib/mortgage'
import type { LoanPart, LoanPartGroup, Payment, CsvResult, ColMapping, Owner, ExpectedCharge, Mortgage, CatalogBank, EffectiveBankProfile } from '../lib/mortgage'
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
import PeriodDialog from './bolanekoll/PeriodDialog'
import ValuationDialog from './bolanekoll/ValuationDialog'
import PaymentDialog from './bolanekoll/PaymentDialog'
import CopyToPartsDialog from './bolanekoll/CopyToPartsDialog'
import SettingsDialog from './bolanekoll/SettingsDialog'
import BankProfileDialog from './bolanekoll/BankProfileDialog'
import AgreementDialog from './bolanekoll/AgreementDialog'
import BankChangeWizard from './bolanekoll/BankChangeWizard'
import AgreementHistoryDialog from './bolanekoll/AgreementHistoryDialog'
import { CellReveal, kindLabel, buildPayBuckets, periodFrom, monthsToWhen, fmtMoney, fmtPct, M, P, currencyState, type TriageRow, type ImportCfg } from './bolanekoll/shared'
import { useMortgageWorkspace, type PendingChargeKind } from './bolanekoll/useMortgageWorkspace'

// The hero reprice notice appears only inside the final month before the
// villkorsändring — before that, the date lives in the Lånedelar ledger.
const REPRICE_NOTICE_DAYS = 31

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

/** Swedish enumeration for a short list of names: "A", "A och B",
 * "A, B och C". Display formatting only — the list itself is decided in
 * lib/mortgage. */
function swedishList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return names.slice(0, -1).join(', ') + ' och ' + names[names.length - 1]
}

/** "om 1 dag" / "om 2 dagar" — the Kommande band's countdown chip (plan 127
 * §4). Correct Swedish singular/plural only; `n` is always >= 1 here because
 * `upcomingRatePeriods` never returns a group starting today or earlier. */
function omDagarLabel(n: number): string {
  return 'om ' + n + ' dag' + (n === 1 ? '' : 'ar')
}

/** The rate input is deliberately stricter than parseAmount(): a trailing
 * decimal separator is normal while typing, but must not become 0 % (or a
 * silently truncated saved value) when the field loses focus. */
function parseScenarioRate(raw: string): number | null {
  const normalized = raw.trim().replace(',', '.')
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null
  const value = Number(normalized)
  return Number.isFinite(value) && value >= 0 ? value : null
}

// The change banner is a nudge about NEWS — after this many days the new rate
// is just "the rate" and the banner stays quiet even if never dismissed
// (a first visit shouldn't announce a nine-month-old cut).
const RATE_CHANGE_NEWS_DAYS = 60

// ── Main component ─────────────────────────────────────────────────────────

export default function Bolanekoll() {
  const active = useToolPageActive('/bolanekoll')
  useLayoutEffect(() => { document.documentElement.classList.remove('calc-layout') }, [])

  const {
    state: { banks, catalogBanks, mortgages, parts, payments, valuations, periods, contributions, settings, loaded },
    selection: { activeMortgage, activeBank },
    feedback: { toast, saved, showToast, flashSaved, showError: saveErr },
    actions: workspaceActions,
  } = useMortgageWorkspace()
  const { refresh, settings: settingsActions } = workspaceActions
  const confirm = useConfirm()
  const [bridgePeriod, setBridgePeriod] = useState<'ytd' | '12m' | 'all'>('ytd')
  const [extraAmort, setExtraAmort] = useState('')
  // Rate what-if: null means no local draft. The display then follows the saved
  // household assumption, or the live blended prefill when that is also null.
  const [whatIfRate, setWhatIfRate] = useState<string | null>(null)
  const [scenarioRateError, setScenarioRateError] = useState('')
  // Whole-household shared costs (joint costs only) pulled from Hushållsbudget,
  // for the rate what-if's "total per month" chips. null until loaded / no budget.
  const [householdCosts, setHouseholdCosts] = useState<number | null>(null)
  const [paymentFilter, setPaymentFilter] = useState('all')
  // Betalningar discloses one calendar month at a time (plan 115): 1 = only
  // the newest populated month, 'all' = every bucket, N = the N newest buckets.
  const [payMonthsShown, setPayMonthsShown] = useState<number | 'all'>(1)
  const [isDragging, setIsDragging] = useState(false)
  const [importCfg, setImportCfg] = useState<ImportCfg | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const whatIfRateRef = useRef<HTMLInputElement>(null)
  const savedScenarioRateRef = useRef<number | null>(settings.what_if_rate_pct)
  const scenarioRateSavingRef = useRef<number | null>(null)

  const [partDlg, setPartDlg] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  // Plan 127 §2 — the ONE standalone PeriodDialog instance for the whole page:
  // a row's percent action and PartDialog's rate-history editor both target
  // this same state, so a correction never stacks on top of another dialog.
  const [periodDlg, setPeriodDlg] = useState<{ open: boolean; partId: string | null; id: string | null }>({ open: false, partId: null, id: null })
  const [valDlg, setValDlg] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  const [payDlg, setPayDlg] = useState<{ open: boolean; id: string | null }>({ open: false, id: null })
  const [copyDlg, setCopyDlg] = useState<{ open: boolean; source: Payment | null }>({ open: false, source: null })
  const [expandedPays, setExpandedPays] = useState<Set<string>>(new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const groupsSeeded = useRef(false)
  const [avslutadeOpen, setAvslutadeOpen] = useState(false)
  // Plan 127 §4 — the Kommande band starts collapsed, same as Avslutade.
  const [kommandeOpen, setKommandeOpen] = useState(false)
  const reduceMotion = useReducedMotion()
  const [settingsDlg, setSettingsDlg] = useState(false)
  const [profileDlg, setProfileDlg] = useState(false)
  const [createDlg, setCreateDlg] = useState(false)
  const [changeDlg, setChangeDlg] = useState(false)
  const [historyDlg, setHistoryDlg] = useState(false)

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

  useEffect(() => { document.title = (settings.property_name || 'Bolånekoll') + ' · Hemma·OS' }, [settings.property_name])
  useEffect(() => { savedScenarioRateRef.current = settings.what_if_rate_pct }, [settings.what_if_rate_pct])
  // Pull the household's shared-cost total from Hushållsbudget once, for the
  // rate what-if's "total per month" chips. Read-only: never writes the budget.
  useEffect(() => { let live = true; loadBudget().then(b => { if (live && b) setHouseholdCosts(computeBudget(b).costsJoint) }); return () => { live = false } }, [])
  // Collapse the ledger back to just the newest month whenever the part filter changes.
  useEffect(() => { setPayMonthsShown(1) }, [paymentFilter])

  const { nameOf } = usePersonNames(settings.owner_a_name, settings.owner_b_name)

  // ── Derived data ───────────────────────────────────────────────────────────
  const today = todayISO()

  // Plan 103 — the active mortgage the UI surfaces (the model supports many; we
  // show one). First non-archived, else the first. Legacy data with no mortgage
  // → null, and the Lånedelar list renders flat, exactly as before. The
  // `?? mortgages[0]` fallback is deliberate legacy tolerance (plan 103): a
  // household whose only agreement predates end_date/archived semantics (and may
  // carry archived=true) still surfaces its parts rather than vanishing — so we
  // keep it rather than the stricter domain activeMortgage(), which returns null
  // when every agreement is archived.
  // Plan 109c — the ACTIVE-agreement view scope. The bank-change RPC archives the
  // AGREEMENT (mortgages.archived + end_date), never the old agreement's loan
  // parts, so filtering by a part's own `archived` flag would keep an old
  // agreement's parts in the ACTIVE ledger and merge both agreements' balances
  // (plan 109 decision 6; mortgage.ts "Agreement scoping"). Active scoping must
  // go through the mortgage link. Legacy parts with no agreement link
  // (mortgage_id null — possible via old JSON import) stay VISIBLE here in a
  // repair state with an "ej kopplad" indicator, rather than disappearing or
  // being silently adopted by the active agreement.
  const activeViewParts = useMemo(
    () => activeAgreementPartsScope(parts, activeMortgage?.id ?? null),
    [parts, activeMortgage])
  // Ledger rows in the active view: part-linked rows via the active-view parts;
  // partless rows (down payments) via their own agreement provenance, keeping
  // unlinked legacy rows visible. Old agreement transactions live in the history
  // modal, not here (plan 109 decision 6/7).
  const activeViewPayments = useMemo(
    () => activeAgreementPaymentsScope(payments, activeViewParts, activeMortgage?.id ?? null),
    [payments, activeViewParts, activeMortgage])
  // The live ledger (non-archived active-view parts) and this agreement's own
  // settled/restructured parts (its "Avslutade" list) — NOT the old bank's
  // parts, which are reached through the history modal.
  const activeParts = useMemo(() => activeViewParts.filter(p => !p.archived), [activeViewParts])
  const archivedParts = useMemo(() => activeViewParts.filter(p => p.archived), [activeViewParts])
  // Plan 127 §4 — Kommande band: future rate periods on the live Lånedelar
  // rows only (`activeParts`, never archived/other-agreement parts), grouped
  // by the day they take effect. Pure grouping/counting lives in
  // upcomingRatePeriods; this component only renders what it returns.
  const upcoming = useMemo(() => upcomingRatePeriods(activeParts, periods, today), [activeParts, periods, today])

  const balance = useMemo(() => totalBalance(activeViewParts, activeViewPayments), [activeViewParts, activeViewPayments])
  // The balance resolver is also the provenance source for the dashboard: a
  // provisional Betalning must never look like an observed Saldo result.
  const balanceResolutions = useMemo(
    () => new Map(activeParts.map(p => [p.id, resolvePartBalance(p, payments)])),
    [activeParts, payments],
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
  const marketSplit = useMemo(() => marketEquitySplit(value, balance, payments, contributions, settings), [value, balance, payments, contributions, settings])
  const deposit = useMemo(() => derivedDeposit(price, parts, payments), [price, parts, payments])
  const downPayments = useMemo(() => payments.filter(p => p.kind === 'down_payment'), [payments])
  const extraAmortizationPayments = useMemo(
    () => payments.filter(p => p.kind === 'amortization' && p.is_insats),
    [payments],
  )
  const timeline = useMemo(() => equityTimeline(parts, payments, valuations, settings, contributions), [parts, payments, valuations, settings, contributions])

  const loanGroups = useMemo(() => groupLoanParts(activeViewParts, periods, activeViewPayments, today), [activeViewParts, periods, activeViewPayments, today])
  // Next villkorsändring for the hero note: the soonest dated group. loanGroups
  // is already ordered expired-first then by ascending end_date, so the first
  // dated group IS the next (or most-overdue) reprice — and it carries what the
  // bare date can't: how much of the loan moves, and off which rate.
  const nextReprice = useMemo(() => loanGroups.find(g => !g.is_catchall && g.days_left != null) ?? null, [loanGroups])

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
  // `active` adds the one-click "Ny räntesats" action (plan 127 §2) — only for
  // the live Lånedelar rows, never the Avslutade (archived) list, which reuses
  // this same function for its Edit/Ta bort pair.
  const partActs = (p: LoanPart, active?: boolean) => (
    <>
      {active && (
        <button type="button" className="icon-btn" title="Ny räntesats" aria-label="Ny räntesats"
          onClick={() => setPeriodDlg({ open: true, partId: p.id, id: null })}>
          <Icon icon={Percent} />
        </button>
      )}
      <button type="button" className="icon-btn" title="Edit" aria-label="Edit" onClick={() => setPartDlg({ open: true, id: p.id })}><Icon icon={Pencil} /></button>
      <button type="button" className="icon-btn" data-del-part title="Ta bort" aria-label="Ta bort" onClick={async () => { if (await confirm({ title: 'Ta bort lånedelen?', message: 'Alla dess betalningar och ränteperioder tas bort. Det går inte att ångra.' })) handleDeletePart(p.id) }}><Icon icon={X} /></button>
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
  // Plan 126 §2 — the blended rate (and the Prognos "Nu (…)" label it feeds) is
  // a CURRENT figure, so it reads the periods covering `today`, the same
  // captured day the groups and member badges use. A part with no current
  // coverage contributes nothing rather than contributing a future rate.
  const blended = useMemo(() => weightedAvgRate(activeViewParts, periods, activeViewPayments, today), [activeViewParts, periods, activeViewPayments, today])
  const krav = useMemo(() => amorteringskravStatus(activeViewParts, activeViewPayments, valuations, settings), [activeViewParts, activeViewPayments, valuations, settings])

  const extra = Math.max(0, parseAmount(extraAmort) || 0)
  const base = useMemo(() => monthlyAmortizationRate(activeViewParts, activeViewPayments), [activeViewParts, activeViewPayments])
  const ms = useMemo(() => projectMilestones(activeViewParts, activeViewPayments, valuations, settings, { extraMonthly: extra }), [activeViewParts, activeViewPayments, valuations, settings, extra])
  // Rate what-if — derive the editable value rather than seeding via effect, so
  // an untouched null setting continues to track an async-loaded blended rate.
  // Takes `base` (observed amortization), NOT `extra`: the rate comparison
  // ignores the extra-amortering input (plan 82, decision 7).
  const savedScenarioRate = settings.what_if_rate_pct
  const fallbackScenarioRate = savedScenarioRate ?? blended
  const shownScenarioRate = whatIfRate ?? fallbackScenarioRate.toFixed(2)
  const draftScenarioRate = whatIfRate == null ? null : parseScenarioRate(whatIfRate)
  const hypRate = draftScenarioRate ?? fallbackScenarioRate

  async function commitScenarioRate(draft: string): Promise<void> {
    const rate = parseScenarioRate(draft)
    if (rate == null) {
      setScenarioRateError('Ange en giltig ränta på 0 % eller mer.')
      whatIfRateRef.current?.focus()
      return
    }
    // Enter may be followed by blur. Once this exact value is persisted (or is
    // already being written), that second browser event must not create a
    // second cloud mutation or a misleading second success flash.
    if (rate === savedScenarioRateRef.current || rate === scenarioRateSavingRef.current) {
      setWhatIfRate(rate.toFixed(2))
      setScenarioRateError('')
      return
    }
    setScenarioRateError('')
    scenarioRateSavingRef.current = rate
    try {
      const saved = await settingsActions.save({ what_if_rate_pct: rate })
      if (saved) {
        savedScenarioRateRef.current = rate
        setWhatIfRate(rate.toFixed(2))
        return
      }
      // The workspace action surfaces the persistence category in its existing
      // toast. Keep this targeted message beside the draft as a retry cue.
      setScenarioRateError('Kunde inte spara räntan. Försök igen.')
      whatIfRateRef.current?.focus()
    } finally {
      scenarioRateSavingRef.current = null
    }
  }

  function adjustScenarioRate(delta: number): void {
    const draft = Math.max(0, hypRate + delta).toFixed(2)
    setWhatIfRate(draft)
    setScenarioRateError('')
    void commitScenarioRate(draft)
  }
  // Amortering in the what-if = observed monthly amortering + whatever's typed in
  // "Extra amortering", so nu/vid read as the full monthly payment (interest +
  // amortering), not interest alone.
  const whatIf = useMemo(() => rateWhatIf(balance, blended, hypRate, base + extra, householdCosts ?? 0), [balance, blended, hypRate, base, extra, householdCosts])

  // Expected next charge (plan 23): arithmetic from stored data — balance ×
  // rate × days/365 — calibrated against the real charge history. Read-only
  // here; writes happen only via the explicit log button / import supersede.
  // Plan 104 — thread the bank entities (and the full part list) into the
  // forecast so a declared lock overrides detection AND the year-basis learner
  // can pool evidence across all of a bank's parts (phase 2). Plan 126 adds the
  // catalogue rows so the forecast resolves the SAME effectiveBankProfile the
  // Bankvillkor panel displays — without them a curated catalogue convention
  // would be shown in the UI but silently ignored when pricing the charge.
  const forecastOpts = useMemo(() => ({ banks, mortgages, parts: activeViewParts, catalogBanks }),
    [banks, mortgages, activeViewParts, catalogBanks])
  const prognos = useMemo(() => expectedCharges(activeViewParts, periods, activeViewPayments, forecastOpts), [activeViewParts, periods, activeViewPayments, forecastOpts])
  // Plan 104 (phase 2) — the parts on the active bank, the learner's suggestion
  // for them, and any drift between a declared lock and the fresh evidence.
  const activeBankParts = useMemo(
    () => activeBank ? parts.filter(p => bankForPart(p, mortgages, banks)?.id === activeBank.id) : [],
    [activeBank, parts, mortgages, banks])
  const bankSuggestion = useMemo(
    () => activeBank ? suggestBankProfile(activeBankParts, periods, payments) : null,
    [activeBank, activeBankParts, periods, payments])
  // Plan 109b/c — the catalogue row backing the active bank, and the resolved
  // effective profile (declared lock > confident detection > catalogue > default)
  // with any convention drift. Drift drives the card badge; the full explanation
  // lives in the bank-profile modal.
  const activeCatalog = useMemo<CatalogBank | null>(
    () => activeBank?.catalog_id ? (catalogBanks.find(c => c.id === activeBank.catalog_id) ?? null) : null,
    [activeBank, catalogBanks])
  const effectiveProfile = useMemo<EffectiveBankProfile | null>(
    () => activeBank ? effectiveBankProfile(activeBank, activeCatalog, activeBankParts, periods, payments) : null,
    [activeBank, activeCatalog, activeBankParts, periods, payments])
  // How many agreements point at the active bank profile — so the modal can make
  // its household-wide reuse clear when a lock would affect several avtal.
  const agreementCount = useMemo(
    () => activeBank ? mortgages.filter(m => m && m.bank_id === activeBank.id).length : 0,
    [activeBank, mortgages])
  // Plan 109c — the active parts still lacking a current rate period. A fresh
  // agreement right after a bank change is entirely in this state (rates are
  // deliberately not copied); the card prompts for Lägg till räntevillkor until
  // every part has one, so the forecast never silently reads as 0 %.
  const missingRate = useMemo(() => partsMissingRateTerms(activeParts, periods), [activeParts, periods])
  // Plan 126 §2 — the other half of that split: parts that DO have räntevillkor,
  // but none covering `today` (a gap, a lapsed timeline, an all-future one, or
  // two overlapping rows). Such a part has no current rate anywhere — no Nästa
  // avisering, no group rate, catch-all placement — so it needs its own
  // explanation. Disjoint from `missingRate` by construction, so the two prompts
  // never both name the same part.
  const missingCurrentRate = useMemo(
    () => partsMissingCurrentRateTerms(activeParts, periods, today),
    [activeParts, periods, today])
  // Plan 109c — Ångra bankbyte is offered only while the new (active) agreement
  // is still pristine: no payment references its parts (or itself as a partless
  // down payment) and no rate period touches its parts. Computed client-side for
  // display; the revert RPC re-verifies before deleting anything.
  const activeAgreementParts = useMemo(
    () => activeMortgage ? partsForMortgage(parts, activeMortgage.id) : [],
    [parts, activeMortgage])
  const bankChangePredecessor = useMemo<Mortgage | null>(
    () => activeMortgage
      ? (mortgages.find(m => m && m.archived && m.id !== activeMortgage.id
          && (m.end_date ?? null) === (activeMortgage.start_date ?? null)) ?? null)
      : null,
    [mortgages, activeMortgage])
  const canRevertBankChange = useMemo(() => {
    if (!activeMortgage || !bankChangePredecessor) return false
    const partIds = new Set(activeAgreementParts.map(p => p.id))
    const hasPeriods = periods.some(pr => pr.loan_part_id && partIds.has(pr.loan_part_id))
    const hasPayments = paymentsForMortgage(payments, parts, activeMortgage.id).length > 0
    return !hasPeriods && !hasPayments
  }, [activeMortgage, bankChangePredecessor, activeAgreementParts, periods, payments, parts])
  const forecast = useMemo(() => forecastInterest(activeViewParts, periods, activeViewPayments), [activeViewParts, periods, activeViewPayments])
  // The next UNCOVERED charge per part: once a month is fully logged (or
  // imported), the Nästa avisering block rolls forward to the following month
  // rather than going quiet — there is always a next avisering to look at.
  const pendingSeries = useMemo(
    () => activeParts
      .map(p => pendingChargeSeries(p, periods, activeViewPayments, 12, forecastOpts))
      .filter(s => s.length > 0 && s[0].interest > 0),
    [activeParts, periods, activeViewPayments, forecastOpts])
  const pendingCharges = useMemo(() => pendingSeries.map(s => s[0]), [pendingSeries])
  // Flattened to ONE entry per upcoming transaction, mirroring the bank's avi:
  // per part a Ränta row and — when the ledger has betalning history — the
  // bank's Betalning row (the TOTAL debit, ränta + amortering; equal to the
  // ränta on an interest-only part). Ledgers without betalning rows keep the
  // legacy separate amortering line. Each line is individually loggable and
  // individually guarded.
  const chargeEntries = (r: ExpectedCharge): Array<{ charge: ExpectedCharge; kind: PendingChargeKind; amount: number }> => {
    const out: Array<{ charge: ExpectedCharge; kind: PendingChargeKind; amount: number }> = []
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
  // year's avier (each month at the rate of the period covering it, balance
  // stepping down each period).
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
    return activeParts.filter(p => ids.has(p.id))
  }, [pendingSeries, activeParts])
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
  const staleRows = useMemo(() => stalePredictedRows(activeViewParts, periods, activeViewPayments), [activeViewParts, periods, activeViewPayments])

  const reconcile = useMemo(() => reconcileBalance(activeViewParts, activeViewPayments).filter(r => {
    if (r.drift == null || r.start_balance == null) return false
    return Math.abs(r.drift) >= Math.max(r.start_balance * 0.01, 5000)
  }), [activeViewParts, activeViewPayments])

  const insightsReady = parts.length > 0 && valuations.length > 0 && payments.length > 0

  // ── Chart data (stacked area: my equity → partner → bank) ────────────────────
  // Resolve the timeline into display-ordered bands; negatives clip to 0 so the
  // stack never inverts (matches the old Chart.js Math.max(0, …)).
  // "Me" is a VIEW concern only (plan 111): when the signed-in account has a
  // Bolånekoll person binding it decides which of A/B is emphasized; an
  // unmapped account keeps the legacy `i_am` perspective, so existing
  // households look unchanged before reconciliation. A/B data, order and every
  // calculated value are person-independent and never move with this.
  const identityView = usePersonIdentity()
  const me: Owner = identityView.myToolSlot('bolanekoll') ?? (settings.i_am === 'b' ? 'b' : 'a')
  const other: Owner = me === 'a' ? 'b' : 'a'
  // The plan-111 "Du" treatment renders ONLY when the account is actually mapped
  // to a Bolånekoll slot — `mappedSlot` is null for an unmapped/unbound account,
  // so an existing household keeps today's display and no incorrect Du marker.
  const mappedSlot = identityView.myToolSlot('bolanekoll')
  const isSelf = (o: Owner) => mappedSlot === o
  const isOther = (o: Owner) => mappedSlot != null && mappedSlot !== o
  // Once bound, canonical names are the live display names; else fall back to the
  // legacy owner_a_name/owner_b_name via usePersonNames.
  const ownerName = (o: 'a' | 'b' | null | undefined) =>
    ((o === 'a' || o === 'b') ? identityView.personFor('bolanekoll', o)?.display_name : undefined) ?? nameOf(o)
  const ownerSplitName = (o: Owner, pct: number) => (
    <PersonLabel
      className="split-name"
      name={ownerName(o)}
      self={isSelf(o)}
      other={isOther(o)}
      suffix={<span className="split-pct"> · {fmtPct(pct)}</span>}
    />
  )
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
    const fallback = auto ? (activeParts[0]?.id || null) : (importPart || null)
    const loanNumbers = parsed.rows.map(r => mapping.loan_number == null ? null : (r[mapping.loan_number] ?? ''))
    // Imports land on the ACTIVE agreement's parts only — a bank statement is for
    // a current loan account, never an archived old-agreement part.
    const assigns = assignPaymentsToPart(loanNumbers, activeParts, { selectedPartId: fallback, auto })
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
    const importPart = mapping.loan_number != null ? '__auto__' : (activeParts[0]?.id || '')
    return { file, parsed, mapping, importPart, triage: buildTriage(parsed, mapping, importPart), queue: [], qIdx: 0 }
  }
  async function handleFiles(files: FileList | File[]) {
    const arr = Array.from(files).filter(f => f.name.endsWith('.csv') || f.type.includes('csv') || f.type.includes('text'))
    if (!arr.length) return
    if (!activeParts.length) { showToast('Add a loan part first, then import.'); return }
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
      if (!(await confirm({
        title: 'Räntan avviker från prognosen',
        message: 'Ränteändring, avgift eller extra amortering? Ersätt de godkända prognosraderna med de importerade beloppen?',
        lines,
        confirmLabel: 'Ersätt', cancelLabel: 'Behåll', danger: false,
      }))) return
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
    if (await workspaceActions.parts.save(data, partDlg.id)) {
      setPartDlg({ open: false, id: null })
    }
  }

  async function handleDeletePart(id: string) {
    if (await workspaceActions.parts.remove(id)) {
      setPartDlg({ open: false, id: null })
    }
  }
  const handleSaveBankProfile = workspaceActions.agreements.saveBankProfile
  const handleCreateAgreement = workspaceActions.agreements.create
  const handleChangeBank = workspaceActions.agreements.changeBank
  const handleRevertBankChange = workspaceActions.agreements.revertBankChange
  const handleSavePeriod = workspaceActions.parts.savePeriod
  const handleDeletePeriod = workspaceActions.parts.removePeriod
  const handleEnableTracking = workspaceActions.settings.enableContributionTracking
  const closePeriodDlg = () => setPeriodDlg({ open: false, partId: null, id: null })
  // Plan 127 §2 — "Ny räntesats" (a Lånedelar row action) and PartDialog's
  // rate-history editor both funnel through this: null periodId is a create,
  // a real one is a correction, and both open the SAME standalone dialog.
  function handleEditPeriod(partId: string, periodId: string | null) {
    setPartDlg({ open: false, id: null })
    setPeriodDlg({ open: true, partId, id: periodId })
  }
  function handleDeletePeriodFromDialog(id: string) {
    handleDeletePeriod(id)
    closePeriodDlg()
  }

  async function handleSaveVal(data: Parameters<typeof workspaceActions.valuations.save>[0]) {
    if (await workspaceActions.valuations.save(data, valDlg.id)) {
      setValDlg({ open: false, id: null })
    }
  }

  function toggleExpandPay(id: string) {
    setExpandedPays(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })
  }

  const openPayments = useCallback(() => {
    const target = document.getElementById('betalningar')
    if (!target) return
    target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
    target.focus({ preventScroll: true })
  }, [reduceMotion])

  async function handleDeleteVal(id: string) {
    if (await workspaceActions.valuations.remove(id)) {
      setValDlg({ open: false, id: null })
    }
  }

  async function handleSavePay(data: Parameters<typeof workspaceActions.payments.save>[0]) {
    if (await workspaceActions.payments.save(data, payDlg.id)) {
      setPayDlg({ open: false, id: null })
    }
  }

  async function handleDeletePay(id: string) {
    if (await workspaceActions.payments.remove(id)) {
      setPayDlg({ open: false, id: null })
    }
  }

  async function handleCopyToParts(source: Payment, targetIds: string[]) {
    if (await workspaceActions.payments.copy(source, targetIds)) {
      setCopyDlg({ open: false, source: null })
    }
  }

  async function handleSaveSettings(patch: Parameters<typeof workspaceActions.settings.save>[0]) {
    if (await workspaceActions.settings.save(patch)) {
      setSettingsDlg(false)
    }
  }

  const handleLogPredicted = workspaceActions.payments.logPredicted

  async function clearPayments() {
    const scoped = paymentFilter === 'all' ? activeViewPayments : activeViewPayments.filter(p => p.loan_part_id === paymentFilter)
    if (!scoped.length) return
    if (!(await confirm({ title: 'Delete ' + scoped.length + ' payment' + (scoped.length === 1 ? '' : 's') + '?', message: 'This can’t be undone.' }))) return
    await workspaceActions.payments.clear(scoped)
  }

  function handleExportCSV() {
    // The CSV mirrors the visible Betalningar ledger (the active agreement's
    // rows). The full backup — every agreement's history — is the JSON export.
    const csv = paymentsToCsv(activeViewPayments, activeViewParts)
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
  // Share column basis. When a köpeskilling is recorded, each loan part's Share
  // is measured against the purchase price rather than the loan alone, so the
  // parts sum to loan/price and the remainder up to 100% is Insatt kapital
  // (balance + costBasisEq ≡ price, see costBasisEquity in mortgage.ts). Without
  // a purchase price — or if the loan somehow exceeds it — fall back to the
  // loan-only basis so the column still reads 100 %.
  const insattShareActive = price > 0 && costBasisEq > 0
  const shareBasis = insattShareActive ? price : partsTotal

  const chronVals = useMemo(() => valuations.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))), [valuations])
  const maxVal = chronVals.reduce((mx, v) => Math.max(mx, Number(v.value) || 0), 0)

  const filteredPayments = paymentFilter === 'all' ? activeViewPayments : activeViewPayments.filter(p => p.loan_part_id === paymentFilter)
  // Month buckets over the already-ordered (newest-first) filtered ledger —
  // see buildPayBuckets in shared.tsx for the grouping contract.
  const payBuckets = useMemo(() => buildPayBuckets(filteredPayments), [filteredPayments])
  const visiblePayBucketCount = payMonthsShown === 'all' ? payBuckets.length : Math.min(payMonthsShown, payBuckets.length)
  const shownPayments = useMemo(
    () => payBuckets.slice(0, visiblePayBucketCount).flatMap(b => b.rows),
    [payBuckets, visiblePayBucketCount])
  const hiddenPayBucketCount = payBuckets.length - visiblePayBucketCount
  const nextPayBucket = payBuckets[visiblePayBucketCount] ?? null
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
            {/* Plan 109c — a mortgage agreement is the parent of the loan parts,
                so the first action creates the agreement (with its bank); loan
                parts can only be added once it exists. An agreement that exists
                but has no parts yet prompts for the first lånedel instead. */}
            {activeMortgage ? (
              <>
                <p className="empty-hero-text">Bolåneavtalet är skapat. Lägg till din första lånedel — en per lånekonto — för att börja; du kan importera kontoutdrag som CSV när den finns.</p>
                <div className="empty-hero-actions">
                  <button type="button" className="btn btn-primary" onClick={() => setPartDlg({ open: true, id: null })}>+ Lägg till lånedel</button>
                </div>
              </>
            ) : (
              <>
                <p className="empty-hero-text">Skapa ditt bolåneavtal — välj bank och startdatum — så följer du lånet del för del: kvarvarande skuld, eget kapital, belåningsgrad och vägen till att bli skuldfri.</p>
                <div className="empty-hero-actions">
                  <button type="button" className="btn btn-primary" onClick={() => setCreateDlg(true)}>Skapa bolåneavtal</button>
                </div>
              </>
            )}
          </div>
        </section>
        )
        ) : (<>

        {/* ── Dashboard: one hero (market equity), cost-basis as a secondary row ── */}
        <section className="card dashboard-card">
          <div className="dash-main">
            <p className="dash-label">Eget kapital · Marknadsvärde minus skuld</p>
            {hasValuation ? (
              <>
                <p className="dash-headline" data-market-equity={String(Math.round(eq))}>{M(eq, false, true)}</p>
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
                  {ownerSplitName('a', marketSplit.a_pct)}
                  <span className="split-val" data-owner-market-capital="a">{M(marketSplit.a, false, true)}</span>
                  <span className="split-sub">equity share</span>
                </div>
                <div className={'split-card' + (me === 'b' ? ' is-accent' : '')}>
                  {ownerSplitName('b', marketSplit.b_pct)}
                  <span className="split-val" data-owner-market-capital="b">{M(marketSplit.b, false, true)}</span>
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
                      {ownerSplitName('a', cbSplit.a_pct)}
                      <span className="split-val" data-owner-cost-capital="a">{M(cbSplit.a, false, true)}</span>
                      <span className="split-sub">paid in · insatt</span>
                    </div>
                    <div className={'split-card' + (me === 'b' ? ' is-accent' : '')}>
                      {ownerSplitName('b', cbSplit.b_pct)}
                      <span className="split-val" data-owner-cost-capital="b">{M(cbSplit.b, false, true)}</span>
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
                    mineLabel={ownerName(me) + '’s equity' + (mappedSlot ? ' · Du' : '')} partnerLabel={ownerName(other) + '’s equity'}
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
                      onMouseDown={event => event.preventDefault()}
                      onClick={() => adjustScenarioRate(-0.01)}>−</button>
                    <input type="text" id="whatIfRate" className="proj-input rate-input" inputMode="decimal" autoComplete="off"
                      ref={whatIfRateRef} value={shownScenarioRate}
                      aria-invalid={scenarioRateError ? true : undefined}
                      aria-describedby={scenarioRateError ? 'whatIfRate-error' : undefined}
                      onChange={e => { setWhatIfRate(e.target.value); setScenarioRateError('') }}
                      onBlur={e => { void commitScenarioRate(e.target.value) }}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void commitScenarioRate(e.currentTarget.value) } }} />
                    <button type="button" className="rate-step" aria-label="+0,01 procentenheter"
                      onMouseDown={event => event.preventDefault()}
                      onClick={() => adjustScenarioRate(0.01)}>+</button>
                  </div>
                  {scenarioRateError && <p id="whatIfRate-error" className="proj-note" role="alert">{scenarioRateError}</p>}
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
                    {activeParts.map(p => <option key={p.id} value={p.id}>{p.label || '(loan part)'}</option>)}
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
                              ? <span className="row-flag row-flag-match">✓ {t.recon.predicted ? 'ersätter godkänd prognosrad' : 'matchar prognosen'}</span>
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

        {/* ── Mortgage agreement (loan parts nested beneath) ── */}
        <section className="card">
          <div className="card-head">
            <h2>Bolåneavtal <span className="card-en">· Mortgage agreement</span></h2>
            <span className="count-pill">{activeViewParts.length}</span>
            <div className="card-actions">
              {(activeMortgage || parts.length > 0) && (
                <button type="button" className="btn btn-ghost" onClick={() => setPartDlg({ open: true, id: null })}>+ Lägg till lånedel</button>
              )}
            </div>
          </div>
          {/* Plan 109c — the agreement is the visible parent: name, bank, and the
              relationship start ("hos banken sedan …", never binding-flavoured),
              with the bank profile, bank change and history actions. The convention
              controls moved into the Bankprofil modal; a compact drift badge is the
              only convention signal left on the page and opens that modal. */}
          {activeMortgage && (
            <div className="agreement-head">
              <div className="agreement-summary">
                <span className="agreement-name">{activeMortgage.label || 'Bolån'}</span>
                <span className="agreement-sep">·</span>
                <span className="agreement-bank">{activeBank?.label || 'Okänd bank'}</span>
                {activeMortgage.start_date && (
                  <span className="agreement-since">hos banken sedan {activeMortgage.start_date}</span>
                )}
                <span className="agreement-status">Aktivt</span>
                <span className="agreement-parts-count">{activeParts.length} lånedel{activeParts.length === 1 ? '' : 'ar'}</span>
                {effectiveProfile && effectiveProfile.drift.length > 0 && (
                  <button type="button" className="agreement-drift-badge" onClick={() => setProfileDlg(true)}
                    title="Villkoren avviker från historiken — öppna Bankprofil">⚠ Villkor avviker</button>
                )}
              </div>
              <div className="agreement-actions">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setProfileDlg(true)}>Bankprofil</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setChangeDlg(true)}>Byt bank</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHistoryDlg(true)}>Tidigare avtal</button>
              </div>
            </div>
          )}
          {/* Plan 109c — parts without a current rate period (the state a fresh
              agreement is in right after a bank change): prompt to add räntevillkor
              so the forecast never silently reads as 0 %. Clears once every part
              has a rate period. */}
          {activeMortgage && missingRate.length > 0 && (
            <div className="missing-rate-prompt" role="status">
              <span className="missing-rate-text">
                <b>Räntevillkor saknas.</b> {missingRate.length === 1 ? 'En lånedel' : missingRate.length + ' lånedelar'} saknar en aktuell ränteperiod — prognosen kan inte räknas förrän den är satt.
              </span>
              <span className="missing-rate-parts">
                {missingRate.map(m => (
                  <button key={m.loan_part_id} type="button" className="btn btn-ghost btn-sm"
                    onClick={() => setPartDlg({ open: true, id: m.loan_part_id })}>
                    + Lägg till räntevillkor: {m.label || 'lånedel'}
                  </button>
                ))}
              </span>
            </div>
          )}
          {/* Plan 126 §2 — räntevillkor exist but none covers today (a gap, a
              lapsed timeline, an all-future one, or overlapping rows). The part
              has no current rate anywhere on the page, so say so and point at
              the periods to correct. Distinct from the prompt above, which is
              for parts with no villkor at all. */}
          {activeMortgage && missingCurrentRate.length > 0 && (
            <div className="missing-rate-prompt" role="status">
              <span className="missing-rate-text">
                <b>Räntevillkor saknas för idag.</b> Kontrollera perioderna för {swedishList(missingCurrentRate.map(m => m.label || 'lånedel'))}.
              </span>
              <span className="missing-rate-parts">
                {missingCurrentRate.map(m => (
                  <button key={m.loan_part_id} type="button" className="btn btn-ghost btn-sm"
                    onClick={() => setPartDlg({ open: true, id: m.loan_part_id })}>
                    Öppna {m.label || 'lånedel'}
                  </button>
                ))}
              </span>
            </div>
          )}
          {/* Plan 127 §4 — Kommande: rate periods that have not started yet on
              the live Lånedelar rows. Default-collapsed, no empty state (the
              whole band renders only when something is actually upcoming),
              and structurally the same disclosure pattern as Avslutade below
              (chevron toggle + Collapse) so the two preview/archive bands
              read as one family. A SEPARATE table from Lånedelar, never a
              merged row, so Balance/Share still close to exactly 100 % once —
              these parts' balances are already counted in their current
              Lånedelar row. */}
          {upcoming.groups.length > 0 && (() => {
            const days = daysUntil(upcoming.earliestStartDate!, today)
            const n = upcoming.uniquePartCount
            return (
              <div className="kommande-section">
                <button type="button" className="kommande-toggle" aria-expanded={kommandeOpen}
                  aria-label={(kommandeOpen ? 'Dölj' : 'Visa') + ' kommande ränteperioder'}
                  onClick={() => setKommandeOpen(v => !v)}>
                  <motion.span
                    className="expand-btn"
                    animate={{ rotate: kommandeOpen ? 90 : 0 }}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                  ><Icon icon={ChevronRight} size={12} /></motion.span>
                  Kommande
                  {days != null && <span className="kommande-chip">{omDagarLabel(days)}</span>}
                  <span className="count-pill">{n} lånedel{n === 1 ? '' : 'ar'}</span>
                </button>
                <Collapse open={kommandeOpen}>
                  <div className="table-wrap kommande-table-wrap">
                    <table className="data-table kommande-table">
                      <thead>
                        <tr>
                          <th>Startdatum</th><th>Ränta</th><th>Lånedel</th><th>Slutdatum</th><th className="col-act"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {upcoming.groups.flatMap(g => g.items.map(it => (
                          <tr key={it.period.id}>
                            <td className="col-date">{fmtRateDate(g.start_date)}</td>
                            <td>{rateBadge(it.period.rate, it.period.rate_type)}</td>
                            <td>{it.partLabel || '(no name)'}</td>
                            <td className="col-date">{it.period.end_date ? fmtRateDate(it.period.end_date) : '—'}</td>
                            <td className="col-act">
                              <button type="button" className="icon-btn" title="Redigera" aria-label={'Redigera ränteperiod för ' + (it.partLabel || 'lånedel')}
                                onClick={() => handleEditPeriod(it.partId, it.period.id)}>
                                <Icon icon={Pencil} />
                              </button>
                            </td>
                          </tr>
                        )))}
                      </tbody>
                    </table>
                  </div>
                </Collapse>
              </div>
            )
          })()}
          {!activeViewParts.length ? (
            <p className="empty">
              {activeMortgage
                ? 'Inga lånedelar än. Lägg till en lånedel — en per lånekonto — för att börja.'
                : 'Inget bolåneavtal än. Skapa ett för att komma igång.'}
            </p>
          ) : (
            <div className="table-wrap">
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
                          <td className="num ld-sum">{fmtPct(shareBasis > 0 ? g.total_balance / shareBasis * 100 : 0)}</td>
                          <td className="col-act"></td>
                        </tr>
                        <AnimatePresence initial={false}>
                          {isExp && g.parts.map(p => {
                            const bal = partBalance(p, payments)
                            const share = shareBasis > 0 ? bal / shareBasis * 100 : 0
                            // Plan 126 §2 — the member badge shows the rate in
                            // force TODAY, not the newest one entered.
                            const per = effectiveRatePeriod(p, periods, today)
                            return (
                              <motion.tr key={p.id} className="ld-member">
                                <td>
                                  <CellReveal reduce={reduceMotion}>
                                    <span className="ld-member-label">
                                      <span className="ld-name">{p.label || '(no name)'}{p.loan_number && <span className="ld-loanno">#{p.loan_number}</span>}</span>
                                      {rateBadge(per?.rate ?? null, per?.rate_type ?? null)}
                                      {p.mortgage_id == null && <span className="row-flag row-flag-estimated" title="Saknar koppling till bolåneavtal — öppna lånedelen för att koppla">⚠ ej kopplad</span>}
                                    </span>
                                  </CellReveal>
                                </td>
                                <td className="num"><CellReveal reduce={reduceMotion}>{fmtMoney(bal)}</CellReveal></td>
                                <td className="num"><CellReveal reduce={reduceMotion}>{fmtPct(share)}</CellReveal></td>
                                <td className="col-act"><CellReveal reduce={reduceMotion}>{partActs(p, true)}</CellReveal></td>
                              </motion.tr>
                            )
                          })}
                        </AnimatePresence>
                      </Fragment>
                    )
                  })}
                  {/* Insatt kapital closes the Share column to 100 %: the loan
                      parts above cover loan/price, this row covers the equity
                      that's already been paid in (deposit + amortised). */}
                  {insattShareActive && (
                    <tr className="ld-insatt">
                      <td>
                        <span className="ld-member-label">
                          <span className="ld-name">Insatt kapital</span>
                          <span className="ld-count">paid in · insatt</span>
                        </span>
                      </td>
                      <td className="num ld-sum">{fmtMoney(costBasisEq)}</td>
                      <td className="num ld-sum">{fmtPct(shareBasis > 0 ? costBasisEq / shareBasis * 100 : 0)}</td>
                      <td className="col-act"></td>
                    </tr>
                  )}
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
                          <button type="button" className="icon-btn" data-del-val title="Delete" aria-label="Delete" onClick={async () => { if (await confirm({ title: 'Delete this valuation?' })) handleDeleteVal(v.id) }}><Icon icon={X} /></button>
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
          {/* Plan 126 §5, the acceptance boundary — a row the owner approved is
              frozen forever, so this banner is INFORMATIONAL only: it names the
              drift and stops there. There is deliberately no refresh action.
              Predicted provenance already makes the case self-healing: the next
              real CSV import replaces the same loan_part_id + kind + month, so
              reality supersedes a row computed under a worse model. Rewriting an
              approved row from a better *model* is the one path that is not. */}
          {staleRows.length > 0 && (
            <div className="reconcile-banner" role="status">
              {staleRows.length === 1
                ? '1 godkänd prognosrad beräknades med en äldre modell. Bankens nästa import ersätter den.'
                : staleRows.length + ' godkända prognosrader beräknades med en äldre modell. Bankens nästa import ersätter dem.'}
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
                    Godkänn alla rader
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
                                // Plan 126 — the rate is always the entered one; the badge now
                                // reports how well the bank's day-count conventions are known.
                                <span className={'conf-badge' + (r.confidence === 'exact' ? ' is-exact' : '')}
                                  title={r.confidence === 'exact'
                                    ? 'Bankens villkor (dagbasis) är kända — beloppet följer avtalet exakt'
                                    : 'Bankens dagbasis är antagen (svensk standard 365) — beloppet kan avvika något'}>
                                  {r.confidence === 'exact' ? '≈ exakt' : '≈ est.'}
                                </span>
                              ) : r.amortization_source === 'declared' && (
                                <span className="conf-badge is-exact" title="Planerad amortering — deklarerad, inte framräknad ur historiken">deklarerad</span>
                              )}
                            </td>
                            <td className="col-act">
                              <button type="button" className="btn btn-ghost prognos-log-btn" onClick={() => handleLogPredicted([e])}>
                                Godkänn rad
                              </button>
                            </td>
                          </tr>
                          {/* Plan 126 removed the "listad X vs debiterad Y" row: with `rate`
                              BEING the listed rate the gap is identically zero, and the row
                              reconstructed the listed rate as rate + calibration_gap, which is
                              wrong the moment the entered rate moves. The honest calibration
                              check is predicted vs actual at import (reconcileCharge). */}
                        </Fragment>
                      )
                    })}
                    {/* Read-only preview of the coming year's avier: each month
                        priced at the rate period covering it, balance stepping
                        down by amorteringen each period. A villkorsändring the
                        owner has entered shows up here from its Gäller från.
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
          <div className="card-head" id="betalningar" tabIndex={-1}>
            <h2>Betalningar <span className="card-en">· Payments</span></h2>
            <span className="count-pill">{filteredPayments.length}</span>
            <div className="card-actions">
              <Segmented value={paymentFilter} onChange={setPaymentFilter} ariaLabel="Filter payments"
                options={[{ v: 'all', label: 'All' }, ...activeParts.map(p => ({ v: p.id, label: p.label || 'part' }))]} />
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
          <p className="contrib-note">Saldo är utgångspunkten för lånedelen. Senare betalningar och amorteringar ändrar skulden med sitt belopp. En separat Extra amortering minskar alltid skulden, även om den har samma datum som senaste Saldo.</p>
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
                          <td className="col-kind"><span className={'kind-tag kind-' + (p.kind || 'other')}>{kindLabel(p.kind)}</span>{p.source === 'predicted' && <span className="row-flag row-flag-predicted">godkänd prognos</span>}{p.kind === 'amortization' && p.is_insats && <span className="row-flag row-flag-insats">extra amortering</span>}{estimatedPaymentIds.has(p.id) && <span className="row-flag row-flag-estimated">ränta saknas · uppskattat</span>}</td>
                          <td className="num col-amount">{fmtMoney(p.amount)}</td>
                          <td className="num col-balance">{p.balance_after != null ? fmtMoney(p.balance_after) : '—'}</td>
                          <td className="col-act">
                            <button type="button" className="icon-btn" title="Edit" aria-label="Edit" onClick={() => setPayDlg({ open: true, id: p.id })}><Icon icon={Pencil} /></button>
                            {parts.length > 1 && (
                              <button type="button" className="icon-btn" title="Copy to parts" aria-label="Copy to parts" onClick={() => setCopyDlg({ open: true, source: p })}><Icon icon={Copy} /></button>
                            )}
                            <button type="button" className="icon-btn" data-del-pay title="Delete" aria-label="Delete" onClick={async () => { if (await confirm({ title: 'Delete this payment?' })) handleDeletePay(p.id) }}><Icon icon={X} /></button>
                          </td>
                        </tr>
                        <AnimatePresence initial={false}>
                          {p.is_insats && isExp && (
                            <motion.tr key="detail" className="pay-detail">
                              <td colSpan={6}>
                                <CellReveal reduce={reduceMotion}>
                                <div className="pay-detail-inner">
                                  {isExtraAmortering(p) ? (
                                    <>
                                      {/* Extra amortering: Betald av (the bank transfer) and
                                          Fördelning (each person's paid-in capital) are two
                                          independent facts — one payer must not stand in for
                                          a two-person allocation. */}
                                      <span className="pay-detail-label">Betald av</span>
                                      <span className="alloc-chip">{p.paid_by === 'joint' ? 'Gemensamt' : ownerName(p.paid_by)}</span>
                                      <span className="pay-detail-label">Fördelning</span>
                                      {(() => {
                                        const alloc = extraAmorteringAllocation(p, settings)
                                        return (
                                          <>
                                            <span className="alloc-chip"><b>{ownerName('a')}</b> {fmtMoney(alloc.a)}</span>
                                            <span className="alloc-chip"><b>{ownerName('b')}</b> {fmtMoney(alloc.b)}</span>
                                            {alloc.provenance === 'derived' && (
                                              <span className="row-flag row-flag-estimated" title="Beräknad från ägarfördelningen — granska och spara för att göra den definitiv">beräknad</span>
                                            )}
                                          </>
                                        )
                                      })()}
                                    </>
                                  ) : (
                                    <>
                                      <span className="pay-detail-label">Betalad av</span>
                                      {p.paid_split ? (
                                        <>
                                          <span className="alloc-chip"><b>{ownerName('a')}</b> {fmtMoney(p.paid_split.a)}</span>
                                          <span className="alloc-chip"><b>{ownerName('b')}</b> {fmtMoney(p.paid_split.b)}</span>
                                        </>
                                      ) : (
                                        <span className="alloc-chip">{p.paid_by === 'joint'
                                          ? 'Gemensamt · enligt ägarfördelning'
                                          : <><b>{ownerName(p.paid_by === 'b' ? 'b' : 'a')}</b> {fmtMoney(p.amount)}</>}</span>
                                      )}
                                    </>
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
          {/* Month disclosure (plan 115): reveal one populated month at a time,
              or all at once. Hidden entirely for a single-bucket ledger; the
              collapse action survives once more than the newest month shows. */}
          {payBuckets.length > 1 && (
            <div className="table-more">
              {hiddenPayBucketCount > 0 && nextPayBucket && (
                <>
                  <button type="button" className="btn btn-ghost" onClick={() => setPayMonthsShown(n => (n === 'all' ? n : n + 1))}>
                    Visa en månad till
                    <span className="more-count">{nextPayBucket.label} · {hiddenPayBucketCount} kvar</span>
                  </button>
                  <button type="button" className="link-btn" onClick={() => setPayMonthsShown('all')}>Visa alla månader</button>
                </>
              )}
              {visiblePayBucketCount > 1 && (
                <button type="button" className="link-btn" onClick={() => setPayMonthsShown(1)}>Visa senaste månaden</button>
              )}
            </div>
          )}
        </section>

        {/* ── Linked canonical projections — neither section owns its own data. */}
        <section className="card" id="kontantinsatser">
          <div className="card-head">
            <h2>Kontantinsatser</h2>
            <span className="count-pill">{downPayments.length}</span>
            <div className="card-actions"><button type="button" className="btn btn-ghost" onClick={openPayments}>Öppna Betalningar</button></div>
          </div>
          <p className="contrib-note">Källposter av typen Kontantinsats. Redigera eller ta bort dem i samma Betalningar-liggare.</p>
          {!downPayments.length ? <p className="empty">Inga kontantinsatser ännu.</p> : (
            <div className="table-wrap">
              <table className="data-table table-cards insats-table kontantinsats-table">
                <thead><tr><th className="col-date">Datum</th><th>Betalad av</th><th className="num">Belopp</th><th className="col-act" /></tr></thead>
                <tbody>{downPayments.map(p => (
                  <tr key={p.id} data-source-payment-id={p.id}>
                    <td className="col-date">{p.date || '—'}</td>
                    <td className="col-owner">{p.paid_split ? `${ownerName('a')} ${fmtMoney(p.paid_split.a)} · ${ownerName('b')} ${fmtMoney(p.paid_split.b)}` : p.paid_by === 'joint' ? 'Gemensamt' : ownerName(p.paid_by)}</td>
                    <td className="num col-amt">{fmtMoney(p.amount)}</td>
                    <td className="col-act">
                      {/* A kontantinsats belongs to a mortgage agreement, not a
                          loan part — the Lånedel column was misleading and is
                          gone; the unlinked-agreement warning it used to carry
                          moves here next to the row's own edit action. */}
                      {!p.mortgage_id && <span className="row-flag row-flag-estimated" title="Saknar koppling till bolåneavtal — öppna för att koppla">⚠ ej kopplad</span>}
                      <button type="button" className="icon-btn" title="Redigera i Betalningar" aria-label="Redigera i Betalningar" onClick={() => setPayDlg({ open: true, id: p.id })}><Icon icon={Pencil} /></button>
                      <button type="button" className="icon-btn" title="Ta bort" aria-label="Ta bort" onClick={async () => { if (await confirm({ title: 'Ta bort betalningen?' })) handleDeletePay(p.id) }}><Icon icon={X} /></button>
                    </td>
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
            <div className="card-actions"><button type="button" className="btn btn-ghost" onClick={openPayments}>Öppna Betalningar</button></div>
          </div>
          <p className="contrib-note">Källposter av typen Extra amortering. Vanliga amorteringar visas bara i Betalningar.</p>
          {!extraAmortizationPayments.length ? <p className="empty">Inga extra amorteringar ännu.</p> : (
            <div className="table-wrap">
              <table className="data-table table-cards insats-table extra-amort-table">
                <thead><tr><th className="col-date">Datum</th><th>Betald av</th><th>Fördelning</th><th>Lånedel</th><th className="num">Belopp</th><th className="col-act" /></tr></thead>
                <tbody>{extraAmortizationPayments.map(p => {
                  // Betald av is who sent the money to the bank; Fördelning is
                  // the person-level capital allocation. One payer must never
                  // stand in for a two-person split — always resolve and show
                  // both named shares (explicit when reviewed, derived from
                  // the configured ownership split for a legacy unsplit row).
                  const alloc = extraAmorteringAllocation(p, settings)
                  return (
                  <tr key={p.id} data-source-payment-id={p.id}>
                    <td className="col-date">{p.date || '—'}</td>
                    <td className="col-owner">{p.paid_by === 'joint' ? 'Gemensamt' : ownerName(p.paid_by)}</td>
                    <td className="col-alloc">
                      <span className="alloc-chip"><b>{ownerName('a')}</b> {fmtMoney(alloc.a)}</span>
                      <span className="alloc-chip"><b>{ownerName('b')}</b> {fmtMoney(alloc.b)}</span>
                      {alloc.provenance === 'derived' && (
                        <span className="row-flag row-flag-estimated" title="Beräknad från ägarfördelningen — granska och spara för att göra den definitiv">beräknad</span>
                      )}
                    </td>
                    <td className="col-part">{partNameById(p.loan_part_id)}</td>
                    <td className="num col-amt">{fmtMoney(p.amount)}</td>
                    <td className="col-act"><button type="button" className="icon-btn" title="Redigera i Betalningar" aria-label="Redigera i Betalningar" onClick={() => setPayDlg({ open: true, id: p.id })}><Icon icon={Pencil} /></button><button type="button" className="icon-btn" title="Ta bort" aria-label="Ta bort" onClick={async () => { if (await confirm({ title: 'Ta bort betalningen?' })) handleDeletePay(p.id) }}><Icon icon={X} /></button></td>
                  </tr>
                  )
                })}</tbody>
              </table>
            </div>
          )}
        </section>

        </>)}

      </main>

      {/* ── Dialogs ── */}
      <PartDialog open={partDlg.open} id={partDlg.id} parts={parts} periods={periods} payments={payments}
        onSave={handleSavePart} onDelete={handleDeletePart} onClose={() => setPartDlg({ open: false, id: null })}
        onEditPeriod={handleEditPeriod} onDeletePeriod={handleDeletePeriod} />
      {/* Plan 127 §2 — the ONE standalone rate-period dialog on the page: the
          Lånedelar row's "Ny räntesats" action and PartDialog's rate-history
          editor both target `periodDlg`, so a correction never opens on top of
          another dialog. */}
      <PeriodDialog open={periodDlg.open} partId={periodDlg.partId} id={periodDlg.id} periods={periods}
        onSave={data => handleSavePeriod(periodDlg.partId!, data, periodDlg.id || undefined)}
        onDelete={handleDeletePeriodFromDialog} onClose={closePeriodDlg} />
      <ValuationDialog open={valDlg.open} id={valDlg.id} valuations={valuations} onSave={handleSaveVal} onDelete={handleDeleteVal} onClose={() => setValDlg({ open: false, id: null })} />
      <PaymentDialog open={payDlg.open} id={payDlg.id} payments={payments} parts={parts} settings={settings}
        mortgages={mortgages} banks={banks} activeMortgageId={activeMortgage?.id ?? null}
        displayNames={{ a: ownerName('a'), b: ownerName('b') }} selfSlot={mappedSlot}
        onSave={handleSavePay} onDelete={handleDeletePay} onClose={() => setPayDlg({ open: false, id: null })} />
      <CopyToPartsDialog open={copyDlg.open} source={copyDlg.source} parts={parts} onConfirm={ids => copyDlg.source && handleCopyToParts(copyDlg.source, ids)} onClose={() => setCopyDlg({ open: false, source: null })} />
      <SettingsDialog open={settingsDlg} settings={settings}
        bound={mappedSlot != null || (identityView.personFor('bolanekoll', 'a') != null && identityView.personFor('bolanekoll', 'b') != null)}
        mapped={mappedSlot != null}
        boundNames={{ a: ownerName('a'), b: ownerName('b') }}
        onManagePeople={openHouseholdDialog}
        onSave={handleSaveSettings} onClose={() => setSettingsDlg(false)}
        onExportJSON={handleExportJSON} onExportCSV={handleExportCSV} onImportJSON={handleImportJSON} />

      <BankProfileDialog open={profileDlg} bank={activeBank} banks={banks} catalogBanks={catalogBanks}
        effective={effectiveProfile} suggestion={bankSuggestion} agreementCount={agreementCount}
        onSave={handleSaveBankProfile} onClose={() => setProfileDlg(false)} />

      <AgreementDialog open={createDlg} banks={banks} catalogBanks={catalogBanks}
        onSave={handleCreateAgreement} onClose={() => setCreateDlg(false)} />

      {activeMortgage && (
        <BankChangeWizard open={changeDlg} currentBankId={activeBank?.id ?? null}
          currentAgreementLabel={activeMortgage.label || 'Bolån'} banks={banks} catalogBanks={catalogBanks}
          parts={activeAgreementParts} payments={payments}
          onConfirm={handleChangeBank} onClose={() => setChangeDlg(false)} />
      )}

      <AgreementHistoryDialog open={historyDlg} mortgages={mortgages} banks={banks}
        parts={parts} periods={periods} payments={payments}
        canRevert={canRevertBankChange} revertTargetLabel={activeMortgage?.label || 'Bolån'}
        onRevert={handleRevertBankChange}
        onEditPart={(id) => setPartDlg({ open: true, id })}
        onEditPayment={(id) => setPayDlg({ open: true, id })}
        onClose={() => setHistoryDlg(false)} />

      {/* ── Toast ── */}
      <div className={'bk-toast' + (toast.show ? ' show' : '')} role="status" aria-live="polite">{toast.msg}</div>
    </div>
  )
}
