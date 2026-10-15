import { CopyButton } from '@/components/ui/CopyButton'
import { agentInstruction, freshness, instructionNeedsEdit } from '@/lib/marketplace'
import type { CatalogEntry } from '@/hooks/useCatalog'

/**
 * The pieces of one offer that the desktop row (`OfferRow`) and the phone
 * card (`OffersTable`'s `OfferCard`) share since #3998, when the instruction
 * stopped being printed under every offer: the quiet meta line, the
 * instruction that IS still printed (edit-needed, or revealed after a failed
 * copy), and the labelled copy button. One home, so the two shapes cannot
 * drift on what is copied or when the text shows.
 */

/** "https://a.example/api/fact/" → "a.example/api/fact" — the display form only; the copy carries the full URL. */
function resourceLabel(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

/**
 * The grey line under an offer's description: where it is served, then how
 * fresh the verification is. Only the URL truncates — the freshness has no
 * other home on the card, so it is never what gets cut (#3998 design
 * review); the full URL is the title, and the copy button yields the whole
 * instruction anyway. An offer whose instruction stays printed names its tool
 * there, so the line does not repeat it.
 */
export function OfferMeta({ entry }: { entry: CatalogEntry }) {
  return (
    <p className="mt-0.5 flex min-w-0 text-xs text-[var(--v2-ink-3)]" data-testid={`offer-meta-${entry.id}`}>
      <span className="min-w-0 truncate" title={entry.resource_url}>
        {resourceLabel(entry.resource_url)}
      </span>
      <span className="shrink-0 whitespace-nowrap">&nbsp;· {freshness(entry.verified_at)}</span>
    </p>
  )
}

/**
 * The instruction text, printed only when the user must see it:
 * - it carries a placeholder to replace (`instructionNeedsEdit`) — copying a
 *   sentence with `<what you want>` in it must never be the only signal; or
 * - the clipboard refused the copy (`revealed`), so the text would otherwise
 *   be lost. It stays revealed for the rest of the visit.
 */
export function OfferInstructionText({ entry, revealed }: { entry: CatalogEntry; revealed: boolean }) {
  const needsEdit = instructionNeedsEdit(entry)
  if (!needsEdit && !revealed) return null
  return (
    <div className="mt-1.5" data-testid={`offer-instruction-text-${entry.id}`}>
      {/* `overflow-wrap: anywhere` breaks at spaces first and splits a long
          URL only when it must — `break-all` split "via" mid-word on a phone. */}
      <code className="block select-all whitespace-pre-wrap [overflow-wrap:anywhere] text-xs text-[var(--v2-ink-2)]">
        {agentInstruction(entry)}
      </code>
      {/* Announced: a screen-reader user who pressed Copy instruction and was
          refused would otherwise hear nothing. */}
      <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]" role={revealed ? 'status' : undefined}>
        {revealed && !needsEdit
          ? 'Copying was blocked — select the instruction above to copy it.'
          : 'Replace <what you want> before sending.'}
      </p>
    </div>
  )
}

/** The labelled copy button; its accessible name keeps the visible words and names the offer. */
export function OfferCopyButton({
  entry,
  onCopyFailed,
  className,
}: {
  entry: CatalogEntry
  onCopyFailed: () => void
  className?: string
}) {
  return (
    <CopyButton
      value={agentInstruction(entry)}
      label={`instruction for ${entry.name}`}
      text="Copy instruction"
      onCopyFailed={onCopyFailed}
      className={className}
    />
  )
}
