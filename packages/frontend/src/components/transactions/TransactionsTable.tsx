'use client'

import { useState, useMemo, type ReactNode } from 'react'
import { getExplorerUrl } from '@/lib/chains'
import { isMachinePaymentSource, parseX402Hostname, paymentSourceTitle } from '@/lib/transaction-labels'
import { timeAgo, truncate } from '@/lib/format'
import type { AggregatedTransaction } from '@/types/transactions'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { DirectionMark, ExternalDetailsLink, TransactionMovement } from '@/components/haven'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Tooltip } from '@/components/ui/Tooltip'

// ─── Types ────────────────────────────────────────────────────────────────────

type AmountTone = 'success' | 'debit' | 'danger' | 'neutral'
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
}

// ─── Amount tone map ──────────────────────────────────────────────────────────

// Outgoing amounts adopt the sibling `--v2-debit` colour so incoming + outgoing
// read as a symmetric pair (green / sky) instead of green / neutral.
const AMOUNT_TONE_CLASS: Record<AmountTone, string> = {
  success: 'text-[var(--v2-success)]',
  debit: 'text-[var(--v2-debit)]',
  danger: 'text-[var(--v2-danger)]',
  neutral: 'text-[var(--v2-ink)]',
}

// ─── Chevron sort indicator ────────────────────────────────────────────────────

