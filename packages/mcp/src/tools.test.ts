import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient, toolDescriptions as sharedDescriptions } from '@haven_ai/sdk'
import { createToolHandlers, toolDescriptions } from './tools.js'
import { readFileSync } from 'node:fs'

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
    for (const tool of ['haven_pay_x402_quote'] as const) {
      const desc = toolDescriptions[tool].toLowerCase()

      expect(desc).toContain('do not use this for read-only allowance')
      expect(desc).toContain('what-can-i-spend')
      expect(desc).toContain('use the allowance lookup tool instead')
    }
  })

  it('no longer registers the retired mpp_demo MCP tools (#1328)', () => {
    const names = Object.keys(toolDescriptions)
    expect(names).not.toContain('haven_quote_mpp')
    expect(names).not.toContain('haven_pay_mpp_challenge')
    expect(names).not.toContain('haven_resume_mpp_payment')
  })
})

describe('Haven MCP tool handlers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
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

  it('insufficient delegate balance + allowance: pre-flight surfaces structured failure', async () => {
    // Slice B regression: when the delegate's on-chain balance plus the
    // remaining Safe AllowanceModule allowance cannot cover the requested
    // amount, the Haven backend returns 422 with a structured shape and the
    // MCP tool MUST surface phase + nextAction so the agent can tell the
    // user "fund the Safe or raise the allowance" rather than silently
    // burning a sign step that would revert on-chain.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, _init) => {
      const u = String(url)
      if (u === resourceUrl) {
        return new Response(JSON.stringify(x402PaymentRequired), {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (u.endsWith('/x402')) {
        return new Response(JSON.stringify({
          error:
            'Insufficient funds to pay 0.02 USDC: delegate balance 0.0 + remaining allowance 0.005 ' +
            '= 0.005 USDC, short by 0.015. Fund the Safe or raise the agent allowance and retry.',
          error_code: 'insufficient_funds',
          phase: 'insufficient_funds',
          next_action: 'fund_safe_or_raise_allowance',
          rail: 'x402',
          chain_id: 8453,
          token: 'USDC',
          asset: x402PaymentRequired.accepts[0].asset,
          network: x402PaymentRequired.accepts[0].network,
          amount: '0.02',
          amount_atomic: '20000',
          delegate_balance: '0.0',
          delegate_balance_atomic: '0',
          remaining_allowance: '0.005',
          remaining_allowance_atomic: '5000',
          shortfall: '0.015',
          shortfall_atomic: '15000',
          resource_url: resourceUrl,
          merchant_address: x402PaymentRequired.accepts[0].payTo,
        }), { status: 422, headers: { 'Content-Type': 'application/json' } })
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

    const result = await handlers.haven_pay_x402({ url: resourceUrl })

    expect(result.success).toBe(false)
    if (!result.success) {
      // The two machine-readable fields the agent should branch on.
      expect(result.nextAction).toBe('fund_safe_or_raise_allowance')
      expect(result.phase).toBe('insufficient_funds')
      expect(result.statusCode).toBe(422)
      // No payment_id because no intent was created — the pre-flight check
      // short-circuits before any state-creating write. This is the field
      // an agent uses to decide "is there something to resume?" — there is
      // not, so it should remain undefined.
      expect(result.paymentId).toBeUndefined()
      // The structured body must carry the actionable shortfall details so
      // the agent can surface them to the user verbatim.
      const body = result.body as Record<string, unknown>
      expect(body.error_code).toBe('insufficient_funds')
      expect(body.shortfall_atomic).toBe('15000')
      expect(body.delegate_balance_atomic).toBe('0')
      expect(body.remaining_allowance_atomic).toBe('5000')
      // Non-custody surveillance guard: the structured failure must NOT
      // echo the delegate or Safe address back to the agent runtime. The
      // agent already holds both via its credential; surfacing them here
      // widens the hot-wallet delegate's monitoring surface for no benefit.
      expect(body).not.toHaveProperty('delegate_address')
      expect(body).not.toHaveProperty('safe_address')
      // Message must be human-readable and reference the actual token + amount.
      expect(result.message).toMatch(/Insufficient funds/i)
      expect(result.message).toContain('USDC')
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
      // haven_get_agent now folds in getAllowances (getAgentSummary), so stub
      // BOTH endpoints with valid bodies — otherwise the tool errors out and the
      // test would assert key-isolation on a request that never really happened.
      if (String(url).endsWith('/machine-payments/agent')) {
        return jsonResponse({
          id: 'agt_1', name: 'Test', delegate_address: delegateAddress,
          safe_address: safeAddress, chain_id: 8453, status: 'active',
        })
      }
      if (String(url).includes('/allowances')) {
        return jsonResponse({
          agent_id: 'agt_1', safe_address: safeAddress, delegate_address: delegateAddress,
          chain_id: 8453, allowances: [],
        })
      }
      return jsonResponse({})
    })

    const haven = new HavenClient({ apiKey: 'sk_agent_test', delegateKey, baseUrl })
    const handlers = createToolHandlers(haven)

    const agentResult = await handlers.haven_get_agent({})
    const allowancesResult = await handlers.haven_get_allowances({})
    // Both tools must actually succeed now, so the key-isolation check below runs
    // against real requests rather than a swallowed error path.
    expect(agentResult.success).toBe(true)
    expect(allowancesResult.success).toBe(true)

    expect(requests.length).toBeGreaterThan(0)
    for (const req of requests) {
      const all = `${req.url} ${req.body} ${req.headers}`
      expect(all, `read-only tool: delegate key must not appear in request to ${req.url}`)
        .not.toContain(delegateKey)
    }
  })

  it('haven_get_agent returns the enriched bootstrap summary (identity + readiness + remaining)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url)
      if (u.endsWith('/machine-payments/agent')) {
        return jsonResponse({
          id: 'agt_1', name: 'Test', status: 'active',
          safe_address: safeAddress, delegate_address: delegateAddress, chain_id: 8453,
        })
      }
      if (u.includes('/allowances')) {
        return jsonResponse({
          agent_id: 'agt_1', safe_address: safeAddress, delegate_address: delegateAddress, chain_id: 8453,
          allowances: [{
            id: 'a1', token_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            token_symbol: 'USDC', configured_amount: '10000', reset_period_min: 60,
            onchain: {
              amount: '10000', spent: '2500', remaining: '7500', effective_spent: '2500',
              reset_time_min: 60, last_reset_min: 100, nonce: 7, is_reset_pending: false,
            },
          }],
        })
      }
      return jsonResponse({})
    })

    const haven = new HavenClient({ apiKey: 'sk_agent_test', delegateKey, baseUrl })
    const result = await createToolHandlers(haven).haven_get_agent({})

    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    const data = result.data as { id: string; readiness: string; allowances: Array<Record<string, unknown>> }
    expect(data.id).toBe('agt_1')
    expect(data.readiness).toBe('ready')
    expect(data.allowances[0]).toMatchObject({
      tokenSymbol: 'USDC',
      remainingAtomic: '7500',
      remainingDisplay: '0.0075 USDC',
    })
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

})

describe('haven_send', () => {
  const SEND_DELEGATE_KEY = '0x' + 'b'.repeat(64)
  const SIGN_HASH = `0x${'aa'.repeat(32)}`

  function sendHandlers() {
    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      baseUrl: 'http://haven.test',
      delegateKey: SEND_DELEGATE_KEY,
    })
    return createToolHandlers(haven)
  }

  it('sends USDC in-budget: signs locally and confirms', async () => {
    const requests: CapturedRequest[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      requests.push({ url: String(url), init })
      const path = new URL(String(url)).pathname
      // POST /payments → intent
      if (path === '/payments' && (!init?.method || init.method === 'POST')) {
        return jsonResponse({
          payment_id: 'send_1',
          status: 'pending_signature',
          expires_at: '2099-01-01T00:00:00.000Z',
          sign_data: { hash: SIGN_HASH, components: {} },
        }, 201)
      }
      // POST /payments/send_1/sign → submit signature
      if (path.endsWith('/sign')) {
        return jsonResponse({ payment_id: 'send_1', status: 'confirmed', tx_hash: '0xtx' })
      }
      // GET /payments/send_1 → waitForConfirmation poll
      if (path === '/payments/send_1' && (!init?.method || init.method === 'GET')) {
        return jsonResponse({ payment_id: 'send_1', status: 'confirmed', tx_hash: '0xtx' })
      }
      return jsonResponse({})
    })

    const result = await sendHandlers().haven_send({
      asset: 'USDC',
      recipient: '0xRecipient',
      amount: '5.00',
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as any).status).toBe('confirmed')
      expect((result.data as any).tx_hash).toBe('0xtx')
    }

    // Only { signature } was sent to Haven — no key material in transit.
    const signCall = requests.find((r) => r.url.includes('/sign'))
    const signBody = JSON.parse(signCall?.init?.body as string ?? '{}')
    expect(Object.keys(signBody)).toEqual(['signature'])
    expect(JSON.stringify(requests)).not.toContain(SEND_DELEGATE_KEY)
  })

  it('returns pending_approval for over-allowance send', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/payments')) {
        return jsonResponse({
          payment_id: 'send_over',
          status: 'pending_approval',
          expires_at: '2099-01-01T00:00:00.000Z',
        }, 202)
      }
      return jsonResponse({})
    })

    const result = await sendHandlers().haven_send({
      asset: 'USDC',
      recipient: '0xRecipient',
      amount: '9999',
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as any).status).toBe('pending_approval')
    }
  })

  it('rejects unknown asset at schema level before any network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await sendHandlers().haven_send({
      asset: 'DOGE',
      recipient: '0xRecipient',
      amount: '1',
    })
    expect(result.success).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('haven_pay_mcp_tool', () => {
  const MCP_DELEGATE_KEY = '0x' + 'c'.repeat(64)
  const MCP_MERCHANT_URL = 'https://mcp.merchant.example/mcp'
  const SIGN_HASH = `0x${'cc'.repeat(32)}`

  function mcpHandlers() {
    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      baseUrl: 'http://haven.test',
      delegateKey: MCP_DELEGATE_KEY,
    })
    return createToolHandlers(haven)
  }

  it('calls a free MCP tool and returns the merchant result', async () => {
    const merchantResult = { type: 'text', text: 'Hello from MCP merchant' }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = String(url)
      // MCP initialize handshake
      if (urlStr === MCP_MERCHANT_URL && (!init?.body || JSON.parse(init.body as string).method === 'initialize')) {
        return new Response(
          'data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","serverInfo":{"name":"test"}}}\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream', 'mcp-session-id': 'sess-abc' } },
        )
      }
      // tools/call request — free (200)
      if (urlStr === MCP_MERCHANT_URL) {
        const body = JSON.parse(init?.body as string ?? '{}')
        if (body.method === 'tools/call') {
          return new Response(
            `data: {"jsonrpc":"2.0","id":"${body.id}","result":${JSON.stringify(merchantResult)}}\n\n`,
            { status: 200, headers: { 'Content-Type': 'text/event-stream', 'mcp-session-id': 'sess-abc' } },
          )
        }
      }
      return jsonResponse({})
    })

    const result = await mcpHandlers().haven_pay_mcp_tool({
      merchant_url: MCP_MERCHANT_URL,
      tool_name: 'create_text',
      arguments: { prompt: 'Hello' },
    })

    expect(result.success).toBe(true)
    if (result.success) {
      const data = result.data as any
      expect(data.status).toBe(200)
      expect(JSON.stringify(data.body)).toContain('Hello from MCP merchant')
    }
  })

  it('pays via x402 when merchant returns 402 and returns the tool result', async () => {
    const PAYMENT_REQUIRED_HEADER = btoa(JSON.stringify(x402PaymentRequired))
    const requests: CapturedRequest[] = []
    // Count merchant tools/call hits so we return 402 on the first hit and
    // success on the retry after payment.
    let merchantToolsCallCount = 0

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = String(url)
      const path = new URL(urlStr).pathname
      requests.push({ url: urlStr, init })

      if (urlStr === MCP_MERCHANT_URL) {
        const bodyStr = typeof init?.body === 'string' ? init.body : undefined
        const bodyJson = bodyStr ? JSON.parse(bodyStr) : {}

        // MCP initialize/notifications — return session header
        if (!bodyStr || bodyJson.method === 'initialize' || bodyJson.method === 'notifications/initialized') {
          return new Response(
            'data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","serverInfo":{"name":"test"}}}\n\n',
            { status: 200, headers: { 'Content-Type': 'text/event-stream', 'mcp-session-id': 'sess-mcp1' } },
          )
        }

        // tools/call: first hit → 402, second hit → paid result
        if (bodyJson.method === 'tools/call') {
          merchantToolsCallCount++
          if (merchantToolsCallCount === 1) {
            const res = new Response('Payment required', {
              status: 402,
              headers: { 'PAYMENT-REQUIRED': PAYMENT_REQUIRED_HEADER },
            })
            res.clone = () => new Response('Payment required', {
              status: 402,
              headers: { 'PAYMENT-REQUIRED': PAYMENT_REQUIRED_HEADER },
            })
            return res
          }
          return new Response(
            `data: {"jsonrpc":"2.0","id":"${bodyJson.id}","result":{"type":"text","text":"Paid result"}}\n\n`,
            { status: 200, headers: { 'Content-Type': 'text/event-stream', 'mcp-session-id': 'sess-mcp1' } },
          )
        }
      }

      // Haven API: POST /x402 → AllowanceModule funding intent
      // (SDK calls this after signing the EIP-3009 header locally)
      if (path === '/x402') {
        return jsonResponse({
          payment_id: 'mcp_x402_1',
          status: 'pending_signature',
          expires_at: '2099-01-01T00:00:00.000Z',
          sign_data: {
            hash: SIGN_HASH,
            components: { safe: '0xSafe', token: '0xToken', to: '0xTo', amount: '10000', payment_token: '0x0', payment: '0', nonce: 1 },
          },
        }, 201)
      }
      // POST /payments/{id}/sign → confirmed
      if (path.endsWith('/sign')) {
        return jsonResponse({ payment_id: 'mcp_x402_1', status: 'confirmed', tx_hash: '0xtx_mcp' })
      }

      return jsonResponse({})
    })

    const result = await mcpHandlers().haven_pay_mcp_tool({
      merchant_url: MCP_MERCHANT_URL,
      tool_name: 'create_text',
      arguments: { prompt: 'Write me a haiku' },
    })

    expect(result.success).toBe(true)
    if (result.success) {
      const data = result.data as any
      expect(data.status).toBe(200)
      expect(JSON.stringify(data.body)).toContain('Paid result')
    }
    expect(merchantToolsCallCount).toBe(2) // probe 402 + paid retry
    // Signing key never leaked to the network
    expect(JSON.stringify(requests)).not.toContain(MCP_DELEGATE_KEY)
  })

  it('rejects invalid merchant_url at schema level', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await mcpHandlers().haven_pay_mcp_tool({
      merchant_url: 'not-a-url',
      tool_name: 'create_text',
    })
    expect(result.success).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ── #1301: bounded same-origin merchant endpoint discovery (local parity with
// mcp-server's #1271) ─────────────────────────────────────────────────────────

describe('merchant MCP endpoint discovery (#1301)', () => {
  const DISCOVERY_DELEGATE_KEY = '0x' + 'e'.repeat(64)
  const DISCOVERY_SIGN_HASH = `0x${'ee'.repeat(32)}`
  const PAYMENT_REQUIRED_HEADER = btoa(JSON.stringify(x402PaymentRequired))

  function discoveryHandlers() {
    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      baseUrl: 'http://haven.test',
      delegateKey: DISCOVERY_DELEGATE_KEY,
    })
    return createToolHandlers(haven)
  }

  /**
   * Installs a fetch stub keyed on exact `METHOD url`, with one exception:
   * any request whose JSON-RPC body names `method: 'initialize'` (the MCP
   * session handshake `haven.fetch()` runs up front for a `/mcp`-suffixed
   * URL) is answered with a plain 200 and no `mcp-session-id` header, which
   * the SDK treats as "not an MCP session" and silently falls back to
   * standard x402 — keeping these fixtures focused on discovery, not the
   * MCP transport layer (covered elsewhere in this file).
   */
  function installDiscoveryFetch(
    routes: Record<string, { status: number; body?: unknown; headers?: Record<string, string> } | ((hitCount: number) => { status: number; body?: unknown; headers?: Record<string, string> })>,
  ): { url: string; method: string }[] {
    const calls: { url: string; method: string }[] = []
    const hitCounts: Record<string, number> = {}
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown, init: RequestInit = {}) => {
      const urlStr = String(url)
      const method = (init.method ?? 'GET').toUpperCase()
      calls.push({ url: urlStr, method })
      const bodyStr = typeof init.body === 'string' ? init.body : undefined
      let bodyJson: Record<string, unknown> | undefined
      if (bodyStr) {
        try {
          bodyJson = JSON.parse(bodyStr)
        } catch {
          bodyJson = undefined
        }
      }
      if (bodyJson?.method === 'initialize') {
        return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      const key = `${method} ${urlStr}`
      hitCounts[key] = (hitCounts[key] ?? 0) + 1
      const raw = routes[key]
      const def = typeof raw === 'function' ? raw(hitCounts[key]) : raw
      if (!def) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify(def.body ?? {}), {
        status: def.status,
        headers: { 'Content-Type': 'application/json', ...(def.headers ?? {}) },
      })
    })
    return calls
  }

  function havenPaymentRoutes(paymentId: string) {
    return {
      'POST http://haven.test/x402': {
        status: 201,
        body: {
          payment_id: paymentId,
          status: 'pending_signature',
          expires_at: '2099-01-01T00:00:00.000Z',
          sign_data: {
            hash: DISCOVERY_SIGN_HASH,
            components: {
              safe: '0xSafe',
              token: '0xToken',
              to: '0xTo',
              amount: '10000',
              payment_token: '0x0',
              payment: '0',
              nonce: 1,
            },
          },
        },
      },
      [`POST http://haven.test/payments/${paymentId}/sign`]: {
        status: 200,
        body: { payment_id: paymentId, status: 'confirmed', tx_hash: '0xtx_discovery' },
      },
    }
  }

  it('resolves a base URL through /.well-known and returns the RESOLVED merchant_url', async () => {
    const calls = installDiscoveryFetch({
      'POST http://merchant.test/': { status: 404, body: { error: 'Not found' } },
      'GET http://merchant.test/.well-known/haven-demo-merchant': {
        status: 200,
        body: { name: 'Haven Demo Merchant', mcp_url: 'http://merchant.test/mcp' },
      },
      'POST http://merchant.test/mcp': (hit) =>
        hit === 1
          ? { status: 402, headers: { 'PAYMENT-REQUIRED': PAYMENT_REQUIRED_HEADER } }
          : { status: 200, body: { ok: true, result: 'paid' } },
      ...havenPaymentRoutes('mcp_disc_resolve'),
    })

    const result = await discoveryHandlers().haven_pay_mcp_tool({
      merchant_url: 'http://merchant.test/',
      tool_name: 'buy_vpn',
      arguments: { plan: 'basic' },
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    const data = result.data as { merchant_url: string; merchant_url_discovered_from?: string }
    expect(data.merchant_url).toBe('http://merchant.test/mcp')
    expect(data.merchant_url_discovered_from).toBe('http://merchant.test/')
    expect(calls.some((c) => c.url.includes('.well-known'))).toBe(true)
  })

  it('does NOT run discovery when the exact endpoint answers 402', async () => {
    const calls = installDiscoveryFetch({
      'POST http://merchant.test/mcp': (hit) =>
        hit === 1
          ? { status: 402, headers: { 'PAYMENT-REQUIRED': PAYMENT_REQUIRED_HEADER } }
          : { status: 200, body: { ok: true, result: 'paid' } },
      ...havenPaymentRoutes('mcp_disc_shortcircuit'),
    })

    const result = await discoveryHandlers().haven_pay_mcp_tool({
      merchant_url: 'http://merchant.test/mcp',
      tool_name: 'buy_vpn',
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    const data = result.data as { merchant_url: string; merchant_url_discovered_from?: string }
    expect(data.merchant_url).toBe('http://merchant.test/mcp')
    expect(data.merchant_url_discovered_from).toBeUndefined()
    expect(calls.some((c) => c.url.includes('.well-known'))).toBe(false)
  })

  it('fails with actionable guidance when no discovery document exists', async () => {
    installDiscoveryFetch({
      'POST http://merchant.test/': { status: 404, body: { error: 'Not found' } },
      'GET http://merchant.test/.well-known/haven-demo-merchant': { status: 404, body: {} },
      'GET http://merchant.test/': { status: 404, body: {} },
    })

    const result = await discoveryHandlers().haven_pay_mcp_tool({
      merchant_url: 'http://merchant.test/',
      tool_name: 'buy_vpn',
    })

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    expect(result.message).toMatch(/No same-origin discovery document/)
    expect(result.message).toMatch(/<origin>\/mcp/)
  })

  it('REFUSES an off-origin mcp_url — never even fetches it (SSRF bound)', async () => {
    const calls = installDiscoveryFetch({
      'POST http://merchant.test/': { status: 404, body: { error: 'Not found' } },
      'GET http://merchant.test/.well-known/haven-demo-merchant': {
        status: 200,
        body: { mcp_url: 'http://evil.example/mcp' },
      },
      'GET http://merchant.test/': {
        status: 200,
        body: { mcp_url: 'http://evil.example/mcp' },
      },
    })

    const result = await discoveryHandlers().haven_pay_mcp_tool({
      merchant_url: 'http://merchant.test/',
      tool_name: 'buy_vpn',
    })

    expect(result.success).toBe(false)
    expect(calls.some((c) => c.url.includes('evil.example'))).toBe(false)
  })

  it('bounds discovery fetches to the fixed same-origin path set even on a plain merchant failure', async () => {
    const calls = installDiscoveryFetch({
      'POST http://merchant.test/mcp': { status: 500, body: { error: 'boom' } },
      'GET http://merchant.test/.well-known/haven-demo-merchant': { status: 404, body: {} },
      'GET http://merchant.test/': { status: 404, body: {} },
    })

    const result = await discoveryHandlers().haven_pay_mcp_tool({
      merchant_url: 'http://merchant.test/mcp',
      tool_name: 'buy_vpn',
    })

    expect(result.success).toBe(false)
    const fetched = calls.map((c) => c.url)
    expect(
      fetched.every(
        (u) =>
          u.startsWith('http://merchant.test/mcp') ||
          u === 'http://merchant.test/.well-known/haven-demo-merchant' ||
          u === 'http://merchant.test/',
      ),
    ).toBe(true)
  })
})

// ── #318 Tool selection clarity ───────────────────────────────────────────────

describe('Tool selection errors (#318)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function baseHandlers() {
    const haven = new HavenClient({ apiKey: 'sk_agent_test', delegateKey, baseUrl })
    return createToolHandlers(haven)
  }

  // ── haven_quote_x402 WRONG_RAIL ──────────────────────────────────────────

  it('haven_quote_x402: a MACHINE-PAYMENT-CHALLENGE response is a plain error, no dead tool suggestion (#1328)', async () => {
    // #1328: nothing in Haven produces this header anymore (the mpp_demo
    // route it identified is retired) — quoteX402's defensive guard still
    // refuses it, but the old WRONG_RAIL redirect to the now-deleted
    // haven_quote_mpp is gone. Any surviving MACHINE-PAYMENT-CHALLENGE
    // responder (there should be none) now just produces a generic error.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Payment required', {
        status: 402,
        headers: { 'MACHINE-PAYMENT-CHALLENGE': btoa(JSON.stringify(challenge)) },
      }),
    )

    const result = await baseHandlers().haven_quote_x402({ url: 'https://merchant.example/paid' })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).not.toBe('WRONG_RAIL')
      expect(result.suggested_tool).not.toBe('haven_quote_mpp')
    }
  })

  // ── haven_pay_x402_quote WRONG_TOOL ─────────────────────────────────────

  it('haven_pay_x402_quote: returns WRONG_TOOL when quote is null', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await baseHandlers().haven_pay_x402_quote({ quote: null })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WRONG_TOOL')
      expect(result.suggested_tool).toBe('haven_quote_x402')
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('haven_pay_x402_quote: returns WRONG_TOOL when quote is missing paymentRequired', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await baseHandlers().haven_pay_x402_quote({ quote: { rail: 'x402' } })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WRONG_TOOL')
      expect(result.suggested_tool).toBe('haven_quote_x402')
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('haven_pay_x402_quote: an mpp-shaped quote is just "missing paymentRequired" now, no MPP tool suggestion (#1328)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const mppShapedQuote = { rail: 'mpp', challenge, amountAtomic: '10000' }
    const result = await baseHandlers().haven_pay_x402_quote({ quote: mppShapedQuote })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WRONG_TOOL')
      expect(result.suggested_tool).toBe('haven_quote_x402')
      expect(result.suggested_tool).not.toBe('haven_pay_mpp_challenge')
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // ── haven_resume_x402_payment: mpp resume_state is retired, not a redirect ──

  it('haven_resume_x402_payment: an mpp-rail resume_state is a plain state mismatch, no dead tool suggestion (#1328)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const mppState = { rail: 'mpp', paymentId: 'pay-mpp-1', challenge }
    const result = await baseHandlers().haven_resume_x402_payment({ resume_state: mppState })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.suggested_tool).not.toBe('haven_resume_mpp_payment')
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // ── Cross-cutting: structured errors have no network side effects ─────────

  it('WRONG_TOOL errors never make network calls (no false charges)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const handlers = baseHandlers()

    // All of these should be caught before any HTTP request
    await handlers.haven_pay_x402_quote({ quote: null })
    await handlers.haven_pay_x402_quote({ quote: { rail: 'mpp', challenge } })
    await handlers.haven_resume_x402_payment({ resume_state: { rail: 'mpp' } })

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('no longer exposes haven_quote_mpp / haven_pay_mpp_challenge / haven_resume_mpp_payment handlers (#1328)', () => {
    const handlers = baseHandlers()
    expect((handlers as Record<string, unknown>).haven_quote_mpp).toBeUndefined()
    expect((handlers as Record<string, unknown>).haven_pay_mpp_challenge).toBeUndefined()
    expect((handlers as Record<string, unknown>).haven_resume_mpp_payment).toBeUndefined()
  })
})

describe('haven_discover_tools (#349)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const catalogEntries = [
    {
      id: 'cat-mcp', name: 'Text generation', description: 'd', category: 'media',
      resource_url: 'https://mcp.merchant.example/mcp', rail: 'x402', protocol: 'mcp',
      tool_name: 'create_text', tool_arguments: { prompt: 'hello' },
      price_display: '$0.01 USDC', price_atomic: '10000',
      asset: 'USDC', network: 'eip155:8453', status: 'active', verified_at: '2026-06-10T00:00:00.000Z',
    },
    {
      id: 'cat-http', name: 'Paid API', description: 'd', category: 'data',
      resource_url: 'https://api.merchant.example/paid', rail: 'x402', protocol: 'http',
      tool_name: null, price_display: '$0.02 USDC', price_atomic: '20000',
      asset: 'USDC', network: 'eip155:8453', status: 'active', verified_at: null,
    },
    {
      id: 'cat-mpp', name: 'MPP resource', description: 'd', category: 'demo',
      resource_url: 'https://api.merchant.example/mpp', rail: 'mpp', protocol: 'http',
      tool_name: null, price_display: '$0.01 USDC', price_atomic: '10000',
      asset: 'USDC', network: 'eip155:8453', status: 'degraded', verified_at: null,
    },
  ]

  function handlers() {
    const haven = new HavenClient({ apiKey: 'sk_agent_test', delegateKey, baseUrl })
    return createToolHandlers(haven)
  }

  it('returns catalog entries with the correct suggested_tool per rail and protocol', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ entries: catalogEntries }),
    )

    const result = await handlers().haven_discover_tools({})
    expect(result.success).toBe(true)
    const data = (result as { data: Array<Record<string, unknown>> }).data

    expect(data).toHaveLength(3)
    expect(data[0]).toMatchObject({
      id: 'cat-mcp',
      suggested_tool: 'haven_pay_mcp_tool',
      tool_arguments: { prompt: 'hello' },
    })
    expect(data[1]).toMatchObject({ id: 'cat-http', suggested_tool: 'haven_pay_x402' })
    // #1328: the 'mpp' rail's suggested_tool fallback no longer names a
    // deleted tool — it now matches the plain-HTTP x402 case (unreachable in
    // practice today; the only-ever 'mpp' catalog row is delisted).
    expect(data[2]).toMatchObject({ id: 'cat-mpp', suggested_tool: 'haven_pay_x402', status: 'degraded' })

    // read-only: exactly one request, a GET to /catalog, nothing else
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${baseUrl}/catalog`)
  })

  it('forwards category and rail filters as query parameters', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ entries: [] }),
    )

    await handlers().haven_discover_tools({ category: 'media', rail: 'x402' })
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${baseUrl}/catalog?category=media&rail=x402`)
  })

  it('forwards a product search without making a payment request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ entries: [] }),
    )

    await handlers().haven_discover_tools({ search: 'NordShield VPN Basic' })
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${baseUrl}/catalog?search=NordShield+VPN+Basic`)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('preserves blank search terms so the backend can reject them consistently', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({ entries: [] }),
    )

    await handlers().haven_discover_tools({ search: '' })
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${baseUrl}/catalog?search=`)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('lets the agent pay a discovered entry in the same session (discover -> pay)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      // 1. discovery
      .mockResolvedValueOnce(jsonResponse({ entries: [catalogEntries[1]] }))
      // 2. merchant 402 probe from haven_pay_x402
      .mockResolvedValueOnce(new Response(JSON.stringify(x402PaymentRequired), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }))
      // 3. Haven funding authorize
      .mockResolvedValueOnce(jsonResponse({
        payment_id: 'pay_349',
        status: 'pending_signature',
        chain_id: 8453,
        safe_address: safeAddress,
        sign_data: {
          hash: `0x${'11'.repeat(32)}`,
          components: {
            safe: safeAddress,
            token: x402PaymentRequired.accepts[0].asset,
            to: delegateAddress,
            amount: x402PaymentRequired.accepts[0].amount,
            payment_token: '0x0000000000000000000000000000000000000000',
            payment: '0',
            nonce: 1,
          },
          instructions: 'Sign locally',
        },
      }, 201))
      // 4. sign/relay confirmation
      .mockResolvedValueOnce(jsonResponse({
        payment_id: 'pay_349', status: 'confirmed', tx_hash: txHash, chain_id: 8453,
        token: 'USDC', amount: '0.02', to: delegateAddress,
      }))
      // 5. merchant retry succeeds
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'PAYMENT-RESPONSE': btoa(JSON.stringify({
            success: true, transaction: txHash, network: 'eip155:8453',
          })),
        },
      }))
      // 6. evidence write
      .mockResolvedValueOnce(jsonResponse({ evidence: { id: 'ev-349' } }, 202))

    const h = handlers()
    const discovery = await h.haven_discover_tools({})
    expect(discovery.success).toBe(true)
    const entry = (discovery as { data: Array<{ resource_url: string; suggested_tool: string }> }).data[0]
    expect(entry.suggested_tool).toBe('haven_pay_x402')

    const payment = await h.haven_pay_x402({ url: entry.resource_url, method: 'GET' })
    expect(payment.success).toBe(true)
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(5)
  })
})

