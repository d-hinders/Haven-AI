import { ethers } from 'ethers'

/**
 * Verifiable payment receipts.
 *
 * A self-contained proof bundle for a settled Haven payment that anyone can
 * verify **independently of Haven**. The anchor is the agent delegate's
 * signature over the on-chain transfer hash: recover the signer and confirm it
 * is the agent's delegate, and you have cryptographic proof the agent authorised
 * exactly this transfer — no need to trust Haven's backend. The on-chain
 * `txHash` is the settlement source of truth (verify on any explorer).
 *
 * This lives in the SDK so agents and users can verify receipts client-side
 * with zero Haven trust.
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

export type ReceiptVerification =
  | { verified: true; recoveredSigner: string }
  | {
      verified: false
      reason: 'missing_signature' | 'bad_signature' | 'signer_mismatch'
      recoveredSigner?: string
    }

/** Default ECDSA recovery (raw ecrecover over the hash, no message prefix). */
function defaultRecover(hash: string, signature: string): string {
  return ethers.recoverAddress(hash, signature)
}

/**
 * Verify a receipt independently: recover the signer from the authorisation and
 * confirm it is the agent's delegate. Pure — `recover` is injectable but
 * defaults to standard ECDSA recovery, so this runs anywhere (no Haven backend).
 */
export function verifyPaymentReceipt(
  receipt: PaymentReceipt,
  recover: (hash: string, signature: string) => string = defaultRecover,
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
