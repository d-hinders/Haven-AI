import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from './client.js'
import { HavenPaymentStateError } from './types.js'
import {
  buildX402IdempotencyKey,
  encodePaymentProof,
  parsePaymentRequired,
  parsePaymentRequiredResponse,
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

const paymentRequired: X402PaymentRequired = {
  x402Version: 2,
  error: 'Payment required',
  resource: {
    url: 'https://mcp.soundside.ai/mcp',
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

  it('records a reconciliation event when an x402 retry is rejected after funding', async () => {
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Payment rejected' }), { status: 402 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ event_id: 'event-123' }), { status: 202 }))

    const haven = new HavenClient({
      apiKey: 'sk_agent_test',
      delegateKey: `0x${'01'.repeat(32)}`,
      baseUrl: backendUrl,
    })

    await expect(haven.fetch(resourceUrl)).rejects.toMatchObject({
      statusCode: 402,
      body: expect.objectContaining({
        marker: 'x402_retry_rejected_after_funding',
        payment_id: 'pay_123',
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
        retry_status: 402,
        retry_body: JSON.stringify({ error: 'Payment rejected' }),
        merchant_to: accepted.payTo,
        delegate_to: delegateAddress,
      },
    })
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
})
