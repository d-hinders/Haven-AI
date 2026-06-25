'use client'

import { useMemo, useState, useCallback } from 'react'
import { useCatalog, type CatalogEntry } from '@/hooks/useCatalog'
import { useAgents } from '@/hooks/useAgents'
import { EmptyState } from './ui/EmptyState'
import { Skeleton } from './ui/Skeleton'

// ── Helpers ────────────────────────────────────────────────────────

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
 * asset that covers the price. Configured amounts are atomic strings, same
 * unit as price_atomic.
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
  try {
    const price = BigInt(entry.price_atomic)
    return candidates.some((al) => BigInt(al.allowance_amount) >= price)
  } catch {
    return null
  }
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
      className="flex flex-col gap-3 rounded-xl border border-[var(--v2-border)] bg-white p-4 transition-colors hover:border-[var(--v2-brand)]/30"
      data-testid={`catalog-card-${entry.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-[var(--v2-ink)]">{entry.name}</h3>
          <p className="mt-0.5 line-clamp-2 text-xs text-[var(--v2-ink-3)]">{entry.description}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="rounded-full bg-[var(--v2-surface-2)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--v2-ink-2)]">
            {entry.rail}
          </span>
          {degraded ? (
            <span className="rounded-full bg-[var(--v2-warning-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--v2-warning)]">
              Limited availability
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex items-baseline justify-between gap-2">
        <span className="v2-tabular text-base font-semibold text-[var(--v2-ink)]">
          {entry.price_display ?? 'Price on request'}
        </span>
        <span className="text-[11px] text-[var(--v2-ink-3)]">{freshness(entry.verified_at)}</span>
      </div>

      {budget !== null && (
        <p
          className={`text-xs font-medium ${
            budget ? 'text-[var(--v2-success)]' : 'text-[var(--v2-warning)]'
          }`}
        >
          {budget
            ? 'Within your agent budget'
            : 'Exceeds every agent allowance — would queue for approval'}
        </p>
      )}

      {degraded ? (
        <p className="text-[11px] text-[var(--v2-ink-3)]">
          Recently unreachable on our checks — a payment may need a retry until it recovers.
        </p>
      ) : null}

      <div className="rounded-lg bg-[var(--v2-surface-2)] px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <code className="min-w-0 truncate text-[11px] text-[var(--v2-ink-2)]">{instruction}</code>
          <button
            onClick={copy}
            className="shrink-0 rounded px-2 py-0.5 text-[11px] font-medium text-[var(--v2-brand)] transition-colors hover:bg-white"
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
  const { entries, loading, error } = useCatalog()
  const { agents } = useAgents()
  const [category, setCategory] = useState<string | null>(null)

  const categories = useMemo(
    () => Array.from(new Set(entries.map((e) => e.category))).sort(),
    [entries],
  )
  const visible = useMemo(
    () => (category ? entries.filter((e) => e.category === category) : entries),
    [entries, category],
  )

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
      <div className="rounded-xl border border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] px-4 py-3">
        <p className="text-sm font-medium text-[var(--v2-danger)]">Could not load the catalog</p>
        <p className="mt-1 text-sm text-[var(--v2-danger)]">{error}</p>
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        title="No services listed yet"
        body="The catalog is curated — new payable services appear here as they are verified."
      />
    )
  }

  return (
    <div>
      {categories.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter by category">
          <button
            onClick={() => setCategory(null)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              category === null
                ? 'bg-[var(--v2-brand)] text-white'
                : 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-2)] hover:bg-[var(--v2-border)]'
            }`}
          >
            All
          </button>
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${
                category === c
                  ? 'bg-[var(--v2-brand)] text-white'
                  : 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-2)] hover:bg-[var(--v2-border)]'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {visible.map((entry) => (
          <CatalogCard key={entry.id} entry={entry} budget={withinBudget(entry, agents)} />
        ))}
      </div>
    </div>
  )
}
