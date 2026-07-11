// Registers @testing-library/jest-dom's custom matchers (toBeInTheDocument,
// toHaveValue, etc.) on Vitest's `expect`. Loaded via `test.setupFiles` in
// vite.config.ts so every test file — node or jsdom — can use them; the
// matchers only actually assert against a DOM in the jsdom-environment files.
import '@testing-library/jest-dom/vitest'

// jsdom ships no matchMedia; several components read it at module load (e.g.
// Home.tsx's fineHover, ThemeToggle). Stub a stable "no match" implementation so
// the jsdom-environment tests can import them. Guarded on `window` so this is a
// no-op in the node-environment test files that share this setup.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })
}

// jsdom (as of v29) doesn't implement <dialog>'s showModal()/close(); DialogShell
// drives both off the `open` prop, so stub them to toggle the `open` attribute
// (enough for the DOM to reflect open/closed) and fire the native `close` event.
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
    this.dispatchEvent(new Event('close'))
  }
}
