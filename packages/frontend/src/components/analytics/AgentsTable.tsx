'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import {
  budgetUsedPercent,
  formatAnalyticsAmount,
  formatAnalyticsAmountCompact,
  formatBudgetTokenValue,
  formatRefusedCount,
  formatSharePercent,
  lastPaymentCaption,
} from '@/lib/analytics-format'
import type { AnalyticsCurrency } from '@/lib/analytics-format'
import { agentStatusPresentation } from '@/lib/payment-status'
import { budgetCaption } from '@/lib/budget-caption'
import { BudgetMeter } from '@/components/haven/BudgetMeter'
import { Card } from '@/components/ui/Card'
import { Monogram } from '@/components/ui/Monogram'
import { Row } from '@/components/ui/Row'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Table, tableColumnClass } from '@/components/ui/Table'
import { Tooltip } from '@/components/ui/Tooltip'
import type { AnalyticsAgentRow } from '@/types/analytics'

/**
 * The agents table (#2947, epic #2944 slice C; the #4333 rebuild).
 *
 * One row per agent the endpoint lists (#3540: every non-revoked agent, plus
 * a revoked one that had activity in range or still holds a budget), in the
 * page's display order —
 * spend descending, then id (`lib/analytics-series.ts`): the wire's
 * `agents[]` carries no ORDER BY, so the page sorts once and every section
 * (this table, the spend chart, the merchants roster) inherits that one order
 * rather than choosing its own (two orders would be two answers to "which
 * agent spent most"). Every column is a field on one agent in the
 * response; the table computes nothing about the money.
 *
 * ── The columns (#4333) ─────────────────────────────────────────────────────
 *
 * Agent (Monogram, name, the revoked badge), Spent with "N% of spend" under
 * it — the former Share column merged into the figure it was a share OF —
 * Payments, Refused as a link to that agent's refused attempts
 * (`/agents/<id>?tab=activity&status=refused`, #4323), Budget (the shared
 * caption helper's meter), Top merchant by name with a merchant monogram (an
 * unresolved one reads "Unknown recipient", the address riding the tooltip —
 * no cell renders a `0x…` AS a label), and Last paid. The WHOLE row links to
 * the agent: the row carries the pointer and the navigation, the Agent cell's
 * `Link` stays the keyboard-reachable half of it.
 *
 * ── Why there are two renderings ────────────────────────────────────────────
 *
 * On desktop this is a `Table`: columns exist to be compared down a column, and
 * the reader's eye travels. Below `lg` there is no width for seven of them, and
 * the collapse primitive inside `Table` would leave two or three columns and
 * drop the rest — silently deleting exactly the figures the row was opened to
 * show. So below `lg` the table is removed from layout entirely and the same
 * rows render through the `Row` list below, which keeps SPEND, REFUSALS and
 * BUDGET visible on every mobile device and carries what the table would have
 * hidden — share, top merchant, payments, last payment — in a disclosure that
 * opens under the row. Two renderings, one row data, no column silently
 * omitted from the screen you are actually on.
 *
 * The gate is `hidden lg:block` against `lg:hidden` on the two containers
 * (the viewport-keyed split the theme row used to carry before #4029). They are complements by construction: the same `lg:` prefix, one
 * with `hidden`, one without, so exactly one is displayed at any width and
 * `AgentsTable.test.tsx` pins both halves of that.
 *
 * Columns the table itself drops (`revealAt="xl"`) are the ones that survive
 * the narrow-desktop case: below a 974px container — the shell's own `xl`
 * tooth — there is not room for seven columns and a sidebar, and losing
 * top merchant first is the choice the primitive's stage ladder already
 * makes for every table in the app (`e2e/table-container-collapse.spec.ts`
 * anchors on it).
 */

const COLUMN_PAD = 'px-4 py-3'

/** The refused-attempts route (#4323): the agent's activity tab, pre-filtered. */
function refusedAttemptsHref(agentId: string): string {
  return `/agents/${agentId}?tab=activity&status=refused`
}

