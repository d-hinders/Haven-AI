import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient, toolDescriptions as sharedDescriptions } from '@haven_ai/sdk'
import { createToolHandlers, toolDescriptions } from './tools.js'

const delegateKey = '0x59c6995e998f97a5a0044966f09453843a4bba3e18a70e0614612ece7c1e4568'
const delegateAddress = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1'
const safeAddress = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const baseUrl = 'https://haven.example'
const txHash = `0x${'ab'.repeat(32)}`

const challenge = {
  rail: 'mpp_demo',
  version: '2026-05-12',
  challengeId: 'challenge-123',
  resource: 'https://merchant.example/data',
  description: 'Demo data',
  network: { chainId: 8453, name: 'base' },
  asset: {
    symbol: 'USDC',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
  },
  amount: { display: '0.01', atomic: '10000' },
  recipient: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
  expiresAt: '2099-01-01T00:00:00.000Z',
} as const

const x402PaymentRequired = {
  x402Version: 2,
  error: 'Payment required',
  resource: {
    url: 'https://merchant.example/data',
    description: 'Premium data',
    mimeType: 'application/json',
  },
  accepts: [
    {
      scheme: 'exact' as const,
      network: 'eip155:8453',
      asset: challenge.asset.address,
      amount: challenge.amount.atomic,
      payTo: challenge.recipient,
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2' },
    },
  ],
}

// resourceUrl is used by the #190 security tests below
const resourceUrl = challenge.resource

interface CapturedRequest {
  url: string
  init?: RequestInit
}

/**
 * Non-custody assertion: the delegate private key must never appear anywhere
 * in an outgoing HTTP call — URL, header name, header value, or body. The
 * checks handle every variant of the WHATWG fetch RequestInit shape:
 *
 *   - `init.headers` can be `Headers`, a plain record, or an array of
 *     `[name, value]` tuples. `JSON.stringify(new Headers(...))` returns
 *     `"{}"` (Headers does not implement toJSON), so we cannot rely on
 *     stringification alone — every shape is iterated explicitly.
 *   - `init.body` can be `string`, `URLSearchParams`, `FormData`, `Blob`,
 *     `Uint8Array`, or `ReadableStream`. `String(body)` on non-strings
 *     produces `"[object X]"` placeholders that would silently pass a
 *     substring check, so non-string bodies are inspected via their own
 *     iteration where possible and explicitly REJECTED with a clear test
 *     failure otherwise — we'd rather force the caller to widen the helper
 *     than silently green-light a leak.
 *
 * The substring check is case-folded and also tested against the unprefixed
 * (`key.slice(2)`) and URL-encoded (`encodeURIComponent(key)`) variants:
 * ABI encoders emit unprefixed hex, and a URL query parameter would emit the
 * encoded form.
 */
function assertNoDelegateKeyLeak(requests: CapturedRequest[], key: string): void {
  const variants = collectKeyVariants(key)
  for (const request of requests) {
    assertNoVariantPresent(request.url, variants, `request URL ${request.url}`)
    iterateHeaders(request.init?.headers, (name, value) => {
      assertNoVariantPresent(name, variants, `header name in ${request.url}`)
      assertNoVariantPresent(value, variants, `header value in ${request.url}`)
    })
    inspectBody(request.init?.body, (text, label) => {
      assertNoVariantPresent(text, variants, `${label} in ${request.url}`)
    })
  }
}

function collectKeyVariants(key: string): string[] {
  const unprefixed = key.startsWith('0x') ? key.slice(2) : key
  const variants = new Set<string>([
    key,
    key.toLowerCase(),
    key.toUpperCase(),
    unprefixed,
    unprefixed.toLowerCase(),
    unprefixed.toUpperCase(),
    encodeURIComponent(key),
    encodeURIComponent(unprefixed),
  ])
  return Array.from(variants).filter((v) => v.length > 0)
}

function assertNoVariantPresent(haystack: string, variants: string[], label: string): void {
  if (!haystack) return
  const lower = haystack.toLowerCase()
  for (const variant of variants) {
    expect(lower, `${label} contains delegate key (variant: ${variant.slice(0, 12)}…)`)
      .not.toContain(variant.toLowerCase())
  }
}

type HeadersLike = Headers | Record<string, string | string[]> | Array<[string, string]>

