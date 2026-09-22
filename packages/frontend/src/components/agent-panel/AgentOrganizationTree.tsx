'use client'

import { useMemo } from 'react'
import { ChevronRight, Network, Plus } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Button } from '@/components/ui/Button'
import type { Organization } from '@/hooks/useOrganizations'
import { buildOrganizationTree, flattenOrganizationTree } from '@/lib/agent-organizations'

/**
 * The organization tree above the agents grid (#3164).
 *
 * One row per organization, depth-indented, with the folder's direct agent
 * count, always fully expanded — organization trees are small (folders, not
 * transactions) and a collapsed branch is one more thing to hunt through.
 * Selecting a row filters the list to that subtree through the #3165 facet;
 * the selection lives in the toolbar's URL-mirrored state, so a shared link
 * keeps it. "All agents" is the unfiltered rest state, "Top level" the
 * explicit option for unfiled agents.
 *
 * Creating the first organization happens from here; managing (rename, move,
 * delete) lives in the manager modal. Empty state: a single quiet line with
 * the create action, not a competing panel — the agents list above stays the
 * primary content. Loading and error states stay inline for the same reason.
 */
export function AgentOrganizationTree({
  organizations,
  loading,
  error,
  selectedId,
  onSelect,
  onCreate,
  onManage,
  onRetry,
}: {
  organizations: Organization[]
  loading: boolean
  error: string | null
  /** The facet's current organization value (null = all agents; 'top_level' = unfiled). */
  selectedId: string | null
  onSelect: (orgId: string | null) => void
  onCreate: () => void
  onManage: () => void
  onRetry: () => void
}) {
  const rows = useMemo(
    () => flattenOrganizationTree(buildOrganizationTree(organizations)),
    [organizations],
  )

  if (loading && organizations.length === 0) {
    return (
      <div className="mb-4 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-3 shadow-card">
        <p className="text-sm text-[var(--v2-ink-3)]" role="status" aria-busy="true" aria-live="polite">
          Loading organizations…
        </p>
      </div>
    )
  }

  if (error && organizations.length === 0) {
    return (
      <div className="mb-4 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-3 shadow-card">
        <p className="text-sm text-[var(--v2-ink-2)]">{error}</p>
        <Button className="mt-2" size="sm" variant="tertiary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    )
  }

  return (
    <div
      data-testid="organization-tree"
      className="mb-4 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-3 shadow-card"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon icon={Network} className="h-3.5 w-3.5 text-[var(--v2-ink-3)]" />
          <span className="text-xs font-medium text-[var(--v2-ink-3)]">Organizations</span>
        </div>
        <div className="flex items-center gap-1">
          <Button onClick={onManage} size="sm" variant="tertiary">
            Manage
          </Button>
          <Button onClick={onCreate} size="sm" variant="tertiary">
            <Icon icon={Plus} className="h-3.5 w-3.5" />
            Add organization
          </Button>
        </div>
      </div>

      {organizations.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--v2-ink-3)]">
          No organizations yet. Add one to start grouping your agents.
        </p>
      ) : (
        <div className="mt-2 space-y-0.5">
          {/* All agents — the unfiltered rest state. */}
          <TreeRow
            label="All agents"
            depth={0}
            selected={selectedId === null}
            onSelect={() => onSelect(null)}
            count={undefined}
            hasChildren={false}
          />
          <TreeRow
            label="Top level"
            depth={0}
            selected={selectedId === 'top_level'}
            onSelect={() => onSelect('top_level')}
            count={undefined}
            hasChildren={false}
          />
          {rows.map((node) => (
            <TreeRow
              key={node.org.id}
              label={node.org.name}
              depth={node.depth}
              selected={selectedId === node.org.id}
              onSelect={() => onSelect(node.org.id)}
              count={node.org.agent_count}
              hasChildren={node.children.length > 0}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function TreeRow({
  label,
  depth,
  selected,
  onSelect,
  count,
  hasChildren,
}: {
  label: string
  depth: number
  selected: boolean
  onSelect: () => void
  count: number | undefined
  hasChildren: boolean
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex min-h-11 w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)] sm:min-h-8 ${
        selected
          ? 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
          : 'text-[var(--v2-ink)] hover:bg-[var(--v2-surface)]'
      }`}
      style={{ paddingLeft: `calc(0.5rem + ${Math.min(depth, 6)}rem)` }}
    >
      <Icon
        icon={ChevronRight}
        className={`h-3 w-3 shrink-0 text-[var(--v2-ink-3)] ${hasChildren ? 'rotate-90' : 'opacity-0'}`}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && (
        <span className="shrink-0 text-xs text-[var(--v2-ink-3)] v2-tabular">{count}</span>
      )}
    </button>
  )
}
