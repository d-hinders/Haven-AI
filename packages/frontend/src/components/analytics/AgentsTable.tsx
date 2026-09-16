'use client'

import Link from 'next/link'
import {
  budgetUsedPercent,
  formatAnalyticsAmount,
  formatAnalyticsAmountCompact,
  formatBudgetResetDate,
  formatBudgetTokenValue,
  formatSharePercent,
  lastPaymentCaption,
  merchantLabel,
} from '@/lib/analytics-format'
import type { AnalyticsCurrency } from '@/lib/analytics-format'
import { agentStatusPresentation } from '@/lib/payment-status'
import { useState } from 'react'
import { Card } from '@/components/ui/Card'
import { Row } from '@/components/ui/Row'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Table, tableColumnClass } from '@/components/ui/Table'
import { SeriesSwatch } from '@/components/ui/StackedBarChart'
import type { AnalyticsAgentRow } from '@/types/analytics'

/**
 * The agents table (#2947, epic #2944 slice C).
 *
 * One row per agent that spent in the range, in the page's display order —
 * spend descending, then id (`lib/analytics-series.ts`): the wire's
 * `agents[]` carries no ORDER BY, so the page sorts once and every section
 * (this table, the spend chart, the merchants roster) inherits that one order
 * rather than choosing its own (two orders would be two answers to "which
 * agent spent most"). Every column is a field on one agent in the
 * response; the table computes nothing about the money.
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
 * (the same viewport-keyed split the theme row carries in the More sheet,
 * #2928). They are complements by construction: the same `lg:` prefix, one
 * with `hidden`, one without, so exactly one is displayed at any width and
 * `AgentsTable.test.tsx` pins both halves of that.
 *
 * Columns the table itself drops (`revealAt="xl"`) are the ones that survive
 * the narrow-desktop case: below a 974px container — the shell's own `xl`
 * tooth — there is not room for seven columns and a sidebar, and losing
 * share/top-merchant first is the choice the primitive's stage ladder already
 * makes for every table in the app.
 */

const COLUMN_PAD = 'px-4 py-3'

function StatusCell({ agent }: { agent: AnalyticsAgentRow }) {
  const presentation = agentStatusPresentation(agent.status)
  const revoked = agent.status === 'revoked'
  return (
    <span className="inline-flex items-center gap-2 min-w-0">
      <span className="truncate text-sm font-medium text-[var(--v2-ink)]">{agent.name}</span>
      {/* A revoked agent stays in the table rather than dropping out of it: it
          still spent money in this range, and hiding the row would hide the
          spending. The badge is what says the account is closed. */}
      {revoked && <StatusBadge tone={presentation.tone}>{presentation.label}</StatusBadge>}
    </span>
  )
}

