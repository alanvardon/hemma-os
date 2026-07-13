/// <reference types="node" />

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const scannerPath = resolve(process.cwd(), 'scripts/verify-build-security.mjs')
const temporaryBuilds: string[] = []

function createBuild(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), 'hemma-build-security-'))
  temporaryBuilds.push(directory)
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(directory, name), body, 'utf8')
  }
  return directory
}

function runScanner(directory: string) {
  return spawnSync(process.execPath, [scannerPath, directory], {
    encoding: 'utf8',
  })
}

afterEach(() => {
  for (const directory of temporaryBuilds.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('emitted-build security scanner', () => {
  it('accepts a clean build containing a fictional publishable key', () => {
    const directory = createBuild({
      'index.html': '<script src="app.js"></script>',
      'app.js': 'const key = "sb_publishable_fictional_plan96"',
    })

    const result = runScanner(directory)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('PASS: scanned 2 emitted text assets')
    expect(result.stderr).toBe('')
  })

  it('rejects a fictional Supabase secret without echoing it', () => {
    const secret = 'sb_secret_fictional_plan96_never_echo'
    const directory = createBuild({
      'index.html': `<script>const key = "${secret}"</script>`,
    })

    const result = runScanner(directory)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('FAIL: Supabase secret-key prefix was emitted')
    expect(result.stderr).not.toContain(secret)
    expect(result.stdout).not.toContain(secret)
  })

  it('rejects a synthetically generated service-role JWT', () => {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const token = [
      encode({ alg: 'HS256', typ: 'JWT' }),
      encode({ role: 'service_role', fixture: 'plan96' }),
      'fictional-signature',
    ].join('.')
    const directory = createBuild({
      'index.html': '<script src="app.js"></script>',
      'app.js': `const token = "${token}"`,
    })

    const result = runScanner(directory)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('FAIL: a JWT with the service_role claim was emitted')
    expect(result.stderr).not.toContain(token)
    expect(result.stdout).not.toContain(token)
  })

  it('rejects emitted source-map files', () => {
    const directory = createBuild({
      'index.html': '<script src="app.js"></script>',
      'app.js': 'console.log("fixture")',
      'app.js.map': '{}',
    })

    const result = runScanner(directory)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('FAIL: a source-map file was emitted')
  })

  it('rejects source-map references', () => {
    const directory = createBuild({
      'index.html': '<script src="app.js"></script>',
      'app.js': 'console.log("fixture")\n//# sourceMappingURL=app.js.map',
    })

    const result = runScanner(directory)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('FAIL: a source-map reference was emitted')
  })

  it('rejects a build without index.html', () => {
    const directory = createBuild({
      'app.js': 'console.log("fixture")',
    })

    const result = runScanner(directory)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('FAIL: the build has no index.html')
  })
})
