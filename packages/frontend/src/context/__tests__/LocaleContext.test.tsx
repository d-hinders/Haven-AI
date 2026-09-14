import { render, screen, waitFor, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider, useLocale, useT } from '@/context/LocaleContext'
import type { ReactNode } from 'react'

function Probe() {
  const { locale } = useLocale()
  const t = useT()
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="title">{t.settings.title}</span>
    </div>
  )
}

const wrapper = ({ children }: { children: ReactNode }) => <LocaleProvider>{children}</LocaleProvider>

/**
 * Single-locale contract (#2926). Swedish, the Settings toggle and
 * browser-language detection were removed; what these pin is that the
 * provider still holds a locale and a catalog, still sets `<html lang>`, and
 * reads NOTHING from the device — no storage key, no `navigator.language`.
 */
describe('LocaleContext', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.lang = ''
  })

  // In afterEach, not at the end of the test body: an assertion that throws
  // above the restore would otherwise leak the navigator.language getter spy
  // into the rest of the file.
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('serves English and the matching catalog', async () => {
    render(
      <LocaleProvider>
        <Probe />
      </LocaleProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('en'))
    expect(screen.getByTestId('title')).toHaveTextContent('Settings')
  })

  it('sets <html lang> to the active locale', async () => {
    render(
      <LocaleProvider>
        <Probe />
      </LocaleProvider>,
    )
    await waitFor(() => expect(document.documentElement.lang).toBe('en'))
  })

  it('reads no device preference — not storage, not navigator.language', async () => {
    const getItem = vi.spyOn(window.localStorage, 'getItem')
    // A leftover `haven.locale` from before #2926 is inert: nothing reads it,
    // so no migration ships and no device is asked to forget it.
    window.localStorage.setItem('haven.locale', 'sv')
    getItem.mockClear()
    const languageReads = vi.fn()
    vi.spyOn(navigator, 'language', 'get').mockImplementation(() => {
      languageReads()
      return 'sv-SE'
    })

    const { result } = renderHook(() => useLocale(), { wrapper })

    await waitFor(() => expect(result.current.locale).toBe('en'))
    expect(result.current.t.settings.title).toBe('Settings')
    expect(getItem).not.toHaveBeenCalled()
    expect(languageReads).not.toHaveBeenCalled()
  })

  it('throws when used outside a provider', () => {
    // Silence the expected React error boundary noise for this assertion.
    expect(() => renderHook(() => useLocale())).toThrow(/within a LocaleProvider/)
  })
})
