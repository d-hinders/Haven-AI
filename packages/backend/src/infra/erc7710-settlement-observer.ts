/**
 * Passive on-chain settlement observer for erc7710 x402 payments (#2117).
 *
 * ## The gap this closes
 *
 * On erc7710 direct settlement the MERCHANT redeems the [child, budget]
 * delegation chain and Haven submits nothing, so Haven never learns the
 * settlement transaction hash on its own. The intent therefore sits at
 * `submitted` with `tx_hash` NULL, and because everything the Fortnox feed and
 * the backfill read (`machine_payment_evidence`, `reporting_feed_syncs`) is
 * keyed on a `confirmed` intent, such a payment stays invisible to
 * bookkeeping FOREVER unless the agent later reports the hash to
 * `POST /machine-payments/evidence`. That was the exact residual gap accepted
 * in `docs/architecture/04-x402-payment-sequence.md` § Completing an erc7710
 * settlement.
 *
 * This monitor closes it passively: every tick it asks the database for
 * `submitted` erc7710 intents whose settlement window is still open, discovers
 * the settlement transaction on-chain (`eth_getLogs` for a `Transfer` from the
 * Safe to the merchant in the intent's token), and — only under the verifier's
 * `verified` verdict — completes the intent and pushes it through the exact
 * same evidence pipeline the agent-report path uses.
 *
 * ## Integrity posture — identical to the agent-report path, by construction
 *
 * The observer never hand-crafts a verdict. Discovery is just candidate
 * FINDING: the exact-match gate is
 * `verifySettlementTransferTx`/`observeErc7710Settlement` — the same seam the
 * HTTP path uses — so a settlement the observer completes satisfies every
 * check (token contract, `from` = Safe, `to` = merchant, exact amount,
 * in-window block timestamp) and every guard (CAS, replay, ambiguity) that an
 * agent-reported hash must satisfy. Discovery only narrows the candidate set;
 * it adds NO trust of its own. Anything short of `verified` is skipped and
 * retried next tick; `rpc_unavailable` is never treated as a verdict.
 *
 * ## Ordering and exclusion
 *
 * Read, verify, then (in the keyed lock) confirm, reload, and record evidence.
 * The eligibility query bounds the scan to windows that are still plausibly
 * open, so an intent whose settlement window has fully expired is left alone
 * forever — exactly as the accepted gap says — rather than hammering the RPC
 * pointlessly every tick.
 */
import { ethers } from 'ethers'
import {
  ERC7710_SETTLEMENT_OBSERVER_MAX_AGE_SECONDS,
  findPendingErc7710Settlements,
} from './repositories/x402-authorizations.js'
import { findIntentEvidenceSource } from './repositories/machine-payments.js'
import { recordMachinePaymentEvidenceBase } from '../modules/mpp/index.js'
import {
  expectedSettlementTransferFor,
  observeErc7710Settlement,
  type ObservableSettlementIntent,
} from '../modules/x402/index.js'
import {
  ERC20_TRANSFER_TOPIC,
  verifySettlementTransferTx,
  type ExpectedSettlementTransfer,
} from './chain/settlement-transfer-verifier.js'
import { getProvider } from '../rails/allowance-module.js'
import { KEYED_LOCK_NAMESPACES, withKeyedAdvisoryLock } from '../platform/leader-lock.js'

/**
 * Tick cadence. Fast enough that a settled-but-unreported payment reaches
 * Fortnox within a couple of minutes of the merchant redeeming it; slow enough
 * that the per-tick RPC reads and the leader lock stay negligible.
 */
export const ERC7710_SETTLEMENT_OBSERVER_INTERVAL_MS = 90_000

/** How many eligible intents one tick may start completing. */
export const ERC7710_SETTLEMENT_OBSERVER_SCAN_LIMIT = 50

/**
 * Assumed block time for estimating the discovery block range. Deliberately at
 * the FAST end of the range (Base family is ~2s) so the estimated range is
 * WIDER than reality on every slower chain — a generous range plus the exact
 * verifier is the safe combination; a narrow range could miss a genuine
 * settlement wholesale.
 */
const ASSUMED_SECONDS_PER_BLOCK = 2

/** Extra blocks of slack on the discovery range, so a slow RPC head or a burst
 * of empty blocks can never push a genuine settlement off the range. */
const DISCOVERY_RANGE_MARGIN_BLOCKS = 128

const SCOPE = 'erc7710-settlement-observer'

interface ObserverLogger {
  info(obj: Record<string, unknown>, msg: string): void
  warn(obj: Record<string, unknown>, msg: string): void
}

