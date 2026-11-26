// Plan tab: add menu, the selected item's editor, the item list with warning
// counts, and the rooms the partition walls make (v41 Layout tab).

import type { Geometry } from '../../lib/vindsplanen/attic'
import { ADD_ORDER } from '../../lib/vindsplanen/items'
import type { Item, ItemType, PlanV2 } from '../../lib/vindsplanen/plan'
import type { Zones } from '../../lib/vindsplanen/zones'
import type { RuleResult } from '../../lib/vindsplanen/rules'
import { realWarnings, type Warning } from '../../lib/vindsplanen/warnings'
import { fmt } from './fmt'
import ItemEditor from './ItemEditor'
import { TYPE_LABEL, describeItem } from './itemText'
import RulesPanel from './RulesPanel'

export default function LayoutPanel({
  geo, plan, zones, warnings, rules, holesOk, selectedId, onSelect, onAdd, onPatch, onDuplicate, onDelete,
}: {
  geo: Geometry
  plan: PlanV2
  zones: Zones
  warnings: Record<string, Warning[]>
  rules: readonly RuleResult[]
  holesOk: ReadonlySet<string>
  selectedId: string | null
  onSelect: (id: string | null) => void
  onAdd: (type: ItemType) => void
  onPatch: (id: string, patch: Record<string, unknown>) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
}) {
  const selected: Item | undefined = plan.items.find((i) => i.id === selectedId)
  const area = (n: number) => fmt(n * zones.cellArea, 1)
  return (
    <div className="vp-pane">
      <div className="vp-group">
        <h2>Add</h2>
        <div className="vp-adds">
          {ADD_ORDER.map((t) => (
            <button key={t} type="button" className="btn btn-ghost" onClick={() => onAdd(t)}>
              + {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
      </div>

      {selected && (
        <ItemEditor
          key={selected.id}
          geo={geo}
          plan={plan}
          item={selected}
          warnings={warnings[selected.id] ?? []}
          holesOk={holesOk}
          onPatch={(patch) => onPatch(selected.id, patch)}
          onDone={() => onSelect(null)}
          onDuplicate={() => onDuplicate(selected.id)}
          onDelete={() => onDelete(selected.id)}
        />
      )}

      <div className="vp-group">
        <h2>In the plan</h2>
        {plan.items.length === 0 ? (
          <p className="vp-note">Nothing in the plan yet. Add something above.</p>
        ) : (
          <ul className="vp-list">
            {plan.items.map((it) => {
              const n = realWarnings(warnings[it.id] ?? []).length
              return (
                <li key={it.id}>
                  <button type="button" aria-current={it.id === selectedId} onClick={() => onSelect(it.id)}>
                    <span className="vp-list-name">{TYPE_LABEL[it.type]}</span>
                    <span className="vp-list-meta">{describeItem(geo, plan, it)}</span>
                    {n > 0 && (
                      <span className="vp-badge" title="Has warnings">
                        {n} {n === 1 ? 'warning' : 'warnings'}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="vp-group">
        <h2>Rooms, split by partition walls</h2>
        <div className="vp-rooms">
          {zones.segs.map((s, i) => (
            <div key={i}>
              <span>
                Room {i + 1} · {fmt(s.a)}–{fmt(s.b)} m
              </span>
              <span>
                {area(s.boa)} m² · {area(s.stand)} m² standing
              </span>
            </div>
          ))}
        </div>
      </div>

      <RulesPanel rules={rules} items={plan.items} selectedId={selectedId} onSelect={onSelect} />
    </div>
  )
}
