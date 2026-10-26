'use client'

/**
 * The agent page's Tool calls tab (#4227, epic #4224): the MCP tool-call
 * audit log rebuilt to mockup v2. Generic `Row` list items under
 * `TransactionActivityDayHeader` day bands — NOT `TransactionActivityRow`,
 * which needs an amount and a direction mark an audit row does not have (a
 * no-amount variant of it would be a design-system extension). Each row
 * leads with a plain-language label (`toolCallLabel`) and carries the raw
 * tool name second, as `code`.
 *
 * Repeats: consecutive calls with the same tool, the same result and the
 * same day fold into one row with "×N" (`foldToolCallRuns`). The fold runs
 * over the whole LOADED list — `useMemo` over the reader's `items`, so
 * loading more re-folds everything on screen and a run is never split at a
 * page boundary. It is client-side only; the dashboard's server fold is a
 * different population and is not reused.
 *
 * The population is #4229's kinded read (`kind=tool_calls`) via
 * `useAgentToolCallLog`: the Result facet, Period and search all filter on
 * the server, `counts.error` feeds the summary line, and `ListShowMore`
 * pages with `hasMore`/`total`.
 *
 * A call that carries a `payment_id` links to that payment: it selects the
 * Activity tab, whose `activityToTransaction` adapter opens the shared
 * `TransactionDetailPanel` for it (#4229's `paymentId` filter).
 */

import { useEffect, useMemo, useState } from 'react'
import {
  TransactionActivityDayHeader,
  transactionDayGroups,
  transactionDayKey,
} from '@/components/haven'
import { Row } from '@/components/ui/Row'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ListNoMatch, ListShowMore, ListToolbar } from '@/components/ui/ListToolbar'
import type { ListFacet } from '@/components/ui/FacetMenu'
import type { ListCount, ListNoun } from '@/components/ui/list-controls-copy'
import {
  clearedListState,
  isAllTime,
  type ListState,
  type ListUrlSchema,
} from '@/components/ui/list-url-codec'
import { useListUrlState } from '@/components/ui/useListUrlState'
import {
  useAgentToolCallLog,
  AGENT_TOOL_CALL_PAGE_SIZE,
  type McpToolCallActivityItem,
} from '@/hooks/useAgentActivity'
import { api } from '@/lib/api'
import { errorCodeLabel, toolCallLabel } from '@/lib/tool-call-labels'
import { timeAgo } from '@/lib/format'
import { periodToBounds } from './AgentActivityTab'

interface AgentToolCallsTabProps {
  /** The agent whose audit log this is — fixed by the page, never a filter. */
  agentId: string
  /**
   * #4227: open a call's payment — selects the Activity tab and opens that
   * payment's detail panel. The page owns the URL, so the tab hands the id
   * up rather than writing it itself.
   */
  onOpenPayment: (paymentId: string) => void
}

const toolCallNoun: ListNoun = { one: 'tool call', other: 'tool calls' }

/** The Result facet's vocabulary, as #4229's `status` filter takes it. */
const RESULT_VALUES = ['ok', 'error', 'denied'] as const

/**
 * The tab's URL keys, alongside the page's own `?tab=` — a filtered link is
 * `/agents/<id>?tab=tool-calls&result=error` and reproduces the view. The
 * codec never touches keys it does not own, so the page's `?paymentId=`
 * survives the tab's own filter writes (like `?grant=`).
 */
function toolCallUrlSchema(): ListUrlSchema {
  return {
    search: { aliases: ['search'] },
    facets: [{ id: 'result', values: [...RESULT_VALUES] }],
    period: { allowCustom: true },
  }
}

/** The toolbar's state as the filters the kinded read sends. */
function listStateToFilters(state: ListState) {
  const first = (id: string): string | undefined => state.facets[id]?.[0]
  const search = state.q.trim()
  return {
    result: first('result'),
    q: search || undefined,
    ...periodToBounds(state.period),
  }
}

/** One capped read of the agent's UNFILTERED tool-call count (#4196's rule). */
async function fetchUnfilteredTotal(agentId: string): Promise<number | null> {
  try {
    const res = await api.get<{ total?: number }>(
      `/agent-activity/${agentId}/activity?kind=tool_calls&limit=1`,
    )
    return typeof res?.total === 'number' ? res.total : null
  } catch {
    return null
  }
}

/**
 * One folded row: the run's most recent call (the first in the feed order)
 * as the representative, and how many consecutive same-tool, same-result,
 * same-day calls folded into it.
 */
export interface ToolCallRun {
  item: McpToolCallActivityItem
  count: number
}

