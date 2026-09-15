'use client'

import Link from 'next/link'
import { useState } from 'react'
import {
  formatAnalyticsAmount,
  formatAnalyticsAmountCompact,
  formatAnalyticsDay,
  merchantLabel,
} from '@/lib/analytics-format'
import type { AnalyticsCurrency } from '@/lib/analytics-format'
import { Address } from '@/components/haven/Address'
import { Card } from '@/components/ui/Card'
import { Row } from '@/components/ui/Row'
import { Table, tableColumnClass } from '@/components/ui/Table'
import type { AnalyticsAgentRow, AnalyticsMerchantRow } from '@/types/analytics'

/**
 * The top merchants table (#2949, epic #2944 slice E).
 *
 * One row per merchant the account's agents paid most in the range, in the
 * order the endpoint already sent them: `GET /analytics/overview` returns
 * `merchants` as the top ten by spend, so the table inherits that ranking
 * rather than choosing its own — two orders would be two answers to "who got
 * the most". Every column is one field on one merchant row; the table
 * computes nothing about the money, and it never re-resolves a label.
 * `merchants[].label` is already the API's own resolution (contact name, else
 * the receipt's merchant name, else the address), and a second resolution
 * here would be a second place the same merchant can be named two different
 * ways. What the table does with a label that is still an address is display
 * only, through the one `lib/analytics-format.merchantLabel` rule the agents
 * table shares — the two tables cannot disagree about how an unresolved
 * address reads, because neither owns a private version of it.
 *
 * The money fields arrive as numeric STRINGS (`spent`, and every other fiat
 * field on this response, #2946). They are handed to the shared formatters
 * as strings and nowhere re-typed; `payments` is a number and is printed as
 * one. `MerchantsTable.test.tsx` pins both halves of that against the
 * capture harness's own fixture.
 *
 * ── Why there are two renderings ────────────────────────────────────────────
 *
 * The split `AgentsTable` documents and ships: below `lg` there is no width
 * for seven columns, and the collapse primitive inside `Table` would keep two
 * or three of them and drop the rest — silently deleting the figures the row
 * exists to show. So below `lg` the table leaves the layout entirely and the
 * same rows render through the `Row` list, which keeps WHO, SPEND and
 * PAYMENTS on the face of every row and carries what the table would have
 * hidden — address, paying agents, first and last seen — in a disclosure
 * that opens. The pair is complements by construction: one container carries
 * `hidden lg:block`, the other `lg:hidden`, the same `lg:` prefix once with
 * `hidden` and once without, so exactly one is displayed at any width
 * (#2928's rule; the test pins both halves).
 *
 * ── The link target, stated once because the test states it too ───────────
 *
 * The issue's rule is `/transactions?merchant=<address>` when that filter
 * exists there, else `/transactions`. The filter does not exist:
 * `TransactionsClient` seeds its filters from the `accountId`, `agentId`,
 * `tokenKey` and `direction` search parameters alone, and no `merchant`
 * parameter is read anywhere on that page. So the target is the plain
 * `/transactions`. A URL carrying a parameter the page ignores would look
 * filtered while showing everything, which is the one thing the issue
 * forbids ("the row never links somewhere that shows something else"). When
 * the filter lands, `MERCHANT_FILTER_BASE` is the single line that changes,
 * and `MERCHANTS_LINK_TARGET` carries the rule the test reads.
 */

const COLUMN_PAD = 'px-4 py-3'

/** See the header: the plain history route is the target until the merchant
 *  filter exists on `/transactions`. */
const MERCHANT_FILTER_BASE = '/transactions'

/** The roster cap the desktop column and the mobile disclosure both honour:
 *  three paying agents named, the rest counted ("and N more"). Three is the
 *  issue's number, not this component's opinion of it. */
const MAX_AGENT_NAMES = 3

/** The roster the `agent_ids` of a merchant row are looked up in: the SAME
 *  response's `agents` array, keyed by id. An id the roster does not name
 *  renders as the raw id — the endpoint draws both arrays from one query, so
 *  an unknown id means the response disagreed with itself, and an invented
 *  name would hide the disagreement. */
