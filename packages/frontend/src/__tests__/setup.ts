/// <reference types="vitest/globals" />
import '@testing-library/jest-dom'
import type { RenderOptions } from '@testing-library/react'
import type { ReactNode } from 'react'

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

beforeEach(() => {
  localStorageMock.clear()
  vi.clearAllMocks()
})
