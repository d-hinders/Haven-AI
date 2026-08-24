'use client'

/**
 * Table — the semantic data-table chrome (#857, epic #859), extracted from
 * the transactions table so every list surface shares one header band, one
 * row-border rule, and one accessible sort control.
 *
 * The primitive owns CHROME: the `--v2-table-*` tokens, the sticky header
 * mechanics, `aria-sort` + focus-ring sort buttons, and the responsive
 * column-collapse pattern. Cell CONTENT (td markup, sorting logic, data
 * fetching) stays with the caller.
 *
 *   <Table>
 *     <Table.Head sticky>
 *       <tr>
 *         <Table.HeaderCell srLabel="Direction" className="w-9" />
 *         <Table.HeaderCell align="left">Activity</Table.HeaderCell>
 *         <Table.SortableHeaderCell label="Date" direction="desc" onSort={…} revealAt="md" />
 *       </tr>
 *     </Table.Head>
 *     <Table.Body>…rows with plain <td>s, carrying tableColumnClass(stage)…</Table.Body>
 *   </Table>
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE COLLAPSE IS KEYED ON THE TABLE'S CONTAINER, NOT THE VIEWPORT (#1999).
 *
 * `hideBelowMd` used to emit `hidden md:table-cell` — a VIEWPORT query — and
 * the variable that decides whether a column fits is the width of the box the
 * table is in. On this app shell the two diverge sharply, because TWO things
 * step at `lg` and both take width: `Sidebar.tsx` goes `fixed` -> `lg:static`
 * at `w-[240px]` (border-box, its 1px `border-r` included), AND the
 * authenticated layout's `main` steps `p-6` -> `lg:p-8`, 16px more across the
 * pair. 256px is handed back in one breakpoint, so the content available to a
 * table is a SAWTOOTH in viewport width, not a ramp. MEASURED in real
 * Chromium on `/design-system`, `/transactions`, `/accounts/:id` and
 * `/agents/:id` — the same four numbers on all four, because they share the
 * shell:
 *
 *     viewport   390   767   768   900   1023  1024  1279  1280
 *     container  340   717   718   850   973   718   973   974
 *
 * A table is exactly as cramped at 1024 as it is at 768. `md:` therefore made
 * the reveal decision against the wrong number twice, which is #1827.
 *
 * So the stages are container queries. `Table` puts a named inline-size
 * container on its wrapper and the two stages are:
 *
 *     'md'  container >= 718px
 *     'xl'  container >= 974px
 *
 * Those two NUMBERS are the container widths at the shell's own `md` and `xl`
 * teeth (see the table above), chosen so this is a change of VARIABLE and not
 * a change of RENDERING: every consumer renders byte-identically at every
 * width measured. What changes is that they now stay right if the sidebar or
 * the page padding ever moves — and that the sawtooth stops having to be
 * rediscovered per table. The names are kept familiar on purpose; the numbers
 * are what is asserted, in `e2e/table-container-collapse.spec.ts`, by
 * resizing the CONTAINER at a fixed viewport.
 *
 * ⚠️ HEADER AND BODY MUST BE CONVERTED TOGETHER. A `<th>` on a container
 * stage over `<td>`s on a viewport variant is the #1774 failure one layer
 * down: width declarations on a `display: none` cell take no part in column
 * sizing, and the result measures byte-identical to a fix. Use
 * `tableColumnClass(stage)` on the `<td>`, never a hand-written variant.
 *
 * What is deliberately NOT container-keyed, so the next reader does not
 * "finish the job" wrongly:
 *   - `STICKY_HEAD`/`STICKY_CELL`'s `-top-6 lg:-top-8`. That compensates
 *     `main`'s OWN padding step, which is genuinely a viewport thing.
 *   - Cell gutters (`px-2 md:px-4`) and width/wrap switches in consumers.
 *     They are cell padding and sizing, not column PRESENCE: a disagreement
 *     there tightens a cell, it does not delete a column's width from the
 *     layout. They are left viewport-keyed rather than multiplying this diff
 *     across a showcase full of separately measured decisions — and on
 *     today's shell they cannot disagree, since 718 <-> 768/1024 and
 *     974 <-> 1280 exactly.
 * ─────────────────────────────────────────────────────────────────────────
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

/**
 * The inline-size container the stages below query. Named (`v2table`) rather
 * than anonymous so a nested table cannot capture an outer table's stage.
 *
 * Written as Tailwind arbitrary properties/variants rather than through
 * `@tailwindcss/container-queries`: the plugin is not installed, `plugins` is
 * `[]`, and this needs no dependency or lockfile change to emit exactly the
 * same CSS (verified against the compiled stylesheet, not assumed).
 */
const TABLE_CONTAINER = '[container-type:inline-size] [container-name:v2table]'

/** The two container stages. See the docstring above for the measurements. */
export type ColumnStage = 'md' | 'xl'

/**
 * ⚠️ The trailing `@supports not` variant is the fallback, and it is not
 * decoration. Container queries are Baseline (Chrome 105 / Safari 16 /
 * Firefox 110, all 2022–23) and nothing else in this codebase reaches for a
 * newer CSS feature — but the failure mode without a fallback is silent and
 * total, not graceful: a browser that cannot parse `@container` keeps the
 * base `hidden` and NEVER reveals the column, at any width. So the old
 * viewport breakpoints are re-stated inside `@supports not
 * (container-type: inline-size)`, which is dead code in every browser that
 * understands the query and the previous behaviour in every one that does
 * not. It cannot conflict with the container rule: exactly one of the two
 * blocks is live in any given browser.
 */
