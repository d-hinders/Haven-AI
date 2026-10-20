import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from './client.js'
import { MCP_X402_PAYMENT_RESPONSE_META_KEY } from './mcp-merchant-transport.js'
import { buildFundingLegSignData } from './__fixtures__/valid-userop.js'
import type { X402PaymentOption } from './types.js'

// #4120 — characterization for the ONE post-funding merchant-answer decision.
//
// The SDK makes the accepted/rejected-after-funding decision twice: the HOSTED
// `HavenClient.completeX402MerchantCall` (client.ts) and the LOCAL
// `MerchantCompletion.retryRequest` (merchant-completion.ts, reached through
// `fetch` / `payX402Quote` / `resumeX402Payment`). This file drives BOTH paths
// through the same merchant answers and pins today's values, including the two
// measured divergences:
//
//   D1 — the hash rule. The hosted copy takes the header's transaction when a
//   `PAYMENT-RESPONSE` header is present (even when it carries none); the
//   local copy falls back to the `_meta` settlement's transaction. A header
//   WITHOUT a transaction beside a `_meta` settlement WITH one is therefore
//   `MERCHANT_REJECTED_AFTER_FUNDING` on the hosted path and an acceptance on
//   the local path, today.
//
//   D2 — when the tool result is read. The local path reads it only from an
//   `ok` answer whose content type is JSON or SSE; the hosted path
//   `JSON.parse`s any body. A 200 `text/plain` answer carrying an
//   `isError: true` tool result is rejected on hosted, accepted on local.
//
// Owner decision 2026-10-20 (issue #4120): D1 resolves to the LOCAL rule on
// both paths — the HOSTED D1 cases below are the one intended flip when the
// shared decision lands; every local case, the D2 cases and the precedence
// case must survive the extraction unedited. D2 was not decided and stays per
// caller.

// ── fixtures ──────────────────────────────────────────────────────────────

// #3271: a real, self-consistent PackedUserOperation — the binding check
// recomputes its hash and refuses a hand-rolled 3-field toy.
const userOpSignData = buildFundingLegSignData({ asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '20000' })
const userOpTypedData = userOpSignData.typed_data

const accepted: X402PaymentOption = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '20000',
  payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' },
}

const delegateKey = `0x${'01'.repeat(32)}`
const delegateAddress = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1'
const safeAddress = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const backendUrl = 'https://haven.example'
const fundingTxHash = `0x${'ab'.repeat(32)}`

/** Well-formed, pairwise-different settlement hashes for the D1/precedence cases. */
const headerTx = `0x${'aa'.repeat(32)}`
const metaTx = `0x${'bb'.repeat(32)}`
const otherTx = `0x${'cc'.repeat(32)}`

const paidToolUrl = 'https://api.merchant.example/paid-tool'
const localPaidUrl = 'https://api.merchant.example/paid-data'

/** A real base64-JSON x402 v2 payment envelope, as the funding leg mints it. */
const paymentEnvelope = {
  x402Version: 2,
  resource: { url: paidToolUrl },
  accepted,
  payload: { signature: `0x${'55'.repeat(65)}`, authorization: { from: delegateAddress, to: accepted.payTo, value: accepted.amount } },
}
const paymentHeader = btoa(JSON.stringify(paymentEnvelope))

function paymentRequiredFor(url: string): Record<string, unknown> {
  return {
    x402Version: 2,
    error: 'Payment required',
    resource: { url, description: 'paid tool - $0.02 USDC', mimeType: 'application/json' },
    accepts: [accepted],
  }
}

/** A profile challenge: `isError: true` with a valid PaymentRequired beside it. */
function nativeChallenge(url: string): Record<string, unknown> {
  const required = paymentRequiredFor(url)
  return {
    isError: true,
    structuredContent: required,
    content: [{ type: 'text', text: JSON.stringify(required) }],
  }
}

