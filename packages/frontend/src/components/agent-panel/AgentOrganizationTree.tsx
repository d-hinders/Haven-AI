'use client'

import { useMemo, useState } from 'react'
import { ChevronDown, Folder, Network, Plus } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Button } from '@/components/ui/Button'
import type { Organization } from '@/hooks/useOrganizations'
import { buildOrganizationTree, flattenOrganizationTree, TOP_LEVEL_OPTION } from '@/lib/agent-organizations'

/**
 * The organization tree above the agents grid (#3164).
 *
 * One row per organization, depth-indented. Each row's count is the SAME
 * number the toolbar's Organization filter shows for that option — the
 * facet's per-option count (`counts`, the whole subtree, with the other
 * filters applied) — so the two controls never contradict each other on one
 * screen (#3222 re-review S6: the tree showed direct members, "Tech Agents
 * 0", beside a dropdown saying "Tech Agents 1"). Rows carry a static folder
 * icon, not a chevron: nothing here expands or collapses per branch, and a
 * chevron read as a toggle that did nothing.
 *
 * Below `lg` the rows fold behind one toggle that names the current
 * selection, collapsed by default: at 390px the always-open tree pushed the
 * first agent card below the fold (y ≈ 1045 of 844, re-review S8). From `lg`
 * up it is always open, as before.
 * Selecting a row filters the list to that subtree through the #3165 facet;
 * the selection lives in the toolbar's URL-mirrored state, so a shared link
 * keeps it. "All agents" is the unfiltered rest state, "Top level" the
 * explicit option for unfiled agents.
 *
 * Creating the first organization happens from here; managing (rename, move,
 * delete) lives in the manager modal. Empty state: a single quiet line with
 * the create action, not a competing panel — the agents list above stays the
 * primary content. Loading and error states stay inline for the same reason,
 * and render during refetches too, not only on an empty first load (#3236):
 * with no rows yet they are the panel; with rows present the tree STAYS, with
 * a quiet "Updating…" status or an error line and Try again above the
 * last-known rows. The panel refetches after every agent move and folder
 * change, so swapping the whole tree for a status panel made everything
 * below it jump on each move.
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
  counts,
}: {
  organizations: Organization[]
  /**
   * The organization facet's per-option counts (option value → agents), from
   * `useAgentListFilters`. Required: without it the tree fell back to direct
   * members and contradicted the filter (#3222 re-review S6).
   */
  counts: Record<string, number> | undefined
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
  // Below `lg` only; `lg:block` keeps the rows open on desktop regardless.
  const [expanded, setExpanded] = useState(false)
  const selectedLabel =
    selectedId === null
      ? 'All agents'
      : selectedId === TOP_LEVEL_OPTION
        ? 'Top level'
        : (organizations.find((o) => o.id === selectedId)?.name ?? 'All agents')
  const countFor = (value: string) => (counts ? (counts[value] ?? 0) : undefined)
  // On mobile, picking a row folds the tree again so the filtered list is in view.
  const select = (orgId: string | null) => {
    setExpanded(false)
    onSelect(orgId)
  }

  // #3236: first load (no rows yet) → the status panel. A refetch with rows
  // present keeps the tree and says so in place (the header's "Updating…"
  // and the error row above the rows, below).
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
      aria-busy={loading || undefined}
      className="mb-4 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-3 shadow-card"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon icon={Network} className="h-3.5 w-3.5 text-[var(--v2-ink-3)]" />
          <span className="text-xs font-medium text-[var(--v2-ink-3)]">Organizations</span>
          {/* #3236: a refetch with rows present says so in place — the rows
              stay, so nothing below the tree moves. Deliberately NOT a live
              region: it fires after every agent move, and `aria-busy` on the
              tree already marks the rows as being replaced. */}
          {loading ? <span className="text-xs text-[var(--v2-ink-3)]">Updating…</span> : null}
        </div>
        <div className="flex items-center gap-1">
          <Button onClick={onManage} size="sm" variant="tertiary">
            Manage
          </Button>
          {/* The label hides below `sm` so the header stays one line at 390. */}
          <Button onClick={onCreate} size="sm" variant="tertiary" aria-label="Add organization">
            <Icon icon={Plus} className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Add organization</span>
          </Button>
        </div>
      </div>

      {error ? (
        // A failed refetch: the last-known rows stay below, with the error
        // and a retry above them (#3236).
        <div className="mt-2 flex flex-wrap items-center gap-2" role="alert">
          {/* The rows below ARE loaded — say the refresh failed and they may
              be out of date, not that nothing could be loaded. */}
          <p className="text-sm text-[var(--v2-ink-2)]">
            We could not refresh your organizations — the list below may be out of date.
          </p>
          <Button size="sm" variant="tertiary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}

      {organizations.length > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-controls="organization-tree-rows"
          className="mt-2 flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-[var(--v2-ink)] hover:bg-[var(--v2-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)] lg:hidden"
        >
          <span className="min-w-0 flex-1 truncate">
            <span className="text-[var(--v2-ink-3)]">Showing: </span>
            {selectedLabel}
          </span>
          <Icon
            icon={ChevronDown}
            className={`h-4 w-4 shrink-0 text-[var(--v2-ink-3)] transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        </button>
      ) : null}

      {organizations.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--v2-ink-3)]">
          No organizations yet. Add one to start grouping your agents.
        </p>
      ) : (
        <div
          id="organization-tree-rows"
          className={`mt-2 space-y-0.5 ${expanded ? 'block' : 'hidden'} lg:block`}
        >
          {/* All agents — the unfiltered rest state. */}
          <TreeRow
            label="All agents"
            depth={0}
            selected={selectedId === null}
            onSelect={() => select(null)}
            count={undefined}
            folder={false}
          />
          <TreeRow
            label="Top level"
            depth={0}
            selected={selectedId === 'top_level'}
            onSelect={() => select(TOP_LEVEL_OPTION)}
            count={countFor(TOP_LEVEL_OPTION)}
            folder={false}
          />
          {rows.map((node) => (
            <TreeRow
              key={node.org.id}
              label={node.org.name}
              depth={node.depth}
              selected={selectedId === node.org.id}
              onSelect={() => select(node.org.id)}
              count={countFor(node.org.id)}
              folder
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
  folder,
}: {
  label: string
  depth: number
  selected: boolean
  onSelect: () => void
  count: number | undefined
  /** A static folder icon for organization rows; a same-width spacer otherwise. */
  folder: boolean
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
        icon={Folder}
        aria-hidden="true"
        className={`h-3.5 w-3.5 shrink-0 text-[var(--v2-ink-3)] ${folder ? '' : 'opacity-0'}`}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && (
        <span className="shrink-0 text-xs text-[var(--v2-ink-3)] v2-tabular">{count}</span>
      )}
    </button>
  )
}
