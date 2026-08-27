/**
 * The scheme-agnostic settlement-completion seam for erc7710 (#2092).
 *
 * ## The gap this closes
 *
 * On EIP-3009 (both rails) Haven submits a transaction, so it learns the hash
 * and flips the intent to `confirmed` itself. On erc7710 direct settlement the
 * MERCHANT redeems the delegation chain and Haven submits nothing, so
 * `POST /x402/:id/settle` left the intent at `submitted` forever. Everything
 * downstream is keyed on `confirmed` + `tx_hash`:
 * `recordMachinePaymentEvidenceBase` (book-time FX, the fee-ledger row, and
 * `feedSettledPaymentBestEffort`), `GET /receipts`, merchant-receipt capture,
 * and dashboard transaction history. A whole settlement scheme was therefore
 * absent from the Fortnox reporting feed.
 *
 * ## Shape: one seam, not one branch per consumer
 *
 * The fix is deliberately NOT "teach the feed / receipts / history about
 * schemes". It is a single pre-step in front of the existing evidence attach:
 * when the reported payment is a `submitted` erc7710 intent, verify the
 * reported hash on-chain and complete the intent. From that instant the intent
 * is indistinguishable from a 3009 one, and every consumer keeps exactly one
 * code path. The agent-facing contract is unchanged too — the SDK already
 * posts `POST /machine-payments/evidence` with a `txHash`; on erc7710 that
 * hash is simply the merchant's settlement transaction rather than Haven's
 * funding transaction.
 *
 * ## Trust
 *
 * The reported hash is CLIENT INPUT and this path ends in the user's
 * bookkeeping, so it is verified against the chain — see
 * `infra/chain/settlement-transfer-verifier.ts` for the full statement of what
 * is and is not verified. **Fail closed:** anything short of `verified` leaves
 * the intent `submitted`, and an unreachable RPC is reported as retryable
 * rather than being allowed to become either a confirmation or a rejection.
 */
import {
  confirmObservedSettlement,
  type Executor,
} from '../../infra/repositories/x402-authorizations.js'
import { verifySettlementTransferTx } from '../../infra/chain/settlement-transfer-verifier.js'
import { getFiatValuesForTokenAmount } from '../../infra/fiat-values.js'
import { MAX_SETTLEMENT_WINDOW_SECONDS } from './x402-delegation.js'

/**
 * Clock-skew allowance between Postgres' `created_at` and the chain's block
 * timestamps. Generous on purpose: this bound exists to EXCLUDE settlements
 * from unrelated windows, so widening it costs a little precision, while
 * narrowing it could reject a genuine payment — which on this path means
 * silently dropping it out of the user's bookkeeping.
 */
const CLOCK_SKEW_SECONDS = 120

/**
 * How far apart two intents' `created_at` values can be and still have
 * OVERLAPPING settlement windows — the reach the ambiguity guard must have.
 *
 * The arithmetic matters and is easy to get wrong. A window is asymmetric
 * about its own authorize time `t`: `[t - skew, t + M + skew]`. Two such
 * windows around `t1 <= t2` intersect exactly when
 * `t2 - skew <= t1 + M + skew`, i.e. when `t2 - t1 <= M + 2 * skew`. Using
 * `M + skew` (the window's own forward reach) leaves a `skew`-wide band of
 * genuinely-overlapping look-alikes the guard would not see — which is the
 * mis-attribution this whole guard exists to prevent. Pinned by the two
 * `BOUNDARY:` tests in
 * `modules/mpp/__tests__/erc7710-settlement-evidence.test.ts`, which run
 * through this seam so they exercise THIS constant rather than a copy of it —
 * one at `Δt` inside the overlap but past `M + skew`, one past the overlap.
 */
export const AMBIGUITY_WINDOW_SECONDS = MAX_SETTLEMENT_WINDOW_SECONDS + 2 * CLOCK_SKEW_SECONDS

/** The intent fields this seam needs; a structural subset of the evidence source row. */
export interface ObservableSettlementIntent {
  id: string
  agent_id: string
  chain_id: number
  safe_address: string
  to_address: string
  token_symbol: string
  token_address: string
  amount_raw: string
  amount_human: string
  status: string
  tx_hash: string | null
  /**
   * #2094: the settlement child's hash, stored at authorize time. Intent-unique
   * since the child is salted from the intent id, so the DelegationManager's
   * `RedeemedDelegation` log can name THIS payment rather than its shape.
   * Optional because a pre-#2094 row may not carry one, in which case
   * verification falls back to transfer shape + window and the ambiguity guard
   * keeps its original reach.
   */
  delegation_hash?: string | null
  /** Authorize time — the origin of this intent's settlement window. */
  created_at?: string | null
  source?: string | null
  payment_rail?: string | null
  execution_rail?: string | null
  machine_metadata?: Record<string, unknown> | string | null
}