describe('haven_discover_tools badge fields + verified filter (#1716)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function handlers() {
    const haven = new HavenClient({ apiKey: 'sk_agent_test', delegateKey, baseUrl })
    return createToolHandlers(haven)
  }

  const badgeFixture = [
    {
      id: 'cat-directory', name: 'Directory Summarizer', description: 'Self-submitted service', category: 'api',
      resource_url: 'https://directory.example.com/mcp', rail: 'x402', protocol: 'mcp',
      tool_name: 'summarize', tool_arguments: null,
      price_display: null, price_atomic: null,
      asset: null, network: null, status: 'active', verified_at: '2026-08-23T10:00:00.000Z',
      source: 'ingestion', domain_verified: true, verified_payable: true,
    },
  ]

  it('surfaces the verified-directory badge fields and forwards the verified filter (#1716)', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(jsonResponse({ entries: badgeFixture })))

    await handlers().haven_discover_tools({ verified: 'verified' })
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toContain('/catalog')
    // The filter is applied client-side by the SDK, not as a query param.
    expect(url).not.toContain('verified')

    const result = await handlers().haven_discover_tools({})
    const data = (result as { data: Array<Record<string, unknown>> }).data
    expect(data[0]).toMatchObject({
      source: 'ingestion',
      domain_verified: true,
      verified_payable: true,
    })
  })

  it('forwards the verified operator filter to the SDK discoverTools call', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ entries: [] }))
    const discoverSpy = vi
      .spyOn(HavenClient.prototype, 'discoverTools')
      .mockResolvedValue([])

    await handlers().haven_discover_tools({ verified: 'operator' })
    expect(discoverSpy).toHaveBeenCalledWith(
      expect.objectContaining({ verified: 'operator' }),
    )

    await handlers().haven_discover_tools({ verified: 'any' })
    expect(discoverSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ verified: undefined }),
    )
  })
})

