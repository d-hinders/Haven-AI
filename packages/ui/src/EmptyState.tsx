import type { ReactNode } from 'react'

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger'
type Size = 'default' | 'compact' | 'inline'
type Align = 'center' | 'start'

interface EmptyStateProps {
  icon?: ReactNode
  /** Tone of the leading icon's tinted circle. Defaults to `brand`. */
  tone?: Tone
  title: string
  body?: ReactNode
  action?: ReactNode
  /**
   * `default` — page/section-level empty state (roomy, icon halo).
   * `compact` — in-card previews and side columns (tighter padding + type).
   * `inline` — a one-line dashed placeholder inside dense content (renders
   * the title only; icon/body/action belong to the larger sizes).
   */
  size?: Size
  /**
   * Drop the dashed, `--v2-surface`-filled shell (#4563). Use it when the
   * state sits inside a `Card`: the shell would be a second filled surface
   * inside the card, which `CLAUDE.md` § UI Surface Hierarchy forbids.
   *
   * A separate prop rather than a fourth `size` because the two axes are
   * independent — `size` is density, `bare` is surface. `size="compact" bare`
   * is the in-card preview; `bare` alone is the in-card page-level state.
   */
  bare?: boolean
  /**
   * `center` (default) — the state stands on its own: a page, a section, a
   * list body.
   * `start` — the state sits in left-aligned content and must line up with it:
   * a card column under a left-aligned heading, a settings row's value.
   * Everything starts at the content edge; with `bare` and `inline` the line
   * also drops its padding, so it is plain text where a value would be.
   *
   * An option, not a `className="text-left px-0"` override: that class list
   * also holds `text-center` and `px-3`, and Tailwind emits those AFTER
   * `text-left` and `px-0`, so the override silently lost (the Spending card's
   * "No budget yet." sat centred above a left-aligned Set budget button).
   */
  align?: Align
  className?: string
}

const TONE_CLASSES: Record<Tone, { iconBg: string; iconColor: string; halo: string }> = {
  brand: {
    iconBg: 'bg-[var(--v2-brand-soft)]',
    iconColor: 'text-[var(--v2-brand)]',
    halo: 'ring-brand/10',
  },
  success: {
    iconBg: 'bg-[var(--v2-success-soft)]',
    iconColor: 'text-[var(--v2-success)]',
    halo: 'ring-success/10',
  },
  warning: {
    iconBg: 'bg-[var(--v2-warning-soft)]',
    iconColor: 'text-[var(--v2-warning)]',
    halo: 'ring-warning/10',
  },
  danger: {
    iconBg: 'bg-[var(--v2-danger-soft)]',
    iconColor: 'text-[var(--v2-danger)]',
    halo: 'ring-danger/10',
  },
  neutral: {
    iconBg: 'bg-[var(--v2-surface-2)]',
    iconColor: 'text-[var(--v2-ink-2)]',
    // 40%, not the 10% its four siblings use: this halo is a low-chroma grey,
    // and at 10% it would be all but invisible against --v2-surface-2. The
    // higher opacity buys the SAME visual weight, not more. Don't "fix" it
    // into false consistency with the tinted tones (#1708 design review).
    halo: 'ring-border/40',
  },
}

export function EmptyState({
  icon,
  tone = 'brand',
  title,
  body,
  action,
  size = 'default',
  bare = false,
  align = 'center',
  className = '',
}: EmptyStateProps) {
  const palette = TONE_CLASSES[tone]
  const start = align === 'start'
  const textAlign = start ? 'text-left' : 'text-center'
  // Centred blocks need `mx-auto`; at `start` they sit on the content edge.
  const blockAlign = start ? '' : 'mx-auto'
  // #4563: `bare` drops the shell but keeps everything else. The shell is a
  // filled surface (`--v2-surface`), so inside a `Card` it would be a second
  // filled surface — CLAUDE.md § UI Surface Hierarchy forbids that.
  const shell = bare
    ? textAlign
    : `rounded-[10px] border border-dashed border-[var(--v2-border-strong)] bg-[var(--v2-surface)] ${textAlign}`

  if (size === 'inline') {
    // The padding insets the text from the dashed shell; with no shell and
    // nothing to centre it would only push the text off the content edge.
    const padding = bare && start ? '' : 'px-3 py-2.5'
    return (
      <div className={`${shell} ${padding} text-xs text-[var(--v2-ink-3)] ${className}`}>
        {title}
      </div>
    )
  }

  const isCompact = size === 'compact'
  return (
    <div className={`${shell} ${isCompact ? 'p-6' : 'px-6 py-10'} ${className}`}>
      {icon && (
        <div
          className={`${blockAlign} flex items-center justify-center rounded-full ring-4 ${
            isCompact ? 'mb-3 h-8 w-8' : 'mb-4 h-10 w-10'
          } ${palette.iconBg} ${palette.iconColor} ${palette.halo}`}
        >
          <span className={`inline-flex items-center justify-center ${isCompact ? 'h-4 w-4' : 'h-5 w-5'}`}>
            {icon}
          </span>
        </div>
      )}
      <h3 className={`text-sm text-[var(--v2-ink)] ${isCompact ? 'font-medium' : 'font-semibold'}`}>
        {title}
      </h3>
      {body && (
        <div
          className={`${blockAlign} mt-2 max-w-sm leading-relaxed text-[var(--v2-ink-2)] ${
            isCompact ? 'text-xs' : 'text-sm'
          }`}
        >
          {body}
        </div>
      )}
      {action && <div className={isCompact ? 'mt-4' : 'mt-5'}>{action}</div>}
    </div>
  )
}
