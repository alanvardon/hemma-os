import { useEffect, useMemo, useState } from 'react'
import DialogShell from '../../components/DialogShell'
import FormField from '../../components/FormField'
import { usePersonNames } from '../../components/usePersonNames'
import { makePayment, parseAmount, todayISO } from '../../lib/mortgage'
import type { LoanPart, Payment, MortgageSettings, PaidBy } from '../../lib/mortgage'

type EntryType = 'down_payment' | 'payment' | 'interest' | 'amortization' | 'extra_amortization' | 'loan' | 'fee' | 'other'

interface PayDlgProps {
  open: boolean; id: string | null; payments: Payment[]; parts: LoanPart[]; settings: MortgageSettings
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

export default function PaymentDialog({ open, id, payments, parts, settings, onSave, onDelete, onClose }: PayDlgProps) {
  const rec = id ? payments.find(p => p.id === id) : null
  const [form, setForm] = useState({ date: todayISO(), loan_part_id: '', entryType: 'payment' as EntryType, amount: '', balance_after: '', paid_by: 'joint' as PaidBy, split_a: '', split_b: '' })
  useEffect(() => {
    if (!open) return
    const entryType = entryTypeFor(rec)
    const joint = entryType === 'payment' || entryType === 'interest'
    setForm({
      date: rec?.date || todayISO(),
      loan_part_id: rec?.loan_part_id || (parts[0]?.id || ''),
      entryType,
      amount: rec?.amount ? String(rec.amount) : '',
      balance_after: rec?.balance_after != null ? String(rec.balance_after) : '',
      // Legacy individual attribution on Betalning/Ränta is deliberately
      // discarded on the next save; those rows are household-joint.
      paid_by: joint ? 'joint' : (rec?.paid_by || 'joint'),
      split_a: !joint && rec?.paid_split ? String(rec.paid_split.a) : '',
      split_b: !joint && rec?.paid_split ? String(rec.paid_split.b) : '',
    })
  }, [open, id]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof typeof form>(key: K, value: typeof form[K]) => setForm(current => ({ ...current, [key]: value }))
  const jointRecord = form.entryType === 'payment' || form.entryType === 'interest'
  const needsLoanPart = form.entryType !== 'down_payment'
  const acceptsSaldo = form.entryType === 'payment' || form.entryType === 'amortization' || form.entryType === 'extra_amortization'
  const hasSplit = !jointRecord && (form.split_a.trim() !== '' || form.split_b.trim() !== '')
  const split = hasSplit ? { a: parseAmount(form.split_a) || 0, b: parseAmount(form.split_b) || 0 } : null
  const splitIsValid = !split || split.a + split.b === (parseAmount(form.amount) || 0)
  const missingInterest = useMemo(() => {
    if (form.entryType !== 'payment' || !form.loan_part_id || !form.date) return false
    const month = form.date.slice(0, 7)
    const others = payments.filter(p => p.id !== id && p.loan_part_id === form.loan_part_id)
    const hasInterest = others.some(p => p.kind === 'interest' && p.date?.slice(0, 7) === month)
    const laterSaldo = others.some(p => p.date > form.date && p.balance_after != null)
    return !hasInterest && !laterSaldo
  }, [form.date, form.entryType, form.loan_part_id, id, payments])
  const { a: aName, b: bName } = usePersonNames(settings.owner_a_name, settings.owner_b_name)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const kind = paymentKind(form.entryType)
    if (!splitIsValid) return
    const paid_by: PaidBy = jointRecord ? 'joint'
      : split ? split.a > 0 && split.b > 0 ? 'joint' : split.a > 0 ? 'a' : split.b > 0 ? 'b' : form.paid_by
        : form.paid_by
    onSave(makePayment({
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
      paid_split: jointRecord ? null : split,
    }))
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
          {!jointRecord && (
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
          {id && <button type="button" className="btn btn-ghost btn-danger" onClick={() => { if (confirm('Ta bort betalningen?')) onDelete(id) }}>Ta bort</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Avbryt</button>
          <button type="submit" className="btn btn-primary" disabled={!splitIsValid}>Spara</button>
        </div>
      </form>
    </DialogShell>
  )
}
