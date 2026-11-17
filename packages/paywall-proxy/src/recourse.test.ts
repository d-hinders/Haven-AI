/**
 * The second #4893 PR end to end: proof-backed retries (§6), the challenge
 * nonces, the per-IP limits and the two global caps (§7). A real proxy over a
 * real SQLite file, a mocked facilitator, chain reader and upstream, and a
 * buyer that signs real EIP-3009 authorizations and real SIGN-IN-WITH-X proofs.
 */
import { request as httpRequest } from 'node:http'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { afterEach, describe, expect, it } from 'vitest'
import type { VerifyResponse } from '@x402/core/types'
import { DEFAULT_LIMITS, type LimitSettings } from './limits.js'
import {
  CHAT_BODY,
  CHAT_PATH,
  PLAIN_PRODUCT,
  chatRequest,
  newBuyer,
  signInAs,
  startHarness,
  until,
  type Buyer,
  type Harness,
} from './test-harness.js'

let h: Harness
afterEach(async () => {
  await h?.stop()
})

const TX = `0x${'1'.repeat(64)}`
const PUBLIC = 'https://proxy.test'
const RESOURCE = `${PUBLIC}${CHAT_PATH}`
const LOOSE: Partial<LimitSettings> = { unpaidBurst: 10_000, unpaidPerMinute: 600_000, unpaidConcurrentPerIp: 10_000, upstreamSlotWaitMs: 50 }

function keyOf(paid: { payload: { payload: Record<string, unknown> } }): string {
  const a = paid.payload.payload.authorization as { from: string; nonce: string }
  return `eip3009:84532:${a.from}:${a.nonce}`.toLowerCase()
}

async function paidChat(buyer: Buyer, extra: Record<string, string> = {}) {
  const paid = await buyer.pay(h, CHAT_PATH, chatRequest())
  const res = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header, ...extra }))
  return { res, paid, body: (await res.json()) as Record<string, any> }
}

function present(header: string, proof?: string): Promise<Response> {
  return fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': header, ...(proof ? { 'sign-in-with-x': proof } : {}) }))
}

