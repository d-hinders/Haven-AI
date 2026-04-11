/**
 * x402 protocol support for the Haven SDK.
 *
 * Provides:
 * - parsePaymentRequired() — extract payment requirements from a 402 response
 * - encodePaymentProof()   — encode a receipt as a PAYMENT-SIGNATURE header
 *
 * The main authorizeX402() and fetchWithPayment() are methods on HavenClient
 * (see client.ts) since they need API access and signing.
 */

import type { X402PaymentRequired, X402PaymentOption } from './types.js'

// ── Supported networks (CAIP-2 chain IDs) ────────────────────────

/** CAIP-2 chain IDs that Haven supports for x402 payments. */
export const SUPPORTED_X402_NETWORKS: Record<string, string> = {
  'eip155:100': 'Gnosis Chain',
}

// ── Token address map (Gnosis Chain) ─────────────────────────────

/** Map token addresses to symbols on Gnosis Chain. */
const GNOSIS_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '0x0000000000000000000000000000000000000000': { symbol: 'xDAI', decimals: 18 },
  '0xcb444e90d8198415266c6a2724b7900fb12fc56e': { symbol: 'EURe', decimals: 18 },
  '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0': { symbol: 'USDC.e', decimals: 6 },
}

// ── Parser ───────────────────────────────────────────────────────

/**
 * Parse an HTTP 402 response into x402 PaymentRequired data.
 *
 * Supports:
 * - v2: PAYMENT-REQUIRED header (base64 JSON)
 * - v1 fallback: X-PAYMENT header or response body
 */
export function parsePaymentRequired(response: Response): X402PaymentRequired {
  // v2: PAYMENT-REQUIRED header
  const v2Header = response.headers.get('PAYMENT-REQUIRED')
  if (v2Header) {
    try {
      return JSON.parse(atob(v2Header)) as X402PaymentRequired
    } catch {
      throw new Error('Failed to decode PAYMENT-REQUIRED header')
    }
  }

  // v1: X-PAYMENT header
  const v1Header = response.headers.get('X-PAYMENT')
  if (v1Header) {
    try {
      return JSON.parse(atob(v1Header)) as X402PaymentRequired
    } catch {
      throw new Error('Failed to decode X-PAYMENT header')
    }
  }

  throw new Error(
    'No x402 payment headers found in 402 response. ' +
    'Expected PAYMENT-REQUIRED (v2) or X-PAYMENT (v1) header.',
  )
}

/**
 * Select the best payment option from the x402 accepts array.
 *
 * Preference: Gnosis Chain tokens that Haven supports.
 * Falls back to the first option if no Haven-supported match.
 */
export function selectPaymentOption(
  accepts: X402PaymentOption[],
): X402PaymentOption | null {
  if (!accepts || accepts.length === 0) return null

  // First pass: find a Gnosis Chain option with a supported token
  for (const opt of accepts) {
    if (opt.network in SUPPORTED_X402_NETWORKS) {
      const tokenInfo = GNOSIS_TOKENS[opt.asset.toLowerCase()]
      if (tokenInfo) return opt
    }
  }

  // Second pass: any Gnosis Chain option
  for (const opt of accepts) {
    if (opt.network in SUPPORTED_X402_NETWORKS) {
      return opt
    }
  }

  // No compatible option found
  return null
}

/**
 * Encode a payment receipt as a base64 PAYMENT-SIGNATURE header value.
 *
 * This follows the x402 v2 protocol — the server's facilitator will
 * verify the on-chain transaction referenced by tx_hash.
 */
export function encodePaymentProof(receipt: {
  txHash: string
  paymentId: string
  token: string
  amount: string
  to: string
}): string {
  const payload = {
    x402Version: 2,
    payload: {
      txHash: receipt.txHash,
      paymentId: receipt.paymentId,
      settledVia: 'haven',
    },
  }
  return btoa(JSON.stringify(payload))
}

/**
 * Resolve a token symbol from a contract address on Gnosis Chain.
 */
export function resolveTokenFromAddress(address: string): { symbol: string; decimals: number } | null {
  return GNOSIS_TOKENS[address.toLowerCase()] ?? null
}
