/**
 * #5035 — the delegate-sweep confirmer.
 *
 * ## The gap
 *
 * `POST /machine-payments/sweep/submit` broadcasts the delegate's EIP-3009
 * `transferWithAuthorization` and waits for a receipt. When that wait times out
 * (ethers 6 REJECTS a timed-out `waitForTransaction` with a `TIMEOUT` error
 * carrying no hash) or the broadcast's own answer is lost, the transaction is
 * already durable and may still land. The route books the sweep
 * `outcome_unknown` with the hash it was broadcast under — never `failed`, and
 * never `submitted` (six queries read `submitted` as "landed").
 *
 * Nothing else reads `delegate_sweeps` after the route returns, and the bump
 * worker may replace a stuck sweep under a NEW hash after
 * `STALE_BROADCAST_SECONDS`. So this tick is what gives the row its true
 * terminal state.
 *
 * ## The decision — chain state, not a hash
 *
 * The authority is the token's own `authorizationState(from, nonce)`: an
 * EIP-3009 nonce is single-use, so "used" means the sweep landed, whichever
 * transaction consumed it. That is why the decision does not depend on the
 * first hash mining.
 *
 * - **used** → find the hash that actually mined and mark the row `submitted`
 *   with it, then resolve the agent's stranded-funds event. Attribution in
 *   transaction history matches on `ds.tx_hash`, so the hash must be the mined
 *   one, not merely the first broadcast one.
 * - **unused, past `valid_before`** → the authorization can never be used, so
 *   the row is `failed` with that cause. This is the bound that keeps an
 *   unresolved row from living forever.
 * - **unused, still valid** → leave it; the next tick retries.
 * - **read failed** → leave it; a read failure confirms nothing.
 *
 * ## Finding the mined hash
 *
 * Primary: walk the outbound record from the row's hash through `replaced_by`
 * (the bump worker links a replacement that way) and take the first candidate
 * whose receipt exists and succeeded. Fallback: the token's
 * `AuthorizationUsed(from, nonce)` log, via the shared scanner the eip3009
 * settlement sweeper already uses (`infra/chain/authorization-used-scanner.ts`)
 * — for a sweep whose record failed open. If neither yields a hash the row
 * stays unresolved — never a guessed hash.
 *
 * ## Concurrency
 *
 * Leader-gated across replicas (`runIfLeader`) because the RPC reads are the
 * expensive part. Correctness does not depend on the election: both terminal
 * writes are CASes on `status = 'outcome_unknown'`, so a concurrent submit
 * replay (which reads the same chain state) can win and this tick's write is
 * then the no-op loser.
 */

import {
  findOutcomeUnknownSweeps,
  markSweepFailedFromOutcomeUnknown,
  markSweepSubmittedFromOutcomeUnknown,
  resolveStrandedEventsForAgent,
  type OutcomeUnknownSweepRow,
} from '../../infra/repositories/machine-payments.js'
import { findOutboundTxById, findOutboundTxByHash } from '../../infra/repositories/outbound-txs.js'
import {
  findAuthorizationUsedTx,
  readAuthorizationState,
} from '../../infra/chain/authorization-used-scanner.js'
import { effectiveLogBatchBlocks } from '../../infra/chain/log-range-limit.js'
import { getProvider } from '../../infra/chain/relayer-reads.js'

/** Structural logger — Fastify's and vitest's loggers both satisfy it. */
export interface SweepConfirmerLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void
  warn: (obj: Record<string, unknown>, msg?: string) => void
}

/** Candidates considered per tick. */
export const SWEEP_CONFIRMER_MAX_CANDIDATES_PER_TICK = 50

/**
 * How far back the `AuthorizationUsed` fallback scans. Base produces a block
 * every ~2 s, so 50 000 blocks is roughly 28 hours — comfortably past any
 * sweep's 300 s validity window plus inclusion lag.
 */
export const SWEEP_CONFIRMER_LOG_LOOKBACK_BLOCKS = 50_000

/** Blocks per `eth_getLogs` call for the fallback scan (narrowed by the provider's learned limit). */
const SWEEP_CONFIRMER_LOG_BATCH_BLOCKS = 2_000

