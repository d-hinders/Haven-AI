import { verifyTypedData, type Address } from 'viem'
import { USDC_ADDRESS, CHAIN_ID } from './products.js'

// ── EIP-3009 typed data ───────────────────────────────────────────────────────

const TRANSFER_WITH_AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

const USDC_DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: CHAIN_ID,
  verifyingContract: USDC_ADDRESS,
} as const

// ── X-PAYMENT header types ───────────────────────────────────────────────────

export interface Eip3009Authorization {
  from: string
  to: string
  value: string
  validAfter: string
  validBefore: string
  nonce: string
}

export interface XPaymentPayload {
  x402Version: number
  scheme: string
  network: string
  payload: {
    signature: string
    authorization: Eip3009Authorization
  }
}

export interface VerifiedPayment {
  from: Address
  to: Address
  value: bigint
  nonce: string
}

// In-memory nonce registry — prevents replay within a server lifetime.
// NOTE: resets on process restart; use persistent storage for production.
const usedNonces = new Set<string>()

/** Safely parse a bigint field from untrusted JSON, throwing PaymentError on bad input. */
function parseBigInt(value: unknown, field: string): bigint {
  try {
    if (value === null || value === undefined || value === '') {
      throw new Error('empty')
    }
    return BigInt(String(value))
  } catch {
    throw new PaymentError(`Ogiltigt betalningsfält '${field}': ${JSON.stringify(value)}`)
  }
}

/**
 * Parse and verify an X-PAYMENT header value.
 *
 * Validates:
 *  1. Base64 decode + JSON parse
 *  2. EIP-3009 signature over the authorization struct
 *  3. `to` matches our merchant address
 *  4. `value` matches the expected price
 *  5. Nonce not previously used
 *  6. validBefore not expired
 */
export async function verifyXPayment(
  xPaymentHeader: string,
  merchantAddress: Address,
  expectedAmount: bigint,
): Promise<VerifiedPayment> {
  // Decode
  let payment: XPaymentPayload
  try {
    const json = Buffer.from(xPaymentHeader, 'base64').toString('utf8')
    payment = JSON.parse(json) as XPaymentPayload
  } catch {
    throw new PaymentError('Ogiltig X-PAYMENT header: kunde inte avkoda base64/JSON')
  }

  const { authorization, signature } = payment.payload
  const nowSec = BigInt(Math.floor(Date.now() / 1000))

  // Parse numeric fields early — throws PaymentError (not SyntaxError) on bad input.
  const validBefore = parseBigInt(authorization.validBefore, 'validBefore')
  const validAfter  = parseBigInt(authorization.validAfter,  'validAfter')
  const value       = parseBigInt(authorization.value,       'value')

  // Expiry check
  if (validBefore > 0n && nowSec >= validBefore) {
    throw new PaymentError('Betalningsauktoriseringen har löpt ut')
  }

  // validAfter check
  if (nowSec < validAfter) {
    throw new PaymentError('Betalningsauktoriseringen är inte giltig ännu')
  }

  // Recipient check
  const toAddr = authorization.to.toLowerCase() as Address
  if (toAddr !== merchantAddress.toLowerCase()) {
    throw new PaymentError(
      `Betalning är inte adresserad till handlaren: förväntade ${merchantAddress}, fick ${authorization.to}`,
    )
  }

  // Amount check
  if (value < expectedAmount) {
    throw new PaymentError(
      `Otillräckligt belopp: förväntade ${expectedAmount}, fick ${value}`,
    )
  }

  // Nonce replay check — claim the nonce atomically (before the async verify) so
  // two concurrent requests with the same nonce cannot both pass this check.
  // If signature verification fails below, we remove it again so a legitimate
  // retry with a valid signature still works.
  const nonceKey = authorization.nonce.toLowerCase()
  if (usedNonces.has(nonceKey)) {
    throw new PaymentError('Betalningsnonce har redan använts (replay attack)')
  }
  usedNonces.add(nonceKey)

  // EIP-712 signature verification
  let valid: boolean
  try {
    valid = await verifyTypedData({
      address: authorization.from as Address,
      domain: USDC_DOMAIN,
      types: TRANSFER_WITH_AUTH_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: authorization.from as Address,
        to: authorization.to as Address,
        value,
        validAfter,
        validBefore,
        nonce: authorization.nonce as `0x${string}`,
      },
      signature: signature as `0x${string}`,
    })
  } catch (err) {
    // Unexpected verification error — release the nonce so a valid retry can succeed.
    usedNonces.delete(nonceKey)
    throw err
  }

  if (!valid) {
    // Signature is genuinely bad — release the nonce so the payer can correct and retry.
    usedNonces.delete(nonceKey)
    throw new PaymentError('Ogiltig EIP-3009 signatur')
  }

  return {
    from: authorization.from as Address,
    to: toAddr,
    value,
    nonce: authorization.nonce,
  }
}

export class PaymentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentError'
  }
}

/**
 * Build the HTTP 402 response body following the x402 v2 spec.
 */
export function buildPaymentRequired(params: {
  merchantAddress: Address
  amountUsdc: bigint
  resource: string
  description: string
}): object {
  return {
    x402Version: 2,
    accepts: [
      {
        scheme: 'exact',
        network: 'base',
        maxAmountRequired: params.amountUsdc.toString(),
        resource: params.resource,
        description: params.description,
        mimeType: 'application/json',
        payTo: params.merchantAddress,
        maxTimeoutSeconds: 300,
        asset: USDC_ADDRESS,
        outputSchema: null,
        extra: null,
      },
    ],
    error: 'Betalning krävs',
  }
}
