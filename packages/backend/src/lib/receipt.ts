import pool from '../db.js'
import { recoverSigner } from './allowance-module.js'

/**
 * Verifiable payment receipts (non-custody design P2, #479).
 *
 * A self-contained proof bundle for a settled payment that anyone can verify
 * *independently of Haven*. The anchor is the agent delegate's signature over
 * the on-chain transfer hash: recover the signer and confirm it is the agent's
 * delegate, and you have cryptographic proof the agent authorised exactly this
 * transfer — no need to trust Haven's database. The on-chain `txHash` is the
 * settlement source of truth (verify on any explorer).
 */
export const RECEIPT_VERSION = 'haven-receipt-1'

export interface PaymentReceipt {
  version: typeof RECEIPT_VERSION
  paymentId: string
  payment: {
    token: string
    tokenAddress: string
    amount: string
    amountSek: string | null
    recipient: string
    safe: string
    chainId: number
    settledAt: string | null
    resourceUrl: string | null
  }
  /** The agent's cryptographic authorisation — what makes the receipt verifiable. */
  authorization: {
    delegate: string
    signHash: string
    signature: string | null
  }
  onChain: {
    txHash: string | null
    chainId: number
  }
}

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

export type ReceiptVerification =
  | { verified: true; recoveredSigner: string }
  | { verified: false; reason: 'missing_signature' | 'bad_signature' | 'signer_mismatch'; recoveredSigner?: string }

/**
 * Verify a receipt independently: recover the signer from the authorisation and
 * confirm it is the agent's delegate. Pure — `recover` is injected (defaults to
 * the standard ECDSA recovery) so this can run anywhere, including outside Haven.
 */
export function verifyPaymentReceipt(
  receipt: PaymentReceipt,
  recover: (hash: string, signature: string) => string = recoverSigner,
): ReceiptVerification {
  const { delegate, signHash, signature } = receipt.authorization
  if (!signature) return { verified: false, reason: 'missing_signature' }

  let recovered: string
  try {
    recovered = recover(signHash, signature)
  } catch {
    return { verified: false, reason: 'bad_signature' }
  }

  if (recovered.toLowerCase() !== delegate.toLowerCase()) {
    return { verified: false, reason: 'signer_mismatch', recoveredSigner: recovered }
  }
  return { verified: true, recoveredSigner: recovered }
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