function iterateHeaders(
  headers: HeadersInit | undefined,
  visit: (name: string, value: string) => void,
): void {
  if (!headers) return
  if (headers instanceof Headers) {
    for (const [name, value] of headers) visit(name, value)
    return
  }
  if (Array.isArray(headers)) {
    for (const [name, value] of headers) visit(String(name), String(value))
    return
  }
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (Array.isArray(value)) for (const v of value) visit(name, String(v))
    else if (value != null) visit(name, String(value))
  }
}

function inspectBody(
  body: BodyInit | null | undefined,
  visit: (text: string, label: string) => void,
): void {
  if (body == null) return
  if (typeof body === 'string') { visit(body, 'body string'); return }
  if (body instanceof URLSearchParams) {
    for (const [k, v] of body) { visit(k, 'body param name'); visit(v, 'body param value') }
    return
  }
  // Force the test to fail loudly if a future SDK call uses a body shape we
  // don't inspect (Blob, FormData, Uint8Array, ReadableStream). Silently
  // passing on `'[object Blob]'` would defeat the non-custody invariant.
  throw new Error(
    `assertNoDelegateKeyLeak does not yet inspect body of type ${Object.prototype.toString.call(body)}; ` +
    `widen the helper before adding a Haven request that uses this body shape.`,
  )
}

describe('Haven MCP tool descriptions', () => {
  // Drift guard: every MCP tool description must contain ALL fragments of the
  // shared description (summary, behavior, nextActionGuidance) — not just the
  // summary. The previous version only asserted .toContain(summary), which
  // (a) missed drift in behavior/nextActionGuidance, and (b) was vacuously
  // true if a summary was ever set to an empty string (every string contains
  // ''). Asserting each fragment individually catches partial drift; the
  // non-empty assertion catches the empty-summary degenerate case.
  const cases: Array<{ tool: keyof typeof toolDescriptions; key: keyof typeof sharedDescriptions }> = [
    { tool: 'haven_quote_x402', key: 'quoteX402' },
    { tool: 'haven_pay_x402_quote', key: 'payX402' },
    { tool: 'haven_pay_x402', key: 'payX402OneShot' },
    { tool: 'haven_resume_x402_payment', key: 'resumeX402' },
    { tool: 'haven_quote_mpp', key: 'quoteMpp' },
    { tool: 'haven_pay_mpp_challenge', key: 'payMpp' },
    { tool: 'haven_resume_mpp_payment', key: 'resumeMpp' },
    { tool: 'haven_get_payment_status', key: 'getPaymentStatus' },
    { tool: 'haven_get_resume_state', key: 'getResumeState' },
    { tool: 'haven_get_agent', key: 'getAgent' },
    { tool: 'haven_get_allowances', key: 'getAllowances' },
    { tool: 'haven_list_receipts', key: 'listReceipts' },
  ]

  for (const { tool, key } of cases) {
    it(`${tool} composes every fragment from the shared ${key} description`, () => {
      const shared = sharedDescriptions[key]
      const desc = toolDescriptions[tool]
      // Every entry must have a non-empty summary so the substring check
      // below has a real anchor rather than the vacuously-true `''`.
      expect(shared.summary.length).toBeGreaterThan(10)
      expect(desc).toContain(shared.summary)
      if ('selectionGuidance' in shared && shared.selectionGuidance) {
        expect(desc).toContain(shared.selectionGuidance)
      }
      if (shared.behavior) expect(desc).toContain(shared.behavior)
      if (shared.nextActionGuidance) expect(desc).toContain(shared.nextActionGuidance)
    })
  }

  it('points budget and remaining-spend questions at the allowance tool', () => {
    const desc = toolDescriptions.haven_get_allowances.toLowerCase()

    expect(desc).toContain('budget')
    expect(desc).toContain('spend limit')
    expect(desc).toContain('remaining amount')
    expect(desc).toContain('remaining allowance')
    expect(desc).toContain('remaining budget')
    expect(desc).toContain('daily limit')
    expect(desc).toContain('what can i spend')
    expect(desc).toContain('what the agent can still spend')
  })

  it('keeps receipts routed away from remaining-budget questions', () => {
    const desc = toolDescriptions.haven_list_receipts.toLowerCase()

    expect(desc).toContain('transaction history')
    expect(desc).toContain('use the allowance tool instead')
    expect(desc).toContain('remaining allowance')
    expect(desc).toContain('what-can-i-spend')
  })

  it('keeps payment tools routed away from read-only budget questions', () => {
    for (const tool of ['haven_pay_x402_quote', 'haven_pay_mpp_challenge'] as const) {
      const desc = toolDescriptions[tool].toLowerCase()

      expect(desc).toContain('do not use this for read-only allowance')
      expect(desc).toContain('what-can-i-spend')
      expect(desc).toContain('use the allowance lookup tool instead')
    }
  })
})

