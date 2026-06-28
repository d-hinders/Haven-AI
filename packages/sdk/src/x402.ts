/**
 * x402 protocol support for the Haven SDK.
 *
 * Provides:
 * - parsePaymentRequired() — extract payment requirements from a 402 response
 * - parsePaymentRequiredResponse() — async parser with JSON body fallback
 * - encodePaymentProof()   — encode a receipt as a PAYMENT-SIGNATURE header
 *
 * The main authorizeX402() and fetchWithPayment() are methods on HavenClient
 * (see client.ts) since they need API access and signing.
 */

import { createHash } from 'node:crypto'
import type { X402ExpectedContext, X402PaymentRequired, X402PaymentOption } from './types.js'
import type { PaymentRequirements } from 'x402/types'
import { decodeBase64Json, encodeBase64Json } from './base64.js'

const BASE_USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const BASE_SEPOLIA_USDC_ADDRESS = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
/** USDC addresses the standard EIP-3009 exact scheme can pay (Base mainnet + Base Sepolia). */
const STANDARD_X402_USDC_ADDRESSES = new Set([BASE_USDC_ADDRESS, BASE_SEPOLIA_USDC_ADDRESS])
const X402_IDEMPOTENCY_BUCKET_MS = 300_000
const DECIMAL_ATOMIC_AMOUNT_RE = /^[0-9]+$/

function isPositiveDecimalAtomicAmount(value: string): boolean {
  return DECIMAL_ATOMIC_AMOUNT_RE.test(value) && BigInt(value) > 0n
}

function optionAuthorizationAmount(option: X402PaymentOption): string {
  return option.maxAmountRequired ?? option.amount
}

function normalizePaymentOption(value: unknown): X402PaymentOption | null {
  const candidate = value as Partial<X402PaymentOption> | null
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    typeof candidate.scheme !== 'string' ||
    typeof candidate.network !== 'string' ||
    typeof candidate.asset !== 'string' ||
    typeof candidate.payTo !== 'string'
  ) {
    return null
  }

  const amount =
    typeof candidate.amount === 'string'
      ? candidate.amount
      : typeof candidate.maxAmountRequired === 'string'
        ? candidate.maxAmountRequired
        : null

  if (!amount) return null
  if (!isPositiveDecimalAtomicAmount(amount)) return null
  if (
    candidate.maxAmountRequired !== undefined &&
    (
      typeof candidate.maxAmountRequired !== 'string' ||
      !isPositiveDecimalAtomicAmount(candidate.maxAmountRequired)
    )
  ) {
    return null
  }

  return {
    scheme: candidate.scheme,
    network: candidate.network,
    amount,
    maxAmountRequired: candidate.maxAmountRequired,
    resource: candidate.resource,
    description: candidate.description,
    mimeType: candidate.mimeType,
    asset: candidate.asset,
    payTo: candidate.payTo,
    maxTimeoutSeconds: candidate.maxTimeoutSeconds ?? 30,
    extra: candidate.extra,
  }
}

function normalizePaymentRequired(value: unknown): X402PaymentRequired | null {
  const candidate = value as Partial<X402PaymentRequired> | null
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    typeof candidate.x402Version !== 'number' ||
    !Array.isArray(candidate.accepts)
  ) {
    return null
  }

  const accepts = candidate.accepts
    .map((option) => normalizePaymentOption(option))
    .filter((option): option is X402PaymentOption => !!option)

  if (accepts.length === 0) return null

  const first = accepts[0]
  const resourceUrl = candidate.resource?.url ?? first.resource
  if (!resourceUrl) return null

  const resource = {
    url: resourceUrl,
    description: candidate.resource?.description ?? first.description,
    mimeType: candidate.resource?.mimeType ?? first.mimeType,
  }

  return {
    x402Version: candidate.x402Version,
    resource,
    accepts,
    error: candidate.error,
    ...(candidate.extensions && typeof candidate.extensions === 'object'
      ? { extensions: candidate.extensions as Record<string, unknown> }
      : {}),
  }
}

