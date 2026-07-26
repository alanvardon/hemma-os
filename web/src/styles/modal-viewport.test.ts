import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Every modal surface must be sized against the SMALL viewport.
//
// `vh` (and the `%` a modal <dialog> inherits from the UA stylesheet, and the
// `100%` a `position: fixed; inset: 0` box resolves to) is the LARGE viewport:
// the page height with the phone's browser chrome retracted. The chrome is
// normally on screen, so a modal sized that way renders taller than the band
// the user can see — its footer, and with it Avbryt/Spara, sits behind the
// browser UI with no scrollbar to reveal it. That is what made the taller
// dialogs unusable on mobile.
//
// The rules below are load-bearing and easy to undo by copying a nearby `vh`,
// so assert them here rather than trusting a browser check nobody re-runs.

const read = (file: string) =>
  readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').replaceAll(/\/\*[\s\S]*?\*\//g, '')

/** Declarations of `prop` inside the first rule whose selector contains `selector`. */
function declarations(css: string, selector: string, prop: string) {
  const start = css.indexOf(selector)
  expect(start, `${selector} not found`).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', start)
  const block = css.slice(open + 1, css.indexOf('}', open))
  return [...block.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]+)`, 'g'))].map((m) => m[1].trim())
}

const bareVh = /\d\s*vh\b/

describe('modal viewport sizing', () => {
  it('caps every top-layer <dialog> against the visible band', () => {
    const tokens = read('tokens.css')
    const global = read('global.css')

    // The correction for `margin: auto` centring a dialog in the large viewport
    // while only the small viewport is on screen — see tokens.css.
    expect(declarations(tokens, ':root', '--dialog-max-h')).toEqual(['calc(200svh - 100lvh - 2rem)'])
    expect(declarations(global, 'dialog:modal', 'max-height')).toEqual(['var(--dialog-max-h)'])
    // Content past the cap scrolls inside the dialog instead of leaking to the page.
    expect(declarations(global, 'dialog:modal', 'overscroll-behavior')).toEqual(['contain'])
    expect(global).toContain('html:has(dialog:modal) { overflow: hidden; }')
  })

  it('folds the cap into dialogs that set their own max-height', () => {
    // A more specific selector than `dialog:modal` silently opts out of the
    // global cap, so every such rule has to re-apply it.
    expect(declarations(read('hushallsbudget.css'), 'dialog.hb-modal', 'max-height'))
      .toEqual(['min(720px, var(--dialog-max-h))'])
  })

  it('pins fixed-position overlays to the small viewport', () => {
    // These are not in the top layer, so they can size themselves directly —
    // `height: 100svh` both covers and centres within the visible band.
    for (const [file, selector] of [
      ['modals.css', '.modal-backdrop'],
      ['charts.css', '.chart-overlay-backdrop'],
      ['hushallsbudget.css', '.chart-overlay {'],
    ] as const) {
      expect(declarations(read(file), selector, 'height'), `${file} ${selector}`).toEqual(['100svh'])
    }
  })

  it('never sizes a modal surface with vh', () => {
    const surfaces = [
      ['modals.css', '.modal {', 'max-height'],
      ['modals.css', '.save-prompt-box', 'max-height'],
      ['charts.css', '.chart-overlay-panel', 'max-height'],
      ['hushallsbudget.css', '.chart-overlay-inner', 'height'],
    ] as const

    for (const [file, selector, prop] of surfaces) {
      for (const value of declarations(read(file), selector, prop)) {
        expect(bareVh.test(value), `${file} ${selector} ${prop}: ${value}`).toBe(false)
      }
    }
  })
})
