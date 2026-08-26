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
  source?: string | null
  payment_rail?: string | null
  execution_rail?: string | null
  machine_metadata?: Record<string, unknown> | string | null
}

export type SettlementObservation =
  /** The intent is now `confirmed` with the reported hash. */
  | { outcome: 'confirmed' }
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
export async function observeErc7710Settlement(
  intent: ObservableSettlementIntent,
  txHash: string,
  db?: Executor,
): Promise<SettlementObservation> {
  if (!isPendingErc7710Settlement(intent)) return { outcome: 'not_applicable' }

  const verification = await verifySettlementTransferTx(txHash, {
    chainId: intent.chain_id,
    tokenAddress: intent.token_address,
    fromAddress: intent.safe_address,
    toAddress: intent.to_address,
    amountRaw: intent.amount_raw,
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
    },
    db,
  )

  if (!confirmed) {
    // The guarded UPDATE matched nothing: either the row moved under us
    // (another report won the CAS) or the replay guard refused because this
    // transaction already confirms a different intent. Both leave this intent
    // exactly as it was — refuse rather than guess which.
    return {
      outcome: 'unverified',
      retryable: false,
      reason:
        'The settlement could not be recorded: the payment changed state, or this ' +
        'transaction already confirms a different payment',
    }
  }

  return { outcome: 'confirmed' }
}