function BudgetCell({ agent }: { agent: AnalyticsAgentRow }) {
  if (agent.budgets.length === 0) {
    return <span className="text-sm text-[var(--v2-ink-3)]">No budget set</span>
  }
  return (
    <div className="space-y-2">
      {agent.budgets.map((budget) => {
        const used = budgetUsedPercent(budget.used_atomic, budget.budget_atomic)
        return (
          <div key={`${budget.token}:${budget.recipient ?? 'any'}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="v2-tabular text-xs font-medium text-[var(--v2-ink)]">
                {formatBudgetTokenValue(budget)}
              </span>
              <span className="v2-tabular text-xs text-[var(--v2-ink-3)]">{used}%</span>
            </div>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={used}
              aria-label={`${budget.token} budget used`}
              className="mt-1 h-1.5 rounded-full bg-[var(--v2-surface-2)] overflow-hidden"
            >
              <div
                // The fill is a token surface colour, never a series colour: a
                // budget bar is a measurement of one delegation against its own
                // period, not a category to be keyed against a legend.
                className="h-full rounded-full bg-[var(--v2-brand)]"
                style={{ width: `${used}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
              <span title={new Date(budget.period_end).toLocaleString()}>
                resets {formatBudgetResetDate(budget.period_end)}
              </span>
              {/* When the on-chain read failed the endpoint says so, and the
                  page must say it too: "200 of 250" read from a stale
                  snapshot is not the same claim as "200 of 250" read from the
                  chain, and a reader comparing this cell against the agent's
                  budget screen needs to know which of the two they are
                  looking at. */}
              {!budget.remaining_from_chain && ' · read from Haven’s last snapshot'}
            </p>
          </div>
        )
      })}
    </div>
  )
}

/**
 * The ONE merchant-label rule lives in `lib/analytics-format.merchantLabel`
 * (shared with slice E's MerchantsTable, so the two tables cannot diverge on
 * how an unresolved address reads). It is imported, not restated here.
 */

function MerchantCell({ agent }: { agent: AnalyticsAgentRow }) {
  if (agent.top_merchant === null) {
    return <span className="text-sm text-[var(--v2-ink-3)]">None in this range</span>
  }
  const { value, title } = merchantLabel(agent.top_merchant.label)
  return (
    <span
      // Tabular numerals only on the address branch: a hexadecimal string is a
      // measurement of identity, not of quantity, and the tabular ramp is what
      // keeps two rows' addresses from jittering. A name keeps normal spacing.
      className={`text-sm text-[var(--v2-ink)]${title ? ' v2-tabular' : ''}`}
      title={title}
    >
      {value}
    </span>
  )
}

export function AgentsTable({
  agents,
  currency,
  seriesIndexById,
}: {
  /** In display order — the page sorts once (`orderAgentsForDisplay`). */
  agents: AnalyticsAgentRow[]
  currency: AnalyticsCurrency
  /** `seriesIndexByAgent(agents, byDay)`; absent → no swatches (the table alone). */
  seriesIndexById?: Map<string, number>
}) {
  return (
    <Card hover={false} className="overflow-hidden">
      <Card.Header as="h2" title="Agents" />

      <div className="hidden lg:block">
        <Table>
          <Table.Head collapseWhenNarrow={false}>
            <tr>
              <Table.HeaderCell align="left">Agent</Table.HeaderCell>
              <Table.HeaderCell align="right">Spend</Table.HeaderCell>
              <Table.HeaderCell align="right" revealAt="xl">
                Share
              </Table.HeaderCell>
              <Table.HeaderCell align="right">Payments</Table.HeaderCell>
              <Table.HeaderCell align="right">Refusals</Table.HeaderCell>
              <Table.HeaderCell align="left">Budget used</Table.HeaderCell>
              <Table.HeaderCell align="left" revealAt="xl">
                Top merchant
              </Table.HeaderCell>
              <Table.HeaderCell align="left">Last payment</Table.HeaderCell>
            </tr>
          </Table.Head>
          <Table.Body>
            {agents.map((agent) => (
              <tr key={agent.id} className="hover:bg-[var(--v2-surface-hover)] transition-colors duration-150">
                <td className={COLUMN_PAD}>
                  <Link
                    href={`/agents/${agent.id}`}
                    className="inline-flex items-center gap-2 min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 rounded"
                  >
                    <StatusCell agent={agent} />
                  </Link>
                </td>
                <td className={`${COLUMN_PAD} text-right`}>
                  {/* #3051: the series token the spend chart paints this agent
                      with, from the ONE map the page builds
                      (`lib/analytics-series.ts`), beside the SPEND figure —
                      the money the bar is made of — and never beside the
                      name, where a coloured dot reads as a status light. An
                      agent with no bar gets no swatch. */}
                  <span className="inline-flex items-center justify-end gap-2">
                    {/* A fixed-width slot BEFORE the figure: the dots form one
                        column whatever the figure's width, and the figure's
                        right edge stays on the SPEND header's like every other
                        numeric column — an unplotted agent keeps the empty
                        slot so its figure lines up too. */}
                    <span className="inline-flex w-2.5 shrink-0 justify-center" data-testid="series-swatch-slot">
                      {seriesIndexById?.get(agent.id) !== undefined && (
                        <SeriesSwatch seriesIndex={seriesIndexById.get(agent.id) as number} />
                      )}
                    </span>
                    <span className="v2-tabular text-sm font-medium text-[var(--v2-ink)]">
                      {formatAnalyticsAmount(agent.spent, currency)}
                    </span>
                  </span>
                </td>
                <td className={`${COLUMN_PAD} text-right ${tableColumnClass('xl')}`}>
                  <span className="v2-tabular text-sm text-[var(--v2-ink-2)]">
                    {formatSharePercent(agent.share)}
                  </span>
                </td>
                <td className={`${COLUMN_PAD} text-right`}>
                  <span className="v2-tabular text-sm text-[var(--v2-ink-2)]">{agent.payments}</span>
                </td>
                <td className={`${COLUMN_PAD} text-right`}>
                  {/* Refusals and the attempts behind them: one cell, because
                      the pair is one fact (a dedupe upstream makes rows and
                      attempts differ), and two columns would double the
                      width of the loudest zero. */}
                  <span className="v2-tabular text-sm text-[var(--v2-ink-2)]">
                    {agent.refusals}
                    {agent.refusal_attempts !== agent.refusals && ` · ${agent.refusal_attempts} attempts`}
                  </span>
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
          <MobileAgentRow key={agent.id} agent={agent} currency={currency} seriesIndex={seriesIndexById?.get(agent.id)} />
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
  seriesIndex,
}: {
  agent: AnalyticsAgentRow
  currency: AnalyticsCurrency
  seriesIndex: number | undefined
}) {
  const [open, setOpen] = useState(false)
  const presentation = agentStatusPresentation(agent.status)
  const budgetLine =
    agent.budgets.length === 0
      ? 'No budget set'
      : agent.budgets.map((b) => `${formatBudgetTokenValue(b)} · ${budgetUsedPercent(b.used_atomic, b.budget_atomic)}%`).join(' · ')

  return (
    <div className="px-4 py-3">
      <Row
        title={
          <span className="inline-flex items-center gap-2 min-w-0">
            <span className="truncate">{agent.name}</span>
            {agent.status === 'revoked' && <StatusBadge tone={presentation.tone}>{presentation.label}</StatusBadge>}
          </span>
        }
        subtitle={
          <span className="v2-tabular inline-flex items-center gap-1.5">
            {seriesIndex !== undefined && <SeriesSwatch seriesIndex={seriesIndex} />}
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
        className="px-0 py-0"
      />
      <p className="v2-tabular mt-1 text-xs text-[var(--v2-ink-3)]">{budgetLine}</p>
      {open && (
        <dl className="mt-2 space-y-1.5 rounded-md bg-[var(--v2-surface)] p-3 text-xs">
          <DisclosureLine term="Payments" value={String(agent.payments)} />
          <DisclosureLine
            term="Refusals"
            value={`${agent.refusals}${agent.refusal_attempts !== agent.refusals ? ` · ${agent.refusal_attempts} attempts` : ''}`}
          />
          <DisclosureLine term="Share" value={formatSharePercent(agent.share)} />
          <DisclosureLine term="Spend" value={formatAnalyticsAmount(agent.spent, currency)} />
          <DisclosureLine
            term="Top merchant"
            {...merchantLabel(agent.top_merchant?.label ?? 'None in this range')}
          />
          <DisclosureLine
            term="Last payment"
            value={lastPaymentCaption(agent.last_payment_at)}
            title={agent.last_payment_at ? new Date(agent.last_payment_at).toLocaleString() : undefined}
          />
        </dl>
      )}
      <Link
        href={`/agents/${agent.id}`}
        className="mt-2 inline-block text-xs font-medium text-[var(--v2-brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 rounded"
      >
        Open agent
      </Link>
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
