import { describe, expect, it } from 'vitest'
import { headText, WHERE_TEXT } from './walkText'

describe('walk HUD text (v41 1815–1826)', () => {
  it('rounds the headroom to whole centimetres and warns below 185 cm', () => {
    expect(headText(2.304, 'attic', false)).toBe('Headroom 230 cm')
    expect(headText(1.85, 'below', false)).toBe('Headroom 185 cm')
    expect(headText(1.849, 'new', false)).toBe('Headroom 185 cm · mind your head, you have to stoop')
  })

  it('adds the B9 hint only when stooping on the old stairs with B9 unmeasured', () => {
    const hint = ' (the old stairs’ step depth is a guess: measure B9)'
    expect(headText(1.62, 'old', false)).toBe('Headroom 162 cm · mind your head, you have to stoop' + hint)
    expect(headText(1.62, 'old', true)).not.toContain('B9')
    expect(headText(1.62, 'ground', false)).not.toContain('B9')
    expect(headText(2.1, 'old', false)).toBe('Headroom 210 cm')
  })

  it('names every place you can stand', () => {
    expect(Object.keys(WHERE_TEXT).sort()).toEqual(['attic', 'below', 'ground', 'new', 'old'])
  })
})
