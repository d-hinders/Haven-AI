/**
 * #4061 — the X-PAYMENT proof header on the hosted settlement reports.
 *
 * Since #3925 the backend records an agent-reported eip3009 merchant
 * settlement only when the report carries the payment header that was sent
 * to the merchant (`paymentProofHeader`); without it the report is refused.
 * On the plain-HTTP path the AGENT makes the paid retry, so the hosted
 * server never sees that header unless the agent hands it back. These pin
 * what `haven_report_x402_outcome` and `haven_report_settlement_evidence`
 * do with that header and with that refusal, at the hosted boundary
 * (stubbed backend, the real SDK client underneath).
 *
 * The proof check itself — the header must be signed by THIS payment's
 * delegate and name the nonce the settlement burned — is the backend's, and
 * is proven against real Postgres in
 * `packages/backend/src/modules/mpp/__tests__/eip3009-settlement-evidence.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { deliveryReferenceError } from '@haven_ai/core'
import { HAVEN_SKILL_MD, encodeBase64Json } from '@haven_ai/sdk'
import { toolDescriptions as signerDescriptions } from '@haven_ai/signer'
import { HOSTED_INSTRUCTIONS } from './server.js'
import { toolDescriptions } from './tools.js'
import {
  clearCalls,
  fail,
  handlers,
  installSharedFixtureLifecycle,
  ok,
  recordedCalls,
} from './test-support/hosted-mcp.js'

installSharedFixtureLifecycle()

const FUNDING_TX = '0x' + 'ab'.repeat(32)
const MERCHANT_TX = '0x' + 'be'.repeat(32)

/** The backend's #3925 `MISSING_PROOF_HEADER_REASON`, verbatim. */
const MISSING_HEADER_REASON =
  'The settlement report carries no X-PAYMENT payment header, so the nonce its settlement ' +
  'burned cannot be proven bound to this payment — report the settlement again with the ' +
  'payment header that was sent to the merchant (the retry path carries it)'

const NOT_RECORDED = 'The reported settlement transaction was not recorded for this payment — the payment is unchanged'

/** The backend's missing-header 409 since #4061: the reason AND the code. */
const MISSING_HEADER_409 = {
  status: 409,
  body: { error: NOT_RECORDED, reason: MISSING_HEADER_REASON, error_code: 'settlement_proof_header_missing' },
}

/** A header this payment's delegate did not sign: a different refusal, no code. */
const FOREIGN_HEADER_REASON =
  'The X-PAYMENT header’s authorization names a different payer than this payment’s delegate'
const FOREIGN_HEADER_409 = { status: 409, body: { error: NOT_RECORDED, reason: FOREIGN_HEADER_REASON } }

/**
 * An EIP-3009-shaped payment header: what the signer's haven_sign_x402
 * returns and the agent retried the merchant with (base64 JSON, a signed
 * authorization). Its content is the backend's to verify; the hosted tool
 * forwards it verbatim.
 */
const PAYMENT_HEADER = encodeBase64Json({
  x402Version: 1,
  scheme: 'exact',
  network: 'eip155:84532',
  payload: {
    signature: '0x' + '5a'.repeat(65),
    authorization: {
      from: '0x00000000000000000000000000000000000000d1',
      to: '0x00000000000000000000000000000000000000c1',
      value: '100000',
      validAfter: '0',
      validBefore: '9999999999',
      nonce: '0x' + '77'.repeat(32),
    },
  },
})

/**
 * The backend's #3925 rule, as the hosted tool meets it: a settlement report
 * WITH a proof header is judged (here: recorded), one WITHOUT is refused with
 * the typed code.
 */
const BACKEND_RULE = (body: Record<string, unknown> | undefined) =>
  body?.paymentProofHeader ? { status: 202, body: { evidence: { id: 'ev_settle' } } } : MISSING_HEADER_409

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
    resource_url: 'https://merchant.example/resource',
    merchant_address: '0x00000000000000000000000000000000000000c1',
    tx_hash: FUNDING_TX,
    expires_at: '2099-01-01T00:00:00.000Z',
    chain_id: 8453,
    settlement_scheme: 'eip3009',
    message: 'The payment is confirmed.',
    ...overrides,
  }
}

