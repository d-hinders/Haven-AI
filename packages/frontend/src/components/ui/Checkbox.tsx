import type { InputHTMLAttributes, ReactNode } from 'react'

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /**
   * The text beside the box. Every use in Haven is a checkbox plus an
   * explanation rather than a bare tick, so the label is required and the
   * component owns the row layout — that is the shape being absorbed.
   */
  label: ReactNode
  /** Layout/typography of the row (the wrapping label), not the box. */
  className?: string
  helperText?: ReactNode
}

/**
 * The styled native checkbox (#1410).
 *
 * Every raw `<input type="checkbox">` in the product app lived in the
 * connect-agent flow, each re-deriving the same `flex items-start gap-2`
 * label row — so the row is part of the primitive, not left to callers.
 *
 * Intentionally the NATIVE control with `accent-color`, not a custom-painted
 * box: it keeps the platform's keyboard behaviour and screen-reader semantics
 * for free, which a hand-built div would have to re-earn. Wrapping in
 * `<label>` gives implicit association, so the text is a click target with no
 * `id`/`htmlFor` wiring at the call site. The focus RING is ours, not the
 * platform's — `focus-visible:outline-none` replaces it with the product
 * treatment, so it is the one part of the native package we do re-earn.
 *
 * That ring MUST carry an offset (#1741). `accent-color` paints the box solid
 * `--v2-brand` when CHECKED, so an un-offset brand ring composites
 * brand-over-brand at ~1.5:1 — the same defect fixed in `WalletButton` and
 * `ErrorBoundary`, but hidden here because the fill is state-dependent and so
 * never appears as a `bg-` class in the markup. The offset puts a
 * `--v2-bg` moat between box and ring, which lands the ring on white (4.19:1)
 * in both the checked and unchecked states.
 *
 * No ref is forwarded, so `indeterminate` — a DOM property, not an attribute —
 * is out of reach. Nothing needs it yet (every checkbox in the app is a single
 * confirmation, not a select-all); add `forwardRef` when a real tri-state
 * arrives rather than speculatively.
 */
export function Checkbox({
  label,
  className = '',
  helperText,
  ...props
}: CheckboxProps) {
  return (
    <label className={`flex items-start gap-2 ${className}`}>
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--v2-brand)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)] disabled:cursor-not-allowed disabled:opacity-50"
        {...props}
      />
      <span className={props.disabled ? 'text-[var(--v2-ink-3)]' : undefined}>
        {label}
        {helperText && (
          <span className="mt-1 block text-[var(--v2-ink-3)]">{helperText}</span>
        )}
      </span>
    </label>
  )
}

export default Checkbox
