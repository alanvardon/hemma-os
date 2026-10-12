import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

// Lint for the branded Swedish Supabase Auth email templates (plan 135).
// Plan 136 deliberately changes the `{{ .Token }}` assertion.

const dir = new URL('../../../supabase/templates/', import.meta.url)
const configToml = readFileSync(new URL('../../../supabase/config.toml', import.meta.url), 'utf8')

const COMMON = ['Token', 'TokenHash', 'SiteURL', 'Email', 'Data']
const WITH_URL = [...COMMON, 'ConfirmationURL', 'RedirectTo']

const TEMPLATES: Record<string, { allowed: string[]; url: boolean }> = {
  magic_link: { allowed: WITH_URL, url: true },
  confirmation: { allowed: WITH_URL, url: true },
  invite: { allowed: WITH_URL, url: true },
  email_change: { allowed: [...WITH_URL, 'NewEmail'], url: true },
  recovery: { allowed: WITH_URL, url: true },
  reauthentication: { allowed: COMMON, url: false },
}

function variables(html: string): string[] {
  return [...html.matchAll(/\{\{\s*\.(\w+)\s*\}\}/g)].map((m) => m[1])
}

describe.each(Object.entries(TEMPLATES))('auth email template %s', (key, spec) => {
  const file = new URL(`${key}.html`, dir)
  const html = existsSync(file) ? readFileSync(file, 'utf8') : ''

  it('exists and is a complete Swedish document', () => {
    expect(existsSync(file)).toBe(true)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('lang="sv"')
    expect(html).toContain('<meta charset="utf-8">')
    expect(html.trimEnd().endsWith('</html>')).toBe(true)
  })

  it('has no unbalanced template delimiters', () => {
    const stripped = html.replace(/\{\{[^{}]*\}\}/g, '')
    expect(stripped).not.toMatch(/\{\{|\}\}/)
  })

  it('uses only variables its template type supports', () => {
    for (const v of variables(html)) expect(spec.allowed, `{{ .${v} }}`).toContain(v)
    const vars = variables(html)
    expect(vars.includes('NewEmail')).toBe(key === 'email_change')
    expect(vars.includes('Token')).toBe(key === 'reauthentication')
  })

  it(spec.url ? 'contains the confirmation URL exactly twice (button + fallback)' : 'shows the token and no URL variable', () => {
    const vars = variables(html)
    if (spec.url) {
      expect(vars.filter((v) => v === 'ConfirmationURL')).toHaveLength(2)
    } else {
      expect(vars).toContain('Token')
      expect(vars).not.toContain('ConfirmationURL')
      expect(vars).not.toContain('RedirectTo')
    }
  })

  it('loads no remote resources', () => {
    expect(html).not.toMatch(/\bsrc\s*=/i)
    expect(html).not.toMatch(/<img/i)
    expect(html).not.toMatch(/<link/i)
    expect(html).not.toMatch(/url\(/i)
    expect(html.replace(/\{\{[^{}]*\}\}/g, '')).not.toMatch(/http/i)
  })

  it('states why it arrived and that replies are not read', () => {
    expect(html).toContain('Du får det här mejlet för att')
    expect(html).toContain('Var det inte du kan du ignorera det')
    expect(html).toContain('Det går inte att svara på det här mejlet.')
  })

  it('is wired into config.toml with a matching content_path', () => {
    const block = configToml.match(new RegExp(`^\\[auth\\.email\\.template\\.${key}\\]\\n((?:(?!\\[).+\\n?)*)`, 'm'))
    expect(block, `[auth.email.template.${key}] block`).not.toBeNull()
    expect(block![1]).toContain(`content_path = "./supabase/templates/${key}.html"`)
    expect(block![1]).toMatch(/^subject = ".+"$/m)
  })
})
