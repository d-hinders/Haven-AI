'use client'

import { useMemo, useState, useCallback, type ReactNode } from 'react'
import { useCatalog, type CatalogEntry } from '@/hooks/useCatalog'
import { useAgents } from '@/hooks/useAgents'
import { useChainScope } from '@/hooks/useActiveChain'
import { ALL_CHAINS, getChainConfig } from '@/lib/chains'
import { getTokenDecimals, humanAmountToAtomic } from '@/lib/allowance-format'
import { Button } from './ui/Button'
import { EmptyState } from './ui/EmptyState'
import { Select } from './ui/Select'
import { Skeleton } from './ui/Skeleton'
import { StatusBadge } from './ui/StatusBadge'
import CatalogSubmitModal from './CatalogSubmitModal'

// ── Helpers ────────────────────────────────────────────────────────

export type SourceFilter = 'all' | 'ingestion' | 'operator'

/**
 * The epic trust claim, verbatim: "verified" only ever means domain
 * controlled AND verified payable — never merchant honesty, quality or
 * settlement reliability. The badge appears exactly when the row is a
 * self-submitted ingestion entry that passed both proofs.
 */
export function isVerified(entry: Pick<CatalogEntry, 'source'>): boolean {
  return entry.source === 'ingestion'
}

/** Segment pill shared by the category and source filters. */
function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? 'bg-[var(--v2-brand)] text-white'
          : 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-2)] hover:bg-[var(--v2-border)]'
      }`}
    >
      {children}
    </button>
  )
}

/**
 * Resolve a catalog entry's `network` to a chain id. The field is heterogeneous
 * — it arrives as a CAIP-2 id (`eip155:8453`) or a chain short-name (`base`,
 * `base-sepolia`, `gnosis`) — so handle both. Returns `undefined` for unknown /
 * null networks (those only ever show under "All networks").
 */
export function networkToChainId(network: string | null | undefined): number | undefined {
  if (!network) return undefined
  const caip = /^eip155:(\d+)$/.exec(network)
  if (caip) return Number(caip[1])
  return ALL_CHAINS.find((c) => c.shortName === network)?.chainId
}

function chainName(chainId: number): string {
  try {
    return getChainConfig(chainId).name
  } catch {
    return `Chain ${chainId}`
  }
}

/**
 * The ready-to-paste instruction for an entry, phrased so the MCP tool set
 * routes it without extra prompting (mirrors the epic's acceptance phrasing:
 * "pay <url> via <tool> for ...").
 */
export function agentInstruction(entry: CatalogEntry): string {
  if (entry.protocol === 'mcp' && entry.tool_name) {
    return `Pay ${entry.resource_url} via ${entry.tool_name} for <what you want>`
  }
  if (entry.rail === 'mpp') {
    return `Pay the machine-payment resource at ${entry.resource_url} and return the result`
  }
  return `Pay ${entry.resource_url} and return the result`
}

/**
 * Budget check against configured agent allowances: an entry is "within
 * budget" when at least one active agent has an allowance for the entry's
 * asset that covers the price.
 *
 * ── The units, stated because getting them wrong was silent (#2295) ──────────
 *
 * `entry.price_atomic` is atomic. `allowance_amount` on `Agent.allowances` is
 * NOT — it is the human-decimal delegation projection (`"25.00"` for a 25 USDC
 * budget), the same shape that produced the #2283 display bug. This function
 * previously read `BigInt(al.allowance_amount) >= price` inside a `try` whose
 * `catch` returned `null`, so on the delegation rail — the only rail that
 * produces allowances at all since #2020 — the BigInt threw on every row and
 * the badge silently degraded to "unknown" instead of answering. Its docstring
 * asserted the opposite ("Configured amounts are atomic strings, same unit as
 * price_atomic"), which is why nobody looked.
 *
 * The comparison is done in atomic units, with the human budget scaled up by
 * the token's decimals rather than the price scaled down — no rounding, and
 * `humanAmountToAtomic` is told which shape it has instead of inferring one.
 * `null` still means "cannot answer" (no price, no matching allowance,
 * unresolvable decimals, unparseable budget), never "over budget": this badge
 * is advisory, and the on-chain caveat enforcer is what actually refuses.
 */
export function withinBudget(
  entry: CatalogEntry,
  agents: Array<{ status: string; allowances: Array<{ token_symbol: string; allowance_amount: string }> }>,
): boolean | null {
  if (!entry.price_atomic || !entry.asset) return null
  const candidates = agents
    .filter((a) => a.status === 'active')
    .flatMap((a) => a.allowances)
    .filter((al) => al.token_symbol === entry.asset)
  if (candidates.length === 0) return null

  const chainId = networkToChainId(entry.network)
  const decimals = chainId != null ? getTokenDecimals(chainId, entry.asset) : undefined
  // Without decimals the two units cannot be reconciled, and guessing 18 for
  // a 6-decimal stablecoin would answer "within budget" by a factor of 10^12.
  if (decimals == null) return null

  let price: bigint
  try {
    price = BigInt(entry.price_atomic)
  } catch {
    // `price_atomic` is the merchant's own advertised value, so a malformed
    // one is a real possibility rather than a shape confusion.
    return null
  }
  const budgets = candidates.map((al) => humanAmountToAtomic(al.allowance_amount, decimals))
  if (budgets.some((budget) => budget != null && budget >= price)) return true
  // A budget we could not parse is not a budget we know to be too small.
  // Reporting `false` there would paint "over budget" on an agent that may
  // well cover the price — the misleading direction. Only a set of budgets we
  // fully understood, none of which covers the price, is an honest `false`.
  return budgets.every((budget) => budget != null) ? false : null
}

function freshness(verifiedAt: string | null): string {
  if (!verifiedAt) return 'not yet verified'
  const ageMs = Date.now() - new Date(verifiedAt).getTime()
  const hours = Math.floor(ageMs / 3_600_000)
  if (hours < 1) return 'verified just now'
  if (hours < 24) return `verified ${hours}h ago`
  return `verified ${Math.floor(hours / 24)}d ago`
}

// ── Card ───────────────────────────────────────────────────────────

function CatalogCard({
  entry,
  budget,
}: {
  entry: CatalogEntry
  budget: boolean | null
}) {
  const [copied, setCopied] = useState(false)
  const degraded = entry.status === 'degraded'
  const instruction = agentInstruction(entry)

  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(instruction)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [instruction])

  return (
    <article
      className="flex flex-col gap-3 rounded-xl border border-[var(--v2-border)] bg-white p-4 transition-colors hover:border-brand/30"
      data-testid={`catalog-card-${entry.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-[var(--v2-ink)]">{entry.name}</h3>
          <p className="mt-0.5 line-clamp-2 text-xs text-[var(--v2-ink-3)]">{entry.description}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="rounded-full bg-[var(--v2-surface-2)] px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-[var(--v2-ink-2)]">
            {entry.rail}
          </span>
          {isVerified(entry) && (
            <span title="Domain controlled and verified payable">
              <StatusBadge tone="success" className="uppercase tracking-wide">
                Verified
              </StatusBadge>
            </span>
          )}
          {degraded ? (
            <span className="rounded-full bg-[var(--v2-warning-soft)] px-2 py-0.5 text-xs font-medium text-[var(--v2-warning)]">
              Limited availability
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex items-baseline justify-between gap-2">
        <span className="v2-tabular text-base font-semibold text-[var(--v2-ink)]">
          {entry.price_display ?? 'Price on request'}
        </span>
        <span className="text-xs text-[var(--v2-ink-3)]">{freshness(entry.verified_at)}</span>
      </div>

      {/*
        #2295: all three states of this line became reachable only when
        `withinBudget` stopped discriminating wire shapes by exception. The
        `false` branch had been DEAD — the function could return `true` or
        `null` and nothing else — and the copy it carried had gone stale
        unnoticed: it said an over-budget purchase "would queue for approval",
        which is retired AllowanceModule behaviour (#1440/#1986). The
        delegation rail does not queue; an over-budget redemption reverts at
        the caveat enforcer. Same correction `docs/operations/agent-qa.md`
        made under #2140, applied to the last live instance.

        Deliberately `--v2-warning`, not `--v2-danger`, and no pill or icon:
        this line is ADVISORY. The badge is a client-side comparison against a
        reported budget, and the thing that actually refuses a payment is the
        on-chain enforcer — so it must not read as a hard block. `null`
        renders nothing at all, which is absence rather than failure.
      */}
      {budget !== null && (
        <p
          className={`text-xs font-medium ${
            budget ? 'text-[var(--v2-success)]' : 'text-[var(--v2-warning)]'
          }`}
        >
          {budget
            ? 'Within your agent budget'
            : 'Above every agent budget — a payment would be declined'}
        </p>
      )}

      {degraded ? (
        <p className="text-xs text-[var(--v2-ink-3)]">
          Recently unreachable on our checks — a payment may need a retry until it recovers.
        </p>
      ) : null}

      <div className="rounded-lg bg-[var(--v2-surface-2)] px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <code className="min-w-0 truncate text-xs text-[var(--v2-ink-2)]">{instruction}</code>
          <button
            onClick={copy}
            className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-[var(--v2-brand)] transition-colors hover:bg-white"
            aria-label={`Copy agent instruction for ${entry.name}`}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </article>
  )
}

// ── Panel ──────────────────────────────────────────────────────────

export default function CatalogPanel() {
  const { entries, loading, error, refetch } = useCatalog()
  const { agents } = useAgents()
  const [category, setCategory] = useState<string | null>(null)
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [submitOpen, setSubmitOpen] = useState(false)
  // Catalog follows the active chain by default and re-defaults when it switches;
  // the network dropdown is the manual override (#633, epic #625).
  const { scope, setScope } = useChainScope('follow-active')

  const categories = useMemo(
    () => Array.from(new Set(entries.map((e) => e.category))).sort(),
    [entries],
  )
  // Distinct chains present in the catalog, for the override dropdown.
  const chainIds = useMemo(
    () =>
      Array.from(
        new Set(
          entries
            .map((e) => networkToChainId(e.network))
            .filter((id): id is number => id !== undefined),
        ),
      ).sort((a, b) => a - b),
    [entries],
  )
  const visible = useMemo(
    () =>
      entries.filter((e) => {
        if (category && e.category !== category) return false
        if (sourceFilter === 'ingestion' && !isVerified(e)) return false
        if (sourceFilter === 'operator' && e.source !== 'operator') return false
        if (scope === 'all') return true
        return networkToChainId(e.network) === scope
      }),
    [entries, category, sourceFilter, scope],
  )
  // Show the network filter when there's a real choice: multiple chains, or the
  // active chain has no catalog entries (so the user has an escape hatch to "all").
  const showNetworkFilter =
    chainIds.length > 1 || (typeof scope === 'number' && !chainIds.includes(scope))

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-40 rounded-xl" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-xl border border-danger/20 bg-[var(--v2-danger-soft)] px-4 py-3">
        <p className="text-sm font-medium text-[var(--v2-danger)]">Could not load the catalog</p>
        <p className="mt-1 text-sm text-[var(--v2-danger)]">{error}</p>
      </div>
    )
  }

  const emptyCatalog = entries.length === 0

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div role="group" aria-label="Filter by verification" className="flex flex-wrap gap-2">
          <FilterPill active={sourceFilter === 'all'} onClick={() => setSourceFilter('all')}>
            All
          </FilterPill>
          <FilterPill
            active={sourceFilter === 'ingestion'}
            onClick={() => setSourceFilter('ingestion')}
          >
            Verified
          </FilterPill>
          <FilterPill
            active={sourceFilter === 'operator'}
            onClick={() => setSourceFilter('operator')}
          >
            Operator-curated
          </FilterPill>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setSubmitOpen(true)}>
          List your payable service
        </Button>
      </div>

      <p className="mb-4 text-xs leading-relaxed text-[var(--v2-ink-3)]">
        Verified listings have proven domain control and a confirmed payable endpoint.
        Operator-curated listings are added by the Haven team.
      </p>

      {!emptyCatalog && showNetworkFilter && (
        <div className="mb-4 flex items-center gap-2">
          <label htmlFor="catalog-network" className="text-xs font-medium text-[var(--v2-ink-3)]">
            Network
          </label>
          <Select
            id="catalog-network"
            aria-label="Filter catalog by network"
            value={scope === 'all' ? 'all' : String(scope)}
            onChange={(e) =>
              setScope(e.target.value === 'all' ? 'all' : Number(e.target.value))
            }
            className="max-w-[200px]"
          >
            <option value="all">All networks</option>
            {chainIds.map((id) => (
              <option key={id} value={String(id)}>
                {chainName(id)}
              </option>
            ))}
          </Select>
        </div>
      )}

      {categories.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter by category">
          <FilterPill active={category === null} onClick={() => setCategory(null)}>
            All
          </FilterPill>
          {categories.map((c) => (
            <FilterPill key={c} active={category === c} onClick={() => setCategory(c)}>
              <span className="capitalize">{c}</span>
            </FilterPill>
          ))}
        </div>
      )}

      {emptyCatalog ? (
        <EmptyState
          title="No services listed yet"
          body="The catalog is curated — new payable services appear here as they are verified."
        />
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-6 text-center">
          {sourceFilter === 'ingestion' ? (
            <>
              <p className="text-sm font-medium text-[var(--v2-ink-2)]">
                No verified listings yet
              </p>
              <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
                List your payable service and it will appear here once verified.
              </p>
            </>
          ) : sourceFilter === 'operator' ? (
            <p className="text-sm font-medium text-[var(--v2-ink-2)]">
              No operator-curated services yet
            </p>
          ) : (
            <>
              <p className="text-sm font-medium text-[var(--v2-ink-2)]">
                {typeof scope === 'number'
                  ? `No services on ${chainName(scope)} yet`
                  : 'No services match this filter'}
              </p>
              {typeof scope === 'number' && (
                <button
                  onClick={() => setScope('all')}
                  className="mt-2 text-xs font-medium text-[var(--v2-brand)] hover:underline"
                >
                  View all networks
                </button>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map((entry) => (
            <CatalogCard key={entry.id} entry={entry} budget={withinBudget(entry, agents)} />
          ))}
        </div>
      )}

      <CatalogSubmitModal
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        onVerifiedPayable={() => void refetch()}
      />
    </div>
  )
}
