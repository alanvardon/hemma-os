import { describe, expect, it } from 'vitest'
import { headText, WHERE_TEXT } from './walkText'

describe('walk HUD text (v41 1815–1826 in Swedish)', () => {
  it('rounds the headroom to whole centimetres and warns below 185 cm', () => {
    expect(headText(2.304, 'attic', false)).toBe('Fri höjd 230 cm')
    expect(headText(1.85, 'below', false)).toBe('Fri höjd 185 cm')
    expect(headText(1.849, 'new', false)).toBe('Fri höjd 185 cm · se upp med huvudet, du måste böja dig')
  })

  it('adds the B9 hint only when stooping on the old stairs with B9 unmeasured', () => {
    const hint = ' (den gamla trappans stegdjup är en gissning: mät B9)'
    expect(headText(1.62, 'old', false)).toBe('Fri höjd 162 cm · se upp med huvudet, du måste böja dig' + hint)
    expect(headText(1.62, 'old', true)).not.toContain('B9')
    expect(headText(1.62, 'ground', false)).not.toContain('B9')
    expect(headText(2.1, 'old', false)).toBe('Fri höjd 210 cm')
  })

  it('names every place you can stand', () => {
    expect(Object.keys(WHERE_TEXT).sort()).toEqual(['attic', 'below', 'ground', 'new', 'old'])
  })
})
