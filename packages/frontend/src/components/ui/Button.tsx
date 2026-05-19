import Link from 'next/link'
import { forwardRef } from 'react'
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'ghost' | 'tertiary' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const SIZE_CLASS: Record<Size, string> = {
  sm: 'h-9 px-3.5 text-[13px]',
  md: 'h-10 px-4 text-[14px]',
  lg: 'h-11 px-5 text-[15px]',
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
  const classes = `inline-flex items-center justify-center gap-1.5 rounded-md font-medium tracking-tight transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)] disabled:cursor-not-allowed disabled:opacity-60 ${SIZE_CLASS[size]} ${VARIANT_CLASS[variant]} ${className}`
  const content = (
    <>
      {children}
      {trailingIcon && (
        <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75}>
          <path d="M3.5 8h9M9 4.5L12.5 8 9 11.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
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