/**
 * Fold consecutive same-tool, same-result, same-day calls into one row. The
 * feed is newest-first, so the run's representative is its most recent call
 * and its timestamp is what the row shows. A run breaks on tool, result, OR
 * day — the day key is the day bands' own (`transactionDayKey`), so the fold
 * and the bands can never disagree about what "same day" means.
 */
export function foldToolCallRuns(
  items: readonly McpToolCallActivityItem[],
): ToolCallRun[] {
  const runs: ToolCallRun[] = []
  for (const item of items) {
    const current = runs[runs.length - 1]
    if (
      current &&
      current.item.tool_name === item.tool_name &&
      current.item.result_status === item.result_status &&
      transactionDayKey(current.item.created_at) === transactionDayKey(item.created_at)
    ) {
      current.count += 1
    } else {
      runs.push({ item, count: 1 })
    }
  }
  return runs
}

function resultTone(resultStatus: string): 'success' | 'warning' | 'danger' {
  switch (resultStatus) {
    case 'ok':
      return 'success'
    case 'denied':
      return 'danger'
    default:
      return 'warning'
  }
}

export default function AgentToolCallsTab({
  agentId,
  onOpenPayment,
}: AgentToolCallsTabProps) {
  // The schema is static; a stable reference keeps a pending search commit
  // from being re-parsed away on re-render (#4130's note).
  const urlSchema = useMemo(() => toolCallUrlSchema(), [])
  const [listState, setListState] = useListUrlState(urlSchema, { filtering: 'server' })
  const filters = useMemo(() => listStateToFilters(listState), [listState])

  const {
    items,
    total,
    hasMore,
    errorCount,
    loading,
    loadingMore,
    error,
    loadMore,
    refresh,
  } = useAgentToolCallLog(agentId, filters)

  // Active means "differs from the tab default" (#4110): no search, Result
  // All, All time — the same rule the toolbar applies to its chips.
  const hasActiveFilters =
    listState.q.trim() !== '' ||
    Object.values(listState.facets).some((values) => values.length > 0) ||
    !isAllTime(listState.period)

  // The filtered count's denominator (#4196's rule): when a filter is
  // applied, "{shown} of {total}" compares the FILTERED population against
  // the agent's UNFILTERED one. Unknown renders no figure rather than a
  // wrong one.
  const [unfilteredTotal, setUnfilteredTotal] = useState<number | null>(null)
  useEffect(() => {
    if (!hasActiveFilters) return
    let cancelled = false
    void fetchUnfilteredTotal(agentId).then((count) => {
      if (!cancelled) setUnfilteredTotal(count)
    })
    return () => {
      cancelled = true
    }
  }, [hasActiveFilters, agentId])

  // The fold runs over the whole loaded list — a run spanning two loaded
  // pages comes out as ONE row once the second page lands.
  const runs = useMemo(() => foldToolCallRuns(items), [items])
  const dayGroups = useMemo(
    () => transactionDayGroups(runs, (run) => run.item.created_at),
    [runs],
  )

  const facets: ListFacet[] = [
    {
      id: 'result',
      label: 'Result',
      options: [
        { value: 'ok', label: 'OK' },
        { value: 'error', label: 'Error' },
        { value: 'denied', label: 'Denied' },
      ],
    },
  ]

  const count: ListCount | null = loading
    ? null
    : !hasActiveFilters
      ? { shown: total, total }
      : unfilteredTotal === null || unfilteredTotal < total
        ? null
        : { shown: total, total: unfilteredTotal }
  const showNoMatch = hasActiveFilters && !loading && !error && runs.length === 0

  return (
    <div>
      {/* The one-line intro (owner decision on the epic, 2026-10-21): the tab
          is an audit trail, and saying so plainly is what keeps a read-only
          list from reading like a control. */}
      <p className="mb-4 text-sm text-[var(--v2-ink-3)]" data-testid="tool-calls-intro">
        Calls from this agent&apos;s MCP runtime: an audit trail, not a spending
        control.
      </p>

      <ListToolbar
        noun={toolCallNoun}
        state={listState}
        onChange={setListState}
        filtering="server"
        facets={facets}
        period={{ allowCustom: true }}
        searchDescription="by tool"
        count={count}
        summary={
          loading ? undefined : (
            // #4229's `counts.error`: the population's errors WITHOUT the
            // status filter, so the figure holds while the facet flips.
            <span data-testid="tool-calls-error-count">
              {errorCount} {errorCount === 1 ? 'error' : 'errors'}
            </span>
          )
        }
      />

      {showNoMatch ? (
        <div className="mt-3" data-testid="tool-calls-no-match">
          <ListNoMatch
            noun={toolCallNoun}
            onClear={() => setListState(clearedListState(listState, urlSchema))}
          />
        </div>
      ) : (
        <Card hover={false} className="mt-3">
          {loading ? (
            <div
              className="divide-y divide-[var(--v2-border)]"
              role="status"
              aria-busy="true"
              aria-label="Loading tool calls"
            >
              {[0, 1, 2].map((index) => (
                <div key={index} className="flex items-center gap-3 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="h-3.5 w-40 rounded bg-[var(--v2-surface-2)] animate-pulse" />
                    <div className="mt-1.5 h-2.5 w-56 rounded bg-[var(--v2-surface-2)] animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="p-6">
              <EmptyState
                title="Tool calls could not load"
                body={error}
                className="py-8"
                action={
                  <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                    Try again
                  </Button>
                }
              />
            </div>
          ) : runs.length === 0 ? (
            // The tab stays on an agent with no tool calls — the audit log
            // being empty is a fact about the agent, not a dead surface.
            <div className="p-6" data-testid="tool-calls-empty">
              <EmptyState
                title="No tool calls"
                body="When this agent's MCP runtime calls Haven, each call shows here."
                className="py-8"
              />
            </div>
          ) : (
            <div className="divide-y divide-[var(--v2-border)] v2-animate-fade-in">
              {dayGroups.map((day) => (
                <div key={day.dayKey}>
                  <TransactionActivityDayHeader label={day.label} />
                  {day.items.map((run, index) => (
                    <ToolCallRow
                      key={`${run.item.id}:${run.count}`}
                      run={run}
                      onOpenPayment={onOpenPayment}
                      insetDivider={index > 0}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {!showNoMatch && !loading && !error && (
        <ListShowMore
          loaded={items.length}
          total={total}
          pageSize={AGENT_TOOL_CALL_PAGE_SIZE}
          hasMore={hasMore}
          loading={loadingMore}
          onShowMore={() => void loadMore()}
        />
      )}
    </div>
  )
}

/**
 * One audit row. Title: the plain-language label (with the fold's ×N); the
 * raw tool name sits second, as `code` — the one fact the log is certain
 * of, kept visible even where the label is plain. Error and Denied rows
 * carry their StatusBadge and the `error_code` in words; a call that moved
 * a payment links to it.
 */
function ToolCallRow({
  run,
  onOpenPayment,
  insetDivider,
}: {
  run: ToolCallRun
  onOpenPayment: (paymentId: string) => void
  /** #4165's same-day inset hairline, on every row after a day's first. */
  insetDivider: boolean
}) {
  const { item, count } = run
  // `result_status` is `ok | error | denied` — only error and denied get a
  // badge; an OK row stays quiet so the failures are the things that read.
  const badged = item.result_status === 'error' || item.result_status === 'denied'
  const errorWords = badged ? errorCodeLabel(item.error_code) : null
  return (
    <Row
      density="comfortable"
      title={
        <span>
          {toolCallLabel(item.tool_name)}
          {count > 1 ? (
            <span
              className="ml-1.5 font-normal text-[var(--v2-ink-3)]"
              data-testid="tool-call-fold"
              aria-label={`repeated ${count} times`}
            >
              ×{count}
            </span>
          ) : null}
        </span>
      }
      subtitle={
        <span className="block truncate">
          <code className="font-mono text-xs text-[var(--v2-ink-2)]">{item.tool_name}</code>
          {errorWords ? (
            <>
              <span aria-hidden="true" className="text-xs text-[var(--v2-ink-3)]"> · </span>
              <span className="text-xs text-[var(--v2-ink-3)]">{errorWords}</span>
            </>
          ) : null}
          {item.payment_id ? (
            <>
              {' · '}
              <button
                type="button"
                className="text-xs font-medium text-[var(--v2-ink)] underline underline-offset-4 hover:decoration-2"
                onClick={() => onOpenPayment(item.payment_id as string)}
                data-testid="tool-call-payment-link"
              >
                View payment
              </button>
            </>
          ) : null}
        </span>
      }
      trailing={
        <span className="flex shrink-0 items-center gap-2">
          {badged ? (
            <StatusBadge tone={resultTone(item.result_status)}>{item.result_status}</StatusBadge>
          ) : null}
          <span className="text-xs text-[var(--v2-ink-3)]">{timeAgo(item.created_at)}</span>
        </span>
      }
      className={
        insetDivider
          ? // The shared same-day hairline (#4165): subtle, inset to the text
            // column, on every row after a day's first — never a bright
            // `currentColor` divider (the deleted `--v2-divider` defect).
            'before:pointer-events-none before:absolute before:top-0 before:h-px before:bg-[var(--v2-border-subtle)] before:content-[""] before:right-4 sm:before:right-5 before:left-4 sm:before:left-5'
          : undefined
      }
    />
  )
}
