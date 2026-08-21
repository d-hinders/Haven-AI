import type { TextareaHTMLAttributes, ReactNode } from 'react'

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
  helperText?: ReactNode
}

/**
 * The styled native `<textarea>` — the multi-line half of the `Input` family.
 *
 * Deliberately mirrors `Input`'s radius, surface, padding, focus ring, invalid
 * and disabled treatment, so a description field sitting under a name field
 * belongs to the same form. Before this existed the two textareas in the app
 * were hand-rolled and had drifted apart from each other AND from the `Input`
 * directly above one of them (#1410).
 *
 * `resize-none` by default because both callers want a fixed field in a
 * dialog; pass `className="resize-y"` where growing is genuinely wanted.
 */
export function Textarea({
  className = '',
  invalid = false,
  helperText,
  ...props
}: TextareaProps) {
  const borderClass = invalid
    ? 'border-[var(--v2-danger)] focus:border-[var(--v2-danger)] focus:ring-danger/20'
    : 'border-[var(--v2-border)] focus:border-[var(--v2-brand)] focus:ring-brand/20'

  const textareaEl = (
    <textarea
      className={`w-full resize-none rounded-md border bg-[var(--v2-bg)] px-3 py-2 text-sm text-[var(--v2-ink)] placeholder:text-[var(--v2-ink-3)] transition-colors focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-[var(--v2-surface)] disabled:text-[var(--v2-ink-3)] ${borderClass} ${className}`}
      {...props}
    />
  )

  if (!helperText) return textareaEl

  return (
    <div className="space-y-1.5">
      {textareaEl}
      <p className={`text-xs ${invalid ? 'text-[var(--v2-danger)]' : 'text-[var(--v2-ink-3)]'}`}>
        {helperText}
      </p>
    </div>
  )
}

export default Textarea