describe('a forward other than the first needs a SIGN-IN-WITH-X proof from the payer (§6)', () => {
  it('a failed call is served again, with no second charge, when the payer presents the same header with a proof over the challenge', async () => {
    h = await startHarness({ env: { PUBLIC_BASE_URL: PUBLIC }, upstream: { status: 503 }, overrides: { limits: LOOSE } })
    const buyer = newBuyer()
    const { paid, body } = await paidChat(buyer)
    expect(body).toMatchObject({ error: 'upstream_failed_after_settlement', retry: { proof: 'SIGN-IN-WITH-X', forwards_left: 2 } })
    expect(body.sign_in_with_x.info).toMatchObject({ domain: 'proxy.test', uri: RESOURCE, version: '1' })

    h.upstream.behaviour.status = 200
    const proof = await buyer.signIn(body.sign_in_with_x, RESOURCE)
    const again = await present(paid.header, proof)
    expect(again.status).toBe(200)
    expect((await again.json()).choices).toBeDefined()
    expect(h.upstream.seen).toHaveLength(2)
    // The proof is the buyer's metadata: it is never forwarded.
    expect(h.upstream.seen[1]!.headers['sign-in-with-x']).toBeUndefined()
    expect(h.facilitator.settleCalls).toBe(1)
    expect(await h.proxy.store.get(keyOf(paid))).toMatchObject({ state: 'delivered', forwardCount: 2 })

    // Delivered: the payment bought its one call, proof or not.
    const third = await present(paid.header, proof)
    expect((await third.json()).error).toBe('payment_already_delivered')
    expect(h.upstream.seen).toHaveLength(2)
  })

  it('a proof is accepted once: after another failed forward the same proof needs a fresh one, and spent forwards need none', async () => {
    h = await startHarness({ env: { PUBLIC_BASE_URL: PUBLIC }, upstream: { status: 503 }, overrides: { limits: LOOSE } })
    const buyer = newBuyer()
    const { paid, body } = await paidChat(buyer)
    const firstProof = await buyer.signIn(body.sign_in_with_x, RESOURCE)

    const second = (await (await present(paid.header, firstProof)).json()) as Record<string, any>
    expect(second).toMatchObject({ error: 'upstream_failed_after_settlement', retry: { forwards_left: 1 } })
    expect(second.sign_in_with_x.info.nonce).not.toBe(body.sign_in_with_x.info.nonce)

    const replayed = (await (await present(paid.header, firstProof)).json()) as Record<string, any>
    expect(replayed.error).toBe('payment_retry_needs_proof')
    expect(h.upstream.seen).toHaveLength(2)
    expect(h.logs.some((l) => l.event === 'retry_proof_refused' && l.reason === 'nonce_mismatch')).toBe(true)

    const third = (await (await present(paid.header, await buyer.signIn(second.sign_in_with_x, RESOURCE))).json()) as Record<string, any>
    expect(third).toMatchObject({ error: 'upstream_failed_after_settlement', retry: { forwards_left: 0 } })
    // Nothing left to buy: no challenge, and the next answer needs no proof.
    expect(third.sign_in_with_x).toBeUndefined()
    expect((await (await present(paid.header)).json()).error).toBe('payment_exhausted')
    expect(h.upstream.seen).toHaveLength(3)
  })

  it('a proof signed by anyone but the payer forwards nothing', async () => {
    h = await startHarness({ env: { PUBLIC_BASE_URL: PUBLIC }, upstream: { status: 503 }, overrides: { limits: LOOSE } })
    const { paid, body } = await paidChat(newBuyer())
    h.upstream.behaviour.status = 200
    const stranger = await signInAs(privateKeyToAccount(generatePrivateKey()), body.sign_in_with_x, RESOURCE)
    const res = await present(paid.header, stranger)
    expect(res.status).toBe(200)
    expect((await res.json()).error).toBe('payment_retry_needs_proof')
    expect(h.upstream.seen).toHaveLength(1)
    expect(h.logs.some((l) => l.event === 'retry_proof_refused' && l.reason === 'not_the_payer')).toBe(true)
    expect((await h.proxy.store.get(keyOf(paid)))?.forwardCount).toBe(1)
  })

  it('a transfer found on the chain that this proxy never sent is forwarded once the payer signs in', async () => {
    h = await startHarness({ env: { PUBLIC_BASE_URL: PUBLIC }, overrides: { limits: LOOSE } })
    const buyer = newBuyer()
    const paid = await buyer.pay(h, CHAT_PATH, chatRequest())
    const auth = paid.payload.payload.authorization as { from: `0x${string}`; nonce: `0x${string}` }
    h.chain.markUsed(auth.from, auth.nonce)
    h.chain.outcome = { kind: 'settled', txHash: TX as `0x${string}` }
    const first = (await (await present(paid.header)).json()) as Record<string, any>
    expect(first.error).toBe('payment_retry_needs_proof')
    expect(h.upstream.seen).toHaveLength(0)

    const res = await present(paid.header, await buyer.signIn(first.sign_in_with_x, RESOURCE))
    expect(res.status).toBe(200)
    expect(h.upstream.seen).toHaveLength(1)
    expect(h.facilitator.settleCalls).toBe(0)
    expect(await h.proxy.store.get(keyOf(paid))).toMatchObject({ state: 'delivered', forwardCount: 1 })
  })

  it('a re-presented body that fails the body checks is bad_request_after_settlement with a challenge, whatever the proof', async () => {
    h = await startHarness({ env: { PUBLIC_BASE_URL: PUBLIC }, upstream: { status: 503 }, overrides: { limits: LOOSE } })
    const buyer = newBuyer()
    const { paid, body } = await paidChat(buyer)
    const proof = await buyer.signIn(body.sign_in_with_x, RESOURCE)
    const res = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': paid.header, 'sign-in-with-x': proof }, 'not json'))
    const answer = (await res.json()) as Record<string, any>
    expect(res.status).toBe(200)
    expect(answer.error).toBe('bad_request_after_settlement')
    expect(answer.sign_in_with_x.info.nonce).toBe(body.sign_in_with_x.info.nonce)
    expect(h.upstream.seen).toHaveLength(1)
    // The proof was not spent on the refused body.
    h.upstream.behaviour.status = 200
    expect((await present(paid.header, proof)).status).toBe(200)
    expect(h.upstream.seen).toHaveLength(2)
  })
})

