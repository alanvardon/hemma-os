import { describe, expect, it } from 'vitest'
import { applyMortgageSync, defaultState } from './hushallsbudget'
import { migrateBudget } from './hushallsbudget-store'

describe('migrateBudget', () => {
  it('keeps synced mortgage rows category-less while categorising ordinary joint rows', () => {
    const state = applyMortgageSync(defaultState(), { ranta: 8_550, amortering: 3_000 })
    state.costs.push({ id: 'manual', label: 'Manuell kostnad', amount: 500, owner: 'joint' })

    const migrated = migrateBudget(state)!
    const fallback = migrated.categories[migrated.categories.length - 1].id
    expect(migrated.costs.filter((row) => row.source === 'bolanekoll').every((row) => row.category === undefined)).toBe(true)
    expect(migrated.costs.find((row) => row.id === 'manual')?.category).toBe(fallback)
  })
})
