import type { AnalyticsAgentRow, AnalyticsDayBucket } from '@/types/analytics'

/**
 * One order and one colour map for every analytics surface that names an
 * agent (#3051). `GET /analytics/overview`'s `agents[]` carries no `ORDER BY`
 * (`PER_AGENT_SPEND_SQL` groups and never sorts), so the wire order can differ
 * between two requests — and `StackedBarSeries.seriesIndex` must be HELD
 * STABLE or an agent changes colour between the chart and the table beside
 * it. So the page sorts once, here, and every section reads the result.
 */

/** Spend descending (the ranking the table's own docblock promises), then id
 *  for a total, deterministic order. `spent` is the wire's numeric string. */
export function orderAgentsForDisplay(agents: AnalyticsAgentRow[]): AnalyticsAgentRow[] {
  return [...agents].sort((a, b) => {
    const diff = Number(b.spent) - Number(a.spent)
    if (diff !== 0) return diff
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * Series index per agent that APPEARS in `by_day` — the agents the chart
 * plots — numbered in the display order. An agent with no bar gets no
 * colour: the swatch beside its name would match nothing on the chart, and
 * a roster of every delegation-rail agent the tenant owns would run past the
 * six series tokens (`seriesColor` wraps at six) while the chart itself
 * carries only the spenders.
 */
export function seriesIndexByAgent(
  orderedAgents: AnalyticsAgentRow[],
  byDay: AnalyticsDayBucket[],
): Map<string, number> {
  const plotted = new Set<string>()
  for (const day of byDay) for (const id of Object.keys(day.spent_by_agent)) plotted.add(id)
  const map = new Map<string, number>()
  let next = 0
  for (const agent of orderedAgents) {
    if (plotted.has(agent.id)) map.set(agent.id, next++)
  }
  // An id in `by_day` that the roster does not carry (not producible by this
  // endpoint — both statements share the tenant + rail scope — but named
  // rather than dropped) takes the next slot so it never collides with a
  // rostered agent.
  for (const id of plotted) if (!map.has(id)) map.set(id, next++)
  return map
}
