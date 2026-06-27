import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DropdownMenu } from 'radix-ui'
import { motion, type Variants } from 'motion/react'
import NumberFlow from '@number-flow/react'
import type { Inputs, Figures } from '../lib/calc'
import { fmt, fmtCompact } from '../lib/format'

// One scenario as a full-width labelled row. The whole row is the open target;
// the kebab (saved rows) or the Continue/Discard footer (the draft) carry the
// rest. Price and monthly cost are the two co-anchors (large); the remaining
// figures are labelled stat cells that line up column-wise down the list so
// scenarios can be compared at a glance. Motion is gated by the `reduce` flag.

interface Props {
  name: string
  dateLabel: string
  inputs: Inputs
  figures: Figures
  reduce: boolean
  variants?: Variants
  /** Draft variant: dashed treatment, Continue/Discard footer, no kebab/rename. */
  draft?: boolean
  onOpen: () => void
  onContinue?: () => void
  onDiscard?: () => void
  onDuplicate?: () => void
  onDelete?: () => void
  onRename?: (name: string) => void
}

// LTV health bands per amorteringskrav / bolånetak: ≤70% low amort, 70–85% the
// 2% requirement, >85% over the loan-to-value ceiling.
function ltvTone(ltv: number): 'good' | 'warn' | 'bad' {
  if (ltv > 85) return 'bad'
  if (ltv > 70) return 'warn'
  return 'good'
}

function Stat({
  label,
  k,
  tone,
  lead,
  children,
}: {
  label: string
  /** Layout key → .row-stat-<k> min-width class so columns line up down the list. */
  k: string
  tone?: 'good' | 'warn' | 'bad'
  lead?: boolean
  children: ReactNode
}) {
  return (
    <div className={'row-stat row-stat-' + k + (lead ? ' row-stat-lead' : '')}>
      <span className="row-stat-label">{label}</span>
      <span className={'row-stat-val' + (tone ? ' tone-' + tone : '')}>{children}</span>
    </div>
  )
}

export default function ScenarioCard({
  name,
  dateLabel,
  inputs,
  figures,
  reduce,
  variants,
  draft = false,
  onOpen,
  onContinue,
  onDiscard,
  onDuplicate,
  onDelete,
  onRename,
}: Props) {
  const open = draft ? onContinue ?? onOpen : onOpen

  // Monthly count-up: start at 0 and roll to the real value once mounted. Under
  // reduced motion render the final value straight away (NumberFlow won't roll).
  const [monthlyVal, setMonthlyVal] = useState(reduce ? figures.totalMonthly : 0)
  useEffect(() => {
    if (!reduce) setMonthlyVal(figures.totalMonthly)
  }, [reduce, figures.totalMonthly])

  // Inline rename, reusing the calculator header's .scenario-title-input pattern.
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)
  // Set when Rename is chosen so the menu's close-autofocus hands focus to the
  // input instead of bouncing back to the kebab trigger (Radix focus dance).
  const renamePending = useRef(false)
  useEffect(() => {
    if (editing) {
      const id = requestAnimationFrame(() => inputRef.current?.select())
      return () => cancelAnimationFrame(id)
    }
  }, [editing])

  const startRename = () => {
    setDraftName(name)
    setEditing(true)
  }
  const commitRename = () => {
    setEditing(false)
    const next = draftName.trim()
    if (next && next !== name) onRename?.(next)
  }

  const exit = reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98, transition: { duration: 0.16 } }

  return (
    <motion.div
      className={'scenario-row' + (draft ? ' draft-row' : '')}
      variants={variants}
      exit={exit}
      role="button"
      tabIndex={editing ? -1 : 0}
      aria-label={draft ? 'Continue unsaved draft' : `Open ${name || 'Untitled'}`}
      onClick={() => {
        if (!editing) open?.()
      }}
      onKeyDown={(e) => {
        if (editing) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open?.()
        }
      }}
    >
      <div className="row-id">
        {editing ? (
          <input
            ref={inputRef}
            className="scenario-title-input scenario-row-rename"
            value={draftName}
            aria-label="Scenario name"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <h3 className="row-name" title={name || 'Untitled'}>
            {name || 'Untitled'}
          </h3>
        )}
        <span className="row-date">{dateLabel}</span>
      </div>

      <div className="row-stats">
        <Stat label="Price" k="price" lead>
          {fmtCompact(inputs.newPrice || 0)}
        </Stat>
        <Stat label="Monthly" k="monthly" lead>
          <NumberFlow
            value={monthlyVal}
            locales="sv-SE"
            format={{ style: 'currency', currency: 'SEK', maximumFractionDigits: 0 }}
            suffix=" / mån"
          />
          <span className="row-stat-sub">eff. {fmt(figures.effectiveMonthly)}</span>
        </Stat>
        <Stat label="Cash" k="cash" tone={figures.cashBalance >= 0 ? 'good' : 'bad'}>
          {fmtCompact(figures.cashBalance, true)}
        </Stat>
        <Stat label="LTV" k="ltv" tone={ltvTone(figures.ltv)}>
          {Math.round(figures.ltv)}%
        </Stat>
        <Stat label="Req. lön" k="salary">
          {fmtCompact(figures.reqSalaryMonthly)} / mån
        </Stat>
      </div>

      {!draft && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            className="scenario-kebab"
            aria-label="Scenario actions"
            onClick={(e) => e.stopPropagation()}
          >
            ⋯
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="kebab-menu"
              align="end"
              sideOffset={6}
              onClick={(e) => e.stopPropagation()}
              onCloseAutoFocus={(e) => {
                // Rename: keep focus off the trigger so our input keeps it.
                if (renamePending.current) {
                  e.preventDefault()
                  renamePending.current = false
                }
              }}
            >
              <DropdownMenu.Item className="kebab-item" onSelect={() => onDuplicate?.()}>
                Duplicate
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="kebab-item"
                onSelect={() => {
                  renamePending.current = true
                  startRename()
                }}
              >
                Rename
              </DropdownMenu.Item>
              <DropdownMenu.Item className="kebab-item kebab-danger" onSelect={() => onDelete?.()}>
                Delete
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}

      {draft && (
        <div className="row-footer">
          <button
            className="btn btn-primary"
            onClick={(e) => {
              e.stopPropagation()
              onContinue?.()
            }}
          >
            Continue
          </button>
          <button
            className="btn btn-ghost"
            onClick={(e) => {
              e.stopPropagation()
              onDiscard?.()
            }}
          >
            Discard
          </button>
        </div>
      )}
    </motion.div>
  )
}
