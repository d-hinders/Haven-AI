import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider, useTheme } from '../ThemeContext'
import { THEME_STORAGE_KEY } from '@/lib/theme-bootstrap'

/**
 * The theme provider (#2927): default `system`, stored choices adopted after
 * mount, the attribute contract on <html>, live OS tracking while in
 * `system`, and storage that must never crash the app.
 */

type DarkListener = (event: { matches: boolean }) => void

let darkListeners: DarkListener[] = []
let darkMatches = false

function installMatchMedia() {
  darkListeners = []
  darkMatches = false
  vi.spyOn(window, 'matchMedia').mockImplementation(((query: string) => ({
    matches: query === '(prefers-color-scheme: dark)' ? darkMatches : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: (_type: string, listener: DarkListener) => {
      if (query === '(prefers-color-scheme: dark)') darkListeners.push(listener)
    },
    removeEventListener: (_type: string, listener: DarkListener) => {
      darkListeners = darkListeners.filter((l) => l !== listener)
    },
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia)
}

/** Flip the OS appearance and notify every live listener. */
function setOsDark(matches: boolean) {
  darkMatches = matches
  for (const listener of [...darkListeners]) listener({ matches })
}

function Probe() {
  const { preference, resolved, setPreference } = useTheme()
  return (
    <div>
      <span data-testid="preference">{preference}</span>
      <span data-testid="resolved">{resolved}</span>
      <button type="button" onClick={() => setPreference('light')}>
        choose light
      </button>
      <button type="button" onClick={() => setPreference('dark')}>
        choose dark
      </button>
      <button type="button" onClick={() => setPreference('system')}>
        choose system
      </button>
    </div>
  )
}

function renderTheme() {
  return render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  )
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    installMatchMedia()
    window.localStorage.clear()
    delete document.documentElement.dataset.theme
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete document.documentElement.dataset.theme
  })

  it('defaults to system with no stored choice, and stamps nothing on <html>', async () => {
    renderTheme()
    await waitFor(() => expect(screen.getByTestId('preference')).toHaveTextContent('system'))
    await waitFor(() => expect(screen.getByTestId('resolved')).toHaveTextContent('light'))
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
  })

  it('a stored dark choice resolves dark and stamps data-theme="dark" after mount', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    renderTheme()
    await waitFor(() => expect(screen.getByTestId('resolved')).toHaveTextContent('dark'))
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('a stored light choice stamps data-theme="light"', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    renderTheme()
    await waitFor(() => expect(screen.getByTestId('preference')).toHaveTextContent('light'))
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('a stored choice over a dark OS still resolves the explicit choice', async () => {
    darkMatches = true
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    renderTheme()
    await waitFor(() => expect(screen.getByTestId('resolved')).toHaveTextContent('light'))
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('each explicit choice writes the storage key and the attribute', async () => {
    renderTheme()
    await waitFor(() => expect(screen.getByTestId('preference')).toHaveTextContent('system'))

    await act(async () => {
      screen.getByRole('button', { name: 'choose dark' }).click()
    })
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'))
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')

    await act(async () => {
      screen.getByRole('button', { name: 'choose light' }).click()
    })
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'))
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')

    // Back to system: the attribute is REMOVED so the OS decides again.
    await act(async () => {
      screen.getByRole('button', { name: 'choose system' }).click()
    })
    await waitFor(() =>
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false),
    )
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
  })

  it('an OS change while in system flips resolved', async () => {
    renderTheme()
    await waitFor(() => expect(screen.getByTestId('resolved')).toHaveTextContent('light'))

    await act(async () => {
      setOsDark(true)
    })
    await waitFor(() => expect(screen.getByTestId('resolved')).toHaveTextContent('dark'))
    // system still stamps nothing — the media-query block owns rendering.
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)

    await act(async () => {
      setOsDark(false)
    })
    await waitFor(() => expect(screen.getByTestId('resolved')).toHaveTextContent('light'))
  })

  it('an OS change while in an explicit choice does NOT flip resolved', async () => {
    renderTheme()
    await act(async () => {
      screen.getByRole('button', { name: 'choose light' }).click()
    })
    await waitFor(() => expect(screen.getByTestId('preference')).toHaveTextContent('light'))

    await act(async () => {
      setOsDark(true)
    })
    expect(screen.getByTestId('resolved')).toHaveTextContent('light')
  })

  it('storage throwing does not crash — getItem on mount, setItem on save', async () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    renderTheme()
    await waitFor(() => expect(screen.getByTestId('preference')).toHaveTextContent('system'))
    await waitFor(() => expect(screen.getByTestId('resolved')).toHaveTextContent('light'))
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)

    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    await act(async () => {
      screen.getByRole('button', { name: 'choose dark' }).click()
    })
    // The in-memory choice still applies even though persisting failed.
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'))
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark')
  })

  it('a theme switch suppresses transitions for one frame and then releases', async () => {
    renderTheme()
    await waitFor(() => expect(screen.getByTestId('preference')).toHaveTextContent('system'))

    await act(async () => {
      screen.getByRole('button', { name: 'choose dark' }).click()
    })
    // First paint after the click is suppressed…
    expect(document.documentElement.hasAttribute('data-theme-switching')).toBe(true)
    // …and the attribute is dropped after the double animation frame.
    await waitFor(() =>
      expect(document.documentElement.hasAttribute('data-theme-switching')).toBe(false),
    )
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})
