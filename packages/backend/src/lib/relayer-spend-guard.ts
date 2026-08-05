/**
 * Per-identity budgets on relayer-paid operations (#717).
 *
 * The relayer EOAs sponsor all gas — the product model, and therefore an
 * availability/DoS surface: before this guard, nothing bounded how much of
 * the shared relayer one identity could burn. Funds were never at risk (the
 * relayer cannot move user money); what this protects is everyone ELSE's
 * onboarding and payments staying up, and the gas bill being attributable.
 *
 * Two calls, one table (`relayer_gas_events`, migration 054):
 *
 * - `assertRelayerBudget` — run BEFORE the relayer signs anything. Counts
 *   the identity's submitted operations in the window; over the cap throws
 *   `RelayerBudgetExceededError` (routes map it to 429). Caps are env-tunable
 *   with deliberate defaults far above organic use.
 * - `recordRelayerSpend` — run when a tx is SUBMITTED, updated gas numbers
 *   from the receipt. Best-effort: metrics must never fail a payment.
 *
 * Failure direction is deliberate and the opposite of the money-path gates:
 * a database error in the COUNT fails OPEN (warn + allow). This guard
 * protects availability; failing closed would let a DB hiccup take down the
 * exact operations it exists to keep up, while funds stay gated on-chain
 * either way. An attacker cannot exploit the fail-open without first taking
 * down Postgres — at which point nothing here works anyway.
 *
 * Attempt-level throttling (pre-submission spam that never reaches the
 * relayer) stays with the route-layer rate limits; this guard counts what
 * actually reached submission, because that is what burns gas.
 */

import pool from '../db.js'

export type RelayerOperation =
  | 'safe_deploy'
  | 'safe_exec'
  | 'hybrid_deploy'
  | 'allowance_transfer'
  | 'sweep'

interface BudgetRule {
  /** Which identity column the cap counts by. */
  identity: 'user_id' | 'agent_id'
  windowMinutes: number
  /** Env var overriding the default cap. */
  envVar: string
  defaultCap: number
}

/**
 * Defaults are sized to be invisible to organic use and cheap to tighten:
 * deploys are once-per-account events (10/day/user is already generous),
 * execs and transfers follow the busiest legitimate flows seen in QA with
 * headroom, sweeps are bounded by how often a funding leg can strand value.
 */
const RULES: Record<RelayerOperation, BudgetRule> = {
  safe_deploy: {
    identity: 'user_id',
    windowMinutes: 24 * 60,
    envVar: 'RELAYER_MAX_DEPLOYS_PER_USER_PER_DAY',
    defaultCap: 10,
  },
  hybrid_deploy: {
    identity: 'user_id',
    windowMinutes: 24 * 60,
    envVar: 'RELAYER_MAX_DEPLOYS_PER_USER_PER_DAY',
    defaultCap: 10,
  },
  safe_exec: {
    identity: 'user_id',
    windowMinutes: 60,
    envVar: 'RELAYER_MAX_EXECS_PER_USER_PER_HOUR',
    defaultCap: 20,
  },
  allowance_transfer: {
    identity: 'agent_id',
    windowMinutes: 60,
    envVar: 'RELAYER_MAX_TRANSFERS_PER_AGENT_PER_HOUR',
    defaultCap: 60,
  },
  sweep: {
    identity: 'agent_id',
    windowMinutes: 60,
    envVar: 'RELAYER_MAX_SWEEPS_PER_AGENT_PER_HOUR',
    defaultCap: 12,
  },
}

export class RelayerBudgetExceededError extends Error {
  readonly operation: RelayerOperation
  readonly retryAfterMinutes: number
  constructor(operation: RelayerOperation, cap: number, windowMinutes: number) {
    super(
      `Relayer budget exceeded: more than ${cap} ${operation} operations in ${windowMinutes} minutes. ` +
        'This protects the shared gas sponsor — wait and retry, or contact Haven if this is organic volume.',
    )
    this.name = 'RelayerBudgetExceededError'
    this.operation = operation
    this.retryAfterMinutes = windowMinutes
  }
}

