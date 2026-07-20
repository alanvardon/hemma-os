import { useEffect, useState } from 'react'
import DialogShell from '../../components/DialogShell'
import FormField from '../../components/FormField'
import Segmented from '../../components/Segmented'
import type { MonthEndSettings } from '../../lib/manadsavslut'
import { clean } from './shared'

interface SetDlgProps {
  open: boolean; settings: MonthEndSettings
  /** Plan 111: once bound, canonical household names replace the editable A/B
      name fields with a link to the household dialog. Legacy fields persist as a
      fallback for unmapped households (they still save on submit). */
  bound?: boolean; boundNames?: { a: string; b: string }; onManagePeople?: () => void
  onSave: (patch: Partial<MonthEndSettings>) => void; onClose: () => void
  onExport: () => void; onImport: (e: React.ChangeEvent<HTMLInputElement>) => void
}
export default function SettingsDialog({ open, settings, bound, boundNames, onManagePeople, onSave, onClose, onExport, onImport }: SetDlgProps) {
  const [form, setForm] = useState({ ...settings })
  useEffect(() => { if (open) setForm({ ...settings }) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  function submit(e: React.FormEvent) {
    e.preventDefault()
    onSave({ person_a_name: clean(form.person_a_name) || 'Person A', person_b_name: clean(form.person_b_name) || 'Person B', currency: form.currency || 'SEK', default_split: !!form.default_split })
  }
  return (
    <DialogShell open={open} onClose={onClose} className="ma-dialog">
      <form className="dialog-body" onSubmit={submit}>
        <h3 className="dialog-title">Settings</h3>
        <div className="form-grid">
          {bound ? (
            <div className="form-field form-wide">
              <span>Personer</span>
              <p className="config-note">{boundNames?.a} &amp; {boundNames?.b} — hämtas från hushållet.</p>
              <button type="button" className="link-btn" onClick={() => { onClose(); onManagePeople?.() }}>Hantera personer i Hushåll →</button>
            </div>
          ) : (
            <>
              <FormField label="Name A"><input type="text" autoComplete="off" value={form.person_a_name} onChange={e => setForm(p => ({ ...p, person_a_name: e.target.value }))} /></FormField>
              <FormField label="Name B"><input type="text" autoComplete="off" value={form.person_b_name} onChange={e => setForm(p => ({ ...p, person_b_name: e.target.value }))} /></FormField>
            </>
          )}
          <div className="form-field form-wide">
            <span>Default treatment for new / imported rows</span>
            <Segmented value={form.default_split ? 'split' : 'full'} onChange={v => setForm(p => ({ ...p, default_split: v === 'split' }))} options={[{ v: 'split' as const, label: 'Split 50/50' }, { v: 'full' as const, label: 'Owes all' }]} />
          </div>
          <FormField label="Currency" wide>
            <select className="select" value={form.currency} onChange={e => setForm(p => ({ ...p, currency: e.target.value }))}>
              <option value="SEK">SEK · kr</option><option value="NOK">NOK · kr</option><option value="DKK">DKK · kr</option>
              <option value="EUR">EUR · €</option><option value="USD">USD · $</option><option value="GBP">GBP · £</option>
            </select>
          </FormField>
          <div className="form-field form-wide">
            <span>Backup</span>
            <div className="settings-data-row">
              <button type="button" className="btn btn-ghost" onClick={onExport}>Export JSON</button>
              <label className="btn btn-ghost" style={{ cursor: 'pointer' }}>Import JSON
                <input type="file" accept=".json,application/json" hidden onChange={onImport} />
              </label>
            </div>
            <p className="config-note">Download everything — items, settlements and settings — or restore a backup (merges by id, so re-importing is safe).</p>
          </div>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </DialogShell>
  )
}
