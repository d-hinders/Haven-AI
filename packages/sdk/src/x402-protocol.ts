import {
  AgentPaymentNextAction,
  HavenApiError,
  HavenPaymentStateError,
} from './types.js'
import type {
  PaymentStatusResult,
  X402McpTransport,
  X402PaymentOption,
  X402PaymentRequired,
  X402Quote,
  X402Receipt,
  X402RequestSnapshot,
  X402ResumeState,
} from './types.js'
import {
  buildX402IdempotencyKey,
  resolveTokenFromAddress,
  selectErc7710PaymentOption,
  selectStandardPaymentOption,
  x402AuthorizationAmount,
} from './x402.js'
import { paymentStateStatusCode } from './payment-state.js'

/**
 * Protocol-level x402 shapes and request plumbing, owned by neither
 * settlement scheme (#1618, epic #1613).
 *
 * These are the parts of the x402 lifecycle that do not know how the money
 * moves: quote/receipt/resume shapes, the merchant request snapshot a resume
 * replays, the `x402-wallet` header, and the state checks that decide whether
 * a payment is resumable at all. The EIP-3009 funding leg
 * (`x402-funding-leg.ts`) and the erc7710 no-funding-leg path both build on
 * them, which is why they live here rather than inside either one — a
 * neutral primitive parked in the 3009 module would make the erc7710 module
 * import a funding leg it does not have.
 *
 * Everything here is a free function. There is no state to own: give the same
 * inputs, get the same shape. That is also what makes them cheap to test
 * directly, without constructing a client.
 */

const CHAIN_EXPLORER_TX: Record<number, string> = {
  100:  'https://gnosisscan.io/tx',
  8453: 'https://basescan.org/tx',
}

export function buildExplorerUrl(chainId: number | undefined, txHash: string): string {
  const base = CHAIN_EXPLORER_TX[chainId ?? 8453] ?? CHAIN_EXPLORER_TX[8453]
  return `${base}/${txHash}`
}

export function explorerUrlOrEmpty(
  chainId: number | undefined,
  txHash: string | null | undefined,
): string {
  return txHash ? buildExplorerUrl(chainId, txHash) : ''
}

export function chainIdFromNetwork(network: string | undefined): number | undefined {
  if (network === 'base') return 8453
  // #1471: canonical in the x402 spec's NetworkSchema, and the backend maps
  // it as of the same change — the #1478 pin test enforces that every copy
  // widens together, which is exactly how this line got here.
  if (network === 'base-sepolia') return 84532
  if (!network?.startsWith('eip155:')) return undefined
  const chainId = Number(network.slice('eip155:'.length))
  return Number.isFinite(chainId) ? chainId : undefined
}

export function chainIdOrNull(network: string | undefined): number | null {
  return chainIdFromNetwork(network) ?? null
}

export function sameAddress(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase())
}

