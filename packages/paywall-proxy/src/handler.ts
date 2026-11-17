/**
 * The proxy's request handling: docs/architecture/12-merchant-kit.md §6-§8.
 *
 * The order of checks on a paid request is the design's (§8): the body checks
 * (JSON, `model`, the cap, the size); the payment's key, looked up in the
 * store (a known key is answered from its record); the payment checks (an
 * unknown key only); the per-IP rate limit and the verify cap; reserve; the
 * chain read, verify, the upstream slot and settle; then forward. A forward
 * other than the reserving request's first needs a SIGN-IN-WITH-X proof from
 * the payer (§6). Nothing is forwarded, and the upstream key is never sent,
 * until settlement is confirmed. The proxy has no settlement key and never
 * submits a transaction: it asks Coinbase's facilitator through the shared
 * core, and reads the chain to learn what happened when the answer is lost.
 */
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getAddress, isAddress, type Address, type Hex } from 'viem'
import { SettleError, VerifyError, type PaymentPayload, type PaymentRequired, type SettleResponse } from '@x402/core/types'
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http'
import {
  AuthorizationAlreadyUsedError,
  CDP_CALL_TIMEOUT_MS,
  MAX_FORWARDS_PER_PAYMENT,
  NONCE_RE,
  PaymentError,
  SETTLE_RESOLVE_MS,
  assertExtensionsEchoed,
  authorizationDigest,
  decodePayment,
  describeError,
  paymentStoreKey,
  parseExactEvmPayload,
  recoverUsedAuthorization,
  settleThroughCdp,
  verifyCdpAuthorization,
  type CdpFacilitator,
  type CdpSettlementConfig,
  type ConsumedPaymentRecord,
  type Eip3009Authorization,
} from '@haven_ai/merchant-payments'
import { buildChallenge, refusalWithChallenge } from './challenge.js'
import { secretValues, type ProxyConfig } from './config.js'
import { DISCOVERY_PATH, buildDiscoveryDocument } from './discovery.js'
import { applyOutputTokenCap, callUpstream, type UpstreamFailureReason } from './forward.js'
import { DEFAULT_LIMITS, Gate, IpLimiter, type LimitSettings, type Permit } from './limits.js'
import { redactor, type LogFn } from './log.js'
import { indexProducts, type Product } from './products.js'
import { buildSiwxChallenge, checkSiwxProof, siwxBinding, type SiwxChallenge } from './siwx.js'
import type { SqliteConsumedPaymentStore } from './sqlite-store.js'

export const MAX_REQUEST_BODY_BYTES = 1024 * 1024
/** An oversized body is read and discarded up to this many bytes, so its 413 can be delivered; past it the connection is cut. */
const DRAIN_LIMIT_BYTES = 8 * MAX_REQUEST_BODY_BYTES
/** `Retry-After`, seconds, on a 503 `settlement_unknown`. */
const SETTLEMENT_RETRY_SECONDS = 5
/** `Retry-After`, seconds, on an `at_capacity` answer: the upstream slot wait. */
const AT_CAPACITY_RETRY_SECONDS = 10

export interface ProxyDeps {
  config: ProxyConfig
  products: readonly Product[]
  /** The products file's last change, for the discovery document's `updated` (§4). */
  updated?: string
  store: SqliteConsumedPaymentStore
  cdp: CdpSettlementConfig
  log: LogFn
  fetchImpl?: typeof fetch
  now?: () => Date
  /** How long a holder polls the chain for a lost settle answer. Default `SETTLE_RESOLVE_MS`. */
  settleResolveMs?: number
  settlePollMs?: number
  /** Tests only; the deployed proxy uses the config's (bounded) value. */
  reservationDeadlineMs?: number
  /** Tests only: the deployed proxy uses `DEFAULT_LIMITS` (§7). */
  limits?: Partial<LimitSettings>
}

interface Problem {
  status: number
  error: string
  message: string
}

/** What the request's body allowed: the selected product and the body to forward, or why neither. */
interface BodyOutcome {
  product?: Product
  forwardBody?: Buffer
  problem?: Problem
}

/** Everything a request knows about its payment once the key is derived. */
interface PaymentContext {
  header: string
  payload: PaymentPayload
  authorization: Eip3009Authorization
  signature: Hex
  key: string
  digest: string
  payer: Address
}

type VerifiedCheck = Awaited<ReturnType<typeof verifyCdpAuthorization>>

