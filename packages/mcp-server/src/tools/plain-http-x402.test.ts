/**
 * #2811 — colocated tests for the PLAIN-HTTP X402 capability.
 *
 * Moved VERBATIM out of `tools.test.ts` on the #2810 model: every block here
 * invokes ONLY the four tools this capability owns (haven_quote_x402,
 * haven_pay_x402_quote, haven_resume_x402_payment, haven_report_x402_outcome).
 * Blocks that also drive a sibling capability's handler stayed behind — the
 * classification is by the invocation set of a top-level `describe`, not by
 * title (see tools/catalog-purchase.test.ts for the full statement of that
 * rule, and #2811 for AntonioSaaranen's measurement note).
 *
 * `#2145: the hosted resume description gates on the live retry trigger` and
 * the two description-only blocks (`runtime-neutral tool naming (#1588)`,
 * `next_tool emission literals (#1588 review)`) remain in `tools.test.ts`:
 * they invoke no x402 handler (they are description-text assertions over the
 * residual surface) and moving them would be a re-classification, not a move.
 *
 * Fixtures come from the #2808 shared module, never re-declared here.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import {
  AgentPaymentFailureCode,
  AgentPaymentNextAction,
  SIGNER_UPDATE_FALLBACK,
} from '@haven_ai/sdk'
import {
  AGENT_RESPONSE,
  DELEGATE_KEY,
  PAYMENT_REQUIRED,
  X402_EXPECTED_AUTH,
  X402_INTENT_RESPONSE,
  clearCalls,
  handlers,
  installSharedFixtureLifecycle,
  mintPaymentHeaders,
  ok,
  recordedCalls,
  stubFetch,
} from '../test-support/hosted-mcp.js'

installSharedFixtureLifecycle()

beforeEach(() => {
  clearCalls()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ── x402 fixtures ─────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Headers are minted by the SDK's real signing path so these fixtures
  // cannot drift from what a client actually sends (#1618 note — see the
  // shared fixture's mintPaymentHeaders).
  await mintPaymentHeaders()
})

// ── haven_pay_x402_quote ──────────────────────────────────────────────────────

describe('haven_pay_x402_quote', () => {
  it('rejects with PRICE_EXCEEDS_MAX before funding when the option price is above max_amount', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    const payload = await handlers().haven_pay_x402_quote({
      payment_required: PAYMENT_REQUIRED,
      max_amount: '1000000', // below the fixture's authoritative 1500000
    })

    expect(payload.success).toBe(false)
    if (payload.success) throw new Error('expected failure')
    expect(payload.code).toBe(AgentPaymentFailureCode.PriceExceedsMax)
    // #2041 CHARACTERIZATION CHANGE, stated rather than quietly dropped: this
    // used to also assert the agent fetch had not run. The cap is now asserted
    // AFTER scheme selection — because a cap checked before selection is a cap
    // checked against an option that may not be the one authorized, which was
    // wrong in both directions (#2051, and the over-binding mirror) — and
    // selection needs the account's rail. So a read-only GET now precedes this
    // refusal.
    //
    // The property that protects money is unchanged and still pinned: no
    // authorize is created, so no funding intent exists and no funds moved.
    expect(recordedCalls().find((c) => c.url.endsWith('/x402'))).toBeUndefined()
    expect(recordedCalls().every((c) => c.method === 'GET')).toBe(true)
  })

  it('returns the unsigned funding hash + x402 data for the edge, signing nothing', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    const result = ok<{
      payment_id: string
      idempotency_key: string
      payload_hash: string
      next_tool: string
      reason: string
      x402: Record<string, unknown>
    }>(await handlers().haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED }))

    expect(result.data.payment_id).toBe('pay_x402')
    expect(result.data.idempotency_key).toMatch(/^x402:/)
    // #2291: next_tool was already right; the REASON beside it, in the SAME
    // response object, named a successor the named tool cannot serve —
    // "finish with haven_x402_sign_header" after a one-shot that spends its
    // own binding building the header inline. A test asserting only next_tool
    // stayed green while the pair contradicted itself. Cheap literal guards,
    // the same shape the erc7710 branch already uses; nothing interprets a
    // sentence.
    expect(result.data.next_tool).toBe('mcp__haven-signer__haven_sign_x402')
    expect(result.data.reason).toContain('Do NOT call')
    expect(result.data.reason).toContain('haven_x402_sign_header')
    expect(result.data.reason).toContain('payment_header')
    expect(result.data.payload_hash).toBe('0xfunding')
    expect(result.data.x402.funding_to).toBe('0xDelegate')
    expect(result.data.x402.merchant_to).toBe('0xMerchant')
    expect(result.data.x402.expected).toEqual({
      payment_id: 'pay_x402',
      payload_hash: '0xfunding',
      // The value Haven SIGNED — `paymentRequired.resource.url`. This used to
      // mirror the implementation's `accepted.resource ?? resourceUrl`, so it
      // passed whichever way the code went (#1189).
      resource_url: PAYMENT_REQUIRED.resource.url,
      merchant_to: '0xMerchant',
      amount: PAYMENT_REQUIRED.accepts[0].maxAmountRequired,
      asset: PAYMENT_REQUIRED.accepts[0].asset,
      network: PAYMENT_REQUIRED.accepts[0].network,
      expires_at: X402_INTENT_RESPONSE.expires_at,
      auth: X402_EXPECTED_AUTH,
    })

    // Custody: the funding request tops up the delegate EOA but carries no key.
    const x402Call = recordedCalls().find((c) => c.url.endsWith('/x402'))
    expect(x402Call?.body).toMatchObject({
      payTo: '0xDelegate',
      merchantPayTo: PAYMENT_REQUIRED.accepts[0].payTo,
      amount: PAYMENT_REQUIRED.accepts[0].maxAmountRequired,
    })
    expect(JSON.stringify(recordedCalls())).not.toContain(DELEGATE_KEY)
    expect(JSON.stringify(recordedCalls())).not.toContain('delegate_key')
  })

  it('binds resource_url to what Haven signed, even when the option carries its own resource (#1189)', async () => {
    // A merchant may set a `resource` on the accepted option that differs from
    // the top-level one. The backend signs the TOP-LEVEL url, so preferring the
    // option's here reconstructed a different message and the signer refused
    // with "authentication message is invalid" — an error that reads as a
    // credential problem, not a field mismatch. The signature is the authority.
    const optionScopedResource = {
      ...PAYMENT_REQUIRED,
      accepts: [{ ...PAYMENT_REQUIRED.accepts[0], resource: 'https://merchant.test/option-scoped' }],
    }
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    const result = ok<{ x402: { expected: { resource_url: string } } }>(
      await handlers().haven_pay_x402_quote({ payment_required: optionScopedResource }),
    )

    expect(result.data.x402.expected.resource_url).toBe(PAYMENT_REQUIRED.resource.url)
    expect(result.data.x402.expected.resource_url).not.toBe('https://merchant.test/option-scoped')
  })

  it('reports the expected-context version this quote will emit, pre-payment (#1155)', async () => {
    // The hosted half of pre-payment skew detection. The agent holds the
    // signer's advertised set from that server's initialize handshake; this is
    // the number to compare it against, available before haven_sign is called
    // and before haven_submit moves anything.
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    const result = ok<{
      signer_compatibility: {
        x402_expected_context_version: number
        signer_capability: string
        check: string
      }
    }>(await handlers().haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED }))

    // Read from the binding Haven signed, not re-derived here.
    expect(result.data.signer_compatibility.x402_expected_context_version).toBe(
      X402_EXPECTED_AUTH.version,
    )
    expect(result.data.signer_compatibility.signer_capability).toBe('haven/signer-compatibility')
  })

  it('carries the skew warning in-band, naming the #1143 fix (#1155)', async () => {
    // Warning, not refusal: the quote succeeds either way. The instruction
    // travels with the number so an agent that never reads tool descriptions
    // still sees it at the moment it matters.
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    const result = ok<{ signer_compatibility: { check: string } }>(
      await handlers().haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED }),
    )

    const check = result.data.signer_compatibility.check
    expect(check).toContain('@haven_ai/signer')
    expect(check).toContain('npx @haven_ai/connect@alpha')
    expect(check).toMatch(/STOP before signing/)
    // Same standing instruction as the signing-time error (#1143).
    expect(check).toMatch(/invalidates the signature/)
  })

  it('carries the recovery guidance as STRUCTURED data too, not only inside check (#1309)', async () => {
    // #1309: signer_compatibility is the stable machine-readable compatibility
    // contract. `fallback` is the same fix `check` states in prose, as a field
    // an agent can read without parsing a sentence — and it is the SAME string
    // (SIGNER_UPDATE_FALLBACK) the local signer's own structured refusal uses,
    // so an agent that meets either surface gets identical guidance.
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    const result = ok<{ signer_compatibility: { fallback: string } }>(
      await handlers().haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED }),
    )

    expect(result.data.signer_compatibility.fallback).toBe(SIGNER_UPDATE_FALLBACK)
  })

  it('does not refuse a quote whose emitted version the signer may not know (#1155)', async () => {
    // The skew scenario itself. A newer backend emits a version no shipped
    // signer knows; the quote must still succeed and simply report it. Refusing
    // here on reported client metadata would let a false positive block a
    // working payment — strictly worse than the current state.
    const futureVersionIntent = {
      ...X402_INTENT_RESPONSE,
      x402_expected_auth: { ...X402_EXPECTED_AUTH, version: 99 },
    }
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: futureVersionIntent },
    })

    const result = ok<{
      payload_hash: string
      signer_compatibility: { x402_expected_context_version: number }
    }>(await handlers().haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED }))

    expect(result.data.payload_hash).toBe('0xfunding')
    expect(result.data.signer_compatibility.x402_expected_context_version).toBe(99)
  })

  it('surfaces pending_approval (no hash) when the x402 amount is over budget', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 202, body: { payment_id: 'pay_over', status: 'pending_approval' } },
    })

    const result = ok<{ status: string; payload_hash: unknown }>(
      await handlers().haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED }),
    )
    expect(result.data.status).toBe('pending_approval')
    expect(result.data.payload_hash).toBeNull()
  })
})

// ── haven_quote_x402 ──────────────────────────────────────────────────────────

describe('haven_quote_x402', () => {
  it('probes the merchant, returns payment_required without creating a Haven payment', async () => {
    // The SDK reads payment_required from the PAYMENT-REQUIRED response header (base64 JSON).
    const paymentRequiredHeader = btoa(JSON.stringify(PAYMENT_REQUIRED))
    stubFetch({
      'GET /paid': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': paymentRequiredHeader },
      },
    })

    const result = ok<{
      payment_required: unknown
      amount: string
      resource_url: string
    }>(await handlers().haven_quote_x402({ url: 'http://merchant.test/paid' }))

    expect(result.data.payment_required).toBeDefined()
    // Haven was never contacted — only the merchant URL.
    expect(recordedCalls().every((c) => c.url.includes('merchant.test'))).toBe(true)
    // No x402 intent created.
    expect(recordedCalls().find((c) => c.url.endsWith('/x402'))).toBeUndefined()
  })
})

// ── haven_resume_x402_payment ─────────────────────────────────────────────────

describe('haven_resume_x402_payment', () => {
  it('returns signing context when payment is ready to retry', async () => {
    const resumeState = {
      rail: 'x402' as const,
      paymentId: 'pay_approved',
      idempotencyKey: 'idem_1',
      paymentRequired: PAYMENT_REQUIRED,
      accepted: PAYMENT_REQUIRED.accepts[0],
      url: 'https://merchant.test/paid',
      resourceUrl: 'https://merchant.test/paid',
      description: null,
      amountAtomic: '1500000',
      amount: '1.50',
      token: 'USDC',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      network: 'base',
      chainId: 8453,
      merchantAddress: '0xMerchant',
    }

    stubFetch({
      // getPaymentStatus recordedCalls() /machine-payments/:id/status
      'GET /machine-payments/pay_approved/status': {
        status: 200,
        body: {
          payment_id: 'pay_approved',
          status: 'confirmed',
          next_action: 'retry_original_x402_request',
          tx_hash: '0xfunded',
          rail: 'x402',
        },
      },
    })

    const result = ok<{
      payment_id: string
      payment_required: unknown
      x402: Record<string, unknown>
      tx_hash: string
    }>(await handlers().haven_resume_x402_payment({ resume_state: resumeState }))

    expect(result.data.payment_id).toBe('pay_approved')
    expect(result.data.payment_required).toBeDefined()
    expect(result.data.x402).toBeDefined()
    expect(result.data.tx_hash).toBe('0xfunded')
  })

  /**
   * #2041 (re-review NIT): the erc7710 disposition was an ARGUMENT in a comment
   * and nothing would have failed if a future change let an erc7710 intent
   * reach this handler. Pin the invariant instead of resting it on prose.
   *
   * The gate requires nextAction === 'retry_original_x402_request', which the
   * backend emits for exactly one state: 'executed', meaning the user completed
   * the FUNDING payment. A successful erc7710 settle instead leaves the intent
   * at 'submitted' (#1508) — the merchant redeems the chain afterwards. So this
   * models the real end state of an erc7710 payment and pins that resume
   * REFUSES it, rather than half-resuming a flow that has no funding leg to
   * retry. If someone later routes erc7710 into the resume lifecycle, this test
   * is what makes them confront the question.
   */
  it('#2041: refuses a SUBMITTED erc7710 intent — the resume lifecycle is the funding one', async () => {
    stubFetch({
      'GET /machine-payments/pay_7710_submitted/status': {
        status: 200,
        body: {
          payment_id: 'pay_7710_submitted',
          status: 'submitted',
          // NOT retry_original_x402_request: nothing was funded, so there is no
          // funding payment for the user to have completed.
          next_action: 'check_status_later',
          rail: 'x402',
          tx_hash: null,
          message: 'The payment was submitted and is waiting for confirmation.',
        },
      },
    })

    const result = await handlers().haven_resume_x402_payment({
      resume_state: {
        rail: 'x402' as const,
        paymentId: 'pay_7710_submitted',
        paymentRequired: PAYMENT_REQUIRED,
        accepted: PAYMENT_REQUIRED.accepts[0],
        url: 'https://merchant.test/paid',
        resourceUrl: 'https://merchant.test/paid',
        description: null,
        amountAtomic: '2500000',
        amount: '2.50',
        token: 'USDC',
        asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        network: 'base',
        chainId: 8453,
        merchantAddress: '0xMerchant',
      },
    })

    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    // The gate refuses with the payment-state 409 rather than handing back a
    // resume context. (The message is the backend's own — the handler prefers
    // it over its fallback string — so the invariant is asserted on the refusal
    // and its status, not on prose that a backend copy edit could change.)
    expect((result as unknown as Record<string, unknown>).statusCode).toBe(409)
    // And critically: no signing context for a scheme whose signing step has
    // already happened.
    expect((result as unknown as Record<string, unknown>).payload_hash).toBeUndefined()
    expect((result as unknown as Record<string, unknown>).x402).toBeUndefined()
  })

  it('rejects when no payment_id and no resume_state provided', async () => {
    stubFetch({})
    const result = await handlers().haven_resume_x402_payment({})
    expect(result.success).toBe(false)
    // HavenApiError uses code 'API_ERROR'
    expect((result as any).code).toBe('API_ERROR')
  })
})

