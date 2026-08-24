/**
 * Confirmed x402 funding → merchant-facing transaction normalization,
 * extracted verbatim from `routes/transactions.ts` (#992). Data access goes
 * through `infra/repositories/transaction-history.ts` (#985 convention).
 */
import { getChain } from '../../domain/chains.js'
import { machinePaymentLifecycle } from '../../domain/machine-payment-lifecycle.js'
import {
  findConfirmedX402ApprovalRequests,
  findConfirmedX402PaymentIntents,
} from '../../infra/repositories/transaction-history.js'
import { parseIsoTimestamp, paymentAgentIdentityKey } from './ordering.js'
import type { EnrichedTransaction, UserSafeRow } from './types.js'

function x402FundingIdentityKey(tx: EnrichedTransaction): string {
  return paymentAgentIdentityKey(tx.hash, tx.safeId, tx.chainId)
}

export async function fetchConfirmedX402Transactions(
  userId: string,
  safes: UserSafeRow[],
): Promise<EnrichedTransaction[]> {
  if (safes.length === 0) return []

  const safeIds = safes.map((safe) => safe.id)
  const paymentIntentRows = await findConfirmedX402PaymentIntents(userId, safeIds)
  const approvalRows = await findConfirmedX402ApprovalRequests(userId, safeIds)

  const paymentIntentTransactions: EnrichedTransaction[] = paymentIntentRows.map((row) => {
    const chain = getChain(row.chain_id)
    const tokenAddress = row.token_address.toLowerCase()
    const tokenConfig =
      chain.tokenByAddress[tokenAddress] ??
      Object.values(chain.tokens).find((token) => token.symbol === row.token_symbol)
    const merchantAddress = row.x402_merchant_address ?? row.to_address
    const proofStatus = row.payment_proof_status ?? 'payment_confirmed'
    const lifecycle = machinePaymentLifecycle({
      rail: 'x402',
      paymentProofStatus: proofStatus,
      reconciliationEventType: row.payment_reconciliation_event_type,
    })

    return {
      hash: row.tx_hash,
      type: 'erc20',
      from: row.safe_address,
      to: merchantAddress,
      value: row.amount_raw,
      valueFormatted: row.amount_human,
      asset: row.token_symbol,
      decimals: tokenConfig?.decimals ?? 18,
      direction: 'out',
      timestamp: parseIsoTimestamp(row.confirmed_at ?? row.created_at),
      blockNumber: 0,
      isError: false,
      tokenAddress: row.token_address,
      tokenSymbol: row.token_symbol,
      source: 'x402',
      x402ResourceUrl: row.x402_resource_url,
      x402MerchantAddress: row.x402_merchant_address,
      chainId: row.chain_id,
      safeId: row.safe_id,
      safeAddress: row.safe_address,
      safeName: row.safe_name,
      agentId: row.agent_id,
      agentName: row.agent_name,
      paymentId: row.id,
      paymentProofStatus: proofStatus,
      paymentFlowStatus: lifecycle.paymentFlowStatus,
      paymentAttentionReason: lifecycle.paymentAttentionReason,
      amountSek: row.amount_sek,
      settlementScheme: row.settlement_scheme,
    }
  })

  const approvalTransactions = approvalRows.map((row) => {
    const chain = getChain(row.chain_id)
    const tokenAddress = row.token_address.toLowerCase()
    const tokenConfig =
      chain.tokenByAddress[tokenAddress] ??
      Object.values(chain.tokens).find((token) => token.symbol === row.token_symbol)
    const merchantAddress = row.merchant_address ?? row.to_address
    const proofStatus = row.payment_proof_status ?? 'payment_confirmed'
    const lifecycle = machinePaymentLifecycle({
      rail: 'x402',
      paymentProofStatus: proofStatus,
      reconciliationEventType: row.payment_reconciliation_event_type,
    })

    return {
      hash: row.tx_hash,
      type: 'erc20' as const,
      from: row.safe_address,
      to: merchantAddress,
      value: row.amount_raw,
      valueFormatted: row.amount_human,
      asset: row.token_symbol,
      decimals: tokenConfig?.decimals ?? 18,
      direction: 'out' as const,
      timestamp: parseIsoTimestamp(row.executed_at ?? row.created_at),
      blockNumber: 0,
      isError: false,
      tokenAddress: row.token_address,
      tokenSymbol: row.token_symbol,
      source: 'x402',
      x402ResourceUrl: row.payment_resource_url,
      x402MerchantAddress: row.merchant_address,
      chainId: row.chain_id,
      safeId: row.safe_id,
      safeAddress: row.safe_address,
      safeName: row.safe_name,
      agentId: row.agent_id,
      agentName: row.agent_name,
      paymentId: row.id,
      paymentProofStatus: proofStatus,
      paymentFlowStatus: lifecycle.paymentFlowStatus,
      paymentAttentionReason: lifecycle.paymentAttentionReason,
      amountSek: row.amount_sek,
      settlementScheme: row.settlement_scheme,
    }
  })

  return [...paymentIntentTransactions, ...approvalTransactions]
}

export async function mergeX402Transactions(
  userId: string,
  safes: UserSafeRow[],
  transactions: EnrichedTransaction[],
): Promise<EnrichedTransaction[]> {
  const x402Transactions = await fetchConfirmedX402Transactions(userId, safes)
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
