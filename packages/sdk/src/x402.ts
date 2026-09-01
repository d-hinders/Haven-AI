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
import { recoverTypedDataAddress } from 'viem'
import type { X402ExpectedContext, X402PaymentRequired, X402PaymentOption } from './types.js'
import type { PaymentRequirements } from 'x402/types'
import { decodeBase64Json, encodeBase64Json } from './base64.js'
import { buildSweepTypedData } from './sweep.js'

const BASE_USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const BASE_SEPOLIA_USDC_ADDRESS = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
/** USDC addresses the standard EIP-3009 exact scheme can pay (Base mainnet + Base Sepolia). */
const STANDARD_X402_USDC_ADDRESSES = new Set([BASE_USDC_ADDRESS, BASE_SEPOLIA_USDC_ADDRESS])
const X402_IDEMPOTENCY_BUCKET_MS = 300_000
const DECIMAL_ATOMIC_AMOUNT_RE = /^[0-9]+$/
const X402_PAYMENT_HEADER_MAX_LENGTH = 65_536
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/
const NONCE_RE = /^0x[0-9a-fA-F]{64}$/

/**
 * Persisted, agent-scoped facts used to preflight a signed standard x402
 * payment header. This is an integrity comparison only: it never rebuilds,
 * modifies, persists, or submits the supplied authorization.
 */
export interface X402PaymentHeaderContext {
  merchantTo: string
  amountAtomic: string
  asset: string
  network: string
  resourceUrl: string
  payer: string
  chainId: number
}

/** A deliberately value-free refusal for untrusted payment-header input. */
export class X402PaymentHeaderValidationError extends Error {
  constructor() {
    super('Invalid X-PAYMENT header.')
    this.name = 'X402PaymentHeaderValidationError'
  }
}

function isPositiveDecimalAtomicAmount(value: string): boolean {
  return DECIMAL_ATOMIC_AMOUNT_RE.test(value) && BigInt(value) > 0n
}

function optionAuthorizationAmount(option: X402PaymentOption): string {
  return option.maxAmountRequired ?? option.amount
}

/**
 * Upper bound on the MERCHANT-requested part of the EIP-3009 authorization
 * window (#715, epic #713). The x402 library sets
 * `validBefore = now + maxTimeoutSeconds` straight from the MERCHANT's 402
 * challenge — without a cap, a malicious or sloppy merchant can request a
 * year-long window and a leaked signed authorization stays spendable that
 * whole time. 600 s is generous for any facilitator settle (typical is
 * 30–60 s); we CLAMP rather than reject so payments keep flowing while
 * exposure stays bounded. `validBefore` is a deadline, not a demand —
 * settling earlier is always valid.
 */
export const X402_MAX_AUTHORIZATION_WINDOW_SECONDS = 600

/**
 * Forward margin ADDED on top of the (clamped) merchant timeout when the
 * authorization is actually signed (#1256). The x402 verify rule requires
 * `validBefore ≥ now + maxTimeoutSeconds` AT THE FACILITATOR — but the
 * upstream library computes `validBefore = now + maxTimeoutSeconds` at
 * SIGNING time, leaving zero forward margin. Haven's flow guarantees elapsed
 * time between the two (the funding UserOp confirms before the merchant
 * retry, ~1 min plus latency), so every purchase against a merchant whose
 * `maxTimeoutSeconds` exceeded that latency failed structurally — measured
 * live on Base mainnet: Anchor requires 300 s, and 226 s remained at verify.
 *
 * 300 s covers funding + retry latency with room to spare. The #715 exposure
 * ceiling becomes clamped-timeout + margin ≤ 900 s total forward — a
 * deliberate widening from 600 s, recorded on #1256: an authorization that
 * cannot pass verify protects no one, and 900 s is still bounded by the same
 * clamp discipline.
 */
export const X402_SETTLEMENT_FORWARD_MARGIN_SECONDS = 300