/** Hard ceiling on `eth_getLogs` calls per fallback scan. */
const SWEEP_CONFIRMER_MAX_LOG_CALLS = 10

/** How many `replaced_by` hops to follow before giving up. */
const MAX_REPLACEMENT_HOPS = 5

export type SweepConfirmOutcome = 'submitted' | 'failed_expired' | 'unresolved'

/**
 * The fields the decision needs, independent of the DB row shape — so the
 * submit route can reuse the same decision for a replay without a second read.
 */
export interface OutcomeUnknownSweepInput {
  id: string
  agentId: string
  chainId: number
  tokenAddress: string
  fromAddress: string
  nonce: string
  validBefore: string
  txHash: string | null
}

export interface SweepConfirmDecision {
  outcome: SweepConfirmOutcome
  /** The hash that actually mined, when `outcome === 'submitted'`. */
  txHash?: string
}

export interface SweepConfirmerTickResult {
  candidates: number
  submitted: number
  failedExpired: number
  unresolved: number
}

export interface SweepConfirmerDeps {
  findCandidates?: typeof findOutcomeUnknownSweeps
  /** `null` means the chain could not be read — never "unused". */
  readAuthorizationState?: (
    chainId: number,
    tokenAddress: string,
    authorizer: string,
    nonce: string,
  ) => Promise<boolean | null>
  /** Resolve the hash that actually mined for this row, or null. */
  findMinedHash?: (row: OutcomeUnknownSweepInput) => Promise<string | null>
  markSubmitted?: typeof markSweepSubmittedFromOutcomeUnknown
  markFailed?: typeof markSweepFailedFromOutcomeUnknown
  resolveStranded?: typeof resolveStrandedEventsForAgent
  /** Test seam: the clock. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * The default mined-hash resolver: the outbound record chain first, then the
 * token's `AuthorizationUsed` log. Returns null when neither answers — the
 * caller leaves the row unresolved rather than guessing.
 */
async function defaultFindMinedHash(row: OutcomeUnknownSweepInput): Promise<string | null> {
  const candidates: string[] = []
  if (row.txHash) candidates.push(row.txHash)

  // Follow the bump worker's replacement chain from the first broadcast hash.
  let record = row.txHash ? await findOutboundTxByHash(row.chainId, row.txHash) : null
  for (let hop = 0; record && hop < MAX_REPLACEMENT_HOPS; hop++) {
    if (record.tx_hash && !candidates.includes(record.tx_hash)) candidates.push(record.tx_hash)
    if (!record.replaced_by) break
    record = await findOutboundTxById(record.replaced_by)
  }

  const provider = getProvider(row.chainId)
  for (const hash of candidates) {
    try {
      const receipt = await provider.getTransactionReceipt(hash)
      if (receipt && receipt.status === 1) return hash
    } catch {
      // A receipt read failure is "not known yet" for this candidate; try the
      // next one, then the log fallback.
    }
  }

  try {
    const head = await provider.getBlockNumber()
    const fromBlock = Math.max(0, head - SWEEP_CONFIRMER_LOG_LOOKBACK_BLOCKS)
    const batchBlocks = effectiveLogBatchBlocks(row.chainId, SWEEP_CONFIRMER_LOG_BATCH_BLOCKS)
    const batches = Math.min(
      SWEEP_CONFIRMER_MAX_LOG_CALLS,
      Math.ceil((head - fromBlock + 1) / batchBlocks),
    )
    const found = await findAuthorizationUsedTx(
      row.chainId,
      row.tokenAddress,
      row.fromAddress,
      row.nonce,
      { fromBlock, toBlock: head },
      { batchBlocks, maxBatches: batches },
    )
    return found.status === 'found' ? found.txHash : null
  } catch {
    return null
  }
}

/**
 * Decide one outcome-unknown sweep from chain state and apply the terminal
 * write. Shared by the tick and the submit route's replay branch, so the two
 * cannot disagree about what "the current state" is.
 *
 * Never throws for a read failure — it returns `unresolved`, which is the only
 * safe reading of "not known yet".
 */
export async function confirmOutcomeUnknownSweep(
  row: OutcomeUnknownSweepInput,
  deps: SweepConfirmerDeps = {},
): Promise<SweepConfirmDecision> {
  const readAuthState = deps.readAuthorizationState ?? readAuthorizationState
  const findMinedHash = deps.findMinedHash ?? defaultFindMinedHash
  const markSubmitted = deps.markSubmitted ?? markSweepSubmittedFromOutcomeUnknown
  const markFailed = deps.markFailed ?? markSweepFailedFromOutcomeUnknown
  const resolveStranded = deps.resolveStranded ?? resolveStrandedEventsForAgent
  const now = deps.now ?? Date.now

  const used = await readAuthState(row.chainId, row.tokenAddress, row.fromAddress, row.nonce)
  if (used === null) return { outcome: 'unresolved' }
  if (used) {
    const minedHash = await findMinedHash(row)
    if (!minedHash) return { outcome: 'unresolved' }
    if (!(await markSubmitted(minedHash, row.id))) return { outcome: 'unresolved' }
    // Recovering the stranded funds resolves the open stranded-funds
    // reconciliation — the same write the route makes on a confirmed sweep.
    // Only the CAS winner resolves, so a lost race resolves once.
    await resolveStranded(row.agentId)
    return { outcome: 'submitted', txHash: minedHash }
  }
  if (Number(row.validBefore) <= Math.floor(now() / 1000)) {
    if (
      await markFailed('Sweep authorization expired unused — the transaction never landed', row.id)
    ) {
      return { outcome: 'failed_expired' }
    }
  }
  return { outcome: 'unresolved' }
}

/**
 * One confirmer tick. Never throws for an individual candidate — one poison
 * row must not silence the rest, and the queue is oldest-first, so a row that
 * threw on every tick would otherwise be first in line every time.
 */
export async function runSweepConfirmerTick(
  log: SweepConfirmerLogger,
  deps: SweepConfirmerDeps = {},
): Promise<SweepConfirmerTickResult> {
  const findCandidates = deps.findCandidates ?? findOutcomeUnknownSweeps

  const rows = await findCandidates(SWEEP_CONFIRMER_MAX_CANDIDATES_PER_TICK)
  const result: SweepConfirmerTickResult = {
    candidates: rows.length,
    submitted: 0,
    failedExpired: 0,
    unresolved: 0,
  }
  if (rows.length === 0) return result

  for (const row of rows) {
    let decision: SweepConfirmDecision = { outcome: 'unresolved' }
    try {
      decision = await confirmOutcomeUnknownSweep(toInput(row), deps)
      if (decision.outcome === 'submitted') {
        log.info(
          { sweep_id: row.id, agent_id: row.agent_id, tx_hash: decision.txHash },
          'Sweep confirmed: authorization used on-chain',
        )
      } else if (decision.outcome === 'failed_expired') {
        log.info(
          { sweep_id: row.id, valid_before: row.valid_before },
          'Sweep failed: authorization expired unused',
        )
      } else {
        log.info({ sweep_id: row.id, tx_hash: row.tx_hash }, 'Sweep outcome still unresolved')
      }
    } catch (err) {
      // A read failure confirms nothing. "Not known yet" is the only safe
      // reading of any failure on this path — never a terminal booking.
      log.warn({ sweep_id: row.id, err }, 'Sweep confirmer attempt threw — row left unresolved')
    }
    if (decision.outcome === 'submitted') result.submitted += 1
    else if (decision.outcome === 'failed_expired') result.failedExpired += 1
    else result.unresolved += 1
  }
  return result
}

function toInput(row: OutcomeUnknownSweepRow): OutcomeUnknownSweepInput {
  return {
    id: row.id,
    agentId: row.agent_id,
    chainId: row.chain_id,
    tokenAddress: row.token_address,
    fromAddress: row.from_address,
    nonce: row.nonce,
    validBefore: row.valid_before,
    txHash: row.tx_hash,
  }
}