export type SettlementObservation =
  /**
   * The intent is now `confirmed` with the reported hash. `delegationBound`
   * reports whether the pinned DelegationManager's own `RedeemedDelegation`
   * log named THIS intent's settlement child (verifier check 8) — i.e. whether
   * the attribution rested on on-chain identity or only on transfer shape.
   */
  | { outcome: 'confirmed'; delegationBound: boolean }
  /** Not a pending erc7710 settlement — the caller's existing gates apply unchanged. */
  | { outcome: 'not_applicable' }
  /** Refused. `retryable` distinguishes "ask again later" from a settled no. */
  | { outcome: 'unverified'; retryable: boolean; reason: string }

function settlementSchemeOf(intent: ObservableSettlementIntent): string | null {
  const raw = intent.machine_metadata
  if (!raw) return null
  let metadata: Record<string, unknown> | null = null
  if (typeof raw === 'string') {
    try {
      metadata = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return null
    }
  } else {
    metadata = raw
  }
  const scheme = metadata?.settlement_scheme
  return typeof scheme === 'string' ? scheme : null
}

/**
 * True only for the one lifecycle that legitimately sits at `submitted` with
 * no hash and can still be completed: an x402 delegation-rail erc7710 intent.
 *
 * Every other combination returns false, which is what keeps eip3009 and the
 * legacy rail on exactly the transitions they already had.
 */
export function isPendingErc7710Settlement(intent: ObservableSettlementIntent): boolean {
  return (
    intent.status === 'submitted' &&
    !intent.tx_hash &&
    (intent.payment_rail ?? intent.source) === 'x402' &&
    intent.execution_rail === 'delegation' &&
    settlementSchemeOf(intent) === 'erc7710'
  )
}

/**
 * Complete a `submitted` erc7710 intent from an agent-reported settlement tx
 * hash, after verifying that hash on-chain.
 *
 * Order matters and is the integrity boundary: VERIFY, then write. Nothing
 * touches the row until the chain has confirmed the transfer really happened,
 * from this account, to this merchant, for this exact amount, in this token.
 */
export interface ObserveSettlementOptions {
  /**
   * Refuse to confirm unless verifier check 8 BOUND this transaction to this
   * intent's own settlement child (#2117).
   *
   * Off for the agent-reported path, which is unchanged: there the agent named
   * one transaction for one payment, checks 1–7 plus the database's replay and
   * ambiguity guards carry the attribution, and a facilitator route that emits
   * no decodable manager log still completes.
   *
   * ON for the passive sweeper, and non-negotiably so. The sweeper searched a
   * whole window of open intents for a transaction nobody reported, so "a
   * transfer of the right shape inside the right window" is not evidence of
   * WHICH payment it settled — it is exactly the coin flip that would put a
   * confidently wrong row in someone's books. A missing row surfaces at
   * reconciliation; a wrong one does not. So the sweep confirms only what the
   * manager itself named, and there is deliberately no transfer-shape fallback
   * behind this flag.
   */
  requireDelegationBound?: boolean
}