function SortChevron({ active, ascending }: { active: boolean; ascending: boolean }) {
  return (
    <svg
      className={`ml-1 inline-block h-3 w-3 flex-shrink-0 transition-transform ${active ? 'opacity-100' : 'opacity-30'} ${active && ascending ? 'rotate-180' : ''}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2.5}
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  )
}

// ─── Header band ──────────────────────────────────────────────────────────────

// Tokenized so the header band reads as one design-system primitive across
// every transaction list (history page, Safe detail, agent detail). The
// `--v2-table-header-bg` token replaces the previous mix of page-bg and
// surface-tint values that diverged per surface.
const TH_BASE =
  'bg-[var(--v2-table-header-bg)] border-b border-[var(--v2-table-row-border)] text-[11px] uppercase tracking-wide text-[var(--v2-table-header-ink)] px-4 py-3 font-medium'

// Sticky behaviour only applies on the `page` variant. Negative top
// compensates for <main>'s p-6/lg:p-8 padding so the pinned header sits
// flush against the TopBar instead of below the padding.
const TH_STICKY = 'sticky -top-6 lg:-top-8 z-20'

function SortableHeader({
  label,
  column,
  sort,
  onSort,
  loadedCount,
  className = '',
  align = 'left',
  sticky,
}: {
  label: string
  column: SortColumn
  sort: SortState
  onSort: (col: SortColumn) => void
  loadedCount: number
  className?: string
  align?: 'left' | 'right'
  sticky: boolean
}) {
  const active = sort.column === column
  const ascending = active && sort.direction === 'asc'
  const ariaSort: 'ascending' | 'descending' | 'none' = active
    ? (sort.direction === 'asc' ? 'ascending' : 'descending')
    : 'none'
  const buttonAlign = align === 'right' ? 'w-full justify-end' : ''
  const directionWord = active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'unsorted'
  const tooltipLabel = `Sorts the ${loadedCount} loaded transaction${loadedCount === 1 ? '' : 's'} — use Load more to widen the set`
  return (
    <th
      className={`${TH_BASE} ${sticky ? TH_STICKY : ''} ${className}`}
      scope="col"
      aria-sort={ariaSort}
    >
      <Tooltip label={tooltipLabel} side="bottom">
        <button
          type="button"
          onClick={() => onSort(column)}
          aria-label={`Sort by ${label}, currently ${directionWord}`}
          className={`inline-flex items-center gap-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30 focus-visible:ring-offset-1 rounded ${buttonAlign}`}
        >
          {label}
          <SortChevron active={active} ascending={ascending} />
        </button>
      </Tooltip>
    </th>
  )
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
      <table className="w-full border-separate border-spacing-0">
        <tbody className="[&>tr>td]:border-b [&>tr>td]:border-[var(--v2-table-row-border)] [&>tr:last-child>td]:border-b-0">
          {[0, 1, 2, 3].map((i) => (
            <tr key={i}>{columns.map((col) => renders[col](`${col}-${i}`))}</tr>
          ))}
        </tbody>
      </table>
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

  const thStickyClass = isSticky ? TH_STICKY : ''
  const colSpan = columns.length

  return (
    <table className="w-full border-separate border-spacing-0">
      <thead className={`hidden md:table-header-group ${isSticky ? 'sticky -top-6 lg:-top-8 z-10' : ''}`}>
        <tr>
          {showCol('direction') ? (
            <th className={`${TH_BASE} ${thStickyClass} w-9`} scope="col" />
          ) : null}
          {showCol('activity') ? (
            <th className={`${TH_BASE} ${thStickyClass} text-left`} scope="col">
              Activity
            </th>
          ) : null}
          {showCol('initiator') ? (
            <th
              className={`${TH_BASE} ${thStickyClass} w-[120px] text-left hidden md:table-cell`}
              scope="col"
            >
              Initiator
            </th>
          ) : null}
          {showCol('fromTo') ? (
            <th
              className={`${TH_BASE} ${thStickyClass} w-[140px] text-left hidden md:table-cell`}
              scope="col"
            >
              From / To
            </th>
          ) : null}
          {showCol('date') ? (
            <SortableHeader
              label="Date"
              column="date"
              sort={sort}
              onSort={handleSort}
              loadedCount={transactions.length}
              className="w-[90px] hidden md:table-cell"
              sticky={isSticky}
            />
          ) : null}
          {showCol('amount') ? (
            <SortableHeader
              label="Amount"
              column="amount"
              sort={sort}
              onSort={handleSort}
              loadedCount={transactions.length}
              className="w-[110px] text-right"
              align="right"
              sticky={isSticky}
            />
          ) : null}
          {showCol('link') ? (
            <th className={`${TH_BASE} ${thStickyClass} w-8`} scope="col" />
          ) : null}
        </tr>
      </thead>

      <tbody className="[&>tr>td]:border-b [&>tr>td]:border-[var(--v2-table-row-border)] [&>tr:last-child>td]:border-b-0">
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
            // Outgoing amounts intentionally stay neutral ink — the sky
            // `--v2-debit` colour is reserved for the direction icon so
            // the row reads as a calm number with a coloured marker,
            // rather than a busy two-colour line.
            const amountTone: AmountTone = tx.isError
              ? 'danger'
              : tx.direction === 'in'
                ? 'success'
                : 'neutral'
            const movement = transactionMovement(tx, resolveAddress, safeNamesByAddress)
            // Incoming transactions: leave initiator blank (no meaningful "who" — the originator is the sending wallet).
            // Outgoing without an agent: surface as "You".
            const initiator = tx.agentName ?? (tx.direction === 'in' ? '' : 'You')

            return (
              <tr
                key={`${tx.safeId}:${tx.hash}:${tx.type}:${index}`}
                className="hover:bg-[var(--v2-table-row-hover)] transition-colors"
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
                      {tx.statusBadge ? (
                        <StatusBadge tone={tx.statusBadge.tone}>{tx.statusBadge.label}</StatusBadge>
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
                    <span
                      className={`v2-tabular text-sm font-semibold ${AMOUNT_TONE_CLASS[amountTone]}`}
                    >
                      {transactionAmount(tx)}
                    </span>
                  </td>
                ) : null}

                {showCol('link') ? (
                  <td className={`w-8 px-4 ${padY} text-center`}>
                    {tx.explorerUrl !== null ? (
                      <ExternalDetailsLink href={tx.explorerUrl ?? getExplorerUrl(tx.chainId, 'tx', tx.hash)} />
                    ) : null}
                  </td>
                ) : null}
              </tr>
            )
          })
        )}
      </tbody>
    </table>
  )
}

// ─── Helper functions ─────────────────────────────────────────────────────────

function transactionTitle(tx: AggregatedTransaction): string {
  if (tx.titleOverride) return tx.titleOverride
  if (tx.direction === 'in') return 'Received payment'
  const sourceTitle = paymentSourceTitle(tx.source)
  if (sourceTitle && tx.agentName) return `${sourceTitle} by ${tx.agentName}`
  if (sourceTitle) return sourceTitle
  if (tx.agentName) return `Agent payment by ${tx.agentName}`
  return 'Payment sent by you'
}

function transactionAmount(tx: AggregatedTransaction): string {
  const sign = tx.direction === 'in' ? '+' : '-'
  return `${sign}${tx.valueFormatted} ${tx.asset}`
}

function transactionMovement(
  tx: AggregatedTransaction,
  resolveAddress?: (address: string) => string | null,
  safeNamesByAddress?: Map<string, string>,
): ReactNode {
  if (tx.movementOverride) return tx.movementOverride
  const counterparty = counterpartyLabel(tx, resolveAddress, safeNamesByAddress)
  const from = tx.direction === 'in' ? counterparty : tx.safeName
  const to = tx.direction === 'in' ? tx.safeName : counterparty

  return <TransactionMovement from={from} to={to} />
}

function counterpartyLabel(
  tx: AggregatedTransaction,
  resolveAddress?: (address: string) => string | null,
  safeNamesByAddress?: Map<string, string>,
): string {
  if (isMachinePaymentSource(tx.source)) {
    return parseX402Hostname(tx.x402ResourceUrl) ?? truncate(tx.to)
  }

  const address = tx.direction === 'in' ? tx.from : tx.to
  const safeName = safeNamesByAddress?.get(address.toLowerCase())
  const contactName = resolveAddress?.(address)

  return safeName ?? contactName ?? truncate(address)
}