describe('the challenge nonces (§6)', () => {
  it('one live nonce per key: issued again unchanged while 60 s of it remain, replaced after, and a lapsed proof is refused', async () => {
    let clock = Date.now()
    h = await startHarness({ env: { PUBLIC_BASE_URL: PUBLIC }, upstream: { status: 503 }, overrides: { limits: LOOSE, now: () => new Date(clock) } })
    const buyer = newBuyer()
    const { paid, body } = await paidChat(buyer)
    const nonce = body.sign_in_with_x.info.nonce as string
    const proof = await buyer.signIn(body.sign_in_with_x, RESOURCE)

    clock += 239_000
    const unchanged = (await (await present(paid.header)).json()) as Record<string, any>
    expect(unchanged.sign_in_with_x).toEqual(body.sign_in_with_x)

    clock += 2_000
    const replaced = (await (await present(paid.header)).json()) as Record<string, any>
    expect(replaced.sign_in_with_x.info.nonce).not.toBe(nonce)
    // The old nonce is no longer the key's live one.
    h.upstream.behaviour.status = 200
    expect((await (await present(paid.header, proof)).json()).error).toBe('payment_retry_needs_proof')
    expect(h.upstream.seen).toHaveLength(1)
  })
})

describe('the upstream slot cap (§7)', () => {
  it('with no slot free, a proof-backed forward is 200 at_capacity_after_settlement, and the same proof works once a slot frees', async () => {
    h = await startHarness({
      env: { PUBLIC_BASE_URL: PUBLIC, UPSTREAM_TIMEOUT_MS: '400' },
      upstream: { status: 503 },
      overrides: { limits: { ...LOOSE, upstreamConcurrency: 1 } },
    })
    const buyer = newBuyer()
    const { paid, body } = await paidChat(buyer)
    const proof = await buyer.signIn(body.sign_in_with_x, RESOURCE)

    // Another payment's call holds the only slot.
    h.upstream.behaviour.hang = true
    const other = paidChat(newBuyer())
    await until(() => h.upstream.seen.length === 2)

    const busy = await present(paid.header, proof)
    const answer = (await busy.json()) as Record<string, any>
    expect(busy.status).toBe(200)
    expect(answer).toMatchObject({ error: 'at_capacity_after_settlement', retry_after_seconds: 10, retry: { forwards_left: 2 } })
    expect(answer.sign_in_with_x.info.nonce).toBe(body.sign_in_with_x.info.nonce)

    await other
    h.upstream.behaviour = { ...h.upstream.behaviour, hang: false, status: 200 }
    const served = await present(paid.header, proof)
    expect(served.status).toBe(200)
    expect(await h.proxy.store.get(keyOf(paid))).toMatchObject({ state: 'delivered', forwardCount: 2 })
  })

  it('a holder with no slot after verify sends no settle, releases its reservation and answers 503 at_capacity', async () => {
    h = await startHarness({
      env: { UPSTREAM_TIMEOUT_MS: '400' },
      upstream: { hang: true },
      overrides: { limits: { ...LOOSE, upstreamConcurrency: 1 } },
    })
    const other = paidChat(newBuyer())
    await until(() => h.upstream.seen.length === 1)

    const buyer = newBuyer()
    const paid = await buyer.pay(h, CHAT_PATH, chatRequest())
    const res = await present(paid.header)
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('10')
    expect((await res.json()).error).toBe('at_capacity')
    expect(h.facilitator.verifyCalls).toBe(2)
    expect(h.facilitator.settleCalls).toBe(1)
    expect(await h.proxy.store.get(keyOf(paid))).toBeNull()

    await other
    h.upstream.behaviour = { ...h.upstream.behaviour, hang: false }
    expect((await present(paid.header)).status).toBe(200)
    expect(h.facilitator.settleCalls).toBe(2)
  })
})

describe('the verify cap (§7)', () => {
  it('an unknown key over the cap is 503 at_capacity before it is reserved, and the token comes back on every exit', async () => {
    h = await startHarness({ overrides: { limits: { ...LOOSE, verifyConcurrency: 1 } } })
    let open!: () => void
    const held = new Promise<void>((resolve) => {
      open = resolve
    })
    let verifies = 0
    const realVerify = h.facilitator.verify.bind(h.facilitator)
    h.facilitator.verify = async (): Promise<VerifyResponse> => {
      verifies += 1
      if (verifies === 1) await held
      return realVerify()
    }

    const first = paidChat(newBuyer())
    await until(() => verifies === 1)
    const blocked = newBuyer()
    const paid = await blocked.pay(h, CHAT_PATH, chatRequest())
    const res = await present(paid.header)
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('at_capacity')
    expect(verifies).toBe(1)
    expect(await h.proxy.store.get(keyOf(paid))).toBeNull()

    open()
    expect((await first).res.status).toBe(200)
    // A chain-first exit (the authorization already used) makes no verify call and still gives the token back.
    const used = newBuyer()
    const usedPaid = await used.pay(h, CHAT_PATH, chatRequest())
    const auth = usedPaid.payload.payload.authorization as { from: `0x${string}`; nonce: `0x${string}` }
    h.chain.markUsed(auth.from, auth.nonce)
    h.chain.outcome = { kind: 'settled', txHash: TX as `0x${string}` }
    expect((await (await present(usedPaid.header)).json()).error).toBe('payment_retry_needs_proof')
    expect((await present(paid.header)).status).toBe(200)
    expect(verifies).toBe(2)
  })
})