/**
 * #1456 review: the code comment claims "a prefetch FAILURE deliberately
 * yields the 3009 path", and nothing pinned it. Mutating the rail test from
 * `=== 'delegation'` to `!== 'legacy'` — which makes an UNKNOWN rail
 * erc7710-eligible — passed all 151 tests. A guarantee stated in a comment and
 * checked by nothing is the failure mode this repo keeps naming.
 */
describe('null-holed payment_required (#1469)', () => {
  it('haven_pay_x402_quote survives a null accepts entry and still selects the valid one', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })
    const result = await handlers().haven_pay_x402_quote({
      payment_required: { ...PAYMENT_REQUIRED, accepts: [null, ...PAYMENT_REQUIRED.accepts] },
    })
    // Whatever else this stub run yields, it must NOT be the crash shape.
    expect(JSON.stringify(result)).not.toMatch(/Cannot read properties of null/)
  })

  it('an accepts of ONLY garbage entries refuses cleanly with the wrong-tool guidance', async () => {
    const result = await handlers().haven_pay_x402_quote({
      payment_required: { ...PAYMENT_REQUIRED, accepts: [null, 'garbage', 42] },
    })
    const text = JSON.stringify(result)
    expect(text).not.toMatch(/Cannot read properties/)
    expect(text).toMatch(/No compatible payment option|not a valid x402 PaymentRequired/)
  })
})

