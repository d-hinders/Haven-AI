'use client'

/**
 * Table — the semantic data-table chrome (#857, epic #859), extracted from
 * the transactions table so every list surface shares one header band, one
 * row-border rule, and one accessible sort control.
 *
 * The primitive owns CHROME: the `--v2-table-*` tokens, the sticky header
 * mechanics, `aria-sort` + focus-ring sort buttons, and the established
 * `hidden md:table-cell` responsive-collapse pattern. Cell CONTENT (td
 * markup, sorting logic, data fetching) stays with the caller.
 *
 *   <Table>
 *     <Table.Head sticky>
 *       <tr>
 *         <Table.HeaderCell srLabel="Direction" className="w-9" />
 *         <Table.HeaderCell align="left">Activity</Table.HeaderCell>
 *         <Table.SortableHeaderCell label="Date" direction="desc" onSort={…} hideBelowMd />
 *       </tr>
 *     </Table.Head>
 *     <Table.Body>…rows with plain <td>s…</Table.Body>
 *   </Table>
 */

import type { ReactNode, ThHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'
import { Icon } from './Icon'
import { Tooltip } from './Tooltip'

// Tokenized header band — one look across every table surface.
// The 11px uppercase band predates the type ramp; it is the table-header
// exception and lives here ONLY. design-lint-disable-line
const TH_BASE =
  'bg-[var(--v2-table-header-bg)] border-b border-[var(--v2-table-row-border)] text-[11px] uppercase tracking-wide text-[var(--v2-table-header-ink)] px-4 py-3 font-medium' // design-lint-disable-line

// Sticky compensation for <main>'s p-6/lg:p-8 padding so a pinned header
// sits flush against the TopBar. thead pins at z-10, cells at z-20.
const STICKY_HEAD = 'sticky -top-6 lg:-top-8 z-10'
const STICKY_CELL = 'sticky -top-6 lg:-top-8 z-20'

export function Table({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <table className={`w-full border-separate border-spacing-0 ${className}`.trim()}>{children}</table>
}

function Head({
  children,
  sticky = false,
  collapseBelowMd = true,
  className = '',
}: {
  children: ReactNode
  /** Pin the header while the page scrolls (dedicated table routes). */
  sticky?: boolean
  /**
   * Headers collapse below md by default — mobile rows carry their own
   * labels. Pass `false` for dense admin tables whose rows don't (pair the
   * table with an `overflow-x-auto` wrapper so mobile scrolls horizontally).
   *
   * ⚠️ The `overflow-x-auto` wrapper and `sticky` are MUTUALLY EXCLUSIVE
   * (#1772). `overflow-x: auto` forces the computed `overflow-y` to `auto`
   * too, which makes the wrapper the sticky scroll ancestor — the pinned
   * header then sticks to a box that never scrolls vertically, i.e. it stops
   * pinning. Measured on `/transactions`: thead held at y=56 while scrolling
   * without the wrapper, scrolled off to y=-303 with it.
   *
   * So a collapsing table (`collapseBelowMd` left true, usually `sticky`) has
   * to FIT rather than scroll. If it overflows at 393px, the cause is almost
   * always a `truncate`d cell: `truncate` is `white-space: nowrap`, and an
   * auto-layout column can never be narrower than its min-content, so the
   * untruncated text widens the table instead of ellipsising. Put `max-w-0`
   * on the one flexible cell — a cell `max-width` IS allowed below
   * min-content — and the `truncate` starts working.
   */
  collapseBelowMd?: boolean
  className?: string
}) {
  return (
    <thead
      className={`${collapseBelowMd ? 'hidden md:table-header-group' : 'table-header-group'} ${sticky ? STICKY_HEAD : ''} ${className}`.trim()}
    >
      {children}
    </thead>
  )
}

interface HeaderCellProps extends ThHTMLAttributes<HTMLTableCellElement> {
  children?: ReactNode
  /** Accessible name for icon/blank columns (renders visually hidden). */
  srLabel?: string
  align?: 'left' | 'right'
  /** Follow the responsive-collapse pattern: hidden below md. */
  hideBelowMd?: boolean
  sticky?: boolean
}

function HeaderCell({
  children,
  srLabel,
  align,
  hideBelowMd = false,
  sticky = false,
  className = '',
  ...rest
}: HeaderCellProps) {
  const alignClass = align === 'right' ? 'text-right' : align === 'left' ? 'text-left' : ''
  return (
    <th
      scope="col"
      className={`${TH_BASE} ${sticky ? STICKY_CELL : ''} ${alignClass} ${
        hideBelowMd ? 'hidden md:table-cell' : ''
      } ${className}`.trim()}
      {...rest}
    >
      {srLabel ? <span className="sr-only">{srLabel}</span> : null}
      {children}
    </th>
  )
}

export type SortDirection = 'asc' | 'desc' | null

function SortableHeaderCell({
  label,
  direction,
  onSort,
  tooltip,
  align = 'left',
  hideBelowMd = false,
  sticky = false,
  className = '',
}: {
  label: string
  /** `null` = this column is not the active sort. */
  direction: SortDirection
  onSort: () => void
  /** Optional hover explanation (e.g. what set the sort operates on). */
  tooltip?: string
  align?: 'left' | 'right'
  hideBelowMd?: boolean
  sticky?: boolean
  className?: string
}) {
  const active = direction !== null
  const ariaSort: 'ascending' | 'descending' | 'none' =
    direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'
  const directionWord = direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'unsorted'
  const button = (
    <button
      type="button"
      onClick={onSort}
      aria-label={`Sort by ${label}, currently ${directionWord}`}
      className={`inline-flex items-center gap-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-1 ${
        align === 'right' ? 'w-full justify-end' : ''
      }`.trim()}
    >
      {label}
      <Icon
        icon={ChevronDown}
        className={`ml-1 inline-block h-3 w-3 flex-shrink-0 transition-transform ${
          active ? 'opacity-100' : 'opacity-30'
        } ${direction === 'asc' ? 'rotate-180' : ''}`}
      />
    </button>
  )
  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className={`${TH_BASE} ${sticky ? STICKY_CELL : ''} ${align === 'right' ? 'text-right' : 'text-left'} ${
        hideBelowMd ? 'hidden md:table-cell' : ''
      } ${className}`.trim()}
    >
      {tooltip ? (
        <Tooltip label={tooltip} side="bottom">
          {button}
        </Tooltip>
      ) : (
        button
      )}
    </th>
  )
}

function Body({ children, className = '' }: { children: ReactNode; className?: string }) {
  // One row-border rule: every td bottom-hairlined, last row open.
  return (
    <tbody
      className={`[&>tr>td]:border-b [&>tr>td]:border-[var(--v2-table-row-border)] [&>tr:last-child>td]:border-b-0 ${className}`.trim()}
    >
      {children}
    </tbody>
  )
}

Table.Head = Head
Table.HeaderCell = HeaderCell
Table.SortableHeaderCell = SortableHeaderCell
Table.Body = Body