function capFor(rule: BudgetRule): number {
  const raw = process.env[rule.envVar]
  if (raw !== undefined) {
    const n = Number(raw)
    // A cap that does not parse to a positive number would silently disable
    // the guard while looking configured — refuse to be that trap; keep the
    // default and let the misconfiguration surface in the warn log.
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
    console.warn(`relayer-spend-guard: ignoring non-positive ${rule.envVar}=${raw}; using default ${rule.defaultCap}`)
  }
  return rule.defaultCap
}

export interface RelayerAttribution {
  agentId?: string | null
  userId?: string | null
}

/**
 * Throws RelayerBudgetExceededError when the identity is over its window cap
 * for this operation. Missing attribution (no id of the rule's kind) allows
 * with a warn — an unattributable caller is a bug to surface, not a reason
 * to take the operation down.
 */
export async function assertRelayerBudget(
  operation: RelayerOperation,
  attribution: RelayerAttribution,
): Promise<void> {
  const rule = RULES[operation]
  const identityValue = rule.identity === 'agent_id' ? attribution.agentId : attribution.userId
  if (!identityValue) {
    console.warn(`relayer-spend-guard: ${operation} without ${rule.identity} attribution — allowed, fix the caller`)
    return
  }
  const cap = capFor(rule)
  let count: number
  try {
    const res = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM relayer_gas_events
       WHERE ${rule.identity} = $1 AND operation = $2
         AND created_at > NOW() - ($3 || ' minutes')::interval`,
      [identityValue, operation, String(rule.windowMinutes)],
    )
    count = Number(res.rows[0]?.cnt ?? '0')
  } catch (err) {
    // Fail OPEN — availability guard; see the header for why.
    console.warn(
      `relayer-spend-guard: budget check failed for ${operation} (${err instanceof Error ? err.message : String(err)}) — allowing`,
    )
    return
  }
  if (count >= cap) {
    throw new RelayerBudgetExceededError(operation, cap, rule.windowMinutes)
  }
}

export interface RelayerSpendRecord extends RelayerAttribution {
  operation: RelayerOperation
  chainId: number
  txHash?: string | null
  gasUsed?: bigint | null
  effectiveGasPrice?: bigint | null
}

/**
 * Record a submitted relayer tx. Call at submission (counts toward the cap
 * immediately — a landing-but-reverting tx burns gas too); pass the receipt
 * numbers when you have them. Best-effort: never throws.
 */
export async function recordRelayerSpend(record: RelayerSpendRecord): Promise<void> {
  const costWei =
    record.gasUsed != null && record.effectiveGasPrice != null
      ? (record.gasUsed * record.effectiveGasPrice).toString()
      : null
  try {
    await pool.query(
      `INSERT INTO relayer_gas_events
        (chain_id, operation, agent_id, user_id, tx_hash, gas_used, effective_gas_price, cost_wei)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        record.chainId,
        record.operation,
        record.agentId ?? null,
        record.userId ?? null,
        record.txHash ?? null,
        record.gasUsed?.toString() ?? null,
        record.effectiveGasPrice?.toString() ?? null,
        costWei,
      ],
    )
  } catch (err) {
    console.warn(
      `relayer-spend-guard: could not record ${record.operation} spend (${err instanceof Error ? err.message : String(err)})`,
    )
  }
}

/** Per-chain, per-operation spend over a trailing window — the ops rollup. */
export async function relayerSpendSummary(
  hours = 24,
): Promise<Array<{ chain_id: number; operation: string; ops: number; total_cost_wei: string | null }>> {
  const res = await pool.query<{ chain_id: number; operation: string; ops: string; total_cost_wei: string | null }>(
    `SELECT chain_id, operation, COUNT(*)::text AS ops, SUM(cost_wei)::text AS total_cost_wei
     FROM relayer_gas_events
     WHERE created_at > NOW() - ($1 || ' hours')::interval
     GROUP BY chain_id, operation
     ORDER BY chain_id, operation`,
    [String(hours)],
  )
  return res.rows.map((r) => ({ ...r, ops: Number(r.ops) }))
}
