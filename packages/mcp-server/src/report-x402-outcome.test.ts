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
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { encodeBase64Json } from '@haven_ai/sdk'
import { createToolHandlers, toolDescriptions, type ToolPayload, type ToolSuccess } from './tools.js'
import {
  clearCalls,
  handlers,
  installSharedFixtureLifecycle,
  ok,
  recordedCalls,
  stubFetch,
} from './test-support/hosted-mcp.js'

installSharedFixtureLifecycle()

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
  clearCalls()
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
    const posted = recordedCalls().find((c) => c.url.endsWith('/machine-payments/reconciliation-events'))
    expect(posted?.body).toMatchObject({
      paymentId: 'pay_x402',
      rail: 'x402',
      eventType: 'merchant_retry_rejected_after_payment',
      txHash: TX_HASH,
    })
    // Never an evidence write on a rejection.
    expect(recordedCalls().some((c) => c.url.endsWith('/machine-payments/evidence'))).toBe(false)
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
    const posted = recordedCalls().find((c) => c.url.endsWith('/machine-payments/evidence'))
    expect(posted?.body).toMatchObject({
      paymentId: 'pay_x402',
      rail: 'x402',
      txHash: TX_HASH,
      resourceUrl: RESOURCE_URL,
      merchantStatus: 200,
    })
    expect(recordedCalls().some((c) => c.url.endsWith('/machine-payments/reconciliation-events'))).toBe(false)
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

    expect(recordedCalls().every((c) => new URL(c.url).origin === 'http://haven.test')).toBe(true)
    expect(recordedCalls().some((c) => c.url.includes('merchant.example'))).toBe(false)
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
    const posted = recordedCalls().find((c) => c.url.endsWith('/machine-payments/evidence'))
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
    expect(recordedCalls()).toHaveLength(0)
  })

  it('refuses an outcome that contradicts its own merchant_status, before any write', async () => {
    stubFetch(HAPPY_ROUTES)
    for (const [outcome, merchantStatus] of [
      ['accepted', 500],
      ['rejected', 200],
    ] as const) {
      clearCalls()
      const payload = fail(
        await handlers().haven_report_x402_outcome({
          payment_id: 'pay_x402',
          outcome,
          merchant_status: merchantStatus,
        }),
      )
      expect(payload.message).toContain('contradicts')
      expect(recordedCalls()).toHaveLength(0)
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
    expect(recordedCalls().some((c) => c.method === 'POST')).toBe(false)
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
    expect(recordedCalls().some((c) => c.method === 'POST')).toBe(false)
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
    expect(recordedCalls().some((c) => c.method === 'POST')).toBe(false)
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
      recordedCalls().push({
        url,
        method,
        body: init.body ? JSON.parse(init.body as string) : undefined,
        headers: (init.headers ?? {}) as Record<string, string>,
      })
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

  // #3475 follow-up (owner decision, 2026-09-30): an `accepted` outcome on an
  // eip3009 plain-HTTP payment with no merchant settlement recorded yet names
  // haven_report_settlement_evidence as the next tool, payment_id prefilled.
  describe('offering haven_report_settlement_evidence (#3475 follow-up)', () => {
    it('accepted + eip3009 + no recorded settlement: names haven_report_settlement_evidence, payment_id only', async () => {
      stubFetch({
        ...HAPPY_ROUTES,
        'GET /machine-payments/pay_x402/status': {
          body: statusBody({ settlement_scheme: 'eip3009' }),
        },
      })
      const result = ok<{
        next_tool?: string
        next_arguments?: Record<string, unknown>
        next_action: string
        reason?: string
      }>(
        await handlers().haven_report_x402_outcome({
          payment_id: 'pay_x402',
          outcome: 'accepted',
          merchant_status: 200,
        }),
      )
      expect(result.data.next_tool).toBe('mcp__haven__haven_report_settlement_evidence')
      expect(result.data.next_arguments).toEqual({ payment_id: 'pay_x402' })
      // S1 (review round 1): next_action is UNCHANGED by the offer — it stays
      // the status re-read's own answer ('none' here, statusBody's default),
      // never AgentPaymentNextAction.AwaitingSettlementEvidence — that value's
      // published meaning (an erc7710 payment past its settlement window) is
      // never reused for this, different, fact.
      expect(result.data.next_action).toBe('none')
      // S4: the offer's reason states the conditional verbatim.
      expect(result.data.reason).toBe(
        "Recorded. If the merchant's response carried a settlement transaction " +
          '(PAYMENT-RESPONSE.transaction), pass it as settlement_tx_hash to ' +
          'haven_report_settlement_evidence so Haven can verify and record it. If it did ' +
          'not, the purchase is already complete and no further Haven tool is needed.',
      )
    })

    it('accepted + eip3009 + settlement ALREADY recorded: no tool follows (unchanged answer)', async () => {
      stubFetch({
        ...HAPPY_ROUTES,
        'GET /machine-payments/pay_x402/status': {
          body: statusBody({ settlement_scheme: 'eip3009', merchant_settlement_recorded: true }),
        },
      })
      const result = ok<{ next_tool?: string; next_tool_omitted_reason?: string }>(
        await handlers().haven_report_x402_outcome({
          payment_id: 'pay_x402',
          outcome: 'accepted',
          merchant_status: 200,
        }),
      )
      expect(result.data.next_tool).toBeUndefined()
      expect(result.data.next_tool_omitted_reason).toBe(
        'the merchant accepted the paid retry; the purchase is complete and no Haven tool follows',
      )
    })

    it('accepted + erc7710: no tool follows (unchanged answer)', async () => {
      stubFetch({
        ...HAPPY_ROUTES,
        'GET /machine-payments/pay_x402/status': {
          body: statusBody({ settlement_scheme: 'erc7710' }),
        },
      })
      const result = ok<{ next_tool?: string; next_tool_omitted_reason?: string }>(
        await handlers().haven_report_x402_outcome({
          payment_id: 'pay_x402',
          outcome: 'accepted',
          merchant_status: 200,
        }),
      )
      expect(result.data.next_tool).toBeUndefined()
      expect(result.data.next_tool_omitted_reason).toBe(
        'the merchant accepted the paid retry; the purchase is complete and no Haven tool follows',
      )
    })

    it('accepted + no settlement_scheme reported (older backend / unknown): no tool follows', async () => {
      stubFetch(HAPPY_ROUTES)
      const result = ok<{ next_tool?: string; next_tool_omitted_reason?: string }>(
        await handlers().haven_report_x402_outcome({
          payment_id: 'pay_x402',
          outcome: 'accepted',
          merchant_status: 200,
        }),
      )
      expect(result.data.next_tool).toBeUndefined()
      expect(result.data.next_tool_omitted_reason).toBe(
        'the merchant accepted the paid retry; the purchase is complete and no Haven tool follows',
      )
    })

    it('rejected + eip3009 unsettled: still sweeps, never offers settlement evidence', async () => {
      stubFetch({
        ...HAPPY_ROUTES,
        'GET /machine-payments/pay_x402/status': {
          body: statusBody({ settlement_scheme: 'eip3009' }),
        },
      })
      const result = ok<{ next_tool?: string }>(
        await handlers().haven_report_x402_outcome({
          payment_id: 'pay_x402',
          outcome: 'rejected',
          merchant_status: 402,
        }),
      )
      expect(result.data.next_tool).toBe('mcp__haven__haven_sweep_delegate')
    })
  })

  // #3727: folding settlement evidence into the outcome report — one call
  // replaces the haven_report_settlement_evidence follow-up, through the SAME
  // on-chain-verified seam (HavenClient.reportSettlementEvidence), so every
  // refusal here is exactly that tool's refusal.
  describe('folding settlement evidence into the report (#3727)', () => {
    const MERCHANT_TX = '0x' + 'be'.repeat(32)
    const PAYER_CLAIM = '0x' + '99'.repeat(20)
    const EVIDENCE_RECORDED_REASON =
      'the merchant accepted the paid retry and the settlement is verified and recorded; the purchase is complete and no Haven tool follows'

    const paymentResponseHeader = (obj: Record<string, unknown>) => encodeBase64Json(obj)

    /** The status route pinned to eip3009 unless overridden. */
    function statusWith(overrides: Record<string, unknown> = {}) {
      return {
        ...HAPPY_ROUTES,
        'GET /machine-payments/pay_x402/status': {
          body: statusBody({ settlement_scheme: 'eip3009', ...overrides }),
        },
      }
    }

    function evidencePosts() {
      return recordedCalls().filter((c) => c.url.endsWith('/machine-payments/evidence'))
    }

    it('settlement_tx_hash on an accepted outcome records the merchant settlement in the SAME call', async () => {
      stubFetch(statusWith())
      const result = ok<{
        settlement_evidence: Record<string, unknown>
        next_tool?: string
        next_tool_omitted_reason?: string
        reason?: string
      }>(
        await handlers().haven_report_x402_outcome({
          payment_id: 'pay_x402',
          outcome: 'accepted',
          merchant_status: 200,
          settlement_tx_hash: MERCHANT_TX,
        }),
      )

      expect(result.data.settlement_evidence).toMatchObject({
        settlement_tx_hash: MERCHANT_TX,
        source: 'settlement_tx_hash',
        recorded: true,
        outcome: 'confirmed',
      })
      // The merchant settlement rides its OWN evidence row: the payment's
      // anchor hash, no resource URL, no merchant status (those belong to the
      // outcome report's own evidence post).
      const posted = evidencePosts().find((c) => (c.body as Record<string, unknown>)?.txHash === MERCHANT_TX)
      expect(posted).toBeDefined()
      expect(posted?.body).toMatchObject({ paymentId: 'pay_x402', rail: 'x402', txHash: MERCHANT_TX })
      expect(posted?.body).not.toHaveProperty('resourceUrl')
      expect(posted?.body).not.toHaveProperty('merchantStatus')
      // The fold's whole point: no tool follows, even though the stubbed
      // status re-read still reports the settlement as unrecorded.
      expect(result.data.next_tool).toBeUndefined()
      expect(result.data.next_tool_omitted_reason).toBe(EVIDENCE_RECORDED_REASON)
      expect(result.data.reason).toContain('verified on-chain')
    })

    it('payment_response decodes to the same record — transaction only, payer NEVER written', async () => {
      stubFetch(statusWith())
      const result = ok<{ settlement_evidence: Record<string, unknown> }>(
        await handlers().haven_report_x402_outcome({
          payment_id: 'pay_x402',
          outcome: 'accepted',
          merchant_status: 200,
          payment_response: paymentResponseHeader({ transaction: MERCHANT_TX, payer: PAYER_CLAIM }),
        }),
      )

      // The hash came from the header, and the source says so.
      expect(result.data.settlement_evidence).toMatchObject({
        settlement_tx_hash: MERCHANT_TX,
        source: 'payment_response',
        recorded: true,
      })
      // #3125 pinned at this boundary: the merchant-claimed `payer` is not
      // the record and reaches nothing Haven writes.
      for (const post of evidencePosts()) {
        expect(JSON.stringify(post.body)).not.toContain(PAYER_CLAIM)
      }
    })

    it('both inputs naming the SAME hash (any case) are one record, not a conflict', async () => {
      stubFetch(statusWith())
      const result = ok<{ settlement_evidence: Record<string, unknown> }>(
        await handlers().haven_report_x402_outcome({
          payment_id: 'pay_x402',
          outcome: 'accepted',
          merchant_status: 200,
          settlement_tx_hash: MERCHANT_TX.slice(0, 2) + MERCHANT_TX.slice(2).toUpperCase(),
          payment_response: paymentResponseHeader({ transaction: MERCHANT_TX }),
        }),
      )
      expect(result.data.settlement_evidence).toMatchObject({ recorded: true, source: 'both' })
    })

    it('both inputs naming DIFFERENT hashes refuse before anything is written', async () => {
      stubFetch(statusWith())
      const payload = fail(
        await handlers().haven_report_x402_outcome({
          payment_id: 'pay_x402',
          outcome: 'accepted',
          merchant_status: 200,
          settlement_tx_hash: MERCHANT_TX,
          payment_response: paymentResponseHeader({ transaction: '0x' + 'cd'.repeat(32) }),
        }),
      )
      expect(payload.code).toBe('SETTLEMENT_EVIDENCE_CONFLICT')
      expect(recordedCalls()).toHaveLength(0)
    })

    it('payment_response that decodes to no transaction refuses before anything is written', async () => {
      stubFetch(statusWith())
      const payload = fail(
        await handlers().haven_report_x402_outcome({
          payment_id: 'pay_x402',
          outcome: 'accepted',
          merchant_status: 200,
          payment_response: paymentResponseHeader({ payer: PAYER_CLAIM, note: 'no transaction here' }),
        }),
      )
      expect(payload.code).toBe('PAYMENT_EVIDENCE_UNREADABLE')
      expect(recordedCalls()).toHaveLength(0)
    })

    it('the zero-hash "delivered, not settled" marker refuses before anything is written', async () => {
      stubFetch(statusWith())
      const payload = fail(
        await handlers().haven_report_x402_outcome({
          payment_id: 'pay_x402',
          outcome: 'accepted',
          merchant_status: 200,
          payment_response: paymentResponseHeader({ transaction: '0x' + '00'.repeat(32) }),
        }),
      )
      expect(payload.code).toBe('ZERO_SETTLEMENT_HASH')
      expect(recordedCalls()).toHaveLength(0)
    })

    it('a hash that does not match on-chain is refused exactly as the evidence tool refuses', async () => {
      // First evidence POST = the outcome report's own (funding-hash) row →
      // 202. The second = the folded settlement report → the same 409 the
      // standalone evidence tool answers, WITH the backend's #3529 reason.
      let evidencePostsSeen = 0
      vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
        const method = (init.method ?? 'GET').toUpperCase()
        const path = new URL(url).pathname
        recordedCalls().push({
          url,
          method,
          body: init.body ? JSON.parse(init.body as string) : undefined,
          headers: (init.headers ?? {}) as Record<string, string>,
        })
        const respond = (status: number, body: unknown) => ({
          ok: status >= 200 && status < 300,
          status,
          headers: new Headers(),
          json: async () => body,
          text: async () => JSON.stringify(body),
          clone: () => ({
            ok: status >= 200 && status < 300,
            status,
            headers: new Headers(),
            json: async () => body,
            text: async () => JSON.stringify(body),
          }),
        })
        if (path.endsWith('/machine-payments/evidence')) {
          evidencePostsSeen += 1
          if (evidencePostsSeen === 1) return respond(202, { evidence: { id: 'ev_1' } })
          return respond(409, {
            error: 'settlement_unverified',
            reason: 'the reported transaction does not settle this payment on-chain',
          })
        }
        if (path.endsWith('/status')) {
          return respond(200, statusBody({ settlement_scheme: 'eip3009' }))
        }
        return respond(404, { error: 'unexpected route' })
      })

      const result = ok<{
        settlement_evidence: Record<string, unknown>
        next_tool?: string
        next_tool_omitted_reason?: string
        reason?: string
      }>(
        await handlers().haven_report_x402_outcome({
          payment_id: 'pay_x402',
          outcome: 'accepted',
          merchant_status: 200,
          settlement_tx_hash: MERCHANT_TX,
        }),
      )
      expect(result.data.settlement_evidence).toMatchObject({
        recorded: false,
        outcome: 'refused',
        refusal_reason: 'the reported transaction does not settle this payment on-chain',
      })
      // A refused hash must not re-report itself: no tool follows, the reason
      // says why.
      expect(result.data.next_tool).toBeUndefined()
      expect(result.data.next_tool_omitted_reason).toContain('do not re-report the same hash')
      expect(result.data.reason).toContain('refused')
    })

    it('a retryable verification hands off to the evidence tool with the hash prefilled', async () => {
      let evidencePostsSeen = 0
      vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
        const method = (init.method ?? 'GET').toUpperCase()
        const path = new URL(url).pathname
        recordedCalls().push({
          url,
          method,
          body: init.body ? JSON.parse(init.body as string) : undefined,
          headers: (init.headers ?? {}) as Record<string, string>,
        })
        const respond = (status: number, body: unknown) => ({
          ok: status >= 200 && status < 300,
          status,
          headers: new Headers(),
          json: async () => body,
          text: async () => JSON.stringify(body),
          clone: () => ({
            ok: status >= 200 && status < 300,
            status,
            headers: new Headers(),
            json: async () => body,
            text: async () => JSON.stringify(body),
          }),
        })
        if (path.endsWith('/machine-payments/evidence')) {
          evidencePostsSeen += 1
          if (evidencePostsSeen === 1) return respond(202, { evidence: { id: 'ev_1' } })
          return respond(503, { error: 'settlement_unobservable' })
        }
        if (path.endsWith('/status')) {
          return respond(200, statusBody({ settlement_scheme: 'eip3009' }))
        }
        return respond(404, { error: 'unexpected route' })
      })

      // The SDK backs off 1s + 2s + 4s before answering retryable — fake
      // timers so the suite stays fast, advanced past the full backoff.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const pending = handlers().haven_report_x402_outcome({
          payment_id: 'pay_x402',
          outcome: 'accepted',
          merchant_status: 200,
          settlement_tx_hash: MERCHANT_TX,
        })
        await vi.advanceTimersByTimeAsync(8_000)
        const result = ok<{
          settlement_evidence: Record<string, unknown>
          next_tool?: string
          next_arguments?: Record<string, unknown>
        }>(await pending)
        expect(result.data.settlement_evidence).toMatchObject({
          recorded: false,
          outcome: 'retryable',
          status_code: 503,
        })
        expect(result.data.next_tool).toBe('mcp__haven__haven_report_settlement_evidence')
        expect(result.data.next_arguments).toEqual({
          payment_id: 'pay_x402',
          settlement_tx_hash: MERCHANT_TX,
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('a REJECTED outcome ignores attached evidence with a warning and still sweeps', async () => {
      stubFetch(HAPPY_ROUTES)
      const result = ok<{
        recorded?: string
        settlement_evidence: Record<string, unknown>
        next_tool?: string
        reason?: string
      }>(
        await handlers().haven_report_x402_outcome({
          payment_id: 'pay_x402',
          outcome: 'rejected',
          merchant_status: 402,
          settlement_tx_hash: MERCHANT_TX,
        }),
      )
      // The rejection itself is recorded (the reconciliation event), the
      // evidence is not — there is no settlement to verify when the merchant
      // refused.
      expect(result.data.recorded).toBe('reconciliation_event')
      expect(evidencePosts()).toHaveLength(0)
      expect(result.data.settlement_evidence).toMatchObject({
        settlement_tx_hash: MERCHANT_TX,
        recorded: false,
        outcome: 'not_attempted',
      })
      expect(String(result.data.settlement_evidence.note)).toContain('only recorded with outcome')
      expect(result.data.next_tool).toBe('mcp__haven__haven_sweep_delegate')
      expect(result.data.reason).toContain('was not used')
    })

    it('calls without evidence carry no settlement_evidence field — the pre-existing shape', async () => {
      stubFetch(statusWith())
      const result = ok<{ settlement_evidence?: unknown }>(
        await handlers().haven_report_x402_outcome({
          payment_id: 'pay_x402',
          outcome: 'accepted',
          merchant_status: 200,
        }),
      )
      expect(result.data.settlement_evidence).toBeUndefined()
    })

    it('erc7710 payments accept folded evidence through the same seam (settled by /settle, verified the same way)', async () => {
      // The open question, pinned: an erc7710 payment's settlement is normally
      // recorded by the settle path, but the merchant's PAYMENT-RESPONSE may
      // still name the redemption — the folded evidence goes through the SAME
      // reportSettlementEvidence call (the original #2972 case), refusing
      // nothing for the scheme.
      stubFetch({
        ...HAPPY_ROUTES,
        'GET /machine-payments/pay_x402/status': {
          body: statusBody({ settlement_scheme: 'erc7710' }),
        },
      })
      const result = ok<{ settlement_evidence: Record<string, unknown>; next_tool?: string }>(
        await handlers().haven_report_x402_outcome({
          payment_id: 'pay_x402',
          outcome: 'accepted',
          merchant_status: 200,
          settlement_tx_hash: MERCHANT_TX,
        }),
      )
      expect(result.data.settlement_evidence).toMatchObject({ recorded: true, outcome: 'confirmed' })
      expect(result.data.next_tool).toBeUndefined()
    })
  })
})

