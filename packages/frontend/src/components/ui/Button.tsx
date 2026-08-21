import Link from 'next/link'
import { forwardRef } from 'react'
import { ArrowRight } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'ghost' | 'tertiary' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const SIZE_CLASS: Record<Size, string> = {
  sm: 'h-9 px-3.5 text-[13px]',
  md: 'h-10 px-4 text-[14px]',
  lg: 'h-11 px-5 text-[15px]',
}

/**
 * Tap-target extension (#1726).
 *
 * `sm` renders 36px tall and `md` 40px — both under the ~44px commonly cited as
 * a comfortable touch target. (Neither is an accessibility failure: WCAG 2.2 AA
 * *Target Size (Minimum)* has a 24px floor. This is comfort and mis-tap rate,
 * which matters most in row lists of destructive actions — the Backup & recovery
 * card's stacked `Remove` buttons at 390px are the case that surfaced it.)
 *
 * Rather than raise the rendered heights — which would move the density of every
 * table, toolbar and row list in the product and require new visual baselines —
 * a transparent pseudo-element extends the *hit area* to 44px while the button
 * still renders at its declared height. Nothing about the painted pixels changes.
 *
 * Deliberately **vertical only**. An `sm` button's width already clears 44px at
 * every real call site (`px-3.5` plus a label), and growing the target sideways
 * would let a button in a tight `gap-2` toolbar swallow clicks meant for its
 * neighbour. The vertical overhang is 4px per edge on `sm` and 2px on `md`,
 * which is within half of the 8px minimum gap this design system uses between
 * stacked controls, so adjacent targets meet but never overlap.
 *
 * `lg` is already 44px and gets nothing.
 */
const TAP_TARGET_CLASS: Record<Size, string> = {
  sm: "relative after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-['']",
  md: "relative after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-['']",
  lg: '',
}

const VARIANT_CLASS: Record<Variant, string> = {
  primary:
    'bg-[var(--v2-brand)] text-white hover:bg-[var(--v2-brand-strong)] shadow-[var(--v2-shadow-button)]',
  ghost:
    'bg-white text-[var(--v2-ink)] border border-[var(--v2-border-strong)] hover:bg-[var(--v2-surface)]',
  tertiary:
    'bg-transparent text-[var(--v2-ink-2)] hover:bg-[var(--v2-surface)] hover:text-[var(--v2-ink)]',
  danger:
    'bg-[var(--v2-danger)] text-white hover:bg-[var(--v2-danger)]/90 shadow-[var(--v2-shadow-button)]',
}

type ButtonProps = {
  children: ReactNode
  href?: string
  target?: AnchorHTMLAttributes<HTMLAnchorElement>['target']
  rel?: AnchorHTMLAttributes<HTMLAnchorElement>['rel']
  type?: ButtonHTMLAttributes<HTMLButtonElement>['type']
  disabled?: boolean
  onClick?: ButtonHTMLAttributes<HTMLButtonElement>['onClick']
  variant?: Variant
  size?: Size
  className?: string
  trailingIcon?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  children,
  href,
  target,
  rel,
  type = 'button',
  disabled,
  onClick,
  variant = 'primary',
  size = 'md',
  className = '',
  trailingIcon,
}, ref) {
  const classes = `inline-flex items-center justify-center gap-1.5 rounded-md font-medium tracking-tight transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)] disabled:cursor-not-allowed disabled:opacity-60 ${SIZE_CLASS[size]} ${TAP_TARGET_CLASS[size]} ${VARIANT_CLASS[variant]} ${className}`
  const content = (
    <>
      {children}
      {trailingIcon && (
        <Icon icon={ArrowRight} className="w-3.5 h-3.5" />
      )}
    </>
  )

  if (!href) {
    return (
      <button ref={ref} type={type} disabled={disabled} onClick={onClick} className={classes}>
        {content}
      </button>
    )
  }

  return (
    <Link href={href} target={target} rel={rel} className={classes}>
      {content}
    </Link>
  )
})
