/**
 * `GET /ops/health` (#3514, epic #3507): the ops console's system-health read.
 *
 * One payload that lists what is operationally WRONG right now — sweepable
 * ERC-7710 payment intents (still in the sweeper's window and past its
 * horizon), stuck passport revocations, stuck outbound lanes, the delegate
 * balance monitor's last report, and the existing `/health/ops` diagnostics —
 * so an operator reads everything from one call.
 *
 * The route is READ-ONLY about the operational world (invariant 1, #3509):
 *
 * - Every data read goes through the executor the route was given (the
 *   read-only ops role, #3510), passed explicitly to the repositories.
 * - The reused queries are the monitors' OWN functions with the arguments
 *   their existing callers pass, so the definitions cannot drift from the
 *   behaviour they describe: `findSweepableErc7710Intents` (over
 *   `FIND_SWEEPABLE_ERC7710_INTENTS_SQL`, called twice — the sweeper's window
 *   and the past-horizon working set it no longer retries), the REPOSITORY
 *   `listStuckRevocations` (the module wrapper takes no executor; the SQL has
 *   no LIMIT, so the result is capped in code), `listStuckReanchors`, and
 *   `listUnminedOutboundTxs` + `countLaneAttemptsAtNonce`.
 * - NO RPC call on request. The relayer, passport and accounting diagnostics
 *   arrive through the injected `/health/ops` builder, and the delegate
 *   balance section reads the monitor's LAST report —
 *   `lastDelegateBalanceReport()` — never a fresh scan (a scan is 8 multicall
 *   chunks against the rate-limited primary for ~1,600 monitored delegates).
 *   On a replica without the monitor's leader lock there is no report, and
 *   the field says `not_available_on_this_replica`.
 * - The stuck-lane predicate is COMPOSED from the bump worker's exported
 *   constants (`STALE_BROADCAST_SECONDS`, `REBROADCAST_SAFE_SUBMITTERS`,
 *   `MAX_BUMPS_PER_NONCE`) — the same constants `cancelStuckOutboundLane`
 *   reads — so the two cannot drift; the cancel path itself is untouched.
 *   This read claims nothing: `listUnminedOutboundTxs` is a plain SELECT and
 *   the claiming queries (`FOR UPDATE SKIP LOCKED`) are never used. No
 *   receipt is read, so a listed lane may already be mined — the worker's
 *   chain-first tick closes those.
 * - Serialization is an explicit positive projection (#3512): the raw rows
 *   are never re-emitted. The sweep SQL selects `machine_metadata` and the
 *   row type carries `delegation_hash` — neither key, nor any `*_hash`,
 *   `*_token` or delegation body, may reach the response (pinned by the
 *   forbidden-key walk in `routes/__tests__/ops-data.test.ts`).
 */

import type { Executor } from '../../infra/transaction.js'
import {
  findSweepableErc7710Intents,
  findEvidenceOrphanedErc7710Intents,
  type SweepableSettlementRow,
} from '../../infra/repositories/x402-authorizations.js'
import { listStuckRevocations, listStuckReanchors } from '../../infra/repositories/agent-passports.js'
import { listUnminedOutboundTxs, countLaneAttemptsAtNonce } from '../../infra/repositories/outbound-txs.js'
import { MAX_BUMPS_PER_NONCE, REBROADCAST_SAFE_SUBMITTERS, STALE_BROADCAST_SECONDS } from '../../domain/outbound-lane-policy.js'
import { SWEEP_MIN_AGE_SECONDS, SWEEP_RECOVERY_HORIZON_SECONDS } from '../../domain/x402-sweep-window.js'
import { PASSPORT_STUCK_REVOKE_SECONDS } from '../../infra/passport-stuck-revoke-seconds.js'
import type { DelegateBalanceReport } from '../../domain/delegate-balance.js'
import type { HealthOpsPayload } from '../../routes/health-payload-types.js'

/** Row cap per stuck list: an ops read is a glance, not a scan dump. */
export const OPS_HEALTH_LIST_LIMIT = 50

/** The past-horizon window's far edge: 30 days back (#3514). */
export const PAST_HORIZON_SECONDS = 30 * 24 * 60 * 60

/** The sweepable-intent working sets, keyed the way the issue names them. */
export type SweepableWindow = 'in_window' | 'past_horizon'