describe('#3774 haven_report_x402_outcome on an erc7710 payment', () => {
  const ERC7710_SUBMITTED = {
    ...HAPPY_ROUTES,
    // A 200 status read (not the backend 409 the sibling test stubs), so the
    // SDK's own anchor gate is what refuses — the path the QA run hit.
    'GET /machine-payments/pay_x402/status': {
      status: 200,
      body: statusBody({ status: 'submitted', phase: 'payment_submitted', tx_hash: null, settlement_scheme: 'erc7710' }),
    },
  }

  it('refuses with a typed code naming haven_report_settlement_evidence, writing nothing', async () => {
    stubFetch(ERC7710_SUBMITTED)
    const payload = fail(
      await handlers().haven_report_x402_outcome({ payment_id: 'pay_x402', outcome: 'accepted', merchant_status: 200 }),
    ) as unknown as Record<string, any>
    expect(payload.code).toBe('ERC7710_REPORT_SETTLEMENT_EVIDENCE')
    expect(payload.code).not.toBe('API_ERROR')
    expect(payload.next_tool_name).toBe('haven_report_settlement_evidence')
    expect(payload.next_arguments).toEqual({ payment_id: 'pay_x402' })
    expect(recordedCalls().some((c) => c.method === 'POST')).toBe(false)
  })

  it('carries the folded settlement hash into next_arguments instead of discarding it', async () => {
    stubFetch(ERC7710_SUBMITTED)
    const payload = fail(
      await handlers().haven_report_x402_outcome({
        payment_id: 'pay_x402',
        outcome: 'accepted',
        merchant_status: 200,
        settlement_tx_hash: TX_HASH,
      }),
    ) as unknown as Record<string, any>
    expect(payload.next_arguments).toEqual({ payment_id: 'pay_x402', settlement_tx_hash: TX_HASH })
  })

  it('a rejected erc7710 retry stops: nothing moved, nothing to report or sweep', async () => {
    stubFetch(ERC7710_SUBMITTED)
    const payload = fail(
      await handlers().haven_report_x402_outcome({ payment_id: 'pay_x402', outcome: 'rejected', merchant_status: 402 }),
    ) as unknown as Record<string, any>
    expect(payload.code).toBe('ERC7710_OUTCOME_NOT_REPORTABLE')
    expect(payload.next_action).toBe('stop_and_tell_user')
    expect(JSON.stringify(payload)).not.toContain('haven_sweep_delegate')
  })

  it('CONTROL: an unconfirmed eip3009 payment keeps the status-read refusal', async () => {
    stubFetch({
      ...HAPPY_ROUTES,
      'GET /machine-payments/pay_x402/status': {
        status: 200,
        body: statusBody({ status: 'submitted', phase: 'payment_submitted', tx_hash: null, settlement_scheme: 'eip3009' }),
      },
    })
    const payload = fail(
      await handlers().haven_report_x402_outcome({ payment_id: 'pay_x402', outcome: 'accepted', merchant_status: 200 }),
    ) as unknown as Record<string, any>
    // Unchanged: the pre-#3774 refusal, whose next step is the status
    // projection's own next_action (stateErrorNextStep), not the erc7710 remedy.
    expect(payload.code).toBe('API_ERROR')
    expect(payload.status).toBe('submitted')
    expect(JSON.stringify(payload)).not.toContain('haven_report_settlement_evidence')
  })
})