describe('the per-IP limits (§7)', () => {
  const REAL: Partial<LimitSettings> = { ...DEFAULT_LIMITS, upstreamSlotWaitMs: 50 }

  it('unpaid requests: a burst of 10, then 429 with Retry-After and no challenge; a verified payment is not counted, and a known key is never 429', async () => {
    h = await startHarness({ overrides: { limits: REAL } })
    const buyer = newBuyer()
    const delivered = await buyer.pay(h, CHAT_PATH, chatRequest())
    const fresh = await newBuyer().pay(h, CHAT_PATH, chatRequest())
    expect((await present(delivered.header)).status).toBe(200)

    // Two tokens went to the two challenges; the verified payment took none.
    for (let i = 0; i < 8; i++) {
      expect((await fetch(`${h.base}${PLAIN_PRODUCT.route.split(' ')[1]}`)).status).toBe(402)
    }
    const limited = await fetch(`${h.base}${PLAIN_PRODUCT.route.split(' ')[1]}`)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(limited.headers.get('payment-required')).toBeNull()
    expect(await limited.json()).toMatchObject({ error: 'rate_limited' })

    // A known key whose digest matches is answered from the store, never 429.
    expect((await (await present(delivered.header)).json()).error).toBe('payment_already_delivered')
    // An unknown key from an address over the limit is 429 before it is reserved: no verify, nothing recorded.
    const verifyCalls = h.facilitator.verifyCalls
    expect((await present(fresh.header)).status).toBe(429)
    expect(h.facilitator.verifyCalls).toBe(verifyCalls)
    expect(await h.proxy.store.get(keyOf(fresh))).toBeNull()
  })

  it('payment headers that fail verification count against the same limit', async () => {
    h = await startHarness({ overrides: { limits: { ...REAL, unpaidBurst: 3 } } })
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': 'not a payment' }))
      expect(res.status).toBe(402)
    }
    expect((await fetch(`${h.base}${CHAT_PATH}`, chatRequest())).status).toBe(429)
  })

  it('at most 10 concurrent unpaid requests per address', async () => {
    h = await startHarness({ overrides: { limits: { ...REAL, unpaidConcurrentPerIp: 1 } } })
    const url = new URL(CHAT_PATH, h.base)
    const slow = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(CHAT_BODY.length) } })
    const slowDone = new Promise<number>((resolve) => slow.on('response', (r) => {
      r.resume()
      resolve(r.statusCode ?? 0)
    }))
    slow.write(CHAT_BODY.slice(0, 5))
    await new Promise((r) => setTimeout(r, 50))
    const second = await fetch(`${h.base}${CHAT_PATH}`, chatRequest())
    expect(second.status).toBe(429)
    slow.end(CHAT_BODY.slice(5))
    expect(await slowDone).toBe(402)
    expect((await fetch(`${h.base}${CHAT_PATH}`, chatRequest())).status).toBe(402)
  })

  it('CLIENT_IP_HEADER names the address the merchant\'s own proxy sets, and the rightmost entry of a list counts', async () => {
    h = await startHarness({ env: { CLIENT_IP_HEADER: 'X-Client-IP' }, overrides: { limits: { ...REAL, unpaidBurst: 1 } } })
    const get = (ip: string) => fetch(`${h.base}${PLAIN_PRODUCT.route.split(' ')[1]}`, { headers: { 'x-client-ip': ip } })
    expect((await get('198.51.100.1')).status).toBe(402)
    expect((await get('198.51.100.1')).status).toBe(429)
    expect((await get('198.51.100.2')).status).toBe(402)
    expect((await get('203.0.113.9, 198.51.100.1')).status).toBe(429)
  })
})
