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
import { BRAND_COLOURS } from '@/lib/brand-colours'

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
 * Keep the installed shell's status bar in step with the palette for an
 * EXPLICIT choice (#2928).
 *
 * The root layout ships `theme-color` as a media PAIR — each palette's `bg`
 * under its `(prefers-color-scheme: …)` query — and that pair is the whole
 * answer for `system`: two tags, the browser picks one, nothing to write at
 * runtime. What the pair cannot do is answer an explicit choice, because its
 * two media queries match the DEVICE and never the document: an app that
 * picked `dark` over a light OS still owns a light-matching tag, and Android
 * reads that tag as the status-bar colour — a white band above a dark app,
 * the one place #2927's dark palette could not reach.
 *
 * So the provider writes one override tag, appended last in `<head>`. Of
 * several `theme-color` tags the browser keeps the last whose `media`
 * matches, and a tag with no `media` matches always, so an appended tag with
 * none wins over both halves of the pair wherever it lands. `system` deletes
 * it again: the pair is the fallback, and a fallback that survives its
 * override needs no re-stamping — deletion from the end is exactly the
 * restore, which is why this function has no "re-add the pair" path and
 * would break if one were added (it would double the pair on every cycle).
 *
 * Idempotent by construction: the tag is keyed by `data-haven-theme-color`
 * and updated in place, so N activations of the toggle write the head at
 * most once per state, never once per click. A unit test pins both halves:
 * the content after an explicit `dark`, and the byte-identical pair after a
 * round through `system`.
 *
 * Inert in every gate the repository runs — headless Chromium has no status
 * bar and reads the tag as nothing. It is not inert on an Android phone in
 * standalone mode, which is where it is the whole feature; the handoff
 * names it as the item no local test can see.
 */
function stampThemeColorMeta(preference: ThemePreference, resolved: ResolvedTheme) {
  const existing = document.head.querySelector('meta[data-haven-theme-color]')
  if (preference === 'system') {
    existing?.remove()
    return
  }
  const content = resolved === 'dark' ? BRAND_COLOURS.darkBackground : BRAND_COLOURS.background
  if (existing) {
    // In place, so repeated calls do not accumulate tags in the head.
    existing.setAttribute('content', content)
    return
  }
  const meta = document.createElement('meta')
  meta.setAttribute('name', 'theme-color')
  meta.setAttribute('content', content)
  meta.setAttribute('data-haven-theme-color', '')
  document.head.append(meta)
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

  // Keep <html data-theme> in sync with the preference, and the installed
  // shell's status-bar tag in sync with the palette the preference resolved
  // to (#2928) — both are DOM stamps of the same decision, so they live in
  // one effect and cannot diverge between renders.
  useEffect(() => {
    stampDataTheme(preference)
    stampThemeColorMeta(preference, resolved)
  }, [preference, resolved])

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
