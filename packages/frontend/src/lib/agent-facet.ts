/**
 * One agent facet, built once (#4453, epic #4450).
 *
 * Three pages offer the same list of agents as a filter — `/transactions`'
 * Initiator, the account Activity tab's Initiator, and Analytics' Agent — and
 * before this module each built its own: three copies of the same rank
 * function, one page writing the status into the label ("Name (Revoked)"),
 * one page dropping it entirely. The order, the status suffix and the
 * inactive group are one decision, so they live here.
 *
 * The shape is `ListFacetOption` (#4110): `meta` is the non-truncating status
 * slot (#4150), and `group` is the collapsed tail (#4452). Both renderers —
 * the desktop `FacetMenu` and the phone filter sheet — already understand
 * them, so a page only has to call this function.
 */

import type { ListFacetOption } from '@/components/ui/FacetMenu'
import { agentStatusPresentation } from './payment-status'

/**
 * The minimum an agent row needs to become a facet option. Both sources
 * satisfy it: `/transactions/filters` returns `{ id, name, status }`
 * (`transaction-history.ts`), and `useAgents` returns the full `Agent`, whose
 * `archived_at` is what marks a removed agent.
 */
export interface AgentFacetSource {
  id: string
  name: string
  status: string
  /** Set once the agent is archived. Absent from the transaction-filters source. */
  archived_at?: string | null
}

/**
 * The one group: agents that are no longer usable. Revoked agents keep their
 * history on these pages, and an archived agent is gone from the list's
 * default view — neither is a choice a reader makes often, so they collapse
 * behind one disclosure row instead of padding the menu.
 *
 * `pending_approval` deliberately stays OUT: "Needs setup" is an agent about
 * to become usable, and hiding it would hide the one row a reader is looking
 * for.
 */
export const INACTIVE_AGENT_GROUP = { id: 'inactive', label: 'inactive' } as const

/**
 * The order the three pages have listed agents in since #4095: active, then
 * paused, then needs setup, then everything else. Names A–Z inside a status.
 *
 * This is the expression the three pages each carried their own copy of
 * (`status === 'active' ? 0 : status === 'paused' ? 1 : 2`), extended by the
 * needs-setup rung the issue asks for. It lives here now, once.
 */
const rankOf = (status: string) =>
  status === 'active' ? 0 : status === 'paused' ? 1 : status === 'pending_approval' ? 2 : 3

/** An agent is inactive when it is revoked, or archived where the source says so. */
function isInactive(agent: AgentFacetSource): boolean {
  return agent.status === 'revoked' || agent.archived_at != null
}

/**
 * Build a facet's options from an agent list.
 *
 * `leading` are the page's own options that come before every agent — the
 * Initiator facets' "User (manual)". They are never grouped and never
 * reordered: they are not agents, and the reader expects them first.
 *
 * Every non-active status rides in `meta`, from `agentStatusPresentation`, so
 * the menu row, the phone-sheet row and the chip all name it without the
 * label carrying it — a long agent name can lose its tail to truncation, the
 * status cannot.
 */
export function agentFacetOptions(
  agents: readonly AgentFacetSource[],
  leading: readonly ListFacetOption[] = [],
): ListFacetOption[] {
  const sorted = [...agents].sort(
    (a, b) => rankOf(a.status) - rankOf(b.status) || a.name.localeCompare(b.name),
  )

  return [
    ...leading,
    ...sorted.map((agent) => ({
      value: agent.id,
      label: agent.name,
      ...(agent.status === 'active' ? {} : { meta: agentStatusPresentation(agent.status).label }),
      ...(isInactive(agent) ? { group: INACTIVE_AGENT_GROUP } : {}),
    })),
  ]
}
