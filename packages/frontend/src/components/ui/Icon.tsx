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
 * Sizing is via className (`h-4 w-4` etc.) like any other element, on a
 * CLOSED six-step scale — 12/14/16/20/24/28 px, i.e. `h-3 h-3.5 h-4 h-5 h-6
 * h-7`, always square, never an arbitrary value. Size cannot be a wrapper
 * DEFAULT the way `strokeWidth` and `aria-hidden` are — there is no one right
 * size — so it is checked in two places instead, split by what each place can
 * actually see:
 *
 *   - the `size` prop, right here, by typing it `IconSize`;
 *   - `className` sizing, by `design-lint`'s `icon-size` rule (#1858) — a
 *     className is an opaque string to the type system, and a runtime check
 *     would not gate CI. That rule scans whole `<Icon>` ELEMENTS, because a
 *     `className` two lines below the tag is invisible to a line-based one.
 *
 * Which rung to pick is a judgement neither check makes — the container-keyed
 * table lives in `docs/product/design-system.md` § 5 → Size.
 *
 * Brand marks (`components/brand`) and marketing pages are the only surfaces
 * that may use bespoke SVGs.
 */
/**
 * The icon size scale (#1858), in pixels — `docs/product/design-system.md`
 * § 5 → Size holds the container-keyed table for choosing among them.
 *
 * Exported so wrappers that thread a size through to `<Icon>` can adopt it
 * and stay inside the same check: `agent-panel/agent-display.tsx`'s `BotIcon`
 * is exactly that case, and it was leaking 15/17/24 past the design-lint gate
 * — which sees `<Icon>` elements, not one-level indirections — until it took
 * this type.
 */
export type IconSize = 12 | 14 | 16 | 20 | 24 | 28

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
  /**
   * Pixel size for numeric-sized call sites. Prefer className (`h-4 w-4`).
   * Typed to the scale, so this half of the size rule IS enforced here,
   * beside `strokeWidth` and `aria-hidden` — `tsc` rejects `size={17}`.
   */
  size?: IconSize
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
