import Link from 'next/link'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'ghost'
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
}

export function Button({
  children,
  href,
  type = 'button',
  disabled,
  onClick,
  variant = 'primary',
  size = 'md',
  className = '',
  trailingIcon,
}: {
  children: ReactNode
  href?: string
  type?: ButtonHTMLAttributes<HTMLButtonElement>['type']
  disabled?: boolean
  onClick?: ButtonHTMLAttributes<HTMLButtonElement>['onClick']
  variant?: Variant
  size?: Size
  className?: string
  trailingIcon?: boolean
}) {
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
      <button type={type} disabled={disabled} onClick={onClick} className={classes}>
        {content}
      </button>
    )
  }

  return (
    <Link href={href} className={classes}>
      {content}
    </Link>
  )
}
