/**
 * Machine-payment agent attribution, extracted verbatim from
 * `routes/transactions.ts` (#992). Data access goes through
 * `infra/repositories/transaction-history.ts` (#985 convention).
 */
import { machinePaymentLifecycle } from '../../domain/machine-payment-lifecycle.js'
import {
  findDelegateSweepAgentMatches,
  findPaymentIntentAgentMatches,
} from '../../infra/repositories/transaction-history.js'
import { toCanonicalAddress } from './normalize.js'
import { paymentAgentIdentityKey } from './ordering.js'
import type { EnrichedTransaction } from './types.js'

export async function enrichTransactionsWithAgents(
  userId: string,
  transactions: EnrichedTransaction[],
): Promise<EnrichedTransaction[]> {
  const txHashes = Array.from(
    new Set(transactions.map((tx) => tx.hash.toLowerCase())),
  )
  const accountIds = Array.from(
    new Set(transactions.map((tx) => tx.accountId).filter(Boolean)),
  )
  if (txHashes.length === 0 || accountIds.length === 0) return transactions

  try {
    const piRows = await findPaymentIntentAgentMatches(txHashes, userId, accountIds)

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
        fxRateSek: string | null
        fxSource: string | null
        settlementScheme?: string | null
      }
    >()
    for (const row of piRows) {
      const lifecycle = machinePaymentLifecycle({
        rail: row.source,
        paymentProofStatus: row.payment_proof_status,
        reconciliationEventType: row.payment_reconciliation_event_type,
      })
      agentByTransactionIdentity.set(
        paymentAgentIdentityKey(row.tx_hash, row.account_id, row.chain_id),
        {
          id: row.agent_id,
          name: row.agent_name,
          source: row.source,
          resourceUrl: row.payment_resource_url,
          // #3129: normalised HERE, where the DB row enters, for the same
          // reason `aggregate.ts` and `x402.ts` normalise at their
          // boundaries — this value OVERWRITES the row's already-canonical
          // `x402MerchantAddress` below, so leaving it raw would put the
          // mixed casing back after the boundary had settled it.
          merchantAddress: toCanonicalAddress(row.merchant_address),
          paymentId: row.id,
          paymentProofStatus: row.payment_proof_status,
          paymentFlowStatus: lifecycle.paymentFlowStatus,
          paymentAttentionReason: lifecycle.paymentAttentionReason,
          amountSek: row.amount_sek,
          fxRateSek: row.fx_rate_sek,
          fxSource: row.fx_source,
        },
      )
    }

    // #2055: the approval_requests attribution pass is gone with the table.

    const sweepRows = await findDelegateSweepAgentMatches(txHashes, userId, accountIds)

    for (const row of sweepRows) {
      agentByTransactionIdentity.set(
        paymentAgentIdentityKey(row.tx_hash, row.account_id, row.chain_id),
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
          fxRateSek: null,
          fxSource: null,
        },
      )
    }

    return transactions.map((tx) => {
      const agent = agentByTransactionIdentity.get(
        paymentAgentIdentityKey(tx.hash, tx.accountId, tx.chainId),
      )
      // #2097: the initiator record follows the EFFECTIVE attribution — an
      // agent matched here, or one already on the row (confirmed x402 rows
      // arrive pre-attributed from `mergeX402Transactions`), makes the row
      // 'agent'. An outbound row that stays unattributed is a raw transfer
      // with no matched intent — 'unknown'. Inbound rows carry no initiator
      // record (undefined).
      const attributedAgentId = agent?.id ?? tx.agentId
      return {
        ...tx,
        agentId: attributedAgentId,
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
        fxRateSek: agent?.fxRateSek ?? tx.fxRateSek,
        fxSource: agent?.fxSource ?? tx.fxSource,
        settlementScheme: agent?.settlementScheme ?? tx.settlementScheme,
        initiatedBy: attributedAgentId
          ? 'agent'
          : tx.direction === 'out'
            ? 'unknown'
            : undefined,
      }
    })
  } catch {
    // #2097: on any DB/repo failure the rows are returned UNMODIFIED — a
    // matched agent keeps its agentId/agentName but no `initiatedBy`
    // classification is stamped. Deliberate and fail-soft: the frontend's
    // initiator helper degrades to explicit 'Unknown' on a missing record,
    // never 'You', so an enrichment outage cannot falsely claim a human
    // initiator. The trade is that unknown-vs-agent goes unreported here;
    // keep the two in agreement if this path ever gets a logger.
    return transactions
  }
}