function agentNamesFor(agentIds: string[], roster: Map<string, string>): {
  names: string[]
  total: number
} {
  return {
    names: agentIds.slice(0, MAX_AGENT_NAMES).map((id) => roster.get(id) ?? id),
    total: agentIds.length,
  }
}

function rosterLine(names: string[], total: number): string {
  if (total === 0) return 'No paying agents reported'
  const rest = total - names.length
  return rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(', ')
}

function PayingAgentsCell({ names, total }: { names: string[]; total: number }) {
  return <span className="text-sm text-[var(--v2-ink-2)]">{rosterLine(names, total)}</span>
}

/**
 * The "first/last seen" cell. Day granularity is the right unit here: first
 * and last seen answer when this relationship began and ended, which is a
 * question about days, and — unlike the relative "3d ago" of the agents
 * table's last-payment cell — an absolute day label reads identically on the
 * day the capture is taken, which is why the fixture's dates are absolute.
 * The full timestamp rides in the title for whoever needs the instant.
 */
function SeenCell({ iso }: { iso: string }) {
  return (
    <span className="v2-tabular text-sm text-[var(--v2-ink-2)]" title={new Date(iso).toLocaleString()}>
      {formatAnalyticsDay(iso.slice(0, 10))}
    </span>
  )
}

/** The label half of the row. An address-valued label is the API saying it
 *  found no contact and no receipt name behind the address; it goes through
 *  the shared truncation rule, reads in tabular figures so two rows'
 *  addresses do not jitter against each other, and keeps the whole string in
 *  the title. A resolved name keeps its own characters and spacing, and gets
 *  no title. */
function LabelCell({ merchant }: { merchant: AnalyticsMerchantRow }) {
  const { value, title } = merchantLabel(merchant.label)
  return (
    <span
      className={`text-sm font-medium text-[var(--v2-ink)]${title ? ' v2-tabular' : ''}`}
      title={title}
    >
      {value}
    </span>
  )
}

export function MerchantsTable({
  merchants,
  agents,
  currency,
}: {
  merchants: AnalyticsMerchantRow[]
  /** The response's own `agents` array, read only to turn the ids in
   *  `agent_ids` into the names the reader already met in the agents table.
   *  It is not re-sorted, re-filtered, or used to derive a figure. */
  agents: AnalyticsAgentRow[]
  currency: AnalyticsCurrency
}) {
  const roster = new Map(agents.map((agent) => [agent.id, agent.name] as const))

  return (
    <Card hover={false} className="overflow-hidden">
      <Card.Header
        as="h2"
        title="Top merchants"
        description="The recipients your agents paid most in this range, ranked by spent."
      />

      <div className="hidden lg:block">
        <Table>
          <Table.Head collapseWhenNarrow={false}>
            <tr>
              <Table.HeaderCell align="left">Merchant</Table.HeaderCell>
              <Table.HeaderCell align="left">Address</Table.HeaderCell>
              <Table.HeaderCell align="right">Spent</Table.HeaderCell>
              <Table.HeaderCell align="right">Payments</Table.HeaderCell>
              <Table.HeaderCell align="left" revealAt="xl">
                Paying agents
              </Table.HeaderCell>
              <Table.HeaderCell align="left">First seen</Table.HeaderCell>
              <Table.HeaderCell align="left">Last seen</Table.HeaderCell>
            </tr>
          </Table.Head>
          <Table.Body>
            {merchants.map((merchant) => {
              const { names, total } = agentNamesFor(merchant.agent_ids, roster)
              return (
                <tr
                  key={merchant.address}
                  className="hover:bg-[var(--v2-surface-hover)] transition-colors duration-150"
                >
                  <td className={COLUMN_PAD}>
                    <Link
                      href={MERCHANT_FILTER_BASE}
                      className="inline-flex min-w-0 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
                    >
                      <LabelCell merchant={merchant} />
                    </Link>
                  </td>
                  <td className={COLUMN_PAD}>
                    <Address value={merchant.address} className="text-xs text-[var(--v2-ink-2)]" />
                  </td>
                  <td className={`${COLUMN_PAD} text-right`}>
                    <span className="v2-tabular text-sm font-medium text-[var(--v2-ink)]">
                      {formatAnalyticsAmount(merchant.spent, currency)}
                    </span>
                  </td>
                  <td className={`${COLUMN_PAD} text-right`}>
                    <span className="v2-tabular text-sm text-[var(--v2-ink-2)]">{merchant.payments}</span>
                  </td>
                  <td className={`${COLUMN_PAD} ${tableColumnClass('xl')}`}>
                    <PayingAgentsCell names={names} total={total} />
                  </td>
                  <td className={COLUMN_PAD}>
                    <SeenCell iso={merchant.first_seen} />
                  </td>
                  <td className={COLUMN_PAD}>
                    <SeenCell iso={merchant.last_seen} />
                  </td>
                </tr>
              )
            })}
          </Table.Body>
        </Table>
      </div>

      <div className="lg:hidden divide-y divide-[var(--v2-table-row-border)]">
        {merchants.map((merchant) => (
          <MobileMerchantRow
            key={merchant.address}
            merchant={merchant}
            roster={roster}
            currency={currency}
          />
        ))}
      </div>
    </Card>
  )
}

