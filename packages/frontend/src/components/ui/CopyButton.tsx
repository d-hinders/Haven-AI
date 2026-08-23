'use client'

/**
 * The inline copy affordance with check-pop feedback (#1878).
 *
 * Extracted on its second occurrence, per the pattern-absorption preflight
 * (epic #904): `Address` owned this button, and `McpServerName` needed the
 * same one. The shape that was duplicated is not just the icon swap — it is
 * the silent-catch around `navigator.clipboard`, the exact hit area, and the
 * focus ring, none of which a second hand-rolled copy would have got right by
 * accident for long.
 *
 * The catch is deliberate and belongs here rather than at each call site:
 * `navigator.clipboard` rejects on an insecure origin, a denied permission,
 * and in most headless captures. A copy button is an accelerator for
 * something already on screen, so failing silently is right — the value is
 * still readable and selectable either way.
 */

import { Check, Clipboard } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useCopyTimeout } from '@/hooks/useCopyTimeout'

/** "address" -> "Address". Only the first character; "MCP server name" keeps its caps. */
function sentenceCase(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export function CopyButton({
  value,
  label,
  className = '',
}: {
  /** The exact text placed on the clipboard — never a truncated display form. */
  value: string
  /**
   * What is being copied, for the accessible name ("Copy address" /
   * "Address copied"). Say the thing, not the widget: "address", "MCP server
   * name". Pass it lowercase — the confirmation sentence-cases it.
   */
  label: string
  className?: string
}) {
  const { copied, markCopied } = useCopyTimeout(1500)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      markCopied()
    } catch {
      /* clipboard unavailable — the value is still on screen */
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? `${sentenceCase(label)} copied` : `Copy ${label}`}
      className={`inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 ${className}`.trim()}
    >
      {copied ? (
        <Icon icon={Check} className="h-3 w-3 text-[var(--v2-success)]" />
      ) : (
        <Icon icon={Clipboard} className="h-3 w-3" />
      )}
    </button>
  )
}