// ── generic plain-HTTP x402: settlement-scheme selection (#2041) ─────────────

describe('generic plain-HTTP x402: settlement-scheme selection (#2041)', () => {
  const FACILITATOR = '0x4444444444444444444444444444444444444444'
  /**
   * The load-bearing fixture: a plain-HTTP merchant that ADVERTISES erc7710.
   *
   * The two entries carry **deliberately different amounts**, and that is the
   * point of the fixture rather than incidental detail. #1453 made the two
   * option selectors mutually exclusive, so the cap is compared against one
   * accepts[] entry while the erc7710 branch authorizes the OTHER — and
   * nothing ties their amounts together. Building the erc7710 entry as a plain
   * spread of the standard one (which is what #1456's fixtures do) gives both
   * entries the same amount, which makes that entire failure mode invisible to
   * a green suite. See #2051.
   */
  const STANDARD_ATOMIC = '1500000' // 1.50 USDC — PAYMENT_REQUIRED's maxAmountRequired
  const ERC7710_ATOMIC = '2500000' // 2.50 USDC — what the erc7710 branch really authorizes
  const ERC7710_PAYMENT_REQUIRED = {
    ...PAYMENT_REQUIRED,
    accepts: [
      ...PAYMENT_REQUIRED.accepts,
      {
        ...PAYMENT_REQUIRED.accepts[0],
        amount: ERC7710_ATOMIC,
        maxAmountRequired: ERC7710_ATOMIC,
        extra: { assetTransferMethod: 'erc7710', facilitatorAddresses: [FACILITATOR] },
      },
    ],
  }
  /**
   * The MIRROR of the fixture above: an EXPENSIVE standard entry beside a CHEAP
   * erc7710 one. Same root cause, opposite direction — here a cap compared
   * against the unselected standard entry OVER-binds and refuses a purchase
   * that was never going to cost that much.
   */
  const EXPENSIVE_STANDARD_ATOMIC = '3000000' // 3.00 USDC — never authorized on the erc7710 branch
  const CHEAP_ERC7710_ATOMIC = '500000' // 0.50 USDC — what actually gets authorized
  const CHEAP_ERC7710_PAYMENT_REQUIRED = {
    ...PAYMENT_REQUIRED,
    accepts: [
      {
        ...PAYMENT_REQUIRED.accepts[0],
        amount: EXPENSIVE_STANDARD_ATOMIC,
        maxAmountRequired: EXPENSIVE_STANDARD_ATOMIC,
      },
      {
        ...PAYMENT_REQUIRED.accepts[0],
        amount: CHEAP_ERC7710_ATOMIC,
        maxAmountRequired: CHEAP_ERC7710_ATOMIC,
        extra: { assetTransferMethod: 'erc7710', facilitatorAddresses: [FACILITATOR] },
      },
    ],
  }

  /** A merchant advertising erc7710 and NOTHING else — no standard entry. */
  const ERC7710_ONLY_PAYMENT_REQUIRED = {
    ...PAYMENT_REQUIRED,
    accepts: [
      {
        ...PAYMENT_REQUIRED.accepts[0],
        amount: ERC7710_ATOMIC,
        maxAmountRequired: ERC7710_ATOMIC,
        extra: { assetTransferMethod: 'erc7710', facilitatorAddresses: [FACILITATOR] },
      },
    ],
  }
  const DELEGATION_AGENT = { ...AGENT_RESPONSE, execution_rail: 'delegation' }
  const LEGACY_AGENT = { ...AGENT_RESPONSE, execution_rail: 'legacy' }
  const CHILD = {
    payment_id: 'pay_generic_7710',
    status: 'pending_signature',
    sign_data: {
      hash: '0x' + '11'.repeat(32),
      signature_scheme: 'eip712_delegation',
      typed_data: { domain: {}, types: {}, primaryType: 'Delegation', message: { caveats: [] } },
    },
  }

  /**
   * The /x402 fixture is chosen by the EXPECTED scheme, not by the challenge —
   * a legacy account meeting a 7710-advertising merchant must still get the
   * 3009 intent back, which is the case a careless helper gets wrong.
   */
  async function rawQuotePay(
    paymentRequired: unknown,
    agent: Record<string, unknown>,
    expectErc7710 = false,
    extraArgs: Record<string, unknown> = {},
  ) {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: agent },
      'POST /x402': { status: 201, body: expectErc7710 ? CHILD : X402_INTENT_RESPONSE },
    })
    return handlers().haven_pay_x402_quote({ payment_required: paymentRequired, ...extraArgs })
  }

  async function quotePay(
    paymentRequired: unknown,
    agent: Record<string, unknown>,
    expectErc7710 = false,
    extraArgs: Record<string, unknown> = {},
  ) {
    return ok(await rawQuotePay(paymentRequired, agent, expectErc7710, extraArgs)) as {
      data: Record<string, any>
    }
  }

  function authorizeBody() {
    const raw = recordedCalls().find((c) => new URL(c.url).pathname === '/x402')!.body
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>
  }

  it('delegation rail + erc7710 merchant: selects erc7710 and shapes the request for DIRECT settlement', async () => {
    const res = await quotePay(ERC7710_PAYMENT_REQUIRED, DELEGATION_AGENT, true)

    expect(res.data.payment_id).toBe('pay_generic_7710')
    expect(res.data.settlement_scheme).toBe('erc7710')
    expect(res.data.settlement.scheme).toBe('erc7710')
    // The defining property of the preferred scheme is this ABSENCE.
    expect(res.data.settlement.funding_leg).toBe(false)
    expect(res.data.settlement.merchant_pay_to).toBe(PAYMENT_REQUIRED.accepts[0].payTo)
    expect(res.data.settlement.facilitator_addresses).toEqual([FACILITATOR])

    const body = authorizeBody()
    // payTo = the MERCHANT is what selects direct settlement server-side, and
    // the explicit scheme must AGREE with that shape (#1360).
    expect(body.payTo).toBe(PAYMENT_REQUIRED.accepts[0].payTo)
    expect(body.settlementScheme).toBe('erc7710')
    // No funding target, so no separate merchant field and no funding leg.
    expect(body).not.toHaveProperty('merchantPayTo')
    expect(body.facilitatorAddresses).toEqual([FACILITATOR])
    // The authorized amount is the ERC7710 entry's own, not the standard
    // entry's — stated here because everything about the cap depends on it.
    expect(body.amount).toBe(ERC7710_ATOMIC)
    expect(res.data.amount_atomic).toBe(ERC7710_ATOMIC)
  })

  it('POSITIVE CONTROL — a merchant that does NOT advertise erc7710 still takes the 3009 bridge', async () => {
    const res = await quotePay(PAYMENT_REQUIRED, DELEGATION_AGENT)

    expect(res.data.settlement_scheme).toBeUndefined()
    expect(res.data.settlement).toBeUndefined()
    const body = authorizeBody()
    // Byte-identical to the pre-#2041 generic path: fund the delegate EOA,
    // record the real merchant separately, and SAY 'eip3009' out loud (#1360).
    expect(body.settlementScheme).toBe('eip3009')
    expect(body.payTo).toBe('0xDelegate')
    expect(body.merchantPayTo).toBe(PAYMENT_REQUIRED.accepts[0].payTo)
  })

  it('a LEGACY-rail account never takes the branch, even when the merchant offers it', async () => {
    const res = await quotePay(ERC7710_PAYMENT_REQUIRED, LEGACY_AGENT)

    expect(res.data.settlement_scheme).toBeUndefined()
    expect(authorizeBody().settlementScheme).toBe('eip3009')
  })

  it('an agent record with NO execution_rail is not treated as delegation', async () => {
    // AGENT_RESPONSE carries no execution_rail at all. Guessing 'delegation'
    // here would build a request the backend refuses; the pre-#2041 behaviour
    // of this tool was 3009, and an unknown rail keeps it.
    const res = await quotePay(ERC7710_PAYMENT_REQUIRED, AGENT_RESPONSE)

    expect(res.data.settlement_scheme).toBeUndefined()
    expect(authorizeBody().settlementScheme).toBe('eip3009')
  })

  it('keeps the #1348 round-trip budget on BOTH branches: exactly ONE agent fetch', async () => {
    await quotePay(ERC7710_PAYMENT_REQUIRED, DELEGATION_AGENT, true)
    const onErc7710 = recordedCalls().filter((c) =>
      new URL(c.url).pathname.endsWith('/machine-payments/agent'),
    ).length
    clearCalls()
    await quotePay(PAYMENT_REQUIRED, DELEGATION_AGENT)
    const on3009 = recordedCalls().filter((c) =>
      new URL(c.url).pathname.endsWith('/machine-payments/agent'),
    ).length
    expect([onErc7710, on3009]).toEqual([1, 1])
  })

  it('points the agent at the erc7710 continuation, not the 3009 header-building one', async () => {
    const res = await quotePay(ERC7710_PAYMENT_REQUIRED, DELEGATION_AGENT, true)

    expect(res.data.next_action).toBe(AgentPaymentNextAction.SignAndSubmitPayment)
    expect(res.data.next_tool).toBe('mcp__haven-signer__haven_sign')
    expect(res.data.next_arguments).toEqual({ payment_id: 'pay_generic_7710' })
    // The agent must be told to say the scheme back on submit — the header is
    // assembled by Haven on this path, never by haven_x402_sign_header.
    expect(res.data.reason).toContain("settlement_scheme: 'erc7710'")
    expect(res.data.reason).toContain('Do NOT call haven_x402_sign_header')
    // #2330 added these two assertions, and #2341 INVERTS the second one.
    // #2330 was right that this reason tells the agent to retry the merchant
    // ITSELF and must therefore name the wire correctly; it was wrong about
    // what correct is on THIS scheme. erc7710 is always x402 v2 and its header
    // carries a delegation chain, so telling an agent to also send X-PAYMENT
    // is telling it to overflow the merchant's header limit — HTTP 431, the
    // funding-leg money already gone on the hosted path. The assertion that
    // pinned the fix now pins the defect, which is why it is reversed here in
    // place rather than deleted.
    //
    // The reason deliberately does not name the legacy header even to FORBID
    // it. A first pass wrote "do not add X-PAYMENT", which failed this very
    // assertion — `not.toContain` cannot tell an instruction from a
    // prohibition. Rewording to "ONLY that header name" keeps the guard
    // literal, costs fewer bytes against the #1591 mean, and avoids handing an
    // agent a negated header name to be primed by.
    expect(res.data.reason).toContain('PAYMENT-SIGNATURE')
    expect(res.data.reason).not.toContain('X-PAYMENT')
  })

  it('the optional-cap nudge still fires on the erc7710 branch', async () => {
    const res = await quotePay(ERC7710_PAYMENT_REQUIRED, DELEGATION_AGENT, true)
    expect(res.data.cap_warning).toBeTruthy()
  })

  /**
   * #2051 in miniature, fixed for THIS branch only.
   *
   * `payment_required` is merchant-controlled input. Because #1453 made the two
   * option selectors mutually exclusive, a cap compared against the standard
   * entry says nothing about the erc7710 entry the branch actually authorizes —
   * so a merchant could advertise a cheap standard price beside an expensive
   * erc7710 one and walk straight through a user-stated spending limit. That is
   * a bypass an attacker chooses to trigger, not a guard that merely fails to
   * fire, which is why it is proven in both directions here.
   */
  describe('the cap binds the option that is ACTUALLY authorized', () => {
    it('REFUSES when the erc7710 entry exceeds the cap, though the standard entry does not', async () => {
      // 2 USDC cap. Standard entry 1.50 (under), erc7710 entry 2.50 (over).
      // Pre-#2041-review this returned a signable child for 2.50 USDC.
      const payload = await rawQuotePay(
        ERC7710_PAYMENT_REQUIRED,
        DELEGATION_AGENT,
        true,
        { max_amount_human: '2' },
      )

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.code).toBe(AgentPaymentFailureCode.PriceExceedsMax)
      // The cap is PRE-network on this branch too: nothing was authorized.
      expect(recordedCalls().find((c) => new URL(c.url).pathname === '/x402')).toBeUndefined()
    })

    it('POSITIVE CONTROL — an IN-cap erc7710 payment still succeeds', async () => {
      // Same fixture, same branch, cap raised above the erc7710 entry. Proves
      // the fix refuses the right thing rather than refusing everything.
      const res = await quotePay(ERC7710_PAYMENT_REQUIRED, DELEGATION_AGENT, true, {
        max_amount_human: '3',
      })

      expect(res.data.settlement_scheme).toBe('erc7710')
      expect(authorizeBody().amount).toBe(ERC7710_ATOMIC)
    })

    it('the atomic spelling of the cap binds the erc7710 entry too', async () => {
      const payload = await rawQuotePay(ERC7710_PAYMENT_REQUIRED, DELEGATION_AGENT, true, {
        max_amount: STANDARD_ATOMIC, // exactly the standard entry's price
      })

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.code).toBe(AgentPaymentFailureCode.PriceExceedsMax)
    })

    it('does NOT over-bind: a cheap erc7710 entry is payable under a cap the standard entry exceeds', async () => {
      // The mirror defect, found by the re-review. Before the reordering the
      // pre-network check refused this outright with
      //   "Authorized amount 3000000 exceeds max_amount_human 1 USDC"
      // — a refusal citing an amount that was never going to be authorized. It
      // failed SAFE, which is exactly why it could ship unnoticed; it also hit
      // the recipient-pinned population this issue exists to unblock, since
      // they are the ones on the erc7710 branch.
      const res = await quotePay(CHEAP_ERC7710_PAYMENT_REQUIRED, DELEGATION_AGENT, true, {
        max_amount_human: '1',
      })

      expect(res.data.settlement_scheme).toBe('erc7710')
      expect(authorizeBody().amount).toBe(CHEAP_ERC7710_ATOMIC)
    })

    it('the atomic spelling does not over-bind either', async () => {
      const res = await quotePay(CHEAP_ERC7710_PAYMENT_REQUIRED, DELEGATION_AGENT, true, {
        max_amount: CHEAP_ERC7710_ATOMIC, // exactly the erc7710 price
      })

      expect(res.data.settlement_scheme).toBe('erc7710')
      expect(authorizeBody().amount).toBe(CHEAP_ERC7710_ATOMIC)
    })

    it('POSITIVE CONTROL — the same fixture on a LEGACY rail IS refused, because there the expensive entry is the authorized one', async () => {
      // The control that keeps the fix honest: "do not over-bind" must not
      // decay into "do not bind". Same payment_required, same cap; only the
      // rail differs, and with it which entry is authorized.
      const payload = await rawQuotePay(
        CHEAP_ERC7710_PAYMENT_REQUIRED,
        LEGACY_AGENT,
        false,
        { max_amount_human: '1' },
      )

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.code).toBe(AgentPaymentFailureCode.PriceExceedsMax)
      expect(recordedCalls().find((c) => new URL(c.url).pathname === '/x402')).toBeUndefined()
    })

    it('POSITIVE CONTROL — the 3009 branch keeps capping against the standard entry', async () => {
      // The same cap that refuses above must still ALLOW the bridge, because
      // there the standard entry IS the authorized one. A fix that simply
      // capped harder everywhere would break this.
      const res = await quotePay(PAYMENT_REQUIRED, LEGACY_AGENT, false, {
        max_amount_human: '2',
      })

      expect(res.data.payment_id).toBe('pay_x402')
      expect(authorizeBody().settlementScheme).toBe('eip3009')
    })
  })

  /**
   * A merchant advertising ONLY erc7710 is payable now, so a CAPPED call must
   * not be refused as "no payment option Haven can settle" while the same call
   * uncapped succeeds — stating a spending limit must never be the thing that
   * breaks a purchase.
   */
  describe('a merchant advertising ONLY erc7710', () => {
    it('is payable with a cap that covers it', async () => {
      const res = await quotePay(ERC7710_ONLY_PAYMENT_REQUIRED, DELEGATION_AGENT, true, {
        max_amount_human: '3',
      })

      expect(res.data.settlement_scheme).toBe('erc7710')
      expect(authorizeBody().amount).toBe(ERC7710_ATOMIC)
    })

    it('still REFUSES a cap it exceeds — the widened guard did not disable the cap', async () => {
      const payload = await rawQuotePay(
        ERC7710_ONLY_PAYMENT_REQUIRED,
        DELEGATION_AGENT,
        true,
        { max_amount_human: '1' },
      )

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.code).toBe(AgentPaymentFailureCode.PriceExceedsMax)
      expect(recordedCalls().find((c) => new URL(c.url).pathname === '/x402')).toBeUndefined()
    })

    it('is still refused on a LEGACY rail, which genuinely cannot settle it', async () => {
      const payload = await rawQuotePay(ERC7710_ONLY_PAYMENT_REQUIRED, LEGACY_AGENT, false, {
        max_amount_human: '3',
      })

      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.message).toContain('No compatible payment option')
    })
  })

  /**
   * The backend has supported replay dedup on this branch all along — the
   * lookup runs before the funding-shape branch and the erc7710 insert carries
   * `conflictTarget: 'x402_idempotency_key'`. It was never invoked, because the
   * SDK options bag had no way to say the key. A retried call therefore minted
   * a second INDEPENDENTLY SIGNABLE settlement child for one purchase, and on
   * this scheme the signed artifact is spend authority, not a funding step.
   */
  describe('idempotency on the erc7710 branch', () => {
    it('sends the caller idempotency_key on the authorize, so a retry can replay', async () => {
      await quotePay(ERC7710_PAYMENT_REQUIRED, DELEGATION_AGENT, true, {
        idempotency_key: 'x402:generic-7710:abc',
      })

      expect(authorizeBody().idempotencyKey).toBe('x402:generic-7710:abc')
    })

    it('sends the SAME key on a repeated call, which is what makes the replay one purchase', async () => {
      const seen: unknown[] = []
      for (let i = 0; i < 2; i++) {
        clearCalls()
        await quotePay(ERC7710_PAYMENT_REQUIRED, DELEGATION_AGENT, true, {
          idempotency_key: 'x402:generic-7710:abc',
        })
        seen.push(authorizeBody().idempotencyKey)
      }
      expect(seen).toEqual(['x402:generic-7710:abc', 'x402:generic-7710:abc'])
    })

    it('omits the field entirely when the caller gave no key, keeping the old request shape', async () => {
      await quotePay(ERC7710_PAYMENT_REQUIRED, DELEGATION_AGENT, true)
      expect(authorizeBody()).not.toHaveProperty('idempotencyKey')
    })
  })

  /**
   * A recipient-PINNED budget cannot fund the delegate EOA, so 3009-mode is
   * structurally impossible for it (owner decision 2026-07-15) and the backend
   * answers 403. Before #2041 that was the ONLY answer a pinned agent could get
   * from this tool — for EVERY merchant, including one advertising erc7710 —
   * because the generic path never asked for anything else.
   */
  describe('recipient-pinned budgets', () => {
    const PINNED_403 = {
      status: 403,
      body: {
        error:
          'Agent has no delegation able to fund EIP-3009 settlement for USDC. ' +
          '3009-mode needs an open (unpinned) budget delegation — merchant-pinned budgets settle via erc7710 only.',
      },
    }

    it('still refuses with the existing 403 at a 3009-only merchant', async () => {
      stubFetch({
        'GET /machine-payments/agent': { status: 200, body: DELEGATION_AGENT },
        'POST /x402': PINNED_403,
      })
      const payload = await handlers().haven_pay_x402_quote({
        payment_required: PAYMENT_REQUIRED,
      })
      expect(payload.success).toBe(false)
      if (payload.success) throw new Error('expected failure')
      expect(payload.message).toContain('erc7710 only')
      expect(authorizeBody().settlementScheme).toBe('eip3009')
    })

    it('reaches the scheme it CAN settle at an erc7710 merchant, instead of that 403', async () => {
      // The severity correction this issue understated: a pinned agent could
      // not pay ANY merchant through this tool, not merely pay them
      // sub-optimally.
      const res = await quotePay(ERC7710_PAYMENT_REQUIRED, DELEGATION_AGENT, true)
      expect(res.data.settlement_scheme).toBe('erc7710')
      expect(authorizeBody().settlementScheme).toBe('erc7710')
    })
  })
})

