/**
 * #2292 — `haven_report_x402_outcome` at the hosted tool boundary.
 *
 * The backend half (does a report actually move `haven_get_payment_status`,
 * and can a foreign agent forge one) is proven against real Postgres in
 * `packages/backend/src/modules/payments/__tests__/x402-agent-reported-outcome.test.ts`.
 * What is provable HERE is everything about the boundary itself: which
 * request the tool makes, which request it deliberately does NOT make, and
 * what a caller can and cannot put into it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { HavenClient } from '@haven_ai/sdk'
import { createToolHandlers, toolDescriptions, type ToolPayload, type ToolSuccess } from './tools.js'

interface CapturedCall {
  url: string
  method: string
  body: Record<string, unknown> | undefined
}

let calls: CapturedCall[]

const TX_HASH = '0x' + 'ab'.repeat(32)
const RESOURCE_URL = 'https://merchant.example/resource'

function statusBody(overrides: Record<string, unknown> = {}) {
  return {
    payment_id: 'pay_x402',
    kind: 'payment_intent',
    rail: 'x402',
    status: 'confirmed',
    phase: 'payment_confirmed',
    next_action: 'none',
    amount: '0.10',
    token: 'USDC',
    resource_url: RESOURCE_URL,
    merchant_address: '0x00000000000000000000000000000000000000c1',
    tx_hash: TX_HASH,
    expires_at: '2099-01-01T00:00:00.000Z',
    chain_id: 8453,
    message: 'The payment is confirmed.',
    ...overrides,
  }
}

function stubFetch(routes: Record<string, { status?: number; body?: unknown }>) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const path = new URL(url).pathname
    const body = init.body ? JSON.parse(init.body as string) : undefined
    calls.push({ url, method, body })
    const route = routes[`${method} ${path}`]
    const status = route?.status ?? 200
    const payload = route?.body ?? {}
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      json: async () => payload,
      text: async () => JSON.stringify(payload),
      clone: () => ({
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(),
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      }),
    }
  })
}

function handlers() {
  return createToolHandlers(
    new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' }),
  )
}

function ok<T = unknown>(payload: ToolPayload): ToolSuccess<T> {
  if (!payload.success) throw new Error(`expected success, got failure: ${payload.message}`)
  return payload as ToolSuccess<T>
}

function fail(payload: ToolPayload) {
  if (payload.success) throw new Error('expected failure, got success')
  return payload
}

/** The routes a report is allowed to reach — and nothing else. */
const HAPPY_ROUTES = {
  'GET /machine-payments/pay_x402/status': { body: statusBody() },
  'POST /machine-payments/reconciliation-events': { status: 202, body: { event_id: 'evt_1' } },
  'POST /machine-payments/evidence': { status: 202, body: { evidence: { id: 'ev_1' } } },
}