/**
 * Every evidence post answers 202 EXCEPT the settlement report (the one
 * whose `txHash` is the merchant's settlement), which answers
 * `settlementAnswer` — the outcome report's own funding-hash post is a
 * different request and must not be the one refused.
 */
function stubSettlementAnswer(
  settlementAnswer:
    | { status: number; body: unknown }
    | ((body: Record<string, unknown> | undefined) => { status: number; body: unknown }),
  // #4061 review: the payment's status as the backend reports it (default: a
  // funded eip3009 payment); `null` makes the status read fail.
  status: Record<string, unknown> | null = statusBody(),
) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const path = new URL(url).pathname
    const body = init.body ? JSON.parse(init.body as string) : undefined
    recordedCalls().push({ url, method, body, headers: (init.headers ?? {}) as Record<string, string> })
    const respond = (status: number, payload: unknown) => ({
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
    })
    if (path.endsWith('/machine-payments/evidence')) {
      if (body?.txHash === MERCHANT_TX) {
        const answer = typeof settlementAnswer === 'function' ? settlementAnswer(body) : settlementAnswer
        return respond(answer.status, answer.body)
      }
      return respond(202, { evidence: { id: 'ev_1' } })
    }
    if (path.endsWith('/status')) {
      if (!status) return respond(503, { error: 'down' })
      if (status.__status404) return respond(404, { error: 'Payment not found' })
      return respond(200, status)
    }
    return respond(404, { error: 'unexpected route' })
  })
}

/** The settlement report the hosted tool posted, if any. */
function settlementPost() {
  return recordedCalls().find(
    (c) => c.url.endsWith('/machine-payments/evidence') && c.body?.txHash === MERCHANT_TX,
  )
}

beforeEach(() => {
  clearCalls()
})

type OutcomeData = {
  settlement_evidence: Record<string, unknown>
  next_action?: string
  next_tool?: string
  next_tool_name?: string
  next_arguments?: Record<string, unknown>
  next_tool_omitted_reason?: string
  reason?: string
}

