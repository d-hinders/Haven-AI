import type { ReactNode } from 'react'
import { Card } from '@haven_ai/ui/Card'

/**
 * The public site's product frame (#3573) — the mockup's `.frame`: a picture
 * of a Haven screen, with a bar naming the environment and the screen.
 *
 * Built from `@haven_ai/ui`'s `Card` and `Card.Header`, so the frame IS the
 * product's own surface: in the dark theme it shows the dark UI, because
 * the card, its header band and its borders are theme tokens. Elevation is
 * `raised`, whose shadow has its dark form in `tokens.css`.
 *
 * A frame is an illustration, never a working screen (epic rule "No dead
 * links"): its body is `inert`, so nothing inside can be focused or clicked,
 * and `FrameControl` draws a control as a non-interactive span.
 */
export function ProductFrame({
  env,
  screen,
  children,
  className = '',
}: {
  /** The chip on the left of the bar, e.g. "Operations". */
  env: ReactNode
  /** The screen name on the right of the bar, e.g. "Dashboard". */
  screen: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <Card
      hover={false}
      elevation="raised"
      className={`!rounded-[14px] overflow-hidden text-[var(--v2-ink)] ${className}`}
    >
      <Card.Header
        padding="none"
        className="flex items-center justify-between gap-3 px-4 py-3 text-[12.5px] text-[var(--v2-ink-3)]"
      >
        <span className="inline-flex items-center gap-[7px] rounded-full border border-[var(--v2-border)] bg-[var(--v2-bg)] px-[9px] py-[3px] font-medium text-[var(--v2-ink-2)]">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--v2-brand)]" />
          {env}
        </span>
        <span>{screen}</span>
      </Card.Header>
      <div inert className="p-4" data-product-frame-body="">
        {children}
      </div>
    </Card>
  )
}

/**
 * A control drawn inside a frame. It looks like `Button` at size `sm` and is
 * a `<span>`: a frame shows the product, it does not operate it.
 */
export function FrameControl({
  variant = 'ghost',
  children,
}: {
  variant?: 'primary' | 'ghost'
  children: ReactNode
}) {
  const tone =
    variant === 'primary'
      ? 'bg-[var(--v2-brand)] text-[var(--v2-ink-on-brand)]'
      : 'border border-[var(--v2-border-strong)] bg-[var(--v2-bg)] text-[var(--v2-ink)]'
  return (
    <span
      className={`inline-flex h-9 items-center rounded-md px-3.5 text-[13px] font-medium ${tone}`}
    >
      {children}
    </span>
  )
}