beforeEach(() => {
  calls = []
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('haven_report_x402_outcome', () => {
  it('a rejection posts the reconciliation event the SDK retry path posts', async () => {
    stubFetch(HAPPY_ROUTES)
    const result = ok<{ recorded: string; tx_hash: string; outcome: string }>(
      await handlers().haven_report_x402_outcome({
        payment_id: 'pay_x402',
        outcome: 'rejected',
        merchant_status: 402,
      }),
    )

    expect(result.data.outcome).toBe('rejected')
    expect(result.data.recorded).toBe('reconciliation_event')
    const posted = calls.find((c) => c.url.endsWith('/machine-payments/reconciliation-events'))
    expect(posted?.body).toMatchObject({
      paymentId: 'pay_x402',
      rail: 'x402',
      eventType: 'merchant_retry_rejected_after_payment',
      txHash: TX_HASH,
    })
    // Never an evidence write on a rejection.
    expect(calls.some((c) => c.url.endsWith('/machine-payments/evidence'))).toBe(false)
  })

  it('an acceptance posts evidence and NOT a reconciliation event', async () => {
    // The positive control for the whole tool: an implementation that marked
    // everything failed would post a reconciliation event here.
    stubFetch(HAPPY_ROUTES)
    const result = ok<{ recorded: string }>(
      await handlers().haven_report_x402_outcome({
        payment_id: 'pay_x402',
        outcome: 'accepted',
        merchant_status: 200,
      }),
    )

    expect(result.data.recorded).toBe('evidence')
    const posted = calls.find((c) => c.url.endsWith('/machine-payments/evidence'))
    expect(posted?.body).toMatchObject({
      paymentId: 'pay_x402',
      rail: 'x402',
      txHash: TX_HASH,
      resourceUrl: RESOURCE_URL,
      merchantStatus: 200,
    })
    expect(calls.some((c) => c.url.endsWith('/machine-payments/reconciliation-events'))).toBe(false)
  })

  it('NEVER contacts the merchant — the keyless property this path exists to protect', async () => {
    // The load-bearing assertion of the whole slice. Haven records what the
    // agent says; it must not "verify it for you", because verifying means
    // calling the merchant. A convenience that did so would quietly undo the
    // architecture #2288 exists to protect.
    stubFetch(HAPPY_ROUTES)
    await handlers().haven_report_x402_outcome({
      payment_id: 'pay_x402',
      outcome: 'rejected',
      merchant_status: 402,
      merchant_body: 'Payment required',
    })

    expect(calls.every((c) => new URL(c.url).origin === 'http://haven.test')).toBe(true)
    expect(calls.some((c) => c.url.includes('merchant.example'))).toBe(false)
  })

  it('anchors on HAVEN’s tx hash and resource URL, which the caller cannot name', async () => {
    // The tool takes no tx_hash and no resource_url. Both come from the
    // payment record, so a report cannot be aimed at another transaction.
    stubFetch({
      ...HAPPY_ROUTES,
      'GET /machine-payments/pay_x402/status': {
        body: statusBody({ tx_hash: '0x' + 'cd'.repeat(32), resource_url: 'https://other.example/r' }),
      },
    })
    const result = ok<{ tx_hash: string; resource_url: string }>(
      await handlers().haven_report_x402_outcome({
        payment_id: 'pay_x402',
        outcome: 'accepted',
        merchant_status: 200,
      }),
    )
    expect(result.data.tx_hash).toBe('0x' + 'cd'.repeat(32))
    expect(result.data.resource_url).toBe('https://other.example/r')
    const posted = calls.find((c) => c.url.endsWith('/machine-payments/evidence'))
    expect(posted?.body).toMatchObject({
      txHash: '0x' + 'cd'.repeat(32),
      resourceUrl: 'https://other.example/r',
    })
  })

  it('REFUSES an unrecognised key instead of stripping it (#2282’s lesson)', async () => {
    stubFetch(HAPPY_ROUTES)
    const payload = fail(
      await handlers().haven_report_x402_outcome({
        payment_id: 'pay_x402',
        outcome: 'rejected',
        merchant_status: 402,
        tx_hash: '0x' + 'ff'.repeat(32),
      }),
    )
    expect(payload.message).toContain('tx_hash')
    // Refused BEFORE anything is read or written — not parsed to the same
    // value as "absent" and then acted on.
    expect(calls).toHaveLength(0)
  })

  it('refuses an outcome that contradicts its own merchant_status, before any write', async () => {
    stubFetch(HAPPY_ROUTES)
    for (const [outcome, merchantStatus] of [
      ['accepted', 500],
      ['rejected', 200],
    ] as const) {
      calls = []
      const payload = fail(
        await handlers().haven_report_x402_outcome({
          payment_id: 'pay_x402',
          outcome,
          merchant_status: merchantStatus,
        }),
      )
      expect(payload.message).toContain('contradicts')
      expect(calls).toHaveLength(0)
    }
  })

  it('refuses a payment with no confirmed Haven funding tx — it cannot confirm an intent', async () => {
    // An erc7710 intent sits at `submitted` with no Haven tx. Completing one
    // from a caller-supplied settlement hash is #2092's separately-verified
    // seam; this tool must never become a second, unverified door to it.
    stubFetch({
      ...HAPPY_ROUTES,
      'GET /machine-payments/pay_x402/status': {
        status: 409,
        body: statusBody({ status: 'submitted', phase: 'payment_submitted', tx_hash: null }),
      },
    })
    const payload = fail(
      await handlers().haven_report_x402_outcome({
        payment_id: 'pay_x402',
        outcome: 'accepted',
        merchant_status: 200,
      }),
    )
    expect(payload.success).toBe(false)
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('refuses a CONFIRMED payment carrying no Haven funding tx — the anchor gate itself', async () => {
    // The sibling above is refused by the backend's own 409 before the SDK
    // gate is reached, so it proves the HTTP contract rather than this guard.
    // This shape — confirmed, tx_hash null — reaches the guard, and is what
    // stops the tool becoming a second, unverified door into #2092's
    // caller-asserted-settlement-hash seam.
    stubFetch({
      ...HAPPY_ROUTES,
      'GET /machine-payments/pay_x402/status': { body: statusBody({ tx_hash: null }) },
    })
    const payload = fail(
      await handlers().haven_report_x402_outcome({
        payment_id: 'pay_x402',
        outcome: 'accepted',
        merchant_status: 200,
      }),
    )
    expect(payload.message).toContain('no confirmed Haven funding transaction')
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('refuses a non-x402 payment', async () => {
    stubFetch({
      ...HAPPY_ROUTES,
      'GET /machine-payments/pay_x402/status': { body: statusBody({ rail: 'mpp_crypto' }) },
    })
    const payload = fail(
      await handlers().haven_report_x402_outcome({
        payment_id: 'pay_x402',
        outcome: 'accepted',
        merchant_status: 200,
      }),
    )
    expect(payload.message).toContain('not x402')
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('surfaces the backend refusal when a delivery is already recorded', async () => {
    // The precedence rule, seen from the tool: an acceptance is terminal.
    stubFetch({
      ...HAPPY_ROUTES,
      'POST /machine-payments/reconciliation-events': {
        status: 409,
        body: { error: 'A merchant response is already recorded for this payment' },
      },
    })
    const payload = fail(
      await handlers().haven_report_x402_outcome({
        payment_id: 'pay_x402',
        outcome: 'rejected',
        merchant_status: 402,
      }),
    )
    expect(payload.message).toContain('already recorded')
  })

  it('a failed status re-read does not turn a RECORDED report into a failure', async () => {
    // The write already happened and is not undone by a read that fell over.
    let seenStatus = 0
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const method = (init.method ?? 'GET').toUpperCase()
      const path = new URL(url).pathname
      calls.push({ url, method, body: init.body ? JSON.parse(init.body as string) : undefined })
      if (path.endsWith('/status')) {
        seenStatus += 1
        if (seenStatus > 1) throw new Error('status read exploded')
        const payload = statusBody()
        return {
          ok: true, status: 200, headers: new Headers(),
          json: async () => payload, text: async () => JSON.stringify(payload),
          clone: () => ({ ok: true, status: 200, headers: new Headers(), json: async () => payload, text: async () => JSON.stringify(payload) }),
        }
      }
      const payload = { event_id: 'evt_1' }
      return {
        ok: true, status: 202, headers: new Headers(),
        json: async () => payload, text: async () => JSON.stringify(payload),
        clone: () => ({ ok: true, status: 202, headers: new Headers(), json: async () => payload, text: async () => JSON.stringify(payload) }),
      }
    })

    const result = ok<{ recorded: string }>(
      await handlers().haven_report_x402_outcome({
        payment_id: 'pay_x402',
        outcome: 'rejected',
        merchant_status: 402,
      }),
    )
    expect(result.data.recorded).toBe('reconciliation_event')
  })

  it('the plain-HTTP guidance names this tool, so it is actually reached', async () => {
    // A cheap literal guard, not a prose assertion: the description that
    // tells an agent to retry the merchant itself has to name where the
    // outcome goes, or the tool is unreachable in practice.
    expect(toolDescriptions.haven_pay_x402_quote).toContain('haven_report_x402_outcome')
    expect(toolDescriptions.haven_resume_x402_payment).toContain('haven_report_x402_outcome')
  })
})
