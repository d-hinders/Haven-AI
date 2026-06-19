'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  isLocale,
  localeFromLanguageTag,
  messages,
  type Locale,
  type Messages,
} from '@/lib/i18n'

interface LocaleContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  /** Active message catalog for `locale`. */
  t: Messages
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

/**
 * Holds the active UI language.
 *
 * SSR-safe by design: the first render (server and client) uses
 * DEFAULT_LOCALE so hydration matches; an effect then upgrades to the stored
 * choice, or the browser language on first visit. The choice is device-local
 * (localStorage) because language is a per-device preference, not account data.
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE)

  // Resolve the persisted / browser-preferred locale after mount.
  useEffect(() => {
    let resolved: Locale | null = null
    try {
      const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
      if (isLocale(stored)) resolved = stored
    } catch {
      // localStorage can throw (private mode, blocked storage) — fall through.
    }
    if (!resolved) resolved = localeFromLanguageTag(navigator.language)
    if (resolved && resolved !== locale) setLocaleState(resolved)
    // Run once on mount; later changes go through setLocale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep <html lang> in sync for accessibility and correct hyphenation.
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next)
    } catch {
      // Persisting is best-effort; the in-memory choice still applies.
    }
  }, [])

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, setLocale, t: messages[locale] }),
    [locale, setLocale],
  )

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
