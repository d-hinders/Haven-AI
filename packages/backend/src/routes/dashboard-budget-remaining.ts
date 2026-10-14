/**
 * GET /dashboard/budget-remaining (#3804) — the dashboard's display-only,
 * cached read of every budget's live remaining amount.
 *
 * Separate FILE from `routes/dashboard.ts` on purpose — the same reason
 * `agent-labels.ts` rides the `/agents` prefix: #3803 is concurrently
 * reworking the overview route and its repository, and one route file per
 * surface keeps the request-validation `enforcedModules` key (and the two
 * issues' diffs) from colliding. Registered on `/dashboard`; born ENFORCED
 * (`index.ts`).
 *
 * ## Money-path boundary
 *
 * Display only. The ONLY cache in the spend path is `none` — this route
 * caches the enforcer read for DISPLAY (`modules/dashboard/budget-remaining-cache.ts`,
 * whose sole importer is this file, pinned by a structural test), while
 * `readRemainingBudget` itself stays the uncached fresh read behind every
 * spend decision. The set of budgets to show is read fresh from Postgres on
 * every request (user-scoped, #3802's expiry predicate), so issuing,
 * revoking, replacing, re-keying or removing a budget needs no cache
 * invalidation.
 *
 * ## Deadline
 *
 * 4 s overall: reads that have not finished by then return as UNKNOWN —
 * `remaining_from_chain: false` with `remaining_atomic`/`used_atomic` null —
 * are not cached, and never delay the chain-free `/dashboard/overview`.
 * Unknown is a deliberate departure from `?include=remaining` and
 * `/analytics/overview`, which fall back to the full budget and would ship
 * "full budget left" as a fact; here a failed/unknown read shows as
 * unavailable instead.
 */

import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { listDelegationJsonByIds } from '../infra/repositories/delegation-budgets.js'
import {
  listDashboardBudgetDelegations,
  listSubBudgetSpend,
  type DashboardBudgetRow,
  type SubBudgetSpendRow,
} from '../infra/repositories/budget-remaining.js'
import {
  BUDGET_READ_CONCURRENCY,
  currentPeriodBounds,
  mapWithConcurrency,
} from '../infra/chain/delegation-budget-reader.js'
import {
  // dep-lint-exempt: #3804's owner decision places the display cache in
  // modules/dashboard and this route as its ONLY importer (pinned by
  // modules/dashboard/__tests__/budget-remaining-import-guard.test.ts) — a
  // display-only cache must never be reachable from the money path, which is
  // exactly what this one-file edge guarantees.
  fetchBudgetRemaining,
  type BudgetRemainingOutcome,
} from '../modules/dashboard/budget-remaining-cache.js'

/** The overall route deadline (#3804): reads that miss it return unknown. */
export const BUDGET_REMAINING_DEADLINE_MS = 4_000

const UNKNOWN_OUTCOME: BudgetRemainingOutcome = { status: 'unknown' }

export interface BudgetRemainingEntry {
  agent_id: string
  chain_id: number
  delegation_hash: string
  token_address: string
  token_symbol: string
  token_decimals: number
  budget_atomic: string
  /** ISO instant of the read, or null when the read is unknown. */
  read_at: string | null
  /** ISO instant of the period boundary in force for this read. */
  period_end: string
  /** Null when the read is unknown — never "0", never the full budget. */
  remaining_atomic: string | null
  remaining_from_chain: boolean
  /** Null when the read is unknown. */
  used_atomic: string | null
  sub_budget_spend: Array<{ agent_id: string; spent_atomic: string }>
}

export interface BudgetRemainingResponse {
  budgets: BudgetRemainingEntry[]
}

function shapeEntry(
  row: DashboardBudgetRow,
  outcome: BudgetRemainingOutcome,
  periodEndSec: number,
  spend: SubBudgetSpendRow[],
): BudgetRemainingEntry {
  const base: BudgetRemainingEntry = {
    agent_id: row.agent_id,
    chain_id: row.chain_id,
    delegation_hash: row.delegation_hash,
    token_address: row.token_address,
    token_symbol: row.token_symbol,
    token_decimals: row.token_decimals,
    budget_atomic: row.budget_atomic,
    read_at: null,
    period_end: new Date(periodEndSec * 1000).toISOString(),
    remaining_atomic: null,
    remaining_from_chain: false,
    used_atomic: null,
    sub_budget_spend: spend.map((s) => ({ agent_id: s.agent_id, spent_atomic: s.spent_atomic })),
  }
  if (outcome.status !== 'known') return base
  const budget = BigInt(row.budget_atomic)
  const remaining = BigInt(outcome.remainingAtomic)
  // The same guard `shapeBudgets` applies: a remaining figure above the
  // budget (never observed from the enforcer, but never shipped as negative
  // used either) clamps to zero spent.
  const used = budget > remaining ? budget - remaining : 0n
  return {
    ...base,
    remaining_atomic: remaining.toString(),
    remaining_from_chain: true,
    used_atomic: used.toString(),
    read_at: new Date(outcome.readAtMs).toISOString(),
  }
}

export default async function dashboardBudgetRemainingRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.get('/budget-remaining', async (request): Promise<BudgetRemainingResponse> => {
    const { sub } = request.user as { sub: string }

    // Fresh from Postgres on EVERY request — the only cached thing is the
    // enforcer read below. `listDelegationJsonByIds` stays explicit (#3693):
    // the signed delegation is a capability and is read server-side only,
    // for the rows that need a chain read, and never reaches the response.
    const rows = await listDashboardBudgetDelegations(sub)
    const jsonById = await listDelegationJsonByIds(rows.map((r) => r.id))
    const nowSec = Math.floor(Date.now() / 1000)

    // Sub-budget attribution is Postgres-only — it does not race the deadline,
    // which exists for the RPC reads. One query per parent budget, each window
    // derived from the SAME `currentPeriodBounds` helper the reads use.
    const spendByHash = new Map<string, SubBudgetSpendRow[]>()
    await Promise.all(
      rows.map(async (row) => {
        const { start, end } = currentPeriodBounds(Number(row.start_date), row.period_seconds, nowSec)
        spendByHash.set(row.delegation_hash, await listSubBudgetSpend(row.delegation_hash, start, end))
      }),
    )

    // One shared 4 s deadline for every read: when it fires, every read still
    // in flight resolves unknown (uncached) at once. The underlying reads
    // keep running and cache normally for the next poll.
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<BudgetRemainingOutcome>((resolve) => {
      deadlineTimer = setTimeout(() => resolve(UNKNOWN_OUTCOME), BUDGET_REMAINING_DEADLINE_MS)
    })

    const shaped = await mapWithConcurrency(rows, BUDGET_READ_CONCURRENCY, async (row) => {
      const { end } = currentPeriodBounds(Number(row.start_date), row.period_seconds, nowSec)
      const outcome = await Promise.race([
        fetchBudgetRemaining({
          chainId: row.chain_id,
          delegationHash: row.delegation_hash,
          delegationJson: jsonById.get(row.id) ?? '',
          budgetAtomic: row.budget_atomic,
          periodEndSec: end,
        }),
        deadline,
      ])
      return shapeEntry(row, outcome, end, spendByHash.get(row.delegation_hash) ?? [])
    })
    clearTimeout(deadlineTimer)

    return { budgets: shaped }
  })
}
