import { CopyButton } from '@/components/ui/CopyButton'
import { ANY_RECIPIENT_BUDGET_TAG, agentInstruction, chainName, freshness, networkToChainId } from '@/lib/marketplace'
import type { CatalogEntry } from '@/hooks/useCatalog'

/**
 * One offer's row content in the merchant page's single offers list (#3981,
 * epic #3077). Since #3981 the page lists each offer ONCE: no Method column
 * (the rail or MCP tool name survives inside the instruction text) and no
 * per-row Verified badge (the merchant-level badge in `MerchantHeader` is the
 * trust claim). The full instruction is rendered as the second row — one
 * line of monospace text that wraps, never truncates, because it becomes a
 * payment — and the copy button carries the same byte-identical string.
 */
export function OfferRow({
  entry,
  budget,
  tagged,
}: {
  entry: CatalogEntry
  budget: boolean | null
  tagged: boolean
}) {
  const degraded = entry.status === 'degraded'
  const instruction = agentInstruction(entry)
  const chainId = networkToChainId(entry.network)

  return (
    <>
      <tr data-testid={`offer-row-${entry.id}`}>
        <td className="px-4 py-3 align-top">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-[var(--v2-ink)]">{entry.name}</span>
            {degraded ? (
              <span className="rounded-full bg-[var(--v2-warning-soft)] px-2 py-0.5 text-xs font-medium text-[var(--v2-warning)]">
                Limited availability
              </span>
            ) : null}
            {tagged ? (
              <span className="rounded-full bg-[var(--v2-warning-soft)] px-2 py-0.5 text-xs font-medium text-[var(--v2-warning)]">
                {ANY_RECIPIENT_BUDGET_TAG}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">{entry.description}</p>
          <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">{freshness(entry.verified_at)}</p>
          {degraded ? (
            <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
              Recently unreachable on our checks — a payment may need a retry until it recovers.
            </p>
          ) : null}
        </td>
        <td className="px-4 py-3 align-top">
          <span className="v2-tabular text-sm font-semibold text-[var(--v2-ink)]">
            {entry.price_display ?? 'Price on request'}
          </span>
          {budget !== null && (
            <p
              className={`mt-0.5 text-xs font-medium ${
                budget ? 'text-[var(--v2-success)]' : 'text-[var(--v2-warning)]'
              }`}
            >
              {budget
                ? 'Within your agent budget'
                : 'Above every agent budget — a payment would be declined'}
            </p>
          )}
        </td>
        <td className="px-4 py-3 align-top text-xs text-[var(--v2-ink-2)]">
          {chainId === undefined ? '—' : chainName(chainId)}
        </td>
        <td className="px-2 py-3 align-top">
          <CopyButton value={instruction} label={`agent instruction for ${entry.name}`} />
        </td>
      </tr>
      <tr data-testid={`offer-instruction-${entry.id}`}>
        <td colSpan={4} className="px-4 pb-3">
          <code className="block whitespace-pre-wrap break-all text-xs text-[var(--v2-ink-2)]">
            {instruction}
          </code>
        </td>
      </tr>
    </>
  )
}
