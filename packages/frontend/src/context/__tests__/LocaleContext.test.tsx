import { render, screen, fireEvent, waitFor, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { LocaleProvider, useLocale, useT } from '@/context/LocaleContext'
import { LOCALE_STORAGE_KEY } from '@/lib/i18n'
import type { ReactNode } from 'react'

function Probe() {
  const { locale, setLocale } = useLocale()
  const t = useT()
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="title">{t.settings.title}</span>
      <button onClick={() => setLocale('sv')}>to-sv</button>
    </div>
  )
}

const wrapper = ({ children }: { children: ReactNode }) => <LocaleProvider>{children}</LocaleProvider>

describe('LocaleContext', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.lang = ''
  })

  it('defaults to English and exposes the matching catalog', async () => {
    render(
      <LocaleProvider>
        <Probe />
      </LocaleProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('locale')).toHaveTextContent('en'))
    expect(screen.getByTestId('title')).toHaveTextContent('Settings')
  })

  it('switches locale, swaps the catalog, persists, and updates <html lang>', async () => {
    render(
      <LocaleProvider>
        <Probe />
      </LocaleProvider>,
    )

    fireEvent.click(screen.getByText('to-sv'))

    await waitFor(() => expect(screen.getByTestId('title')).toHaveTextContent('Inställningar'))
    expect(screen.getByTestId('locale')).toHaveTextContent('sv')
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('sv')
    expect(document.documentElement.lang).toBe('sv')
  })

  it('hydrates from a persisted choice', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'sv')
    const { result } = renderHook(() => useLocale(), { wrapper })
    await waitFor(() => expect(result.current.locale).toBe('sv'))
    expect(result.current.t.settings.title).toBe('Inställningar')
  })

  it('throws when used outside a provider', () => {
    // Silence the expected React error boundary noise for this assertion.
    expect(() => renderHook(() => useLocale())).toThrow(/within a LocaleProvider/)
  })
})
