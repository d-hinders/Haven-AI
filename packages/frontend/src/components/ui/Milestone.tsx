'use client'

/**
 * `Milestone` — the one pattern for a moment worth noticing (#4702, epic
 * #4701).
 *
 * Three strengths, one component, so no page invents its own effect:
 *
 * - `peak` — `check-pop` 320ms plus `v2-bloom` 1100ms. Once, for a first in
 *   your Haven life; the first time you see it, even if it happened while you
 *   were away.
 * - `step` — `check-pop` 320ms only. Only on a change you watch happen; never
 *   on page load.
 * - `live` — one soft brand-soft row fade, 1600ms; no check, no sound. Only on
 *   a row that arrives while the page is open.
 *
 * ## It wraps its child, so size stays the caller's
 *
 * `DialogResult`'s 48px disc, onboarding's 56px disc, `ConnectSteps`' row
 * marks and the guide's `StatusCircle` all use the same component. The bloom
 * is an `inset-0` layer behind the child, so it scales to whatever it wraps
 * instead of carrying a fixed 96px of its own.
 *
 * ## `play` is the slice's decision; the pattern owns what playing looks like
 *
 * `play` defaults to `true` and `false` renders the child static. A slice
 * decides when to play — `DialogResult` mounts fresh on success in all four
 * callers, so success plays on mount with no prop at the call site, while
 * `/design-system` passes `false` until its Replay control.
 *
 * ## Reduced motion: the class is not opted into at all
 *
 * Following `ThemeToggle.tsx:34-37`, the component reads
 * `prefers-reduced-motion: reduce` and follows it live, and under `reduce` it
 * does not add the animation class — so a jsdom test can see the difference
 * rather than recomputing the media query. `globals.css` keeps its own
 * media-query gate as the second half: the class is inert even if a call-site
 * forgets the query.
 *
 * The read is `useSyncExternalStore` rather than a mount effect so the first
 * client render already knows the answer: a mount effect would add the class
 * for one frame and then remove it, and a `useState` initializer that read
 * `matchMedia` would disagree with the server's render. The server snapshot is
 * "no preference", which is what the CSS gate already assumes.
 *
 * ## It owns no live region
 *
 * The announcement stays with the caller: `OnboardingClient`'s `role="status"`
 * stays, and `DialogResult` takes `announce` for the callers that do not
 * already move focus to the outcome region.
 */

import { useSyncExternalStore, type ReactNode } from 'react'

export type MilestoneStrength = 'peak' | 'step' | 'live'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * The bloom behind a Peak, in the token's channel form (§ 1, #1708): the
 * `-rgb` channels are what the Tailwind `success` alias composes, so the glow
 * follows the palette. It is the SUCCESS colour, not brand: a Peak marks a
 * real event that went right, its disc and check are success-toned, and an
 * indigo halo around a green check read as two voices (owner review of the
 * specimens on #4728, 2026-11-08).
 */
const BLOOM_BACKGROUND =
  'radial-gradient(circle, rgb(var(--v2-success-rgb) / 0.35) 0%, rgb(var(--v2-success-rgb) / 0.12) 45%, transparent 70%)'

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const mql = window.matchMedia(REDUCED_MOTION_QUERY)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

function getSnapshot(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

/** The server cannot know the preference; the CSS gate is what holds there. */
function getServerSnapshot(): boolean {
  return false
}

interface Props {
  strength: MilestoneStrength
  /** Play the motion. `false` renders the child static. Default `true`. */
  play?: boolean
  children: ReactNode
  /** Extra classes for the wrapper (placement, not identity). */
  className?: string
}

export function Milestone({ strength, play = true, children, className = '' }: Props) {
  const reducedMotion = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const animating = play && !reducedMotion

  if (strength === 'live') {
    // A row is block-level and keeps its own width; the fade is the wrapper's
    // own background, so the row's content is never re-laid-out.
    return (
      <span className={`relative block ${animating ? 'v2-animate-live' : ''} ${className}`.trim()}>
        {children}
      </span>
    )
  }

  if (strength === 'peak') {
    return (
      <span className={`relative inline-flex ${className}`.trim()}>
        {animating ? (
          <span
            aria-hidden="true"
            className="v2-animate-bloom pointer-events-none absolute inset-0 rounded-full"
            style={{ background: BLOOM_BACKGROUND }}
          />
        ) : null}
        <span className={`relative inline-flex ${animating ? 'animate-check-pop' : ''}`.trim()}>
          {children}
        </span>
      </span>
    )
  }

  return (
    <span className={`inline-flex ${animating ? 'animate-check-pop' : ''} ${className}`.trim()}>
      {children}
    </span>
  )
}

export default Milestone
