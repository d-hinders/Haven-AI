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
import { convertedTransactionAmount } from './currency.js'
import { DEFAULT_TRANSACTION_CURRENCY, type TransactionCurrency } from '../../domain/transaction-currency.js'
import type { EnrichedTransaction } from './types.js'

/**
 * `currency` is the user's preference (#3127) — read by the caller (the route,
 * per request) and applied here, at the LAST step before a row reaches the
 * wire, so the converted triple is computed over the fully attributed row
 * exactly once. Defaults to SEK: a caller that has not converted (internal
 * callers, and the historical signature) keeps today's shape.
 */
export async function enrichTransactionsWithAgents(
  userId: string,
  transactions: EnrichedTransaction[],
  currency: TransactionCurrency = DEFAULT_TRANSACTION_CURRENCY,
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
        fxRates: Record<string, number> | null
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
          fxRates: row.fx_rates,
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
          fxRates: null,
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
        fxRates: agent?.fxRates ?? tx.fxRates,
        // #3127: the converted triple rides every enriched row — the user's
        // preference applied HERE, after attribution, so a pre-attributed
        // confirmed x402 row and a match-merged one carry it alike. The
        // token amount is the row's own `valueFormatted` (the same figure
        // `ledgerAmount` multiplies); SEK never re-derives from it.
        ...convertedTransactionAmount(
          agent?.amountSek ?? tx.amountSek,
          tx.valueFormatted,
          agent?.fxRates ?? tx.fxRates,
          currency,
        ),
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
