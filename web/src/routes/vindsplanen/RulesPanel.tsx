// Rules check (plan 146): the plan against the few Boverket building rules the
// model can grade, then the rules that are judged case by case. A collapsible
// group at the bottom of the Plan tab (a sixth tab would not fit the tab bar at
// 320 px); the summary line shows the tally while it is closed. Status is
// always an icon plus a word, never colour alone. Rows tied to a plan item are
// buttons that select it, like the item list.

import type { Item } from '../../lib/vindsplanen/plan'
import { RULES_SOURCE, type RuleResult, type RuleStatus } from '../../lib/vindsplanen/rules'
import { TYPE_LABEL } from './itemText'
import { ruleText, rulesSummary, STATUS_LABEL } from './rulesText'

const ICON: Record<RuleStatus, string> = { ok: '✓', fail: '✕', unknown: '?', info: 'i' }

function Row({ r, item, selectedId, onSelect }: { r: RuleResult; item?: Item; selectedId: string | null; onSelect: (id: string) => void }) {
  const body = (
    <>
      <span className={`vp-rule-status is-${r.status}`}>
        <span aria-hidden="true">{ICON[r.status]}</span> {STATUS_LABEL[r.status]}
      </span>
      <span className="vp-rule-text">
        {item && <b>{TYPE_LABEL[item.type]}. </b>}
        {ruleText(r)}
      </span>
      <span className="vp-rule-ref">{r.ref}</span>
    </>
  )
  return (
    <li>
      {item ? (
        <button type="button" className="vp-rule" aria-current={item.id === selectedId} onClick={() => onSelect(item.id)}>
          {body}
        </button>
      ) : (
        <div className="vp-rule">{body}</div>
      )}
    </li>
  )
}

export default function RulesPanel({
  rules, items, selectedId, onSelect,
}: {
  rules: readonly RuleResult[]
  items: readonly Item[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const byId = new Map(items.map((i) => [i.id, i]))
  const checked = rules.filter((r) => r.status !== 'info')
  const caseByCase = rules.filter((r) => r.status === 'info')
  const list = (rs: readonly RuleResult[]) => (
    <ul className="vp-rules-list">
      {rs.map((r, i) => (
        <Row key={`${r.id}-${r.itemId ?? ''}-${i}`} r={r} item={r.itemId ? byId.get(r.itemId) : undefined} selectedId={selectedId} onSelect={onSelect} />
      ))}
    </ul>
  )
  return (
    <details className="vp-group vp-rules">
      <summary>
        <span className="vp-rules-title">Rules check</span>
        <span className="vp-rules-tally">{rulesSummary(rules)}</span>
      </summary>
      <div className="vp-rules-body">
        <h3 className="vp-sub">Can be checked</h3>
        {list(checked)}
        <h3 className="vp-sub">Assessed case by case</h3>
        {list(caseByCase)}
        <p className="vp-note">{RULES_SOURCE}</p>
      </div>
    </details>
  )
}
