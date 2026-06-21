import pool from '../db.js'
import {
  RECEIPT_VERSION,
  verifyPaymentReceipt,
  type PaymentReceipt,
  type ReceiptVerification,
} from '@haven_ai/sdk'

/**
 * Backend wiring for verifiable payment receipts (non-custody design P2, #479).
 *
 * The receipt shape and the independent verifier live in `@haven_ai/sdk` (so
 * agents/users can verify client-side with zero Haven trust); this module only
 * adds the DB-specific assembly. Re-exported here for callers in the backend.
 */
export { RECEIPT_VERSION, verifyPaymentReceipt }
export type { PaymentReceipt, ReceiptVerification }

export interface PaymentReceiptRow {
  id: string
  safe_address: string
  chain_id: number
  token_symbol: string
  token_address: string
  to_address: string
  amount_human: string
  delegate_address: string
  sign_hash: string
  signature: string | null
  tx_hash: string | null
  confirmed_at: string | null
  resource_url: string | null
  amount_sek: string | null
}

/** Pure mapping DB row → receipt bundle. */
export function buildPaymentReceipt(row: PaymentReceiptRow): PaymentReceipt {
  return {
    version: RECEIPT_VERSION,
    paymentId: row.id,
    payment: {
      token: row.token_symbol,
      tokenAddress: row.token_address,
      amount: row.amount_human,
      amountSek: row.amount_sek,
      recipient: row.to_address,
      safe: row.safe_address,
      chainId: row.chain_id,
      settledAt: row.confirmed_at,
      resourceUrl: row.resource_url,
    },
    authorization: {
      delegate: row.delegate_address,
      signHash: row.sign_hash,
      signature: row.signature,
    },
    onChain: { txHash: row.tx_hash, chainId: row.chain_id },
  }
}

/** Load a settled payment's receipt for the owning agent. Null if not found. */
export async function getPaymentReceipt(
  paymentId: string,
  agentId: string,
): Promise<PaymentReceipt | null> {
  const result = await pool.query<PaymentReceiptRow>(
    `SELECT pi.id, pi.safe_address, pi.chain_id, pi.token_symbol, pi.token_address,
            pi.to_address, pi.amount_human, pi.delegate_address, pi.sign_hash,
            pi.signature, pi.tx_hash, pi.confirmed_at,
            mpe.resource_url AS resource_url,
            mpe.amount_sek AS amount_sek
     FROM payment_intents pi
     LEFT JOIN machine_payment_evidence mpe ON mpe.payment_intent_id = pi.id
     WHERE pi.id = $1 AND pi.agent_id = $2 AND pi.status = 'confirmed'`,
    [paymentId, agentId],
  )
  const row = result.rows[0]
  return row ? buildPaymentReceipt(row) : null
}
