import type { LucideIcon } from 'lucide-react'

/**
 * Haven icon conventions — one family, one weight.
 *
 * All UI icons come from lucide-react and render through this wrapper so the
 * stroke weight (1.5) and accessibility defaults stay uniform. Icons are
 * decorative by default (`aria-hidden`); pass `label` when the icon is the
 * only content conveying meaning (e.g. an icon-only button without its own
 * `aria-label`).
 *
 * Sizing is via className (`h-4 w-4` etc.) like any other element. Brand
 * marks (`components/brand`) and marketing pages are the only surfaces that
 * may use bespoke SVGs.
 */
type IconProps = {
  icon: LucideIcon
  className?: string
  /** Accessible name. Omit for decorative icons (the default). */
  label?: string
  /**
   * Stroke weight override. 1.5 is the system default — deviate only with a
   * comment explaining why, per the /design-system Icons section.
   */
  strokeWidth?: number
  /** Pixel size for numeric-sized call sites. Prefer className (`h-4 w-4`). */
  size?: number
}

export function Icon({ icon: Glyph, className = '', label, strokeWidth = 1.5, size }: IconProps) {
  return (
    <Glyph
      className={className}
      size={size}
      strokeWidth={strokeWidth}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      focusable={false}
    />
  )
}
