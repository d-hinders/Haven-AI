'use client'

/**
 * The quick theme toggle (#2928, epic #2925 slice 2; two-state flip per
 * #2953).
 *
 * One button, two states, one gesture: it flips light → dark and back. The
 * icon shows the palette on screen — `Sun` in light, `Moon` in dark — and
 * each click flips it. The full three-way choice (light / dark / system)
 * stays in Settings → Appearance, on its `SegmentedControl`; the quick
 * toggle is the shortcut, not the full control, so it offers no `system`
 * step and no `Monitor` glyph.
 *
 * ## The icon is the state; the label is the transition
 *
 * The accessible name answers the question the gesture actually asks —
 * "what will I become" — in the form `Theme: dark. Switch to light`. A
 * control whose name is only the current state is a toggle the user cannot
 * predict; the value that changes is the one worth announcing.
 *
 * ## A `system` preference resolves, then flips
 *
 * If the stored preference is `system` (the default) when the user clicks,
 * the toggle does not cycle into a state the shortcut no longer has: it
 * reads the palette actually rendering (`resolved`), flips it, and persists
 * the explicit `light` or `dark`. After one click the preference is always
 * explicit — which is also what keeps the flip a strict two-state ring
 * rather than a hidden third step.
 *
 * ## No tooltip
 *
 * The icon variant renders the button directly, with no `<Tooltip>` wrapper
 * (#2953): the control is a plain clickable icon, no hover or focus popup.
 * The icon alone is the affordance and the accessible name carries the
 * whole message for screen readers; the previous tooltip rendered above the
 * TopBar icon and landed off the top edge of the viewport, and the product
 * call is that no label bubble is wanted here at all.
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
import { Moon, Sun } from 'lucide-react'
import { useTheme } from '@/context/ThemeContext'
import { useT } from '@/context/LocaleContext'
import { Icon } from '@/components/ui/Icon'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export type ThemeToggleVariant = 'icon' | 'row'

export interface ThemeToggleProps {
  /**
   * `icon` for the top bar's right cluster, `row` for the More sheet. The
   * row renders the visible label; the icon button leaves it to the
   * accessible name alone.
   */
  variant?: ThemeToggleVariant
  /** Extra classes for the call site's cluster (placement, not identity). */
  className?: string
}

/** The icon is the state. Two palettes, two glyphs. */
const ICON = {
  light: Sun,
  dark: Moon,
} as const

/** The other side of the flip — the whole ring, in one place. */
function opposite(resolved: 'light' | 'dark'): 'light' | 'dark' {
  return resolved === 'dark' ? 'light' : 'dark'
}

export function ThemeToggle({ variant = 'icon', className = '' }: ThemeToggleProps) {
  const { resolved, setPreference } = useTheme()
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

  const name = t.settings.theme[resolved]
  const nextName = t.settings.theme[opposite(resolved)]
  // The accessible name announces the palette on screen and the one a click
  // brings: "Theme: dark. Switch to light". Lower-case values, because the
  // sentence reads as the value, not as the proper name of the button.
  const message = t.settings.themeToggle.ariaLabel(name.toLowerCase(), nextName.toLowerCase())

  // The flip always lands on an explicit choice: a click while `system` is
  // stored reads the palette on screen, flips it, and persists the explicit
  // value — the shortcut never writes `system`, so the ring stays two-state.
  const flip = useCallback(() => {
    setPreference(opposite(resolved))
  }, [resolved, setPreference])

  // `key` remounts the glyph on each flip, which is what replays the CSS
  // animation; under `reduce` the class is not added at all and the swap is a
  // plain re-render of the sibling icon.
  const glyph = (
    <span
      key={resolved}
      className={`inline-flex h-4 w-4 items-center justify-center${
        reducedMotion ? '' : ' animate-theme-swap'
      }`}
    >
      <Icon icon={ICON[resolved]} className="h-4 w-4" />
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
        onClick={flip}
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

  // The icon button, with no tooltip (#2953): the button renders directly,
  // so hovering or focusing it shows nothing but the focus ring. The icon is
  // the affordance and the accessible name is the whole message for screen
  // readers.
  return (
    <button
      type="button"
      onClick={flip}
      aria-label={message}
      className={`relative flex h-7 w-7 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/80 ${className}`}
    >
      {glyph}
    </button>
  )
}

export default ThemeToggle
