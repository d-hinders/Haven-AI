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
import { clearCalls, handlers, installSharedFixtureLifecycle, ok, recordedCalls } from './test-support/hosted-mcp.js'

installSharedFixtureLifecycle()

const FUNDING_TX = '0x' + 'ab'.repeat(32)
const MERCHANT_TX = '0x' + 'be'.repeat(32)

/** The backend's #3925 `MISSING_PROOF_HEADER_REASON`, verbatim. */
const MISSING_HEADER_REASON =
  'The settlement report carries no X-PAYMENT payment header, so the nonce its settlement ' +
  'burned cannot be proven bound to this payment — report the settlement again with the ' +
  'payment header that was sent to the merchant (the retry path carries it)'

const MISSING_HEADER_409 = {
  status: 409,
  body: {
    error: 'The reported settlement transaction was not recorded for this payment — the payment is unchanged',
    reason: MISSING_HEADER_REASON,
  },
}

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
function stubSettlementAnswer(settlementAnswer: { status: number; body: unknown }) {
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
      if (body?.txHash === MERCHANT_TX) return respond(settlementAnswer.status, settlementAnswer.body)
      return respond(202, { evidence: { id: 'ev_1' } })
    }
    if (path.endsWith('/status')) return respond(200, statusBody())
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

describe('#4061 haven_report_x402_outcome and the missing-proof-header refusal', () => {
  it('CHARACTERIZATION (pre-fix): the refusal is reported as an on-chain hash mismatch, and no header is posted', async () => {
    stubSettlementAnswer(MISSING_HEADER_409)
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
      status_code: 409,
      refusal_reason: MISSING_HEADER_REASON,
    })
    // The defect #4061 reports: the guidance blames the hash.
    expect(result.data.reason).toContain('the hash does not match this payment on-chain')
    expect(result.data.next_tool).toBeUndefined()
    expect(result.data.next_tool_omitted_reason).toContain('does not match this payment on-chain')
    // And the hosted tool had nothing to forward.
    expect(settlementPost()?.body).not.toHaveProperty('paymentProofHeader')
  })
})

describe('#4061 haven_report_settlement_evidence and the missing-proof-header refusal', () => {
  it('CHARACTERIZATION (pre-fix): the refusal says re-reporting will not help, and no header is posted', async () => {
    stubSettlementAnswer(MISSING_HEADER_409)
    const result = ok<Record<string, any>>(
      await handlers().haven_report_settlement_evidence({
        payment_id: 'pay_x402',
        settlement_tx_hash: MERCHANT_TX,
      }),
    )
    expect(result.data.code).toBe('SETTLEMENT_NOT_RECORDED')
    expect(result.data.refusal_reason).toBe(MISSING_HEADER_REASON)
    expect(result.data.reason).toContain('Reporting the same hash again will not change that')
    expect(result.data.next_tool).toBe('mcp__haven__haven_get_payment_status')
    expect(settlementPost()?.body).not.toHaveProperty('paymentProofHeader')
  })
})
