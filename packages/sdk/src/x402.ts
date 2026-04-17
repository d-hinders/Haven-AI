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
  'eip155:100':  'Gnosis Chain',
  'eip155:8453': 'Base',
}

// ── Token address maps ────────────────────────────────────────────

/** Known tokens on Gnosis Chain (chainId 100). */
const GNOSIS_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '0x0000000000000000000000000000000000000000': { symbol: 'xDAI',   decimals: 18 },
  '0xcb444e90d8198415266c6a2724b7900fb12fc56e': { symbol: 'EURe',   decimals: 18 },
  '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0': { symbol: 'USDC.e', decimals: 6  },
}

/** Known tokens on Base (chainId 8453). */
const BASE_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '0x0000000000000000000000000000000000000000': { symbol: 'ETH',  decimals: 18 },
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6  },
}

/** All known tokens across all supported chains (for display / resolution). */
const ALL_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  ...GNOSIS_TOKENS,
  ...BASE_TOKENS,
}

/** Maps CAIP-2 network ID → token address map. */
const NETWORK_TOKENS: Record<string, Record<string, { symbol: string; decimals: number }>> = {
  'eip155:100':  GNOSIS_TOKENS,
  'eip155:8453': BASE_TOKENS,
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
 * Preference order:
 * 1. Option on a Haven-supported network with a known token
 * 2. Any option on a Haven-supported network
 * 3. null — no compatible option
 */
export function selectPaymentOption(
  accepts: X402PaymentOption[],
): X402PaymentOption | null {
  if (!accepts || accepts.length === 0) return null

  // First pass: find a supported network with a known token
  for (const opt of accepts) {
    if (opt.network in SUPPORTED_X402_NETWORKS) {
      const networkTokens = NETWORK_TOKENS[opt.network]
      if (networkTokens?.[opt.asset.toLowerCase()]) return opt
    }
  }

  // Second pass: any supported network
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
 * Resolve a token symbol from a contract address.
 *
 * Checks all supported chains. For chain-specific resolution,
 * pass the optional `network` CAIP-2 string (e.g. "eip155:100").
 */
export function resolveTokenFromAddress(
  address: string,
  network?: string,
): { symbol: string; decimals: number } | null {
  const lower = address.toLowerCase()

  if (network && network in NETWORK_TOKENS) {
    return NETWORK_TOKENS[network][lower] ?? null
  }

  return ALL_TOKENS[lower] ?? null
}
