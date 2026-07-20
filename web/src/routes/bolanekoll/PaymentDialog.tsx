import { useEffect, useMemo, useState } from 'react'
import DialogShell from '../../components/DialogShell'
import FormField from '../../components/FormField'
import { usePersonNames } from '../../components/usePersonNames'
import { useConfirm } from '../../components/useConfirm'
import { makePayment, parseAmount, todayISO, extraAmorteringAllocation } from '../../lib/mortgage'
import type { LoanPart, Payment, MortgageSettings, PaidBy, Mortgage, Bank } from '../../lib/mortgage'
import { fmtMoney } from './shared'

// Local rounding to öre — mirrors mortgage.ts's internal r2 (not exported) so
// the dialog's live validation matches extraAmorteringAllocation's rule
// exactly: both amounts finite/non-negative and their öre-rounded sum equal
// to the öre-rounded payment amount.
function round2(n: number): number { return Math.round((Number(n) || 0) * 100) / 100 }

type EntryType = 'down_payment' | 'payment' | 'interest' | 'amortization' | 'extra_amortization' | 'loan' | 'fee' | 'other'

interface PayDlgProps {
  open: boolean; id: string | null; payments: Payment[]; parts: LoanPart[]; settings: MortgageSettings
  // Plan 109c — a Kontantinsats (down payment) carries agreement provenance. The
  // selector defaults to the active agreement but includes archived ones so a
  // pre-refinance deposit records the right mortgage_id; part-linked rows derive
  // it from their part in the database and never show this control.
  mortgages: Mortgage[]; banks: Bank[]; activeMortgageId: string | null
  // Plan 111: canonical household names + the signed-in slot for the "Du" marker
  // on the payer selector. Falls back to legacy settings names when unbound.
  displayNames?: { a: string; b: string }; selfSlot?: 'a' | 'b' | null
  onSave: (data: Omit<Payment, 'id' | 'created_at'>) => void
  onDelete: (id: string) => void; onClose: () => void
}

function entryTypeFor(payment: Payment | null | undefined): EntryType {
  if (payment?.kind === 'down_payment') return 'down_payment'
  if (payment?.is_insats) return 'extra_amortization'
  switch (payment?.kind) {
    case 'payment': case 'interest': case 'amortization': case 'loan': case 'fee': case 'other': return payment.kind
    default: return 'payment'
  }
}

function paymentKind(type: EntryType): Payment['kind'] {
  return type === 'extra_amortization' ? 'amortization' : type
}

