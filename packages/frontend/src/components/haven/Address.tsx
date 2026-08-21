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

import { Check, Clipboard } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Tooltip } from '@/components/ui/Tooltip'
import { useCopyTimeout } from '@/hooks/useCopyTimeout'
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
  /** Render as an external link (block explorer) with the ↗ affordance. */
  href?: string
  /** `false` renders the full value (e.g. receive-funds surfaces). */
  truncate?: boolean
  className?: string
}) {
  const { copied, markCopied } = useCopyTimeout(1500)
  const display = truncate ? truncateAddress(value) : value

  const text = href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="v2-tabular font-mono font-medium text-[var(--v2-brand)] hover:underline"
    >
      {display} <span aria-hidden="true">↗</span>
    </a>
  ) : (
    // Full addresses must be able to wrap (receive-funds surfaces).
    <span className={`font-mono ${truncate ? '' : 'break-all'}`.trim()}>{display}</span>
  )

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      markCopied()
    } catch {
      /* clipboard unavailable — the tooltip still exposes the full value */
    }
  }

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
      {copy ? (
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? 'Address copied' : 'Copy address'}
          className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
        >
          {copied ? (
            <Icon icon={Check} className="h-3 w-3 text-[var(--v2-success)]" />
          ) : (
            <Icon icon={Clipboard} className="h-3 w-3" />
          )}
        </button>
      ) : null}
    </span>
  )
}