describe('#4061 haven_report_x402_outcome carries the proof header', () => {
  it('with payment_header: the settlement is recorded, and the header is forwarded exactly as the SDK forwards it', async () => {
    stubSettlementAnswer(BACKEND_RULE)
    const result = ok<OutcomeData>(
      await handlers().haven_report_x402_outcome({
        payment_id: 'pay_x402',
        outcome: 'accepted',
        merchant_status: 200,
        settlement_tx_hash: MERCHANT_TX,
        payment_header: PAYMENT_HEADER,
      }),
    )
    expect(result.data.settlement_evidence).toMatchObject({ recorded: true, outcome: 'confirmed' })
    expect(result.data.settlement_evidence).not.toHaveProperty('code')
    expect(result.data.next_tool).toBeUndefined()
    // `paymentProofHeader` verbatim, plus the names `x402PaymentHeaderNamesSent`
    // derives from this (EIP-3009) payload — the SDK funding report's pair.
    expect(settlementPost()?.body).toEqual({
      paymentId: 'pay_x402',
      rail: 'x402',
      txHash: MERCHANT_TX,
      paymentProofHeaderName: 'PAYMENT-SIGNATURE, X-PAYMENT',
      paymentProofHeader: PAYMENT_HEADER,
    })
  })

  it('the header is read only with the settlement report: the outcome’s own funding-hash post never carries it', async () => {
    stubSettlementAnswer(BACKEND_RULE)
    await handlers().haven_report_x402_outcome({
      payment_id: 'pay_x402',
      outcome: 'accepted',
      merchant_status: 200,
      settlement_tx_hash: MERCHANT_TX,
      payment_header: PAYMENT_HEADER,
    })
    const fundingPost = recordedCalls().find(
      (c) => c.url.endsWith('/machine-payments/evidence') && c.body?.txHash === FUNDING_TX,
    )
    expect(fundingPost).toBeDefined()
    expect(fundingPost?.body).not.toHaveProperty('paymentProofHeader')
  })

  it('without payment_header: the typed refusal, and guidance that names the parameter — never a hash mismatch', async () => {
    stubSettlementAnswer(BACKEND_RULE)
    const result = ok<OutcomeData>(
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
      status_code: 409,
      refusal_reason: MISSING_HEADER_REASON,
      code: 'SETTLEMENT_PROOF_HEADER_MISSING',
    })
    // The fix is the evidence tool again, the hash prefilled — the agent adds
    // payment_header, which Haven never saw and so cannot prefill.
    expect(result.data.next_tool).toBe('mcp__haven__haven_report_settlement_evidence')
    expect(result.data.next_arguments).toEqual({ payment_id: 'pay_x402', settlement_tx_hash: MERCHANT_TX })
    expect(result.data.next_tool_omitted_reason).toBeUndefined()
    expect(result.data.reason).toContain('payment_header')
    expect(result.data.reason).toContain('The hash was not judged')
    // The #4061 defect, pinned shut: no field says the hash mismatched.
    expect(JSON.stringify(result.data)).not.toMatch(/does not match this payment on-chain/)
    expect(JSON.stringify(result.data)).not.toMatch(/do not re-report/i)
    expect(settlementPost()?.body).not.toHaveProperty('paymentProofHeader')
  })

  it('a header from ANOTHER payment is still refused on the hosted path: no code, no re-report, nothing recorded', async () => {
    // The backend's #3925 check refuses a header its delegate did not sign
    // (and, since #4061, a same-agent sibling's derived-nonce header). The
    // hosted path forwards the header verbatim and relays that refusal as the
    // terminal one it is — it must not read it as the fixable missing header.
    stubSettlementAnswer(FOREIGN_HEADER_409)
    const result = ok<OutcomeData>(
      await handlers().haven_report_x402_outcome({
        payment_id: 'pay_x402',
        outcome: 'accepted',
        merchant_status: 200,
        settlement_tx_hash: MERCHANT_TX,
        payment_header: PAYMENT_HEADER,
      }),
    )
    expect(settlementPost()?.body).toMatchObject({ paymentProofHeader: PAYMENT_HEADER })
    expect(result.data.settlement_evidence).toMatchObject({
      recorded: false,
      outcome: 'refused',
      refusal_reason: FOREIGN_HEADER_REASON,
    })
    expect(result.data.settlement_evidence).not.toHaveProperty('code')
    expect(result.data.next_tool).toBeUndefined()
    expect(result.data.next_tool_omitted_reason).toContain('do not re-report the same hash')
  })

  it('payment_header is a payment header, not a credential: the delivery_reference check never reads it', async () => {
    // A long base64 header is exactly what `deliveryReferenceError` refuses as
    // a delivery reference (length, and secret shape) — proven here, so the
    // positive half below is not vacuous.
    expect(deliveryReferenceError(PAYMENT_HEADER)).not.toBeNull()
    stubSettlementAnswer(BACKEND_RULE)
    const result = ok<OutcomeData>(
      await handlers().haven_report_x402_outcome({
        payment_id: 'pay_x402',
        outcome: 'accepted',
        merchant_status: 200,
        settlement_tx_hash: MERCHANT_TX,
        payment_header: PAYMENT_HEADER,
        delivery_reference: 'Bik Bok 5 SEK, order 6ac7',
      }),
    )
    expect(result.data.settlement_evidence).toMatchObject({ recorded: true })
  })

  it('a payment_header past the backend’s 16 KiB stored-header cap is refused before anything is written', async () => {
    stubSettlementAnswer(BACKEND_RULE)
    const payload = fail(
      await handlers().haven_report_x402_outcome({
        payment_id: 'pay_x402',
        outcome: 'accepted',
        merchant_status: 200,
        settlement_tx_hash: MERCHANT_TX,
        payment_header: 'A'.repeat(16_385),
      }),
    )
    expect(payload.message).toContain('payment_header')
    expect(recordedCalls()).toHaveLength(0)
  })
})