function StatusCell({ agent }: { agent: AnalyticsAgentRow }) {
  const presentation = agentStatusPresentation(agent.status)
  const revoked = agent.status === 'revoked'
  return (
    <span className="inline-flex items-center gap-2 min-w-0">
      <Monogram name={agent.name} size="xs" decorative />
      <span className="truncate text-sm font-medium text-[var(--v2-ink)]">{agent.name}</span>
      {/* A revoked agent stays in the table rather than dropping out of it: it
          had activity in this range, or still holds a budget, and hiding the
          row would hide that. The badge is what says the account is closed. */}
      {revoked && <StatusBadge tone={presentation.tone}>{presentation.label}</StatusBadge>}
    </span>
  )
}

function BudgetCell({ agent }: { agent: AnalyticsAgentRow }) {
  if (agent.budgets.length === 0) {
    return <span className="text-sm text-[var(--v2-ink-3)]">No budget</span>
  }
  return (
    <div className="space-y-2">
      {agent.budgets.map((budget) => {
        // #3806: the caption is the shared helper's. The row projects onto it:
        // the period length is derived from the response's own bounds
        // (period_end − period_start), the anchor is the bounds' start, and
        // there is no `expires_at` on this endpoint — no "expires" branch.
        // #4333 fixed the helper itself: a symbol-only row (chainId null)
        // divides by the SYMBOL's decimals, so a token budget reads in its
        // own units instead of "0.00 of 0.00".
        // #4426: the compact `style: 'row'` caption, as the dashboard agent
        // row and the agent hero use it, and no figure line above the meter —
        // the caption already states "214.00 of 250.00 USDC", and the cell
        // used to print it twice.
        const caption = budgetCaption(
          {
            token: budget.token,
            recipient: budget.recipient,
            startSec: Math.floor(Date.parse(budget.period_start) / 1000),
            periodSeconds: Math.round((Date.parse(budget.period_end) - Date.parse(budget.period_start)) / 1000),
            expiresSec: null,
            budgetAtomic: budget.budget_atomic,
            usedAtomic: budget.used_atomic,
            readFromChain: budget.remaining_from_chain,
            periodEndMs: Date.parse(budget.period_end),
            symbol: budget.token,
            chainId: null,
          },
          { nowMs: Date.now(), style: 'row' },
        )
        return (
          <div key={`${budget.token}:${budget.recipient ?? 'any'}`}>
            {caption.kind === 'meter' ? (
              <BudgetMeter usedPercent={caption.usedPercent} label={caption.label} caption={caption.caption} />
            ) : caption.kind !== 'none' ? (
              // A failed read is not a 0 % bar — the used amount the endpoint
              // reports is a fallback, so the cell says the reading is missing
              // (`UNREAD_CAPTION`) instead of rendering a measurement it does
              // not have. The old "read from Haven's last snapshot" suffix is
              // gone with it. An expired or not-yet-started budget says so in
              // the helper's own words: with no figure line above the meter
              // (#4426) the cell would otherwise be empty.
              <p className="text-xs text-[var(--v2-ink-3)]">{caption.caption}</p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/**
 * The top-merchant cell. `top_merchant.label` is nullable since #4332 (null =
 * nothing resolved — no contact, no receipt name, no x402 host), and #4333
 * renders that as "Unknown recipient": the NAME cell never shows an address.
 * The full address rides the tooltip (elaboration on a truncated form — the
 * one thing a tooltip is for), and the monogram is keyed on the name either
 * way so an unknown keeps a stable tint.
 */
function MerchantCell({ agent }: { agent: AnalyticsAgentRow }) {
  if (agent.top_merchant === null) {
    return <span className="text-sm text-[var(--v2-ink-3)]">None in this range</span>
  }
  const name = agent.top_merchant.label ?? 'Unknown recipient'
  const known = agent.top_merchant.label !== null
  return (
    <Tooltip label={agent.top_merchant.address} mono={!known}>
      <span className={`text-sm text-[var(--v2-ink)]${known ? '' : ' v2-tabular'}`}>{name}</span>
    </Tooltip>
  )
}

export function AgentsTable({
  agents,
  currency,
}: {
  /** In display order — the page sorts once (`orderAgentsForDisplay`). */
  agents: AnalyticsAgentRow[]
  currency: AnalyticsCurrency
}) {
  const router = useRouter()
  return (
    <Card hover={false} className="overflow-hidden">
      <Card.Header as="h2" title="Agents" />

      <div className="hidden lg:block">
        <Table>
          <Table.Head collapseWhenNarrow={false}>
            <tr>
              <Table.HeaderCell align="left">Agent</Table.HeaderCell>
              <Table.HeaderCell align="right">Spent</Table.HeaderCell>
              <Table.HeaderCell align="right">Payments</Table.HeaderCell>
              <Table.HeaderCell align="right">Refused</Table.HeaderCell>
              <Table.HeaderCell align="left">Budget</Table.HeaderCell>
              <Table.HeaderCell align="left" revealAt="xl">
                Top merchant
              </Table.HeaderCell>
              <Table.HeaderCell align="left">Last paid</Table.HeaderCell>
            </tr>
          </Table.Head>
          <Table.Body>
            {agents.map((agent) => (
              <tr
                key={agent.id}
                className="cursor-pointer hover:bg-[var(--v2-surface-hover)] transition-colors duration-150"
                // The whole row is a way in (#4333). The navigation itself is
                // client-side so the hover state never flashes a full reload;
                // the Agent cell's Link is the keyboard/AT half of the same
                // destination, so a pointer-less reader loses nothing.
                onClick={() => router.push(`/agents/${agent.id}`)}
              >
                <td className={COLUMN_PAD}>
                  <Link
                    href={`/agents/${agent.id}`}
                    className="inline-flex items-center gap-2 min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 rounded"
                  >
                    <StatusCell agent={agent} />
                  </Link>
                </td>
                <td className={`${COLUMN_PAD} text-right`}>
                  {/* #4331: no series swatch here any more — the agent's
                      colour lives on its monogram, the same tint the spend
                      chart fills the agent with, so the table carries one
                      colour per agent without a second mark in this cell. */}
                  <span className="v2-tabular block text-sm font-medium text-[var(--v2-ink)]">
                    {formatAnalyticsAmount(agent.spent, currency)}
                  </span>
                  {/* The former Share column, merged into the figure it was a
                      share of (#4333): one cell, the amount leading and its
                      slice of the window's spend under it. */}
                  <span className="v2-tabular block text-xs text-[var(--v2-ink-3)]">
                    {formatSharePercent(agent.share)} of spend
                  </span>
                </td>
                <td className={`${COLUMN_PAD} text-right`}>
                  <span className="v2-tabular text-sm text-[var(--v2-ink-2)]">{agent.payments}</span>
                </td>
                <td className={`${COLUMN_PAD} text-right`}>
                  {/* Refused attempts as a way in (#4333): the count links to
                      the agent's activity tab, pre-filtered to its refusals
                      (#4323 has landed). Rows and attempts can differ (a
                      dedupe upstream), so the attempts ride the cell. */}
                  <Link
                    href={refusedAttemptsHref(agent.id)}
                    className="v2-tabular whitespace-nowrap text-sm text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 rounded"
                  >
                    {formatRefusedCount(agent.refusals, agent.refusal_attempts)}
                  </Link>
                </td>
                <td className={COLUMN_PAD}>
                  <BudgetCell agent={agent} />
                </td>
                <td className={`${COLUMN_PAD} ${tableColumnClass('xl')}`}>
                  <MerchantCell agent={agent} />
                </td>
                <td className={COLUMN_PAD}>
                  <span
                    className="text-sm text-[var(--v2-ink-2)]"
                    title={agent.last_payment_at ? new Date(agent.last_payment_at).toLocaleString() : undefined}
                  >
                    {lastPaymentCaption(agent.last_payment_at)}
                  </span>
                </td>
              </tr>
            ))}
          </Table.Body>
        </Table>
      </div>

      <div className="lg:hidden divide-y divide-[var(--v2-table-row-border)]">
        {agents.map((agent) => (
          <MobileAgentRow key={agent.id} agent={agent} currency={currency} />
        ))}
      </div>
    </Card>
  )
}

/**
 * One agent, at a phone: spend, refusals and budget on the row itself, the
 * rest in the disclosure. The three that stay visible are the three a reader
 * at a bus stop is most likely to be asking about ("what did it spend, what
 * did it get refused, how much budget is left"); the disclosure is where the
 * table's remaining columns went, not a second source of truth — every line
 * is the same field the desktop table renders.
 */
function MobileAgentRow({
  agent,
  currency,
}: {
  agent: AnalyticsAgentRow
  currency: AnalyticsCurrency
}) {
  const [open, setOpen] = useState(false)
  const presentation = agentStatusPresentation(agent.status)
  const budgetLine =
    agent.budgets.length === 0
      ? 'No budget'
      : agent.budgets.map((b) => `${formatBudgetTokenValue(b)} · ${budgetUsedPercent(b.used_atomic, b.budget_atomic)}%`).join(' · ')

  return (
    <div className="px-4 py-3">
      <Row
        title={
          <span className="inline-flex items-center gap-2 min-w-0">
            <Monogram name={agent.name} size="xs" decorative />
            <span className="truncate">{agent.name}</span>
            {agent.status === 'revoked' && <StatusBadge tone={presentation.tone}>{presentation.label}</StatusBadge>}
          </span>
        }
        subtitle={
          <span className="v2-tabular inline-flex items-center gap-1.5">
            <span>
              {formatAnalyticsAmountCompact(agent.spent, currency)} spent · {agent.refusals} refused
            </span>
          </span>
        }
        trailing={
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="text-xs font-medium text-[var(--v2-brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 rounded px-1 py-0.5"
          >
            {open ? 'Hide' : 'More'}
          </button>
        }
        density="flush"
      />
      <p className="v2-tabular mt-1 text-xs text-[var(--v2-ink-3)]">{budgetLine}</p>
      {open && (
        <dl className="mt-2 space-y-1.5 rounded-md bg-[var(--v2-surface)] p-3 text-xs">
          <DisclosureLine term="Payments" value={String(agent.payments)} />
          <DisclosureLine
            term="Share of spend"
            value={formatSharePercent(agent.share)}
          />
          <DisclosureLine
            term="Refused"
            value={formatRefusedCount(agent.refusals, agent.refusal_attempts)}
          />
          <DisclosureLine term="Spend" value={formatAnalyticsAmount(agent.spent, currency)} />
          <DisclosureLine
            term="Top merchant"
            value={agent.top_merchant?.label ?? (agent.top_merchant ? 'Unknown recipient' : 'None in this range')}
          />
          <DisclosureLine
            term="Last payment"
            value={lastPaymentCaption(agent.last_payment_at)}
            title={agent.last_payment_at ? new Date(agent.last_payment_at).toLocaleString() : undefined}
          />
        </dl>
      )}
      <div className="mt-2 flex items-center gap-3">
        <Link
          href={`/agents/${agent.id}`}
          className="inline-block text-xs font-medium text-[var(--v2-brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 rounded"
        >
          Open agent
        </Link>
        <Link
          href={refusedAttemptsHref(agent.id)}
          className="inline-block text-xs font-medium text-[var(--v2-brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 rounded"
        >
          View refusals
        </Link>
      </div>
    </div>
  )
}

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

export default AgentsTable
