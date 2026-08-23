'use client'

/**
 * Canonical on-chain address display (#853, epic #859).
 *
 * One truncation rule (`0x1234…abcd`), monospace, the full address in a
 * Tooltip, and optionally the check-pop copy affordance — so call sites stop
 * hand-rolling `slice(0, 6)` variants. Purely presentational: size and colour
 * inherit from the caller via `className`, matching how addresses appear in
 * everything from brand links to muted row metadata.
 */

import { ExternalLink } from 'lucide-react'
import { CopyButton } from '@/components/ui/CopyButton'
import { Icon } from '@/components/ui/Icon'
import { Tooltip } from '@/components/ui/Tooltip'
import { truncate } from '@/lib/format'

/** The one truncation rule (`0x1234…abcd`) — re-exported for discoverability. */
export const truncateAddress = truncate

export function Address({
  value,
  copy = false,
  href,
  truncate = true,
  className = '',
}: {
  /** The full address (or hash) — always what the tooltip and copy deliver. */
  value: string
  /** Show the inline copy button with check-pop feedback. */
  copy?: boolean
  /** Render as an external link (block explorer) with the lucide `ExternalLink` affordance. */
  href?: string
  /** `false` renders the full value (e.g. receive-funds surfaces). */
  truncate?: boolean
  className?: string
}) {
  const display = truncate ? truncateAddress(value) : value

  const text = href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="v2-tabular inline-flex items-center gap-1 font-mono font-medium text-[var(--v2-brand)] hover:underline"
    >
      {display}
      <Icon icon={ExternalLink} className="h-3.5 w-3.5" />
    </a>
  ) : (
    // Full addresses must be able to wrap (receive-funds surfaces).
    <span className={`font-mono ${truncate ? '' : 'break-all'}`.trim()}>{display}</span>
  )

  // inline-flex only when the copy button rides along — plain text spans
  // (especially full wrapping addresses) stay in normal inline flow.
  const wrapperClass = copy
    ? `inline-flex min-w-0 items-center gap-1 ${className}`
    : className
  return (
    <span className={wrapperClass.trim()}>
      {truncate ? (
        <Tooltip label={value} mono>
          {text}
        </Tooltip>
      ) : (
        text
      )}
      {copy ? <CopyButton value={value} label="address" /> : null}
    </span>
  )
}