/**
 * One sweepable ERC-7710 payment intent — a positive projection of
 * `SweepableSettlementRow`: identity, money shape and age only. Never
 * `machine_metadata` (the SQL selects it; #3512 keeps it out of responses)
 * and never `delegation_hash` or `tx_hash`.
 */
export interface OpsSweepableIntent {
  id: string
  agent_id: string
  chain_id: number
  token_symbol: string
  amount_human: string
  status: string
  /** `past_horizon` = past the sweeper's recovery horizon: the sweeper no longer retries it. */
  window: SweepableWindow
  age_seconds: number
}

/**
 * One settled-but-unbooked payment (#2213): confirmed, hash-carrying, and
 * referenced by no `machine_payment_evidence` row — outside every automated
 * retry path until the #2117 observer or an agent report completes it.
 */
export interface OpsEvidenceOrphan {
  id: string
  agent_id: string
  chain_id: number
  token_symbol: string
  amount_human: string
  status: string
  age_seconds: number
}

/** A stuck passport revocation or re-anchor: the chain still shows the agent as valid. */
export interface OpsStuckRevocation {
  agent_id: string
  revocation_requested_at: string | null
  revocation_attempts: number
  age_seconds: number
}

/**
 * One stuck re-anchor (#1699): the live attestation names `agent_eoa`, the
 * address the agent no longer uses (`delegate_address`). A different query
 * shape from the revocation list — the reused SQL selects no timestamp — so
 * it projects what the query returns, nothing invented.
 */
export interface OpsStuckReanchor {
  agent_id: string
  agent_eoa: string | null
  delegate_address: string | null
  revocation_attempts: number
}

/**
 * One stuck outbound lane. `id` is the UNMASKED `outbound_txs.id`: the handle
 * the operator pastes into `ops:cancel-stuck-lane`. It is a random uuid and
 * `outbound_txs` has no user or agent column, so it carries no personal data.
 */
export interface OpsStuckLane {
  id: string
  chain_id: number
  submitter: string
  nonce: string
  age_seconds: number
  /**
   * `capped_needs_operator` — a rebroadcast-safe submitter's lane at the
   * worker's bump cap: the worker has stopped for good and handed the lane to
   * the operator (#2769); this is the row `cancelStuckOutboundLane` accepts.
   * `stale_unmined` — unmined past the stale threshold without that: inside
   * the worker's retry budget, or a submitter whose payload must never be
   * duplicated (the worker alerts on those; the operator watches).
   */
  reason: 'stale_unmined' | 'capped_needs_operator'
}

/**
 * The delegate balance section: the monitor's last report, or the explicit
 * not-available answer on a replica that does not hold the monitor's leader
 * lock. There is NEVER a scan on request.
 */
export type OpsDelegateBalances =
  | { available: true; scanned_at: string; report: OpsDelegateBalanceReport }
  | { available: false; reason: 'not_available_on_this_replica' }

/** The report's positive projection: counts, the lingering balances, atomic amounts as strings. */
export interface OpsDelegateBalanceReport {
  scanned_delegates: number
  unread: number
  lingering: {
    agent_id: string
    agent_name: string
    delegate_address: string
    chain_id: number
    /** Atomic USDC as a decimal string — no bigint crosses JSON. */
    balance_atomic: string
  }[]
  dust_total_atomic: string
  dust_alert: boolean
  /** Chains whose reader could not even be set up (#3458), keyed by chain id. */
  chain_errors: Record<number, string>
}

export interface OpsHealth {
  sweepable_intents: OpsSweepableIntent[]
  evidence_orphans: OpsEvidenceOrphan[]
  stuck_revocations: OpsStuckRevocation[]
  stuck_reanchors: OpsStuckReanchor[]
  stuck_lanes: OpsStuckLane[]
  delegate_balances: OpsDelegateBalances
  /** The `GET /health/ops` payload, built by the same function that route serves. */
  ops_diagnostics: HealthOpsPayload
  generated_at: string
}

