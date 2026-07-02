// Tags <html> with the navigation direction so transitions.css can scope the
// shared-element "whoosh" — forward the page grows OUT of the card's slot, back
// it shrinks INTO it, and the two directions want different timing on the same
// pseudo-elements. React Router drives document.startViewTransition() internally;
// we patch it ONCE so we can clear the tag exactly when the real transition
// finishes, instead of guessing with a timer.

let clearTimer: ReturnType<typeof setTimeout> | undefined
let patched = false
let vtActive = false
const settledListeners = new Set<() => void>()

function clearVtTag(): void {
  if (typeof document === 'undefined') return
  clearTimeout(clearTimer)
  delete document.documentElement.dataset.vtDir
  delete document.documentElement.dataset.vtTool
  if (vtActive) {
    vtActive = false
    settledListeners.forEach((fn) => fn())
  }
}

// Patch startViewTransition once so the direction tag is cleared the moment the
// actual transition's animations end — NOT on a guessed timer. The previous
// implementation read `--vt-dur` and added a margin, but production CSS
// minification rewrites `740ms` → `.74s`, so `parseFloat('.74s')` saw 0.74
// (≈0.74ms) and cleared the tag ~700ms into a >2s transition. That unscoped the
// per-direction keyframes mid-zoom and the page "popped" — but only on the
// minified live build, never on local dev (`740ms`). Tying the clear to the VT's
// own `.finished` is immune to CSS units, VT setup time, and device speed.
function ensurePatched(): boolean {
  if (patched) return true
  if (typeof document === 'undefined' || typeof document.startViewTransition !== 'function') return false
  patched = true
  const orig = document.startViewTransition.bind(document)
  document.startViewTransition = ((...args: Parameters<typeof orig>) => {
    const vt = orig(...args)
    // Clear one frame past `.finished`, when the ::view-transition pseudo-elements
    // are already gone, so unscoping the keyframes can never cause a flash.
    vt.finished.finally(() => requestAnimationFrame(clearVtTag))
    return vt
  }) as typeof document.startViewTransition
  return true
}

/** Call synchronously in the click handler, before navigation begins. */
export function markVtTransition(toolPath: string, dir: 'forward' | 'back'): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.vtDir = dir
  document.documentElement.dataset.vtTool = toolPath
  vtActive = true
  ensurePatched()
  // Fallback for browsers without View Transitions / reduced-motion paths where
  // no VT (and thus no `.finished`) ever runs. Animations are already disabled in
  // those paths, so the exact delay is non-critical — just generous so it never
  // races a real transition that the patch will clear first anyway.
  clearTimeout(clearTimer)
  clearTimer = setTimeout(clearVtTag, 2500)
}

/** Which tool path is currently whooshing, or null if none. */
export function activeVtTool(): string | null {
  return typeof document === 'undefined' ? null : (document.documentElement.dataset.vtTool ?? null)
}

/** True while a whoosh is in flight — mirrors the same lifecycle as the
 *  `data-vt-dir` tag (cleared one frame past the VT's `.finished`, or by the
 *  2500ms fallback on paths with no real VT). Entrance figures (AnimatedNumber)
 *  read this to hold off rolling until the transition has visually settled. */
export function isVtActive(): boolean {
  return vtActive
}

/** Subscribe to be notified once the in-flight whoosh settles. Fires at most
 *  once per subscription; does nothing if no transition is active — callers
 *  should check `isVtActive()` first and only subscribe when it's true.
 *  Returns an unsubscribe function. */
export function subscribeVtSettled(fn: () => void): () => void {
  settledListeners.add(fn)
  return () => settledListeners.delete(fn)
}

/** @deprecated Use markVtTransition instead. */
export function markVtDirection(dir: 'forward' | 'back'): void {
  markVtTransition('', dir)
}