/**
 * #2550 — the next-step fields, pinned before and after adding a role.
 *
 * The defect: `next_tool` is a hardcoded literal naming the DEFAULT local
 * server (`mcp__haven-signer__haven_sign`), and `next_tool_server` is parsed
 * back out of that same literal. A connector run with `--name <slug>` wires
 * `haven-signer-<slug>` instead, so both fields name a server that is not the
 * one the user just set up — while the hosted instructions tell the agent to
 * follow those fields FIRST. Observed on dev 2026-09-04 with `--name devtest`.
 *
 * The fix is deliberately ADDITIVE: `next_tool_server_role` is added, and the
 * three existing fields are left byte-identical. The tests below are the two
 * halves of that decision, and the first half is the one that matters most —
 * an agent following `next_tool` on a default install must see exactly what it
 * saw before, or fixing a named-install bug would have broken every default
 * install to do it.
 */
describe('next-step fields (#2550)', () => {
  it('CHARACTERIZATION: the three existing fields are unchanged on the signer path', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    const result = ok<{
      next_tool: string
      next_tool_server: string
      next_tool_name: string
    }>(await handlers().haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED }))

    // Byte-identical to pre-#2550. Do NOT "fix" these to the named form: the
    // hosted server cannot know a client's slug, and changing them here would
    // break every default install to serve the named minority.
    expect(result.data.next_tool).toBe('mcp__haven-signer__haven_sign_x402')
    expect(result.data.next_tool_server).toBe('haven-signer')
    expect(result.data.next_tool_name).toBe('haven_sign_x402')
  })

  it('adds next_tool_server_role so a named install can resolve the signer', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
    })

    const result = ok<{ next_tool_server_role: string }>(
      await handlers().haven_pay_x402_quote({ payment_required: PAYMENT_REQUIRED }),
    )

    // The role is what a `--name devtest` client resolves against: it looks
    // for the signer among ITS OWN configured servers rather than trusting a
    // name minted by a server that cannot see its config.
    expect(result.data.next_tool_server_role).toBe('signer')
  })
})
