'use client'

import { useState, useMemo, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { getExplorerUrl } from '@/lib/chains'
import { timeAgo } from '@/lib/format'
import { machinePaymentLifecyclePresentation } from '@/lib/machine-payment-lifecycle'
import {
  transactionInitiator,
  transactionMovement,
  transactionStatus,
  transactionTitle,
} from '@/lib/transaction-presentation'
import type { AggregatedTransaction } from '@/types/transactions'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { DirectionMark, ExternalDetailsLink } from '@/components/haven'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Table } from '@/components/ui/Table'
import { Amount } from '@/components/haven'

// ─── Types ────────────────────────────────────────────────────────────────────

type SortColumn = 'date' | 'amount'
type SortDirection = 'asc' | 'desc'

export type TransactionColumnId =
  | 'direction'
  | 'activity'
  | 'initiator'
  | 'fromTo'
  | 'date'
  | 'amount'
  | 'link'

const ALL_COLUMNS: TransactionColumnId[] = [
  'direction',
  'activity',
  'initiator',
  'fromTo',
  'date',
  'amount',
  'link',
]

interface SortState {
  column: SortColumn
  direction: SortDirection
}

interface EmptyStateOverride {
  title: string
  body: string
  action?: ReactNode
}

interface TransactionsTableProps {
  transactions: AggregatedTransaction[]
  loading: boolean
  error: string | null
  onRefresh: () => void
  resolveAddress?: (address: string) => string | null
  safeNamesByAddress?: Map<string, string>
  hasActiveFilters: boolean
  /**
   * Wires the empty-state "Clear filters" action when filters are active.
   * Omitted on screens that don't surface filter controls.
   */
  onClearFilters?: () => void
  /**
   * `page` (default) pins the column header to the page scroll container so
   * it survives long lists. `card` is for tables nested inside a Card — no
   * sticky header, since the surrounding Card supplies the scroll context.
   */
  variant?: 'page' | 'card'
  /**
   * `comfortable` (default) matches the dedicated history page rhythm.
   * `compact` shaves vertical padding so dense card-nested tables don't
   * overpower their host (e.g. the agent detail "Recent activity").
   */
  density?: 'comfortable' | 'compact'
  /**
   * Subset (and order) of columns to render. Defaults to all seven. Use to
   * drop columns that are constant in a given context — e.g. the agent
   * detail view omits `initiator` because every row is the same agent.
   */
  columns?: TransactionColumnId[]
  /**
   * Override the default empty-state copy when there are zero rows AND no
   * active filters. The filter-active empty state is always supplied by the
   * table since only it knows the filter context.
   */
  emptyState?: EmptyStateOverride
  /**
   * When provided, rows become clickable and invoke this with the selected
   * transaction (e.g. to open a detail panel). Omitted on read-only contexts
   * like dashboard previews, where rows stay non-interactive.
   */
  onSelect?: (tx: AggregatedTransaction) => void
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingTable({ columns, padY }: { columns: TransactionColumnId[]; padY: string }) {
  const renders: Record<TransactionColumnId, (key: string) => ReactNode> = {
    direction: (key) => (
      <td key={key} className={`w-9 px-4 ${padY}`}>
        <Skeleton className="h-9 w-9 rounded-[10px]" />
      </td>
    ),
    activity: (key) => (
      <td key={key} className={`px-4 ${padY}`}>
        <div className="space-y-1.5">
          <Skeleton variant="text" className="h-3 w-40" />
          <Skeleton variant="text" className="h-2 w-56" />
        </div>
      </td>
    ),
    initiator: (key) => (
      <td key={key} className={`hidden px-4 ${padY} md:table-cell`}>
        <Skeleton variant="text" className="h-2 w-20" />
      </td>
    ),
    fromTo: (key) => (
      <td key={key} className={`hidden px-4 ${padY} md:table-cell`}>
        <Skeleton variant="text" className="h-2 w-28" />
      </td>
    ),
    date: (key) => (
      <td key={key} className={`hidden px-4 ${padY} md:table-cell`}>
        <Skeleton variant="text" className="h-2 w-14" />
      </td>
    ),
    amount: (key) => (
      <td key={key} className={`px-4 ${padY} text-right`}>
        <Skeleton className="h-4 w-20 ml-auto" />
      </td>
    ),
    link: (key) => (
      <td key={key} className={`w-8 px-4 ${padY} text-center`}>
        <Skeleton className="h-6 w-6 mx-auto" />
      </td>
    ),
  }

  return (
    <div role="status" aria-busy="true" aria-live="polite" aria-label="Loading transactions">
      <Table>
        <Table.Body>
          {[0, 1, 2, 3].map((i) => (
            <tr key={i}>{columns.map((col) => renders[col](`${col}-${i}`))}</tr>
          ))}
        </Table.Body>
      </Table>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function TransactionsTable({
  transactions,
  loading,
  error,
  onRefresh,
  resolveAddress,
  safeNamesByAddress,
  hasActiveFilters,
  onClearFilters,
  variant = 'page',
  density = 'comfortable',
  columns = ALL_COLUMNS,
  emptyState,
  onSelect,
}: TransactionsTableProps) {
  const [sort, setSort] = useState<SortState>({ column: 'date', direction: 'desc' })
  const isSticky = variant === 'page'
  const padY = density === 'compact' ? 'py-3' : 'py-4'
  const showCol = (id: TransactionColumnId) => columns.includes(id)

  function handleSort(col: SortColumn) {
    setSort((prev) =>
      prev.column === col
        ? { column: col, direction: prev.direction === 'desc' ? 'asc' : 'desc' }
        : { column: col, direction: 'desc' },
    )
  }

  const sorted = useMemo(() => {
    const copy = [...transactions]
    copy.sort((a, b) => {
      if (sort.column === 'date') {
        return sort.direction === 'desc'
          ? b.timestamp - a.timestamp
          : a.timestamp - b.timestamp
      }
      // amount: compare on the raw numeric `value` string, not the display value
      // (display strings may carry currency prefixes or locale separators).
      const aVal = parseFloat(a.value) || 0
      const bVal = parseFloat(b.value) || 0
      return sort.direction === 'desc' ? bVal - aVal : aVal - bVal
    })
    return copy
  }, [transactions, sort])

  if (loading) {
    return <LoadingTable columns={columns} padY={padY} />
  }

  if (error) {
    return (
      <EmptyState
        title="Could not load transaction history"
        body={error}
        action={
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            Try again
          </Button>
        }
      />
    )
  }

  const colSpan = columns.length
  const sortTooltip = `Sorts the ${transactions.length} loaded transaction${
    transactions.length === 1 ? '' : 's'
  } — use Load more to widen the set`
  const directionOf = (col: SortColumn): 'asc' | 'desc' | null =>
    sort.column === col ? sort.direction : null

  return (
    <Table>
      <Table.Head sticky={isSticky}>
        <tr>
          {showCol('direction') ? <Table.HeaderCell sticky={isSticky} className="w-9" /> : null}
          {showCol('activity') ? (
            <Table.HeaderCell sticky={isSticky} align="left">
              Activity
            </Table.HeaderCell>
          ) : null}
          {showCol('initiator') ? (
            <Table.HeaderCell sticky={isSticky} align="left" hideBelowMd className="w-[120px]">
              Initiator
            </Table.HeaderCell>
          ) : null}
          {showCol('fromTo') ? (
            <Table.HeaderCell sticky={isSticky} align="left" hideBelowMd className="w-[140px]">
              From / To
            </Table.HeaderCell>
          ) : null}
          {showCol('date') ? (
            <Table.SortableHeaderCell
              label="Date"
              direction={directionOf('date')}
              onSort={() => handleSort('date')}
              tooltip={sortTooltip}
              hideBelowMd
              sticky={isSticky}
              className="w-[90px]"
            />
          ) : null}
          {showCol('amount') ? (
            <Table.SortableHeaderCell
              label="Amount"
              direction={directionOf('amount')}
              onSort={() => handleSort('amount')}
              tooltip={sortTooltip}
              align="right"
              sticky={isSticky}
              className="w-[110px]"
            />
          ) : null}
          {showCol('link') ? <Table.HeaderCell sticky={isSticky} className="w-8" /> : null}
        </tr>
      </Table.Head>

      <Table.Body>
        {sorted.length === 0 ? (
          <tr>
            <td colSpan={colSpan} className="py-16 text-center">
              <EmptyState
                title={
                  hasActiveFilters
                    ? 'No activity matches these filters'
                    : (emptyState?.title ?? 'No activity yet')
                }
                body={
                  hasActiveFilters
                    ? 'Adjust or clear filters to widen the history.'
                    : (emptyState?.body ?? 'Payments and account funding activity will appear here.')
                }
                action={
                  hasActiveFilters && onClearFilters ? (
                    <Button variant="ghost" size="sm" onClick={onClearFilters}>
                      Clear filters
                    </Button>
                  ) : !hasActiveFilters ? (
                    emptyState?.action ?? (
                      <Button href="/dashboard" variant="ghost" size="sm">
                        Open dashboard
                      </Button>
                    )
                  ) : undefined
                }
              />
            </td>
          </tr>
        ) : (
          sorted.map((tx, index) => {
            const movement = transactionMovement(tx, resolveAddress, safeNamesByAddress)
            const initiator = transactionInitiator(tx)
            const lifecycleBadge = machinePaymentLifecyclePresentation(tx)
            const statusBadge = transactionStatus(tx) ?? lifecycleBadge ?? tx.statusBadge

            const selectable = Boolean(onSelect)

            return (
              <tr
                key={`${tx.safeId}:${tx.hash}:${tx.type}:${index}`}
                className={`transition-colors hover:bg-[var(--v2-table-row-hover)]${selectable ? ' cursor-pointer' : ''}`}
                {...(selectable
                  ? {
                      role: 'button' as const,
                      tabIndex: 0,
                      'aria-label': `View details for ${transactionTitle(tx)}`,
                      onClick: () => onSelect?.(tx),
                      onKeyDown: (e: ReactKeyboardEvent<HTMLTableRowElement>) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onSelect?.(tx)
                        }
                      },
                    }
                  : {})}
              >
                {showCol('direction') ? (
                  <td className={`w-9 px-4 ${padY} text-center`}>
                    <DirectionMark direction={tx.direction} />
                  </td>
                ) : null}

                {showCol('activity') ? (
                  <td className={`px-4 ${padY}`}>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-[var(--v2-ink)] truncate">
                        {transactionTitle(tx)}
                      </p>
                      {statusBadge ? (
                        <StatusBadge tone={statusBadge.tone}>{statusBadge.label}</StatusBadge>
                      ) : tx.isError ? (
                        <StatusBadge tone="danger">Failed</StatusBadge>
                      ) : null}
                    </div>
                    {showCol('fromTo') ? (
                      <div className="mt-0.5 text-xs text-[var(--v2-ink-2)] md:hidden">
                        {movement}
                      </div>
                    ) : null}
                  </td>
                ) : null}

                {showCol('initiator') ? (
                  <td className={`hidden md:table-cell w-[120px] px-4 ${padY}`}>
                    <span className="text-xs text-[var(--v2-ink-2)] truncate block">{initiator}</span>
                  </td>
                ) : null}

                {showCol('fromTo') ? (
                  <td className={`hidden md:table-cell w-[140px] px-4 ${padY}`}>
                    <span className="text-xs text-[var(--v2-ink-2)] truncate block">{movement}</span>
                  </td>
                ) : null}

                {showCol('date') ? (
                  <td className={`hidden md:table-cell w-[90px] px-4 ${padY} whitespace-nowrap`}>
                    <span className="v2-tabular text-xs text-[var(--v2-ink-3)]">
                      {timeAgo(tx.timestamp * 1000)}
                    </span>
                  </td>
                ) : null}

                {showCol('amount') ? (
                  <td className={`w-[110px] px-4 ${padY} text-right`}>
                    <Amount
                      value={tx.valueFormatted}
                      symbol={tx.asset}
                      direction={tx.direction}
                      failed={tx.isError}
                    />
                  </td>
                ) : null}

                {showCol('link') ? (
                  <td
                    className={`w-8 px-4 ${padY} text-center`}
                    onClick={selectable ? (e) => e.stopPropagation() : undefined}
                  >
                    {tx.explorerUrl !== null ? (
                      <ExternalDetailsLink href={tx.explorerUrl ?? getExplorerUrl(tx.chainId, 'tx', tx.hash)} />
                    ) : null}
                  </td>
                ) : null}
              </tr>
            )
          })
        )}
      </Table.Body>
    </Table>
  )
}
