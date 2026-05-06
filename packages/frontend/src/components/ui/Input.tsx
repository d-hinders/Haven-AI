import type { InputHTMLAttributes } from 'react'

export function Input({
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-md border border-[var(--v2-border)] bg-[var(--v2-bg)] px-3 py-2 text-sm text-[var(--v2-ink)] placeholder:text-[var(--v2-ink-3)] transition-colors focus:border-[var(--v2-brand)] focus:outline-none focus:ring-2 focus:ring-[var(--v2-brand)]/20 disabled:cursor-not-allowed disabled:bg-[var(--v2-surface)] disabled:text-[var(--v2-ink-3)] ${className}`}
      {...props}
    />
  )
}