const STAGE_REVEAL: Record<ColumnStage, string> = {
  md: 'hidden [@container_v2table_(min-width:718px)]:table-cell md:[@supports_not_(container-type:inline-size)]:table-cell',
  xl: 'hidden [@container_v2table_(min-width:974px)]:table-cell xl:[@supports_not_(container-type:inline-size)]:table-cell',
}

const STAGE_HIDE: Record<ColumnStage, string> = {
  md: '[@container_v2table_(min-width:718px)]:hidden md:[@supports_not_(container-type:inline-size)]:hidden',
  xl: '[@container_v2table_(min-width:974px)]:hidden xl:[@supports_not_(container-type:inline-size)]:hidden',
}

/**
 * The class a `<td>` must carry when its `<th>` uses `revealAt={stage}`.
 *
 * This exists so header and body cannot drift apart (#1774/#1999) — the
 * header cell and the body cell read the SAME constant.
 */
export function tableColumnClass(stage: ColumnStage): string {
  return STAGE_REVEAL[stage]
}

/**
 * The inverse: content that RIDES somewhere else while its own column is
 * collapsed, and must disappear once that column comes back (the movement
 * line under a mobile title, the date under the Amount). Keyed on the same
 * container stage as the column it stands in for — a viewport variant here
 * would reintroduce the split this fix removes, one element over.
 */
export function tableHideFromClass(stage: ColumnStage): string {
  return STAGE_HIDE[stage]
}

export function Table({
  children,
  className = '',
  scrollable = false,
}: {
  children: ReactNode
  className?: string
  /**
   * This table is paired with an `overflow-x-auto` wrapper and is meant to
   * SCROLL rather than fit (the dense-admin shape `Table.Head`'s
   * `collapseWhenNarrow={false}` goes with). Suppresses the inline-size
   * container: containment sizes the wrapper from its own containing block
   * and ignores its contents, so a table that must be allowed to grow past
   * the wrapper should not get one. Such tables have no collapsing columns to
   * key anyway.
   */
  scrollable?: boolean
}) {
  const table = <table className={`w-full border-separate border-spacing-0 ${className}`.trim()}>{children}</table>
  if (scrollable) return table
  return <div className={TABLE_CONTAINER}>{table}</div>
}

function Head({
  children,
  sticky = false,
  collapseWhenNarrow = true,
  className = '',
}: {
  children: ReactNode
  /** Pin the header while the page scrolls (dedicated table routes). */
  sticky?: boolean
  /**
   * The header row collapses while the table's CONTAINER is below the `md`
   * stage (718px) by default — narrow rows carry their own labels. Pass
   * `false` for dense admin tables whose rows don't (pair the table with an
   * `overflow-x-auto` wrapper AND `<Table scrollable>` so it scrolls).
   *
   * ⚠️ The `overflow-x-auto` wrapper and `sticky` are MUTUALLY EXCLUSIVE
   * (#1772). `overflow-x: auto` forces the computed `overflow-y` to `auto`
   * too, which makes the wrapper the sticky scroll ancestor — the pinned
   * header then sticks to a box that never scrolls vertically, i.e. it stops
   * pinning. Measured on `/transactions`: thead held at y=56 while scrolling
   * without the wrapper, scrolled off to y=-303 with it.
   *
   * So a collapsing table (`collapseWhenNarrow` left true, usually `sticky`) has
   * to FIT rather than scroll. If it overflows at 393px, the cause is almost
   * always a `truncate`d cell: `truncate` is `white-space: nowrap`, and an
   * auto-layout column can never be narrower than its min-content, so the
   * untruncated text widens the table instead of ellipsising. Put `max-w-0`
   * on the one flexible cell — a cell `max-width` IS allowed below
   * min-content — and the `truncate` starts working.
   */
  collapseWhenNarrow?: boolean
  className?: string
}) {
  return (
    <thead
      className={`${
        collapseWhenNarrow
          ? 'hidden [@container_v2table_(min-width:718px)]:table-header-group md:[@supports_not_(container-type:inline-size)]:table-header-group'
          : 'table-header-group'
      } ${sticky ? STICKY_HEAD : ''} ${className}`.trim()}
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
  /**
   * Collapse this column until the TABLE'S CONTAINER reaches the stage's
   * width — `'md'` is 718 container px, `'xl'` is 974 (#1999). The matching
   * `<td>` MUST carry `tableColumnClass(stage)`.
   */
  revealAt?: ColumnStage
  sticky?: boolean
}

function HeaderCell({
  children,
  srLabel,
  align,
  revealAt,
  sticky = false,
  className = '',
  ...rest
}: HeaderCellProps) {
  const alignClass = align === 'right' ? 'text-right' : align === 'left' ? 'text-left' : ''
  return (
    <th
      scope="col"
      className={`${TH_BASE} ${sticky ? STICKY_CELL : ''} ${alignClass} ${
        revealAt ? STAGE_REVEAL[revealAt] : ''
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
  revealAt,
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
  /** See `HeaderCell.revealAt`. The matching `<td>` takes `tableColumnClass`. */
  revealAt?: ColumnStage
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
      className={`inline-flex items-center gap-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 ${
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
        revealAt ? STAGE_REVEAL[revealAt] : ''
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
