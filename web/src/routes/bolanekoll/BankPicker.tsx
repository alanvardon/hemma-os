import { useMemo } from 'react'
import FormField from '../../components/FormField'
import type { Bank, CatalogBank } from '../../lib/mortgage'

// The bank a profile/agreement points at. `null` means "keep the current bank"
// (the caller decides whether that is valid). A catalogue pick carries the
// denormalised label so the household bank row still renders offline; a custom
// pick is a brand-new private bank; `existing` reuses a household bank as-is.
export type BankSelection =
  | { kind: 'existing'; bankId: string }
  | { kind: 'catalog'; catalogId: string; label: string }
  | { kind: 'custom'; label: string }
  | null

// Serialised <select> value ↔ BankSelection. Custom keeps its typed label in a
// sibling input, so the option value is a constant sentinel.
const CUSTOM = '__custom__'

export function selectionValue(sel: BankSelection): string {
  if (!sel) return ''
  if (sel.kind === 'existing') return 'existing:' + sel.bankId
  if (sel.kind === 'catalog') return 'catalog:' + sel.catalogId
  return CUSTOM
}

// A compact bank chooser shared by the create-agreement and bank-profile
// dialogs. Household banks come first (reuse keeps their private locks), then
// catalogue banks not yet attached, then "Egen bank…". Catalogue rows are
// read-only identity — never editable inputs (plan 109 decision 1).
export default function BankPicker({ banks, catalogBanks, selection, customLabel, onChange, onCustomLabel, excludeBankId }: {
  banks: Bank[]
  catalogBanks: CatalogBank[]
  selection: BankSelection
  customLabel: string
  onChange: (sel: BankSelection) => void
  onCustomLabel: (label: string) => void
  // The change-bank wizard passes the current agreement's bank so it can never
  // be offered as a "change" — its catalogue row is offered again instead, so a
  // genuine re-selection of the same catalogue bank stays possible if intended.
  excludeBankId?: string | null
}) {
  // Household banks the picker offers — the current bank is dropped when the
  // caller excludes it (a bank change must move to a different profile).
  const householdBanks = useMemo(
    () => excludeBankId ? banks.filter(b => b.id !== excludeBankId) : banks,
    [banks, excludeBankId])
  // Catalogue banks the household hasn't already attached (attached ones show
  // under their household row, so we don't offer a duplicate).
  const attached = useMemo(() => new Set(householdBanks.map(b => b.catalog_id).filter(Boolean)), [householdBanks])
  const unattachedCatalog = useMemo(
    () => catalogBanks.filter(c => !attached.has(c.id)),
    [catalogBanks, attached])

  function handleSelect(value: string) {
    if (value === CUSTOM) { onChange({ kind: 'custom', label: customLabel }); return }
    if (value.startsWith('existing:')) { onChange({ kind: 'existing', bankId: value.slice('existing:'.length) }); return }
    if (value.startsWith('catalog:')) {
      const id = value.slice('catalog:'.length)
      const cat = catalogBanks.find(c => c.id === id)
      onChange(cat ? { kind: 'catalog', catalogId: cat.id, label: cat.label } : null)
      return
    }
    onChange(null)
  }

  return (
    <>
      <FormField label="Bank" wide>
        <select className="select" value={selectionValue(selection)} onChange={e => handleSelect(e.target.value)}>
          {householdBanks.length > 0 && (
            <optgroup label="Dina banker">
              {householdBanks.map(b => <option key={b.id} value={'existing:' + b.id}>{b.label || 'Namnlös bank'}</option>)}
            </optgroup>
          )}
          {unattachedCatalog.length > 0 && (
            <optgroup label="Bankkatalog">
              {unattachedCatalog.map(c => <option key={c.id} value={'catalog:' + c.id}>{c.label}</option>)}
            </optgroup>
          )}
          <option value={CUSTOM}>Egen bank…</option>
        </select>
      </FormField>
      {selection?.kind === 'custom' && (
        <FormField label="Bankens namn" wide>
          <input type="text" placeholder="t.ex. Min bank" value={customLabel}
            onChange={e => { onCustomLabel(e.target.value); onChange({ kind: 'custom', label: e.target.value }) }} />
        </FormField>
      )}
    </>
  )
}
