/**
 * #2809 — the state / direct-payment / recovery capability's own suite.
 *
 * These nine `describe` blocks moved VERBATIM out of the monolithic
 * `tools.test.ts`, against the SHARED fixture from `test-support/hosted-mcp.ts`
 * (#2808) rather than a clone of it. The selection rule was mechanical, not a
 * judgement call: a block moves iff every hosted handler it invokes belongs to
 * this capability's ten tools. That is why `custody invariant` stays in the
 * residual suite — it drives haven_pay/haven_send/haven_submit alongside
 * haven_pay_mcp_tool, haven_pay_x402_quote, haven_complete_mcp_tool and
 * haven_settle_mcp_tool, so it is an assertion about the COMPOSED surface, not
 * about this slice — and why the plain-HTTP settlement-scheme block (#2041)
 * stays too: it drives haven_pay_x402_quote, which is #2811's.
 *
 * Parity is measured on fully-qualified identities (`describe path > name`)
 * collected by vitest, not on bare names or a source grep: bare names collide
 * (13 of them repeat across blocks), and a grep over `it(` cannot see the two
 * `it.each` blocks the file expands into 13 further tests. The before/after
 * figures and both SHAs are in the pull request.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  AgentPaymentFailureCode,
  AgentPaymentNextAction,
} from '@haven_ai/sdk'
import {
  AGENT_ALLOWANCES_RESPONSE,
  AGENT_RESPONSE,
  DELEGATE_KEY,
  PAYMENT_REQUIRED,
  clearCalls,
  handlers,
  installSharedFixtureLifecycle,
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


// ── haven_pay ─────────────────────────────────────────────────────────────────

describe('haven_pay', () => {
  it('returns the unsigned payload hash for an in-budget payment', async () => {
    stubFetch({
      'POST /payments': {
        status: 201,
        body: {
          payment_id: 'pay_1',
          status: 'pending_signature',
          expires_at: '2099-01-01T00:00:00.000Z',
          sign_data: { hash: '0xdeadbeef' },
        },
      },
    })

    const result = ok<{ payload_hash: string; payment_id: string; status: string }>(
      await handlers().haven_pay({ token: 'USDC', amount: '12.50', to: '0xabc' }),
    )

    expect(result.data.payment_id).toBe('pay_1')
    expect(result.data.payload_hash).toBe('0xdeadbeef')
    expect(result.data.status).toBe('pending_signature')
  })

  it('forwards signature_scheme + typed_data VERBATIM for delegation-rail intents (#1254)', async () => {
    // Found live during the #908 mainnet canary: the x402 quote path always
    // forwarded these, this direct path dropped them — so the local signer
    // raw-signed the userOp hash and the Hybrid account rejected it (AA24).
    const typedData = {
      domain: { name: 'HybridDeleGator', chainId: 8453 },
      types: { PackedUserOperation: [{ name: 'sender', type: 'address' }] },
      primaryType: 'PackedUserOperation',
      message: { sender: '0xabc' },
    }
    stubFetch({
      'POST /payments': {
        status: 201,
        body: {
          payment_id: 'pay_delegation',
          status: 'pending_signature',
          expires_at: '2099-01-01T00:00:00.000Z',
          sign_data: {
            hash: '0xdeadbeef',
            signature_scheme: 'eip712_userop',
            typed_data: typedData,
          },
        },
      },
    })

    const result = ok<{ signature_scheme?: string; typed_data?: unknown; typed_data_b64?: string; payload_hash: string }>(
      await handlers().haven_pay({ token: 'USDC', amount: '0.10', to: '0xabc' }),
    )

    expect(result.data.signature_scheme).toBe('eip712_userop')
    expect(result.data.typed_data).toEqual(typedData) // verbatim, never reshaped
    // #1255: the copy-through-safe form decodes to exactly the same payload.
    expect(result.data.typed_data_b64).toBeDefined()
    expect(
      JSON.parse(Buffer.from(result.data.typed_data_b64 as string, 'base64').toString('utf8')),
    ).toEqual(typedData)
    expect(result.data.payload_hash).toBe('0xdeadbeef')
  })

  it('omits the delegation fields entirely on legacy-rail intents (#1254)', async () => {
    stubFetch({
      'POST /payments': {
        status: 201,
        body: {
          payment_id: 'pay_legacy',
          status: 'pending_signature',
          expires_at: '2099-01-01T00:00:00.000Z',
          sign_data: { hash: '0xdeadbeef' },
        },
      },
    })

    const result = ok<Record<string, unknown>>(
      await handlers().haven_pay({ token: 'USDC', amount: '0.10', to: '0xabc' }),
    )

    expect('signature_scheme' in result.data).toBe(false)
    expect('typed_data' in result.data).toBe(false)
    expect('typed_data_b64' in result.data).toBe(false)
  })

  it('surfaces pending_approval (no hash) when over budget', async () => {
    stubFetch({
      'POST /payments': {
        status: 202,
        body: {
          payment_id: 'pay_over',
          status: 'pending_approval',
          expires_at: '2099-01-01T00:00:00.000Z',
        },
      },
    })

    const result = ok<{ status: string; payload_hash: unknown }>(
      await handlers().haven_pay({ token: 'USDC', amount: '999999', to: '0xabc' }),
    )

    expect(result.data.status).toBe('pending_approval')
    expect(result.data.payload_hash).toBeNull()
  })

  it('never sends a delegate key in the construct request', async () => {
    stubFetch({
      'POST /payments': {
        status: 201,
        body: { payment_id: 'pay_1', status: 'pending_signature', sign_data: { hash: '0x1' } },
      },
    })

    await handlers().haven_pay({ token: 'USDC', amount: '1', to: '0xabc' })

    const payCall = recordedCalls().find((c) => c.url.endsWith('/payments'))
    expect(payCall?.body).toEqual({ token: 'USDC', amount: '1', to: '0xabc' })
    // Custody invariant: no field anywhere in the request carries key material.
    expect(JSON.stringify(recordedCalls())).not.toContain(DELEGATE_KEY)
    expect(JSON.stringify(recordedCalls())).not.toContain('delegate_key')
  })
})


// ── haven_submit ──────────────────────────────────────────────────────────────

describe('haven_submit', () => {
  it('relays ONLY { signature } and returns the tx hash', async () => {
    stubFetch({
      'POST /payments/pay_1/sign': {
        status: 200,
        body: { status: 'confirmed', tx_hash: '0xtx' },
      },
    })

    const sig = '0x' + '11'.repeat(65)
    const result = ok<{ status: string; tx_hash: string }>(
      await handlers().haven_submit({ payment_id: 'pay_1', signature: sig }),
    )

    expect(result.data.status).toBe('confirmed')
    expect(result.data.tx_hash).toBe('0xtx')

    const signCall = recordedCalls().find((c) => c.url.includes('/sign'))
    // The relay payload is exactly the signature — nothing else crosses the wire.
    expect(signCall?.body).toEqual({ signature: sig })
    expect(JSON.stringify(recordedCalls())).not.toContain(DELEGATE_KEY)
  })

  it('rejects a malformed signature before any network call', async () => {
    stubFetch({})
    const payload = await handlers().haven_submit({ payment_id: 'pay_1', signature: 'not-hex' })
    expect(payload.success).toBe(false)
    expect(recordedCalls()).toHaveLength(0)
  })
})


// ── haven_sweep_delegate (phase 1 mapping) ────────────────────────────────────

describe('haven_sweep_delegate prepare mapping', () => {
  it('maps a below-floor balance to below_minimum — never a dead-end signature_required (#700)', async () => {
    // Found live on the first prod sweep attempt: the handler only branched on
    // nothing_stranded, so a below-floor response fell through to
    // signature_required with authorization/expected_auth undefined — an
    // instruction to sign a payload that does not exist.
    stubFetch({
      'POST /machine-payments/sweep/prepare': {
        status: 200,
        body: {
          below_min: true,
          asset: 'USDC',
          amount: '0.002',
          amount_atomic: '2000',
          min_usdc: '1',
          chain_id: 8453,
          message: 'Stranded 0.002 USDC is below the sweep floor of 1 USDC',
        },
      },
    })

    const result = ok<Record<string, unknown>>(await handlers().haven_sweep_delegate({}))
    expect(result.data.status).toBe('below_minimum')
    expect(result.data.min_usdc).toBe('1')
    expect('authorization' in result.data).toBe(false)
    expect('sign_with' in result.data).toBe(false)
  })

  it('still returns the full signing payload when a sweep IS prepared', async () => {
    const authorization = {
      from: '0x' + 'aa'.repeat(20), to: '0x' + 'bb'.repeat(20), value: '2000000',
      validAfter: '0', validBefore: '9999999999', nonce: '0x' + 'cc'.repeat(32),
      token: '0x' + 'dd'.repeat(20), chainId: 8453,
    }
    stubFetch({
      'POST /machine-payments/sweep/prepare': {
        status: 201,
        body: {
          authorization,
          expected_auth: { version: 1, message: 'm', signature: '0x' + '11'.repeat(65), signer: '0x' + 'ee'.repeat(20) },
          asset: 'USDC', amount: '2.0', amount_atomic: '2000000', chain_id: 8453,
        },
      },
    })

    const result = ok<Record<string, unknown>>(await handlers().haven_sweep_delegate({}))
    expect(result.data.status).toBe('signature_required')
    expect(result.data.authorization).toEqual(authorization)
    expect(result.data.expected_auth).toBeDefined()
  })
})


// ── haven_get_agent (one-shot bootstrap) ──────────────────────────────────────

describe('haven_get_agent', () => {
  it('returns identity + readiness + live remaining allowance in one call', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 200, body: AGENT_ALLOWANCES_RESPONSE },
    })

    const result = ok<{
      id: string
      status: string
      readiness: string
      allowances: Array<Record<string, unknown>>
    }>(await handlers().haven_get_agent({}))

    expect(result.data.id).toBe('agt_1')
    expect(result.data.readiness).toBe('ready')
    expect(result.data.allowances[0]).toMatchObject({
      tokenSymbol: 'USDC',
      remainingAtomic: '7500',
      remainingDisplay: '0.0075 USDC',
    })
  })
})


// ── haven_list_receipts ───────────────────────────────────────────────────────

describe('haven_list_receipts', () => {
  it('calls the receipts endpoint and returns results', async () => {
    // listReceipts recordedCalls() /machine-payments/receipts
    stubFetch({
      'GET /machine-payments/receipts': {
        status: 200,
        body: { receipts: [{ id: 'rcpt_1', amount: '1.00', payment_id: 'pay_1', rail: 'x402' }] },
      },
    })

    const result = ok<unknown[]>(await handlers().haven_list_receipts({}))
    expect(Array.isArray(result.data)).toBe(true)
  })
})


// ── haven_get_resume_state ────────────────────────────────────────────────────

describe('haven_get_resume_state', () => {
  it('calls the resume state endpoint', async () => {
    // getResumeState recordedCalls() /payments/:id/resume_state
    stubFetch({
      'GET /payments/pay_1/resume_state': {
        status: 200,
        body: {
          rail: 'x402',
          paymentId: 'pay_1',
          payment_required: PAYMENT_REQUIRED,
        },
      },
    })

    const result = ok<{ rail: string }>(
      await handlers().haven_get_resume_state({ payment_id: 'pay_1' }),
    )
    expect(result.data.rail).toBe('x402')
  })
})


// ── haven_send ────────────────────────────────────────────────────────────────

describe('haven_send', () => {
  it('returns payload_hash for in-budget transfer', async () => {
    stubFetch({
      'POST /payments': {
        status: 201,
        body: {
          payment_id: 'pay_send_1',
          status: 'pending_signature',
          expires_at: '2099-01-01T00:00:00.000Z',
          sign_data: { hash: '0xsendhash' },
        },
      },
    })

    const result = ok<{ payment_id: string; payload_hash: string; asset: string; amount: string }>(
      await handlers().haven_send({ asset: 'USDC', recipient: '0xRecipient', amount: '5.00' }),
    )

    expect(result.data.payment_id).toBe('pay_send_1')
    expect(result.data.payload_hash).toBe('0xsendhash')
    expect(result.data.asset).toBe('USDC')
    expect(result.data.amount).toBe('5.00')

    const postCall = recordedCalls().find((c) => c.url.endsWith('/payments'))
    expect(postCall?.body).toEqual({ token: 'USDC', amount: '5.00', to: '0xRecipient' })
    // Custody invariant
    expect(JSON.stringify(recordedCalls())).not.toContain(DELEGATE_KEY)
  })

  it('forwards signature_scheme + typed_data VERBATIM for delegation-rail intents (#1254)', async () => {
    // haven_send was named in the live bug alongside haven_pay — reviewer
    // mutation showed the shared helper's use HERE was untested (dropping it
    // from only this handler passed the whole suite).
    const typedData = {
      domain: { name: 'HybridDeleGator', chainId: 8453 },
      types: { PackedUserOperation: [{ name: 'sender', type: 'address' }] },
      primaryType: 'PackedUserOperation',
      message: { sender: '0xRecipient' },
    }
    stubFetch({
      'POST /payments': {
        status: 201,
        body: {
          payment_id: 'pay_send_delegation',
          status: 'pending_signature',
          expires_at: '2099-01-01T00:00:00.000Z',
          sign_data: {
            hash: '0xsendhash',
            signature_scheme: 'eip712_userop',
            typed_data: typedData,
          },
        },
      },
    })

    const result = ok<{ signature_scheme?: string; typed_data?: unknown; typed_data_b64?: string; payload_hash: string }>(
      await handlers().haven_send({ asset: 'USDC', recipient: '0xRecipient', amount: '0.10' }),
    )

    expect(result.data.signature_scheme).toBe('eip712_userop')
    expect(result.data.typed_data).toEqual(typedData) // verbatim, never reshaped
    // #1255: the copy-through-safe form decodes to exactly the same payload.
    expect(
      JSON.parse(Buffer.from(result.data.typed_data_b64 as string, 'base64').toString('utf8')),
    ).toEqual(typedData)
    expect(result.data.payload_hash).toBe('0xsendhash')
  })

  it('omits the delegation fields entirely on legacy-rail intents (#1254)', async () => {
    stubFetch({
      'POST /payments': {
        status: 201,
        body: {
          payment_id: 'pay_send_legacy',
          status: 'pending_signature',
          expires_at: '2099-01-01T00:00:00.000Z',
          sign_data: { hash: '0xsendhash' },
        },
      },
    })

    const result = ok<Record<string, unknown>>(
      await handlers().haven_send({ asset: 'USDC', recipient: '0xRecipient', amount: '0.10' }),
    )

    expect('signature_scheme' in result.data).toBe(false)
    expect('typed_data' in result.data).toBe(false)
    expect('typed_data_b64' in result.data).toBe(false)
  })

  it('surfaces pending_approval when over allowance budget', async () => {
    stubFetch({
      'POST /payments': {
        status: 202,
        body: { payment_id: 'pay_over', status: 'pending_approval' },
      },
    })

    const result = ok<{ status: string; payload_hash: unknown }>(
      await handlers().haven_send({ asset: 'ETH', recipient: '0xRecipient', amount: '999' }),
    )

    expect(result.data.status).toBe('pending_approval')
    expect(result.data.payload_hash).toBeNull()
  })

  it('rejects unknown asset values', async () => {
    stubFetch({})
    const result = await handlers().haven_send({ asset: 'DAI', recipient: '0xRecipient', amount: '1' })
    expect(result.success).toBe(false)
    expect(recordedCalls()).toHaveLength(0)
  })
})


// ── haven_get_payment_status: post-purchase allowance summary (#1310) ─────────

describe('haven_get_payment_status: post-purchase allowance summary (#1310)', () => {
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

  function statusFixture(overrides: Record<string, unknown> = {}) {
    return {
      payment_id: 'pay_x402',
      kind: 'payment_intent',
      rail: 'x402',
      status: 'confirmed',
      phase: 'payment_confirmed',
      next_action: 'none',
      amount: '1.50',
      token: 'USDC',
      resource_url: 'http://merchant.test/mcp',
      merchant_address: '0xMerchant',
      tx_hash: '0xfund',
      expires_at: '2099-01-01T00:00:00.000Z',
      chain_id: 8453,
      message: 'The payment is confirmed.',
      asset: USDC,
      ...overrides,
    }
  }

  function allowancesFixture(remaining: string) {
    return {
      agent_id: 'agt_1',
      safe_address: '0xSafe',
      delegate_address: '0xDelegate',
      chain_id: 8453,
      allowances: [{
        id: 'allowance-1',
        token_address: USDC,
        token_symbol: 'USDC',
        configured_amount: '5000000',
        reset_period_min: 60,
        onchain: {
          amount: remaining, spent: '0', remaining, effective_spent: '0',
          reset_time_min: 60, last_reset_min: 100, nonce: 7, is_reset_pending: false,
        },
      }],
    }
  }

  it('attaches allowance for a genuinely settled x402 payment (rail: x402, phase: payment_confirmed)', async () => {
    stubFetch({
      'GET /machine-payments/pay_x402/status': { status: 200, body: statusFixture() },
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 200, body: allowancesFixture('3000000') },
    })

    const result = ok<{ allowance: { rail: string; remaining_atomic: string } | null }>(
      await handlers().haven_get_payment_status({ payment_id: 'pay_x402' }),
    )

    expect(result.data.allowance).toEqual(
      expect.objectContaining({ rail: 'legacy', remaining_atomic: '3000000' }),
    )
  })

  it('does NOT attach allowance for funded_but_unsettled — the merchant did not accept the retry', async () => {
    stubFetch({
      'GET /machine-payments/pay_x402/status': {
        status: 200,
        body: statusFixture({ status: 'funded_but_unsettled', phase: 'funded_but_unsettled' }),
      },
    })

    const result = ok<{ allowance?: unknown }>(
      await handlers().haven_get_payment_status({ payment_id: 'pay_x402' }),
    )

    expect('allowance' in result.data).toBe(false)
    // No allowance/agent reads were made for a non-settled status.
    expect(recordedCalls().find((c) => c.url.endsWith('/machine-payments/allowances'))).toBeUndefined()
  })

  it('does NOT attach allowance for a non-x402 rail', async () => {
    stubFetch({
      'GET /machine-payments/pay_direct/status': {
        status: 200,
        body: statusFixture({ payment_id: 'pay_direct', rail: 'direct' }),
      },
    })

    const result = ok<{ allowance?: unknown }>(
      await handlers().haven_get_payment_status({ payment_id: 'pay_direct' }),
    )

    expect('allowance' in result.data).toBe(false)
  })
})

describe('haven_submit — erc7710 settle (#2041)', () => {
  const SIG = '0x' + '44'.repeat(65)

  it('exchanges the signed child for the merchant header, with NO funding relay', async () => {
    stubFetch({
      'POST /x402/pay_generic_7710/settle': {
        status: 200,
        body: { payment_header: 'HEADER_FROM_HAVEN' },
      },
    })
    const res = ok(
      await handlers().haven_submit({
        payment_id: 'pay_generic_7710',
        signature: SIG,
        settlement_scheme: 'erc7710',
      }),
    ) as { data: Record<string, any> }

    expect(res.data.settlement_scheme).toBe('erc7710')
    expect(res.data.payment_header).toBe('HEADER_FROM_HAVEN')
    expect(res.data.funding_tx_hash).toBeNull()
    // erc7710 has no Haven-submitted transaction, so there is no hash to fake.
    expect(res.data.tx_hash).toBeNull()
    expect(res.data.next_action).toBe(AgentPaymentNextAction.RetryOriginalX402Request)
    // #2330 pinned both names here; #2341 reverses the legacy half for the
    // same reason as the erc7710 branch above — this is the erc7710 submit
    // path, where a duplicated header is refused with HTTP 431.
    expect(res.data.reason).toContain('PAYMENT-SIGNATURE')
    expect(res.data.reason).not.toContain('X-PAYMENT')

    // The signature went to settle, NOT to the funding relay.
    expect(recordedCalls().find((c) => c.url.includes('/settle'))?.body).toEqual({ signature: SIG })
    expect(recordedCalls().find((c) => c.url.includes('/sign'))).toBeUndefined()
  })

  it('POSITIVE CONTROL — omitting settlement_scheme still relays a FUNDING signature, unchanged', async () => {
    stubFetch({
      'POST /payments/pay_x402/sign': {
        status: 200,
        body: { status: 'confirmed', tx_hash: '0xfunding_tx' },
      },
    })
    const res = ok(
      await handlers().haven_submit({ payment_id: 'pay_x402', signature: SIG }),
    ) as { data: Record<string, any> }

    expect(res.data.status).toBe('confirmed')
    expect(res.data.tx_hash).toBe('0xfunding_tx')
    // The pre-#2041 shape exactly: no scheme marker, no header.
    expect(res.data.settlement_scheme).toBeUndefined()
    expect(res.data.payment_header).toBeUndefined()
    expect(recordedCalls().find((c) => c.url.includes('/settle'))).toBeUndefined()
    expect(recordedCalls().find((c) => c.url.includes('/sign'))).toBeDefined()
  })

  it('maps an EXPIRED settlement child to the structured window-expired refusal', async () => {
    // The child's window is the shortest in the system, so this is MORE likely
    // on this scheme than on the bridge — leaving it as a raw API error was the
    // wrong asymmetry.
    stubFetch({
      'POST /x402/pay_expired_child/settle': {
        status: 410,
        body: { error: 'Settlement child expired before it could be redeemed' },
      },
      'GET /machine-payments/pay_expired_child/status': {
        status: 200,
        body: {
          payment_id: 'pay_expired_child',
          kind: 'payment_intent',
          rail: 'x402',
          status: 'expired',
          phase: 'expired',
          next_action: 'request_again_if_user_still_wants_it',
          amount: '2.50',
          token: 'USDC',
          resource_url: 'http://merchant.test/paid',
          merchant_address: '0xMerchant',
          tx_hash: null,
          expires_at: '2000-01-01T00:00:00.000Z',
          chain_id: 8453,
          message: 'The payment expired before it was completed.',
          idempotency_key: 'idem-7710',
        },
      },
    })

    const payload = await handlers().haven_submit({
      payment_id: 'pay_expired_child',
      signature: SIG,
      settlement_scheme: 'erc7710',
    })

    if (payload.success) throw new Error('expected a failure payload')
    expect(payload.code).toBe(AgentPaymentFailureCode.PaymentWindowExpired)
    expect(payload.next_action).toBe(AgentPaymentNextAction.PaymentWindowExpired)
    expect(payload.idempotency_key).toBe('idem-7710')
    expect(payload.retry_with_new_quote).toBe(true)
  })

  it("an explicit 'eip3009' behaves identically to omitting it", async () => {
    stubFetch({
      'POST /payments/pay_x402/sign': {
        status: 200,
        body: { status: 'confirmed', tx_hash: '0xfunding_tx' },
      },
    })
    const res = ok(
      await handlers().haven_submit({
        payment_id: 'pay_x402',
        signature: SIG,
        settlement_scheme: 'eip3009',
      }),
    ) as { data: Record<string, any> }

    expect(res.data.status).toBe('confirmed')
    expect(res.data.settlement_scheme).toBeUndefined()
    expect(recordedCalls().find((c) => c.url.includes('/settle'))).toBeUndefined()
  })
})

/**
 * #2051 — the spending cap must bind the option that is ACTUALLY authorized.
 *
 * #1453 made `selectStandardPaymentOption` and `selectErc7710PaymentOption`
 * mutually exclusive by construction. The cap was asserted against the first
 * while `prepareX402Erc7710` independently re-selected and authorized the
 * second, and nothing tied their amounts together. `payment_required` is
 * MERCHANT-CONTROLLED, so that is not a guard that merely fails to bind — it
 * is one the merchant can STEER: advertise a cheap standard entry beside an
 * expensive erc7710 entry and the cap passes against the cheap one while the
 * expensive one is sent. Measured live at 900 USDC authorized against a
 * 1 USDC cap, with the response reporting 1 USDC.
 *
 * Two directions, both tested, because fixing only the dangerous one leaves
 * the mirror-image bug (proved live on #2052): an EXPENSIVE standard entry
 * beside a CHEAP erc7710 entry was wrongly REFUSED, citing an amount that was
 * never going to be authorized. Fail-safe, but it defeats the purpose of the
 * cap working. The rule is: check the cap ONCE, against whichever option the
 * scheme selector actually returned.
 *
 * The fixtures below give the two entries GENUINELY DIFFERENT amounts. The
 * #1456/#1547-era fixtures spread the standard entry into the erc7710 one, so
 * both carried the identical `1000000` — that construction is precisely why a
 * green suite could not see this.
 */
