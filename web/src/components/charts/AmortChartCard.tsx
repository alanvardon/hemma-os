import { useState } from 'react'
import type { Inputs, LumpPayment } from '../../lib/calc'
import ExpandableChartCard from './ExpandableChartCard'
import AmortChart from './AmortChart'
import AmortPlanner from './AmortPlanner'

// Owns the ephemeral lump-sum list (mirrors the legacy module-level `lumpSums` —
// persists while mounted, reflected in both the preview card and the fullscreen
// planner, not saved to a scenario). The planner lives in the fullscreen view.
export default function AmortChartCard({ inputs }: { inputs: Inputs }) {
  const [lumps, setLumps] = useState<LumpPayment[]>([])

  const subtitle =
    lumps.length > 0
      ? `New vs current · ${lumps.length} extra payment${lumps.length > 1 ? 's' : ''}`
      : 'New vs current — remaining balance over time'

  return (
    <ExpandableChartCard title="Mortgage payoff" subtitle={subtitle} preview={<AmortChart inputs={inputs} lumps={lumps} compact />}>
      <AmortPlanner inputs={inputs} lumps={lumps} setLumps={setLumps} />
    </ExpandableChartCard>
  )
}
