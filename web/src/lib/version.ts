// version.ts — build-stamp comparison for the update notice (plan 100).
// Pure logic; the fetch lives here too but stays trivial and injectable.

export interface DeployedVersion {
  sha: string
  builtAt: string | null
}

// The SHA baked into THIS running bundle by the deploy workflow; '' for dev
// and local builds, which disables the checker entirely.
export const BUILD_SHA: string = import.meta.env.VITE_BUILD_SHA || ''

// Defensive parse of bk-assets/version.json — anything malformed is "no
// information" (null), never an update signal.
export function parseVersionJson(data: unknown): DeployedVersion | null {
  if (!data || typeof data !== 'object') return null
  const sha = (data as { sha?: unknown }).sha
  if (typeof sha !== 'string' || !sha) return null
  const builtAt = (data as { builtAt?: unknown }).builtAt
  return { sha, builtAt: typeof builtAt === 'string' ? builtAt : null }
}

export function isUpdateAvailable(currentSha: string, deployed: DeployedVersion | null): boolean {
  return !!currentSha && !!deployed && deployed.sha !== currentSha
}

// no-store so the browser cache can never answer; the CDN may still be up to
// 10 min behind a deploy, which just delays the notice by that much.
export async function fetchDeployedVersion(): Promise<DeployedVersion | null> {
  try {
    const res = await fetch('./bk-assets/version.json', { cache: 'no-store' })
    if (!res.ok) return null
    return parseVersionJson(await res.json())
  } catch {
    return null
  }
}

// Isolated so component tests can assert the reload without fighting jsdom's
// unimplemented navigation.
export function reloadApp(): void {
  window.location.reload()
}
