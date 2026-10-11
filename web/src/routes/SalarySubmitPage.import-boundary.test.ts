// Plan 132 D7 / AGENTS.md: the public `#/lon/<token>` page is rendered BEFORE
// AuthGate, the router or any store (App.tsx), precisely because it must
// never touch an authenticated client or persisted app state. This test
// proves that by statically walking SalarySubmitPage's own relative-import
// graph (a small regex-based resolver — no bundler needed, deterministic,
// and it fails loudly if the file moves or a new import is added) and
// asserting that `lib/supabase` and any Zustand store (`store/useStore`, or a
// `*-store.ts`) never appear in it, directly or transitively. As a second,
// independent guard it also greps every visited file's raw source for the
// Supabase and Zustand package imports themselves, in case a future edit
// reaches them without going through our own wrapper modules.
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ENTRY = resolve(__dirname, 'SalarySubmitPage.tsx')
const EXTENSIONS = ['', '.tsx', '.ts', '/index.tsx', '/index.ts']

// Matches `from '...'`, `from "..."` and bare `import '...'` (side-effect,
// e.g. CSS) — anything with a relative specifier. Bare package specifiers
// (react, zustand, @supabase/supabase-js…) are intentionally left as raw text
// and checked separately below, not resolved on disk.
const IMPORT_RE = /\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm

function resolveRelativeImport(fromFile: string, specifier: string): string | null {
  const base = join(dirname(fromFile), specifier)
  for (const ext of EXTENSIONS) {
    const candidate = normalize(base + ext)
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch { /* try the next extension */ }
  }
  return null
}

function walk(entry: string): { visited: Set<string>; sources: Map<string, string> } {
  const visited = new Set<string>()
  const sources = new Map<string, string>()
  const queue = [entry]
  while (queue.length) {
    const file = queue.pop()!
    if (visited.has(file)) continue
    visited.add(file)
    const source = readFileSync(file, 'utf8')
    sources.set(file, source)
    for (const m of source.matchAll(IMPORT_RE)) {
      const specifier = m[1] ?? m[2]
      if (!specifier || !specifier.startsWith('.')) continue // bare package import — see the separate check below
      const resolved = resolveRelativeImport(file, specifier)
      if (resolved && !visited.has(resolved)) queue.push(resolved)
    }
  }
  return { visited, sources }
}

describe('SalarySubmitPage import boundary (plan 132 D7)', () => {
  const { visited, sources } = walk(ENTRY)

  it('walked more than just the entry file (the resolver actually followed imports)', () => {
    expect(visited.size).toBeGreaterThan(1)
  })

  it('never reaches lib/supabase.ts', () => {
    const hit = [...visited].find((f) => f.endsWith(`${join('lib', 'supabase.ts')}`))
    expect(hit).toBeUndefined()
  })

  it('never reaches store/useStore or any *-store.ts', () => {
    const hit = [...visited].find((f) => f.endsWith(`${join('store', 'useStore.ts')}`) || /-store\.tsx?$/.test(f))
    expect(hit).toBeUndefined()
  })

  it('no visited file imports the Supabase or Zustand packages directly either', () => {
    for (const [file, source] of sources) {
      expect(source, `${file} imports @supabase/supabase-js`).not.toMatch(/['"]@supabase\/supabase-js['"]/)
      expect(source, `${file} imports zustand`).not.toMatch(/['"]zustand(\/|['"])/)
    }
  })
})
