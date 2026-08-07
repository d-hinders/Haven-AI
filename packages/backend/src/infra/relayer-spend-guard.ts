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
 * - `recordRelayerSpend` — insert the attempt row BEFORE broadcast (it
 *   counts toward the cap immediately, closing the burst window where N
 *   concurrent requests all read the pre-insert count), then
 *   `finishRelayerSpend` stamps the tx hash + receipt gas numbers — which
 *   also survives ethers v6's throw-on-revert, where an after-the-wait
 *   insert never runs. Both best-effort: metrics must never fail a payment.
 *
 * Failure direction is deliberate and the opposite of the money-path gates:
 * a database error in the COUNT fails OPEN (warn + allow). This guard
 * protects availability; failing closed would let a DB hiccup take down the
 * exact operations it exists to keep up, while funds stay gated on-chain
 * either way. The honest caveat: a partially degraded database (statement
 * timeouts, lock contention on this COUNT) fails open exactly under the
 * load where protection matters most — repeated fail-open warns in the
 * logs are a signal to act on, not noise.
 *
 * Attempt-level throttling (pre-submission spam that never reaches the
 * relayer) stays with the route-layer rate limits; this guard counts what
 * actually reached submission, because that is what burns gas.
 */

import { countRecentEvents, insertEvent, updateEvent, spendSummary, type SpendSummaryRow } from './repositories/relayer-gas-events.js'

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
    // 30, not lower: qa-dev fires on every dev deploy and runs ~2 sweeps per
    // run on ONE reused agent — a busy merge day must not trip the guard and
    // stale the freshness signal (#1119 review N4). Still bounds abuse: a
    // sweep costs pennies of gas, and the window is an hour.
    defaultCap: 30,
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
    count = await countRecentEvents(rule.identity, identityValue, operation, rule.windowMinutes)
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
 * Record a relayer attempt. Call BEFORE broadcast — the row counts toward
 * the cap immediately (closing the concurrent-burst window), and it exists
 * even when the wait later throws (ethers v6 rejects `tx.wait()` on revert).
 * Returns the row id for `finishRelayerSpend`, or null when the insert
 * failed. Never throws.
 */
export async function recordRelayerSpend(record: RelayerSpendRecord): Promise<string | null> {
  const costWei =
    record.gasUsed != null && record.effectiveGasPrice != null
      ? (record.gasUsed * record.effectiveGasPrice).toString()
      : null
  try {
    return await insertEvent({
      chainId: record.chainId,
      operation: record.operation,
      agentId: record.agentId,
      userId: record.userId,
      txHash: record.txHash,
      gasUsed: record.gasUsed?.toString() ?? null,
      effectiveGasPrice: record.effectiveGasPrice?.toString() ?? null,
      costWei,
    })
  } catch (err) {
    console.warn(
      `relayer-spend-guard: could not record ${record.operation} spend (${err instanceof Error ? err.message : String(err)})`,
    )
    return null
  }
}

/**
 * Stamp the broadcast tx hash and (when available) receipt gas numbers onto
 * a pre-recorded attempt. Best-effort: never throws.
 */
export async function finishRelayerSpend(
  id: string | null,
  fields: { txHash?: string | null; gasUsed?: bigint | null; effectiveGasPrice?: bigint | null },
): Promise<void> {
  if (!id) return
  const costWei =
    fields.gasUsed != null && fields.effectiveGasPrice != null
      ? (fields.gasUsed * fields.effectiveGasPrice).toString()
      : null
  try {
    await updateEvent(id, {
      txHash: fields.txHash,
      gasUsed: fields.gasUsed?.toString() ?? null,
      effectiveGasPrice: fields.effectiveGasPrice?.toString() ?? null,
      costWei,
    })
  } catch (err) {
    console.warn(
      `relayer-spend-guard: could not finish spend record ${id} (${err instanceof Error ? err.message : String(err)})`,
    )
  }
}

/** Per-chain, per-operation spend over a trailing window — the ops rollup. */
export async function relayerSpendSummary(hours = 24): Promise<SpendSummaryRow[]> {
  return spendSummary(hours)
}
