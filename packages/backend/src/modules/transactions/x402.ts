/**
 * Confirmed x402 funding → merchant-facing transaction normalization,
 * extracted verbatim from `routes/transactions.ts` (#992). Data access goes
 * through `infra/repositories/transaction-history.ts` (#985 convention).
 */
import { getChain } from '../../domain/chains.js'
import { machinePaymentLifecycle } from '../../domain/machine-payment-lifecycle.js'
import {
  findConfirmedX402PaymentIntents,
} from '../../infra/repositories/transaction-history.js'
import { toCanonicalAddress } from './normalize.js'
import { parseIsoTimestamp, paymentAgentIdentityKey } from './ordering.js'
import type { EnrichedTransaction, SmartAccountRow } from './types.js'

function x402FundingIdentityKey(tx: EnrichedTransaction): string {
  return paymentAgentIdentityKey(tx.hash, tx.accountId, tx.chainId)
}

export async function fetchConfirmedX402Transactions(
  userId: string,
  accounts: SmartAccountRow[],
): Promise<EnrichedTransaction[]> {
  if (accounts.length === 0) return []

  const accountIds = accounts.map((account) => account.id)
  const paymentIntentRows = await findConfirmedX402PaymentIntents(userId, accountIds)
  // #2055: the approval-request half of x402 history is gone with the table
  // (queue-history readability waived, owner decision on #2021).

  const paymentIntentTransactions: EnrichedTransaction[] = paymentIntentRows.map((row) => {
    const chain = getChain(row.chain_id)
    const tokenAddress = row.token_address.toLowerCase()
    const tokenConfig =
      chain.tokenByAddress[tokenAddress] ??
      Object.values(chain.tokens).find((token) => token.symbol === row.token_symbol)
    const merchantAddress = row.x402_merchant_address ?? row.to_address
    // #3132: recorded or null, never a placeholder. `payment_proof_status`
    // arrives through a LEFT JOIN on machine_payment_evidence, so a confirmed
    // payment with no evidence row has NO proof status — reporting
    // 'payment_confirmed' here presented a value that was never read as a
    // recorded one, and disagreed with enrichment.ts, which passes the same
    // column through unchanged. The lifecycle below lands on the same
    // `confirming_merchant` for null as it did for the placeholder, so no
    // flow status moves; only the fabricated field does.
    const proofStatus = row.payment_proof_status ?? null
    const lifecycle = machinePaymentLifecycle({
      rail: 'x402',
      paymentProofStatus: proofStatus,
      reconciliationEventType: row.payment_reconciliation_event_type,
    })

    return {
      hash: row.tx_hash,
      type: 'erc20',
      from: toCanonicalAddress(row.account_address),
      to: toCanonicalAddress(merchantAddress),
      value: row.amount_raw,
      valueFormatted: row.amount_human,
      asset: row.token_symbol,
      decimals: tokenConfig?.decimals ?? 18,
      direction: 'out',
      // #3132: the fallback to `created_at` stays (the field is a non-null
      // unix-seconds sort key every consumer reads) but it is MARKED, not
      // hidden: `timestampSource` says which column produced it, and
      // `confirmedAt` carries the recorded confirmation time or null — the
      // same nullable value the receipts view reports.
      timestamp: parseIsoTimestamp(row.confirmed_at ?? row.created_at),
      timestampSource: row.confirmed_at ? 'confirmed_at' : 'created_at',
      confirmedAt: row.confirmed_at ?? null,
      // #3129: `null`, not `0`. This row is SYNTHESIZED from a payment intent
      // and no block number is stored anywhere — there is no `block_number`
      // column in any migration — so `0` was a placeholder meaning "unknown"
      // that read as a real block. The zero was not a failed `parseInt`: the
      // explorer legs in `aggregate.ts` do populate this field — on Base, the
      // default chain, `V2Transaction.block_number` is non-optional, so the
      // Blockscout leg cannot produce a zero. (The Etherscan-shaped Gnosis leg
      // is unvalidated passthrough, which is what `toBlockNumber` now guards;
      // that is a different, narrower case.) Every row in the 2026-09-18 field
      // run read zero because all five were payments — this path.
      blockNumber: null,
      isError: false,
      tokenAddress: toCanonicalAddress(row.token_address),
      tokenSymbol: row.token_symbol,
      source: 'x402',
      x402ResourceUrl: row.x402_resource_url,
      x402MerchantAddress: toCanonicalAddress(row.x402_merchant_address),
      chainId: row.chain_id,
      accountId: row.account_id,
      accountAddress: toCanonicalAddress(row.account_address),
      accountName: row.account_name,
      agentId: row.agent_id,
      agentName: row.agent_name,
      paymentId: row.id,
      paymentProofStatus: proofStatus,
      paymentFlowStatus: lifecycle.paymentFlowStatus,
      paymentAttentionReason: lifecycle.paymentAttentionReason,
      amountSek: row.amount_sek,
      fxRateSek: row.fx_rate_sek,
      fxSource: row.fx_source,
      fxRates: row.fx_rates,
      settlementScheme: row.settlement_scheme,
      // #2097: confirmed x402 rows are agent-attributed by construction (the
      // SQL joins `agents`), so the initiator record is always 'agent'.
      initiatedBy: 'agent',
    }
  })

  return paymentIntentTransactions
}

export async function mergeX402Transactions(
  userId: string,
  accounts: SmartAccountRow[],
  transactions: EnrichedTransaction[],
): Promise<EnrichedTransaction[]> {
  const x402Transactions = await fetchConfirmedX402Transactions(userId, accounts)
  if (x402Transactions.length === 0) return transactions

  const x402FundingKeys = new Set(
    x402Transactions.map(x402FundingIdentityKey),
  )

  return [
    ...transactions.filter(
      (tx) => !x402FundingKeys.has(x402FundingIdentityKey(tx)),
    ),
    ...x402Transactions,
  ]
}