interface RequestContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  subPath: string
  resourceUrl: string
  /** The client address the per-IP limits count against (§7). */
  ip: string
  body: BodyOutcome
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export function createProxyHandler(deps: ProxyDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { config, store, cdp, log } = deps
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? (() => new Date())
  const settleResolveMs = deps.settleResolveMs ?? SETTLE_RESOLVE_MS
  const settlePollMs = deps.settlePollMs ?? 2_000
  const reservationDeadlineMs = deps.reservationDeadlineMs ?? config.reservationDeadlineMs
  const byRoute = indexProducts(deps.products)
  // §4: the document is built once, from the products file read at startup, so
  // a change to the file reaches readers when the proxy restarts.
  const discovery = buildDiscoveryDocument({
    config,
    products: deps.products,
    ...(deps.updated !== undefined ? { updated: deps.updated } : {}),
  })
  const takeoverMs = config.upstreamTimeoutMs + 30_000
  // A secret that reached a response body by mistake is still never sent.
  const redact = redactor(secretValues(config))

  /** Reservation holders live in THIS process: key -> when the reservation was made (monotonic). */
  const holders = new Map<string, number>()
  /** Chain resolutions in flight, so a burst of replays costs one bounded resolve per key. */
  const resolving = new Set<string>()

  const limits: LimitSettings = { ...DEFAULT_LIMITS, ...deps.limits }
  const ipLimiter = new IpLimiter(limits)
  /** §7: concurrent verify calls, taken without waiting before `reserve`. */
  const verifyGate = new Gate(limits.verifyConcurrency)
  /** §7: concurrent upstream calls, taken after verify and before settle, or before a known key's forward. */
  const upstreamGate = new Gate(limits.upstreamConcurrency)

  // ---- responses --------------------------------------------------------

  function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    if (res.headersSent) {
      res.end()
      return
    }
    const text = redact(JSON.stringify(body))
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text),
      ...headers,
    })
    res.end(text)
  }

  function refuse(res: ServerResponse, status: number, error: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): void {
    send(res, status, { error, message, ...extra }, headers)
  }

  function challengeFor(ctx: RequestContext, product: Product): PaymentRequired {
    return buildChallenge({ chain: config.chain, payTo: config.payTo, product, resourceUrl: ctx.resourceUrl })
  }

  function send402(ctx: RequestContext, product: Product | undefined, error: string | undefined, message: string): void {
    if (!product) return refuse(ctx.res, 402, error ?? 'payment_required', message)
    const challenge = challengeFor(ctx, product)
    send(
      ctx.res,
      402,
      error ? refusalWithChallenge(error, message, challenge) : challenge,
      { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(challenge) },
    )
  }

  function settlementUnknown(res: ServerResponse): void {
    refuse(
      res,
      503,
      'settlement_unknown',
      'The payment has not been confirmed as settled yet. Nothing has been delivered. Retry the same payment header shortly; it is checked against the chain and settles at most once.',
      { retry_after_seconds: SETTLEMENT_RETRY_SECONDS },
      { 'Retry-After': String(SETTLEMENT_RETRY_SECONDS) },
    )
  }

  function rateLimited(res: ServerResponse, retryAfter: number): void {
    refuse(
      res,
      429,
      'rate_limited',
      'Too many unpaid or unverified requests from this address. Retry after the time given.',
      { retry_after_seconds: retryAfter },
      { 'Retry-After': String(retryAfter) },
    )
  }

  function atCapacity(res: ServerResponse): void {
    refuse(
      res,
      503,
      'at_capacity',
      'The merchant is at capacity. Nothing settled and nothing was reserved. Retry the same payment header shortly.',
      { retry_after_seconds: AT_CAPACITY_RETRY_SECONDS },
      { 'Retry-After': String(AT_CAPACITY_RETRY_SECONDS) },
    )
  }

  /** The SIGN-IN-WITH-X challenge for a key, issuing (or reusing) its live nonce (§6 "The challenge"). */
  function siwxChallengeFor(ctx: RequestContext, record: ConsumedPaymentRecord): SiwxChallenge {
    const nonce = store.siwxNonces.issue(record.key, now().getTime())
    return buildSiwxChallenge({ ...siwxBinding(ctx.resourceUrl), chainId: config.chain.chainId, nonce })
  }

  function retryInfo(record: ConsumedPaymentRecord): Record<string, unknown> {
    return {
      same_payment: true,
      proof: 'SIGN-IN-WITH-X',
      forwards_left: Math.max(0, MAX_FORWARDS_PER_PAYMENT - record.forwardCount),
    }
  }

  function paymentResponseHeader(record: Pick<ConsumedPaymentRecord, 'txHash' | 'payer' | 'chain' | 'amount'>): Record<string, string> {
    if (!record.txHash) return {}
    const settlement: SettleResponse = {
      success: true,
      payer: record.payer,
      transaction: record.txHash,
      network: record.chain as SettleResponse['network'],
      amount: record.amount,
    }
    return { 'PAYMENT-RESPONSE': encodePaymentResponseHeader(settlement) }
  }

  /** A 2xx answer about a settled payment: `error` in the body, never `isError`, a challenge or `success: false`. */
  function answerSettled(res: ServerResponse, record: ConsumedPaymentRecord, error: string, message: string, extra: Record<string, unknown> = {}): void {
    send(
      res,
      200,
      {
        error,
        message,
        ...(record.txHash ? { payment: { tx_hash: record.txHash, chain: record.chain } } : {}),
        ...extra,
      },
      paymentResponseHeader(record),
    )
  }

  // ---- body checks (§7, §8) ---------------------------------------------

  /**
   * Read the request body. Up to the limit it is buffered; past it the rest is
   * read and DISCARDED (so the client gets to read the 413 instead of a reset)
   * until `DRAIN_LIMIT_BYTES`, beyond which the request is paused and the
   * connection is closed after the answer. The request is never destroyed
   * before the refusal is written.
   */
  function readBody(req: IncomingMessage): Promise<{ body: Buffer } | { tooLarge: true }> {
    const declared = firstHeader(req.headers['content-length'])
    if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > DRAIN_LIMIT_BYTES) {
      return Promise.resolve({ tooLarge: true })
    }
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let total = 0
      const cleanup = (): void => {
        req.off('data', onData)
        req.off('end', onEnd)
        req.off('error', onError)
      }
      const onData = (chunk: Buffer | string): void => {
        const length = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        total += length
        if (total > DRAIN_LIMIT_BYTES) {
          cleanup()
          req.pause()
          resolve({ tooLarge: true })
          return
        }
        if (total <= MAX_REQUEST_BODY_BYTES) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      const onEnd = (): void => {
        cleanup()
        resolve(total > MAX_REQUEST_BODY_BYTES ? { tooLarge: true } : { body: Buffer.concat(chunks) })
      }
      const onError = (err: Error): void => {
        cleanup()
        reject(err)
      }
      req.on('data', onData)
      req.on('end', onEnd)
      req.on('error', onError)
    })
  }

  /** Select the product and prepare the forwarded body; every failure is a refusal that makes no facilitator call. */
  function checkBody(candidates: readonly Product[], raw: { body: Buffer } | { tooLarge: true }): BodyOutcome {
    if ('tooLarge' in raw) {
      return {
        ...(candidates.length === 1 ? { product: candidates[0] } : {}),
        problem: { status: 413, error: 'body_too_large', message: 'The request body is larger than 1 MiB.' },
      }
    }
    const needsJson = candidates.some((c) => c.model !== undefined || c.outputTokenCap !== undefined)
    if (!needsJson) return { product: candidates[0], forwardBody: raw.body }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw.body.toString('utf8'))
    } catch {
      return { problem: { status: 400, error: 'bad_request', message: 'The request body must be JSON.' } }
    }

    let product: Product | undefined
    if (candidates.some((c) => c.model !== undefined)) {
      const model = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>).model : undefined
      product = candidates.find((c) => c.model === model)
      if (!product) {
        return {
          problem: {
            status: 400,
            error: 'bad_request',
            message: 'The request body\'s "model" is not one this endpoint sells on this route.',
          },
        }
      }
    } else {
      product = candidates[0]
    }
    if (product.outputTokenCap === undefined) return { product, forwardBody: raw.body }
    const capped = applyOutputTokenCap(parsed, product.outputTokenCap)
    if (!capped) {
      return {
        product,
        problem: {
          status: 400,
          error: 'cap_not_settable',
          message: `This product caps output at ${product.outputTokenCap} tokens, and the request body is not a chat-completions request the cap can be set on.`,
        },
      }
    }
    return { product, forwardBody: capped }
  }

  // ---- the payment's identity -------------------------------------------

  function derivePayment(header: string, chainId: number): PaymentContext {
    const payload = decodePayment(header)
    const { authorization, signature } = parseExactEvmPayload(payload.payload)
    if (!isAddress(authorization.from)) throw new PaymentError('Payment payer address is invalid')
    if (!NONCE_RE.test(authorization.nonce)) throw new PaymentError('Payment nonce must be 32 bytes')
    const payer = getAddress(authorization.from)
    return {
      header,
      payload,
      authorization,
      signature,
      key: paymentStoreKey('eip3009', chainId, payer, authorization.nonce),
      digest: authorizationDigest(authorization, signature),
      payer,
    }
  }

  /** The merchant's own refusals before settlement: a mismatch with the challenge, or an invalid payment. */
  function localCheckError(err: unknown): string {
    const message = err instanceof Error ? err.message : ''
    return /does not match|Unsupported x402|not addressed|echo|extensions|x402Version/.test(message)
      ? 'payment_mismatch'
      : 'payment_invalid'
  }

  // ---- chain resolution --------------------------------------------------

  type ChainOutcome =
    | { kind: 'settled'; txHash: Hex }
    | { kind: 'refused' }
    | { kind: 'unused' }
    | { kind: 'unknown' }

  /** Read what the chain says about one authorization. Bounded by the core's read timeouts. */
  async function learnChainOutcome(authorization: Eip3009Authorization): Promise<ChainOutcome> {
    const payer = getAddress(authorization.from)
    let used: boolean
    try {
      used = await cdp.chain.authorizationUsed(payer, authorization.nonce as Hex)
    } catch {
      return { kind: 'unknown' }
    }
    if (!used) return { kind: 'unused' }
    try {
      await recoverUsedAuthorization({ cdp, authorization })
    } catch (err) {
      if (err instanceof AuthorizationAlreadyUsedError) {
        return err.txHash ? { kind: 'settled', txHash: err.txHash } : { kind: 'unknown' }
      }
      if (err instanceof PaymentError && err.reasonCode === 'facilitator_refused') return { kind: 'refused' }
    }
    return { kind: 'unknown' }
  }

  const expiredAt = (authorization: Eip3009Authorization): boolean =>
    BigInt(Math.floor(now().getTime() / 1000)) >= BigInt(authorization.validBefore)

  // ---- known key (§6, §8 "For a known key") ------------------------------

  /**
   * Answer a request whose key the store knows. The digest is matched first:
   * a key alone authorizes nothing. Every forward here (`settled`, `failed`, a
   * stale `forwarding`) needs a SIGN-IN-WITH-X proof from the payer
   * (`forwardWithProof`). A request whose digest matches is never answered 429.
   */
  async function answerKnown(ctx: RequestContext, pay: PaymentContext, record: ConsumedPaymentRecord, depth = 0): Promise<void> {
    const { res } = ctx
    if (record.authorizationDigest !== pay.digest) {
      // Not this payment: a rebuilt or forged header counts against the address (§7).
      ipLimiter.charge(ctx.ip)
      return send402(ctx, ctx.body.product, 'payment_mismatch', 'This payment header does not match the payment recorded for it. Nothing was changed.')
    }
    if (depth > 3) return settlementUnknown(res)

    const product = ctx.body.product
    const settledStates = ['settled', 'forwarding', 'delivered', 'failed', 'exhausted']
    if (product && settledStates.includes(record.state) && record.productId !== product.id) {
      return answerSettled(res, record, 'payment_used_for_other_product', 'This payment settled for a different product and cannot buy this one.')
    }

    switch (record.state) {
      case 'delivered':
        return answerSettled(res, record, 'payment_already_delivered', 'This payment already bought its one call.')
      case 'exhausted':
        return answerExhausted(res, record)
      case 'settling': {
        const startedAt = holders.get(record.key)
        if (startedAt !== undefined) {
          if (performance.now() - startedAt < reservationDeadlineMs) return settlementUnknown(res)
          // The holder is past its deadline: void its token in one conditional update, then resolve from the chain.
          holders.delete(record.key)
          const cleared = await store.clearReservation(record.key, record.reservedAt)
          if (!cleared) {
            const again = await store.get(record.key)
            return again ? answerKnown(ctx, pay, again, depth + 1) : settlementUnknown(res)
          }
        }
        return resolveUnsettled(ctx, pay, record, depth)
      }
      case 'settlement_unknown':
        return resolveUnsettled(ctx, pay, record, depth)
      case 'forwarding': {
        const startedAt = record.forwardingStartedAt ? Date.parse(record.forwardingStartedAt) : NaN
        const remainingMs = startedAt + takeoverMs - now().getTime()
        if (Number.isFinite(startedAt) && remainingMs > 0) {
          return answerSettled(res, record, 'payment_in_flight', 'The call this payment bought is in flight. Retry the same payment shortly.', {
            retry_after_seconds: Math.ceil(remainingMs / 1000),
            sign_in_with_x: siwxChallengeFor(ctx, record),
          })
        }
        return forwardWithProof(ctx, pay, record, depth)
      }
      case 'failed':
        // Its forwards are used up: nothing a proof could buy, so none is asked for.
        if (record.forwardCount >= MAX_FORWARDS_PER_PAYMENT) return answerExhausted(res, record)
        return forwardWithProof(ctx, pay, record, depth)
      case 'settled':
        return forwardWithProof(ctx, pay, record, depth)
    }
  }

  function answerExhausted(res: ServerResponse, record: ConsumedPaymentRecord): void {
    answerSettled(res, record, 'payment_exhausted', `This payment was forwarded ${MAX_FORWARDS_PER_PAYMENT} times and each call failed. It buys no further call.`)
  }

  function answerNeedsProof(ctx: RequestContext, record: ConsumedPaymentRecord): void {
    answerSettled(
      ctx.res,
      record,
      'payment_retry_needs_proof',
      'This payment settled and its call has not been delivered. Present the same payment header again with a SIGN-IN-WITH-X header signed by the payer over the challenge under sign_in_with_x; nothing was forwarded and no forward was used.',
      { retry: retryInfo(record), sign_in_with_x: siwxChallengeFor(ctx, record) },
    )
  }

  /**
   * A forward other than the reserving request's first (§6, §7): the body
   * checks, then the payer's SIGN-IN-WITH-X proof over the key's live nonce,
   * then an upstream slot (waiting up to 10 s), then the nonce is retired (the
   * acceptance point, one conditional update), then `beginForwarding`. A
   * request that takes a slot and does not forward gives it back before it
   * answers.
   */
  async function forwardWithProof(ctx: RequestContext, pay: PaymentContext, record: ConsumedPaymentRecord, depth: number): Promise<void> {
    const { res, req } = ctx
    const product = ctx.body.product
    if (ctx.body.problem || !product) {
      const message = ctx.body.problem?.message ?? 'The request body could not be checked.'
      return answerSettled(res, record, 'bad_request_after_settlement', `${message} Nothing was forwarded and no forward was used.`, {
        retry: retryInfo(record),
        sign_in_with_x: siwxChallengeFor(ctx, record),
      })
    }
    const header = firstHeader(req.headers['sign-in-with-x'])
    if (!header) return answerNeedsProof(ctx, record)

    const nowMs = now().getTime()
    const check = await checkSiwxProof({
      header,
      binding: siwxBinding(ctx.resourceUrl),
      chainId: config.chain.chainId,
      live: store.siwxNonces.current(record.key, nowMs),
      payer: getAddress(record.payer),
      nowMs,
    })
    if (!check.ok) {
      log('retry_proof_refused', { key: record.key, reason: check.reason })
      return answerNeedsProof(ctx, record)
    }

    const slot = await upstreamGate.acquire(limits.upstreamSlotWaitMs)
    if (!slot) {
      // No forward used and the nonce not retired: the same proof can be presented again.
      return answerSettled(res, record, 'at_capacity_after_settlement', 'The merchant is at capacity. The payment settled; nothing was forwarded and no forward was used. Retry the same payment and proof shortly.', {
        retry_after_seconds: AT_CAPACITY_RETRY_SECONDS,
        retry: retryInfo(record),
        sign_in_with_x: siwxChallengeFor(ctx, record),
      })
    }
    try {
      if (!store.siwxNonces.retire(record.key, check.nonce, now().getTime())) {
        // Another request accepted this proof first, or its nonce lapsed while it waited.
        slot.release()
        return answerNeedsProof(ctx, record)
      }
      const begun = await store.beginForwarding(record.key, now().toISOString())
      const fresh = await store.get(record.key)
      if (begun === 'forward' && fresh) {
        log('payment_forward_with_proof', { key: record.key, forward_count: fresh.forwardCount })
        return await forwardAndAnswer(ctx, fresh, product)
      }
      slot.release()
      if (begun === 'delivered' && fresh) return answerSettled(res, fresh, 'payment_already_delivered', 'This payment already bought its one call.')
      if (begun === 'exhausted' && fresh) return answerExhausted(res, fresh)
      return fresh ? answerKnown(ctx, pay, fresh, depth + 1) : settlementUnknown(res)
    } finally {
      slot.release()
    }
  }

  /** `settling` without a live holder, or `settlement_unknown`: resolve from the chain; a payment found there becomes `settled`, never `forwarding`. */
  async function resolveUnsettled(ctx: RequestContext, pay: PaymentContext, record: ConsumedPaymentRecord, depth: number): Promise<void> {
    if (resolving.has(record.key)) return settlementUnknown(ctx.res)
    resolving.add(record.key)
    let outcome: ChainOutcome
    try {
      outcome = await learnChainOutcome(pay.authorization)
    } finally {
      resolving.delete(record.key)
    }
    switch (outcome.kind) {
      case 'settled': {
        const result = await store.markSettled(record.key, { txHash: outcome.txHash, settledAt: now().toISOString() })
        const fresh = await store.get(record.key)
        if (!fresh) return settlementUnknown(ctx.res)
        log('settlement_found_on_chain', { key: record.key, tx_hash: outcome.txHash, recorded: result })
        return answerKnown(ctx, pay, fresh, depth + 1)
      }
      case 'refused':
        await store.release(record.key)
        return send402(ctx, ctx.body.product, 'payment_mismatch', 'This authorization was used in a transaction that did not pay this merchant. Nothing was paid here and nothing is delivered.')
      case 'unused':
        if (expiredAt(pay.authorization)) {
          await store.release(record.key)
          return send402(ctx, ctx.body.product, 'settle_failed', 'The payment was never settled and its authorization has expired, so nothing was paid.')
        }
        return settlementUnknown(ctx.res)
      case 'unknown':
        return settlementUnknown(ctx.res)
    }
  }

  // ---- unknown key: reserve, verify, settle, forward (§6, §8) -----------

  /**
   * The facilitator calls, watched, so the answer to a failure follows what was
   * actually sent. The verify permit is given back when verify returns; the
   * upstream slot is taken after verify and before the settle call is sent
   * (§7), so a header that has not verified never holds one, and nothing is
   * settled for a call that will not be served.
   */
  function watchSettlement(verifyPermit: Permit) {
    const seen = { verifyRefused: false, settleSent: false, settleRefused: false, chainSaidUsed: false, noSlot: false }
    const held: { slot: Permit | null; done: boolean } = { slot: null, done: false }
    // Review of #4893: the slot wait is its own step in the 110 s budget (§6),
    // not part of settle's 30 s. The core bounds each wrapped call at
    // `timeoutMs`, so that outer bound is widened by the wait (and a margin, so
    // it never fires first), and each facilitator call is bounded here at the
    // core's own per-call value.
    const callMs = cdp.timeoutMs ?? CDP_CALL_TIMEOUT_MS
    const config: CdpSettlementConfig = {
      timeoutMs: callMs + limits.upstreamSlotWaitMs + 1_000,
      facilitator: {
        async verify(payload, requirements) {
          try {
            const result = await within(callMs, 'verify', cdp.facilitator.verify(payload, requirements))
            if (!result.isValid) seen.verifyRefused = true
            return result
          } catch (err) {
            if (err instanceof VerifyError) seen.verifyRefused = true
            throw err
          } finally {
            verifyPermit.release()
          }
        },
        async settle(payload, requirements) {
          if (!held.slot) {
            held.slot = await upstreamGate.acquire(limits.upstreamSlotWaitMs)
            if (!held.slot) {
              seen.noSlot = true
              // Not sent: the core reads the chain, finds the authorization unused, and answers retryable.
              throw new Error('no upstream slot within the wait')
            }
            if (held.done) {
              // The request has already answered: never send a settle for a released reservation.
              held.slot.release()
              seen.noSlot = true
              throw new Error('the request finished before a slot came free')
            }
          }
          seen.settleSent = true
          try {
            const result = await within(callMs, 'settle', cdp.facilitator.settle(payload, requirements))
            if (!result.success) seen.settleRefused = true
            return result
          } catch (err) {
            if (err instanceof SettleError) seen.settleRefused = true
            throw err
          }
        },
      } satisfies CdpFacilitator,
      chain: {
        async authorizationUsed(authorizer, nonce) {
          const used = await cdp.chain.authorizationUsed(authorizer, nonce)
          if (used) seen.chainSaidUsed = true
          return used
        },
        findAuthorizationOutcome: (params) => cdp.chain.findAuthorizationOutcome(params),
      },
    }
    return { seen, held, config }
  }

  type HolderOutcome =
    /**
     * `bySelf`: this holder's own settle call moved the money (its answer, or
     * the chain after the holder sent it). Only then may the holder make the
     * proof-free first forward. A transfer the chain-first read found that this
     * holder never sent may be anyone's replay of a public authorization
     * (review of #4893): it is recorded `settled`, and a forward needs a proof.
     */
    | { kind: 'settled'; txHash: Hex; bySelf: boolean }
    | { kind: 'refused'; error: string; message: string }
    | { kind: 'unknown' }
    | { kind: 'unavailable' }
    /** No upstream slot came free after verify: the settle call was never sent. */
    | { kind: 'at_capacity' }

  /** Settle as the reservation's holder, and decide what each failure leaves in the store. */
  async function settleAsHolder(
    pay: PaymentContext,
    verified: VerifiedCheck,
    watched: ReturnType<typeof watchSettlement>,
  ): Promise<HolderOutcome> {
    const { authorization } = pay
    try {
      const txHash = await settleThroughCdp({
        cdp: watched.config,
        payload: pay.payload,
        requirements: verified.quoted,
        authorization,
        expired: verified.expired,
      })
      return { kind: 'settled', txHash, bySelf: true }
    } catch (err) {
      if (err instanceof AuthorizationAlreadyUsedError) {
        // The chain says the money moved. A transaction found settles it; no
        // transaction found is "cannot tell yet". It is this holder's own
        // settlement only if this holder sent the settle call.
        return err.txHash
          ? { kind: 'settled', txHash: err.txHash, bySelf: watched.seen.settleSent }
          : { kind: 'unknown' }
      }
      if (err instanceof PaymentError && err.reasonCode === 'facilitator_refused') {
        return watched.seen.verifyRefused
          ? { kind: 'refused', error: 'payment_invalid', message: "Coinbase's facilitator refused this payment at verification. Nothing settled." }
          : { kind: 'refused', error: 'payment_mismatch', message: 'This authorization was not used to pay this merchant. Nothing was paid here and nothing is delivered.' }
      }
      if (err instanceof PaymentError && err.reasonCode === 'facilitator_retryable') {
        if (watched.seen.chainSaidUsed) return { kind: 'unknown' }
        if (watched.seen.noSlot && !watched.seen.settleSent) return { kind: 'at_capacity' }
        if (!watched.seen.settleSent) return { kind: 'unavailable' }
        return pollLostSettle(authorization, watched.seen.settleRefused)
      }
      if (err instanceof PaymentError) {
        return verified.expired
          ? { kind: 'refused', error: 'settle_failed', message: 'The payment authorization has expired and was never settled, so nothing was paid.' }
          : { kind: 'refused', error: localCheckError(err), message: err.message }
      }
      log('settle_error', { key: pay.key, error: describeError(err) })
      return watched.seen.settleSent || watched.seen.chainSaidUsed ? { kind: 'unknown' } : { kind: 'unavailable' }
    }
  }

  /**
   * The settle call was sent and its answer is lost: poll the chain up to
   * `SETTLE_RESOLVE_MS`, on the monotonic clock. Each read is raced against
   * the time left, so no read runs past the bound (§6, review of #4893).
   */
  async function pollLostSettle(authorization: Eip3009Authorization, definiteFailure: boolean): Promise<HolderOutcome> {
    const deadline = performance.now() + settleResolveMs
    for (;;) {
      const remaining = deadline - performance.now()
      if (remaining <= 0) break
      let timer: ReturnType<typeof setTimeout> | undefined
      const outcome = await Promise.race([
        learnChainOutcome(authorization),
        new Promise<ChainOutcome>((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'unknown' }), remaining)
        }),
      ]).finally(() => clearTimeout(timer))
      if (outcome.kind === 'settled') return { ...outcome, bySelf: true }
      if (outcome.kind === 'refused') {
        return { kind: 'refused', error: 'payment_mismatch', message: 'This authorization was used in a transaction that did not pay this merchant. Nothing was paid here and nothing is delivered.' }
      }
      if (outcome.kind === 'unused' && expiredAt(authorization)) {
        return { kind: 'refused', error: 'settle_failed', message: 'The payment was never settled and its authorization has expired, so nothing was paid.' }
      }
      if (performance.now() + settlePollMs >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, settlePollMs))
    }
    if (definiteFailure) {
      // The facilitator said the settle failed, and no transfer was found on the chain within the window.
      return { kind: 'refused', error: 'settle_failed', message: "Coinbase's facilitator reported the settlement failed and no transfer was found on the chain. Nothing was paid." }
    }
    return { kind: 'unknown' }
  }

  async function handleUnknownKey(ctx: RequestContext, pay: PaymentContext): Promise<void> {
    const { res } = ctx
    const product = ctx.body.product
    if (ctx.body.problem || !product) {
      const problem = ctx.body.problem!
      return refuse(res, problem.status, problem.error, problem.message)
    }
    const challenge = challengeFor(ctx, product)

    // The payment checks, before any facilitator call (§8 "Before settlement").
    let verified: VerifiedCheck
    try {
      // The payment must name the resource it was made for: the core skips the
      // resource check when a payload omits it. This refuses a client that
      // omits or mismatches it; it is not what binds a payment to its product
      // (the resource is not signed). A fresh payment is bound by the amount
      // and payee it signed, a known one by its recorded product. Haven's SDK
      // always sends it (packages/sdk/src/x402.ts).
      if (!pay.payload.resource?.url) {
        throw new PaymentError('Payment resource does not match quoted resource: the payment names no resource')
      }
      assertExtensionsEchoed(pay.payload, challenge)
      verified = await verifyCdpAuthorization({
        payload: pay.payload,
        paymentRequired: challenge,
        merchantAddress: config.payTo,
        expectedAmount: product.price,
        asset: config.chain,
      })
    } catch (err) {
      // A header that has not verified is not yet a payment: it counts against the address (§7).
      ipLimiter.charge(ctx.ip)
      return send402(ctx, product, localCheckError(err), err instanceof PaymentError ? err.message : 'The payment header could not be checked.')
    }

    // §7: an address over the limit gets 429 before its unknown key is reserved; then the global verify cap.
    const over = ipLimiter.over(ctx.ip)
    if (over !== null) return rateLimited(res, over)
    const verifyPermit = verifyGate.tryAcquire()
    if (!verifyPermit) return atCapacity(res)

    let reserved: Awaited<ReturnType<typeof store.reserve>>
    try {
      reserved = await store.reserve({
      key: pay.key,
      productId: product.id,
      chain: config.chain.network,
      payer: pay.payer,
      amount: product.price.toString(),
      validBefore: Number(pay.authorization.validBefore),
      merchantReference: newMerchantReference(),
        authorizationDigest: pay.digest,
        now: now().toISOString(),
      })
    } catch (err) {
      verifyPermit.release()
      throw err
    }
    if (!reserved.reserved) {
      verifyPermit.release()
      return answerKnown(ctx, pay, reserved.record)
    }

    holders.set(pay.key, performance.now())
    const watched = watchSettlement(verifyPermit)
    const releaseSlot = (): void => watched.held.slot?.release()
    let outcome: HolderOutcome
    try {
      outcome = await settleAsHolder(pay, verified, watched)
    } catch (err) {
      // §6's `finally` rule: release only when the settle call was provably
      // never sent; once it may have been, the outcome is unknown, never released.
      log('settle_unexpected_error', { key: pay.key, error: describeError(err) })
      outcome = watched.seen.settleSent || watched.seen.chainSaidUsed ? { kind: 'unknown' } : { kind: 'unavailable' }
    } finally {
      // Every earlier exit gives the verify token back: a chain-first read that found the authorization used, or a read that failed.
      verifyPermit.release()
      // Before any await: a slot granted from here on is given back and sends no settle.
      watched.held.done = true
    }

    try {
      // Only this holder's own settlement forwards, so only then is its slot kept.
      if (!(outcome.kind === 'settled' && outcome.bySelf)) releaseSlot()
      switch (outcome.kind) {
        case 'refused':
          await store.release(pay.key)
          log('payment_refused', { key: pay.key, error: outcome.error })
          if (outcome.error === 'payment_invalid' || outcome.error === 'payment_mismatch') ipLimiter.charge(ctx.ip)
          return send402(ctx, product, outcome.error, outcome.message)
        case 'at_capacity':
          await store.release(pay.key)
          log('at_capacity', { key: pay.key })
          return atCapacity(res)
        case 'unavailable':
          await store.release(pay.key)
          return refuse(
            res,
            503,
            'facilitator_unavailable',
            "The payment could not be checked with Coinbase's facilitator. Nothing settled and nothing was reserved. Retry the same payment header.",
            { retry_after_seconds: SETTLEMENT_RETRY_SECONDS },
            { 'Retry-After': String(SETTLEMENT_RETRY_SECONDS) },
          )
        case 'unknown':
          await store.markSettlementUnknown(pay.key, now().toISOString())
          log('settlement_unknown', { key: pay.key })
          return settlementUnknown(res)
        case 'settled': {
          // The proof-free first forward is for this holder's own settlement
          // only. A transfer it did not send is recorded without the token:
          // the holder gives its reservation up first (settlement_unknown
          // clears the token hash), then records `settled`, so a forward needs
          // a SIGN-IN-WITH-X proof.
          if (!outcome.bySelf) await store.markSettlementUnknown(pay.key, now().toISOString())
          const result = await store.markSettled(pay.key, {
            txHash: outcome.txHash,
            settledAt: now().toISOString(),
            ...(outcome.bySelf ? { reservationToken: reserved.reservationToken } : {}),
          })
          if (result === 'forward') {
            log('payment_settled', { key: pay.key, tx_hash: outcome.txHash, product_id: product.id })
            const record = await store.get(pay.key)
            if (!record) return settlementUnknown(res)
            return await forwardAndAnswer(ctx, record, product)
          }
          // The token was voided (a restart, or this holder passed its deadline): answer by the record's state.
          releaseSlot()
          const record = await store.get(pay.key)
          return record ? answerKnown(ctx, pay, record) : settlementUnknown(res)
        }
      }
    } finally {
      releaseSlot()
      holders.delete(pay.key)
    }
  }

  // ---- forwarding (§6, §7, §8) -------------------------------------------

  async function forwardAndAnswer(ctx: RequestContext, record: ConsumedPaymentRecord, product: Product): Promise<void> {
    const { req, res } = ctx
    const controller = new AbortController()
    let abortReason: 'timeout' | 'buyer_disconnected' | undefined
    const timer = setTimeout(() => {
      abortReason ??= 'timeout'
      controller.abort()
    }, config.upstreamTimeoutMs)
    const onClose = (): void => {
      if (!res.writableEnded) {
        abortReason ??= 'buyer_disconnected'
        // A disconnect aborts the upstream call, so it does not keep spending.
        controller.abort()
      }
    }
    res.on('close', onClose)

    let result: Awaited<ReturnType<typeof callUpstream>>
    try {
      result = await callUpstream({
        config,
        method: req.method ?? 'POST',
        subPath: ctx.subPath,
        search: ctx.url.search,
        incomingHeaders: req.headers,
        body: ctx.body.forwardBody,
        signal: controller.signal,
        abortReason: () => abortReason,
        fetchImpl,
      })
    } catch (err) {
      log('upstream_error', { key: record.key, error: describeError(err) })
      result = { kind: 'failed', reason: 'upstream_unreachable' }
    } finally {
      clearTimeout(timer)
      res.off('close', onClose)
    }

    if (result.kind === 'failed') return failAfterSettlement(ctx, record, result.reason, result.upstreamStatus)
    if (res.destroyed || res.closed) return failAfterSettlement(ctx, record, 'buyer_disconnected')

    await store.markDelivered(record.key, { upstreamStatus: result.status, deliveredAt: now().toISOString() })
    log('payment_delivered', { key: record.key, tx_hash: record.txHash, product_id: product.id, upstream_status: result.status })
    logOverage(record, product, result)

    const paymentHeader = paymentResponseHeader(record)
    if (result.status >= 200 && result.status < 300) {
      // A 2xx is passed through, headers and body unchanged except the stripped ones.
      const headers: Record<string, string | string[]> = {}
      for (const [name, value] of result.headers) headers[name] = value
      res.writeHead(result.status, { ...headers, 'Content-Length': result.body.length, ...paymentHeader })
      res.end(result.body)
      return
    }
    // A 3xx or a buyer-side 4xx is wrapped into a 200 (§8).
    const contentType = result.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? ''
    const wrapped = wrapUpstreamBody(result.body)
    send(
      res,
      200,
      {
        error: 'upstream_answered',
        message: `The upstream answered ${result.status} to this request. The payment was used for this call.`,
        payment: { tx_hash: record.txHash, chain: record.chain },
        upstream_status: result.status,
        upstream_content_type: contentType,
        ...wrapped,
      },
      paymentHeader,
    )
  }

  function wrapUpstreamBody(body: Buffer): Record<string, unknown> {
    const text = body.toString('utf8')
    if (Buffer.from(text, 'utf8').equals(body)) {
      try {
        return { upstream_body: JSON.parse(text) }
      } catch {
        return { upstream_body: text }
      }
    }
    return { upstream_body: body.toString('base64'), upstream_body_encoding: 'base64' }
  }

  function logOverage(record: ConsumedPaymentRecord, product: Product, result: { status: number; body: Buffer; headers: [string, string][] }): void {
    if (product.outputTokenCap === undefined || result.status < 200 || result.status >= 300) return
    try {
      const usage = (JSON.parse(result.body.toString('utf8')) as { usage?: { completion_tokens?: unknown } }).usage
      const tokens = usage?.completion_tokens
      if (typeof tokens === 'number' && tokens > product.outputTokenCap) {
        log('overage', { key: record.key, product_id: product.id, overage_tokens: tokens - product.outputTokenCap })
      }
    } catch {
      // not JSON: nothing to report
    }
  }

  async function failAfterSettlement(ctx: RequestContext, record: ConsumedPaymentRecord, reason: UpstreamFailureReason, upstreamStatus?: number): Promise<void> {
    await store.markFailed(record.key, { reason, failedAt: now().toISOString() })
    log(reason === 'upstream_auth_refused' ? 'upstream_auth_refused' : 'upstream_failed_after_settlement', {
      key: record.key,
      tx_hash: record.txHash,
      reason,
      ...(upstreamStatus !== undefined ? { upstream_status: upstreamStatus } : {}),
    })
    if (ctx.res.destroyed || ctx.res.closed) return
    const failed = { ...record, state: 'failed' as const }
    answerSettled(
      ctx.res,
      record,
      'upstream_failed_after_settlement',
      'The payment settled and the upstream call failed. Present the same payment header again with a SIGN-IN-WITH-X proof signed by the payer and it will be served without a second charge.',
      {
        reason,
        retry: { ...retryInfo(failed), after_seconds: 0 },
        ...(failed.forwardCount < MAX_FORWARDS_PER_PAYMENT ? { sign_in_with_x: siwxChallengeFor(ctx, failed) } : {}),
      },
    )
  }

  // ---- routing -----------------------------------------------------------

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', 'http://proxy.invalid')

    // Unpriced routes: health, and the public discovery document (§4). The
    // discovery document is served at the x402 well-known path and nowhere
    // else, outside BASE_PATH, and answering it makes no facilitator call.
    if (method === 'GET' && url.pathname === '/healthz') {
      const ready = store.isWritable()
      return send(res, ready ? 200 : 503, ready ? { status: 'ok', network: config.chain.network } : { status: 'not_ready' })
    }
    if ((method === 'GET' || method === 'HEAD') && url.pathname === DISCOVERY_PATH) {
      return send(res, 200, discovery)
    }

    const { basePath } = config
    if (basePath && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return refuse(res, 404, 'unknown_route', 'This route is not sold here.')
    }
    const subPath = (basePath ? url.pathname.slice(basePath.length) : url.pathname) || '/'
    const candidates = byRoute.get(`${method} ${subPath}`)
    if (!candidates) return refuse(res, 404, 'unknown_route', 'This route is not sold here.')

    const ip = clientIp(req)
    const header = firstHeader(req.headers['payment-signature']) ?? firstHeader(req.headers['x-payment'])
    if (!header) {
      // §7: unpaid requests are limited per address, in rate and in concurrency.
      const wait = ipLimiter.take(ip)
      if (wait !== null) return rateLimited(res, wait)
      if (!ipLimiter.enter(ip)) return rateLimited(res, 1)
      try {
        return await answerPriced(req, res, url, subPath, candidates, ip, undefined)
      } finally {
        ipLimiter.leave(ip)
      }
    }
    return answerPriced(req, res, url, subPath, candidates, ip, header)
  }

  function clientIp(req: IncomingMessage): string {
    if (config.clientIpHeader) {
      const value = firstHeader(req.headers[config.clientIpHeader])
      // A list (X-Forwarded-For): the rightmost entry is the one the merchant's own proxy appended.
      const last = value?.split(',').pop()?.trim()
      if (last) return last
    }
    return req.socket.remoteAddress ?? 'unknown'
  }

  async function answerPriced(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    subPath: string,
    candidates: readonly Product[],
    ip: string,
    header: string | undefined,
  ): Promise<void> {
    const origin = config.publicBaseUrl ?? `http://${firstHeader(req.headers.host) ?? 'localhost'}`
    const rawBody = await readBody(req)
    // An oversized body is not drained: answer, then close the connection.
    if ('tooLarge' in rawBody) res.setHeader('Connection', 'close')
    const body = checkBody(candidates, rawBody)
    const ctx: RequestContext = {
      req,
      res,
      url,
      subPath,
      resourceUrl: `${origin}${url.pathname}`,
      ip,
      body,
    }

    if (!header) {
      if (body.problem) return refuse(res, body.problem.status, body.problem.error, body.problem.message)
      return send402(ctx, body.product!, undefined, 'Payment required')
    }

    let pay: PaymentContext
    try {
      pay = derivePayment(header, config.chain.chainId)
    } catch (err) {
      // No key to look up: the body checks come first, then an invalid payment, which counts against the address.
      ipLimiter.charge(ip)
      if (body.problem) return refuse(res, body.problem.status, body.problem.error, body.problem.message)
      return send402(ctx, body.product!, 'payment_invalid', err instanceof PaymentError ? err.message : 'The payment header could not be read.')
    }

    const known = await store.get(pay.key)
    if (known) return answerKnown(ctx, pay, known)
    return handleUnknownKey(ctx, pay)
  }

  return async function handle(req, res) {
    try {
      await route(req, res)
    } catch (err) {
      log('internal_error', { error: describeError(err) })
      if (!res.headersSent) {
        refuse(res, 500, 'internal_error', 'The proxy hit an unexpected error. Nothing was forwarded.')
      } else {
        res.end()
      }
    }
  }
}

/** Race a facilitator call against its own bound; a call that does not answer in time is "did not answer". */
function within<T>(ms: number, label: string, call: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    call,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not answer within ${ms} ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * §5: the sale record's `merchant_reference`, `sale_<ulid>`, generated once at
 * reservation. A ULID: 48 bits of millisecond time and 80 random bits, in
 * Crockford base32 (26 characters), so references sort by creation time.
 */
export function newMerchantReference(nowMs: number = Date.now()): string {
  let time = ''
  let t = nowMs
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  const bytes = randomBytes(16)
  let random = ''
  for (let i = 0; i < 16; i++) random += CROCKFORD[bytes[i] % 32]
  return `sale_${time}${random}`
}
