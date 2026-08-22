import type { InputHTMLAttributes, ReactNode } from 'react'
import { Copy } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'

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
      className="text-xs font-semibold uppercase tracking-wide text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] px-1.5 py-0.5 rounded-md hover:bg-[var(--v2-brand-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 disabled:opacity-40 disabled:pointer-events-none transition-colors"
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
      className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] px-1.5 py-0.5 rounded-md hover:bg-[var(--v2-brand-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 disabled:opacity-40 disabled:pointer-events-none transition-colors"
    >
      <Icon icon={Copy} className="w-3.5 h-3.5" />
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
  // `focus-visible:`, not `focus:` (#1746). A text field is the one control
  // where the two are NOT a behavioural trade-off: per the Selectors-4
  // heuristic every browser implements, a focused text input matches
  // `:focus-visible` however it was focused, mouse click included. So the ring
  // still marks the field you are typing in — the behaviour the `focus:` form
  // was there to buy — while the family now matches Button/Row/Modal.
  const borderClass = invalid
    ? 'border-[var(--v2-danger)] focus-visible:border-[var(--v2-danger)] focus-visible:ring-danger/80'
    : 'border-[var(--v2-border)] focus-visible:border-[var(--v2-brand)] focus-visible:ring-brand/80'

  const inputEl = (
    <div className="relative">
      {leftIcon && (
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--v2-ink-3)] pointer-events-none">
          {leftIcon}
        </span>
      )}
      <input
        className={`w-full rounded-md border bg-[var(--v2-bg)] px-3 py-2 text-sm text-[var(--v2-ink)] placeholder:text-[var(--v2-ink-3)] transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:bg-[var(--v2-surface)] disabled:text-[var(--v2-ink-3)] ${borderClass} ${leftIcon ? 'pl-9' : ''} ${rightAction ? 'pr-24' : ''} ${className}`}
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
