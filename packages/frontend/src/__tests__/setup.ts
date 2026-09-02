/// <reference types="vitest/globals" />
import '@testing-library/jest-dom'
import type { RenderOptions } from '@testing-library/react'
import type { ReactNode } from 'react'
import os from 'node:os'
import { describeSlowTest, lastSlowTestReading } from './slow-test-diagnostic'

vi.mock('@testing-library/react', async () => {
  const actual = await vi.importActual<typeof import('@testing-library/react')>(
    '@testing-library/react',
  )
  const React = await vi.importActual<typeof import('react')>('react')
  const { ToastProvider } =
    await vi.importActual<typeof import('@/components/ui/Toast')>('@/components/ui/Toast')

  const render = (ui: ReactNode, options: RenderOptions = {}) => {
    const ExistingWrapper = options.wrapper

    function TestProviders({ children }: { children: ReactNode }) {
      const wrappedChildren = ExistingWrapper
        ? React.createElement(ExistingWrapper, null, children)
        : children

      return React.createElement(ToastProvider, null, wrappedChildren)
    }

    return actual.render(ui, {
      ...options,
      wrapper: TestProviders,
    })
  }

  return {
    ...actual,
    render,
  }
})

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key]
    }),
    clear: vi.fn(() => {
      store = {}
    }),
    get length() {
      return Object.keys(store).length
    },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
  }
})()

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
})

// Mock window.matchMedia — JSDOM doesn't ship it. Defaults to
// `prefers-reduced-motion: reduce` so motion hooks (useCountUp etc) skip
// animations and tests can assert against final values synchronously.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)',
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Mock ResizeObserver — JSDOM doesn't ship it, and `ui/Modal` uses one to keep
// its scroll continuation cue (#1893) correct when a dialog's content grows
// after mount. Without this stub every test that renders any Modal-based dialog
// throws `ResizeObserver is not defined`.
//
// It is deliberately inert: it records nothing and never invokes the callback,
// because JSDOM has no layout to observe in the first place. Anything asserting
// on the cue drives the geometry explicitly and fires a `scroll` event, or
// relies on the real MutationObserver JSDOM does implement.
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

beforeEach(() => {
  localStorageMock.clear()
  vi.clearAllMocks()
})

// #2319: name the machine when a test is slow or times out. `afterEach` runs
// after a timed-out test too (the runner calls the hook after `failTask`), so
// the diagnostic reaches the log next to the bare `Test timed out` line it
// explains. Tests within a file run sequentially, so one module-level clock
// per worker is enough. The message itself is a pure function, unit-tested in
// `suite-timing-posture.test.ts`; this hook only supplies the live reading.
// Cost per test: two `performance.now()` reads, one `os.loadavg()` and one
// `os.availableParallelism()` call — measured at ~0.02 ms together, against
// tests that start at ~40 ms.
let testStartedAt = 0

beforeEach(() => {
  testStartedAt = performance.now()
})

afterEach((ctx) => {
  const errors = ctx.task.result?.errors ?? []
  const reading = {
    name: `${ctx.task.file?.name ?? '?'} > ${ctx.task.name}`,
    durationMs: performance.now() - testStartedAt,
    timeoutMs: ctx.task.timeout ?? 5000,
    timedOut: errors.some((e) => /timed out/i.test(e.message ?? '')),
    loadAverage1m: os.loadavg()[0],
    cores: os.availableParallelism(),
  }
  lastSlowTestReading.current = reading
  const message = describeSlowTest(reading)
  if (message) console.warn(message)
})