export default function PaymentDialog({ open, id, payments, parts, settings, mortgages, banks, activeMortgageId, displayNames, selfSlot, onSave, onDelete, onClose }: PayDlgProps) {
  const confirm = useConfirm()
  const rec = id ? payments.find(p => p.id === id) : null
  const [form, setForm] = useState({ date: todayISO(), loan_part_id: '', entryType: 'payment' as EntryType, amount: '', balance_after: '', paid_by: 'joint' as PaidBy, split_a: '', split_b: '', mortgage_id: '' })
  // Extra amortering only: once the owner edits either allocation input
  // directly, stop auto-deriving it from the amount/ownership split so a
  // later amount or payer change never silently overwrites reviewed values.
  // An existing row loaded with a VALID stored split counts as already
  // reviewed (touched) so an amount edit can't quietly recompute it either;
  // a legacy row loaded with a derived split stays untouched until the owner
  // edits it, matching the "beräknad — granska innan du sparar" notice below.
  const [splitTouched, setSplitTouched] = useState(false)
  // Whether the split currently shown for an existing extra amortering was
  // loaded as a derived (legacy) fallback rather than the row's own stored
  // split — drives the "beräknad" review notice until the row is saved.
  const [legacyDerived, setLegacyDerived] = useState(false)
  useEffect(() => {
    if (!open) return
    const entryType = entryTypeFor(rec)
    const joint = entryType === 'payment' || entryType === 'interest'
    const isExtra = entryType === 'extra_amortization'
    let splitA = '', splitB = '', touched = false, derived = false
    if (isExtra && rec) {
      const alloc = extraAmorteringAllocation(rec, settings)
      splitA = String(alloc.a)
      splitB = String(alloc.b)
      touched = alloc.provenance === 'explicit'
      derived = alloc.provenance === 'derived'
    } else if (!joint && rec?.paid_split) {
      splitA = String(rec.paid_split.a)
      splitB = String(rec.paid_split.b)
    }
    setForm({
      date: rec?.date || todayISO(),
      loan_part_id: rec?.loan_part_id || (parts[0]?.id || ''),
      entryType,
      amount: rec?.amount ? String(rec.amount) : '',
      balance_after: rec?.balance_after != null ? String(rec.balance_after) : '',
      // Legacy individual attribution on Betalning/Ränta is deliberately
      // discarded on the next save; those rows are household-joint.
      paid_by: joint ? 'joint' : (rec?.paid_by || 'joint'),
      split_a: splitA,
      split_b: splitB,
      // A new down payment defaults to the active agreement; editing keeps the
      // row's own link. A legacy row with no link defaults to blank so the owner
      // makes an explicit repair choice rather than the UI guessing.
      mortgage_id: rec?.mortgage_id ?? (id ? '' : (activeMortgageId ?? '')),
    })
    setSplitTouched(touched)
    setLegacyDerived(derived)
  }, [open, id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Extra amortering only: prefill the allocation from the configured
  // ownership split once an amount is entered, for a brand-new row or a row
  // whose type was just switched to Extra amortering. Skipped once the owner
  // has touched a split field, or once an existing row's own (explicit or
  // derived) split has already been loaded above.
  useEffect(() => {
    if (form.entryType !== 'extra_amortization' || splitTouched) return
    const amt = parseAmount(form.amount) || 0
    if (amt <= 0) return
    const alloc = extraAmorteringAllocation({ amount: amt, paid_split: null } as unknown as Payment, settings)
    setForm(current => (current.entryType === 'extra_amortization'
      ? { ...current, split_a: String(alloc.a), split_b: String(alloc.b) }
      : current))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.entryType, form.amount, splitTouched, settings])

  const set = <K extends keyof typeof form>(key: K, value: typeof form[K]) => setForm(current => ({ ...current, [key]: value }))
  const setSplit = <K extends 'split_a' | 'split_b'>(key: K, value: string) => {
    setForm(current => ({ ...current, [key]: value }))
    setSplitTouched(true)
  }
  const jointRecord = form.entryType === 'payment' || form.entryType === 'interest'
  const isExtra = form.entryType === 'extra_amortization'
  const needsLoanPart = form.entryType !== 'down_payment'
  const acceptsSaldo = form.entryType === 'payment' || form.entryType === 'amortization' || form.entryType === 'extra_amortization'
  const hasSplit = !jointRecord && !isExtra && (form.split_a.trim() !== '' || form.split_b.trim() !== '')
  const split = hasSplit ? { a: parseAmount(form.split_a) || 0, b: parseAmount(form.split_b) || 0 } : null
  const splitIsValid = !split || split.a + split.b === (parseAmount(form.amount) || 0)

  // Extra amortering: the allocation is mandatory and independent of the
  // payer. Valid = both amounts finite, non-negative, and their öre-rounded
  // sum equal to the öre-rounded payment amount (mirrors
  // extraAmorteringAllocation's own explicit-split validity rule).
  const extraAmount = parseAmount(form.amount)
  const extraA = parseAmount(form.split_a)
  const extraB = parseAmount(form.split_b)
  const extraSplitValid = !isExtra || (
    Number.isFinite(extraAmount) && extraAmount > 0 &&
    Number.isFinite(extraA) && Number.isFinite(extraB) &&
    extraA >= 0 && extraB >= 0 &&
    round2(round2(extraA) + round2(extraB)) === round2(extraAmount)
  )
  const extraSplitMessage = !isExtra ? '' : (
    !Number.isFinite(extraAmount) || extraAmount <= 0
      ? 'Ange ett belopp innan fördelningen kan sparas.'
      : !Number.isFinite(extraA) || !Number.isFinite(extraB)
        ? 'Ange båda fördelningsbeloppen.'
        : extraA < 0 || extraB < 0
          ? 'Fördelningen kan inte vara negativ.'
          : extraSplitValid
            ? `Fördelning: ${fmtMoney(round2(extraA))} + ${fmtMoney(round2(extraB))} = ${fmtMoney(round2(round2(extraA) + round2(extraB)))}.`
            : `Fördelning: ${fmtMoney(round2(extraA))} + ${fmtMoney(round2(extraB))} = ${fmtMoney(round2(round2(extraA) + round2(extraB)))} — måste bli samma som beloppet (${fmtMoney(round2(extraAmount))}).`
  )
  const missingInterest = useMemo(() => {
    if (form.entryType !== 'payment' || !form.loan_part_id || !form.date) return false
    const month = form.date.slice(0, 7)
    const others = payments.filter(p => p.id !== id && p.loan_part_id === form.loan_part_id)
    const hasInterest = others.some(p => p.kind === 'interest' && p.date?.slice(0, 7) === month)
    const laterSaldo = others.some(p => p.date > form.date && p.balance_after != null)
    return !hasInterest && !laterSaldo
  }, [form.date, form.entryType, form.loan_part_id, id, payments])
  const names = usePersonNames(displayNames?.a ?? settings.owner_a_name, displayNames?.b ?? settings.owner_b_name)
  const aName = selfSlot === 'a' ? `${names.a} (du)` : names.a
  const bName = selfSlot === 'b' ? `${names.b} (du)` : names.b
  const isDownPayment = form.entryType === 'down_payment'
  // Agreement options, active first then archived (newest close first). The
  // deposit's provenance must be an explicit pick — legacy null rows show a
  // repair hint rather than a silent default.
  const mortgageOptions = useMemo(() => {
    const label = (m: Mortgage) => (m.label || 'Bolån') + ' · ' + (m.bank_id ? (banks.find(b => b.id === m.bank_id)?.label || 'okänd bank') : 'okänd bank') + (m.archived ? ' (avslutat)' : '')
    const active = mortgages.filter(m => m && !m.archived)
    const closed = mortgages.filter(m => m && m.archived).sort((a, b) => String(b.end_date ?? '').localeCompare(String(a.end_date ?? '')))
    return [...active, ...closed].map(m => ({ id: m.id, label: label(m) }))
  }, [mortgages, banks])
  const needsRepair = isDownPayment && !!id && !rec?.mortgage_id

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const kind = paymentKind(form.entryType)
    if (isExtra) {
      if (!extraSplitValid) return
    } else if (!splitIsValid) {
      return
    }
    // Extra amortering: paid_by comes straight from the payer selector and
    // paid_split straight from the reviewed allocation inputs — the two
    // facts stay independent. One person paying the bank must not collapse
    // or silently rewrite a two-person allocation.
    const paid_by: PaidBy = jointRecord ? 'joint'
      : isExtra ? form.paid_by
        : split ? split.a > 0 && split.b > 0 ? 'joint' : split.a > 0 ? 'a' : split.b > 0 ? 'b' : form.paid_by
          : form.paid_by
    const paid_split = jointRecord ? null : isExtra ? { a: round2(extraA), b: round2(extraB) } : split
    onSave({
      ...makePayment({
        date: form.date,
        loan_part_id: needsLoanPart ? form.loan_part_id || null : null,
        kind,
        amount: parseAmount(form.amount),
        // The dialog currently does not edit notes/import provenance. Preserve
        // those canonical fields rather than turning an allocation edit into a
        // lossy rewrite of a bank/imported record.
        description: rec?.description || '', source: rec?.source || 'manual',
        // A bank-reported post-transaction Saldo is authoritative for both an
        // ordinary and an extra amortering. Other row types must not retain a
        // hidden balance anchor when reclassified.
        balance_after: acceptsSaldo && form.balance_after ? parseAmount(form.balance_after) : null,
        paid_by,
        is_insats: form.entryType === 'down_payment' || form.entryType === 'extra_amortization',
        paid_split,
      }),
      // Only a Kontantinsats carries an explicit agreement id (part-linked rows
      // derive it in the database). makePayment drops mortgage_id, so re-attach
      // the chosen one here; blank falls through to the store's active-agreement
      // default for a brand-new deposit.
      ...(isDownPayment && form.mortgage_id ? { mortgage_id: form.mortgage_id } : {}),
    })
  }

  return (
    <DialogShell open={open} onClose={onClose} className="bk-dialog" ariaLabel={id ? 'Redigera betalning' : 'Lägg till betalning'}>
      <form className="dialog-body" onSubmit={submit}>
        <h3 className="dialog-title">{id ? 'Redigera betalning' : 'Lägg till betalning'}</h3>
        <p className="form-hint">Betalningar är källan för kontantinsats och amortering. Ränta och Betalning är alltid gemensamma.</p>
        <div className="form-grid">
          <FormField label="Typ" wide>
            <select className="select" value={form.entryType} onChange={e => set('entryType', e.target.value as EntryType)}>
              <option value="down_payment">Kontantinsats</option>
              <option value="payment">Betalning</option>
              <option value="interest">Ränta</option>
              <option value="amortization">Amortering</option>
              <option value="extra_amortization">Extra amortering</option>
              <option value="loan">Lån</option>
              <option value="fee">Avgift</option>
              <option value="other">Övrigt</option>
            </select>
          </FormField>
          {needsLoanPart && (
            <FormField label="Lånedel" wide>
              <select className="select" value={form.loan_part_id} required onChange={e => set('loan_part_id', e.target.value)}>
                {parts.map(p => <option key={p.id} value={p.id}>{p.label || p.id}</option>)}
              </select>
            </FormField>
          )}
          {isDownPayment && mortgageOptions.length > 0 && (
            <FormField label="Bolåneavtal" wide>
              <select className="select" value={form.mortgage_id} onChange={e => set('mortgage_id', e.target.value)}>
                {needsRepair && <option value="">— välj avtal —</option>}
                {mortgageOptions.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </FormField>
          )}
          {needsRepair && (
            <p className="form-hint form-wide payment-estimate-warning" role="alert">
              Den här kontantinsatsen saknar koppling till ett bolåneavtal. Välj avtalet den hör till för att koppla den — ingen koppling gissas åt dig.
            </p>
          )}
          <FormField label="Datum"><input type="date" required value={form.date} onChange={e => set('date', e.target.value)} /></FormField>
          <FormField label="Belopp"><input type="text" required inputMode="decimal" placeholder="0" value={form.amount} onChange={e => set('amount', e.target.value)} /></FormField>
          {acceptsSaldo && <FormField label="Saldo efteråt (valfritt)"><input type="text" inputMode="decimal" placeholder="0" value={form.balance_after} onChange={e => set('balance_after', e.target.value)} /></FormField>}
          {(form.entryType === 'amortization' || form.entryType === 'extra_amortization') && (
            <p className="form-hint form-wide">Ange bankens Saldo efter amorteringen om den har samma datum som föregående Saldo. Annars räknas beloppet från det senaste tidigare Saldo.</p>
          )}
          {jointRecord ? (
            <p className="form-hint form-wide">Gemensam post — betalningen och räntan kan inte fördelas på en person. Amorteringsdelen följer den valda ägarfördelningen.</p>
          ) : (
            <FormField label="Betalad av" wide>
              <select className="select" value={form.paid_by} onChange={e => set('paid_by', e.target.value as PaidBy)}>
                <option value="joint">Gemensamt · enligt ägarfördelning</option>
                <option value="a">{aName}</option>
                <option value="b">{bName}</option>
              </select>
            </FormField>
          )}
          {isExtra && (
            <p className="form-hint form-wide">Betald av visar vem som gjorde banköverföringen till banken. Fördelningen nedan styr hur mycket av det insatta kapitalet som tillhör vardera person — oberoende av vem som betalade.</p>
          )}
          {isExtra && legacyDerived && (
            <p className="form-hint form-wide payment-estimate-warning" role="alert">
              Beräknad från ägarfördelningen — granska innan du sparar.
            </p>
          )}
          {isExtra ? (
            <>
              <FormField label={`${aName} · fördelning`}><input type="text" required inputMode="decimal" placeholder="0" value={form.split_a} onChange={e => setSplit('split_a', e.target.value)} /></FormField>
              <FormField label={`${bName} · fördelning`}><input type="text" required inputMode="decimal" placeholder="0" value={form.split_b} onChange={e => setSplit('split_b', e.target.value)} /></FormField>
              <p className={'form-hint form-wide' + (extraSplitValid ? '' : ' is-warn')} role={extraSplitValid ? undefined : 'alert'}>{extraSplitMessage}</p>
            </>
          ) : !jointRecord && (
            <>
              <FormField label={`${aName} · fördelning`}><input type="text" inputMode="decimal" placeholder="valfritt" value={form.split_a} onChange={e => set('split_a', e.target.value)} /></FormField>
              <FormField label={`${bName} · fördelning`}><input type="text" inputMode="decimal" placeholder="valfritt" value={form.split_b} onChange={e => set('split_b', e.target.value)} /></FormField>
              <p className={'form-hint form-wide' + (splitIsValid ? '' : ' is-warn')}>{split
                ? `Fördelning: ${split.a} kr + ${split.b} kr${splitIsValid ? '' : ' måste vara samma som beloppet.'}`
                : 'Valfritt: ange båda beloppen för en exakt gemensam fördelning.'}</p>
            </>
          )}
          {missingInterest && (
            <p className="form-hint form-wide payment-estimate-warning" role="alert">
              Ränta saknas för den här betalningen. Hela beloppet räknas preliminärt som amortering tills räntan läggs till; ägandet kan vara överskattat.
            </p>
          )}
        </div>
        <div className="dialog-actions">
          {id && <button type="button" className="btn btn-ghost btn-danger" onClick={async () => { if (await confirm({ title: 'Ta bort betalningen?' })) onDelete(id) }}>Ta bort</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Avbryt</button>
          <button type="submit" className="btn btn-primary" disabled={isExtra ? !extraSplitValid : !splitIsValid}>Spara</button>
        </div>
      </form>
    </DialogShell>
  )
}
