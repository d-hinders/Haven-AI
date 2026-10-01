/// <reference types="vitest/globals" />
import '@testing-library/jest-dom'

// The moved suites render the primitives they moved with. The frontend's
// setup file wraps renders in a ToastProvider and stubs browser APIs; of
// those, the moved suites exercise only the DOM matchers above and the two
// stubs below (Tooltip uses ResizeObserver transitively through Modal? no —
// through its own layout reads; matchMedia gates nothing in these suites, but
// jsdom lacks both, and a suite that moved here must not need the frontend's
// app providers to run).
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: Object.assign(
    (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    }),
    { _mocked: true },
  ),
})

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, 'ResizeObserver', {
  writable: true,
  configurable: true,
  value: ResizeObserverStub,
})
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
