/**
 * The paywall proxy end to end (#4893, docs/architecture/12-merchant-kit.md):
 * a real proxy over a real SQLite file, a mocked facilitator and chain reader,
 * and a mocked upstream. Each test is named for the acceptance criterion it
 * proves.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http'
import {
  CDP_SECRET,
  CHAT_BODY,
  CHAT_PATH,
  CHAT_PRODUCT,
  PAY_TO,
  UPSTREAM_KEY,
  chatRequest,
  newBuyer,
  rawRequest,
  startHarness,
  until,
  type Buyer,
  type Harness,
} from './test-harness.js'
import { openSqliteConsumedPaymentStore } from './sqlite-store.js'

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const TX = `0x${'1'.repeat(64)}`
const header = (name: string, res: Response): string | null => res.headers.get(name)

async function paidChat(buyer: Buyer, extra: Record<string, string> = {}, body: string = CHAT_BODY) {
  const paid = await buyer.pay(h, CHAT_PATH, chatRequest({}, body))
  const res = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header, ...extra }, body))
  return { res, paid }
}

describe('unpaid requests', () => {
  it('an unpaid request to a priced route gets 402 with the product price, the configured network and the configured receiving address', async () => {
    h = await startHarness()
    const res = await fetch(`${h.base}${CHAT_PATH}`, chatRequest())
    expect(res.status).toBe(402)
    const body = (await res.json()) as { accepts: Record<string, unknown>[]; x402Version: number }
    expect(body.x402Version).toBe(2)
    expect(body.accepts).toHaveLength(1)
    expect(body.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'eip155:84532',
      amount: CHAT_PRODUCT.price,
      payTo: PAY_TO,
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      extra: { name: 'USDC', version: '2' },
    })
    const fromHeader = decodePaymentRequiredHeader(header('payment-required', res)!)
    expect(fromHeader.accepts[0]).toMatchObject({ amount: CHAT_PRODUCT.price, payTo: PAY_TO, network: 'eip155:84532' })
    expect(h.upstream.seen).toHaveLength(0)
    expect(h.facilitator.verifyCalls + h.facilitator.settleCalls).toBe(0)
  })

  it('the price comes from the product, never from the payment: a payment for another amount is refused before the facilitator', async () => {
    h = await startHarness()
    const buyer = newBuyer()
    const paid = await buyer.pay(h, '/v1/lookup', { method: 'GET', amountOverride: '1' })
    const res = await fetch(`${h.base}/v1/lookup`, { headers: { 'payment-signature': paid.header } })
    expect(res.status).toBe(402)
    expect((await res.json()).error).toBe('payment_mismatch')
    expect(h.facilitator.verifyCalls + h.facilitator.settleCalls).toBe(0)
    expect(h.upstream.seen).toHaveLength(0)
  })

  it('a request for a route that is not in the products file is refused without a challenge', async () => {
    h = await startHarness()
    const res = await fetch(`${h.base}/v1/not-sold`)
    expect(res.status).toBe(404)
    expect(res.headers.get('payment-required')).toBeNull()
    const body = await res.json()
    expect(body.error).toBe('unknown_route')
    expect(body.accepts).toBeUndefined()
    // wrong method on a sold path is also not sold
    const wrong = await fetch(`${h.base}/v1/lookup`, { method: 'POST' })
    expect(wrong.status).toBe(404)
  })

  it('GET /healthz is unpriced and reports readiness', async () => {
    h = await startHarness()
    const res = await fetch(`${h.base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'ok', network: 'eip155:84532' })
  })

  it('routes are matched under BASE_PATH', async () => {
    h = await startHarness({ env: { BASE_PATH: '/api/' } })
    expect((await fetch(`${h.base}/api/v1/lookup`)).status).toBe(402)
    expect((await fetch(`${h.base}/v1/lookup`)).status).toBe(404)
  })
})

describe('a paid request', () => {
  it('is forwarded only after settlement is reported, and the response carries PAYMENT-RESPONSE with the transaction hash', async () => {
    h = await startHarness()
    h.facilitator.settleResult = { success: true, transaction: TX, network: 'eip155:84532' }
    const buyer = newBuyer()
    // the upstream is called only after the facilitator has settled
    const order: string[] = []
    const settle = h.facilitator.settle.bind(h.facilitator)
    h.facilitator.settle = async () => {
      order.push(`settle(upstream calls so far: ${h.upstream.seen.length})`)
      return settle()
    }
    const { res } = await paidChat(buyer)
    expect(res.status).toBe(200)
    expect(order).toEqual(['settle(upstream calls so far: 0)'])
    expect(h.upstream.seen).toHaveLength(1)
    const settled = decodePaymentResponseHeader(header('payment-response', res)!)
    expect(settled).toMatchObject({ success: true, transaction: TX, network: 'eip155:84532', payer: buyer.address })
    expect(await res.json()).toMatchObject({ id: 'cmpl-1' })
    expect(h.facilitator.events).toEqual(['verify', 'settle'])
  })

  it('a request whose payment is rejected at verification is not forwarded and the upstream key is never sent', async () => {
    h = await startHarness()
    h.facilitator.verifyResult = { isValid: false, invalidReason: 'insufficient_funds' }
    const buyer = newBuyer()
    const { res } = await paidChat(buyer)
    expect(res.status).toBe(402)
    expect((await res.json()).error).toBe('payment_invalid')
    expect(h.facilitator.settleCalls).toBe(0)
    expect(h.upstream.seen).toHaveLength(0)
    // the reservation was released: the same header can be tried again
    h.facilitator.verifyResult = { isValid: true }
    const paid = await buyer.pay(h, CHAT_PATH, chatRequest())
    const retry = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }))
    expect(retry.status).toBe(200)
  })

  it('a settle that definitely failed with the authorization unused is 402 settle_failed and releases the key', async () => {
    h = await startHarness()
    h.facilitator.settleResult = { success: false, errorReason: 'insufficient_funds', transaction: '', network: 'eip155:84532' }
    const { res, paid } = await paidChat(newBuyer())
    expect(res.status).toBe(402)
    expect((await res.json()).error).toBe('settle_failed')
    expect(h.upstream.seen).toHaveLength(0)
    const a = paid.payload.payload.authorization as { from: string; nonce: string }
    expect(await h.proxy.store.get(`eip3009:84532:${a.from}:${a.nonce}`.toLowerCase())).toBeNull()
  })

  it('a facilitator that cannot be reached before settle is 503 and nothing stays reserved', async () => {
    h = await startHarness()
    h.facilitator.verifyResult = new Error('network down')
    const { res } = await paidChat(newBuyer())
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('facilitator_unavailable')
    expect(h.facilitator.settleCalls).toBe(0)
    expect(h.upstream.seen).toHaveLength(0)
  })

  it('a malformed payment header is refused with a challenge and no facilitator call', async () => {
    h = await startHarness()
    const res = await fetch(`${h.base}/v1/lookup`, { headers: { 'payment-signature': 'not-base64-json' } })
    expect(res.status).toBe(402)
    expect((await res.json()).error).toBe('payment_invalid')
    expect(h.facilitator.verifyCalls).toBe(0)
  })

  it('the legacy X-PAYMENT header carries a payment too', async () => {
    h = await startHarness()
    const buyer = newBuyer()
    const paid = await buyer.pay(h, '/v1/lookup', { method: 'GET' })
    const res = await fetch(`${h.base}/v1/lookup`, { headers: { 'x-payment': paid.header } })
    expect(res.status).toBe(200)
    expect(h.upstream.seen).toHaveLength(1)
  })
})

describe('product, model and output-token-cap checks run before any facilitator call', () => {
  it('a payment for product A presented on product B is not forwarded (before settlement: it does not match B)', async () => {
    h = await startHarness()
    const buyer = newBuyer()
    // the same price, so only the resource tells the two apart
    const forA = await buyer.pay(h, '/v1/other', { method: 'GET' })
    const onLookup = await fetch(`${h.base}/v1/lookup`, { headers: { 'payment-signature': forA.header } })
    expect(onLookup.status).toBe(402)
    expect((await onLookup.json()).error).toBe('payment_mismatch')
    expect(h.upstream.seen).toHaveLength(0)
    expect(h.facilitator.verifyCalls).toBe(0)
  })

  it('a payment that names no resource is refused before any facilitator call, so a same-price payment for A cannot pass on B', async () => {
    h = await startHarness()
    const buyer = newBuyer()
    const forA = await buyer.pay(h, '/v1/other', { method: 'GET', omitResource: true } as never)
    const onB = await fetch(`${h.base}/v1/lookup`, { headers: { 'payment-signature': forA.header } })
    expect(onB.status).toBe(402)
    expect((await onB.json()).error).toBe('payment_mismatch')
    expect(h.facilitator.verifyCalls).toBe(0)
    expect(h.upstream.seen).toHaveLength(0)
  })

  it('a payment settled for product A presented on product B is answered payment_used_for_other_product and is not forwarded', async () => {
    h = await startHarness()
    const buyer = newBuyer()
    const forOther = await buyer.pay(h, '/v1/other', { method: 'GET' })
    const first = await fetch(`${h.base}/v1/other`, { headers: { 'payment-signature': forOther.header } })
    expect(first.status).toBe(200)
    expect(h.upstream.seen).toHaveLength(1)
    const onChat = await fetch(`${h.base}/v1/lookup`, { headers: { 'payment-signature': forOther.header } })
    expect(onChat.status).toBe(200)
    expect((await onChat.json()).error).toBe('payment_used_for_other_product')
    expect(h.upstream.seen).toHaveLength(1)
    expect(h.facilitator.settleCalls).toBe(1)
  })

  it('a request whose body names a different model is refused 400 with no challenge, unpaid and paid, with no facilitator call', async () => {
    h = await startHarness()
    const wrong = JSON.stringify({ model: 'openai/other', messages: [{ role: 'user', content: 'hi' }] })
    const unpaid = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({}, wrong))
    expect(unpaid.status).toBe(400)
    expect(unpaid.headers.get('payment-required')).toBeNull()
    expect((await unpaid.json()).error).toBe('bad_request')

    const buyer = newBuyer()
    const paid = await buyer.pay(h, CHAT_PATH, chatRequest())
    const res = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }, wrong))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('bad_request')
    expect(h.facilitator.verifyCalls + h.facilitator.settleCalls).toBe(0)
    expect(h.upstream.seen).toHaveLength(0)
  })

  it('a body that is not JSON is 400 bad_request before settlement', async () => {
    h = await startHarness()
    const paid = await newBuyer().pay(h, CHAT_PATH, chatRequest())
    const res = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }, 'not json'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('bad_request')
    expect(h.facilitator.verifyCalls).toBe(0)
  })

  it('a product with a cap and a body that cannot carry it is 400 cap_not_settable, before settlement', async () => {
    h = await startHarness()
    const notChat = JSON.stringify({ model: 'openai/gpt-6-sol', prompt: 'x' })
    const unpaid = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({}, notChat))
    expect(unpaid.status).toBe(400)
    expect((await unpaid.json()).error).toBe('cap_not_settable')
    const paid = await newBuyer().pay(h, CHAT_PATH, chatRequest())
    const res = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }, notChat))
    expect(res.status).toBe(400)
    expect(h.facilitator.verifyCalls).toBe(0)
    expect(h.upstream.seen).toHaveLength(0)
  })

  it('a body over 1 MiB is 413 body_too_large before settlement', async () => {
    h = await startHarness()
    const big = JSON.stringify({ model: 'openai/gpt-6-sol', messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024 + 10) }] })
    const paid = await newBuyer().pay(h, CHAT_PATH, chatRequest())
    const res = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }, big))
    expect(res.status).toBe(413)
    expect((await res.json()).error).toBe('body_too_large')
    expect(h.facilitator.verifyCalls).toBe(0)
    const unpaid = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({}, big))
    expect(unpaid.status).toBe(413)
    expect(unpaid.headers.get('payment-required')).toBeNull()
  })

  it('the output-token cap is set or lowered on the forwarded request, and never raised', async () => {
    h = await startHarness()
    const buyer = newBuyer()
    await paidChat(buyer) // body asks 5000, the product caps at 1000
    expect(JSON.parse(h.upstream.seen[0]!.body).max_tokens).toBe(1000)

    const lower = JSON.stringify({ model: 'openai/gpt-6-sol', messages: [{ role: 'user', content: 'hi' }], max_tokens: 50, max_completion_tokens: 9999 })
    await paidChat(newBuyer(), {}, lower)
    expect(JSON.parse(h.upstream.seen[1]!.body)).toMatchObject({ max_tokens: 50, max_completion_tokens: 1000 })

    const none = JSON.stringify({ model: 'openai/gpt-6-sol', messages: [{ role: 'user', content: 'hi' }] })
    await paidChat(newBuyer(), {}, none)
    const forwarded = JSON.parse(h.upstream.seen[2]!.body)
    expect(forwarded.max_tokens).toBe(1000)
    expect('max_completion_tokens' in forwarded).toBe(false)
  })

  it('products on one route are selected by the body model, each at its own price', async () => {
    h = await startHarness({
      products: [
        { ...CHAT_PRODUCT, id: 'a', price: '10000' },
        { ...CHAT_PRODUCT, id: 'b', model: 'openai/small', price: '2000', output_token_cap: 100 },
      ],
    })
    const small = JSON.stringify({ model: 'openai/small', messages: [{ role: 'user', content: 'hi' }] })
    const res = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({}, small))
    expect(res.status).toBe(402)
    expect((await res.json()).accepts[0].amount).toBe('2000')
    const big = await fetch(`${h.base}${CHAT_PATH}`, chatRequest())
    expect((await big.json()).accepts[0].amount).toBe('10000')
  })
})

describe('forwarding', () => {
  const buyerHeaders: [string, string][] = [
    ['PAYMENT-SIGNATURE', 'x'],
    ['X-PAYMENT', 'x'],
    ['X-Tax-Declaration', 'declaration'],
    ['SIGN-IN-WITH-X', 'siwx'],
    ['Authorization', 'Bearer buyer-secret-token'],
    ['Cookie', 'session=1'],
    ['Proxy-Authorization', 'Basic abc'],
    ['X-Forwarded-For', '203.0.113.9'],
    ['X-Forwarded-Host', 'buyer.example'],
    ['X-Forwarded-Proto', 'https'],
    ['Forwarded', 'for=203.0.113.9'],
    ['X-Real-IP', '203.0.113.9'],
    ['x402-wallet', '0x1111111111111111111111111111111111111111'],
    ['mcp-session-id', 'abc'],
  ]

  it.each(buyerHeaders.filter(([name]) => !['PAYMENT-SIGNATURE', 'X-PAYMENT', 'Authorization'].includes(name)))(
    'the buyer header %s is not forwarded upstream',
    async (name, value) => {
      h = await startHarness()
      const { res } = await paidChat(newBuyer(), { [name]: value })
      expect(res.status).toBe(200)
      expect(h.upstream.seen).toHaveLength(1)
      const seen = h.upstream.seen[0]!
      expect(Object.keys(seen.headers).map((k) => k.toLowerCase())).not.toContain(name.toLowerCase())
      expect(JSON.stringify(seen.headers)).not.toContain(value)
    },
  )

  it('PAYMENT-SIGNATURE is not forwarded upstream', async () => {
    h = await startHarness()
    const { res, paid } = await paidChat(newBuyer())
    expect(res.status).toBe(200)
    const seen = h.upstream.seen[0]!
    expect(seen.headers['payment-signature']).toBeUndefined()
    expect(JSON.stringify(seen.headers)).not.toContain(paid.header)
  })

  it('X-PAYMENT is not forwarded upstream', async () => {
    h = await startHarness()
    const buyer = newBuyer()
    const paid = await buyer.pay(h, '/v1/lookup', { method: 'GET' })
    const res = await fetch(`${h.base}/v1/lookup`, { headers: { 'x-payment': paid.header } })
    expect(res.status).toBe(200)
    const seen = h.upstream.seen[0]!
    expect(seen.headers['x-payment']).toBeUndefined()
    expect(JSON.stringify(seen.headers)).not.toContain(paid.header)
  })

  it("the buyer's Authorization is replaced by the upstream key, not forwarded", async () => {
    h = await startHarness()
    await paidChat(newBuyer(), { authorization: 'Bearer buyer-secret-token' })
    expect(h.upstream.seen[0]!.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`)
  })

  it('a configured header and scheme carry the key bare, and replace a buyer value under that name', async () => {
    h = await startHarness({ env: { UPSTREAM_AUTH_HEADER: 'x-api-key', UPSTREAM_AUTH_SCHEME: '' } })
    await paidChat(newBuyer(), { 'X-Api-Key': 'buyer-value' })
    const seen = h.upstream.seen[0]!
    expect(seen.headers['x-api-key']).toBe(UPSTREAM_KEY)
    expect(seen.headers.authorization).toBeUndefined()
    expect(JSON.stringify(seen.headers)).not.toContain('buyer-value')
  })

  it('the query string and the path under the upstream base are forwarded, and other buyer headers pass through', async () => {
    h = await startHarness()
    const buyer = newBuyer()
    const paid = await buyer.pay(h, '/v1/lookup?q=1', { method: 'GET' })
    const res = await fetch(`${h.base}/v1/lookup?q=1`, { headers: { 'payment-signature': paid.header, 'x-custom': 'kept', accept: 'application/json' } })
    expect(res.status).toBe(200)
    expect(h.upstream.seen[0]!.url).toBe('/v1/lookup?q=1')
    expect(h.upstream.seen[0]!.headers['x-custom']).toBe('kept')
  })

  it('x-receipt-json, x-receipt-url and the upstream payment headers are removed from the upstream response', async () => {
    h = await startHarness({
      upstream: {
        headers: {
          'content-type': 'application/json',
          'x-receipt-json': 'forged',
          'x-receipt-url': 'https://evil.example/receipt',
          'payment-response': 'forged',
          'payment-required': 'forged',
          'x-opper-cost': '0.0004',
        },
      },
    })
    const { res } = await paidChat(newBuyer())
    expect(res.status).toBe(200)
    expect(res.headers.get('x-receipt-json')).toBeNull()
    expect(res.headers.get('x-receipt-url')).toBeNull()
    expect(res.headers.get('payment-required')).toBeNull()
    expect(res.headers.get('x-opper-cost')).toBe('0.0004')
    // the proxy's own PAYMENT-RESPONSE, not the upstream's
    expect(decodePaymentResponseHeader(res.headers.get('payment-response')!).success).toBe(true)
  })

  it('a 4xx the buyer caused is wrapped as 200 upstream_answered, and the payment is spent', async () => {
    h = await startHarness({ upstream: { status: 422, headers: { 'content-type': 'application/json' }, body: '{"detail":"bad prompt"}' } })
    const { res } = await paidChat(newBuyer())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ error: 'upstream_answered', upstream_status: 422, upstream_body: { detail: 'bad prompt' } })
    expect(res.headers.get('payment-response')).not.toBeNull()
  })

  it('a 3xx is wrapped and not followed', async () => {
    h = await startHarness({ upstream: { status: 302, headers: { location: 'http://127.0.0.1:1/' }, body: '' } })
    const { res } = await paidChat(newBuyer())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ error: 'upstream_answered', upstream_status: 302 })
    expect(h.upstream.seen).toHaveLength(1)
  })

  it('a stream:true request is accepted and the upstream SSE body is buffered and returned whole', async () => {
    const sse = 'data: {"a":1}\n\ndata: [DONE]\n\n'
    h = await startHarness({ upstream: { headers: { 'content-type': 'text/event-stream' }, body: sse } })
    const body = JSON.stringify({ model: 'openai/gpt-6-sol', messages: [{ role: 'user', content: 'hi' }], stream: true })
    const { res } = await paidChat(newBuyer(), {}, body)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(sse)
    expect(JSON.parse(h.upstream.seen[0]!.body).stream).toBe(true)
  })
})

describe('upstream failure after settlement', () => {
  it.each([
    ['a 5xx', { status: 503 }, 'upstream_status'],
    ['a 429', { status: 429 }, 'upstream_status'],
    ['a 408', { status: 408 }, 'upstream_status'],
    ['a 401 on the merchant key', { status: 401 }, 'upstream_auth_refused'],
    ['a 403', { status: 403 }, 'upstream_auth_refused'],
    ['a truncated body', { status: 200, body: 'x'.repeat(100), truncateAfter: 10 }, 'upstream_unreachable'],
    ['an SSE stream without its terminal event', { status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'data: {"a":1}\n\n' }, 'upstream_unreachable'],
  ] as const)('%s is 200 upstream_failed_after_settlement with the hash and the payment is recorded failed', async (_label, behaviour, reason) => {
    h = await startHarness({ upstream: behaviour })
    h.facilitator.settleResult = { success: true, transaction: TX, network: 'eip155:84532' }
    const { res, paid } = await paidChat(newBuyer())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ error: 'upstream_failed_after_settlement', reason, payment: { tx_hash: TX, chain: 'eip155:84532' }, retry: { same_payment: true, forwards_left: 2 } })
    expect(decodePaymentResponseHeader(res.headers.get('payment-response')!).transaction).toBe(TX)
    expect(body.isError).toBeUndefined()
    expect(body.success).toBeUndefined()
    const key = `eip3009:84532:${(paid.payload.payload.authorization as { from: string; nonce: string }).from}:${(paid.payload.payload.authorization as { nonce: string }).nonce}`.toLowerCase()
    expect((await h.proxy.store.get(key))?.state).toBe('failed')
    if (reason === 'upstream_auth_refused') expect(h.logs.some((l) => l.event === 'upstream_auth_refused')).toBe(true)
  })

  it('a response over 5 MiB is a failed call, reason response_too_large', async () => {
    h = await startHarness({ upstream: { status: 200, body: Buffer.alloc(5 * 1024 * 1024 + 1, 97), headers: { 'content-type': 'text/plain' } } })
    const { res } = await paidChat(newBuyer())
    expect((await res.json()).reason).toBe('response_too_large')
  })

  it('an upstream that does not answer within UPSTREAM_TIMEOUT_MS is a failed call, reason upstream_timeout', async () => {
    h = await startHarness({ env: { UPSTREAM_TIMEOUT_MS: '150' }, upstream: { hang: true } })
    const { res } = await paidChat(newBuyer())
    expect(res.status).toBe(200)
    expect((await res.json()).reason).toBe('upstream_timeout')
  })

  it('an unreachable upstream is a failed call, reason upstream_unreachable', async () => {
    h = await startHarness()
    await h.upstream.close()
    const { res } = await paidChat(newBuyer())
    expect((await res.json()).reason).toBe('upstream_unreachable')
    h.upstream = (await import('./test-harness.js').then((m) => m.startUpstream()))
  })

  it('a buyer that disconnects aborts the upstream call and the payment is recorded failed', async () => {
    h = await startHarness({ upstream: { hang: true } })
    const buyer = newBuyer()
    const paid = await buyer.pay(h, CHAT_PATH, chatRequest())
    const { req, done } = rawRequest(h.base, CHAT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'payment-signature': paid.header },
      body: CHAT_BODY,
    })
    done.catch(() => undefined)
    await until(() => h.upstream.seen.length === 1)
    req.destroy()
    await until(() => h.upstream.closedByClient() === 1)
    const a = paid.payload.payload.authorization as { from: string; nonce: string }
    const key = `eip3009:84532:${a.from}:${a.nonce}`.toLowerCase()
    await until(() => h.logs.some((l) => l.event === 'upstream_failed_after_settlement' && l.reason === 'buyer_disconnected'))
    expect((await h.proxy.store.get(key))?.state).toBe('failed')
  })

  it('a re-presented failed payment without a valid proof is answered 200 payment_retry_needs_proof with a challenge: nothing forwarded, no forward used', async () => {
    h = await startHarness({ upstream: { status: 503 } })
    const buyer = newBuyer()
    const { paid } = await paidChat(buyer)
    expect(h.upstream.seen).toHaveLength(1)
    h.upstream.behaviour.status = 200
    const again = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header, 'sign-in-with-x': 'anything' }))
    expect(again.status).toBe(200)
    const body = await again.json()
    expect(body).toMatchObject({ error: 'payment_retry_needs_proof', payment: { tx_hash: TX }, retry: { proof: 'SIGN-IN-WITH-X', forwards_left: 2 } })
    expect(body.sign_in_with_x.info.nonce).toMatch(/^[A-Za-z0-9]{8,}$/)
    expect(h.upstream.seen).toHaveLength(1)
    expect(h.facilitator.settleCalls).toBe(1)
  })
})

describe('a settled payment whose call succeeded cannot buy a second call', () => {
  it('including when presented again, and after a restart of the proxy on the same database', async () => {
    h = await startHarness()
    const buyer = newBuyer()
    const { res, paid } = await paidChat(buyer)
    expect(res.status).toBe(200)

    const again = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }))
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ error: 'payment_already_delivered', payment: { tx_hash: TX } })
    expect(h.upstream.seen).toHaveLength(1)

    await h.restart()
    const afterRestart = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }))
    expect(afterRestart.status).toBe(200)
    expect(await afterRestart.json()).toMatchObject({ error: 'payment_already_delivered' })
    expect(afterRestart.headers.get('payment-response')).not.toBeNull()
    expect(h.upstream.seen).toHaveLength(1)
    expect(h.facilitator.settleCalls).toBe(1)
    expect(h.facilitator.verifyCalls).toBe(1)
  })

  it('a header with the same key but a different signature is 402 payment_mismatch and leaves the record untouched', async () => {
    h = await startHarness()
    const buyer = newBuyer()
    const { paid } = await paidChat(buyer)
    const forged = structuredClone(paid.payload)
    ;(forged.payload as { signature: string }).signature = `0x${'ab'.repeat(65)}`
    const { encodePaymentSignatureHeader } = await import('@x402/core/http')
    const res = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': encodePaymentSignatureHeader(forged) }))
    expect(res.status).toBe(402)
    expect((await res.json()).error).toBe('payment_mismatch')
    expect(h.upstream.seen).toHaveLength(1)
    const after = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }))
    expect((await after.json()).error).toBe('payment_already_delivered')
  })

  it('two concurrent requests with the same payment make one settle and one upstream call', async () => {
    h = await startHarness()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.facilitator.settleResult = async () => {
      await gate
      return { success: true, transaction: TX, network: 'eip155:84532' }
    }
    const buyer = newBuyer()
    const paid = await buyer.pay(h, CHAT_PATH, chatRequest())
    const first = fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }))
    await until(() => h.facilitator.settleCalls === 1)
    const second = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }))
    expect(second.status).toBe(503)
    expect(second.headers.get('retry-after')).not.toBeNull()
    expect((await second.json()).error).toBe('settlement_unknown')
    release()
    const done = await first
    expect(done.status).toBe(200)
    expect(h.facilitator.settleCalls).toBe(1)
    expect(h.facilitator.verifyCalls).toBe(1)
    expect(h.upstream.seen).toHaveLength(1)
  })

  it('while the call is in flight the same payment gets 200 payment_in_flight', async () => {
    h = await startHarness({ upstream: { hang: true }, env: { UPSTREAM_TIMEOUT_MS: '2000' } })
    const buyer = newBuyer()
    const paid = await buyer.pay(h, CHAT_PATH, chatRequest())
    const first = fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header })).catch(() => undefined)
    await until(() => h.upstream.seen.length === 1)
    const second = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }))
    expect(second.status).toBe(200)
    const body = await second.json()
    expect(body.error).toBe('payment_in_flight')
    expect(body.retry_after_seconds).toBeGreaterThan(0)
    expect(h.upstream.seen).toHaveLength(1)
    await first
  })
})

describe('settlement whose outcome is unknown', () => {
  it('a lost settle answer is resolved from the chain within SETTLE_RESOLVE_MS and the first request forwards', async () => {
    h = await startHarness()
    const buyer = newBuyer()
    const paid = await buyer.pay(h, CHAT_PATH, chatRequest())
    const auth = paid.payload.payload.authorization as { from: `0x${string}`; nonce: `0x${string}` }
    h.facilitator.settleResult = new Error('timeout')
    // the transaction lands while the proxy polls
    setTimeout(() => {
      h.chain.markUsed(auth.from, auth.nonce)
      h.chain.outcome = { kind: 'settled', txHash: TX as `0x${string}` }
    }, 15)
    const res = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }))
    expect(res.status).toBe(200)
    expect(decodePaymentResponseHeader(res.headers.get('payment-response')!).transaction).toBe(TX)
    expect(h.upstream.seen).toHaveLength(1)
  })

  it('an outcome still unknown is 503 settlement_unknown with Retry-After; a later request that finds the transaction records settled and needs a proof', async () => {
    h = await startHarness()
    const buyer = newBuyer()
    const paid = await buyer.pay(h, CHAT_PATH, chatRequest())
    const auth = paid.payload.payload.authorization as { from: `0x${string}`; nonce: `0x${string}` }
    h.facilitator.settleResult = new Error('timeout')
    const first = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }))
    expect(first.status).toBe(503)
    expect(first.headers.get('retry-after')).not.toBeNull()
    expect((await first.json()).error).toBe('settlement_unknown')
    const key = `eip3009:84532:${auth.from}:${auth.nonce}`.toLowerCase()
    expect((await h.proxy.store.get(key))?.state).toBe('settlement_unknown')
    expect(h.upstream.seen).toHaveLength(0)

    // still nothing on the chain: 503 again, no new settle call
    const second = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }))
    expect(second.status).toBe(503)
    expect(h.facilitator.settleCalls).toBe(1)

    // the settle lands later: found by a later request, which has no reservation and so needs a proof
    h.chain.markUsed(auth.from, auth.nonce)
    h.chain.outcome = { kind: 'settled', txHash: TX as `0x${string}` }
    const third = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }))
    expect(third.status).toBe(200)
    expect(await third.json()).toMatchObject({ error: 'payment_retry_needs_proof', payment: { tx_hash: TX } })
    expect((await h.proxy.store.get(key))?.state).toBe('settled')
    expect(h.upstream.seen).toHaveLength(0)
    expect(h.facilitator.settleCalls).toBe(1)
  })

  it('an authorization that expired with no transfer on the chain is released and refused 402 settle_failed', async () => {
    let skewMs = 0
    h = await startHarness({ overrides: { now: () => new Date(Date.now() + skewMs) } })
    const buyer = newBuyer()
    const paid = await buyer.pay(h, CHAT_PATH, chatRequest())
    h.facilitator.settleResult = new Error('timeout')
    const first = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }))
    expect(first.status).toBe(503)
    // time passes beyond validBefore
    skewMs = 10 * 60 * 1000
    const second = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }))
    expect(second.status).toBe(402)
    expect((await second.json()).error).toBe('settle_failed')
    expect(h.upstream.seen).toHaveLength(0)
    const a = paid.payload.payload.authorization as { from: string; nonce: string }
    expect(await h.proxy.store.get(`eip3009:84532:${a.from}:${a.nonce}`.toLowerCase())).toBeNull()
  })

  it('an authorization used in a transaction that did not pay this merchant is refused 402 payment_mismatch and released', async () => {
    h = await startHarness()
    const buyer = newBuyer()
    const paid = await buyer.pay(h, CHAT_PATH, chatRequest())
    const auth = paid.payload.payload.authorization as { from: `0x${string}`; nonce: `0x${string}` }
    h.chain.markUsed(auth.from, auth.nonce)
    h.chain.outcome = { kind: 'used_elsewhere', txHash: TX as `0x${string}` }
    const res = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }))
    expect(res.status).toBe(402)
    expect((await res.json()).error).toBe('payment_mismatch')
    expect(h.upstream.seen).toHaveLength(0)
    expect(h.facilitator.settleCalls).toBe(0)
    const key = `eip3009:84532:${auth.from}:${auth.nonce}`.toLowerCase()
    expect(await h.proxy.store.get(key)).toBeNull()
  })

  // Review of #4893 (B1): this test used to assert the holder FORWARDS here. A
  // transfer this proxy never sent may be anyone's replay of an authorization
  // that is public in calldata (another proxy on the same PAY_TO, a store
  // restored from a backup), so it now buys nothing without a proof.
  it('a payment already used on the chain that this proxy never settled is recorded settled and not forwarded without a proof', async () => {
    h = await startHarness()
    const buyer = newBuyer()
    const paid = await buyer.pay(h, CHAT_PATH, chatRequest())
    const auth = paid.payload.payload.authorization as { from: `0x${string}`; nonce: `0x${string}` }
    h.chain.markUsed(auth.from, auth.nonce)
    h.chain.outcome = { kind: 'settled', txHash: TX as `0x${string}` }
    const res = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }))
    expect(res.status).toBe(200)
    expect((await res.json()).error).toBe('payment_retry_needs_proof')
    expect(h.facilitator.settleCalls).toBe(0)
    expect(h.upstream.seen).toHaveLength(0)
    const key = `eip3009:84532:${auth.from}:${auth.nonce}`.toLowerCase()
    expect((await h.proxy.store.get(key))?.state).toBe('settled')
  })

  it('a buyer Expect header is not forwarded, so a settled call still reaches the upstream with the real fetch', async () => {
    h = await startHarness()
    const buyer = newBuyer()
    const paid = await buyer.pay(h, CHAT_PATH, chatRequest())
    const { request } = await import('node:http')
    const url = new URL(`${h.base}${CHAT_PATH}`)
    const init = chatRequest({ 'payment-signature': paid.header })
    const body = String(init.body)
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { ...(init.headers as Record<string, string>), 'content-length': String(Buffer.byteLength(body)), expect: '100-continue', connection: 'keep-alive, x-hop' , 'x-hop': 'secret-hop' } },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        },
      )
      req.on('error', reject)
      req.on('continue', () => req.end(body))
      req.flushHeaders()
    })
    expect(status).toBe(200)
    expect(h.upstream.seen).toHaveLength(1)
    const forwarded = h.upstream.seen[0].headers as Record<string, unknown>
    expect(forwarded.expect).toBeUndefined()
    expect(forwarded['x-hop']).toBeUndefined()
  })

  it('a used authorization whose transaction cannot be read yet is 503 settlement_unknown and is never served', async () => {
    h = await startHarness()
    const buyer = newBuyer()
    const paid = await buyer.pay(h, CHAT_PATH, chatRequest())
    const auth = paid.payload.payload.authorization as { from: `0x${string}`; nonce: `0x${string}` }
    h.chain.markUsed(auth.from, auth.nonce)
    h.chain.outcome = null
    const res = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }))
    expect(res.status).toBe(503)
    expect(h.upstream.seen).toHaveLength(0)
    const key = `eip3009:84532:${auth.from}:${auth.nonce}`.toLowerCase()
    expect((await h.proxy.store.get(key))?.state).toBe('settlement_unknown')
  })

  it('a payment whose reservation was lost to a restart is resolved from the chain, recorded settled, and not forwarded', async () => {
    h = await startHarness()
    const buyer = newBuyer()
    const paid = await buyer.pay(h, CHAT_PATH, chatRequest())
    const auth = paid.payload.payload.authorization as { from: `0x${string}`; nonce: `0x${string}` }
    // a settling record left by a process that died
    await h.proxy.close()
    const { authorizationDigest } = await import('@haven_ai/merchant-payments')
    const store = openSqliteConsumedPaymentStore(h.env.PAYMENTS_DB!, { takeoverAfterMs: 1 })
    const key = `eip3009:84532:${auth.from}:${auth.nonce}`.toLowerCase()
    await store.reserve({
      key,
      productId: CHAT_PRODUCT.id,
      chain: 'eip155:84532',
      payer: auth.from,
      amount: CHAT_PRODUCT.price,
      validBefore: Number((paid.payload.payload.authorization as { validBefore: string }).validBefore),
      merchantReference: 'ref',
      authorizationDigest: authorizationDigest(
        paid.payload.payload.authorization as never,
        paid.payload.payload.signature as string,
      ),
      now: new Date().toISOString(),
    })
    store.close()
    await h.restart()
    h.chain.markUsed(auth.from, auth.nonce)
    h.chain.outcome = { kind: 'settled', txHash: TX as `0x${string}` }
    const res = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ error: 'payment_retry_needs_proof' })
    expect(h.upstream.seen).toHaveLength(0)
    expect((await h.proxy.store.get(key))?.state).toBe('settled')
  })

  it('a holder past RESERVATION_DEADLINE_MS loses its reservation: a later request resolves from the chain and the holder is not forwarded', async () => {
    h = await startHarness({ overrides: { reservationDeadlineMs: 60 } })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.facilitator.settleResult = async () => {
      await gate
      return { success: true, transaction: TX, network: 'eip155:84532' }
    }
    const buyer = newBuyer()
    const paid = await buyer.pay(h, CHAT_PATH, chatRequest())
    const auth = paid.payload.payload.authorization as { from: `0x${string}`; nonce: `0x${string}` }
    const holder = fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }))
    await until(() => h.facilitator.settleCalls === 1)
    await new Promise((r) => setTimeout(r, 90))
    h.chain.markUsed(auth.from, auth.nonce)
    h.chain.outcome = { kind: 'settled', txHash: TX as `0x${string}` }
    const later = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }))
    expect(later.status).toBe(200)
    expect((await later.json()).error).toBe('payment_retry_needs_proof')
    release()
    const lateHolder = await holder
    expect(lateHolder.status).toBe(200)
    expect((await lateHolder.json()).error).toBe('payment_retry_needs_proof')
    expect(h.upstream.seen).toHaveLength(0)
  })
})

describe('secrets never appear in a response or a log line', () => {
  it('the upstream key and the Coinbase secret appear in no response, no error body and no output, across success and failure paths', async () => {
    const captured: string[] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      }),
    )
    const responses: string[] = []
    try {
      // the real logger (not the harness's collector) so a leak into a log line would show
      const { createLogger } = await import('./log.js')
      h = await startHarness({
        overrides: { log: createLogger([UPSTREAM_KEY, CDP_SECRET]) },
        upstream: { status: 500, body: `upstream says: key ${UPSTREAM_KEY}` },
      })
      const record = async (res: Response): Promise<void> => {
        responses.push(JSON.stringify([...res.headers.entries()]), await res.text())
      }
      await record(await fetch(`${h.base}${CHAT_PATH}`, chatRequest()))
      await record((await paidChat(newBuyer())).res) // upstream 500: failed after settlement
      h.upstream.behaviour = { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }
      await record((await paidChat(newBuyer(), { authorization: `Bearer ${UPSTREAM_KEY}` })).res)
      h.facilitator.verifyResult = { isValid: false, invalidReason: `bad secret ${CDP_SECRET}` }
      await record((await paidChat(newBuyer())).res)
      h.facilitator.verifyResult = new Error(`jwt ${CDP_SECRET}`)
      await record((await paidChat(newBuyer())).res)
      await record(await fetch(`${h.base}/healthz`))
      await record(await fetch(`${h.base}/nope`))
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    const everything = [...captured, ...responses].join('\n')
    expect(everything).not.toContain(UPSTREAM_KEY)
    expect(everything).not.toContain(CDP_SECRET)
    expect(captured.join('').length).toBeGreaterThan(0)
  })
})

describe('no self-settlement', () => {
  it('the proxy source holds no signing key, no wallet and no transaction submission', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const dir = fileURLToPath(new URL('.', import.meta.url))
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'test-harness.ts')
    expect(sources.length).toBeGreaterThan(5)
    const forbidden = /privateKeyToAccount|createWalletClient|sendTransaction|writeContract|sendRawTransaction|PRIVATE_KEY|createSettleOnce|signTypedData/
    for (const file of sources) {
      const text = readFileSync(`${dir}${file}`, 'utf8')
      expect(forbidden.test(text), `${file} must not hold a key or submit a transaction`).toBe(false)
    }
  })
})

// ---- #4988: the product's input_schema, before the challenge and before settlement ----

const SEARCH_PATH = '/v1/search'
const SEARCH_PRODUCT = {
  id: 'search',
  route: `POST ${SEARCH_PATH}`,
  price: '30000',
  description: 'One search.',
  input_schema: {
    type: 'object',
    required: ['query'],
    properties: { query: { type: 'string' }, max_results: { type: 'integer', maximum: 10 } },
  },
}
/** A POST product with no schema: the kit forwards its body as it is (§3). */
const RAW_PRODUCT = { id: 'raw', route: 'POST /v1/raw', price: '40000', description: 'One raw call.' }
const VALID_SEARCH = JSON.stringify({ query: 'haven', max_results: 5 })
const searchRequest = (body: string, headers: Record<string, string> = { 'content-type': 'application/json' }): RequestInit => ({ method: 'POST', headers, body })