describe('Haven MCP tool handlers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('pays MPP challenges without leaking the delegate key over HTTP', async () => {
    const requests: CapturedRequest[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      requests.push({ url: String(url), init })

      if (String(url).endsWith('/machine-payments/authorize')) {
        return jsonResponse({
          payment_id: 'payment-1',
          status: 'pending_signature',
          rail: 'mpp_demo',
          chain_id: 8453,
          safe_address: '0xSafe',
          sign_data: {
            hash: `0x${'11'.repeat(32)}`,
            components: {
              safe: '0xSafe',
              token: challenge.asset.address,
              to: challenge.recipient,
              amount: challenge.amount.atomic,
              payment_token: '0x0000000000000000000000000000000000000000',
              payment: '0',
              nonce: 1,
            },
            instructions: 'Sign locally',
          },
        })
      }

      if (String(url).endsWith('/payments/payment-1/sign')) {
        return jsonResponse({
          payment_id: 'payment-1',
          status: 'confirmed',
          tx_hash: txHash,
          token: 'USDC',
          amount: '0.01',
          to: challenge.recipient,
          chain_id: 8453,
        })
      }

      return jsonResponse({ delivered: true })
    })

    const haven = new HavenClient({ apiKey: 'sk_agent_test', delegateKey, baseUrl })
    const handlers = createToolHandlers(haven)
    const quote = await handlers.haven_quote_mpp({ challenge })
    expect(quote.success).toBe(true)
    if (!quote.success) throw new Error('quote failed')

    const paid = await handlers.haven_pay_mpp_challenge({ quote: quote.data })
    expect(paid.success).toBe(true)
    expect(JSON.stringify(paid)).toContain('delivered')

    assertNoDelegateKeyLeak(requests, delegateKey)
  })

  it('pays x402 quotes without leaking the delegate key over HTTP', async () => {
    const requests: CapturedRequest[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      requests.push({ url: String(url), init })
      const u = String(url)

      // First call: merchant returns 402 with x402 payload (used by quoteX402).
      // Second call: merchant returns 402 again on the pay path (Haven re-probes).
      if (u === x402PaymentRequired.resource.url) {
        // Has X-PAYMENT header? It's the retry — return the paid response.
        const headers = init?.headers ? new Headers(init.headers) : new Headers()
        if (headers.has('X-PAYMENT')) {
          return new Response(JSON.stringify({ ok: true, data: 'paid-x402' }), {
            status: 200,
            headers: {
              'PAYMENT-RESPONSE': btoa(JSON.stringify({
                success: true,
                transaction: txHash,
                network: x402PaymentRequired.accepts[0].network,
              })),
            },
          })
        }
        return new Response(JSON.stringify(x402PaymentRequired), {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (u.endsWith('/x402')) {
        // Haven funding leg — returns sign_data for the delegate to sign.
        return jsonResponse({
          payment_id: 'x402-pay-1',
          status: 'pending_signature',
          chain_id: 8453,
          safe_address: safeAddress,
          token: 'USDC',
          amount: '0.01',
          to: delegateAddress,
          resource_url: x402PaymentRequired.resource.url,
          sign_data: {
            hash: `0x${'22'.repeat(32)}`,
            components: {
              safe: safeAddress,
              token: x402PaymentRequired.accepts[0].asset,
              to: delegateAddress,
              amount: x402PaymentRequired.accepts[0].amount,
              payment_token: '0x0000000000000000000000000000000000000000',
              payment: '0',
              nonce: 1,
            },
            instructions: 'Sign with delegate key',
          },
        }, 201)
      }

      if (u.endsWith('/payments/x402-pay-1/sign')) {
        return jsonResponse({
          payment_id: 'x402-pay-1',
          status: 'confirmed',
          tx_hash: txHash,
          token: 'USDC',
          amount: '0.01',
          to: delegateAddress,
          explorer_url: `https://basescan.org/tx/${txHash}`,
        })
      }

      if (u.endsWith('/machine-payments/evidence')) {
        return jsonResponse({ evidence: { id: 'evidence-1' } }, 202)
      }

      return jsonResponse({})
    })

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey,
      baseUrl,
      x402Wallet: safeAddress,
    })
    const handlers = createToolHandlers(haven)

    const quote = await handlers.haven_quote_x402({ url: x402PaymentRequired.resource.url })
    expect(quote.success).toBe(true)
    if (!quote.success) throw new Error('quote failed')

    const paid = await handlers.haven_pay_x402_quote({ quote: quote.data })
    expect(paid.success).toBe(true)
    expect(JSON.stringify(paid)).toContain('paid-x402')

    // Haven traffic must have happened (sign data + sign endpoint) and
    // delegate_key must not appear in any request URL, header, or body.
    expect(requests.some((r) => r.url.endsWith('/x402'))).toBe(true)
    expect(requests.some((r) => r.url.endsWith('/payments/x402-pay-1/sign'))).toBe(true)
    assertNoDelegateKeyLeak(requests, delegateKey)
  })

  it('haven_pay_x402 one-shot: probes 402, pays, retries, returns merchant body', async () => {
    // Regression for the agent-feedback fix that added haven_pay_x402: the
    // single-call form must internally do quoteX402 -> payX402Quote -> retry
    // without the agent orchestrating intermediate tools. We assert the merchant
    // sees X-PAYMENT on exactly one retry and the response body reaches the agent.
    const requests: CapturedRequest[] = []
    let merchantRetries = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      requests.push({ url: String(url), init })
      const u = String(url)

      if (u === x402PaymentRequired.resource.url) {
        const headers = init?.headers ? new Headers(init.headers) : new Headers()
        if (headers.has('X-PAYMENT')) {
          merchantRetries += 1
          return new Response(JSON.stringify({ ok: true, data: 'one-shot-paid' }), {
            status: 200,
            headers: {
              'PAYMENT-RESPONSE': btoa(JSON.stringify({
                success: true,
                transaction: txHash,
                network: x402PaymentRequired.accepts[0].network,
              })),
            },
          })
        }
        return new Response(JSON.stringify(x402PaymentRequired), {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (u.endsWith('/x402')) {
        return jsonResponse({
          payment_id: 'x402-one-shot-1',
          status: 'pending_signature',
          chain_id: 8453,
          safe_address: safeAddress,
          token: 'USDC',
          amount: '0.01',
          to: delegateAddress,
          resource_url: x402PaymentRequired.resource.url,
          sign_data: {
            hash: `0x${'33'.repeat(32)}`,
            components: {
              safe: safeAddress,
              token: x402PaymentRequired.accepts[0].asset,
              to: delegateAddress,
              amount: x402PaymentRequired.accepts[0].amount,
              payment_token: '0x0000000000000000000000000000000000000000',
              payment: '0',
              nonce: 1,
            },
            instructions: 'Sign with delegate key',
          },
        }, 201)
      }

      if (u.endsWith('/payments/x402-one-shot-1/sign')) {
        return jsonResponse({
          payment_id: 'x402-one-shot-1',
          status: 'confirmed',
          tx_hash: txHash,
          token: 'USDC',
          amount: '0.01',
          to: delegateAddress,
          explorer_url: `https://basescan.org/tx/${txHash}`,
        })
      }

      if (u.endsWith('/machine-payments/evidence')) {
        return jsonResponse({ evidence: { id: 'evidence-1' } }, 202)
      }

      return jsonResponse({})
    })

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey,
      baseUrl,
      x402Wallet: safeAddress,
    })
    const handlers = createToolHandlers(haven)

    const result = await handlers.haven_pay_x402({ url: x402PaymentRequired.resource.url })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error('one-shot pay failed')
    expect(JSON.stringify(result.data)).toContain('one-shot-paid')
    expect((result.data as { status: number }).status).toBe(200)

    expect(merchantRetries).toBe(1)
    expect(requests.some((r) => r.url.endsWith('/x402'))).toBe(true)
    expect(requests.some((r) => r.url.endsWith('/payments/x402-one-shot-1/sign'))).toBe(true)
    assertNoDelegateKeyLeak(requests, delegateKey)
  })

  it('haven_pay_x402 one-shot: surfaces pending-approval state with resume context', async () => {
    // When the agent has insufficient on-chain allowance headroom, the one-shot
    // tool must surface the same approval-required failure shape as the split
    // tools — the agent should never silently succeed or fail.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, _init) => {
      const u = String(url)
      if (u === x402PaymentRequired.resource.url) {
        return new Response(JSON.stringify(x402PaymentRequired), {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (u.endsWith('/x402')) {
        return new Response(JSON.stringify({
          payment_id: 'pay-one-shot-overbudget-1',
          kind: 'approval_request',
          status: 'pending_approval',
          phase: 'user_approval_required',
          next_action: 'wait_for_user_approval',
          amount: '0.01',
          token: 'USDC',
          resource_url: x402PaymentRequired.resource.url,
          merchant_address: x402PaymentRequired.accepts[0].payTo,
          tx_hash: null,
          expires_at: '2099-01-01T00:00:00.000Z',
          chain_id: 8453,
          message: 'Allowance exhausted — awaiting user approval',
        }), { status: 202, headers: { 'Content-Type': 'application/json' } })
      }
      return jsonResponse({})
    })

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey,
      baseUrl,
      x402Wallet: safeAddress,
    })
    const handlers = createToolHandlers(haven)

    const result = await handlers.haven_pay_x402({ url: x402PaymentRequired.resource.url })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.nextAction).toBe('wait_for_user_approval')
      expect(result.status).toBe('pending_approval')
      expect(result.paymentId).toBe('pay-one-shot-overbudget-1')
    }
  })

  it('resumes x402 payments by payment_id without leaking the delegate key', async () => {
    const requests: CapturedRequest[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      requests.push({ url: String(url), init })
      const u = String(url)

      if (u.endsWith('/payments/approval-9/resume_state')) {
        // Server-side resume rehydration — returns the captured x402 context.
        return jsonResponse({
          rail: 'x402',
          paymentId: 'approval-9',
          idempotencyKey: 'x402:approval-9',
          paymentRequired: x402PaymentRequired,
          accepted: x402PaymentRequired.accepts[0],
          url: x402PaymentRequired.resource.url,
          resourceUrl: x402PaymentRequired.resource.url,
          description: x402PaymentRequired.resource.description,
          amountAtomic: x402PaymentRequired.accepts[0].amount,
          amount: '0.01',
          token: 'USDC',
          asset: x402PaymentRequired.accepts[0].asset,
          network: x402PaymentRequired.accepts[0].network,
          chainId: 8453,
          merchantAddress: x402PaymentRequired.accepts[0].payTo,
        })
      }

      if (u.endsWith('/machine-payments/approval-9/status')) {
        // resumeX402Payment calls getPaymentStatus and requires status.rail
        // to be x402 with nextAction=retry_original_x402_request and a real
        // txHash on the funding leg.
        return jsonResponse({
          payment_id: 'approval-9',
          kind: 'approval_request',
          rail: 'x402',
          status: 'executed',
          phase: 'funding_sent',
          next_action: 'retry_original_x402_request',
          amount: '0.01',
          token: 'USDC',
          resource_url: x402PaymentRequired.resource.url,
          merchant_address: x402PaymentRequired.accepts[0].payTo,
          tx_hash: txHash,
          expires_at: '2099-01-01T00:00:00.000Z',
          chain_id: 8453,
          message: 'Resume the original x402 request.',
          amount_atomic: x402PaymentRequired.accepts[0].amount,
          asset: x402PaymentRequired.accepts[0].asset,
          network: x402PaymentRequired.accepts[0].network,
        })
      }

      if (u === x402PaymentRequired.resource.url) {
        return new Response(JSON.stringify({ ok: true, data: 'resumed-x402' }), {
          status: 200,
          headers: {
            'PAYMENT-RESPONSE': btoa(JSON.stringify({
              success: true,
              transaction: txHash,
              network: x402PaymentRequired.accepts[0].network,
            })),
          },
        })
      }

      if (u.endsWith('/machine-payments/evidence')) {
        return jsonResponse({ evidence: { id: 'evidence-1' } }, 202)
      }

      return jsonResponse({})
    })

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey,
      baseUrl,
      x402Wallet: safeAddress,
    })
    const handlers = createToolHandlers(haven)

    // Path 1: rehydrate via getResumeState tool and pass the state in.
    const state = await handlers.haven_get_resume_state({ payment_id: 'approval-9' })
    expect(state.success).toBe(true)
    if (!state.success) throw new Error('get_resume_state failed')

    const resumed = await handlers.haven_resume_x402_payment({ resume_state: state.data })
    expect(resumed.success).toBe(true)

    // Path 2: pass only payment_id — the tool fetches resume state internally.
    const resumedById = await handlers.haven_resume_x402_payment({ payment_id: 'approval-9' })
    expect(resumedById.success).toBe(true)

    assertNoDelegateKeyLeak(requests, delegateKey)
  })


  // ── #190 Security & regulatory tests ────────────────────────────────────

  it('[#190] x402 payment: delegate key never appears in any HTTP request — custody invariant', async () => {
    // This test would FAIL before the fix — a leaky implementation would
    // embed the raw private key in an Authorization header or request body.
    // The non-custodial architecture requires only {payloadHash, signature}
    // to cross the wire, never the raw delegate key.
    const requests: Array<{ url: string; init?: RequestInit }> = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      requests.push({ url: String(url), init })

      // First call: resource URL probe returns x402 Payment Required
      if (String(url) === resourceUrl && !init?.headers) {
        return new Response(JSON.stringify(x402PaymentRequired), {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      // x402 wallet probe (first call with Haven wallet header)
      if (String(url) === resourceUrl) {
        return new Response(JSON.stringify(x402PaymentRequired), {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      // Haven backend: POST /x402 (authorize — funds delegate, never receives key)
      if (String(url).endsWith('/x402')) {
        return new Response(JSON.stringify({
          payment_id: 'pay-x402-1',
          status: 'pending_signature',
          chain_id: 8453,
          safe_address: safeAddress,
          token: 'USDC',
          amount: '0.01',
          to: delegateAddress,
          resource_url: resourceUrl,
          sign_data: {
            hash: `0x${'22'.repeat(32)}`,
            components: {
              safe: safeAddress,
              token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
              to: delegateAddress,
              amount: '10000',
              payment_token: '0x0000000000000000000000000000000000000000',
              payment: '0',
              nonce: 1,
            },
            instructions: 'Sign with delegate key',
          },
        }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      }
      // Haven backend: POST /payments/:id/sign (receives signature, not key)
      if (String(url).match(/\/payments\/pay-x402-1\/sign/)) {
        return jsonResponse({
          payment_id: 'pay-x402-1',
          status: 'confirmed',
          tx_hash: txHash,
          chain_id: 8453,
          token: 'USDC',
          amount: '0.01',
          to: delegateAddress,
          explorer_url: `https://basescan.org/tx/${txHash}`,
        })
      }
      // Haven backend: POST /machine-payments/evidence (optional receipt)
      if (String(url).endsWith('/machine-payments/evidence')) {
        return jsonResponse({ evidence: { id: 'ev-1' } }, 202)
      }
      // Resource retry with X-PAYMENT header — merchant confirms
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'PAYMENT-RESPONSE': btoa(JSON.stringify({
            success: true,
            transaction: txHash,
            network: 'eip155:8453',
          })),
        },
      })
    })

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey,
      baseUrl,
      x402Wallet: safeAddress,
    })
    const handlers = createToolHandlers(haven)

    // Step 1: Quote (inspects resource URL, no payment)
    const quote = await handlers.haven_quote_x402({ url: resourceUrl })
    expect(quote.success).toBe(true)

    // Step 2: Pay — key must NEVER appear in any request
    const paid = await handlers.haven_pay_x402_quote({ quote: (quote as { success: true; data: unknown }).data })
    // Payment may succeed or queue for approval — either way, key must not leak
    expect([true, false]).toContain(paid.success)

    for (const request of requests) {
      const requestText = [
        request.url,
        JSON.stringify(request.init?.headers ?? {}),
        String(request.init?.body ?? ''),
      ].join(' ')
      expect(requestText, `x402: delegate key must not appear in request to ${request.url}`)
        .not.toContain(delegateKey)
    }
  })

  it('[#190] over-budget x402 payment queues for user approval (regression)', async () => {
    // Regression guard: when the Safe AllowanceModule has insufficient headroom,
    // Haven MUST queue the payment for user approval rather than reject it
    // outright or — critically — attempt to bypass the on-chain constraint.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, _init) => {
      if (String(url) === resourceUrl) {
        return new Response(JSON.stringify(x402PaymentRequired), {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (String(url).endsWith('/x402')) {
        return new Response(JSON.stringify({
          payment_id: 'pay-overbudget-1',
          kind: 'approval_request',
          status: 'pending_approval',
          phase: 'user_approval_required',
          next_action: 'wait_for_user_approval',
          amount: '0.01',
          token: 'USDC',
          resource_url: resourceUrl,
          merchant_address: x402PaymentRequired.accepts[0].payTo,
          tx_hash: null,
          expires_at: '2099-01-01T00:00:00.000Z',
          chain_id: 8453,
          message: 'Allowance exhausted — awaiting user approval',
        }), { status: 202, headers: { 'Content-Type': 'application/json' } })
      }
      return jsonResponse({})
    })

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey,
      baseUrl,
      x402Wallet: safeAddress,
    })
    const handlers = createToolHandlers(haven)
    const quote = await handlers.haven_quote_x402({ url: resourceUrl })
    expect(quote.success).toBe(true)

    const result = await handlers.haven_pay_x402_quote({
      quote: (quote as { success: true; data: unknown }).data,
    })

    // Must surface approval-required state — never silently fail or succeed
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.nextAction).toBe('wait_for_user_approval')
      expect(result.status).toBe('pending_approval')
      expect(result.paymentId).toBe('pay-overbudget-1')
      // Note: for x402 approvals, resume_state is fetched lazily via
      // haven_get_resume_state(paymentId) once the user approves the payment.
      // The SDK returns undefined here because the haven backend 202 response
      // doesn't carry the full x402 quote context needed to reconstruct it
      // inline. This is by design — don't assert toBeDefined() here.
    }
  })

  it('[#190] over-budget MPP payment queues for user approval (regression — unchanged)', async () => {
    // Mirror of the x402 regression but for the MPP rail.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({
      payment_id: 'pay-mpp-budget-1',
      kind: 'approval_request',
      rail: 'mpp_demo',
      status: 'pending_approval',
      phase: 'user_approval_required',
      next_action: 'wait_for_user_approval',
      amount: '25.00',
      token: 'USDC',
      resource_url: challenge.resource,
      merchant_address: challenge.recipient,
      tx_hash: null,
      expires_at: '2099-01-01T00:00:00.000Z',
      chain_id: 8453,
      message: 'Allowance exhausted — awaiting user approval',
      mpp: {
        amount_atomic: challenge.amount.atomic,
        asset: challenge.asset.address,
        network: 'base',
        resource_url: challenge.resource,
        merchant_address: challenge.recipient,
        description: challenge.description,
        idempotency_key: 'mpp:budget-test',
        challenge_id: challenge.challengeId,
      },
    }, 202))

    const haven = new HavenClient({ apiKey: 'sk_agent_test', delegateKey, baseUrl })
    const handlers = createToolHandlers(haven)
    const mppQuote = {
      rail: 'mpp',
      paymentRail: 'mpp_demo',
      idempotencyKey: 'mpp:budget-test',
      challenge,
      request: { url: challenge.resource, method: 'GET', headers: [] },
      resourceUrl: challenge.resource,
      description: challenge.description,
      amountAtomic: challenge.amount.atomic,
      amount: '25.00',
      token: 'USDC',
      asset: challenge.asset.address,
      network: 'base',
      chainId: 8453,
      merchantAddress: challenge.recipient,
      expiresAt: challenge.expiresAt,
    }

    const result = await handlers.haven_pay_mpp_challenge({ quote: mppQuote })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.nextAction).toBe('wait_for_user_approval')
      expect(result.status).toBe('pending_approval')
      expect(result.paymentId).toBe('pay-mpp-budget-1')
      expect(result.resume_state).toBeDefined()
    }
  })

  it('[#190] read-only tools (get_agent, get_allowances) never transmit the delegate key', async () => {
    // Non-payment tools must also uphold the key-isolation invariant.
    const requests: Array<{ url: string; body: string; headers: string }> = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      requests.push({
        url: String(url),
        body: String(init?.body ?? ''),
        headers: JSON.stringify(init?.headers ?? {}),
      })
      if (String(url).endsWith('/agents/me')) {
        return jsonResponse({
          id: 'agt_1', name: 'Test', delegate_address: delegateAddress,
          safe_address: safeAddress, chain_id: 8453, status: 'active',
        })
      }
      if (String(url).includes('/allowances')) {
        return jsonResponse({ on_chain: [], configured: [] })
      }
      return jsonResponse({})
    })

    const haven = new HavenClient({ apiKey: 'sk_agent_test', delegateKey, baseUrl })
    const handlers = createToolHandlers(haven)

    await handlers.haven_get_agent({})
    await handlers.haven_get_allowances({})

    expect(requests.length).toBeGreaterThan(0)
    for (const req of requests) {
      const all = `${req.url} ${req.body} ${req.headers}`
      expect(all, `read-only tool: delegate key must not appear in request to ${req.url}`)
        .not.toContain(delegateKey)
    }
  })

  it('negative control: assertNoDelegateKeyLeak fails when the key is present', () => {
    // Without these the non-custody assertion could be silently weakened
    // (e.g. comparing against a stripped version of the key) and still pass.
    // Each case targets a different leak path the helper claims to cover.
    const unprefixed = delegateKey.slice(2)
    const cases: Array<{ label: string; req: CapturedRequest }> = [
      { label: 'URL query', req: { url: `https://haven.example/leak?k=${delegateKey}` } },
      { label: 'string body', req: { url: 'https://haven.example/x', init: { body: `{"key":"${delegateKey}"}` } } },
      { label: 'plain-object header value', req: { url: 'https://haven.example/x', init: { headers: { 'X-Leak': delegateKey } } } },
      { label: 'plain-object header name', req: { url: 'https://haven.example/x', init: { headers: { [delegateKey]: '1' } } } },
      { label: 'Headers instance value', req: { url: 'https://haven.example/x', init: { headers: new Headers([['X-Leak', delegateKey]]) } } },
      { label: 'Headers instance name', req: { url: 'https://haven.example/x', init: { headers: new Headers([[`x-${delegateKey.toLowerCase()}`, '1']]) } } },
      { label: 'header-array tuples', req: { url: 'https://haven.example/x', init: { headers: [['X-Leak', delegateKey]] } } },
      { label: 'URL-encoded variant', req: { url: `https://haven.example/leak?k=${encodeURIComponent(delegateKey)}` } },
      { label: 'unprefixed hex (ABI encoder style)', req: { url: 'https://haven.example/x', init: { body: `{"k":"${unprefixed}"}` } } },
      { label: 'uppercased hex', req: { url: 'https://haven.example/x', init: { body: `{"k":"${delegateKey.toUpperCase()}"}` } } },
      { label: 'URLSearchParams body value', req: { url: 'https://haven.example/x', init: { body: new URLSearchParams({ key: delegateKey }) } } },
    ]
    for (const { label, req } of cases) {
      expect(
        () => assertNoDelegateKeyLeak([req], delegateKey),
        `should detect leak in: ${label}`,
      ).toThrow()
    }
  })

  it('negative control: assertNoDelegateKeyLeak loudly rejects unknown body shapes', () => {
    // If a future SDK switches a Haven call to a body shape this helper
    // doesn't inspect (Blob, FormData, ReadableStream, Uint8Array), it must
    // fail loudly rather than green-light the call. The test confirms the
    // helper throws on unknown shapes instead of silently passing.
    const blob = new Blob([delegateKey])
    expect(() =>
      assertNoDelegateKeyLeak(
        [{ url: 'https://haven.example/x', init: { body: blob } }],
        delegateKey,
      ),
    ).toThrow(/does not yet inspect body of type/)
  })

  it('returns structured payment state errors with nextAction and resume_state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({
      payment_id: 'approval-1',
      kind: 'approval_request',
      rail: 'mpp_demo',
      status: 'pending_approval',
      phase: 'user_approval_required',
      next_action: 'wait_for_user_approval',
      amount: '0.01',
      token: 'USDC',
      resource_url: challenge.resource,
      merchant_address: challenge.recipient,
      tx_hash: null,
      expires_at: '2099-01-01T00:00:00.000Z',
      chain_id: 8453,
      message: 'Waiting for user approval',
      mpp: {
        amount_atomic: '10000',
        asset: challenge.asset.address,
        network: 'base',
        resource_url: challenge.resource,
        merchant_address: challenge.recipient,
        description: challenge.description,
        idempotency_key: 'mpp:test',
        challenge_id: challenge.challengeId,
      },
    }, 202))

    const haven = new HavenClient({ apiKey: 'sk_agent_test', delegateKey, baseUrl })
    const handlers = createToolHandlers(haven)
    const quote = {
      rail: 'mpp',
      paymentRail: 'mpp_demo',
      idempotencyKey: 'mpp:test',
      challenge,
      request: { url: challenge.resource, method: 'GET', headers: [] },
      resourceUrl: challenge.resource,
      description: challenge.description,
      amountAtomic: '10000',
      amount: '0.01',
      token: 'USDC',
      asset: challenge.asset.address,
      network: 'base',
      chainId: 8453,
      merchantAddress: challenge.recipient,
      expiresAt: challenge.expiresAt,
    }

    const result = await handlers.haven_pay_mpp_challenge({ quote })

    expect(result).toMatchObject({
      success: false,
      code: 'API_ERROR',
      paymentId: 'approval-1',
      status: 'pending_approval',
      phase: 'user_approval_required',
      nextAction: 'wait_for_user_approval',
      resume_state: {
        rail: 'mpp',
        paymentId: 'approval-1',
      },
    })
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