describe('#4061 haven_report_settlement_evidence carries the proof header', () => {
  it('with payment_header: settled, and the header is forwarded as paymentProofHeader + names', async () => {
    stubSettlementAnswer(BACKEND_RULE)
    const result = ok<Record<string, any>>(
      await handlers().haven_report_settlement_evidence({
        payment_id: 'pay_x402',
        settlement_tx_hash: MERCHANT_TX,
        payment_header: PAYMENT_HEADER,
      }),
    )
    expect(result.data.settled).toBe(true)
    expect(result.data.code).toBeUndefined()
    expect(settlementPost()?.body).toEqual({
      paymentId: 'pay_x402',
      rail: 'x402',
      txHash: MERCHANT_TX,
      paymentProofHeaderName: 'PAYMENT-SIGNATURE, X-PAYMENT',
      paymentProofHeader: PAYMENT_HEADER,
    })
  })

  it('without payment_header: SETTLEMENT_PROOF_HEADER_MISSING, re-call this tool with it — not SETTLEMENT_NOT_RECORDED', async () => {
    stubSettlementAnswer(BACKEND_RULE)
    const result = ok<Record<string, any>>(
      await handlers().haven_report_settlement_evidence({
        payment_id: 'pay_x402',
        settlement_tx_hash: MERCHANT_TX,
      }),
    )
    expect(result.data.settled).toBe(false)
    expect(result.data.code).toBe('SETTLEMENT_PROOF_HEADER_MISSING')
    expect(result.data.refusal_reason).toBe(MISSING_HEADER_REASON)
    expect(result.data.next_action).toBe('retry_with_explicit_context')
    expect(result.data.next_tool).toBe('mcp__haven__haven_report_settlement_evidence')
    expect(result.data.next_arguments).toEqual({ payment_id: 'pay_x402', settlement_tx_hash: MERCHANT_TX })
    expect(result.data.reason).toContain('adding payment_header')
    expect(result.data.reason).not.toContain('will not change that')
    expect(JSON.stringify(result.data)).not.toMatch(/does not match this payment on-chain/)
    expect(result.data.agent_summary.status).toBe('confirmed')
  })

  it('a header from ANOTHER payment stays the terminal SETTLEMENT_NOT_RECORDED, the header forwarded verbatim', async () => {
    stubSettlementAnswer(FOREIGN_HEADER_409)
    const result = ok<Record<string, any>>(
      await handlers().haven_report_settlement_evidence({
        payment_id: 'pay_x402',
        settlement_tx_hash: MERCHANT_TX,
        payment_header: PAYMENT_HEADER,
      }),
    )
    expect(settlementPost()?.body).toMatchObject({ paymentProofHeader: PAYMENT_HEADER })
    expect(result.data.code).toBe('SETTLEMENT_NOT_RECORDED')
    expect(result.data.refusal_reason).toBe(FOREIGN_HEADER_REASON)
    expect(result.data.next_tool).toBe('mcp__haven__haven_get_payment_status')
    expect(result.data.reason).toContain('Reporting the same hash again will not change that')
  })

  it('the missing-header arm keys on error_code, not the sentence: the same reason WITHOUT the code is SETTLEMENT_NOT_RECORDED', async () => {
    // An older backend relays the #3925 sentence with no code. The hosted
    // tool must not pattern-match prose into a remedy it cannot confirm.
    stubSettlementAnswer({ status: 409, body: { error: NOT_RECORDED, reason: MISSING_HEADER_REASON } })
    const result = ok<Record<string, any>>(
      await handlers().haven_report_settlement_evidence({
        payment_id: 'pay_x402',
        settlement_tx_hash: MERCHANT_TX,
      }),
    )
    expect(result.data.code).toBe('SETTLEMENT_NOT_RECORDED')
  })
})

describe('#4061 every plain-HTTP report instruction names payment_header', () => {
  // Each place that tells the agent to report after its own plain-HTTP
  // retry must say to pass the header it retried with — otherwise the agent
  // follows the guidance and the settlement is refused. The sentence that
  // names the report tool must name payment_header too (one sentence, so a
  // payment_header mentioned elsewhere for the RETRY does not satisfy it).
  const REPORT_THEN_HEADER = /haven_report_x402_outcome[^.]*payment_header/
  const surfaces: Array<[string, string]> = [
    ['hosted instructions', HOSTED_INSTRUCTIONS],
    ['haven_pay_x402_quote description', toolDescriptions.haven_pay_x402_quote],
    ['haven_resume_x402_payment description', toolDescriptions.haven_resume_x402_payment],
    ["the signer's haven_sign_x402 description", signerDescriptions.haven_sign_x402],
    ['the agent skill', HAVEN_SKILL_MD],
  ]
  for (const [name, text] of surfaces) {
    it(`${name}: the report sentence names payment_header`, () => {
      expect(text).toMatch(REPORT_THEN_HEADER)
    })
  }

  it('both report tools describe payment_header', () => {
    expect(toolDescriptions.haven_report_x402_outcome).toContain('payment_header')
    expect(toolDescriptions.haven_report_settlement_evidence).toContain('payment_header')
    expect(toolDescriptions.haven_report_settlement_evidence).toContain('SETTLEMENT_PROOF_HEADER_MISSING')
  })
})

