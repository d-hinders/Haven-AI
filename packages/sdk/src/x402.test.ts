import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from './client.js'
import { HavenPaymentStateError } from './types.js'
import {
  buildX402IdempotencyKey,
  encodePaymentProof,
  parsePaymentRequired,
  parsePaymentRequiredResponse,
  selectPaymentOption,
  selectStandardPaymentOption,
  x402AuthorizationAmount,
} from './x402.js'
import type { X402PaymentRequired, X402PaymentOption } from './types.js'

const accepted: X402PaymentOption = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '20000',
  payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' },
}

// Standard-x402 fixture. Its URL is intentionally NOT `/mcp`: these tests
// exercise the plain x402 path and must not trip the MCP auto-handshake
// (issue #315). MCP-shaped endpoints are covered in their own describe block
// below with a `https://mcp.soundside.ai/mcp` fixture.
const paymentRequired: X402PaymentRequired = {
  x402Version: 2,
  error: 'Payment required',
  resource: {
    url: 'https://api.merchant.example/paid',
    description: 'create_image via luma - $0.02 USDC',
    mimeType: 'application/json',
  },
  accepts: [accepted],
}

const delegateAddress = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1'
const safeAddress = '0x135a9215604711AC70d970e12Caa812c53537EF4'

function decodeHeader(header: string): unknown {
  return JSON.parse(atob(header))
}

