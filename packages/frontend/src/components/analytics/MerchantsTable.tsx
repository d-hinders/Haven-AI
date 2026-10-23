'use client'

import Link from 'next/link'
import { useState } from 'react'
import {
  formatAnalyticsAmount,
  formatAnalyticsAmountCompact,
  formatAnalyticsDay,
  lastPaymentCaption,
  unknownRecipientShortAddress,
} from '@/lib/analytics-format'
import type { AnalyticsCurrency } from '@/lib/analytics-format'
import { Card } from '@/components/ui/Card'
import { Row } from '@/components/ui/Row'
import { Tooltip } from '@/components/ui/Tooltip'
import { Address } from '@/components/haven/Address'
import { Table, tableColumnClass } from '@/components/ui/Table'
import type { AnalyticsAgentRow, AnalyticsMerchantRow, AnalyticsRangeValue } from '@/types/analytics'

/**
 * The top merchants table (#2949, epic #2944 slice E; the #4333 rebuild).
 *
 * One row per merchant the account's agents paid most in the range, in the
 * order the endpoint already sent them: `GET /analytics/overview` returns
 * `merchants` as the top ten by spend, so the table inherits that ranking
 * rather than choosing its own — two orders would be two answers to "who got
 * the most". Every column is one field on one merchant row; the table
 * computes nothing about the money, and it never re-resolves a label.
 *
 * ── The columns (#4333) ─────────────────────────────────────────────────────
 *
 * "Paid to" shows the NAME — the API's own resolution (`merchants[].label`,
 * nullable since #4332) — with a KIND line under it: "Your account"
 * (`own_account`), "Paid API" (`x402`), or the short address for an unknown
 * recipient (`kind: 'unknown'`, label null). A contact or receipt name needs
 * no kind line: the name already says what resolved it. The Address COLUMN is
 * gone — an address is metadata, shown in the mobile disclosure and the
 * unknown recipient's tooltip, never as a label. Spent, Payments, "Paid by"
 * as TEXT (the roster line, not a monogram stack — no new pattern), Last
 * paid, and "View in Transactions" linking to the history pre-filtered to
 * that recipient.
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
 * for the columns, and the collapse primitive inside `Table` would keep two
 * or three of them and drop the rest — silently deleting the figures the row
 * exists to show. So below `lg` the table leaves the layout entirely and the
 * same rows render through the `Row` list, which keeps WHO, SPEND and
 * PAYMENTS on the face of every row and carries what the table would have
 * hidden — the kind line, paying agents, last paid — in a disclosure that
 * opens. The pair is complements by construction: one container carries
 * `hidden lg:block`, the other `lg:hidden`, the same `lg:` prefix once with
 * `hidden` and once without, so exactly one is displayed at any width
 * (#2928's rule; the test pins both halves).
 *
 * ── The link target, stated once because the test states it too ───────────
 *
 * `View in Transactions` goes to `/transactions` pre-filtered to the
 * recipient (#4333): `search=<filter_address>` — `search` is the key
 * `parseTransactionFilters` reads (`lib/transaction-filters.ts`), and
 * `filter_address` is the address that page's search matches (the wire's
 * field for exactly this, NOT the group key) — plus `direction=out` and the
 * page's current `period`, and `agentId` when the Agent facet is set. A
 * filtered-looking link that showed everything would be the one thing the
 * issue forbids, so the query is built from the page's own state and the
 * test reads it through `merchantsLinkTarget`.
 */

const COLUMN_PAD = 'px-4 py-3'

/** The roster cap the desktop column and the mobile disclosure both honour:
 *  three paying agents named, the rest counted ("and N more"). Three is the
 *  issue's number, not this component's opinion of it. */
const MAX_AGENT_NAMES = 3

/**
 * The `View in Transactions` target for one merchant row (#4333). Exported
 * for the tests the same way `MERCHANTS_LINK_TARGET` was: the rule lives
 * here, the assertions follow it.
 */
