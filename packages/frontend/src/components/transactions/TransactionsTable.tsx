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
import { Table, tableColumnClass, tableHideFromClass } from '@/components/ui/Table'
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
      <td key={key} className={`w-9 px-2 ${padY} md:px-4`}>
        <Skeleton className="h-9 w-9 rounded-[10px]" />
      </td>
    ),
    activity: (key) => (
      // `max-w-0` for the same reason as the real activity cell below (#1772),
      // and the skeletons cap at the cell rather than at a fixed 160/224px —
      // a 224px bar inside a ~109px cell is the loading state's own overflow.
      <td key={key} className={`max-w-0 px-4 ${padY}`}>
        <div className="space-y-1.5">
          <Skeleton variant="text" className="h-3 w-40 max-w-full" />
          <Skeleton variant="text" className="h-2 w-56 max-w-full" />
        </div>
      </td>
    ),
    initiator: (key) => (
      <td key={key} className={`px-4 ${padY} ${tableColumnClass('md')}`}>
        <Skeleton variant="text" className="h-2 w-20" />
      </td>
    ),
    fromTo: (key) => (
      <td key={key} className={`px-4 ${padY} ${tableColumnClass('md')}`}>
        <Skeleton variant="text" className="h-2 w-28" />
      </td>
    ),
    date: (key) => (
      <td key={key} className={`px-4 ${padY} ${tableColumnClass('md')}`}>
        <Skeleton variant="text" className="h-2 w-14" />
      </td>
    ),
    amount: (key) => (
      <td key={key} className={`px-2 ${padY} text-right md:px-4`}>
        <Skeleton className="h-4 w-20 ml-auto" />
      </td>
    ),
    link: (key) => (
      <td key={key} className={`w-8 px-2 ${padY} text-center md:px-4`}>
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
            <Table.HeaderCell sticky={isSticky} align="left" revealAt="md" className="w-[120px]">
              Initiator
            </Table.HeaderCell>
          ) : null}
          {showCol('fromTo') ? (
            <Table.HeaderCell sticky={isSticky} align="left" revealAt="md" className="w-[140px]">
              From / To
            </Table.HeaderCell>
          ) : null}
          {showCol('date') ? (
            <Table.SortableHeaderCell
              label="Date"
              direction={directionOf('date')}
              onSort={() => handleSort('date')}
              tooltip={sortTooltip}
              revealAt="md"
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
                  // Narrower gutter below md (#1772): `px-4` spent 32px of a
                  // 343px row on padding around a 36px icon, and every pixel
                  // here comes straight out of the activity column, which is
                  // the only one that can flex.
                  <td className={`w-9 px-2 ${padY} text-center md:px-4`}>
                    <DirectionMark direction={tx.direction} />
                  </td>
                ) : null}

                {showCol('activity') ? (
                  // `max-w-0` is what makes the `truncate` below actually
                  // truncate (#1772). In an auto-layout table a column can
                  // never be narrower than its MIN-CONTENT width, and
                  // `truncate` sets `white-space: nowrap` — so the untruncated
                  // title measured 257px of min-content and simply widened the
                  // table instead of ellipsising. Measured at 393px: the table
                  // rendered 462px wide inside a 343px card, overflowing
                  // `<main>` by 94px locally / 106px on CI. A `max-width` on a
                  // cell IS allowed to sit below min-content, so this is the
                  // idiom that lets the flexible column absorb the leftover
                  // width and ellipsise. It is the ONLY flexible column here;
                  // every other one is fixed-width or on the `md` container stage.
                  //
                  // Deliberately NOT an `overflow-x-auto` wrapper (the fix the
                  // issue guessed at): `overflow-x: auto` forces `overflow-y`
                  // to `auto` as well, which makes the wrapper the sticky
                  // scroll ancestor and unpins `Table.Head sticky` on desktop.
                  // Measured — thead pinned at y=56 while scrolling before,
                  // scrolled off to y=-303 after.
                  <td className={`max-w-0 px-4 ${padY}`}>
                    {/* `flex-wrap` so a status badge drops BELOW the title
                        instead of competing with it for a ~141px line — a
                        failed row used to ellipsise all the way down to
                        "Age…" next to its Failed badge. `title` carries the
                        untruncated string for the two `variant="card"` call
                        sites (agent detail, account detail) that render
                        non-selectable rows: on `/transactions` the row is a
                        button whose `aria-label` already holds it, but there
                        the truncation would otherwise be unrecoverable. */}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p
                        className="w-full break-words text-sm font-medium text-[var(--v2-ink)] md:min-w-0 md:flex-1 md:truncate"
                        title={transactionTitle(tx)}
                      >
                        {transactionTitle(tx)}
                      </p>
                      {statusBadge ? (
                        <StatusBadge tone={statusBadge.tone}>{statusBadge.label}</StatusBadge>
                      ) : tx.isError ? (
                        <StatusBadge tone="danger">Failed</StatusBadge>
                      ) : null}
                    </div>
                    {showCol('fromTo') ? (
                      <div className={`mt-0.5 text-xs text-[var(--v2-ink-2)] ${tableHideFromClass('md')}`}>
                        {movement}
                      </div>
                    ) : null}
                  </td>
                ) : null}

                {showCol('initiator') ? (
                  <td className={`${tableColumnClass('md')} w-[120px] px-4 ${padY}`}>
                    <span className="text-xs text-[var(--v2-ink-2)] truncate block">{initiator}</span>
                  </td>
                ) : null}

                {showCol('fromTo') ? (
                  <td className={`${tableColumnClass('md')} w-[140px] px-4 ${padY}`}>
                    <span className="text-xs text-[var(--v2-ink-2)] truncate block">{movement}</span>
                  </td>
                ) : null}

                {showCol('date') ? (
                  <td className={`${tableColumnClass('md')} w-[90px] px-4 ${padY} whitespace-nowrap`}>
                    <span className="v2-tabular text-xs text-[var(--v2-ink-3)]">
                      {timeAgo(tx.timestamp * 1000)}
                    </span>
                  </td>
                ) : null}

                {showCol('amount') ? (
                  // Same narrower gutter below md (#1772). Here it does not
                  // widen the activity column — the width is fixed — it gives
                  // the amount itself 94px of content box instead of 78, which
                  // is the difference between "-25.00 USDC" on one line and
                  // wrapped onto two.
                  <td className={`w-[110px] px-2 ${padY} text-right md:px-4`}>
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
                    className={`w-8 px-2 ${padY} text-center md:px-4`}
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
