import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type RouteSheet = {
  file: string
  root: string
  // A document-level scroll lock cannot be expressed as a descendant selector.
  // Keep such exceptions small and explain why they must remain global.
  allowUnscoped?: readonly string[]
}

const routeSheets: readonly RouteSheet[] = [
  { file: 'home.css', root: '.hub-root' },
  { file: 'konsultkalkyl.css', root: '.kk-root' },
  { file: 'lonevaxling.css', root: '.lv-root' },
  { file: 'student-loan.css', root: '.sl-root' },
  { file: 'bolanekoll.css', root: '.bk-root' },
  { file: 'manadsavslut.css', root: '.ma-root' },
  { file: 'hushallsbudget.css', root: '.hb-root', allowUnscoped: ['html:has(dialog.hb-modal[open])'] },
  { file: 'huskalendern.css', root: '.hk-root' },
  { file: 'dashboard.css', root: '.bk-page-root' },
]

type Scope = { scoped: boolean; keyframes: boolean }

function removeComments(css: string) {
  return css.replaceAll(/\/\*[\s\S]*?\*\//g, '')
}

function auditSelectors(css: string, root: string) {
  const source = removeComments(css)
  const stack: Scope[] = [{ scoped: false, keyframes: false }]
  const unscoped: string[] = []
  const duplicatedRoot: string[] = []
  let start = 0

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '{') {
      // Nested rules may follow declarations. CSS declarations always end with
      // a semicolon, while the route styles do not use semicolons in selectors.
      const segment = source.slice(start, index)
      const header = segment.slice(segment.lastIndexOf(';') + 1).trim()
      const parent = stack.at(-1)!
      const keyframes = parent.keyframes || /^@(?:-[a-z]+-)?keyframes\b/.test(header)
      const atRule = header.startsWith('@')
      const scopedHere = header.includes(root)
      const scoped = parent.scoped || scopedHere

      if (!atRule && !keyframes && header) {
        if (!scoped) unscoped.push(header)
        if (parent.scoped && scopedHere) duplicatedRoot.push(header)
      }
      stack.push({ scoped, keyframes })
      start = index + 1
    } else if (character === '}') {
      stack.pop()
      start = index + 1
    }
  }

  return { duplicatedRoot, unscoped }
}

describe('route stylesheet scoping', () => {
  it('keeps route-owned selectors below their route root', () => {
    const violations = routeSheets.flatMap(({ file, root, allowUnscoped = [] }) => {
      const css = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
      const { unscoped, duplicatedRoot } = auditSelectors(css, root)
      return [
        ...unscoped
        .filter((selector) => !allowUnscoped.includes(selector))
        .map((selector) => `${file}: ${selector}`),
        ...duplicatedRoot.map((selector) => `${file}: nested ${root}: ${selector}`),
      ]
    })

    // This catches bare html/body/form-element selectors and generic classes
    // such as .field, .card, and .layout before they can depend on import order.
    expect(violations).toEqual([])
  })
})
