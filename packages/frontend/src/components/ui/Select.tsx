import type { SelectHTMLAttributes } from 'react'

export function Select({
  className = '',
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`w-full rounded-md border border-[var(--v2-border)] bg-[var(--v2-bg)] px-3 py-2 text-sm text-[var(--v2-ink)] transition-colors focus:border-[var(--v2-brand)] focus:outline-none focus:ring-2 focus:ring-[var(--v2-brand)]/20 disabled:cursor-not-allowed disabled:bg-[var(--v2-surface)] disabled:text-[var(--v2-ink-3)] ${className}`}
      {...props}
    >
      {children}
    </select>
  )
}