export function decimalFromUsdcAtomic(value: string): string {
  const amount = BigInt(value)
  const whole = amount / 1_000_000n
  const fraction = (amount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

export function normalizeDecimal(value: string): string {
  if (!value.includes('.')) return value.replace(/^0+(?=\d)/, '') || '0'
  const [whole, fraction = ''] = value.split('.')
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '') || '0'
  const normalizedFraction = fraction.replace(/0+$/, '')
  return normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole
}

// ── Payer identity and the merchant-facing wallet header ────────────

/**
 * The address a merchant should see as the payer. Both settlement schemes ask
 * this question; the answer differs only by which one is configured.
 */
export function x402PayerAddress(
  delegateAddress: string | undefined,
  x402Wallet: string | undefined,
): string | undefined {
  return delegateAddress ?? x402Wallet
}

export function withX402Wallet(
  init: RequestInit | undefined,
  wallet: string | undefined,
): RequestInit | undefined {
  if (!wallet) return init

  const headers = new Headers(init?.headers)
  if (!headers.has('x402-wallet')) {
    headers.set('x402-wallet', wallet)
  }

  return {
    ...init,
    headers,
  }
}

// ── Request snapshots (what a resume replays) ───────────────────────

export function snapshotRequestBody(body: BodyInit | null | undefined): string | undefined {
  if (body == null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()

  throw new HavenApiError(
    'Quote helpers can only capture resumable request bodies that are strings or URLSearchParams. ' +
    'For streams, blobs, or binary bodies, preserve the original request yourself and call the matching resume method with fresh init.',
    400,
  )
}

export function snapshotX402Request(url: string, init?: RequestInit): X402RequestSnapshot {
  return {
    url,
    method: init?.method ?? 'GET',
    headers: Array.from(new Headers(init?.headers).entries()),
    body: snapshotRequestBody(init?.body),
  }
}

export function requestInitFromSnapshot(request: X402RequestSnapshot): RequestInit {
  return {
    method: request.method,
    headers: request.headers,
    body: request.body,
  }
}

// ── Quote / receipt / resume shapes ─────────────────────────────────

export function buildX402Quote(
  paymentRequired: X402PaymentRequired,
  request: X402RequestSnapshot,
  idempotencyKey?: string,
  mcpTransport?: X402McpTransport,
): X402Quote {
  // #2054: this used to be standard-only, so a merchant advertising ONLY an
  // erc7710-tagged entry — no untagged fallback — was refused as having "no
  // compatible payment option" before scheme selection could ever see the
  // entry Haven actually PREFERS on the delegation rail (#1450). The quote is
  // informational and rail-agnostic, so when no standard entry exists it now
  // DESCRIBES the erc7710 entry instead of throwing, and says which selector
  // produced it via `acceptedScheme`. `selectStandardPaymentOption`'s own
  // erc7710 skip is untouched — it is a #1453 correctness property, and the
  // 3009 settlement paths keep re-selecting through it, so an erc7710
  // described quote can never leak into an EIP-3009 authorization.
  const standard = selectStandardPaymentOption(paymentRequired.accepts)
  const option = standard ?? selectErc7710PaymentOption(paymentRequired.accepts)
  if (!option) {
    throw new HavenApiError(
      'No compatible payment option found in x402 requirements. ' +
      'Haven supports standard x402 exact payments on Base USDC.',
      400,
    )
  }

  const token = resolveTokenFromAddress(option.asset, option.network)
  return {
    rail: 'x402',
    idempotencyKey: idempotencyKey ?? buildX402IdempotencyKey(paymentRequired, option),
    paymentRequired,
    accepted: option,
    acceptedScheme: standard ? 'standard' : 'erc7710',
    request,
    ...(mcpTransport ? { mcpTransport } : {}),
    resourceUrl: paymentRequired.resource.url,
    description: paymentRequired.resource.description ?? option.description ?? null,
    mimeType: paymentRequired.resource.mimeType ?? option.mimeType ?? null,
    amountAtomic: x402AuthorizationAmount(option),
    amount: decimalFromUsdcAtomic(x402AuthorizationAmount(option)),
    token: token?.symbol ?? 'USDC',
    // #1351: null when the asset is unrecognised on this network — the
    // `token` fallback above is a LABEL, not evidence of 6 decimals, and a
    // human-denominated cap must fail closed rather than convert against a
    // guess. Same resolution as `token`, so the two never disagree.
    decimals: token?.decimals ?? null,
    asset: option.asset,
    network: option.network,
    chainId: chainIdOrNull(option.network),
    merchantAddress: option.payTo,
    maxTimeoutSeconds: option.maxTimeoutSeconds,
  }
}

export function buildX402Receipt(input: {
  paymentId: string
  txHash: string
  token: string
  amount: string
  to: string
  resourceUrl: string
  explorerUrl: string
  accepted: X402PaymentOption
  // #1521: absent for a receipt describing an ALREADY-SETTLED payment,
  // which has no live authorization to carry. `X402Receipt.paymentHeader`
  // was already optional; only these builders assumed otherwise.
  paymentHeader: string | undefined
  merchantTo?: string | null
  payer?: string
  chainId?: number
}): X402Receipt {
  const fundingExplorerUrl = input.explorerUrl || explorerUrlOrEmpty(input.chainId, input.txHash)

  return {
    success: true,
    paymentId: input.paymentId,
    txHash: input.txHash,
    token: input.token,
    amount: input.amount,
    to: input.to,
    resourceUrl: input.resourceUrl,
    explorerUrl: input.explorerUrl,
    accepted: input.accepted,
    paymentHeader: input.paymentHeader,
    merchantTo: input.merchantTo ?? input.accepted.payTo,
    payer: input.payer,
    chainId: input.chainId,
    haven: {
      paymentId: input.paymentId,
      fundingTxHash: input.txHash,
      fundingExplorerUrl,
    },
    merchant: {
      payTo: input.merchantTo ?? input.accepted.payTo,
    },
    x402: {
      amount: x402AuthorizationAmount(input.accepted),
      token: input.token,
      network: input.accepted.network,
      asset: input.accepted.asset,
      resource: input.accepted.resource ?? input.resourceUrl,
    },
  }
}

export function buildX402ResumeState(input: {
  paymentId: string
  paymentRequired: X402PaymentRequired
  accepted: X402PaymentOption
  idempotencyKey: string
  request?: X402RequestSnapshot
}): X402ResumeState {
  const token = resolveTokenFromAddress(input.accepted.asset, input.accepted.network)
  return {
    rail: 'x402',
    paymentId: input.paymentId,
    idempotencyKey: input.idempotencyKey,
    paymentRequired: input.paymentRequired,
    accepted: input.accepted,
    url: input.request?.url ?? input.paymentRequired.resource.url,
    request: input.request,
    resourceUrl: input.paymentRequired.resource.url,
    description: input.paymentRequired.resource.description ?? input.accepted.description ?? null,
    amountAtomic: x402AuthorizationAmount(input.accepted),
    amount: decimalFromUsdcAtomic(x402AuthorizationAmount(input.accepted)),
    token: token?.symbol ?? 'USDC',
    asset: input.accepted.asset,
    network: input.accepted.network,
    chainId: chainIdOrNull(input.accepted.network),
    merchantAddress: input.accepted.payTo,
  }
}

export function attachX402ResumeState(
  err: unknown,
  paymentRequired: X402PaymentRequired,
  accepted: X402PaymentOption,
  idempotencyKey: string,
  request?: X402RequestSnapshot,
): void {
  if (!(err instanceof HavenPaymentStateError)) return
  if (err.state.rail !== 'x402') return

  err.resumeState = buildX402ResumeState({
    paymentId: err.state.paymentId,
    paymentRequired,
    accepted,
    idempotencyKey,
    request,
  })
}

// #1328: attachResumeState's 'mpp' branch (buildMppQuote / buildMppResumeState
// / attachMppResumeState) is retired along with the rest of the MPP-demo
// client surface — every remaining caller passes rail: 'x402' only, so this
// is now a direct alias for attachX402ResumeState rather than a dispatcher.
export function attachResumeState(
  err: unknown,
  input: {
    rail: 'x402'
    paymentRequired: X402PaymentRequired
    accepted: X402PaymentOption
    idempotencyKey: string
    request?: X402RequestSnapshot
  },
): void {
  attachX402ResumeState(
    err,
    input.paymentRequired,
    input.accepted,
    input.idempotencyKey,
    input.request,
  )
}

/**
 * Does this payment's live state actually permit the resume the caller is
 * asking for, and does it describe the SAME purchase they are resuming?
 *
 * Every mismatch below is a 409 rather than a best-effort continue: a resume
 * that quietly retargets a different merchant, amount, network or resource is
 * a payment the user never approved.
 */
export function assertCanResumeX402(
  status: PaymentStatusResult,
  paymentRequired: X402PaymentRequired,
  option: X402PaymentOption,
): void {
  if (status.rail !== 'x402') {
    throw new HavenPaymentStateError(
      `Payment ${status.paymentId} is ${status.rail}, not x402.`,
      409,
      status,
    )
  }

  if (status.nextAction !== AgentPaymentNextAction.RetryOriginalX402Request) {
    throw new HavenPaymentStateError(status.message, paymentStateStatusCode(status.status, 409), status)
  }

  if (!status.txHash) {
    throw new HavenApiError(
      `x402 payment ${status.paymentId} is ready to retry but has no Haven transaction hash.`,
      502,
      status,
      status.paymentId,
    )
  }

  if (status.resourceUrl && status.resourceUrl !== paymentRequired.resource.url) {
    throw new HavenApiError(
      'x402 resume request does not match the approved resource URL.',
      409,
      { status, paymentRequired },
      status.paymentId,
    )
  }

  if (status.merchantAddress && !sameAddress(status.merchantAddress, option.payTo)) {
    throw new HavenApiError(
      'x402 resume request does not match the approved merchant.',
      409,
      { status, selectedPayment: option },
      status.paymentId,
    )
  }

  const optionChainId = chainIdFromNetwork(option.network)
  if (status.chainId && optionChainId && status.chainId !== optionChainId) {
    throw new HavenApiError(
      'x402 resume request does not match the approved network.',
      409,
      { status, selectedPayment: option },
      status.paymentId,
    )
  }

  if (status.token && status.token !== 'USDC') {
    throw new HavenApiError(
      'x402 resume request does not match the approved token.',
      409,
      { status, selectedPayment: option },
      status.paymentId,
    )
  }

  const approvedAmount = status.amount ? normalizeDecimal(status.amount) : ''
  const requestedAmount = normalizeDecimal(decimalFromUsdcAtomic(x402AuthorizationAmount(option)))
  if (approvedAmount && approvedAmount !== requestedAmount) {
    throw new HavenApiError(
      'x402 resume request does not match the approved amount.',
      409,
      { status, selectedPayment: option },
      status.paymentId,
    )
  }
}
