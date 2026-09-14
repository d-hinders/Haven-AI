import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider, useTheme } from '../ThemeContext'
import { THEME_STORAGE_KEY } from '@/lib/theme-bootstrap'
import { BRAND_COLOURS } from '@/lib/brand-colours'

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
    // The provider's status-bar tag (#2928) is a document.head side effect
    // with no unmount cleanup — in the real app the provider never unmounts.
    // Tests DO unmount, so an orphan tag would leak into the next case and
    // make "system means no override" read as its opposite. Removing it here
    // is the test seam, not app behaviour.
    document.head.querySelector('meta[data-haven-theme-color]')?.remove()
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

  /**
   * The installed shell's status-bar tag (#2928). The root layout ships the
   * `theme-color` media PAIR (asserted over the exported viewport object in
   * `lib/__tests__/installed-app.test.ts` — jsdom renders no `<head>` from a
   * Next `viewport` export, so "in the document head" is proven where the
   * pair is built). What lives HERE is the provider half: for an EXPLICIT
   * choice the pair is wrong — its media queries read the device, never the
   * document — so the provider stamps one override tag with the resolved
   * palette's `bg`, and `system` removes it again so the pair answers.
   */
  const overrideMeta = () =>
    document.head.querySelector('meta[data-haven-theme-color]') as HTMLMetaElement | null

  it('stamps the dark bg on the theme-color override for an explicit dark choice', async () => {
    renderTheme()
    await waitFor(() => expect(screen.getByTestId('preference')).toHaveTextContent('system'))
    // system: no override exists — the pair alone decides, and nothing may
    // shadow it before the user has chosen.
    expect(overrideMeta()).toBeNull()

    await act(async () => {
      screen.getByRole('button', { name: 'choose dark' }).click()
    })
    await waitFor(() => expect(overrideMeta()?.content).toBe(BRAND_COLOURS.darkBackground))
    expect(document.head.contains(overrideMeta())).toBe(true)
    expect(overrideMeta()?.getAttribute('name')).toBe('theme-color')

    // Explicit light flips the same tag in place — one tag per state, not a
    // pile of them.
    await act(async () => {
      screen.getByRole('button', { name: 'choose light' }).click()
    })
    await waitFor(() => expect(overrideMeta()?.content).toBe(BRAND_COLOURS.background))
    expect(document.head.querySelectorAll('meta[data-haven-theme-color]')).toHaveLength(1)

    // Back to system: the override is GONE and the pair is the answer again.
    // Deletion from the end is the restore, so the round trip leaves the head
    // exactly as it started — this is the idempotence claim.
    await act(async () => {
      screen.getByRole('button', { name: 'choose system' }).click()
    })
    await waitFor(() => expect(overrideMeta()).toBeNull())
    expect(document.head.querySelectorAll('meta[data-haven-theme-color]')).toHaveLength(0)
  })

  it('re-stamping is idempotent: N activations of the same preference write the head once', async () => {
    renderTheme()
    await waitFor(() => expect(screen.getByTestId('preference')).toHaveTextContent('system'))

    const chooseDark = () => screen.getByRole('button', { name: 'choose dark' }).click()
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        chooseDark()
      })
    }
    await waitFor(() => expect(overrideMeta()?.content).toBe(BRAND_COLOURS.darkBackground))
    expect(document.head.querySelectorAll('meta[data-haven-theme-color]')).toHaveLength(1)

    // And the tag survives a system excursion without duplicating:
    // dark → system → dark lands one override, not three.
    await act(async () => {
      screen.getByRole('button', { name: 'choose system' }).click()
    })
    await waitFor(() => expect(overrideMeta()).toBeNull())
    await act(async () => {
      chooseDark()
    })
    await waitFor(() => expect(overrideMeta()?.content).toBe(BRAND_COLOURS.darkBackground))
    expect(document.head.querySelectorAll('meta[data-haven-theme-color]')).toHaveLength(1)
  })
})
