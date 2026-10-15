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
 * and in most headless captures. Where the value is already on screen the
 * button is only an accelerator, so failing silently is right — the value is
 * still readable and selectable. A caller whose value is NOT printed (the
 * marketplace's labelled Copy prompt, #3998, #4003) passes `onCopyFailed` and
 * reveals the value itself, because there a silent failure loses it.
 *
 * Two shapes (#3998): icon-only by default; with `text`, a labelled ghost
 * `Button` ("Copy prompt" → "Copied"). The accessible name keeps the
 * visible words inside it (WCAG 2.5.3, label in name): pass a `label` that
 * starts with the visible noun, e.g. `text="Copy prompt"` with
 * `label="prompt for Fact"` → "Copy prompt for Fact".
 */

import { Check, Clipboard } from 'lucide-react'
import { Button } from './Button'
import { Icon } from './Icon'
import { useCopyTimeout } from './hooks/useCopyTimeout'

/** "address" -> "Address". Only the first character; "MCP server name" keeps its caps. */
function sentenceCase(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export function CopyButton({
  value,
  label,
  text,
  onCopyFailed,
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
  /**
   * A visible label (#3998) — renders the labelled ghost `Button` shape,
   * reading "Copied" once the write succeeds. Omit for the icon-only button.
   */
  text?: string
  /**
   * Called only when `navigator.clipboard.writeText` rejects, the
   * `CodeBlock` precedent. A caller whose value is not on screen must use it
   * to reveal the value; for an on-screen value it can stay unset.
   */
  onCopyFailed?: () => void
  className?: string
}) {
  const { copied, markCopied } = useCopyTimeout(1500)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      markCopied()
    } catch {
      // Clipboard unavailable. Silent for an on-screen value; a caller that
      // does not print the value hears about it and reveals it (#3998).
      onCopyFailed?.()
    }
  }

  const accessibleName = copied ? `${sentenceCase(label)} copied` : `Copy ${label}`

  if (text) {
    return (
      <Button variant="ghost" size="sm" onClick={() => void handleCopy()} aria-label={accessibleName} className={className}>
        {copied ? (
          <Icon icon={Check} className="h-3.5 w-3.5 text-[var(--v2-success)]" />
        ) : (
          <Icon icon={Clipboard} className="h-3.5 w-3.5" />
        )}
        {copied ? 'Copied' : text}
      </Button>
    )
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={accessibleName}
      className={`inline-flex min-h-11 min-w-11 flex-shrink-0 items-center justify-center rounded text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 ${className}`.trim()}
    >
      {copied ? (
        <Icon icon={Check} className="h-3 w-3 text-[var(--v2-success)]" />
      ) : (
        <Icon icon={Clipboard} className="h-3 w-3" />
      )}
    </button>
  )
}