export interface Erc7710SettlementObserverReport {
  /** Intents the eligibility query returned this tick (≤ SCAN_LIMIT). */
  pending: number
  /** Intents flipped to `confirmed` by this tick. */
  confirmed: number
  /** `machine_payment_evidence` rows written (=== Fortnox feed fired). */
  evidencePushed: number
  /** Confirmed but the evidence push failed — logged, retried by the next gap owner. */
  evidenceFailed: number
  /** Eligible but no on-chain candidate verified — expected, retry next tick. */
  skippedNoCandidate: number
  /** The chain could not be reached — retry next tick, never a verdict. */
  skippedRpcUnavailable: number
  scannedAt: string
}

export type SettlementDiscovery =
  | { status: 'found'; txHash: string }
  | { status: 'rpc_unavailable' }
  | { status: 'no_candidate' }

/**
 * Find the on-chain settlement transaction matching `expected`, if any.
 *
 * Two RPC reads (latest block, then a `Transfer` log scan of the expected
 * token contract between the Safe and the merchant) plus one receipt verify
 * per candidate. The log scan is a CANDIDATE filter only — the exact-match
 * verdict always comes from `verifySettlementTransferTx`, so a log that merely
 * shares the token+payer+payee topics can never complete anything by itself.
 *
 * Returns `rpc_unavailable` on any transport failure (retryable, never fatal);
 * `no_candidate` when nothing verified (including `mismatch`/`reverted`
 * candidates that got checked and failed — those are settled answers for THIS
 * candidate, but a later candidate may still be the payment, so the scan
 * continues).
 */
export async function discoverSettlementTransferHash(
  expected: ExpectedSettlementTransfer,
): Promise<SettlementDiscovery> {
  const provider = getProvider(expected.chainId)

  let latestBlock: { number: number } | null
  try {
    latestBlock = await provider.getBlock('latest')
  } catch {
    return { status: 'rpc_unavailable' }
  }
  if (!latestBlock) return { status: 'rpc_unavailable' }

  // The settlement must be mined inside [notBeforeSec, notAfterSec], so every
  // candidate block is within `now - notBeforeSec` seconds of the head. That
  // age, divided by an assumed block time and widened by a margin, is all the
  // range needs to cover — no other timestamp math is hand-rolled here; the
  // verifier's own window clamp is the exact gate.
  const nowSec = Math.floor(Date.now() / 1000)
  const ageSec = Math.max(0, nowSec - expected.notBeforeSec)
  const blocksToCover = Math.ceil(ageSec / ASSUMED_SECONDS_PER_BLOCK) + DISCOVERY_RANGE_MARGIN_BLOCKS
  const fromBlock = Math.max(0, latestBlock.number - blocksToCover)

  let logs: Array<{ transactionHash: string | null }>
  try {
    logs = await provider.getLogs({
      address: expected.tokenAddress,
      topics: [
        ERC20_TRANSFER_TOPIC,
        ethers.zeroPadValue(expected.fromAddress, 32),
        ethers.zeroPadValue(expected.toAddress, 32),
      ],
      fromBlock,
      toBlock: 'latest',
    })
  } catch {
    return { status: 'rpc_unavailable' }
  }

  for (const log of logs) {
    if (!log.transactionHash) continue
    const verification = await verifySettlementTransferTx(log.transactionHash, expected)
    if (verification.outcome === 'verified') return { status: 'found', txHash: log.transactionHash }
    if (verification.outcome === 'rpc_unavailable') {
      // If the RPC cannot answer for this candidate it cannot be trusted for
      // the rest either — stop and retry the whole intent next tick.
      return { status: 'rpc_unavailable' }
    }
    // mismatch / reverted / not_found → not this payment; try the next candidate.
  }

  return { status: 'no_candidate' }
}

export interface ObservedSettlementCompletion {
  confirmed: boolean
  evidencePushed: boolean
  evidenceFailed: boolean
  /** Present when the confirm was refused — every such reason is a skip. */
  refusedReason?: string
}

/**
 * Complete one already-verified settlement: confirm the intent under the
 * per-intent keyed advisory lock, then write the evidence row exactly the way
 * the agent-report path does.
 *
 * The keyed lock serialises this against the HTTP path completing the SAME
 * intent at the same moment; whichever wins the CAS in
 * `confirmObservedSettlement`, this function's re-read after a loss sees the
 * winner's write (returns not_applicable → skipped here).
 */