export async function observeErc7710Settlement(
  intent: ObservableSettlementIntent,
  txHash: string,
  db?: Executor,
  options: ObserveSettlementOptions = {},
): Promise<SettlementObservation> {
  if (!isPendingErc7710Settlement(intent)) return { outcome: 'not_applicable' }

  // The settlement window: the child delegation's `timestamp` caveat is
  // enforced on-chain and can never exceed `authorize + MAX_SETTLEMENT_WINDOW_SECONDS`,
  // so a genuine settlement of THIS child is mined inside this span. Bounding
  // by the maximum rather than by the intent's own `maxTimeoutSeconds` keeps
  // the check derived from a construction invariant instead of from a value
  // parsed back out of `prepared_user_op`, and can only ever be MORE permissive.
  const authorizeSec = Math.floor(new Date(intent.created_at ?? '').getTime() / 1000)
  if (!Number.isFinite(authorizeSec)) {
    // No authorize time means no window, and no window means check 7 — the only
    // intent-specific check — cannot run. Refuse rather than substitute a
    // wall-clock "now": a window around the wrong anchor is worse than none,
    // because it would silently pass a settlement from an unrelated payment.
    return {
      outcome: 'unverified',
      retryable: false,
      reason: 'The payment has no authorize time, so its settlement window cannot be established',
    }
  }

  const verification = await verifySettlementTransferTx(txHash, {
    chainId: intent.chain_id,
    tokenAddress: intent.token_address,
    fromAddress: intent.safe_address,
    toAddress: intent.to_address,
    amountRaw: intent.amount_raw,
    notBeforeSec: authorizeSec - CLOCK_SKEW_SECONDS,
    notAfterSec: authorizeSec + MAX_SETTLEMENT_WINDOW_SECONDS + CLOCK_SKEW_SECONDS,
    // #2094: lets the verifier run check 8 — re-hash the DelegationManager's
    // emitted `Delegation` struct and require it to equal THIS intent's child.
    delegationHash: intent.delegation_hash ?? null,
  })

  if (verification.outcome !== 'verified') {
    // Fail closed. `rpc_unavailable` and a not-yet-mined transaction are the
    // only retryable refusals; a revert or a mismatch is a settled no. In no
    // case does the intent move.
    return {
      outcome: 'unverified',
      retryable:
        verification.outcome === 'rpc_unavailable' || verification.outcome === 'not_found',
      reason: verification.reason,
    }
  }

  if (options.requireDelegationBound && !verification.delegationBound) {
    // Checks 1–7 passed: a transfer of exactly this shape really happened
    // inside this intent's window. That is still not an answer to "which
    // payment", and this caller asked for an answer to that question. Refuse
    // BEFORE anything is written — the guard has to sit here, ahead of the
    // confirm, because after the row moves there is nothing left to refuse.
    //
    // Not retryable-as-in-transient, but not terminal either: the caller sweeps
    // again and this intent simply stays unattributable, which is the residual
    // #2096 already documents and this flag preserves rather than papers over.
    return {
      outcome: 'unverified',
      retryable: false,
      reason:
        `Transaction ${txHash} matches this payment's transfer shape and window, but the ` +
        'DelegationManager did not name this payment\'s settlement child — passive ' +
        'observation will not attribute a settlement on shape alone',
    }
  }

  // Parity with the 3009 confirm in `routes/payments.ts`: stamp spot USD/EUR
  // alongside the hash. Best-effort by construction — `getFiatValuesForTokenAmount`
  // returns nulls on a pricing outage rather than throwing, and book-time SEK
  // (the value the Fortnox feed actually uses) is captured separately and
  // frozen by `recordMachinePaymentEvidenceBase`.
  const fiat = await getFiatValuesForTokenAmount(intent.token_symbol, intent.amount_human)

  const confirmed = await confirmObservedSettlement(
    {
      txHash,
      intentId: intent.id,
      agentId: intent.agent_id,
      usdValue: fiat.usd,
      eurValue: fiat.eur,
      windowSeconds: AMBIGUITY_WINDOW_SECONDS,
      // #2094: only a settlement the pinned DelegationManager itself bound to
      // THIS intent's child may narrow the ambiguity guard past look-alikes.
      // Everything else — a pre-#2094 child, an unpinned chain, a facilitator
      // route with no decodable manager log — keeps #2096's original reach.
      delegationBound: verification.delegationBound,
    },
    db,
  )

  if (!confirmed) {
    // The guarded UPDATE matched nothing. Three causes, all leaving this intent
    // exactly as it was: the row moved under us (another report won the CAS),
    // the replay guard refused because this transaction already confirms a
    // different intent, or the ambiguity guard refused because a look-alike
    // open intent means Haven cannot tell which purchase this settlement paid
    // for. Refuse rather than guess which.
    //
    // Deliberately NOT distinguished into three outcomes: telling them apart
    // needs a second read after the failed UPDATE, and that read races the
    // very state the UPDATE just lost — it could only ever report what was
    // true a moment later. All three are the same answer to the caller (this
    // payment was not confirmed, and reporting the same hash again will not
    // change that), so the message names all three rather than asserting one.
    return {
      outcome: 'unverified',
      retryable: false,
      reason:
        'The settlement could not be recorded: the payment changed state, this transaction ' +
        'already confirms a different payment, or another open payment of the same shape ' +
        'means this settlement cannot be attributed unambiguously',
    }
  }

  return { outcome: 'confirmed', delegationBound: verification.delegationBound }
}