describe('haven_submit_catalog_entry (#1716)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function handlers() {
    const haven = new HavenClient({ apiKey: 'sk_agent_test', delegateKey, baseUrl })
    return createToolHandlers(haven)
  }

  it('submits a resource URL through the SDK and returns id + verify_token + status', async () => {
    const submitSpy = vi
      .spyOn(HavenClient.prototype, 'submitCatalogEntry')
      .mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000001',
        verifyToken: 'ab'.repeat(24),
        status: 'submitted',
      })

    const result = await handlers().haven_submit_catalog_entry({
      resource_url: 'https://merchant.example/mcp',
    })
    expect(result.success).toBe(true)
    expect(submitSpy).toHaveBeenCalledWith('https://merchant.example/mcp', undefined)
    expect((result as { data: Record<string, unknown> }).data).toMatchObject({
      id: '00000000-0000-4000-8000-000000000001',
      verify_token: 'ab'.repeat(24),
      status: 'submitted',
    })
  })
})


// ── haven_get_payment_status: post-purchase allowance summary (#1310) ─────────
// Parity with the hosted MCP's identical addition in packages/mcp-server —
// same condition (rail: x402, phase: payment_confirmed), same SDK call.

describe('haven_get_payment_status: post-purchase allowance summary (#1310)', () => {
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

  function handlers() {
    const haven = new HavenClient({ apiKey: 'sk_agent_test', delegateKey, baseUrl })
    return createToolHandlers(haven)
  }

  function statusFixture(overrides: Record<string, unknown> = {}) {
    return {
      payment_id: 'pay_x402', kind: 'payment_intent', rail: 'x402',
      status: 'confirmed', phase: 'payment_confirmed', next_action: 'none',
      amount: '1.50', token: 'USDC',
      resource_url: 'https://merchant.example/paid', merchant_address: '0xMerchant',
      tx_hash: txHash, expires_at: '2099-01-01T00:00:00.000Z', chain_id: 8453,
      message: 'The payment is confirmed.', asset: USDC,
      ...overrides,
    }
  }

  function allowancesFixture(remaining: string) {
    return {
      agent_id: 'agent-1', safe_address: safeAddress, delegate_address: delegateAddress, chain_id: 8453,
      allowances: [{
        id: 'allowance-1', token_address: USDC, token_symbol: 'USDC',
        configured_amount: '5000000', reset_period_min: 60,
        onchain: {
          amount: remaining, spent: '0', remaining, effective_spent: '0',
          reset_time_min: 60, last_reset_min: 100, nonce: 7, is_reset_pending: false,
        },
      }],
    }
  }

  it('attaches allowance for a genuinely settled x402 payment', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url)
      if (u.endsWith('/machine-payments/pay_x402/status')) return jsonResponse(statusFixture())
      if (u.endsWith('/machine-payments/agent')) {
        return jsonResponse({
          id: 'agent-1', name: 'A', status: 'active',
          safe_address: safeAddress, delegate_address: delegateAddress, chain_id: 8453,
          execution_rail: 'legacy',
        })
      }
      if (u.endsWith('/machine-payments/allowances')) return jsonResponse(allowancesFixture('3000000'))
      throw new Error(`unexpected fetch: ${u}`)
    })

    const result = await handlers().haven_get_payment_status({ payment_id: 'pay_x402' })
    expect(result.success).toBe(true)
    const data = (result as { data: { allowance: { rail: string; remaining_atomic: string } | null } }).data
    expect(data.allowance).toEqual(
      expect.objectContaining({ rail: 'legacy', remaining_atomic: '3000000' }),
    )
  })

  it('does NOT attach allowance for a non-settled x402 phase (funded_but_unsettled)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url)
      if (u.endsWith('/machine-payments/pay_x402/status')) {
        return jsonResponse(statusFixture({ status: 'funded_but_unsettled', phase: 'funded_but_unsettled' }))
      }
      throw new Error(`unexpected fetch: ${u}`)
    })

    const result = await handlers().haven_get_payment_status({ payment_id: 'pay_x402' })
    expect(result.success).toBe(true)
    const data = (result as { data: Record<string, unknown> }).data
    expect('allowance' in data).toBe(false)
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('#2145: the local MCP tool descriptions and README present the resume trigger as live', () => {
  /**
   * The local MCP package has its OWN `toolDescriptions` record — a third
   * agent-facing description surface beside the SDK's and the hosted server's,
   * though `haven_resume_x402_payment` here is composed directly from the
   * SDK's shared `resumeX402` fragment (see `tools.ts`), so it inherits the
   * shared-source fix automatically.
   *
   * #2145 gave `retry_original_x402_request` a real producer
   * (agent-payment-status.ts emits it when the funding leg confirmed but no
   * merchant response was ever recorded). This guard pins that no local
   * description still claims the trigger is unreachable, and that the resume
   * description names it as the gate.
   */
  it('haven_resume_x402_payment names retry_original_x402_request as its gate; nothing claims it is unreachable', () => {
    const entries = Object.entries(toolDescriptions)

    // Non-vacuity: an empty record would satisfy every assertion below.
    expect(entries.length).toBeGreaterThan(0)

    expect(toolDescriptions.haven_resume_x402_payment).toContain(
      'nextAction=retry_original_x402_request',
    )

    for (const [name, description] of entries) {
      const lower = description.toLowerCase()
      expect(
        lower,
        `${name} must not claim retry_original_x402_request is unreachable — #2145 gave it a producer`,
      ).not.toContain('not currently reachable')
      expect(
        lower,
        `${name} must not claim nothing emits a resume trigger — #2145 gave it a producer`,
      ).not.toContain('nothing emits')
    }
  })

  it('the shipped README tells an operator to gate on the live trigger, not to expect it never to fire', () => {
    // Same treatment and same reasoning as the README guard in `consent.test.ts`:
    // this file is shipped on npm, nothing renders it, and #2086 already proved
    // it drifts silently when only the code is checked.
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

    expect(readme).toContain('haven_resume_x402_payment')
    expect(readme).toContain("nextAction: 'retry_original_x402_request'")
    expect(readme.toLowerCase()).not.toMatch(/is not\s+currently reachable/)
    expect(readme.toLowerCase()).not.toContain('nothing emits')
  })
})