// ── Supported networks ───────────────────────────────────────────

/** Network identifiers that Haven can recognise in x402 payment requests. */
export const SUPPORTED_X402_NETWORKS: Record<string, string> = {
  'eip155:100':   'Gnosis Chain',
  'eip155:8453':  'Base',
  'base':         'Base',
  'eip155:84532': 'Base Sepolia',
  'base-sepolia': 'Base Sepolia',
}

/** Networks supported by the official x402 EIP-3009 exact scheme. */
const STANDARD_X402_NETWORKS: Record<string, PaymentRequirements['network']> = {
  'eip155:8453':  'base',
  'base':         'base',
  'eip155:84532': 'base-sepolia',
  'base-sepolia': 'base-sepolia',
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

/** Known tokens on Base Sepolia (chainId 84532) — testnet. */
const BASE_SEPOLIA_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '0x0000000000000000000000000000000000000000': { symbol: 'ETH',  decimals: 18 },
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e': { symbol: 'USDC', decimals: 6  },
}

/** All known tokens across all supported chains (for display / resolution). */
const ALL_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  ...GNOSIS_TOKENS,
  ...BASE_TOKENS,
  ...BASE_SEPOLIA_TOKENS,
}

/** Maps CAIP-2 network ID → token address map. */
const NETWORK_TOKENS: Record<string, Record<string, { symbol: string; decimals: number }>> = {
  'eip155:100':   GNOSIS_TOKENS,
  'eip155:8453':  BASE_TOKENS,
  'base':         BASE_TOKENS,
  'eip155:84532': BASE_SEPOLIA_TOKENS,
  'base-sepolia': BASE_SEPOLIA_TOKENS,
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
    const parsed = normalizePaymentRequired(
      decodeBase64Json<unknown>(v2Header, 'PAYMENT-REQUIRED header'),
    )
    if (parsed) return parsed
  }

  // v1: X-PAYMENT header
  const v1Header = response.headers.get('X-PAYMENT')
  if (v1Header) {
    const parsed = normalizePaymentRequired(
      decodeBase64Json<unknown>(v1Header, 'X-PAYMENT header'),
    )
    if (parsed) return parsed
  }

  throw new Error(
    'No x402 payment headers found in 402 response. ' +
    'Expected PAYMENT-REQUIRED (v2) or X-PAYMENT (v1) header.',
  )
}

/**
 * Parse an HTTP 402 response into x402 PaymentRequired data.
 *
 * Soundside and other Bazaar-style MCP endpoints return the PaymentRequired
 * object in the JSON body, while older Haven demos and many x402 examples use
 * base64 headers. This keeps the synchronous header parser intact and adds the
 * body fallback needed for those endpoints.
 */
export async function parsePaymentRequiredResponse(
  response: Response,
): Promise<X402PaymentRequired> {
  try {
    return parsePaymentRequired(response)
  } catch (headerErr) {
    try {
      const body = await response.clone().json()
      const parsed = normalizePaymentRequired(body)
      if (parsed) return parsed
    } catch {
      // Fall through to the original, more specific header error below.
    }

    throw headerErr
  }
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
      if (
        networkTokens?.[opt.asset.toLowerCase()] &&
        isPositiveDecimalAtomicAmount(optionAuthorizationAmount(opt))
      ) {
        return opt
      }
    }
  }

  // Second pass: any supported network
  for (const opt of accepts) {
    if (
      opt.network in SUPPORTED_X402_NETWORKS &&
      isPositiveDecimalAtomicAmount(optionAuthorizationAmount(opt))
    ) {
      return opt
    }
  }

  // No compatible option found
  return null
}

/**
 * Select an option that can be paid with the official x402 EIP-3009 exact
 * scheme. Haven's older tx-hash proof path can describe more networks; the
 * merchant-verified path currently needs Base USDC.
 */
