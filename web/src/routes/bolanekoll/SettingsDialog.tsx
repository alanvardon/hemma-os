import { useEffect, useState } from 'react'
import DialogShell from '../../components/DialogShell'
import FormField from '../../components/FormField'
import Segmented from '../../components/Segmented'
import { usePersonNames } from '../../components/usePersonNames'
import type { MortgageSettings, Owner } from '../../lib/mortgage'

interface SetDlgProps {
  open: boolean; settings: MortgageSettings
  onSave: (patch: Partial<MortgageSettings>) => void; onClose: () => void
  onExportJSON: () => void; onExportCSV: () => void; onImportJSON: (e: React.ChangeEvent<HTMLInputElement>) => void
}
export default function SettingsDialog({ open, settings, onSave, onClose, onExportJSON, onExportCSV, onImportJSON }: SetDlgProps) {
  const [form, setForm] = useState({ ...settings })
  useEffect(() => { if (open) setForm({ ...settings }) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const f = (k: keyof MortgageSettings) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const v = e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value
    setForm(p => ({ ...p, [k]: v }))
  }
  function submit(e: React.FormEvent) { e.preventDefault(); onSave({ ...form, owner_a_ownership_pct: Number(form.owner_a_ownership_pct), household_income_yearly: form.household_income_yearly ? Number(form.household_income_yearly) : null }) }
  const { a: aName, b: bName } = usePersonNames(form.owner_a_name, form.owner_b_name)
  return (
    <DialogShell open={open} onClose={onClose} className="bk-dialog">
      <form className="dialog-body" onSubmit={submit}>
        <h3 className="dialog-title">Settings</h3>
        <div className="form-grid">
          <FormField label="Property name (optional)" wide><input type="text" placeholder="e.g. Storgatan 4" value={form.property_name} onChange={f('property_name')} /></FormField>
          <FormField label="Owner A name"><input type="text" value={form.owner_a_name} onChange={f('owner_a_name')} /></FormField>
          <FormField label="Owner B name"><input type="text" value={form.owner_b_name} onChange={f('owner_b_name')} /></FormField>
          {/* The ownership split is a person-independent financial fact (plan
              111): the control names owner A explicitly instead of "my
              ownership", and owner B is always the exact complement. */}
          <FormField label={`${aName} ägarandel (%)`}><input type="text" inputMode="decimal" placeholder="50" value={form.owner_a_ownership_pct} onChange={f('owner_a_ownership_pct')} /></FormField>
          <div className="form-field">
            <span>Which owner am I?</span>
            <Segmented value={(form.i_am as Owner) || 'a'} onChange={v => setForm(p => ({ ...p, i_am: v }))}
              options={[{ v: 'a' as Owner, label: aName }, { v: 'b' as Owner, label: bName }]} />
          </div>
          <FormField label="Currency">
            <select className="select" value={form.currency} onChange={f('currency')}>
              <option value="SEK">SEK · kr</option><option value="NOK">NOK · kr</option><option value="DKK">DKK · kr</option>
              <option value="EUR">EUR · €</option><option value="USD">USD · $</option><option value="GBP">GBP · £</option>
            </select>
          </FormField>
          <FormField label="Household income / year (optional)"><input type="text" inputMode="decimal" placeholder="e.g. 720000" value={form.household_income_yearly ?? ''} onChange={f('household_income_yearly')} /></FormField>
          <label className="form-field checkbox-field form-wide">
            <input type="checkbox" checked={form.ranteavdrag} onChange={f('ranteavdrag')} />
            <span>Show estimated ränteavdrag (interest tax deduction)</span>
          </label>
          <label className="form-field checkbox-field form-wide">
            <input type="checkbox" checked={form.track_contributions} onChange={f('track_contributions')} />
            <span>Track contributions — per-owner amortering &amp; lump sums for contribution-based ownership</span>
          </label>
          <div className="form-field form-wide">
            <span>Backup</span>
            <div className="settings-data-row">
              <button type="button" className="btn btn-ghost" onClick={onExportJSON}>Export JSON</button>
              <button type="button" className="btn btn-ghost" onClick={onExportCSV}>Export CSV</button>
              <label className="btn btn-ghost" style={{ cursor: 'pointer' }}>Import JSON
                <input type="file" accept=".json,application/json" hidden onChange={onImportJSON} />
              </label>
            </div>
            <p className="config-note">Download everything as JSON — loan parts, payments, valuations and settings — or restore a backup (merges by id, so re-importing is safe). Export CSV writes the payment ledger for Excel/Sheets or your tax return.</p>
          </div>
        </div>
        <div className="dialog-actions">
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </DialogShell>
  )
}
