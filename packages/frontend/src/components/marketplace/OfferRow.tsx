import { StatusBadge } from '@/components/ui/StatusBadge'
import { chainName, freshness, networkToChainId } from '@/lib/marketplace'
import type { CatalogEntry } from '@/hooks/useCatalog'

/**
 * One offer's row content in the merchant page's offers table (#3079, epic
 * #3077). Renamed from `CatalogCard` (`CatalogPanel.tsx`, deleted by this
 * issue) — that component rendered a whole card per entry; this renders the
 * per-offer cells a `<tr>` in `OffersTable.tsx` wraps, since an offer's
 * identity is now the merchant page, not a card of its own.
 */
export function OfferRow({
  entry,
  budget,
}: {
  entry: CatalogEntry
  budget: boolean | null
}) {
  const degraded = entry.status === 'degraded'
  const method = entry.protocol === 'mcp' ? entry.tool_name : entry.rail.toUpperCase()
  // The resource URL for every protocol: an MCP offer's tool name is already
  // the Method cell, so repeating it here printed one string under two headers.
  const path = entry.resource_url
  const chainId = networkToChainId(entry.network)

  return (
    <tr data-testid={`offer-row-${entry.id}`}>
      <td className="px-4 py-3 align-top">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--v2-ink)]">{entry.name}</span>
          {degraded ? (
            <span className="rounded-full bg-[var(--v2-warning-soft)] px-2 py-0.5 text-xs font-medium text-[var(--v2-warning)]">
              Limited availability
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 max-w-xs truncate text-xs text-[var(--v2-ink-3)]">{path}</p>
        {degraded ? (
          <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
            Recently unreachable on our checks — a payment may need a retry until it recovers.
          </p>
        ) : null}
      </td>
      <td className="px-4 py-3 align-top text-xs text-[var(--v2-ink-2)]">{method}</td>
      <td className="px-4 py-3 align-top text-xs text-[var(--v2-ink-3)]">{entry.description}</td>
      <td className="v2-tabular px-4 py-3 align-top text-sm font-semibold text-[var(--v2-ink)]">
        {entry.price_display ?? 'Price on request'}
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
      <td className="px-4 py-3 align-top text-xs text-[var(--v2-ink-2)]">{chainId === undefined ? '—' : chainName(chainId)}</td>
      <td className="px-4 py-3 align-top text-xs text-[var(--v2-ink-3)]">
        {freshness(entry.verified_at)}
        {entry.verified_payable && (
          <span title="Domain controlled and verified payable" className="ml-2">
            <StatusBadge tone="success" className="uppercase tracking-wide">
              Verified
            </StatusBadge>
          </span>
        )}
      </td>
    </tr>
  )
}