/** Everything the builder needs beyond the ops executor — injected, like `onchainReaders` (#3513). */
export interface OpsHealthDeps {
  /**
   * The `GET /health/ops` payload builder. Injected rather than imported:
   * `routes/health.ts` imports `infra/relayer-balance-monitor.ts`, which the
   * ops invariant-1 walk forbids this module from reaching transitively.
   */
  buildOpsDiagnostics: () => Promise<HealthOpsPayload>
  /**
   * The delegate balance monitor's LAST report, or null when this process
   * has not scanned. Injected from the composition root
   * (`lastDelegateBalanceReport` in `infra/delegate-balance-report-store.ts`)
   * so the ops graph never imports the store — and never, ever scans.
   */
  lastDelegateBalanceReport: () => DelegateBalanceReport | null
  now?: () => number
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null)

function projectDelegateBalances(report: DelegateBalanceReport | null): OpsDelegateBalances {
  if (!report) return { available: false, reason: 'not_available_on_this_replica' }
  return {
    available: true,
    scanned_at: report.scannedAt,
    report: {
      scanned_delegates: report.findings.length,
      unread: report.unread.length,
      lingering: report.lingering.map((f) => ({
        agent_id: f.agentId,
        agent_name: f.agentName,
        delegate_address: f.delegateAddress,
        chain_id: f.chainId,
        balance_atomic: f.balanceAtomic.toString(),
      })),
      dust_total_atomic: report.dustTotalAtomic.toString(),
      dust_alert: report.dustAlert,
      chain_errors: report.chainErrors,
    },
  }
}

interface RevocationLike {
  agent_id: string
  revocation_requested_at: Date | null
  revocation_attempts: number
}

function projectRevocations(rows: RevocationLike[], nowMs: number): OpsStuckRevocation[] {
  return rows.slice(0, OPS_HEALTH_LIST_LIMIT).map((r) => {
    const since = r.revocation_requested_at ? new Date(r.revocation_requested_at).getTime() : nowMs
    return {
      agent_id: r.agent_id,
      revocation_requested_at: iso(r.revocation_requested_at),
      revocation_attempts: r.revocation_attempts,
      age_seconds: Math.max(0, Math.floor((nowMs - since) / 1000)),
    }
  })
}

function projectReanchors(rows: Awaited<ReturnType<typeof listStuckReanchors>>): OpsStuckReanchor[] {
  return rows.slice(0, OPS_HEALTH_LIST_LIMIT).map((r) => ({
    agent_id: r.agent_id,
    agent_eoa: r.agent_eoa,
    delegate_address: r.delegate_address,
    revocation_attempts: r.revocation_attempts,
  }))
}

function projectSweepable(r: SweepableSettlementRow, nowMs: number): OpsSweepableIntent {
  const createdAtMs = new Date(r.created_at).getTime()
  return {
    id: r.id,
    agent_id: r.agent_id,
    chain_id: r.chain_id,
    token_symbol: r.token_symbol,
    amount_human: r.amount_human,
    status: r.status,
    window: createdAtMs >= nowMs - SWEEP_RECOVERY_HORIZON_SECONDS * 1000 ? 'in_window' : 'past_horizon',
    age_seconds: Math.max(0, Math.floor((nowMs - createdAtMs) / 1000)),
  }
}

function projectEvidenceOrphan(r: SweepableSettlementRow, nowMs: number): OpsEvidenceOrphan {
  const createdAtMs = new Date(r.created_at).getTime()
  return {
    id: r.id,
    agent_id: r.agent_id,
    chain_id: r.chain_id,
    token_symbol: r.token_symbol,
    amount_human: r.amount_human,
    status: r.status,
    age_seconds: Math.max(0, Math.floor((nowMs - createdAtMs) / 1000)),
  }
}

/**
 * The stuck-lane rows for ONE chain, labelled by the predicate
 * `cancelStuckOutboundLane` answers to — composed from the SAME exported
 * constants the cancel path reads (`STALE_BROADCAST_SECONDS`,
 * `REBROADCAST_SAFE_SUBMITTERS`, `MAX_BUMPS_PER_NONCE`), so the two cannot
 * disagree without a compile error:
 *
 * - `capped_needs_operator` — a rebroadcast-safe submitter's lane at the
 *   worker's bump cap: the worker has stopped for good and handed the lane to
 *   the operator (#2769), and a cancel trigger on the row would be accepted.
 *   The cancel path then re-checks stamping and chain liveness per row at
 *   trigger time; this read deliberately reads no receipt, so a row listed
 *   here may ALREADY be mined and closed by the worker's next tick.
 * - `stale_unmined` — unmined past the stale threshold but NOT that: still
 *   inside the worker's retry budget, or a submitter whose payload must never
 *   be duplicated (the worker alerts and walks away — an operator watches).
 *
 * This read claims nothing: `listUnminedOutboundTxs` is a plain SELECT; the
 * claiming queries (`FOR UPDATE SKIP LOCKED`) are never touched.
 */
