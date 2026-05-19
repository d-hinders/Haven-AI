import type { InputHTMLAttributes, ReactNode } from 'react'

// ── MaxButton ────────────────────────────────────────────────────────
export function MaxButton({
  onClick,
  disabled,
}: {
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-[11px] font-semibold uppercase tracking-wide text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] px-1.5 py-0.5 rounded-md hover:bg-[var(--v2-brand-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30 disabled:opacity-40 disabled:pointer-events-none transition-colors"
    >
      Max
    </button>
  )
}

// ── PasteButton ──────────────────────────────────────────────────────
export function PasteButton({
  onPaste,
  disabled,
}: {
  onPaste: (text: string) => void
  disabled?: boolean
}) {
  const handleClick = async () => {
    if (!navigator.clipboard?.readText) {
      console.warn('Paste blocked: clipboard API not available')
      return
    }
    try {
      const text = await navigator.clipboard.readText()
      onPaste(text.trim())
    } catch (err) {
      console.warn('Paste blocked', err)
    }
  }

  return (
    <button
      type="button"
      onClick={() => { void handleClick() }}
      disabled={disabled}
      className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] px-1.5 py-0.5 rounded-md hover:bg-[var(--v2-brand-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30 disabled:opacity-40 disabled:pointer-events-none transition-colors"
    >
      <svg
        className="w-3.5 h-3.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 8.25V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.25" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 10a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8Z" />
      </svg>
      Paste
    </button>
  )
}

// ── Input ────────────────────────────────────────────────────────────
interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  leftIcon?: ReactNode
  rightAction?: ReactNode
  invalid?: boolean
  helperText?: ReactNode
}

export function Input({
  className = '',
  leftIcon,
  rightAction,
  invalid = false,
  helperText,
  ...props
}: InputProps) {
  const borderClass = invalid
    ? 'border-[var(--v2-danger)] focus:border-[var(--v2-danger)] focus:ring-[var(--v2-danger)]/20'
    : 'border-[var(--v2-border)] focus:border-[var(--v2-brand)] focus:ring-[var(--v2-brand)]/20'

  const inputEl = (
    <div className="relative">
      {leftIcon && (
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--v2-ink-3)] pointer-events-none">
          {leftIcon}
        </span>
      )}
      <input
        className={`w-full rounded-md border bg-[var(--v2-bg)] px-3 py-2 text-sm text-[var(--v2-ink)] placeholder:text-[var(--v2-ink-3)] transition-colors focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-[var(--v2-surface)] disabled:text-[var(--v2-ink-3)] ${borderClass} ${leftIcon ? 'pl-9' : ''} ${rightAction ? 'pr-24' : ''} ${className}`}
        {...props}
      />
      {rightAction && (
        <span className="absolute right-2 top-1/2 -translate-y-1/2">
          {rightAction}
        </span>
      )}
    </div>
  )

  if (!helperText) return inputEl

  return (
    <div className="space-y-1.5">
      {inputEl}
      <p className={`text-xs ${invalid ? 'text-[var(--v2-danger)]' : 'text-[var(--v2-ink-3)]'}`}>
        {helperText}
      </p>
    </div>
  )
}

export default Input
