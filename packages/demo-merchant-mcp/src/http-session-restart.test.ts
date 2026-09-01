/**
 * #1578 — a stale MCP session fails CLOSED before the payment gate.
 *
 * Characterization first (money.md): before this guard, a paid retry carrying
 * a pre-restart session id silently fell through to an anonymous transport
 * and SUCCEEDED (200, goods, one settle) — observed, not assumed. That shape
 * was protocol-invalid (the MCP contract for an unknown session is 404 +
 * -32001) and one strict-client quirk away from money harm: settlement ran
 * before session validation, so a client that refuses a session-less
 * response would have consumed its one-use authorization for a response it
 * discards. The guard moves the refusal BEFORE the gate: nothing settles,
 * the client re-initializes, and the SAME header then settles exactly once.
 */
import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequired } from '@x402/core/types'
import { createDemoMerchantServer } from './http.js'
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  USDC_ADDRESS,
  createX402PaymentProcessor,
  type Eip3009Authorization,
  type SettlementClient,
} from './x402.js'

const MERCHANT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a' as const
const PAYER_KEY = `0x${'01'.repeat(32)}` as const
const TX = `0x${'ef'.repeat(32)}` as const

let servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))))
  servers = []
})

async function start() {
  const submit = vi.fn<SettlementClient['submit']>().mockResolvedValue(TX)
  const server = createDemoMerchantServer({
    merchantAddress: MERCHANT,
    baseUrl: 'http://127.0.0.1:0',
    paymentProcessor: createX402PaymentProcessor({
      submit,
      waitForReceipt: vi.fn<SettlementClient['waitForReceipt']>().mockResolvedValue(undefined),
    }),
  })
  servers.push(server)
  await new Promise<void>((res, rej) => {
    server.once('error', rej)
    server.listen(0, '127.0.0.1', () => res())
  })
  const a = server.address()
  if (!a || typeof a === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${a.port}/mcp`, submit }
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  })
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'restart-test', version: '0' } },
}
const BUY = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'buy_vpn', arguments: { plan: 'basic' } } }

async function signedHeader(pr: PaymentRequired): Promise<string> {
  const account = privateKeyToAccount(PAYER_KEY)
  const accepted = pr.accepts[0]
  const now = Math.floor(Date.now() / 1000)
  const auth: Eip3009Authorization = {
    from: account.address,
    to: MERCHANT,
    value: accepted.amount,
    validAfter: '0',
    validBefore: String(now + 300),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  }
  const signature = await account.signTypedData({
    domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_ADDRESS },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: account.address,
      to: MERCHANT,
      value: BigInt(auth.value),
      validAfter: 0n,
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce as `0x${string}`,
    },
  })
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: pr.resource,
    accepted,
    payload: { authorization: auth, signature },
    // #2361: echo the challenge's extensions per the enforced spec MUST.
    ...(pr.extensions ? { extensions: pr.extensions } : {}),
  }
  return encodePaymentSignatureHeader(payload)
}

describe('stale MCP session across a merchant restart (#1578)', () => {
  it('the paid retry gets 404/-32001 BEFORE any settlement, then recovers via re-initialize with the SAME header — one settle total', async () => {
    // Session + challenge on server 1.
    const s1 = await start()
    const initRes = await post(s1.url, INIT)
    const sid = initRes.headers.get('mcp-session-id')
    expect(sid).toBeTruthy()
    const challenge = await post(s1.url, BUY, { 'mcp-session-id': sid! })
    expect(challenge.status).toBe(402)
    const pr = decodePaymentRequiredHeader(challenge.headers.get(PAYMENT_REQUIRED_HEADER)!) as PaymentRequired
    const header = await signedHeader(pr)

    // "Restart": a fresh server with an empty session map.
    const s2 = await start()
    const staleRetry = await post(s2.url, BUY, { 'mcp-session-id': sid!, [PAYMENT_SIGNATURE_HEADER]: header })
    const staleBody = await staleRetry.json() as { error?: { code: number; message: string } }

    // FAIL-CLOSED: the SDK's own unknown-session contract, and zero money moved.
    expect(staleRetry.status).toBe(404)
    expect(staleBody.error).toMatchObject({ code: -32001, message: 'Session not found' })
    expect(s2.submit).not.toHaveBeenCalled()

    // The recovery door: initialize is exempt from the guard even with the
    // stale id attached (a client may resend it; the handshake mints a new one).
    const reinit = await post(s2.url, INIT, { 'mcp-session-id': sid! })
    const newSid = reinit.headers.get('mcp-session-id')
    expect(newSid).toBeTruthy()
    expect(newSid).not.toBe(sid)

    // Same payment header, new session: settles EXACTLY once, goods served.
    const paid = await post(s2.url, BUY, { 'mcp-session-id': newSid!, [PAYMENT_SIGNATURE_HEADER]: header })
    const text = await paid.text()
    expect(paid.status).toBe(200)
    expect(paid.headers.get(PAYMENT_RESPONSE_HEADER)).toBeTruthy()
    expect(text).toContain('Purchase confirmed')
    expect(s2.submit).toHaveBeenCalledTimes(1)
  })

  it('stateless calls (no session header) are untouched and still mint no reusable session', async () => {
    const { url, submit } = await start()
    const challenge = await post(url, BUY)
    expect(challenge.status).toBe(402)
    const pr = decodePaymentRequiredHeader(challenge.headers.get(PAYMENT_REQUIRED_HEADER)!) as PaymentRequired
    const paid = await post(url, BUY, { [PAYMENT_SIGNATURE_HEADER]: await signedHeader(pr) })
    expect(paid.status).toBe(200)
    expect(paid.headers.get('mcp-session-id')).toBeNull()
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('a KNOWN session keeps working across requests — the guard only fires on unknown ids', async () => {
    const { url, submit } = await start()
    const initRes = await post(url, INIT)
    const sid = initRes.headers.get('mcp-session-id')!
    const challenge = await post(url, BUY, { 'mcp-session-id': sid })
    expect(challenge.status).toBe(402)
    const pr = decodePaymentRequiredHeader(challenge.headers.get(PAYMENT_REQUIRED_HEADER)!) as PaymentRequired
    const paid = await post(url, BUY, { 'mcp-session-id': sid, [PAYMENT_SIGNATURE_HEADER]: await signedHeader(pr) })
    expect(paid.status).toBe(200)
    expect(submit).toHaveBeenCalledTimes(1)
  })
})