export async function collectStuckLanesForChain(db: Executor, chainId: number, nowMs: number): Promise<OpsStuckLane[]> {
  const stale = await listUnminedOutboundTxs(chainId, STALE_BROADCAST_SECONDS, db)
  const items: OpsStuckLane[] = []
  for (const row of stale) {
    if (row.nonce === null) continue // unstamped: the orphan path owns it, not a nonce lane
    const ageSeconds = Math.max(0, Math.floor((nowMs - row.updated_at.getTime()) / 1000))
    let capped = false
    if (REBROADCAST_SAFE_SUBMITTERS.has(row.submitter)) {
      const attempts = await countLaneAttemptsAtNonce(chainId, BigInt(row.nonce), db)
      capped = attempts >= MAX_BUMPS_PER_NONCE
    }
    items.push({
      id: row.id,
      chain_id: row.chain_id,
      submitter: row.submitter,
      nonce: row.nonce,
      age_seconds: ageSeconds,
      reason: capped ? 'capped_needs_operator' : 'stale_unmined',
    })
  }
  return items
}

/** Which served chains to walk. Injectable for tests; production walks the deployable set. */
export type ServedChains = () => number[]

/**
 * Build the whole system-health payload. Data reads go through `db` — the ops
 * executor — with the executor passed explicitly to every repository call;
 * the diagnostics builder is the injected `/health/ops` builder. Throws when
 * a read throws: the route answers 500, and the unaudited-then-unreturned
 * rule (epic #3507 invariant 6) still holds.
 */
export async function buildOpsHealth(
  db: Executor,
  deps: OpsHealthDeps,
  servedChains: ServedChains,
): Promise<OpsHealth> {
  const nowMs = (deps.now ?? Date.now)()

  const [inWindow, pastHorizon, orphans, revocations, reanchors, diagnostics] = await Promise.all([
    // The sweeper's own working set, with the arguments its caller passes
    // (settlement-sweeper.ts): the payments still inside the recovery window.
    findSweepableErc7710Intents(SWEEP_MIN_AGE_SECONDS, SWEEP_RECOVERY_HORIZON_SECONDS, OPS_HEALTH_LIST_LIMIT, db),
    // 24 h to 30 days: past the horizon, so the sweeper no longer retries
    // these payments at all — the ones actually lost without an operator.
    findSweepableErc7710Intents(SWEEP_RECOVERY_HORIZON_SECONDS, PAST_HORIZON_SECONDS, OPS_HEALTH_LIST_LIMIT, db),
    // The evidence-orphaned recovery set (#2213) — the same working set the
    // sweeper's recovery pass SELECTs.
    findEvidenceOrphanedErc7710Intents(SWEEP_MIN_AGE_SECONDS, PAST_HORIZON_SECONDS, OPS_HEALTH_LIST_LIMIT, db),
    // The REPOSITORY call with the ops executor and the alarm threshold's
    // shared constant (index.ts reads the same module).
    listStuckRevocations(PASSPORT_STUCK_REVOKE_SECONDS, db),
    listStuckReanchors(PASSPORT_STUCK_REVOKE_SECONDS, db),
    deps.buildOpsDiagnostics(),
  ])

  const lanes: OpsStuckLane[] = []
  for (const chainId of servedChains()) {
    lanes.push(...(await collectStuckLanesForChain(db, chainId, nowMs)))
  }

  return {
    sweepable_intents: [...inWindow, ...pastHorizon].map((r) => projectSweepable(r, nowMs)),
    evidence_orphans: orphans.map((r) => projectEvidenceOrphan(r, nowMs)),
    stuck_revocations: projectRevocations(revocations, nowMs),
    stuck_reanchors: projectReanchors(reanchors),
    stuck_lanes: lanes,
    delegate_balances: projectDelegateBalances(deps.lastDelegateBalanceReport()),
    ops_diagnostics: diagnostics,
    generated_at: new Date(nowMs).toISOString(),
  }
}