describe('#4061 review: payment_header is forwarded only on the report it proves', () => {
  // Anywhere but the eip3009 merchant-settlement branch, the header would
  // reach the evidence attach path, whose COALESCE overwrites the header Haven
  // or the SDK stored. So it is dropped there.
  const proofPosts = () =>
    recordedCalls().filter((c) => c.url.endsWith('/machine-payments/evidence') && c.body?.paymentProofHeader)

  it('haven_report_settlement_evidence: an erc7710 payment never gets the header', async () => {
    stubSettlementAnswer(BACKEND_RULE, statusBody({ settlement_scheme: 'erc7710', status: 'submitted', tx_hash: null }))
    await handlers().haven_report_settlement_evidence({
      payment_id: 'pay_x402',
      settlement_tx_hash: MERCHANT_TX,
      payment_header: PAYMENT_HEADER,
    })
    expect(settlementPost()).toBeDefined()
    expect(proofPosts()).toHaveLength(0)
  })

  it('haven_report_settlement_evidence: a report of the FUNDING hash never gets the header', async () => {
    stubSettlementAnswer(BACKEND_RULE)
    await handlers().haven_report_settlement_evidence({
      payment_id: 'pay_x402',
      settlement_tx_hash: FUNDING_TX,
      payment_header: PAYMENT_HEADER,
    })
    expect(recordedCalls().some((c) => c.url.endsWith('/machine-payments/evidence'))).toBe(true)
    expect(proofPosts()).toHaveLength(0)
  })

  it('haven_report_settlement_evidence: a status read that fails transiently posts NOTHING and says to retry with the same header', async () => {
    // Posting without the header would earn a certain missing-header refusal
    // telling an agent that DID pass one to "add payment_header" — a loop.
    stubSettlementAnswer(BACKEND_RULE, null)
    const result = ok<Record<string, any>>(
      await handlers().haven_report_settlement_evidence({
        payment_id: 'pay_x402',
        settlement_tx_hash: MERCHANT_TX,
        payment_header: PAYMENT_HEADER,
      }),
    )
    expect(recordedCalls().some((c) => c.url.endsWith('/machine-payments/evidence'))).toBe(false)
    expect(result.data).toMatchObject({ settled: false, code: 'SETTLEMENT_PENDING', retryable: true })
    expect(result.data.next_action).toBe('retry_with_explicit_context')
    expect(result.data.next_tool).toBe('mcp__haven__haven_report_settlement_evidence')
    expect(result.data.next_arguments).toEqual({ payment_id: 'pay_x402', settlement_tx_hash: MERCHANT_TX })
    expect(result.data.reason).toContain('the same payment_header you passed')
    expect(result.data.reason).not.toMatch(/carried no payment_header/)
  })

  it('haven_report_settlement_evidence: a status read the backend refuses (404) drops the header and reports as before', async () => {
    // A foreign/unknown payment is not transient: the report gets the same
    // 404, classified as it always was — the header is just never sent.
    stubSettlementAnswer({ status: 404, body: { error: 'Payment not found' } }, { __status404: true })
    const result = ok<Record<string, any>>(
      await handlers().haven_report_settlement_evidence({
        payment_id: 'pay_x402',
        settlement_tx_hash: MERCHANT_TX,
        payment_header: PAYMENT_HEADER,
      }),
    )
    expect(settlementPost()).toBeDefined()
    expect(proofPosts()).toHaveLength(0)
    expect(result.data.code).toBe('DELIVERED_UNSETTLED')
  })

  it('haven_report_x402_outcome: folded evidence naming the funding anchor never gets the header', async () => {
    stubSettlementAnswer(BACKEND_RULE)
    await handlers().haven_report_x402_outcome({
      payment_id: 'pay_x402',
      outcome: 'accepted',
      merchant_status: 200,
      settlement_tx_hash: FUNDING_TX,
      payment_header: PAYMENT_HEADER,
    })
    expect(recordedCalls().filter((c) => c.url.endsWith('/machine-payments/evidence')).length).toBeGreaterThan(1)
    expect(proofPosts()).toHaveLength(0)
  })
})
