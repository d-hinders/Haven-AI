import { Loader2 } from 'lucide-react'
import { Icon } from './Icon'

/**
 * The one busy indicator (#4563).
 *
 * Two sizes, both on the closed icon scale (§ 5 → Size): `sm` is 16px, for a
 * glyph beside text or inside a button; `md` is 20px, for a standalone
 * indicator in a panel. The rotation is gated with `motion-safe:`, so a user
 * who has asked their system to reduce motion gets a still glyph rather than a
 * spinning one — five of the six hand-rolled `animate-spin` sites this
 * replaces had no gate at all.
 *
 * Decorative by default (`aria-hidden` through `Icon`). Pass `label` when the
 * spinner is the only thing saying the surface is busy: it then renders
 * `role="status"` with the label in an `sr-only` span. A spinner never
 * replaces the words that say what is happening — a button in flight still
 * swaps its label to `Verbing…` with `aria-busy` (§ Buttons), and a loading
 * container still carries `aria-busy`/`aria-live` around its skeletons
 * (§ Skeletons).
 */
export type SpinnerSize = 'sm' | 'md'

const SIZE_CLASS: Record<SpinnerSize, string> = {
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
}

export interface SpinnerProps {
  /** `sm` (16px, default) beside text; `md` (20px) standalone. */
  size?: SpinnerSize
  /**
   * Accessible name. Omit when the spinner is decorative — the surrounding
   * copy already says the surface is busy.
   */
  label?: string
  className?: string
}

export function Spinner({ size = 'sm', label, className = '' }: SpinnerProps) {
  return (
    <span
      className={`inline-flex items-center justify-center ${className}`}
      role={label ? 'status' : undefined}
      aria-live={label ? 'polite' : undefined}
    >
      <Icon icon={Loader2} className={`${SIZE_CLASS[size]} motion-safe:animate-spin`} />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  )
}

export default Spinner