export async function completeObservedErc7710Settlement(
  intent: ObservableSettlementIntent,
  verifiedHash: string,
): Promise<ObservedSettlementCompletion> {
  return withKeyedAdvisoryLock(KEYED_LOCK_NAMESPACES.settlementObservation, intent.id, async () => {
    const observation = await observeErc7710Settlement(intent, verifiedHash)

    if (observation.outcome !== 'confirmed') {
      // not_applicable: another path won the race (or the intent moved).
      // unverified: the CAS/replay/ambiguity guard refused, or a re-verify
      // disagreed. Both leave the intent exactly where it was.
      return { confirmed: false, evidencePushed: false, evidenceFailed: false, refusedReason: observation.outcome }
    }

    // Re-read rather than patch the in-memory row: `confirmed_at` is the
    // database's NOW(), and `recordMachinePaymentEvidenceBase` copies it onto
    // the evidence row.
    const reloaded = await findIntentEvidenceSource(intent.id, intent.agent_id)
    if (!reloaded) {
      return { confirmed: true, evidencePushed: false, evidenceFailed: false }
    }

    try {
      await recordMachinePaymentEvidenceBase(reloaded)
      return { confirmed: true, evidencePushed: true, evidenceFailed: false }
    } catch (err) {
      // The intent IS confirmed — a thrown evidence write must not be able to
      // fake a failure to confirm. Logged by the caller; the row is missing,
      // which is the pre-existing backfill gap with its own owner, not a
      // regression of the confirm.
      return {
        confirmed: true,
        evidencePushed: false,
        evidenceFailed: true,
        refusedReason: err instanceof Error ? err.message : String(err),
      }
    }
  })
}

/**
 * One scan across the eligible set. Best-effort per intent: a throw anywhere
 * (DB, lock, confirm, reload) is caught and logged, never allowed to abort the
 * rest of the tick — a flaky intent or a flaky RPC must not starve the other
 * pending settlements.
 */
export async function runErc7710SettlementObserver(
  log: ObserverLogger,
): Promise<Erc7710SettlementObserverReport> {
  const pending = await findPendingErc7710Settlements(
    ERC7710_SETTLEMENT_OBSERVER_MAX_AGE_SECONDS,
    ERC7710_SETTLEMENT_OBSERVER_SCAN_LIMIT,
  )

  const report: Erc7710SettlementObserverReport = {
    pending: pending.length,
    confirmed: 0,
    evidencePushed: 0,
    evidenceFailed: 0,
    skippedNoCandidate: 0,
    skippedRpcUnavailable: 0,
    scannedAt: new Date().toISOString(),
  }

  for (const intent of pending) {
    const expected = expectedSettlementTransferFor(intent)
    // The eligibility query guarantees created_at IS NOT NULL, so a null
    // window is unreachable in practice — and must never be guessed if it
    // somehow appears.
    if (!expected) continue

    const discovery = await discoverSettlementTransferHash(expected)
    if (discovery.status !== 'found') {
      if (discovery.status === 'rpc_unavailable') report.skippedRpcUnavailable++
      else report.skippedNoCandidate++
      continue
    }

    let completion: ObservedSettlementCompletion
    try {
      completion = await completeObservedErc7710Settlement(intent, discovery.txHash)
    } catch (err) {
      log.warn(
        {
          scope: SCOPE,
          intentId: intent.id,
          agentId: intent.agent_id,
          err: err instanceof Error ? err.message : String(err),
        },
        'erc7710 settlement observation failed for intent — left submitted, will retry next tick',
      )
      continue
    }

    if (!completion.confirmed) continue // raced / refused — silent, retry next tick

    report.confirmed++
    if (completion.evidencePushed) {
      report.evidencePushed++
      log.info(
        {
          scope: SCOPE,
          intentId: intent.id,
          agentId: intent.agent_id,
          chainId: intent.chain_id,
          txHash: discovery.txHash,
        },
        'erc7710 settlement observed and completed — payment confirmed, evidence recorded, Fortnox feed fired',
      )
    } else if (completion.evidenceFailed) {
      report.evidenceFailed++
      log.warn(
        {
          scope: SCOPE,
          intentId: intent.id,
          agentId: intent.agent_id,
          txHash: discovery.txHash,
          err: completion.refusedReason,
        },
        'erc7710 settlement observed and confirmed, but the evidence push failed — no machine_payment_evidence row (backfill gap owner)',
      )
    } else {
      log.info(
        {
          scope: SCOPE,
          intentId: intent.id,
          agentId: intent.agent_id,
          txHash: discovery.txHash,
        },
        'erc7710 settlement observed and confirmed — intent could not be reloaded for evidence',
      )
    }
  }

  log.info(
    {
      scope: SCOPE,
      pending: report.pending,
      confirmed: report.confirmed,
      evidencePushed: report.evidencePushed,
      skippedNoCandidate: report.skippedNoCandidate,
      skippedRpcUnavailable: report.skippedRpcUnavailable,
    },
    'erc7710 settlement observer scan complete',
  )

  return report
}
