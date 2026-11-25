// Measure tab: the coded measuring steps as a list with their values and
// measured / estimate status, plus the step form (v41 Measure tab and its
// walkthrough card). Selecting a step makes the route fly the camera there and
// highlight where to put the tape; Back / Skip / Save and
// continue step through the list, and past the last step the end card says what
// is left (v41 `showWalk`). Changing an attic measurement redraws the attic in
// place and moves on to the next step — no reload, so nothing to resume.

import { useState } from 'react'
import type { Geometry } from '../../lib/vindsplanen/attic'
import { applyMeasureStep, fieldDisplay, measureProgress, validateInputs, type MeasureStep } from '../../lib/vindsplanen/measure'
import type { PlanV2 } from '../../lib/vindsplanen/plan'
import { todayISO } from '../../lib/date'
import { GROUPS, stepText, valueText, whenText } from './measureText'

/** `activeCode` past the last step: the end-of-list card. */
export const MEASURE_END = 'end'

export default function MeasurePanel({
  geo, plan, steps, activeCode, onOpen, onChange, onToast,
}: {
  geo: Geometry
  plan: PlanV2
  steps: MeasureStep[]
  activeCode: string | null
  onOpen: (code: string | null) => void
  onChange: (next: PlanV2) => void
  onToast: (msg: string) => void
}) {
  const M = plan.options.measured
  const side = plan.options.below.side
  const progress = measureProgress(steps, M)
  const idx = activeCode ? steps.findIndex((s) => s.code === activeCode) : -1
  const go = (i: number) => onOpen(i >= 0 && i < steps.length ? steps[i].code : i >= steps.length ? MEASURE_END : null)

  async function copyList() {
    const txt = steps
      .map((st) => {
        const t = stepText(st, side)
        return `${st.code}  ${t.title}: ${valueText(st)} (${M[st.code] ? 'measured ' + whenText(M[st.code]) : 'estimate'})\n    ${t.how}`
      })
      .join('\n\n')
    try {
      await navigator.clipboard.writeText(txt)
      onToast('List copied. Paste it into a note to take with you.')
    } catch {
      onToast('Copying is blocked here.')
    }
  }

  if (idx >= 0) {
    const st = steps[idx]
    return (
      <StepForm
        key={st.code}
        geo={geo}
        plan={plan}
        step={st}
        index={idx}
        total={steps.length}
        onClose={() => onOpen(null)}
        onGo={go}
        onChange={onChange}
      />
    )
  }

  if (activeCode === MEASURE_END) {
    const left = progress.total - progress.done
    return (
      <div className="vp-pane">
        <section className="vp-card vp-stepform" aria-labelledby="vp-step-title">
          <div className="vp-step-top">
            <span className="vp-count">End of the list</span>
          </div>
          <h3 id="vp-step-title">{left ? `${left} left to measure` : 'Everything is measured'}</h3>
          <p className="vp-note">
            {left ? 'The list shows which are left, marked Estimate.' : 'Look at the stairs’ warnings again: some of them depend on these measurements.'}{' '}
            A missing door can be added under Room → Doors on the floor below.
          </p>
          <div className="vp-actions">
            <button type="button" className="btn btn-primary" onClick={() => onOpen(null)}>
              Close
            </button>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="vp-pane">
      <div className="vp-group">
        <h2>What to measure</h2>
        <div className="vp-progress">
          <b>
            {progress.done} of {progress.total} measured
          </b>
          <span className="vp-meter" aria-hidden="true">
            <i style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
          </span>
        </div>
        <p className="vp-note">
          Each measurement has a code: A for the attic, B for the floor below, W for the windows and D for the doors on the floor below. The same code appears on the model when measurements are shown. Tap a measurement to see where to hold the tape, then type in what you get.
        </p>
        <div className="vp-actions">
          <button type="button" className="btn btn-primary" onClick={() => onOpen(steps[progress.next]?.code ?? null)}>
            Measure next
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void copyList()}>
            Copy the list
          </button>
        </div>
      </div>
      {GROUPS.map((g) => {
        const list = steps.filter((s) => s.code[0] === g.code)
        if (!list.length) return null
        return (
          <div className="vp-group" key={g.code}>
            <h2>
              {g.title}
              <small>
                {list.filter((s) => M[s.code]).length}/{list.length}
              </small>
            </h2>
            <p className="vp-note">{g.note}</p>
            <div className="vp-steps">
              {list.map((st) => {
                const t = stepText(st, side)
                const done = !!M[st.code]
                return (
                  <button
                    key={st.code}
                    type="button"
                    className="vp-step"
                    aria-label={`${st.code}, ${t.title}: ${valueText(st)}, ${done ? 'measured' : 'estimate'}`}
                    onClick={() => onOpen(st.code)}
                  >
                    <span className="vp-code">{st.code}</span>
                    <span className="vp-step-name">
                      <b>{t.title}</b>
                      <small>{t.sub}</small>
                    </span>
                    <span className="vp-step-val">{valueText(st)}</span>
                    <span className={'vp-status' + (done ? ' is-ok' : '')}>{done ? 'Measured' : 'Estimate'}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function StepForm({
  geo, plan, step, index, total, onClose, onGo, onChange,
}: {
  geo: Geometry
  plan: PlanV2
  step: MeasureStep
  index: number
  total: number
  onClose: () => void
  onGo: (i: number) => void
  onChange: (next: PlanV2) => void
}) {
  const side = plan.options.below.side
  const t = stepText(step, side)
  const when = plan.options.measured[step.code]
  const [text, setText] = useState<string[]>(() => step.fields.map((f) => String(fieldDisplay(f))))
  const [bad, setBad] = useState<boolean[]>([])
  const [openingStep, setOpeningStep] = useState('')
  const [badOpeningStep, setBadOpeningStep] = useState(false)
  const last = index === total - 1

  function save() {
    const nums = text.map((s) => parseFloat(s.replace(',', '.')))
    const ok = validateInputs(step, nums)
    setBad(ok.map((v) => !v))
    if (ok.some((v) => !v)) return
    const openingAboveStep = openingStep === '' ? undefined : Number(openingStep)
    const next = applyMeasureStep(geo, plan, step.code, nums, todayISO(), { openingAboveStep })
    if (!next) {
      setBadOpeningStep(openingAboveStep !== undefined)
      return
    }
    onChange(next)
    onGo(index + 1)
  }

  return (
    <div className="vp-pane">
      <section className="vp-card vp-stepform" aria-labelledby="vp-step-title">
        <div className="vp-step-top">
          <span className="vp-count">
            {index + 1} of {total}
          </span>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <h3 id="vp-step-title">
          <span className="vp-code">{step.code}</span> {t.title}
        </h3>
        <p className="vp-note">{t.how}</p>
        {bad.some(Boolean) && (
          <p className="vp-warn" role="alert">
            <span className="vp-sr">Warning: </span>Enter a number within the range shown.
          </p>
        )}
        {step.fields.map((f, k) => (
          <div className="vp-row" key={f.key}>
            <label htmlFor={`vp-m-${k}`}>{t.fields[k] ?? f.key}</label>
            <input
              id={`vp-m-${k}`}
              type="number"
              inputMode="decimal"
              min={f.min}
              max={f.max}
              step={f.raw ? 1 : 0.5}
              value={text[k]}
              aria-invalid={bad[k] ? true : undefined}
              onChange={(e) => setText(text.map((v, i) => (i === k ? e.target.value : v)))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save()
              }}
            />
            <span className="vp-unit">{f.raw ? 'pcs' : 'cm'}</span>
            <span className="vp-range">
              {f.min}–{f.max}
            </span>
          </div>
        ))}
        {step.code === 'B9' && (
          <>
            <div className="vp-row">
              <label htmlFor="vp-opening-step">Step under the opening edge (optional)</label>
              <input
                id="vp-opening-step"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={openingStep}
                aria-describedby="vp-opening-step-help"
                aria-invalid={badOpeningStep || undefined}
                onChange={(e) => {
                  setOpeningStep(e.target.value)
                  setBadOpeningStep(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') save()
                }}
              />
            </div>
            <p id="vp-opening-step-help" className="vp-note">
              Count from the bottom. The opening will start above the front edge of this step.
            </p>
            {badOpeningStep && <p className="vp-warn" role="alert">Choose a whole step number before the turn that places the opening inside the hallway.</p>}
          </>
        )}
        <p className="vp-note" role="status">
          {when ? (
            <>
              Measured {whenText(when)}.{' '}
              <button
                type="button"
                className="vp-link"
                onClick={() => {
                  const measured = { ...plan.options.measured }
                  delete measured[step.code]
                  onChange({ ...plan, options: { ...plan.options, measured } })
                }}
              >
                Mark as an estimate again
              </button>
            </>
          ) : step.attic ? (
            'Currently an estimate. Saving marks it as measured and redraws the attic.'
          ) : (
            'Currently an estimate. Saving marks it as measured.'
          )}
        </p>
        <div className="vp-actions">
          <button type="button" className="btn btn-ghost" disabled={index === 0} onClick={() => onGo(index - 1)}>
            Back
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => onGo(index + 1)}>
            Skip
          </button>
          <button type="button" className="btn btn-primary" onClick={save}>
            {last ? 'Done' : 'Save and continue'}
          </button>
        </div>
      </section>
    </div>
  )
}
