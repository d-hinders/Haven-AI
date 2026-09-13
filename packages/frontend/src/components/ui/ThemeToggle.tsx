'use client'

/**
 * The quick theme toggle (#2928, epic #2925 slice 2).
 *
 * One button, three states, one gesture: it cycles light → dark → system,
 * the same three choices the Settings → Appearance row offers, reduced to a
 * single control for the chrome. The order is the issue's verbatim one
 * ("cycles light → dark → system") and it is not a preference — a unit test
 * pins the whole ring, and reordering the table without updating the tests
 * reddens them.
 *
 * ## The icon is the state; the label is the transition
 *
 * `Sun` when the active palette is light, `Moon` when dark, `Monitor` when
 * following the OS. The icon answers "what am I"; the accessible name answers
 * the question the gesture actually asks — "what will I become" — in the form
 * the issue specified: `Theme: dark. Switch to system`. A control whose name
 * is only the current state is a toggle the user cannot predict; the value
 * that changes is the one worth announcing.
 *
 * ## The animation honours the preference
 *
 * The icon swap cross-fades under `prefers-reduced-motion: no-preference` and
 * snaps under `reduce`, following the `.animate-check-pop` /
 * `.animate-pending-pulse` idiom: the keyframes live in `globals.css` behind
 * the media query, and the component does not even opt in to the class when
 * the OS says reduce (belt and braces). The preference is read on mount and
 * tracked through the MediaQueryList's `change` event, the same way
 * `ThemeContext` tracks `prefers-color-scheme`, so a live flip in the OS
 * panel updates the swap without a reload.
 *
 * ## Two renderings, one state
 *
 * `variant="icon"` is the button in the TopBar's right cluster;
 * `variant="row"` is the row in the tab bar's More sheet (Sidebar's drawer),
 * which carries the visible label — and the visible label must be contained
 * in the accessible name (WCAG 2.5.3, Label in Name): "Theme" is the prefix
 * of "Theme: …". Which variant renders where is decided by the caller's
 * breakpoints (the icon desktop, the row the mobile), so the primitive itself
 * takes no position — the same partition `Sidebar` applies to the More button
 * (`lg:hidden`) and `TopBar` applies here to its cluster (`hidden … lg:`) is
 * what keeps exactly one of the two on screen at any viewport.
 */

import { useCallback, useEffect, useState } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme, type ThemePreference } from '@/context/ThemeContext'
import { useT } from '@/context/LocaleContext'
import { Icon } from '@/components/ui/Icon'
import { Tooltip } from '@/components/ui/Tooltip'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * The ring the gesture walks, in the direction the issue specified. A
 * preference's successor is its successor in the table, not on the number
 * line: cycling wraps. Both `NEXT()` and the accessible name read this table,
 * so it is the single place the order exists.
 */
const NEXT: Record<ThemePreference, ThemePreference> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
}

export type ThemeToggleVariant = 'icon' | 'row'

export interface ThemeToggleProps {
  /**
   * `icon` for the top bar's right cluster, `row` for the More sheet. The
   * row renders the visible label; the icon button leaves it to the
   * accessible name and the tooltip.
   */
  variant?: ThemeToggleVariant
  /** Extra classes for the call site's cluster (placement, not identity). */
  className?: string
}

/** The icon is the state. The mapping is the issue's, verbatim. */
const ICON: Record<ThemePreference, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
}

export function ThemeToggle({ variant = 'icon', className = '' }: ThemeToggleProps) {
  const { preference, setPreference } = useTheme()
  const t = useT()

  const [reducedMotion, setReducedMotion] = useState(false)

  // Read the motion preference on mount and follow it live, the way
  // ThemeContext follows the colour-scheme one. The media list may answer
  // nothing if nothing is added to it, so a component that mounted while the
  // OS said "no preference" and later heard "reduce" must not keep animating.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(REDUCED_MOTION_QUERY)
    setReducedMotion(mql.matches)
    const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  const name = t.settings.theme[preference]
  const nextName = t.settings.theme[NEXT[preference]]
  // The verbatim string the issue specifies: "Theme: dark. Switch to system".
  // Lower-case values, because the sentence reads as the value, not as the
  // proper name of the button.
  const message = t.settings.themeToggle.ariaLabel(name.toLowerCase(), nextName.toLowerCase())

  const cycle = useCallback(() => {
    setPreference(NEXT[preference])
  }, [preference, setPreference])

  // `key` remounts the glyph on each step of the ring, which is what replays
  // the CSS animation; under `reduce` the class is not added at all and the
  // swap is a plain re-render of the sibling icon.
  const glyph = (
    <span
      key={preference}
      className={`inline-flex h-4 w-4 items-center justify-center${
        reducedMotion ? '' : ' animate-theme-swap'
      }`}
    >
      <Icon icon={ICON[preference]} className="h-4 w-4" />
    </span>
  )

  if (variant === 'row') {
    // The More sheet's row. Same classes as the drawer's own menu rows, so
    // the sheet renders one table, not two. The yield that keeps interactive
    // rows clear of the fixed More/Close toggle is carried by the footer this
    // row lives in (Sidebar), and it needs no partner here.
    return (
      <button
        type="button"
        onClick={cycle}
        aria-label={message}
        className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[13px] text-[var(--v2-ink)] transition-colors hover:bg-[var(--v2-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/80 ${className}`}
      >
        {glyph}
        <span className="min-w-0 flex-1 truncate">{t.settings.themeToggle.label}</span>
        <span aria-hidden="true" className="text-[var(--v2-ink-3)]">
          {name}
        </span>
      </button>
    )
  }

  // The icon button: the accessible name carries the whole message, so the
  // tooltip repeats it on hover and focus rather than holding any part of it
  // alone — a tooltip is an elaboration, not a home (see the Tooltip
  // primitive's own docstring).
  return (
    <Tooltip label={message}>
      <button
        type="button"
        onClick={cycle}
        aria-label={message}
        className={`relative flex h-7 w-7 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/80 ${className}`}
      >
        {glyph}
      </button>
    </Tooltip>
  )
}

export default ThemeToggle