export function merchantsLinkTarget(
  filterAddress: string,
  period: AnalyticsRangeValue,
  agentId: string | null,
): string {
  const params = new URLSearchParams({ search: filterAddress, direction: 'out', period })
  if (agentId !== null) params.set('agentId', agentId)
  return `/transactions?${params.toString()}`
}

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
 * The kind line under "Paid to" (#4333): the naming step that produced the
 * label, in words. `own_account` and `x402` name the KIND of counterparty; an
 * unknown recipient shows the short address there (the address is already
 * metadata the reader can reach in the tooltip — the KIND line is where the
 * issue puts its visible short form). A contact or receipt name needs no
 * line: the name is the whole answer.
 */
function kindLine(merchant: AnalyticsMerchantRow): string | null {
  if (merchant.kind === 'own_account') return 'Your account'
  if (merchant.kind === 'x402') return 'Paid API'
  if (merchant.kind === 'unknown') return unknownRecipientShortAddress(merchant.address)
  return null
}

/** The label half of the row: the name, the kind line under it, and — for an
 *  unknown recipient — the full address in the tooltip. A name is rendered
 *  as-is with no tooltip; there is nothing to elaborate. */
function LabelCell({ merchant }: { merchant: AnalyticsMerchantRow }) {
  const known = merchant.label !== null
  const name = merchant.label ?? 'Unknown recipient'
  const kind = kindLine(merchant)
  return (
    <Tooltip label={known ? name : merchant.address} mono={!known}>
      <span className="inline-flex flex-col">
        <span className={`text-sm font-medium text-[var(--v2-ink)]${known ? '' : ' v2-tabular'}`}>{name}</span>
        {kind && <span className="v2-tabular text-xs text-[var(--v2-ink-3)]">{kind}</span>}
      </span>
    </Tooltip>
  )
}

/** The "last paid" cell — the same relative voice the agents table uses
 *  (`lastPaymentCaption`), so the two tables answer "how recently" in one
 *  dialect; the full instant rides the title. */
function LastPaidCell({ iso }: { iso: string }) {
  return (
    <span className="v2-tabular text-sm text-[var(--v2-ink-2)]" title={new Date(iso).toLocaleString()}>
      {lastPaymentCaption(iso)}
    </span>
  )
}

export function MerchantsTable({
  merchants,
  agents,
  currency,
  period,
  agentId = null,
}: {
  merchants: AnalyticsMerchantRow[]
  /** The response's own `agents` array, read only to turn the ids in
   *  `agent_ids` into the names the reader already met in the agents table.
   *  It is not re-sorted, re-filtered, or used to derive a figure. */
  agents: AnalyticsAgentRow[]
  currency: AnalyticsCurrency
  /** The page's current window, carried onto the link's `period` key. */
  period: AnalyticsRangeValue
  /** The Agent facet's selection, carried onto the link when set. */
  agentId?: string | null
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
              <Table.HeaderCell align="left">Paid to</Table.HeaderCell>
              <Table.HeaderCell align="right">Spent</Table.HeaderCell>
              <Table.HeaderCell align="right">Payments</Table.HeaderCell>
              <Table.HeaderCell align="left" revealAt="xl">
                Paid by
              </Table.HeaderCell>
              <Table.HeaderCell align="left">Last paid</Table.HeaderCell>
              <Table.HeaderCell align="left" revealAt="xl">
                View in Transactions
              </Table.HeaderCell>
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
                      href={merchantsLinkTarget(merchant.filter_address, period, agentId)}
                      className="inline-flex min-w-0 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
                    >
                      <LabelCell merchant={merchant} />
                    </Link>
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
                    <LastPaidCell iso={merchant.last_seen} />
                  </td>
                  <td className={`${COLUMN_PAD} ${tableColumnClass('xl')}`}>
                    <Link
                      href={merchantsLinkTarget(merchant.filter_address, period, agentId)}
                      className="inline-block text-xs font-medium text-[var(--v2-brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 rounded"
                    >
                      View in Transactions
                    </Link>
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
            period={period}
            agentId={agentId}
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
  period,
  agentId,
}: {
  merchant: AnalyticsMerchantRow
  roster: Map<string, string>
  currency: AnalyticsCurrency
  period: AnalyticsRangeValue
  agentId: string | null
}) {
  const [open, setOpen] = useState(false)
  const { names, total } = agentNamesFor(merchant.agent_ids, roster)
  const known = merchant.label !== null
  const name = merchant.label ?? 'Unknown recipient'
  const kind = kindLine(merchant)

  return (
    <div className="px-4 py-3">
      <Row
        title={
          <Tooltip label={known ? name : merchant.address} mono={!known}>
            <span className={`truncate ${known ? '' : 'v2-tabular'}`}>{name}</span>
          </Tooltip>
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
        density="flush"
      />
      {kind && <p className="v2-tabular mt-0.5 text-xs text-[var(--v2-ink-3)]">{kind}</p>}
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
            term="Last paid"
            value={lastPaymentCaption(merchant.last_seen)}
            title={new Date(merchant.last_seen).toLocaleString()}
          />
        </dl>
      )}
      <Link
        href={merchantsLinkTarget(merchant.filter_address, period, agentId)}
        className="mt-2 inline-block rounded text-xs font-medium text-[var(--v2-brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
      >
        View in Transactions
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

export default MerchantsTable