function clampAuthorizationWindow(seconds: number | undefined): number {
  const requested = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 30
  return Math.min(Math.max(Math.floor(requested), 1), X402_MAX_AUTHORIZATION_WINDOW_SECONDS)
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
    maxTimeoutSeconds: clampAuthorizationWindow(candidate.maxTimeoutSeconds),
    extra: candidate.extra,
  }
}

export function normalizePaymentRequired(value: unknown): X402PaymentRequired | null {
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
    .filter((option): option is X402PaymentOption => !!option && typeof option === 'object')

  if (accepts.length === 0) return null

  const first = accepts[0]
  const resourceUrl = candidate.resource?.url ?? first.resource
  if (!resourceUrl) return null

  // #2361: spread the merchant's resource object FIRST so unknown fields
  // survive — the v2 payment envelope echoes `resource` verbatim, and a
  // reconstructed subset is a different object than the merchant advertised.
  const resource = {
    ...(candidate.resource && typeof candidate.resource === 'object' ? candidate.resource : {}),
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
 * The x402 wire header names, in one place (#2289).
 *
 * v2 renamed all three; v1's only name was `X-PAYMENT`, used in BOTH
 * directions. Haven had adopted the v2 names for everything it *reads* and
 * kept the v1 name for the one thing it *writes*, which is how a strict v2
 * merchant came to never see a payment header at all.
 *
 * The 2026-08-31 owner decision was to send both outbound names on every
 * retry rather than switch on `x402Version`: a v1 merchant ignores the name it
 * does not know, a v2 merchant ignores the legacy one, and no version
 * heuristic has to be right for a payment to land.
 *
 * **That is no longer unconditional (#2341).** It held while the cost of a
 * spare header was zero, and on the EIP-3009 bridge it still is. On erc7710 it
 * is not: that header carries a whole delegation chain, and duplicating it
 * overflowed the merchant's header limit — HTTP 431, every erc7710 settlement
 * refused. `x402PaymentHeaderNamesFor` below is the live rule; read it rather
 * than this paragraph, which records why the simpler rule was right first.
 */
/** v2 client→server payment payload. The name a strict v2 merchant reads. */
export const X402_PAYMENT_HEADER_NAME = 'PAYMENT-SIGNATURE'
/** v1 client→server payment payload; still accepted by most v2 merchants. */
export const X402_LEGACY_PAYMENT_HEADER_NAME = 'X-PAYMENT'
/** v2 server→client payment requirements. */
export const X402_PAYMENT_REQUIRED_HEADER_NAME = 'PAYMENT-REQUIRED'
/** v2 server→client settlement receipt. */
export const X402_PAYMENT_RESPONSE_HEADER_NAME = 'PAYMENT-RESPONSE'
/**
 * Both wire names, v2 first — the value an EIP-3009 retry actually sends.
 *
 * **Not the general answer any more (#2341), and not what a recorder should
 * reach for.** This was the evidence record's `paymentProofHeaderName` while
 * both names always went on the wire; erc7710 now sends one, so a recorder
 * still reading this constant would log a legacy header that was never sent —
 * exactly the drift the previous wording promised it prevented. Use
 * `x402PaymentHeaderNamesSent(paymentHeader)`. Kept exported because it is a
 * published surface and removing it would break consumers.
 */
export const X402_PAYMENT_HEADER_NAMES_SENT =
  `${X402_PAYMENT_HEADER_NAME}, ${X402_LEGACY_PAYMENT_HEADER_NAME}`

/**
 * Every payment header name Haven may put on the wire, v2 first.
 *
 * `deliverPayment` iterates this rather than the pair it is sending, so a name
 * it is NOT sending is explicitly deleted from the caller's headers instead of
 * being left as-is. Leaving one would resurrect the stale-header bug #2289
 * closed with `set`, one scheme over.
 */
export const X402_PAYMENT_HEADER_NAMES = [
  X402_PAYMENT_HEADER_NAME,
  X402_LEGACY_PAYMENT_HEADER_NAME,
] as const

/**
 * Which payment header names to put on the wire for THIS payload (#2341).
 *
 * #2289 set both names unconditionally, and on the EIP-3009 bridge that is
 * right: the header is a signature plus a six-field authorization, doubling it
 * costs nothing, and lenient v1-only merchants are real. On **erc7710** it is
 * not right, and it is not merely wasteful — the header carries the whole
 * `[child, budget]` delegation chain plus the UserOperation, so sending it
 * twice pushed the request past the server header-size limit and merchants
 * answered **HTTP 431 Request Header Fields Too Large**. Every erc7710
 * settlement failed, with the funding leg already spent on the hosted path.
 *
 * The rule is by SCHEME, not by byte count, because the scheme is what makes
 * the alias pointless rather than merely large: an erc7710 payload is always
 * `x402Version: 2` (the backend's `encodeXPaymentHeader` hardcodes it), and a
 * merchant that can redeem a delegation chain is by construction running x402
 * v2 plus the MetaMask erc7710 extension — it reads `PAYMENT-SIGNATURE`. The
 * legacy name cannot help it and can only cost the request. A size threshold
 * would be an arbitrary number that changes behaviour silently near its edge.
 *
 * An unreadable header falls back to BOTH names — the #2289 behaviour. Haven
 * builds this value itself, so a parse failure means something is already
 * wrong; the conservative answer there is the one that keeps v1 merchants
 * working rather than the one that happens to fix a size problem we cannot
 * confirm this payload has.
 */
export function x402PaymentHeaderNamesFor(paymentHeader: string): readonly string[] {
  const both = [X402_PAYMENT_HEADER_NAME, X402_LEGACY_PAYMENT_HEADER_NAME]
  let decoded: { accepted?: unknown } | null
  try {
    decoded = decodeBase64Json<{ accepted?: unknown }>(paymentHeader)
  } catch {
    return both
  }
  const accepted = decoded?.accepted
  if (!accepted || typeof accepted !== 'object' || Array.isArray(accepted)) return both
  return isErc7710Option(accepted as X402PaymentOption) ? [X402_PAYMENT_HEADER_NAME] : both
}

/**
 * What the evidence record's `paymentProofHeaderName` must say for THIS
 * payload, derived from the same decision the request makes.
 *
 * `X402_PAYMENT_HEADER_NAMES_SENT` was a constant when the answer was always
 * both. It no longer always is, so a recorder still reading the constant would
 * claim an erc7710 request carried a legacy header it never sent — the exact
 * drift that constant's own comment was written to prevent, one scheme later.
 */
export function x402PaymentHeaderNamesSent(paymentHeader: string): string {
  return x402PaymentHeaderNamesFor(paymentHeader).join(', ')
}

/**
 * The x402 v2 payment envelope: `{x402Version, resource?, accepted, payload,
 * extensions?}` per the spec's PaymentPayload (§5.2.2).
 *
 * The `resource` and `extensions` echoes are the #2361 fix, and they are not
 * optional politeness: the spec makes the extensions echo a MUST ("the client
 * must include at least the info received"), and CoinGecko's facilitator was
 * live-bisected rejecting the echo-less envelope with a bare 400 while
 * accepting the identical signature and `accepted`/`payload` bytes with the
 * echoes added (#2360, Base mainnet, 2026-09-01). Both objects are echoed
 * VERBATIM from the merchant's 402 — never reconstructed — and omitted when
 * the challenge carries none, which keeps the envelope byte-identical to the
 * pre-#2361 shape for echo-less merchants (Ampersend and Soundside settled
 * that shape live, so omission is the proven-compatible default).
 *
 * The `accepted` wrap itself is #303's shape and predates this helper — see
 * the #300/#303 history before "fixing" it: scheme/network live INSIDE
 * `accepted` in v2, never at the top level.
 */
export function x402V2PaymentEnvelope(
  paymentRequired: Pick<X402PaymentRequired, 'x402Version' | 'resource' | 'extensions'>,
  accepted: X402PaymentOption,
  payload: unknown,
): Record<string, unknown> {
  const resource = paymentRequired.resource
  const extensions = paymentRequired.extensions
  return {
    x402Version: paymentRequired.x402Version,
    ...(resource && typeof resource === 'object' && !Array.isArray(resource)
      ? { resource }
      : {}),
    accepted,
    payload,
    ...(extensions && typeof extensions === 'object' && !Array.isArray(extensions)
      ? { extensions }
      : {}),
  }
}

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

/** The `extra.assetTransferMethod` value that marks an erc7710-settleable entry. */
export const ERC7710_ASSET_TRANSFER_METHOD = 'erc7710'

/**
 * Read `extra.assetTransferMethod` defensively. `extra` is the merchant's own
 * object, so it is untrusted shape: anything that is not the exact string is
 * treated as "not erc7710" rather than coerced.
 */
export function x402AssetTransferMethod(option: X402PaymentOption): string | null {
  const raw = option.extra?.assetTransferMethod
  return typeof raw === 'string' ? raw : null
}

/** True when the merchant advertises this entry as erc7710-settleable. */
export function isErc7710Option(option: X402PaymentOption): boolean {
  return x402AssetTransferMethod(option) === ERC7710_ASSET_TRANSFER_METHOD
}

/**
 * The facilitator addresses a merchant advertises for an erc7710 entry, for
 * the #1058 redeemer pin — or `null` when it pins nothing.
 *
 * **An EMPTY array is `null`, not `[]`.** The backend rejects an empty
 * `redeemers` list with a 400 (`routes/x402.ts`), and the QA scenario already
 * treats empty as absent. Returning `[]` here would hand callers a value that
 * means "pin to nobody" — which is not a narrower pin, it is an unbuildable
 * delegation.
 *
 * Malformed entries are DROPPED rather than failing the whole option, and that
 * asymmetry is deliberate. A pin narrowed by a merchant's typo means the
 * facilitator that actually tries to redeem is not on the list, so redemption
 * reverts — and erc7710 has no funding leg, so nothing moved and nothing is
 * stranded. Refusing the option outright would instead deny a payment the
 * remaining valid facilitators could have settled. Losing the payment is the
 * worse outcome, precisely because the failure this issue closes (#1453) is the
 * one where funds move BEFORE the rejection.
 */
export function x402FacilitatorAddresses(option: X402PaymentOption): string[] | null {
  const raw = option.extra?.facilitatorAddresses
  if (!Array.isArray(raw)) return null
  const addresses = raw.filter((a): a is string => typeof a === 'string' && ADDRESS_RE.test(a))
  return addresses.length > 0 ? addresses : null
}

/** Shared shape test: scheme/network/asset/amount, ignoring settlement scheme. */
function isPayableStandardOption(opt: X402PaymentOption): boolean {
  return (
    opt.scheme === 'exact' &&
    opt.network in STANDARD_X402_NETWORKS &&
    STANDARD_X402_USDC_ADDRESSES.has(opt.asset.toLowerCase()) &&
    isPositiveDecimalAtomicAmount(optionAuthorizationAmount(opt))
  )
}

/**
 * Select an option that can be paid with the official x402 EIP-3009 exact
 * scheme. Haven's older tx-hash proof path can describe more networks; the
 * merchant-verified path currently needs Base USDC.
 *
 * **Skips erc7710-tagged entries (#1453).** It used to return the first
 * positional match and never look at `extra.assetTransferMethod`, so a merchant
 * that listed its erc7710 entry first made a Haven client echo that option
 * while signing a standard EIP-3009 authorization. The merchant rejects the
 * mismatch cleanly — but on the legacy two-leg the Safe→delegate funding
 * transfer has already executed, so the visible result is a stranded delegate
 * balance for the sweep to reclaim. Only our own demo merchant's ordering was
 * holding that shut, and that pin binds our merchant, not the ones we do not
 * control.
 */
export function selectStandardPaymentOption(
  accepts: X402PaymentOption[],
): X402PaymentOption | null {
  if (!accepts || accepts.length === 0) return null

  for (const opt of accepts) {
    // #1469: a null hole in accepts[] is unpayable data, not a crash. The
    // parsed-Response path filters these in normalizePaymentRequired, but at
    // least one caller (mcp-server, agent-supplied payment_required) reaches
    // here unsanitized — and a throw there became a 500 where every other
    // caller gets the clean no-compatible-option refusal.
    if (opt === null || typeof opt !== 'object') continue
    if (!isErc7710Option(opt) && isPayableStandardOption(opt)) return opt
  }

  return null
}

/**
 * Select the erc7710-settleable option, if the merchant advertises one.
 */
export function selectErc7710PaymentOption(
  accepts: X402PaymentOption[],
): X402PaymentOption | null {
  if (!accepts || accepts.length === 0) return null

  for (const opt of accepts) {
    // #1469: a null hole in accepts[] is unpayable data, not a crash. The
    // parsed-Response path filters these in normalizePaymentRequired, but at
    // least one caller (mcp-server, agent-supplied payment_required) reaches
    // here unsanitized — and a throw there became a 500 where every other
    // caller gets the clean no-compatible-option refusal.
    if (opt === null || typeof opt !== 'object') continue
    if (isErc7710Option(opt) && isPayableStandardOption(opt)) return opt
  }

  return null
}

/** What a settlement-scheme decision resolved to. */
export interface X402SchemeSelection {
  scheme: 'erc7710' | 'eip3009'
  option: X402PaymentOption
  /** Redeemer pin for the settlement child; only ever set on erc7710. */
  facilitatorAddresses: string[] | null
}

/**
 * THE preference rule, in one place (#1450 owner decision, #1453).
 *
 *   Prefer erc7710 whenever the account is on the delegation rail and the
 *   merchant advertises `extra.assetTransferMethod: "erc7710"`; fall back to
 *   the EIP-3009 bridge otherwise.
 *
 * Both halves of that condition are required, and the rail half is the
 * caller's to supply — the SDK cannot see which rail an account is on from a
 * 402 response alone. A legacy AllowanceModule account passing
 * `delegationRail: true` would select a scheme its account cannot settle; the
 * backend refuses that at authorize with the #1986 retired-rail 410 (#2245 —
 * previously a scheme-specific 400 that wrongly implied the legacy rail could
 * still settle via EIP-3009), which is where a rail mismatch SHOULD fail,
 * on-chain-adjacent rather than in a client that could be lying to itself.
 *
 * Returns `null` when neither scheme has a payable entry — the caller decides
 * whether that is an error or a reason to look elsewhere.
 */
export function selectX402SettlementScheme(
  accepts: X402PaymentOption[],
  opts: { delegationRail: boolean },
): X402SchemeSelection | null {
  if (opts.delegationRail) {
    const preferred = selectErc7710PaymentOption(accepts)
    if (preferred) {
      return {
        scheme: 'erc7710',
        option: preferred,
        facilitatorAddresses: x402FacilitatorAddresses(preferred),
      }
    }
  }

  const fallback = selectStandardPaymentOption(accepts)
  if (fallback) return { scheme: 'eip3009', option: fallback, facilitatorAddresses: null }

  return null
}

export function x402AuthorizationAmount(option: X402PaymentOption): string {
  const amount = optionAuthorizationAmount(option)
  if (!isPositiveDecimalAtomicAmount(amount)) {
    throw new Error('Invalid x402 amount: must be a positive decimal atomic amount')
  }
  return amount
}

/**
 * Canonical Haven-authenticated x402 expected context, recomputed byte-for-byte
 * by the edge signer before it signs anything.
 *
 * **Two versions, and the version is derived — never passed in (#1138).**
 * `typedDataHash` present ⇒ v2, absent ⇒ v1. A v1 message is byte-identical to
 * what shipped before, so existing signers keep verifying legacy-rail bindings
 * unchanged.
 *
 * The version lives in both the header line and the payload so neither can be
 * reinterpreted as the other: a v2 context cannot be replayed as a v1 one that
 * drops the typed-data commitment, and a v1 context cannot be presented as v2.
 * That downgrade is exactly the attack the digest exists to stop — see
 * `assertExpectedBinding` in `@haven_ai/signer`, which refuses to raw-sign a
 * hash under a v2 binding and refuses to sign typed data without one.
 */
export function buildX402ExpectedMessage(context: X402ExpectedContext): string {
  // Contents-derived, never caller-chosen (#1138, #1690): payerDelegate ⇒ 3,
  // else typedDataHash ⇒ 2, else 1. A v3 context still carries typedDataHash
  // on the delegation rail — the MODE rules key on typedDataHash presence
  // independently of the version, so v3 works in both hash and typed-data
  // modes.
  const version = context.payerDelegate ? 3 : context.typedDataHash ? 2 : 1
  const payload: Record<string, unknown> = {
    version,
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
  if (context.typedDataHash) {
    payload.typedDataHash = context.typedDataHash.toLowerCase()
  }
  if (context.payerDelegate) {
    payload.payerDelegate = context.payerDelegate.toLowerCase()
    // Only meaningful alongside the delegate it identifies — an agent id with
    // no payer claim would be diagnosis without a guard.
    if (context.payerAgentId) {
      payload.payerAgentId = context.payerAgentId
    }
  }
  return `Haven x402 expected context v${version}\n${stableStringify(payload)}`
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
    // Second enforcement point (#715): the parse path clamps too, but this is
    // the last stop before the x402 library turns the timeout into
    // `validBefore` — options constructed without parsing are bounded here.
    // The forward margin (#1256) is added ONLY here, at signing: the parse
    // path keeps recording the merchant's advertised timeout unchanged, and
    // the library's `validBefore = now + this value` then carries enough
    // slack to satisfy the facilitator's `validBefore ≥ now + maxTimeout`
    // verify rule after our funding leg confirms.
    maxTimeoutSeconds:
      clampAuthorizationWindow(option.maxTimeoutSeconds) +
      X402_SETTLEMENT_FORWARD_MARGIN_SECONDS,
    extra: option.extra,
  }
}

/**
 * Strictly validate an edge-signed EIP-3009 X-PAYMENT header against the
 * persisted x402 intent context before a hosted relay can submit funding.
 *
 * The merchant/facilitator remains the final protocol verifier. This closes a
 * separate hosted-relay integrity gap: malformed or context-mismatched input
 * must never cause Haven to relay the funding signature first.
 */
export async function validateStandardX402PaymentHeader(
  paymentHeader: string,
  context: X402PaymentHeaderContext,
): Promise<void> {
  try {
    if (
      typeof paymentHeader !== 'string' ||
      paymentHeader.length === 0 ||
      paymentHeader.length > X402_PAYMENT_HEADER_MAX_LENGTH ||
      paymentHeader.length % 4 !== 0 ||
      !BASE64_RE.test(paymentHeader)
    ) {
      throw new Error('wire')
    }

    const decoded = decodeBase64Json<Record<string, unknown>>(paymentHeader)
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('shape')
    const version = decoded.x402Version
    const payload = decoded.payload
    if ((version !== 1 && version !== 2) || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('shape')
    }

    if (version === 1) {
      if (!hasOnlyKeys(decoded, ['x402Version', 'scheme', 'network', 'payload'])) throw new Error('shape')
      if (decoded.scheme !== 'exact' || decoded.network !== standardX402WireNetwork(context.network)) {
        throw new Error('context')
      }
    } else {
      // #2361: the v2 envelope may carry the `resource`/`extensions` echoes
      // (spec PaymentPayload §5.2.2; the extensions echo is a spec MUST when
      // the challenge advertises them). They are echoes of merchant data, not
      // spend authority — validated structurally here, while the required
      // key set stays exactly what it was.
      if (!hasOnlyKeys(decoded, ['x402Version', 'accepted', 'payload'], ['resource', 'extensions'])) {
        throw new Error('shape')
      }
      if ('resource' in decoded && (!decoded.resource || typeof decoded.resource !== 'object' || Array.isArray(decoded.resource))) {
        throw new Error('shape')
      }
      if ('extensions' in decoded && (!decoded.extensions || typeof decoded.extensions !== 'object' || Array.isArray(decoded.extensions))) {
        throw new Error('shape')
      }
      const accepted = selectStandardPaymentOption([decoded.accepted as X402PaymentOption])
      if (!accepted || !matchesHeaderContext(accepted, context)) throw new Error('context')
    }

    const record = payload as Record<string, unknown>
    if (!hasOnlyKeys(record, ['signature', 'authorization'])) throw new Error('shape')
    if (typeof record.signature !== 'string' || !SIGNATURE_RE.test(record.signature)) throw new Error('shape')
    const authorization = record.authorization
    if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) throw new Error('shape')
    const auth = authorization as Record<string, unknown>
    if (!hasOnlyKeys(auth, ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'])) throw new Error('shape')
    if (
      typeof auth.from !== 'string' || !ADDRESS_RE.test(auth.from) ||
      typeof auth.to !== 'string' || !ADDRESS_RE.test(auth.to) ||
      typeof auth.value !== 'string' || !isPositiveDecimalAtomicAmount(auth.value) ||
      typeof auth.validAfter !== 'string' || !DECIMAL_ATOMIC_AMOUNT_RE.test(auth.validAfter) ||
      typeof auth.validBefore !== 'string' || !DECIMAL_ATOMIC_AMOUNT_RE.test(auth.validBefore) ||
      typeof auth.nonce !== 'string' || !NONCE_RE.test(auth.nonce)
    ) {
      throw new Error('shape')
    }
    if (!sameAddress(auth.from, context.payer) || !sameAddress(auth.to, context.merchantTo) || auth.value !== context.amountAtomic) {
      throw new Error('context')
    }

    const validAfter = BigInt(auth.validAfter)
    const validBefore = BigInt(auth.validBefore)
    const now = BigInt(Math.floor(Date.now() / 1000))
    if (validBefore <= now || validAfter > validBefore) throw new Error('expired')

    // `buildSweepTypedData` pins the correct USDC EIP-712 domain for the
    // persisted chain + asset pair. Successful recovery makes the nonce and
    // every authorization field cryptographically covered by the delegate.
    const typedData = buildSweepTypedData({
      from: auth.from,
      to: auth.to,
      value: auth.value,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce,
      token: context.asset,
      chainId: context.chainId,
    })
    const recovered = await recoverTypedDataAddress({
      ...typedData,
      // `buildSweepTypedData` keeps the public domain framework-neutral;
      // viem brands contract addresses at this crypto call boundary only.
      domain: {
        ...typedData.domain,
        verifyingContract: typedData.domain.verifyingContract as `0x${string}`,
      },
      message: {
        ...typedData.message,
        from: typedData.message.from as `0x${string}`,
        to: typedData.message.to as `0x${string}`,
        nonce: typedData.message.nonce as `0x${string}`,
      },
      signature: record.signature as `0x${string}`,
    })
    if (!sameAddress(recovered, context.payer)) throw new Error('recovery')
  } catch {
    // Header values are attacker-controlled and may include merchant data.
    // Never propagate them into hosted errors, logs, or serialized telemetry.
    throw new X402PaymentHeaderValidationError()
  }
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): boolean {
  return Object.keys(value).every((key) => required.includes(key) || optional.includes(key)) &&
    required.every((key) => key in value)
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function standardX402WireNetwork(network: string): PaymentRequirements['network'] | null {
  return STANDARD_X402_NETWORKS[network] ?? null
}

function matchesHeaderContext(option: X402PaymentOption, context: X402PaymentHeaderContext): boolean {
  if (
    option.scheme !== 'exact' ||
    !sameAddress(option.payTo, context.merchantTo) ||
    !sameAddress(option.asset, context.asset) ||
    option.network !== context.network ||
    x402AuthorizationAmount(option) !== context.amountAtomic
  ) return false
  // x402 v2 may scope an accepted option to a resource. When it does, that
  // resource is part of the header context and must match the intent.
  return option.resource === undefined || option.resource === context.resourceUrl
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