/**
 * One merchant, at a phone: who and how much on the face of the row, the rest
 * in the disclosure. Who/SPENT/PAYMENTS are the three a reader at a bus stop
 * asks about. The disclosure is where the table's remaining columns went, and
 * every line in it is the same field the desktop table renders — the pair is
 * one data set in two layouts, not two sources that can fall apart.
 */
function MobileMerchantRow({
  merchant,
  roster,
  currency,
}: {
  merchant: AnalyticsMerchantRow
  roster: Map<string, string>
  currency: AnalyticsCurrency
}) {
  const [open, setOpen] = useState(false)
  const { names, total } = agentNamesFor(merchant.agent_ids, roster)
  const label = merchantLabel(merchant.label)

  return (
    <div className="px-4 py-3">
      <Row
        title={
          <span
            className={`truncate ${label.title ? 'v2-tabular' : ''}`}
            title={label.title}
          >
            {label.value}
          </span>
        }
        subtitle={
          <span className="v2-tabular">
            {formatAnalyticsAmountCompact(merchant.spent, currency)} spent · {merchant.payments}{' '}
            payment{merchant.payments === 1 ? '' : 's'}
          </span>
        }
        trailing={
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="rounded px-1 py-0.5 text-xs font-medium text-[var(--v2-brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
          >
            {open ? 'Hide' : 'More'}
          </button>
        }
        className="px-0 py-0"
      />
      {open && (
        <dl className="mt-2 space-y-1.5 rounded-md bg-[var(--v2-surface)] p-3 text-xs">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-[var(--v2-ink-3)]">Address</dt>
            <dd className="text-right">
              <Address value={merchant.address} className="text-[var(--v2-ink)]" />
            </dd>
          </div>
          <DisclosureLine term="Paying agents" value={rosterLine(names, total)} />
          <DisclosureLine
            term="First seen"
            value={formatAnalyticsDay(merchant.first_seen.slice(0, 10))}
            title={new Date(merchant.first_seen).toLocaleString()}
          />
          <DisclosureLine
            term="Last seen"
            value={formatAnalyticsDay(merchant.last_seen.slice(0, 10))}
            title={new Date(merchant.last_seen).toLocaleString()}
          />
        </dl>
      )}
      <Link
        href={MERCHANT_FILTER_BASE}
        className="mt-2 inline-block rounded text-xs font-medium text-[var(--v2-brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
      >
        View in transactions
      </Link>
    </div>
  )
}

/** The same three-line disclosure shape the agents table's mobile rows use.
 *  Written locally rather than exported across: the two tables are siblings,
 *  not a shared primitive, and `design-system-coupling` rightly declines to
 *  let either one masquerade as one — this is a definition list of three
 *  markup lines, not a component. */
function DisclosureLine({ term, value, title }: { term: string; value: string; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[var(--v2-ink-3)]">{term}</dt>
      <dd className="v2-tabular text-right text-[var(--v2-ink)]" title={title}>
        {value}
      </dd>
    </div>
  )
}

/** The link-target rule the test reads instead of re-stating the constant:
 *  when `/transactions` gains a `merchant` filter, this becomes a function of
 *  the address and the test follows it. */
export const MERCHANTS_LINK_TARGET = MERCHANT_FILTER_BASE

export default MerchantsTable