function keyOf(paid: { payload: { payload: Record<string, unknown> } }): string {
  const a = paid.payload.payload.authorization as { from: string; nonce: string }
  return `eip3009:84532:${a.from}:${a.nonce}`.toLowerCase()
}

describe('input_schema (#4988)', () => {
  /** Each body the search product's schema refuses, with what the refusal names. */
  const INVALID: { name: string; init: RequestInit; errors: { path: string; rule: string }[] }[] = [
    { name: 'an empty body', init: searchRequest(''), errors: [{ path: '', rule: 'json' }] },
    { name: 'broken JSON', init: searchRequest('{"query": '), errors: [{ path: '', rule: 'json' }] },
    { name: 'a text/plain body', init: searchRequest(VALID_SEARCH, { 'content-type': 'text/plain' }), errors: [{ path: '', rule: 'content_type' }] },
    { name: 'a body missing a required field', init: searchRequest(JSON.stringify({ max_results: 5 })), errors: [{ path: '/query', rule: 'required' }] },
    { name: 'a body over a maximum', init: searchRequest(JSON.stringify({ query: 'SECRET-QUERY-4988', max_results: 9999 })), errors: [{ path: '/max_results', rule: 'maximum' }] },
  ]

  for (const c of INVALID) {
    it(`${c.name} is refused 400 invalid_request_body, unpaid and with a payment header, with no facilitator call`, async () => {
      h = await startHarness({ products: [SEARCH_PRODUCT, RAW_PRODUCT] })
      const unpaid = await fetch(`${h.base}${SEARCH_PATH}`, c.init)
      expect(unpaid.status).toBe(400)
      expect(unpaid.headers.get('payment-required')).toBeNull()
      const unpaidText = await unpaid.text()
      const unpaidBody = JSON.parse(unpaidText) as Record<string, unknown>
      expect(unpaidBody).toMatchObject({ error: 'invalid_request_body', errors: c.errors })
      expect(typeof unpaidBody.message).toBe('string')
      expect(unpaidBody.accepts).toBeUndefined()

      // A payment signed for a valid body's challenge, presented with the invalid body.
      const paid = await newBuyer().pay(h, SEARCH_PATH, searchRequest(VALID_SEARCH))
      const init = { ...c.init, headers: { ...(c.init.headers as Record<string, string>), 'payment-signature': paid.header } }
      const res = await fetch(`${h.base}${SEARCH_PATH}`, init)
      expect(res.status).toBe(400)
      expect(res.headers.get('payment-required')).toBeNull()
      const text = await res.text()
      expect(JSON.parse(text)).toMatchObject({ error: 'invalid_request_body', errors: c.errors })
      // Nothing verified, settled, recorded or forwarded.
      expect(h.facilitator.verifyCalls + h.facilitator.settleCalls).toBe(0)
      expect(h.upstream.seen).toHaveLength(0)
      expect(await h.proxy.store.get(keyOf(paid))).toBeNull()
      // The refusal never echoes the body's values.
      for (const answer of [unpaidText, text]) {
        expect(answer).not.toContain('SECRET-QUERY-4988')
        expect(answer).not.toContain('9999')
      }
    })
  }

  it('a body that validates gets the ordinary 402 unpaid, with or without a Content-Type, and settles and forwards as it was sent', async () => {
    h = await startHarness({ products: [SEARCH_PRODUCT, RAW_PRODUCT] })
    const unpaid = await fetch(`${h.base}${SEARCH_PATH}`, searchRequest(VALID_SEARCH))
    expect(unpaid.status).toBe(402)
    expect(((await unpaid.json()) as { accepts: { amount: string }[] }).accepts[0]!.amount).toBe(SEARCH_PRODUCT.price)
    // No Content-Type at all (fetch would add text/plain to a string body, so this goes through node:http).
    const bare = await rawRequest(h.base, SEARCH_PATH, { method: 'POST', headers: {}, body: VALID_SEARCH }).done
    expect(bare.status).toBe(402)

    const paid = await newBuyer().pay(h, SEARCH_PATH, searchRequest(VALID_SEARCH))
    const res = await rawRequest(h.base, SEARCH_PATH, { method: 'POST', headers: { 'payment-signature': paid.header }, body: VALID_SEARCH }).done
    expect(res.status).toBe(200)
    expect(h.facilitator.settleCalls).toBe(1)
    expect(h.upstream.seen).toHaveLength(1)
    expect(h.upstream.seen[0]!.body).toBe(VALID_SEARCH)
  })

  it('a product without input_schema is unchanged: any body gets its 402 and is forwarded as it is', async () => {
    h = await startHarness({ products: [SEARCH_PRODUCT, RAW_PRODUCT] })
    for (const init of [searchRequest('not json', { 'content-type': 'text/plain' }), searchRequest(''), searchRequest(JSON.stringify({ max_results: 9999 }))]) {
      const res = await fetch(`${h.base}/v1/raw`, init)
      expect(res.status).toBe(402)
    }
    const paid = await newBuyer().pay(h, '/v1/raw', searchRequest('not json', { 'content-type': 'text/plain' }))
    const res = await fetch(`${h.base}/v1/raw`, searchRequest('not json', { 'content-type': 'text/plain', 'payment-signature': paid.header }))
    expect(res.status).toBe(200)
    expect(h.upstream.seen[0]!.body).toBe('not json')
  })

  it('for a capped product with a schema, a schema failure is invalid_request_body, not cap_not_settable; an over-cap max_tokens is still lowered and messages: [] is the schema\'s call', async () => {
    const withSchema = {
      ...CHAT_PRODUCT,
      input_schema: { type: 'object', required: ['model', 'messages'], properties: { model: { type: 'string' }, messages: { type: 'array' }, max_tokens: { type: 'integer', minimum: 1 } } },
    }
    h = await startHarness({ products: [withSchema] })
    const notChat = JSON.stringify({ model: 'openai/gpt-6-sol', prompt: 'x' })
    const unpaid = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({}, notChat))
    expect(unpaid.status).toBe(400)
    expect(await unpaid.json()).toMatchObject({ error: 'invalid_request_body', errors: [{ path: '/messages', rule: 'required' }] })

    // An empty messages array is an array: this schema accepts it, so it is quoted.
    const empty = JSON.stringify({ model: 'openai/gpt-6-sol', messages: [] })
    expect((await fetch(`${h.base}${CHAT_PATH}`, chatRequest({}, empty))).status).toBe(402)

    // max_tokens 5000 passes the schema and is lowered to the cap on the way upstream.
    const { res } = await paidChat(newBuyer())
    expect(res.status).toBe(200)
    expect(JSON.parse(h.upstream.seen[0]!.body).max_tokens).toBe(1000)
  })

  it('on a route shared by model, the schema is the one of the product the model picks; an unparseable body is bad_request unless every product has a schema', async () => {
    const SCHEMA_MODEL = {
      ...CHAT_PRODUCT,
      id: 'chat-schema',
      input_schema: { type: 'object', required: ['model', 'messages'], properties: { model: { type: 'string' }, messages: { type: 'array', minItems: 1 } } },
    }
    const PLAIN_MODEL = { ...CHAT_PRODUCT, id: 'chat-plain', model: 'openai/plain', price: '5000', output_token_cap: undefined }
    h = await startHarness({ products: [PLAIN_MODEL, SCHEMA_MODEL] })
    // The schema product, with a body its schema refuses: 400 unpaid and paid, no facilitator call.
    const failing = JSON.stringify({ model: 'openai/gpt-6-sol', messages: [] })
    const unpaid = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({}, failing))
    expect(unpaid.status).toBe(400)
    expect(await unpaid.json()).toMatchObject({ error: 'invalid_request_body', errors: [{ path: '/messages', rule: 'minItems' }] })
    const paid = await newBuyer().pay(h, CHAT_PATH, chatRequest())
    const res = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header }, failing))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_request_body')
    expect(h.facilitator.verifyCalls + h.facilitator.settleCalls).toBe(0)
    expect(h.upstream.seen).toHaveLength(0)
    // The product without a schema, the same shape of body, sent as text/plain: quoted, as today.
    const plain = JSON.stringify({ model: 'openai/plain', messages: [] })
    const quoted = await fetch(`${h.base}${CHAT_PATH}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: plain })
    expect(quoted.status).toBe(402)
    // Not JSON at all: the product cannot be picked, and not every product has a schema.
    const broken = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({}, '{"model": '))
    expect(broken.status).toBe(400)
    expect((await broken.json()).error).toBe('bad_request')
  })

  it('a retried known payment with an invalid body is bad_request_after_settlement with errors, or payment_already_delivered once delivered, and is not forwarded', async () => {
    h = await startHarness({ products: [SEARCH_PRODUCT], upstream: { status: 503 } })
    const buyer = newBuyer()
    const paid = await buyer.pay(h, SEARCH_PATH, searchRequest(VALID_SEARCH))
    const first = await fetch(`${h.base}${SEARCH_PATH}`, searchRequest(VALID_SEARCH, { 'content-type': 'application/json', 'payment-signature': paid.header }))
    expect(first.status).toBe(200)
    expect(h.upstream.seen).toHaveLength(1)
    const before = await h.proxy.store.get(keyOf(paid))
    expect(before).toMatchObject({ state: 'failed', forwardCount: 1 })

    const bad = JSON.stringify({ query: 'SECRET-QUERY-4988', max_results: 9999 })
    const retry = await fetch(`${h.base}${SEARCH_PATH}`, searchRequest(bad, { 'content-type': 'application/json', 'payment-signature': paid.header }))
    expect(retry.status).toBe(200)
    const text = await retry.text()
    const answer = JSON.parse(text) as { error: string; sign_in_with_x: Parameters<Buyer['signIn']>[0] }
    expect(answer).toMatchObject({ error: 'bad_request_after_settlement', errors: [{ path: '/max_results', rule: 'maximum' }] })
    expect(text).not.toContain('SECRET-QUERY-4988')
    expect(h.upstream.seen).toHaveLength(1)
    expect(h.facilitator.settleCalls).toBe(1)
    expect(await h.proxy.store.get(keyOf(paid))).toEqual(before)

    // Delivered: the invalid retry is answered as the delivered payment it is.
    h.upstream.behaviour.status = 200
    const proof = await buyer.signIn(answer.sign_in_with_x, `${h.base}${SEARCH_PATH}`)
    const good = await fetch(`${h.base}${SEARCH_PATH}`, searchRequest(VALID_SEARCH, { 'content-type': 'application/json', 'payment-signature': paid.header, 'sign-in-with-x': proof }))
    expect(good.status).toBe(200)
    expect(await h.proxy.store.get(keyOf(paid))).toMatchObject({ state: 'delivered' })
    const after = await fetch(`${h.base}${SEARCH_PATH}`, searchRequest(bad, { 'content-type': 'application/json', 'payment-signature': paid.header }))
    expect((await after.json()).error).toBe('payment_already_delivered')
    expect(h.upstream.seen).toHaveLength(2)
  })
})
