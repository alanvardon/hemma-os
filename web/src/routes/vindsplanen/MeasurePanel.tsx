// Mät: the coded measuring steps as a list with their values and
// uppmätt / uppskattning status, plus the step form (v41 Measure tab and its
// walkthrough card). Selecting a step makes the route fly the camera there and
// highlight where to put the tape; Tillbaka / Hoppa över / Spara och gå
// vidare step through the list, and past the last step the end card says what
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
        return `${st.code}  ${t.title}: ${valueText(st)} (${M[st.code] ? 'uppmätt ' + whenText(M[st.code]) : 'uppskattning'})\n    ${t.how}`
      })
      .join('\n\n')
    try {
      await navigator.clipboard.writeText(txt)
      onToast('Listan kopierad. Klistra in den i en anteckning att ha med dig.')
    } catch {
      onToast('Kopiering är blockerad här.')
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
            <span className="vp-count">Slutet av listan</span>
          </div>
          <h3 id="vp-step-title">{left ? `${left} kvar att mäta` : 'Allt är uppmätt'}</h3>
          <p className="vp-note">
            {left ? 'Listan visar vilka som återstår, markerade Uppskattning.' : 'Titta igen på trappornas varningar: en del av dem beror på de här måtten.'}{' '}
            En dörr som saknas kan läggas till under Rummet → Dörrar på våningen under.
          </p>
          <div className="vp-actions">
            <button type="button" className="btn btn-primary" onClick={() => onOpen(null)}>
              Stäng
            </button>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="vp-pane">
      <div className="vp-group">
        <h2>Vad som ska mätas</h2>
        <div className="vp-progress">
          <b>
            {progress.done} av {progress.total} uppmätta
          </b>
          <span className="vp-meter" aria-hidden="true">
            <i style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
          </span>
        </div>
        <p className="vp-note">
          Varje mått har en kod: A för vinden, B för våningen under, W för fönstren och D för dörrarna på våningen under. Samma kod står på ritningen när måtten visas. Tryck på ett mått för att se var du ska hålla måttbandet och skriv sedan in vad du får.
        </p>
        <div className="vp-actions">
          <button type="button" className="btn btn-primary" onClick={() => onOpen(steps[progress.next]?.code ?? null)}>
            Mät nästa
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void copyList()}>
            Kopiera listan
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
                    aria-label={`${st.code}, ${t.title}: ${valueText(st)}, ${done ? 'uppmätt' : 'uppskattning'}`}
                    onClick={() => onOpen(st.code)}
                  >
                    <span className="vp-code">{st.code}</span>
                    <span className="vp-step-name">
                      <b>{t.title}</b>
                      <small>{t.sub}</small>
                    </span>
                    <span className="vp-step-val">{valueText(st)}</span>
                    <span className={'vp-status' + (done ? ' is-ok' : '')}>{done ? 'Uppmätt' : 'Uppskattning'}</span>
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
  const last = index === total - 1

  function save() {
    const nums = text.map((s) => parseFloat(s.replace(',', '.')))
    const ok = validateInputs(step, nums)
    setBad(ok.map((v) => !v))
    if (ok.some((v) => !v)) return
    const next = applyMeasureStep(geo, plan, step.code, nums, todayISO())
    if (!next) return
    onChange(next)
    onGo(index + 1)
  }

  return (
    <div className="vp-pane">
      <section className="vp-card vp-stepform" aria-labelledby="vp-step-title">
        <div className="vp-step-top">
          <span className="vp-count">
            {index + 1} av {total}
          </span>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Stäng
          </button>
        </div>
        <h3 id="vp-step-title">
          <span className="vp-code">{step.code}</span> {t.title}
        </h3>
        <p className="vp-note">{t.how}</p>
        {bad.some(Boolean) && (
          <p className="vp-warn" role="alert">
            <span className="vp-sr">Varning: </span>Ange ett tal inom det visade intervallet.
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
            <span className="vp-unit">{f.raw ? 'st' : 'cm'}</span>
            <span className="vp-range">
              {f.min}–{f.max}
            </span>
          </div>
        ))}
        <p className="vp-note" role="status">
          {when ? (
            <>
              Uppmätt {whenText(when)}.{' '}
              <button
                type="button"
                className="vp-link"
                onClick={() => {
                  const measured = { ...plan.options.measured }
                  delete measured[step.code]
                  onChange({ ...plan, options: { ...plan.options, measured } })
                }}
              >
                Markera som uppskattning igen
              </button>
            </>
          ) : step.attic ? (
            'Just nu en uppskattning. Sparar du markeras den som uppmätt och vinden ritas om.'
          ) : (
            'Just nu en uppskattning. Sparar du markeras den som uppmätt.'
          )}
        </p>
        <div className="vp-actions">
          <button type="button" className="btn btn-ghost" disabled={index === 0} onClick={() => onGo(index - 1)}>
            Tillbaka
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => onGo(index + 1)}>
            Hoppa över
          </button>
          <button type="button" className="btn btn-primary" onClick={save}>
            {last ? 'Klar' : 'Spara och gå vidare'}
          </button>
        </div>
      </section>
    </div>
  )
}