/** The `_meta["x402/payment-response"]` settlement object the profile merchants send. */
const metaSettlement = { success: true, transaction: metaTx }

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers })
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result }
}

function newClient(): HavenClient {
  return new HavenClient({ apiKey: '«reda...…»', delegateKey, baseUrl: backendUrl })
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>
}

/**
 * Route by URL rather than by call order, so an extra best-effort call
 * (receipt capture, notification) never shifts the fixture.
 */
type Route = (url: string, init: RequestInit | undefined, method: string | undefined) => Response | undefined
function mockFetch(route: Route) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    let method: string | undefined
    try {
      method = (JSON.parse(init?.body as string) as { method?: string }).method
    } catch {
      method = undefined
    }
    const response = route(url, init, method)
    if (response) return response
    if (url === `${backendUrl}/machine-payments/agent`) {
      return json({ id: 'agt_1', name: 'Hosted Agent', status: 'active', account_address: safeAddress, delegate_address: delegateAddress, chain_id: 8453 })
    }
    if (url.startsWith(backendUrl)) return json({ accepted: true }, { status: 202 })
    throw new Error(`unrouted fetch: ${url} ${method ?? ''}`)
  })
}

function backendCalls(fetchMock: ReturnType<typeof mockFetch>, suffix: string): unknown[][] {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix))
}

function evidenceTxHashes(fetchMock: ReturnType<typeof mockFetch>): unknown[] {
  return backendCalls(fetchMock, '/machine-payments/evidence').map((c) => bodyOf(c).txHash)
}

function paymentStatusReady(resourceUrl: string): Response {
  return json({
    payment_id: 'pay_123',
    kind: 'payment_intent',
    rail: 'x402',
    status: 'confirmed',
    phase: 'payment_confirmed',
    next_action: 'none',
    amount: '0.02',
    token: 'USDC',
    resource_url: resourceUrl,
    merchant_address: accepted.payTo,
    tx_hash: fundingTxHash,
    expires_at: '2099-01-01T00:00:00.000Z',
    chain_id: 8453,
    message: 'Retry the original x402 request.',
  })
}

/** #1508: an erc7710 payment has no funding leg — `submitted` is its final state. */
function erc7710Submitted(resourceUrl: string): Response {
  return json({
    payment_id: 'pay_123',
    kind: 'payment_intent',
    rail: 'x402',
    status: 'submitted',
    phase: 'payment_submitted',
    next_action: 'none',
    amount: '0.02',
    token: 'USDC',
    resource_url: resourceUrl,
    merchant_address: accepted.payTo,
    tx_hash: null,
    expires_at: '2099-01-01T00:00:00.000Z',
    chain_id: 8453,
    message: 'submitted',
  })
}

function fundingPendingSignature(resourceUrl: string): Response {
  return json({
    payment_id: 'pay_123',
    status: 'pending_signature',
    chain_id: 8453,
    account_address: safeAddress,
    token: 'USDC',
    amount: '0.02',
    to: delegateAddress,
    resource_url: resourceUrl,
    sign_data: {
      hash: userOpSignData.hash,
      signature_scheme: 'eip712_userop',
      typed_data: userOpTypedData,
      components: {
        payer_account: safeAddress,
        token: accepted.asset,
        to: delegateAddress,
        amount: accepted.amount,
        payment_token: '0x0000000000000000000000000000000000000000',
        payment: '0',
        nonce: 1,
      },
      instructions: 'Sign with delegate key',
    },
  }, { status: 201 })
}

function fundingConfirmed(): Response {
  return json({
    payment_id: 'pay_123',
    status: 'confirmed',
    tx_hash: '0xabc',
    chain_id: 8453,
    token: 'USDC',
    amount: '0.02',
    to: delegateAddress,
    explorer_url: 'https://basescan.org/tx/0xabc',
  })
}

/**
 * Local harness: the full `fetch()` flow — 402 challenge, funding leg
 * (`pending_signature` → `confirmed`), then `MerchantCompletion.retryRequest`
 * with the payment header. The paid answer is keyed on the payment header the
 * retry carries.
 */
