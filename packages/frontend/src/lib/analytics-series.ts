import { seriesColorForAgent } from '@/lib/avatar-tint'
import type { AnalyticsAgentRow, AnalyticsDayBucket } from '@/types/analytics'

/**
 * One order for every analytics surface that names an agent (#3051).
 * `GET /analytics/overview`'s `agents[]` carries no `ORDER BY`
 * (`PER_AGENT_SPEND_SQL` groups and never sorts), so the wire order can
 * differ between two requests. So the page sorts once, here, and every
 * section reads the result. Since #4331 it no longer assigns colours: an
 * agent's fill is its own avatar tint, keyed on its NAME and immune to
 * re-ranking (see `seriesColorByAgent` below).
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
 * Chart fill per agent, keyed by id (#4331). The colour is the agent's
 * avatar tint (`seriesColorForAgent`) — the same token its `Monogram` wears —
 * so an agent keeps one colour across periods, pages and rank moves. Whether
 * an agent appears in `by_day` no longer matters to its colour: the tint is
 * stored on the agent (#4428), and past the first six it repeats rather than
 * running out; two agents that share a tint are told apart by name in the
 * legend and tooltip.
 *
 * The stored tint is threaded in by the surface slice (#4431); this helper
 * builds the map, and reads the name hash until then — which is what every
 * agent wore before #4428.
 *
 * An id in `by_day` that the roster does not carry (not producible by this
 * endpoint — both statements share the tenant + rail scope — but named
 * rather than dropped) has no name to hash: it gets the neutral ink, the
 * same treatment the dashboard gives money it cannot attribute (#3897).
 */
export function seriesColorByAgent(
  orderedAgents: AnalyticsAgentRow[],
  byDay: AnalyticsDayBucket[],
): Map<string, string> {
  const map = new Map(orderedAgents.map((agent) => [agent.id, seriesColorForAgent({ name: agent.name })]))
  for (const day of byDay) {
    for (const id of Object.keys(day.spent_by_agent)) {
      if (!map.has(id)) map.set(id, 'var(--v2-ink-3)')
    }
  }
  return map
}
