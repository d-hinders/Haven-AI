/**
 * Machine-payment agent attribution, extracted verbatim from
 * `routes/transactions.ts` (#992). Data access goes through
 * `infra/repositories/transaction-history.ts` (#985 convention).
 */
import { machinePaymentLifecycle } from '../../lib/machine-payment-lifecycle.js'
import {
  findApprovalRequestAgentMatches,
  findDelegateSweepAgentMatches,
  findPaymentIntentAgentMatches,
} from '../../infra/repositories/transaction-history.js'
import { paymentAgentIdentityKey } from './ordering.js'
import type { EnrichedTransaction } from './types.js'

export async function enrichTransactionsWithAgents(
  userId: string,
  transactions: EnrichedTransaction[],
): Promise<EnrichedTransaction[]> {
  const txHashes = Array.from(
    new Set(transactions.map((tx) => tx.hash.toLowerCase())),
  )
  const safeIds = Array.from(
    new Set(transactions.map((tx) => tx.safeId).filter(Boolean)),
  )
  if (txHashes.length === 0 || safeIds.length === 0) return transactions

  try {
    const piRows = await findPaymentIntentAgentMatches(txHashes, userId, safeIds)

    const agentByTransactionIdentity = new Map<
      string,
      {
        id: string
        name: string
        source: string | null
        resourceUrl: string | null
        merchantAddress: string | null
        paymentId: string
        paymentProofStatus: string | null
        paymentFlowStatus: string | null
        paymentAttentionReason: string | null
        activityType?: 'delegate_sweep'
        amountSek: string | null
      }
    >()
    for (const row of piRows) {
      const lifecycle = machinePaymentLifecycle({
        rail: row.source,
        paymentProofStatus: row.payment_proof_status,
        reconciliationEventType: row.payment_reconciliation_event_type,
      })
      agentByTransactionIdentity.set(
        paymentAgentIdentityKey(row.tx_hash, row.safe_id, row.chain_id),
        {
          id: row.agent_id,
          name: row.agent_name,
          source: row.source,
          resourceUrl: row.payment_resource_url,
          merchantAddress: row.merchant_address,
          paymentId: row.id,
          paymentProofStatus: row.payment_proof_status,
          paymentFlowStatus: lifecycle.paymentFlowStatus,
          paymentAttentionReason: lifecycle.paymentAttentionReason,
          amountSek: row.amount_sek,
        },
      )
    }

    const approvalRows = await findApprovalRequestAgentMatches(txHashes, userId, safeIds)

    for (const row of approvalRows) {
      const identityKey = paymentAgentIdentityKey(
        row.tx_hash,
        row.safe_id,
        row.chain_id,
      )
      if (agentByTransactionIdentity.has(identityKey)) continue
      const proofStatus = row.payment_proof_status ?? 'payment_confirmed'
      const lifecycle = machinePaymentLifecycle({
        rail: row.source,
        paymentProofStatus: proofStatus,
        reconciliationEventType: row.payment_reconciliation_event_type,
      })
      agentByTransactionIdentity.set(identityKey, {
        id: row.agent_id,
        name: row.agent_name,
        source: row.source,
        resourceUrl: row.payment_resource_url,
        merchantAddress: row.merchant_address,
        paymentId: row.id,
        paymentProofStatus: proofStatus,
        paymentFlowStatus: lifecycle.paymentFlowStatus,
        paymentAttentionReason: lifecycle.paymentAttentionReason,
        amountSek: row.amount_sek,
      })
    }

    const sweepRows = await findDelegateSweepAgentMatches(txHashes, userId, safeIds)

    for (const row of sweepRows) {
      agentByTransactionIdentity.set(
        paymentAgentIdentityKey(row.tx_hash, row.safe_id, row.chain_id),
        {
          id: row.agent_id,
          name: row.agent_name,
          source: null,
          resourceUrl: null,
          merchantAddress: null,
          paymentId: row.id,
          paymentProofStatus: null,
          paymentFlowStatus: null,
          paymentAttentionReason: null,
          activityType: 'delegate_sweep',
          amountSek: null,
        },
      )
    }

    return transactions.map((tx) => {
      const agent = agentByTransactionIdentity.get(
        paymentAgentIdentityKey(tx.hash, tx.safeId, tx.chainId),
      )
      return {
        ...tx,
        agentId: agent?.id ?? tx.agentId,
        agentName: agent?.name ?? tx.agentName,
        source: agent?.source ?? tx.source,
        x402ResourceUrl: agent?.resourceUrl ?? tx.x402ResourceUrl,
        x402MerchantAddress: agent?.merchantAddress ?? tx.x402MerchantAddress,
        paymentId: agent?.paymentId ?? tx.paymentId,
        paymentProofStatus: agent?.paymentProofStatus ?? tx.paymentProofStatus,
        paymentFlowStatus: agent?.paymentFlowStatus ?? tx.paymentFlowStatus,
        paymentAttentionReason: agent?.paymentAttentionReason ?? tx.paymentAttentionReason,
        activityType: agent?.activityType ?? tx.activityType,
        amountSek: agent?.amountSek ?? tx.amountSek,
      }
    })
  } catch {
    return transactions
  }
}
