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
import { THEME_STORAGE_KEY } from '@/lib/theme-bootstrap'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const DARK_MEDIA = '(prefers-color-scheme: dark)'

interface ThemeContextValue {
  /** What the user picked — `system` follows the device. */
  preference: ThemePreference
  /** The palette actually rendering right now. */
  resolved: ResolvedTheme
  setPreference: (next: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system'
}

function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
  return window.matchMedia(DARK_MEDIA).matches ? 'dark' : 'light'
}

/**
 * Stamp the choice on <html>. `system` REMOVES the attribute so the
 * `@media (prefers-color-scheme: dark)` token block decides; an explicit
 * choice sets it so it beats the OS in both directions. The bootstrap script
 * has usually stamped it already — this effect is the provider taking
 * ownership (and correcting it, e.g. a stale value from an older build).
 */
function stampDataTheme(preference: ThemePreference) {
  const root = document.documentElement
  if (preference === 'system') delete root.dataset.theme
  else root.dataset.theme = preference
}

/**
 * Kill every in-flight transition for exactly one animation frame while the
 * palette swaps (#2927), under the `[data-theme-switching]` rule in
 * globals.css. Without it, every `transition-colors` on the page cross-fades
 * the whole app through the change. One frame only: a persistent kill-switch
 * would freeze hover and press transitions too.
 */
function suppressTransitionsForOneFrame() {
  const root = document.documentElement
  root.setAttribute('data-theme-switching', '')
  if (typeof requestAnimationFrame === 'function') {
    // Two frames so the suppressed state is actually painted once before the
    // attribute drops — a single rAF can fire before the style recalc lands.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => root.removeAttribute('data-theme-switching'))
    })
  } else {
    root.removeAttribute('data-theme-switching')
  }
}

/**
 * Holds the active theme preference.
 *
 * SSR-safe by design, same shape as LocaleContext: the first render (server
 * and client) uses `system` so hydration matches; the mount effect upgrades
 * to the stored choice. The preference is device-local (localStorage,
 * `haven.theme`) because appearance is a per-device preference, not account
 * data. The inline bootstrap script in `app/layout.tsx` has already stamped
 * `data-theme` before first paint; this provider owns the attribute from
 * hydration on.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>('system')
  // Neutral until the mount effect reads the real state — matches what an
  // un-stamped light document shows during SSR/hydration.
  const [resolved, setResolved] = useState<ResolvedTheme>('light')

  // Adopt the persisted preference after mount (default `system`).
  useEffect(() => {
    let stored: ThemePreference | null = null
    try {
      const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
      if (isThemePreference(raw)) stored = raw
    } catch {
      // localStorage can throw (private mode, blocked storage) — fall through.
    }
    const next = stored ?? 'system'
    setPreferenceState(next)
    setResolved(next === 'system' ? systemTheme() : next)
    // Run once on mount; later changes go through setPreference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep <html data-theme> in sync with the preference.
  useEffect(() => {
    stampDataTheme(preference)
  }, [preference])

  // While in `system`, follow the OS — including live changes. (No initial
  // read here: every path that ENTERS `system` — the mount adoption and
  // setPreference — already sets `resolved` from the OS, and an initial read
  // in this effect would fire on mount with the stale pre-adoption
  // preference and clobber it.)
  useEffect(() => {
    if (preference !== 'system') return
    if (typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(DARK_MEDIA)
    const onChange = (event: MediaQueryListEvent) => {
      setResolved(event.matches ? 'dark' : 'light')
    }
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [preference])

  const setPreference = useCallback((next: ThemePreference) => {
    suppressTransitionsForOneFrame()
    setPreferenceState(next)
    setResolved(next === 'system' ? systemTheme() : next)
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // Persisting is best-effort; the in-memory choice still applies.
    }
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider')
  return ctx
}
