import { Skeleton } from '@/components/ui/Skeleton'

/**
 * The one route and auth fallback (#4568).
 *
 * Ten call sites hand-copied the same block — a pulsing brand dot beside an
 * ASCII-dotted `Loading` label — with two different ink tones (`ink-2` and
 * `ink-3`). This is that block, once: one dot, one ink tone, one label.
 *
 * The label is `Loading…` with a real ellipsis (U+2026), the same character
 * slice 3 (#4563) settled on for in-flight copy. It is VISIBLE and it is the
 * element's accessible name, so a screen reader announces the same words a
 * sighted user reads — `role="status"` plus `aria-live="polite"` announces it
 * when the fallback replaces content, and `aria-busy="true"` says the region
 * is still working.
 *
 * The dot is a `Skeleton` rather than a hand-rolled pulsing div: the
 * primitive owns the pulse (§ Skeletons), and the brand colour is passed
 * through `className` the way every other caller sizes and tints it.
 *
 * `label` exists for the one fallback that says more than "loading" — the
 * account page's `Loading account…`. Everything else takes the default.
 */
export interface RouteLoadingProps {
  /** The visible, announced label. Defaults to `Loading…` (U+2026). */
  label?: string
  /** The row's own layout — padding, centring, the page's wrapper. */
  className?: string
}

export function RouteLoading({ label = 'Loading…', className = '' }: RouteLoadingProps) {
  // `status` takes no name from its contents, so the label is also the
  // region's accessible name — the same words a sighted user reads, and the
  // same name the account page's loading test has always asserted.
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label={label}
      className={`flex items-center gap-3 ${className}`}
    >
      <Skeleton variant="circle" className="h-2 w-2 bg-[var(--v2-brand)]" />
      <span className="text-sm text-[var(--v2-ink-2)]">{label}</span>
    </div>
  )
}

export default RouteLoading
