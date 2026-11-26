// "Compare variants" (plan 149, Save tab): one column per plan variant with
// the numbers that tell two layouts apart. Values come from summarizeVariant
// (the pure core); the table scrolls sideways inside its own box on a phone.

import { useMemo } from 'react'
import type { PlanV2 } from '../../lib/vindsplanen/plan'
import { summarizeVariant, type VariantSummary } from './compare'
import { fmt, fmtKr } from './fmt'

const ROWS: { label: string; value: (s: VariantSummary) => string }[] = [
  { label: 'Floor inside the knee walls', value: (s) => `${fmt(s.floor, 1)} m²` },
  { label: 'Standing height, ≥ 1,90 m', value: (s) => `${fmt(s.stand, 1)} m²` },
  { label: 'Living area, approx.', value: (s) => `${fmt(s.boa, 1)} m²` },
  { label: 'Warnings', value: (s) => String(s.warnings) },
  { label: 'Stairs', value: (s) => String(s.stairs) },
  { label: 'Roof windows', value: (s) => String(s.windows) },
  { label: 'Estimated cost (own prices)', value: (s) => (s.cost === null ? '–' : fmtKr(s.cost)) },
]

export default function ComparePanel({
  variants, openId,
}: {
  variants: { id: string; name: string; plan: PlanV2 }[]
  openId: string | null
}) {
  const cols = useMemo(() => variants.map((v) => ({ id: v.id, name: v.name, s: summarizeVariant(v.plan) })), [variants])
  return (
    <div className="vp-group">
      <h2>Compare variants</h2>
      {cols.length < 2 ? (
        <p className="vp-note">Make a second version of the plan with “New copy” at the top, then compare them here.</p>
      ) : (
        <div className="vp-compare" role="region" aria-label="Compare variants" tabIndex={0}>
          <table>
            <thead>
              <tr>
                <td />
                {cols.map((c) => (
                  <th key={c.id} scope="col" aria-current={c.id === openId ? 'true' : undefined}>
                    {c.name}
                    {c.id === openId && <small>open</small>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.label}>
                  <th scope="row">{r.label}</th>
                  {cols.map((c) => (
                    <td key={c.id}>{r.value(c.s)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