function localPaidRoutes(paidResult: () => Response) {
  return mockFetch((url, init) => {
    if (url === `${backendUrl}/x402`) return fundingPendingSignature(localPaidUrl)
    if (url === `${backendUrl}/payments/pay_123/sign`) return fundingConfirmed()
    if (url !== localPaidUrl) return undefined
    const headers = new Headers(init?.headers)
    if (headers.get('PAYMENT-SIGNATURE') || headers.get('X-PAYMENT')) return paidResult()
    return json(paymentRequiredFor(localPaidUrl), { status: 402 })
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ── hosted: completeX402MerchantCall ──────────────────────────────────────

describe('#4120 characterization — hosted completeX402MerchantCall', () => {
  const merchantInit: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'paid_tool', arguments: { q: 'x' } } }),
  }
  const hosted = (paidResult: () => Response, opts: { noFundingLeg?: boolean } = {}) => {
    const fetchMock = mockFetch((url) => {
      if (url === `${backendUrl}/machine-payments/pay_123/status`) {
        return opts.noFundingLeg ? erc7710Submitted(paidToolUrl) : paymentStatusReady(paidToolUrl)
      }
      if (url !== paidToolUrl) return undefined
      return paidResult()
    })
    return {
      fetchMock,
      result: newClient().completeX402MerchantCall({
        url: paidToolUrl,
        init: merchantInit,
        paymentId: 'pay_123',
        paymentHeader,
        ...(opts.noFundingLeg ? { noFundingLeg: true } : {}),
      }),
    }
  }

  it('accepted with a PAYMENT-RESPONSE header: the header transaction is the settlement hash', async () => {
    const { fetchMock, result } = hosted(() =>
      json(rpcResult(2, { content: [{ type: 'text', text: 'a joke' }] }), { headers: { 'PAYMENT-RESPONSE': btoa(JSON.stringify({ transaction: headerTx })) } }),
    )
    const res = await result
    expect(res.ok).toBe(true)
    expect(res.settlementTxHash).toBe(headerTx)
    // Funding report + the #3764 second report on the header's transaction.
    expect(evidenceTxHashes(fetchMock)).toEqual([fundingTxHash, headerTx])
    expect(bodyOf(backendCalls(fetchMock, '/machine-payments/evidence')[0])).toMatchObject({ protocolReceiptHeaderName: 'PAYMENT-RESPONSE' })
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(0)
  })

  it('accepted via _meta["x402/payment-response"] when there is no header', async () => {
    const { fetchMock, result } = hosted(() => json(rpcResult(2, { content: [{ type: 'text', text: 'paid answer' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: metaSettlement } })))
    const res = await result
    expect(res.ok).toBe(true)
    expect(res.settlementTxHash).toBe(metaTx)
    expect(evidenceTxHashes(fetchMock)).toEqual([fundingTxHash, metaTx])
    expect(bodyOf(backendCalls(fetchMock, '/machine-payments/evidence')[0])).toMatchObject({
      protocolReceiptHeaderName: `_meta.${MCP_X402_PAYMENT_RESPONSE_META_KEY}`,
    })
  })

  it('an in-band payment-required tool result is a rejection after funding', async () => {
    const { fetchMock, result } = hosted(() => json(rpcResult(2, nativeChallenge(paidToolUrl))))
    const res = await result
    expect(res.ok).toBe(false)
    expect(res.settlementTxHash).toBeUndefined()
    expect(backendCalls(fetchMock, '/machine-payments/evidence')).toHaveLength(0)
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(1)
  })

  it('a _meta settlement with success:false is a rejection', async () => {
    const { fetchMock, result } = hosted(() =>
      json(rpcResult(2, { content: [{ type: 'text', text: 'not delivered' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: { success: false, errorReason: 'settlement failed' } } })),
    )
    const res = await result
    expect(res.ok).toBe(false)
    expect(res.settlementTxHash).toBeUndefined()
    expect(backendCalls(fetchMock, '/machine-payments/evidence')).toHaveLength(0)
  })

  it('a plain isError tool result with no receipt (#4062) is a rejection after funding', async () => {
    const { fetchMock, result } = hosted(() =>
      json(rpcResult(2, { isError: true, content: [{ type: 'text', text: "Text generation failed : 'NoneType' object has no attribute 'parts'" }] })),
    )
    const res = await result
    expect(res.ok).toBe(false)
    expect(res.settlementTxHash).toBeUndefined()
    expect(backendCalls(fetchMock, '/machine-payments/evidence')).toHaveLength(0)
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(1)
  })

  it('a tool error beside a settlement hash is delivered — the money moved', async () => {
    const { fetchMock, result } = hosted(() =>
      json(rpcResult(2, { isError: true, content: [{ type: 'text', text: 'partial' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: { success: true, transaction: otherTx } } })),
    )
    const res = await result
    expect(res.ok).toBe(true)
    expect(res.settlementTxHash).toBe(otherTx)
    expect(evidenceTxHashes(fetchMock)).toEqual([fundingTxHash, otherTx])
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(0)
  })

  it('a non-2xx answer is a rejection with no settlement hash', async () => {
    const { fetchMock, result } = hosted(() => json({ error: 'nope' }, { status: 500 }))
    const res = await result
    expect(res.ok).toBe(false)
    expect(res.settlementTxHash).toBeUndefined()
    expect(backendCalls(fetchMock, '/machine-payments/evidence')).toHaveLength(0)
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(1)
  })

  // ── D1: a header WITHOUT a transaction beside a _meta settlement WITH one ──

  it('D1, with isError: a transaction-less header beside a _meta settlement is ACCEPTED — the money moved (owner decision 1)', async () => {
    const { fetchMock, result } = hosted(() =>
      json(rpcResult(2, { isError: true, content: [{ type: 'text', text: 'partial' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: metaSettlement } }), { headers: { 'PAYMENT-RESPONSE': btoa(JSON.stringify({})) } }),
    )
    const res = await result
    expect(res.ok).toBe(true)
    expect(res.settlementTxHash).toBe(metaTx)
    expect(evidenceTxHashes(fetchMock)).toEqual([fundingTxHash, metaTx])
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(0)
  })

  it('D1, without isError: the _meta transaction is the settlement hash and the second report is posted (owner decision 1)', async () => {
    const { fetchMock, result } = hosted(() =>
      json(rpcResult(2, { content: [{ type: 'text', text: 'paid answer' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: metaSettlement } }), { headers: { 'PAYMENT-RESPONSE': btoa(JSON.stringify({})) } }),
    )
    const res = await result
    expect(res.ok).toBe(true)
    expect(res.settlementTxHash).toBe(metaTx)
    // Funding report + the #3764 second report on the _meta transaction.
    expect(evidenceTxHashes(fetchMock)).toEqual([fundingTxHash, metaTx])
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(0)
  })

  it('D1, empty header with isError: accepted on the _meta transaction (owner decision 1)', async () => {
    const { fetchMock, result } = hosted(() =>
      json(rpcResult(2, { isError: true, content: [{ type: 'text', text: 'partial' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: metaSettlement } }), { headers: { 'PAYMENT-RESPONSE': '' } }),
    )
    const res = await result
    expect(res.ok).toBe(true)
    expect(res.settlementTxHash).toBe(metaTx)
    expect(evidenceTxHashes(fetchMock)).toEqual([fundingTxHash, metaTx])
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(0)
  })

  it('D1, empty header without isError: the _meta transaction is the settlement hash (owner decision 1)', async () => {
    const { fetchMock, result } = hosted(() =>
      json(rpcResult(2, { content: [{ type: 'text', text: 'paid answer' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: metaSettlement } }), { headers: { 'PAYMENT-RESPONSE': '' } }),
    )
    const res = await result
    expect(res.ok).toBe(true)
    expect(res.settlementTxHash).toBe(metaTx)
    // The empty header is falsy: the receipt name falls to the _meta form while
    // the raw header value rides the report as-is.
    const funding = bodyOf(backendCalls(fetchMock, '/machine-payments/evidence')[0])
    expect(funding.protocolReceiptHeaderName).toBe(`_meta.${MCP_X402_PAYMENT_RESPONSE_META_KEY}`)
    expect(funding.protocolReceiptHeader).toBe('')
    expect(evidenceTxHashes(fetchMock)).toEqual([fundingTxHash, metaTx])
  })

  it('D1, erc7710 (noFundingLeg) without isError: the evidence anchors on the _meta transaction (owner decision 1)', async () => {
    const { fetchMock, result } = hosted(
      () => json(rpcResult(2, { content: [{ type: 'text', text: 'paid answer' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: metaSettlement } }), { headers: { 'PAYMENT-RESPONSE': btoa(JSON.stringify({})) } }),
      { noFundingLeg: true },
    )
    const res = await result
    expect(res.ok).toBe(true)
    expect(res.settlementTxHash).toBe(metaTx)
    expect(evidenceTxHashes(fetchMock)).toEqual([metaTx])
  })

  it('D1, erc7710 (noFundingLeg) with isError: accepted and anchored on the _meta transaction (owner decision 1)', async () => {
    const { fetchMock, result } = hosted(
      () => json(rpcResult(2, { isError: true, content: [{ type: 'text', text: 'partial' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: metaSettlement } }), { headers: { 'PAYMENT-RESPONSE': btoa(JSON.stringify({})) } }),
      { noFundingLeg: true },
    )
    const res = await result
    expect(res.ok).toBe(true)
    expect(res.settlementTxHash).toBe(metaTx)
    expect(evidenceTxHashes(fetchMock)).toEqual([metaTx])
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(0)
  })

  // ── D2: a 200 text/plain body carrying an isError tool result ─────────────

  it('D2: a 200 text/plain isError body is parsed and REJECTED on the hosted path', async () => {
    const { fetchMock, result } = hosted(() =>
      new Response(JSON.stringify({ isError: true, content: [{ type: 'text', text: 'failed' }] }), { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    )
    const res = await result
    expect(res.ok).toBe(false)
    expect(backendCalls(fetchMock, '/machine-payments/evidence')).toHaveLength(0)
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(1)
  })

  // ── precedence: a header WITH a transaction beside a DIFFERENT _meta one ──

  it('precedence: the header transaction wins over a different _meta transaction', async () => {
    const { fetchMock, result } = hosted(() =>
      json(rpcResult(2, { content: [{ type: 'text', text: 'paid answer' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: metaSettlement } }), { headers: { 'PAYMENT-RESPONSE': btoa(JSON.stringify({ transaction: headerTx })) } }),
    )
    const res = await result
    expect(res.ok).toBe(true)
    expect(res.settlementTxHash).toBe(headerTx)
    expect(evidenceTxHashes(fetchMock)).toEqual([fundingTxHash, headerTx])
    expect(bodyOf(backendCalls(fetchMock, '/machine-payments/evidence')[0])).toMatchObject({ protocolReceiptHeaderName: 'PAYMENT-RESPONSE' })
  })
})

// ── local: MerchantCompletion.retryRequest (through fetch) ────────────────

describe('#4120 characterization — local retryRequest', () => {
  it('accepted with a PAYMENT-RESPONSE header: the header transaction is the settlement hash', async () => {
    const fetchMock = localPaidRoutes(() =>
      json(rpcResult(2, { content: [{ type: 'text', text: 'paid answer' }] }), { headers: { 'PAYMENT-RESPONSE': btoa(JSON.stringify({ transaction: headerTx })) } }),
    )
    const response = await newClient().fetch(localPaidUrl)
    expect(response.status).toBe(200)
    expect(evidenceTxHashes(fetchMock)).toEqual(['0xabc', headerTx])
    expect(bodyOf(backendCalls(fetchMock, '/machine-payments/evidence')[0])).toMatchObject({ protocolReceiptHeaderName: 'PAYMENT-RESPONSE' })
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(0)
  })

  it('accepted via _meta["x402/payment-response"] when there is no header', async () => {
    const fetchMock = localPaidRoutes(() =>
      json(rpcResult(2, { content: [{ type: 'text', text: 'paid answer' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: metaSettlement } })),
    )
    const response = await newClient().fetch(localPaidUrl)
    expect(response.status).toBe(200)
    expect(evidenceTxHashes(fetchMock)).toEqual(['0xabc', metaTx])
    expect(bodyOf(backendCalls(fetchMock, '/machine-payments/evidence')[0])).toMatchObject({
      protocolReceiptHeaderName: `_meta.${MCP_X402_PAYMENT_RESPONSE_META_KEY}`,
    })
  })

  it('an in-band payment-required tool result is the post-funding rejection: 402 with the marker', async () => {
    const fetchMock = localPaidRoutes(() => json(rpcResult(2, nativeChallenge(localPaidUrl))))
    await expect(newClient().fetch(localPaidUrl)).rejects.toMatchObject({
      statusCode: 402,
      body: expect.objectContaining({ marker: 'x402_retry_rejected_after_funding', payment_id: 'pay_123', merchant_status: 200 }),
    })
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(1)
    expect(backendCalls(fetchMock, '/machine-payments/evidence')).toHaveLength(0)
  })

  it('a _meta settlement with success:false is the post-funding rejection', async () => {
    const fetchMock = localPaidRoutes(() =>
      json(rpcResult(2, { content: [{ type: 'text', text: 'not delivered' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: { success: false, errorReason: 'settlement failed' } } })),
    )
    await expect(newClient().fetch(localPaidUrl)).rejects.toMatchObject({ statusCode: 402, body: expect.objectContaining({ marker: 'x402_retry_rejected_after_funding' }) })
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(1)
    expect(backendCalls(fetchMock, '/machine-payments/evidence')).toHaveLength(0)
  })

  it('a plain isError tool result with no receipt (#4062) is the post-funding rejection', async () => {
    const fetchMock = localPaidRoutes(() =>
      json(rpcResult(2, { isError: true, content: [{ type: 'text', text: "Text generation failed : 'NoneType' object has no attribute 'parts'" }] })),
    )
    await expect(newClient().fetch(localPaidUrl)).rejects.toMatchObject({
      statusCode: 402,
      body: expect.objectContaining({ marker: 'x402_retry_rejected_after_funding', merchant_status: 200 }),
    })
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(1)
    expect(backendCalls(fetchMock, '/machine-payments/evidence')).toHaveLength(0)
  })

  it('a tool error beside a settlement hash is delivered — the money moved', async () => {
    const fetchMock = localPaidRoutes(() =>
      json(rpcResult(2, { isError: true, content: [{ type: 'text', text: 'partial' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: { success: true, transaction: otherTx } } })),
    )
    const response = await newClient().fetch(localPaidUrl)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ result: { isError: true } })
    expect(evidenceTxHashes(fetchMock)).toEqual(['0xabc', otherTx])
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(0)
  })

  it('a non-2xx answer is the post-funding rejection with the merchant status', async () => {
    const fetchMock = localPaidRoutes(() => json({ error: 'nope' }, { status: 500 }))
    await expect(newClient().fetch(localPaidUrl)).rejects.toMatchObject({
      statusCode: 500,
      body: expect.objectContaining({ marker: 'x402_retry_rejected_after_funding', merchant_status: 500 }),
    })
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(1)
  })

  // ── D1 ────────────────────────────────────────────────────────────────────

  it('D1, with isError: a transaction-less header beside a _meta settlement is ACCEPTED today (the local rule)', async () => {
    const fetchMock = localPaidRoutes(() =>
      json(rpcResult(2, { isError: true, content: [{ type: 'text', text: 'partial' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: metaSettlement } }), { headers: { 'PAYMENT-RESPONSE': btoa(JSON.stringify({})) } }),
    )
    const response = await newClient().fetch(localPaidUrl)
    expect(response.status).toBe(200)
    expect(evidenceTxHashes(fetchMock)).toEqual(['0xabc', metaTx])
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(0)
  })

  it('D1, without isError: the _meta transaction is the settlement hash today', async () => {
    const fetchMock = localPaidRoutes(() =>
      json(rpcResult(2, { content: [{ type: 'text', text: 'paid answer' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: metaSettlement } }), { headers: { 'PAYMENT-RESPONSE': btoa(JSON.stringify({})) } }),
    )
    const response = await newClient().fetch(localPaidUrl)
    expect(response.status).toBe(200)
    expect(evidenceTxHashes(fetchMock)).toEqual(['0xabc', metaTx])
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(0)
  })

  it('D1, empty header with isError: accepted today (the local rule)', async () => {
    const fetchMock = localPaidRoutes(() =>
      json(rpcResult(2, { isError: true, content: [{ type: 'text', text: 'partial' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: metaSettlement } }), { headers: { 'PAYMENT-RESPONSE': '' } }),
    )
    const response = await newClient().fetch(localPaidUrl)
    expect(response.status).toBe(200)
    expect(evidenceTxHashes(fetchMock)).toEqual(['0xabc', metaTx])
  })

  it('D1, empty header without isError: the _meta transaction is the settlement hash today', async () => {
    const fetchMock = localPaidRoutes(() =>
      json(rpcResult(2, { content: [{ type: 'text', text: 'paid answer' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: metaSettlement } }), { headers: { 'PAYMENT-RESPONSE': '' } }),
    )
    const response = await newClient().fetch(localPaidUrl)
    expect(response.status).toBe(200)
    const funding = bodyOf(backendCalls(fetchMock, '/machine-payments/evidence')[0])
    expect(funding.protocolReceiptHeaderName).toBe(`_meta.${MCP_X402_PAYMENT_RESPONSE_META_KEY}`)
    expect(funding.protocolReceiptHeader).toBe('')
    expect(evidenceTxHashes(fetchMock)).toEqual(['0xabc', metaTx])
  })

  // ── D2 ────────────────────────────────────────────────────────────────────

  it('D2: a 200 text/plain isError body is ACCEPTED on the local path (the tool result is never read)', async () => {
    const fetchMock = localPaidRoutes(() =>
      new Response(JSON.stringify({ isError: true, content: [{ type: 'text', text: 'failed' }] }), { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    )
    const response = await newClient().fetch(localPaidUrl)
    expect(response.status).toBe(200)
    expect(evidenceTxHashes(fetchMock)).toEqual(['0xabc'])
    expect(backendCalls(fetchMock, '/machine-payments/reconciliation-events')).toHaveLength(0)
  })

  // ── precedence ────────────────────────────────────────────────────────────

  it('precedence: the header transaction wins over a different _meta transaction', async () => {
    const fetchMock = localPaidRoutes(() =>
      json(rpcResult(2, { content: [{ type: 'text', text: 'paid answer' }], _meta: { [MCP_X402_PAYMENT_RESPONSE_META_KEY]: metaSettlement } }), { headers: { 'PAYMENT-RESPONSE': btoa(JSON.stringify({ transaction: headerTx })) } }),
    )
    const response = await newClient().fetch(localPaidUrl)
    expect(response.status).toBe(200)
    expect(evidenceTxHashes(fetchMock)).toEqual(['0xabc', headerTx])
    expect(bodyOf(backendCalls(fetchMock, '/machine-payments/evidence')[0])).toMatchObject({ protocolReceiptHeaderName: 'PAYMENT-RESPONSE' })
  })
})
