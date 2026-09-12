'use client'

import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { DEFAULT_LOCALE, messages, type Locale, type Messages } from '@/lib/i18n'

interface LocaleContextValue {
  locale: Locale
  /** Active message catalog for `locale`. */
  t: Messages
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

/**
 * Holds the active UI language.
 *
 * The Haven dashboard ships one language (#2926) — see `lib/i18n/index.ts`
 * for the scope of that claim — so there is nothing to resolve: every
 * render — server and client — is `DEFAULT_LOCALE`, which is also why there is
 * no hydration seam left to guard. The provider stays because the catalog and
 * `useT()` stay: a second locale changes what this holds, not who reads it.
 *
 * It keeps setting `<html lang>` rather than leaving that to the static
 * attribute in the root layout, so the value continues to follow the locale the
 * catalog is actually rendering when there is more than one again.
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const locale = DEFAULT_LOCALE

  // Keep <html lang> in sync for accessibility and correct hyphenation.
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const value = useMemo<LocaleContextValue>(() => ({ locale, t: messages[locale] }), [locale])

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error('useLocale must be used within a LocaleProvider')
  return ctx
}

/** Convenience hook for the active message catalog: `const t = useT()`. */
export function useT(): Messages {
  return useLocale().t
}