export function selectStandardPaymentOption(
  accepts: X402PaymentOption[],
): X402PaymentOption | null {
  if (!accepts || accepts.length === 0) return null

  for (const opt of accepts) {
    if (
      opt.scheme === 'exact' &&
      opt.network in STANDARD_X402_NETWORKS &&
      STANDARD_X402_USDC_ADDRESSES.has(opt.asset.toLowerCase()) &&
      isPositiveDecimalAtomicAmount(optionAuthorizationAmount(opt))
    ) {
      return opt
    }
  }

  return null
}

export function x402AuthorizationAmount(option: X402PaymentOption): string {
  const amount = optionAuthorizationAmount(option)
  if (!isPositiveDecimalAtomicAmount(amount)) {
    throw new Error('Invalid x402 amount: must be a positive decimal atomic amount')
  }
  return amount
}

export function buildX402ExpectedMessage(context: X402ExpectedContext): string {
  const payload: Record<string, unknown> = {
    version: 1,
    kind: 'haven.x402.expected',
    paymentId: context.paymentId,
    payloadHash: context.payloadHash.toLowerCase(),
    resourceUrl: context.resourceUrl,
    merchantTo: context.merchantTo.toLowerCase(),
    amount: context.amount,
    asset: context.asset.toLowerCase(),
    network: context.network,
  }
  if (context.expiresAt) {
    payload.expiresAt = context.expiresAt
  }
  return `Haven x402 expected context v1\n${stableStringify(payload)}`
}

export function toStandardPaymentRequirements(
  paymentRequired: X402PaymentRequired,
  option: X402PaymentOption,
): PaymentRequirements {
  const network = STANDARD_X402_NETWORKS[option.network]
  if (!network) {
    throw new Error(`x402 exact payments are not supported on ${option.network}`)
  }

  if (option.scheme !== 'exact') {
    throw new Error(`Unsupported x402 scheme: ${option.scheme}`)
  }

  return {
    scheme: 'exact',
    network,
    maxAmountRequired: x402AuthorizationAmount(option),
    resource: option.resource ?? paymentRequired.resource.url,
    description:
      option.description ??
      paymentRequired.resource.description ??
      'Haven x402 payment',
    mimeType:
      option.mimeType ??
      paymentRequired.resource.mimeType ??
      'application/octet-stream',
    payTo: option.payTo,
    asset: option.asset,
    maxTimeoutSeconds: option.maxTimeoutSeconds,
    extra: option.extra,
  }
}

export function buildX402IdempotencyKey(
  paymentRequired: X402PaymentRequired,
  option: X402PaymentOption,
  now = Date.now(),
): string {
  const bucket = Math.floor(now / X402_IDEMPOTENCY_BUCKET_MS)
  const material = [
    paymentRequired.resource.url,
    paymentRequired.resource.description ?? '',
    option.payTo.toLowerCase(),
    option.asset.toLowerCase(),
    x402AuthorizationAmount(option),
    option.network,
    bucket,
  ].join('|')

  return `x402:${createHash('sha256').update(material).digest('hex').slice(0, 16)}`
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
  resourceUrl?: string
  accepted?: X402PaymentOption
  payer?: string
  chainId?: number
}): string {
  const payload = {
    x402Version: 2,
    resource: receipt.resourceUrl ? { url: receipt.resourceUrl } : undefined,
    accepted: receipt.accepted,
    payload: {
      type: 'haven_tx_hash',
      txHash: receipt.txHash,
      paymentId: receipt.paymentId,
      settledVia: 'haven',
      payer: receipt.payer,
      chainId: receipt.chainId,
    },
  }
  return encodeBase64Json(payload)
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

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const primitive = JSON.stringify(value)
    return primitive === undefined ? 'undefined' : primitive
  }
  // Match JSON.stringify's Date handling: serialize to the ISO string, not the
  // empty object the generic-object branch would produce (Object.keys(date) is
  // []). The backend builds the x402 expected-context message from a Postgres
  // TIMESTAMPTZ (a Date at runtime), so without this the signed message carried
  // "expiresAt":{} while the edge signer recomputed "expiresAt":"<ISO>" — a
  // mismatch that broke x402 signature verification once expires_at entered the
  // signed context.
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`
}
