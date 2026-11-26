// Plan 144: the real sun's date and time control, shown over the 3D view while
// Lighting is "Real sun". The date is a month and day in the current Swedish
// year (a native date picker clamped to that year); the time is a slider in
// 15-minute steps. All text comes from sunText.ts.

import { useMemo } from 'react'
import type { Site, ViewPrefs } from '../../lib/vindsplanen/plan'
import { sunReadout, stockholmYear } from './sunText'

const STEP = 15

export default function SunControl({ view, site, onView, hidden }: { view: ViewPrefs; site: Site; onView: (v: ViewPrefs) => void; hidden?: boolean }) {
  const year = useMemo(() => stockholmYear(), [])
  const r = sunReadout(year, view.sunDate, view.sunMinutes, site)
  return (
    <div className="vp-sun" role="group" aria-label="Real sun" hidden={hidden}>
      <div className="vp-sun-row">
        <label htmlFor="vp-sun-date">Date</label>
        <input
          id="vp-sun-date"
          type="date"
          min={`${year}-01-01`}
          max={`${year}-12-31`}
          value={`${year}-${view.sunDate}`}
          onChange={(e) => {
            const m = /^\d{4}-(\d{2}-\d{2})$/.exec(e.target.value)
            if (m && m[1] !== view.sunDate && !(m[1] === '02-29')) onView({ ...view, sunDate: m[1] })
          }}
        />
        <label htmlFor="vp-sun-time">Time</label>
        <input
          id="vp-sun-time"
          type="range"
          min={0}
          max={1440 - STEP}
          step={STEP}
          value={Math.min(1440 - STEP, Math.round(view.sunMinutes / STEP) * STEP)}
          aria-valuetext={r.label}
          onChange={(e) => onView({ ...view, sunMinutes: Number(e.target.value) })}
        />
      </div>
      <p className="vp-sun-text" role="status" aria-live="off">
        <b>{r.label}</b>
        <span>{r.daylight}</span>
      </p>
    </div>
  )
}
