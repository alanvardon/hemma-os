// Capture Vindsplanen golden fixtures by running the v41 artifact itself.
//
//   cd web
//   node tools/vindsplanen-gold/capture.mjs [path/to/vindsplanen-v41.html]
//
// Makes the renamed copy (make-copy.sh), serves it with `python3 -m
// http.server 8790`, loads it once per fixture in headless Chromium with the
// fixture plan pre-stored (v41 reads its attic at module load) and every
// one-time init flag pre-set (so no init block rewrites the plan), calls the
// injected `__gold` hook and writes src/lib/vindsplanen/__fixtures__/*.json.
// three.js comes from cdn.jsdelivr.net, so this needs network access.

import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { FIXTURES, SANITIZE_CASES } from './fixtures.mjs'

const DIR = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(DIR, '../../src/lib/vindsplanen/__fixtures__')
const PORT = 8790
const FLAGS = ['owner-design-1', 'storage-room-1', 'storage-corner-2', 'bedroom-board-1', 'measure-1', 'closet-1', 'oldstairs-count-2', 'floor-fill-1']

execFileSync('sh', [resolve(DIR, 'make-copy.sh'), ...process.argv.slice(2)], { stdio: 'inherit' })
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: resolve(DIR, 'out'), stdio: 'ignore' })
const url = `http://127.0.0.1:${PORT}/vindsplanen-gold.html`

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('http.server did not start')
}

async function load(browser, stored) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await context.addInitScript(
    ([flags, plan]) => {
      for (const f of flags) localStorage.setItem('vgold-' + f, '1')
      if (plan) localStorage.setItem('vgold-v1', plan)
    },
    [FLAGS, stored ? JSON.stringify(stored) : null],
  )
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(url)
  await page.waitForFunction(() => window.__goldReady === true, null, { timeout: 60_000 }).catch((e) => {
    throw new Error(`v41 copy did not boot: ${errors.join(' | ') || e}`)
  })
  return { context, page, errors }
}

try {
  await waitForServer()
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  for (const fx of FIXTURES) {
    const { context, page, errors } = await load(browser, fx.input)
    const data = await page.evaluate(([input, opts]) => window.__gold(input, opts), [fx.input, fx.opts])
    if (errors.length) throw new Error(`${fx.name}: ${errors.join(' | ')}`)
    writeFileSync(resolve(OUT, `${fx.name}.json`), JSON.stringify(data) + '\n')
    console.log(`${fx.name}: ${Object.keys(data.warnings).length} items, ${Object.values(data.warnings).flat().length} warnings`)
    await context.close()
  }
  {
    const { context, page } = await load(browser, null)
    const out = await page.evaluate((list) => window.__goldSanitize(list), SANITIZE_CASES)
    writeFileSync(resolve(OUT, 'sanitize.json'), JSON.stringify({ cases: SANITIZE_CASES, out }) + '\n')
    console.log(`sanitize: ${out.length} cases`)
    await context.close()
  }
  await browser.close()
} finally {
  server.kill()
}