describe('x402 helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses base64 PAYMENT-REQUIRED headers synchronously', () => {
    const response = new Response(null, {
      status: 402,
      headers: {
        'PAYMENT-REQUIRED': btoa(JSON.stringify(paymentRequired)),
      },
    })

    expect(parsePaymentRequired(response)).toEqual(paymentRequired)
  })

  it('preserves Bazaar extensions from base64 PAYMENT-REQUIRED headers', () => {
    const bazaarPaymentRequired: X402PaymentRequired = {
      ...paymentRequired,
      extensions: { bazaar: { discovery: 'https://bazaar.example/published' } },
    }
    const response = new Response(null, {
      status: 402,
      headers: {
        'PAYMENT-REQUIRED': btoa(JSON.stringify(bazaarPaymentRequired)),
      },
    })

    expect(parsePaymentRequired(response)).toEqual(bazaarPaymentRequired)
  })

  it('parses Soundside-style JSON 402 bodies asynchronously', async () => {
    const response = new Response(JSON.stringify(paymentRequired), {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    })

    await expect(parsePaymentRequiredResponse(response)).resolves.toEqual(paymentRequired)
  })

  it('normalizes official x402 JSON bodies that keep resource fields on accepts', async () => {
    const officialBody = {
      x402Version: 1,
      accepts: [
        {
          scheme: 'exact',
          network: 'base',
          maxAmountRequired: accepted.amount,
          resource: paymentRequired.resource.url,
          description: paymentRequired.resource.description,
          mimeType: paymentRequired.resource.mimeType,
          payTo: accepted.payTo,
          maxTimeoutSeconds: accepted.maxTimeoutSeconds,
          asset: accepted.asset,
          extra: accepted.extra,
        },
      ],
      error: 'X-PAYMENT header is required',
    }
    const response = new Response(JSON.stringify(officialBody), {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    })

    await expect(parsePaymentRequiredResponse(response)).resolves.toMatchObject({
      x402Version: 1,
      resource: paymentRequired.resource,
      accepts: [
        {
          ...accepted,
          network: 'base',
          amount: accepted.amount,
          maxAmountRequired: accepted.amount,
          resource: paymentRequired.resource.url,
          description: paymentRequired.resource.description,
          mimeType: paymentRequired.resource.mimeType,
        },
      ],
    })
  })

  it('keeps the legacy Haven tx-hash proof encoder available', () => {
    const header = encodePaymentProof({
      txHash: '0xabc',
      paymentId: 'pay_123',
      token: 'USDC',
      amount: '0.02',
      to: accepted.payTo,
      resourceUrl: paymentRequired.resource.url,
      accepted,
      payer: '0x135a9215604711AC70d970e12Caa812c53537EF4',
      chainId: 8453,
    })

    expect(decodeHeader(header)).toEqual({
      x402Version: 2,
      resource: { url: paymentRequired.resource.url },
      accepted,
      payload: {
        type: 'haven_tx_hash',
        txHash: '0xabc',
        paymentId: 'pay_123',
        settledVia: 'haven',
        payer: '0x135a9215604711AC70d970e12Caa812c53537EF4',
        chainId: 8453,
      },
    })
  })

  it('quotes x402 payment requirements without creating a Haven payment', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(paymentRequired), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: 'https://haven.example',
    })

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'create_image' },
    })
    const quote = await haven.quoteX402(paymentRequired.resource.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }, { idempotencyKey: 'mcp-create-image' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe(paymentRequired.resource.url)
    expect(quote).toMatchObject({
      rail: 'x402',
      idempotencyKey: 'mcp-create-image',
      paymentRequired,
      accepted,
      resourceUrl: paymentRequired.resource.url,
      description: paymentRequired.resource.description,
      amountAtomic: accepted.amount,
      amount: '0.02',
      token: 'USDC',
      asset: accepted.asset,
      network: accepted.network,
      chainId: 8453,
      merchantAddress: accepted.payTo,
      request: {
        url: paymentRequired.resource.url,
        method: 'POST',
        body,
      },
    })

    const headers = new Headers(quote.request.headers)
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('x402-wallet')).toBe(delegateAddress)
  })

  it('quotes Bazaar MCP transport metadata for non-/mcp x402 endpoints', async () => {
    const bazaarPaymentRequired: X402PaymentRequired = {
      ...paymentRequired,
      extensions: { bazaar: { discovery: 'https://bazaar.example/published' } },
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(bazaarPaymentRequired), {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: 'https://haven.example',
    })

    const quote = await haven.quoteX402(paymentRequired.resource.url)

    expect(quote.mcpTransport).toEqual({ handshakeRequired: true, source: 'bazaar' })
    expect(quote.paymentRequired.extensions?.bazaar).toBeDefined()
  })

  it('attaches a serializable resume state when quote payment needs approval', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(paymentRequired), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'approval-123',
        kind: 'approval_request',
        rail: 'x402',
        status: 'pending_approval',
        phase: 'user_approval_required',
        next_action: 'wait_for_user_approval',
        message: 'This x402 funding payment is waiting for user approval in Haven. Do not start a new merchant session or create another payment; poll this payment id and resume the original x402 request after approval.',
        token: 'USDC',
        requested: '0.02',
        resource_url: paymentRequired.resource.url,
        merchant_address: accepted.payTo,
        chain_id: 8453,
        amount_atomic: accepted.amount,
        asset: accepted.asset,
        network: accepted.network,
        description: paymentRequired.resource.description,
        idempotency_key: 'mcp-create-image',
        expires_at: '2026-05-10T20:00:00.000Z',
      }), { status: 202 }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: 'https://haven.example',
    })

    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' })
    const quote = await haven.quoteX402(paymentRequired.resource.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }, { idempotencyKey: 'mcp-create-image' })

    let thrown: unknown
    try {
      await haven.payX402Quote(quote)
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(HavenPaymentStateError)
    expect(thrown).toMatchObject({
      paymentId: 'approval-123',
      resumeState: {
        rail: 'x402',
        paymentId: 'approval-123',
        idempotencyKey: 'mcp-create-image',
        paymentRequired,
        accepted,
        url: paymentRequired.resource.url,
        request: {
          url: paymentRequired.resource.url,
          method: 'POST',
          body,
        },
        amountAtomic: accepted.amount,
        merchantAddress: accepted.payTo,
      },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('funds the delegate wallet and retries paid fetches with a standard x402 header', async () => {
    const backendUrl = 'https://haven.example'
    const resourceUrl = paymentRequired.resource.url
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(paymentRequired), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'pay_123',
        status: 'pending_signature',
        chain_id: 8453,
        safe_address: safeAddress,
        token: 'USDC',
        amount: '0.02',
        to: delegateAddress,
        resource_url: resourceUrl,
        sign_data: {
          hash: `0x${'11'.repeat(32)}`,
          components: {
            safe: safeAddress,
            token: accepted.asset,
            to: delegateAddress,
            amount: accepted.amount,
            payment_token: '0x0000000000000000000000000000000000000000',
            payment: '0',
            nonce: 1,
          },
          instructions: 'Sign with delegate key',
        },
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'pay_123',
        status: 'confirmed',
        tx_hash: '0xabc',
        chain_id: 8453,
        token: 'USDC',
        amount: '0.02',
        to: delegateAddress,
        explorer_url: 'https://basescan.org/tx/0xabc',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'PAYMENT-RESPONSE': btoa(JSON.stringify({
            success: true,
            transaction: '0xabc',
            network: accepted.network,
          })),
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ evidence: { id: 'evidence-123' } }), { status: 202 }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: backendUrl,
      x402Wallet: safeAddress,
    })

    const response = await haven.fetch(resourceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(5)

    const fundingInit = fetchMock.mock.calls[1][1] as RequestInit
    expect(JSON.parse(fundingInit.body as string)).toMatchObject({
      url: resourceUrl,
      payTo: delegateAddress,
      merchantPayTo: accepted.payTo,
      amount: accepted.amount,
      asset: accepted.asset,
      network: accepted.network,
      idempotencyKey: expect.stringMatching(/^x402:[0-9a-f]{16}$/),
    })

    const retryInit = fetchMock.mock.calls[3][1] as RequestInit
    const retryHeaders = new Headers(retryInit.headers)
    const x402Header = retryHeaders.get('X-PAYMENT') ?? ''
    const payment = decodeHeader(x402Header)

    expect(retryHeaders.get('x402-wallet')).toBe(delegateAddress)
    expect(retryHeaders.has('PAYMENT-SIGNATURE')).toBe(false)
    expect(payment).toMatchObject({
      x402Version: 2,
      accepted,
      payload: {
        authorization: {
          from: delegateAddress,
          to: accepted.payTo,
          value: accepted.amount,
        },
      },
    })

    // ── PR #300 regression guard ──────────────────────────────────────
    //
    // The x402 v2 spec (and Soundside's facilitator) require the payment
    // payload to carry `accepted` as a top-level field that is an exact
    // copy of the chosen `accepts[i]` from the 402 response. See
    // Soundside Protocol Details item 5:
    //   https://github.com/soundside-design/soundside-docs/blob/main/guides/x402.md
    //
    // PR #300 (cc54083) dropped the `accepted` wrap on the assumption
    // that the spec required top-level `scheme`/`network` string fields
    // instead. That broke every compliant v2 facilitator including
    // Soundside, which rejected the header with `Field required: accepted`
    // and stranded the agent's USDC on the delegate EOA.
    //
    // These assertions are stricter than the `toMatchObject` above on
    // purpose: `toMatchObject` only checks that the listed keys are
    // present and match, so it cannot catch a regression where stray
    // top-level `scheme`/`network` keys leak in alongside `accepted`.
    // The strict key-set + exact-equality checks here would have failed
    // on PR #300's payload shape.
    expect((payment as { accepted: unknown }).accepted).toEqual(accepted)
    expect(Object.keys(payment as object).sort()).toEqual(
      ['accepted', 'payload', 'x402Version'].sort(),
    )
    expect(payment).not.toHaveProperty('scheme')
    expect(payment).not.toHaveProperty('network')

    expect(fetchMock.mock.calls[4][0]).toBe(`${backendUrl}/machine-payments/evidence`)
    const evidenceInit = fetchMock.mock.calls[4][1] as RequestInit
    expect(JSON.parse(evidenceInit.body as string)).toMatchObject({
      paymentId: 'pay_123',
      rail: 'x402',
      txHash: '0xabc',
      resourceUrl,
      merchantStatus: 200,
      selectedPayment: accepted,
      paymentProofHeaderName: 'X-PAYMENT',
      protocolReceiptHeaderName: 'PAYMENT-RESPONSE',
      protocolReceiptPayload: {
        success: true,
        transaction: '0xabc',
        network: accepted.network,
      },
    })
  })

  it('gets server-side x402 resume state by payment id', async () => {
    const resumeState = {
      rail: 'x402',
      paymentId: 'approval-123',
      idempotencyKey: 'x402:approval',
      paymentRequired,
      accepted,
      url: paymentRequired.resource.url,
      resourceUrl: paymentRequired.resource.url,
      description: paymentRequired.resource.description ?? null,
      amountAtomic: accepted.amount,
      amount: '0.02',
      token: 'USDC',
      asset: accepted.asset,
      network: accepted.network,
      chainId: 8453,
      merchantAddress: accepted.payTo,
    }
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(resumeState), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      baseUrl: 'https://haven.example',
    })

    await expect(haven.getResumeState('approval-123')).resolves.toEqual(resumeState)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://haven.example/payments/approval-123/resume_state')
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer sk_agent_test',
    })
  })

  it('records a reconciliation event when an x402 retry fails after funding', async () => {
    const backendUrl = 'https://haven.example'
    const resourceUrl = paymentRequired.resource.url
    const txHash = `0x${'ab'.repeat(32)}`
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(paymentRequired), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'pay_123',
        status: 'pending_signature',
        chain_id: 8453,
        safe_address: safeAddress,
        token: 'USDC',
        amount: '0.02',
        to: delegateAddress,
        resource_url: resourceUrl,
        sign_data: {
          hash: `0x${'11'.repeat(32)}`,
          components: {
            safe: safeAddress,
            token: accepted.asset,
            to: delegateAddress,
            amount: accepted.amount,
            payment_token: '0x0000000000000000000000000000000000000000',
            payment: '0',
            nonce: 1,
          },
          instructions: 'Sign with delegate key',
        },
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'pay_123',
        status: 'confirmed',
        tx_hash: txHash,
        chain_id: 8453,
        token: 'USDC',
        amount: '0.02',
        to: delegateAddress,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Missing session ID' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'X-Soundside-Trace': 'trace-789' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ event_id: 'event-123' }), { status: 202 }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: backendUrl,
    })

    await expect(haven.fetch(resourceUrl)).rejects.toMatchObject({
      statusCode: 400,
      body: expect.objectContaining({
        marker: 'x402_retry_rejected_after_funding',
        payment_id: 'pay_123',
        merchant_status: 400,
        merchant_body: JSON.stringify({ error: 'Missing session ID' }),
        merchant_headers: expect.objectContaining({ 'x-soundside-trace': 'trace-789' }),
      }),
    })

    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(fetchMock.mock.calls[4][0]).toBe(`${backendUrl}/machine-payments/reconciliation-events`)
    const reportInit = fetchMock.mock.calls[4][1] as RequestInit
    expect(JSON.parse(reportInit.body as string)).toMatchObject({
      paymentId: 'pay_123',
      rail: 'x402',
      eventType: 'merchant_retry_rejected_after_payment',
      txHash,
      details: {
        resource_url: resourceUrl,
        retry_status: 400,
        retry_body: JSON.stringify({ error: 'Missing session ID' }),
        merchant_to: accepted.payTo,
        delegate_to: delegateAddress,
      },
    })
  })

  const x402PreRetryResponses = (resourceUrl: string, txHash: string): Response[] => [
    new Response(JSON.stringify(paymentRequired), {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    }),
    new Response(JSON.stringify({
      payment_id: 'pay_123',
      status: 'pending_signature',
      chain_id: 8453,
      safe_address: safeAddress,
      token: 'USDC',
      amount: '0.02',
      to: delegateAddress,
      resource_url: resourceUrl,
      sign_data: {
        hash: `0x${'11'.repeat(32)}`,
        components: {
          safe: safeAddress,
          token: accepted.asset,
          to: delegateAddress,
          amount: accepted.amount,
          payment_token: '0x0000000000000000000000000000000000000000',
          payment: '0',
          nonce: 1,
        },
        instructions: 'Sign with delegate key',
      },
    }), { status: 201 }),
    new Response(JSON.stringify({
      payment_id: 'pay_123',
      status: 'confirmed',
      tx_hash: txHash,
      chain_id: 8453,
      token: 'USDC',
      amount: '0.02',
      to: delegateAddress,
    }), { status: 200 }),
  ]

  it.each([
    {
      label: '400 schema-style rejection',
      status: 400,
      statusText: 'Bad Request',
      body: JSON.stringify({ error: 'Field required: accepted' }),
    },
    {
      label: '402 signature/balance rejection',
      status: 402,
      statusText: 'Payment Required',
      body: JSON.stringify({ error: 'invalid_exact_evm_payload_authorization_valueInsufficient' }),
    },
    {
      label: '5xx server error',
      status: 503,
      statusText: 'Service Unavailable',
      body: 'upstream temporarily unavailable',
    },
  ])('captures the merchant response body for a $label retry failure', async ({ status, statusText, body }) => {
    const backendUrl = 'https://haven.example'
    const resourceUrl = paymentRequired.resource.url
    const txHash = `0x${'ab'.repeat(32)}`
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    for (const response of x402PreRetryResponses(resourceUrl, txHash)) {
      fetchMock.mockResolvedValueOnce(response)
    }
    fetchMock
      .mockResolvedValueOnce(new Response(body, {
        status,
        statusText,
        headers: { 'Content-Type': 'application/json', 'X-Merchant-Trace': 'trace-abc' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ event_id: 'event-123' }), { status: 202 }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: backendUrl,
    })

    await expect(haven.fetch(resourceUrl)).rejects.toMatchObject({
      statusCode: status,
      body: expect.objectContaining({
        marker: 'x402_retry_rejected_after_funding',
        payment_id: 'pay_123',
        merchant_status: status,
        merchant_status_text: statusText,
        merchant_body: body,
        merchant_headers: expect.objectContaining({ 'x-merchant-trace': 'trace-abc' }),
      }),
    })
  })

  it('does not leak the delegate key or agent API key into the captured merchant response', async () => {
    const backendUrl = 'https://haven.example'
    const resourceUrl = paymentRequired.resource.url
    const txHash = `0x${'ab'.repeat(32)}`
    const delegateKey = `0x${'01'.repeat(32)}`
    const apiKey = 'sk_agent_secret_value'
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    for (const response of x402PreRetryResponses(resourceUrl, txHash)) {
      fetchMock.mockResolvedValueOnce(response)
    }
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Missing session ID' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ event_id: 'event-123' }), { status: 202 }))

    const haven = new HavenClient({ apiKey, delegateKey, baseUrl: backendUrl })

    const error = await haven.fetch(resourceUrl).then(
      () => { throw new Error('expected merchant retry to reject') },
      (err: unknown) => err as { body: Record<string, unknown> },
    )

    const serialized = JSON.stringify(error.body)
    expect(serialized).not.toContain(apiKey)
    expect(serialized).not.toContain(delegateKey)
    expect(error.body.merchant_body).toBe(JSON.stringify({ error: 'Missing session ID' }))
  })

  it('does not fund the delegate wallet for unsupported Base assets', async () => {
    const unsupportedPaymentRequired: X402PaymentRequired = {
      ...paymentRequired,
      accepts: [{
        ...accepted,
        asset: '0x0000000000000000000000000000000000000001',
      }],
    }

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(unsupportedPaymentRequired), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: 'https://haven.example',
    })

    await expect(haven.fetch(paymentRequired.resource.url)).rejects.toThrow(
      'No compatible payment option found',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces x402 approval queues as structured payment state', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'approval-123',
        status: 'pending_approval',
        phase: 'user_approval_required',
        next_action: 'wait_for_user_approval',
        message: 'This x402 funding payment is waiting for user approval in Haven. Do not start a new merchant session or create another payment; poll this payment id and resume the original x402 request after approval.',
        token: 'USDC',
        requested: '0.02',
        remaining: '0.005',
        rail: 'x402',
        kind: 'approval_request',
        resource_url: paymentRequired.resource.url,
        merchant_address: accepted.payTo,
        chain_id: 8453,
        amount_atomic: accepted.amount,
        asset: accepted.asset,
        network: accepted.network,
        description: paymentRequired.resource.description,
        idempotency_key: 'soundside-joke',
        x402: {
          amount_atomic: accepted.amount,
          asset: accepted.asset,
          network: accepted.network,
          resource_url: paymentRequired.resource.url,
          merchant_address: accepted.payTo,
          description: paymentRequired.resource.description,
          idempotency_key: 'soundside-joke',
        },
        expires_at: '2026-05-10T20:00:00.000Z',
      }), { status: 202 }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: 'https://haven.example',
    })

    let thrown: unknown
    try {
      await haven.authorizeX402(paymentRequired)
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(HavenPaymentStateError)
    expect(thrown).toMatchObject({
      paymentId: 'approval-123',
      statusCode: 202,
      state: expect.objectContaining({
        paymentId: 'approval-123',
        status: 'pending_approval',
        phase: 'user_approval_required',
        nextAction: 'wait_for_user_approval',
        amount: '0.02',
        token: 'USDC',
        resourceUrl: paymentRequired.resource.url,
        merchantAddress: accepted.payTo,
        chainId: 8453,
        amountAtomic: accepted.amount,
        asset: accepted.asset,
        network: accepted.network,
        description: paymentRequired.resource.description,
        idempotencyKey: 'soundside-joke',
        x402: {
          amountAtomic: accepted.amount,
          asset: accepted.asset,
          network: accepted.network,
          resourceUrl: paymentRequired.resource.url,
          merchantAddress: accepted.payTo,
          description: paymentRequired.resource.description,
          idempotencyKey: 'soundside-joke',
        },
      }),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('resumes an approved x402 payment without creating a new authorization', async () => {
    const txHash = `0x${'ab'.repeat(32)}`
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'approval-123',
        kind: 'approval_request',
        rail: 'x402',
        status: 'executed',
        phase: 'funding_sent',
        next_action: 'retry_original_x402_request',
        amount: '0.02',
        token: 'USDC',
        resource_url: paymentRequired.resource.url,
        merchant_address: accepted.payTo,
        tx_hash: txHash,
        expires_at: '2026-05-10T20:00:00.000Z',
        chain_id: 8453,
        message: 'Retry the original x402 request.',
      }), { status: 200 }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: 'https://haven.example',
    })

    const receipt = await haven.resumeAuthorizedX402({
      paymentId: 'approval-123',
      paymentRequired,
      idempotencyKey: 'soundside-joke',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://haven.example/machine-payments/approval-123/status')
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/x402'))).toBe(false)

    expect(receipt).toMatchObject({
      success: true,
      paymentId: 'approval-123',
      txHash,
      token: 'USDC',
      amount: '0.02',
      merchantTo: accepted.payTo,
      haven: {
        paymentId: 'approval-123',
        fundingTxHash: txHash,
        fundingExplorerUrl: `https://basescan.org/tx/${txHash}`,
      },
      x402: {
        amount: accepted.amount,
        token: 'USDC',
        network: accepted.network,
        asset: accepted.asset,
        resource: paymentRequired.resource.url,
      },
    })
    expect(receipt.paymentHeader).toBeTruthy()

    const payment = decodeHeader(receipt.paymentHeader ?? '')
    expect(payment).toMatchObject({
      x402Version: 2,
      accepted,
      payload: {
        authorization: {
          from: delegateAddress,
          to: accepted.payTo,
          value: accepted.amount,
        },
      },
    })

    // PR #300 regression guard — see the longer note on the earlier
    // payX402Quote test for the spec reference (Soundside docs item 5).
    expect((payment as { accepted: unknown }).accepted).toEqual(accepted)
    expect(Object.keys(payment as object).sort()).toEqual(
      ['accepted', 'payload', 'x402Version'].sort(),
    )
    expect(payment).not.toHaveProperty('scheme')
    expect(payment).not.toHaveProperty('network')
  })

  it('retries the original x402 request from an approved payment id', async () => {
    const fundingTxHash = `0x${'ab'.repeat(32)}`
    const settlementTxHash = `0x${'cd'.repeat(32)}`
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'approval-123',
        kind: 'approval_request',
        rail: 'x402',
        status: 'executed',
        phase: 'funding_sent',
        next_action: 'retry_original_x402_request',
        amount: '0.02',
        token: 'USDC',
        resource_url: paymentRequired.resource.url,
        merchant_address: accepted.payTo,
        tx_hash: fundingTxHash,
        expires_at: '2026-05-10T20:00:00.000Z',
        chain_id: 8453,
        message: 'Retry the original x402 request.',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'PAYMENT-RESPONSE': btoa(JSON.stringify({
            success: true,
            transaction: settlementTxHash,
            network: accepted.network,
          })),
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ evidence: { id: 'evidence-123' } }), { status: 202 }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: 'https://haven.example',
    })

    const response = await haven.resumeX402Payment({
      paymentId: 'approval-123',
      url: paymentRequired.resource.url,
      paymentRequired,
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/x402'))).toBe(false)

    const retryInit = fetchMock.mock.calls[1][1] as RequestInit
    const retryHeaders = new Headers(retryInit.headers)
    expect(retryHeaders.get('X-PAYMENT')).toBeTruthy()

    const evidenceInit = fetchMock.mock.calls[2][1] as RequestInit
    expect(JSON.parse(evidenceInit.body as string)).toMatchObject({
      paymentId: 'approval-123',
      rail: 'x402',
      txHash: fundingTxHash,
      protocolReceiptPayload: {
        success: true,
        transaction: settlementTxHash,
        network: accepted.network,
      },
    })
  })

  it('resumes an approved x402 payment from a captured resume state', async () => {
    const fundingTxHash = `0x${'ab'.repeat(32)}`
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'approval-123',
        kind: 'approval_request',
        rail: 'x402',
        status: 'executed',
        phase: 'funding_sent',
        next_action: 'retry_original_x402_request',
        amount: '0.02',
        token: 'USDC',
        resource_url: paymentRequired.resource.url,
        merchant_address: accepted.payTo,
        tx_hash: fundingTxHash,
        expires_at: '2026-05-10T20:00:00.000Z',
        chain_id: 8453,
        message: 'Retry the original x402 request.',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ evidence: { id: 'evidence-123' } }), { status: 202 }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: 'https://haven.example',
    })

    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' })
    const response = await haven.resumeX402Payment({
      rail: 'x402',
      paymentId: 'approval-123',
      idempotencyKey: 'mcp-create-image',
      paymentRequired,
      accepted,
      url: paymentRequired.resource.url,
      request: {
        url: paymentRequired.resource.url,
        method: 'POST',
        headers: [['Content-Type', 'application/json'], ['mcp-session-id', 'session-123']],
        body,
      },
      resourceUrl: paymentRequired.resource.url,
      description: paymentRequired.resource.description ?? null,
      amountAtomic: accepted.amount,
      amount: '0.02',
      token: 'USDC',
      asset: accepted.asset,
      network: accepted.network,
      chainId: 8453,
      merchantAddress: accepted.payTo,
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[0][0]).toBe('https://haven.example/machine-payments/approval-123/status')

    const retryInit = fetchMock.mock.calls[1][1] as RequestInit
    const retryHeaders = new Headers(retryInit.headers)
    expect(fetchMock.mock.calls[1][0]).toBe(paymentRequired.resource.url)
    expect(retryInit.method).toBe('POST')
    expect(retryInit.body).toBe(body)
    expect(retryHeaders.get('mcp-session-id')).toBe('session-123')
    expect(retryHeaders.get('X-PAYMENT')).toBeTruthy()
  })

  it('rejects x402 resume attempts that do not match the approved amount', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'approval-123',
        kind: 'approval_request',
        rail: 'x402',
        status: 'executed',
        phase: 'funding_sent',
        next_action: 'retry_original_x402_request',
        amount: '0.03',
        token: 'USDC',
        resource_url: paymentRequired.resource.url,
        merchant_address: accepted.payTo,
        tx_hash: `0x${'ab'.repeat(32)}`,
        expires_at: '2026-05-10T20:00:00.000Z',
        chain_id: 8453,
        message: 'Retry the original x402 request.',
      }), { status: 200 }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: 'https://haven.example',
    })

    await expect(haven.resumeAuthorizedX402({
      paymentId: 'approval-123',
      paymentRequired,
    })).rejects.toMatchObject({
      statusCode: 409,
      message: 'x402 resume request does not match the approved amount.',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/x402'))).toBe(false)
  })

  it('returns structured state from the x402 agent tool', async () => {
    vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'approval-123',
        kind: 'approval_request',
        rail: 'x402',
        status: 'pending_approval',
        phase: 'user_approval_required',
        next_action: 'wait_for_user_approval',
        message: 'This x402 funding payment is waiting for user approval in Haven. Do not start a new merchant session or create another payment; poll this payment id and resume the original x402 request after approval.',
        token: 'USDC',
        requested: '0.02',
        remaining: '0.005',
        resource_url: paymentRequired.resource.url,
        merchant_address: accepted.payTo,
        chain_id: 8453,
        amount_atomic: accepted.amount,
        asset: accepted.asset,
        network: accepted.network,
        description: paymentRequired.resource.description,
        idempotency_key: 'soundside-joke',
        x402: {
          amount_atomic: accepted.amount,
          asset: accepted.asset,
          network: accepted.network,
          resource_url: paymentRequired.resource.url,
          merchant_address: accepted.payTo,
          description: paymentRequired.resource.description,
          idempotency_key: 'soundside-joke',
        },
        expires_at: '2026-05-10T20:00:00.000Z',
      }), { status: 202 }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: 'https://haven.example',
    })

    const result = await haven.executeTool('authorize_x402_payment', {
      url: paymentRequired.resource.url,
      payTo: accepted.payTo,
      amount: accepted.amount,
      asset: accepted.asset,
      network: accepted.network,
    })

    expect(result).toMatchObject({
      success: false,
      payment_id: 'approval-123',
      kind: 'approval_request',
      rail: 'x402',
      status: 'pending_approval',
      phase: 'user_approval_required',
      next_action: 'wait_for_user_approval',
      amount: '0.02',
      token: 'USDC',
      resource_url: paymentRequired.resource.url,
      merchant_address: accepted.payTo,
      chain_id: 8453,
      amount_atomic: accepted.amount,
      asset: accepted.asset,
      network: accepted.network,
      description: paymentRequired.resource.description,
      idempotency_key: 'soundside-joke',
      x402: {
        amount_atomic: accepted.amount,
        asset: accepted.asset,
        network: accepted.network,
        resource_url: paymentRequired.resource.url,
        merchant_address: accepted.payTo,
        description: paymentRequired.resource.description,
        idempotency_key: 'soundside-joke',
      },
      message: 'This x402 funding payment is waiting for user approval in Haven. Do not start a new merchant session or create another payment; poll this payment id and resume the original x402 request after approval.',
    })
  })

  it('returns a payment header from the x402 resume agent tool', async () => {
    vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'approval-123',
        kind: 'approval_request',
        rail: 'x402',
        status: 'executed',
        phase: 'funding_sent',
        next_action: 'retry_original_x402_request',
        amount: '0.02',
        token: 'USDC',
        resource_url: paymentRequired.resource.url,
        merchant_address: accepted.payTo,
        tx_hash: `0x${'ab'.repeat(32)}`,
        expires_at: '2026-05-10T20:00:00.000Z',
        chain_id: 8453,
        message: 'Retry the original x402 request.',
      }), { status: 200 }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: 'https://haven.example',
    })

    const result = await haven.executeTool('resume_x402_payment', {
      payment_id: 'approval-123',
      url: paymentRequired.resource.url,
      payTo: accepted.payTo,
      amount: accepted.amount,
      asset: accepted.asset,
      network: accepted.network,
      idempotencyKey: 'soundside-joke',
    })

    expect(result).toMatchObject({
      success: true,
      payment_id: 'approval-123',
      payment_header: expect.any(String),
      merchant_to: accepted.payTo,
      haven: {
        paymentId: 'approval-123',
      },
      x402: {
        amount: accepted.amount,
        network: accepted.network,
        resource: paymentRequired.resource.url,
      },
    })
  })

  it('checks status for approval request IDs', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'approval-123',
        kind: 'approval_request',
        rail: 'x402',
        status: 'executed',
        phase: 'funding_sent',
        next_action: 'retry_original_x402_request',
        amount: '0.02',
        token: 'USDC',
        resource_url: paymentRequired.resource.url,
        merchant_address: accepted.payTo,
        tx_hash: `0x${'ab'.repeat(32)}`,
        expires_at: '2026-05-10T20:00:00.000Z',
        chain_id: 8453,
        message: 'The user completed the funding payment. Retry the original x402 request.',
      }), { status: 200 }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: 'https://haven.example',
    })

    const result = await haven.executeTool('get_payment_status', {
      payment_id: 'approval-123',
    })

    expect(fetchMock.mock.calls[0][0]).toBe('https://haven.example/machine-payments/approval-123/status')
    expect(result).toMatchObject({
      payment_id: 'approval-123',
      status: 'executed',
      phase: 'funding_sent',
      next_action: 'retry_original_x402_request',
      resource_url: paymentRequired.resource.url,
    })
  })

  it('surfaces over-budget haven.fetch x402 flows as agent-actionable state', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(paymentRequired), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'approval-123',
        kind: 'approval_request',
        rail: 'x402',
        status: 'pending_approval',
        phase: 'user_approval_required',
        next_action: 'wait_for_user_approval',
        message: 'This x402 funding payment is waiting for user approval in Haven. Do not start a new merchant session or create another payment; poll this payment id and resume the original x402 request after approval.',
        token: 'USDC',
        requested: '0.02',
        resource_url: paymentRequired.resource.url,
        merchant_address: accepted.payTo,
        chain_id: 8453,
        amount_atomic: accepted.amount,
        asset: accepted.asset,
        network: accepted.network,
        description: paymentRequired.resource.description,
        expires_at: '2026-05-10T20:00:00.000Z',
      }), { status: 202 }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: 'https://haven.example',
    })

    await expect(haven.fetch(paymentRequired.resource.url)).rejects.toMatchObject({
      state: expect.objectContaining({
        paymentId: 'approval-123',
        nextAction: 'wait_for_user_approval',
        resourceUrl: paymentRequired.resource.url,
        merchantAddress: accepted.payTo,
        amountAtomic: accepted.amount,
        asset: accepted.asset,
        network: accepted.network,
      }),
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('surfaces expired x402 authorization replays as a 410 API error', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'pay_123',
        status: 'expired',
        token: 'USDC',
        amount: '0.02',
      }), { status: 200 }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: 'https://haven.example',
    })

    await expect(haven.authorizeX402(paymentRequired)).rejects.toMatchObject({
      statusCode: 410,
      body: expect.objectContaining({
        payment_id: 'pay_123',
        status: 'expired',
      }),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('builds deterministic x402 idempotency keys per 5-minute bucket', () => {
    const now = 1778440000000
    expect(buildX402IdempotencyKey(paymentRequired, accepted, now)).toBe(
      buildX402IdempotencyKey(paymentRequired, accepted, now + 60_000),
    )
    expect(buildX402IdempotencyKey(paymentRequired, accepted, now)).not.toBe(
      buildX402IdempotencyKey(paymentRequired, accepted, now + 300_000),
    )
  })

  it('uses maxAmountRequired as the EIP-3009 authorization amount when present', () => {
    const option = { ...accepted, amount: '10000', maxAmountRequired: '20000' }
    expect(x402AuthorizationAmount(option)).toBe('20000')
    expect(buildX402IdempotencyKey(paymentRequired, option, 1778440000000)).not.toBe(
      buildX402IdempotencyKey(paymentRequired, { ...option, maxAmountRequired: '30000' }, 1778440000000),
    )
  })

  it('rejects malformed x402 atomic authorization amounts before selection', () => {
    const malformedAmounts = [
      '0x4e20',
      '1e6',
      '+20000',
      '-1',
      ' 20000',
      '20000 ',
      '',
      '0',
    ]

    for (const amount of malformedAmounts) {
      const option = { ...accepted, amount }

      expect(selectPaymentOption([option])).toBeNull()
      expect(selectStandardPaymentOption([option])).toBeNull()
      expect(() => x402AuthorizationAmount(option)).toThrow(
        'Invalid x402 amount: must be a positive decimal atomic amount',
      )
    }

    expect(selectPaymentOption([
      { ...accepted, amount: '10000', maxAmountRequired: '0x4e20' },
    ])).toBeNull()
    expect(selectStandardPaymentOption([
      { ...accepted, amount: '10000', maxAmountRequired: '0x4e20' },
    ])).toBeNull()
  })

  // ── v1 x402 path coverage (#324) ────────────────────────────────────────
  //
  // `createStandardX402Header` re-wraps v2+ headers as
  // `{ x402Version, accepted, payload }` (the v2 spec shape, see PR #303's
  // regression guard above). v1 headers must pass through the x402 library's
  // output UNCHANGED — v1 facilitators reject the `accepted` wrap. These tests
  // pin that branch so a future refactor can't silently wrap v1 too.

  it('passes v1 payment headers through unchanged (no accepted wrap)', async () => {
    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: 'https://haven.example',
    })

    const v1PaymentRequired: X402PaymentRequired = {
      ...paymentRequired,
      x402Version: 1,
    }

    const header = await (haven as unknown as {
      createStandardX402Header(pr: X402PaymentRequired, option: X402PaymentOption): Promise<string>
    }).createStandardX402Header(v1PaymentRequired, accepted)

    const decoded = JSON.parse(atob(header)) as Record<string, unknown>

    // V1 shape: the raw library output — no top-level `accepted` key.
    expect(decoded).not.toHaveProperty('accepted')
    expect(decoded.x402Version).toBe(1)

    // The library's v1 envelope carries scheme/network at the top level and
    // the signed payload underneath. Pin the key set exactly so a future
    // change that adds or renames top-level keys fails loudly.
    expect(Object.keys(decoded).sort()).toEqual(['network', 'payload', 'scheme', 'x402Version'])
    expect(decoded.scheme).toBe('exact')
    expect(decoded.network).toBe('base')

    const payload = decoded.payload as { signature?: string; authorization?: Record<string, unknown> }
    expect(typeof payload.signature).toBe('string')
    expect(payload.authorization).toMatchObject({
      to: accepted.payTo,
      value: accepted.amount,
    })
  })

  it('still wraps v2 headers with accepted — the v1/v2 split is on x402Version', async () => {
    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: 'https://haven.example',
    })

    const header = await (haven as unknown as {
      createStandardX402Header(pr: X402PaymentRequired, option: X402PaymentOption): Promise<string>
    }).createStandardX402Header(paymentRequired, accepted)

    const decoded = JSON.parse(atob(header)) as Record<string, unknown>
    expect(Object.keys(decoded).sort()).toEqual(['accepted', 'payload', 'x402Version'])
    expect(decoded.x402Version).toBe(2)
    expect(decoded.accepted).toEqual(accepted)
  })
})
