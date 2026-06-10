/**
 * EIP-3009 + EIP-712 wire-format invariant tests (#323).
 *
 * ── Why these invariants matter ───────────────────────────────────────────
 *
 * The X-PAYMENT header Haven's SDK produces is consumed by external merchant
 * facilitators (Soundside, the Coinbase reference) that verify it against
 * USDC's on-chain EIP-3009 `transferWithAuthorization`. A header that is
 * structurally valid JSON but wrong in any byte of the signed typed data is
 * rejected with an opaque `Invalid payment signature header` — there is no
 * server-side error that points at the broken field.
 *
 * PR #303 added a regression guard for the top-level header shape
 * (`x402Version` / `accepted` / `payload`). These tests extend coverage to
 * the layer below — the layer where the next class of bug lives:
 *
 * 1. **Authorization fields** — `from`/`to`/`value` must match the payment
 *    option exactly; `validAfter`/`validBefore` must form a sane window
 *    (facilitators reject expired or not-yet-valid authorizations); `nonce`
 *    must be 32 random bytes (USDC rejects reused nonces on-chain).
 * 2. **Signature recovery** — the signature must recover to the delegate
 *    address under the exact EIP-712 domain USDC uses on Base
 *    (`name: 'USD Coin'`, `version: '2'`, `chainId: 8453`,
 *    `verifyingContract: <Base USDC>`). A signature produced under any other
 *    domain (wrong chainId, wrong contract) recovers to a different address
 *    and the facilitator rejects it.
 * 3. **Nonce lifecycle** — separate payments must use fresh nonces (replay
 *    safety), while a retry of the *same* payment must reuse the cached
 *    header — and therefore the same nonce — so the merchant can de-dupe.
 * 4. **Asset address byte-sensitivity** — EIP-712 hashes are computed over
 *    the checksummed `verifyingContract`; the SDK must not lowercase or
 *    otherwise rewrite the asset address it echoes into `accepted`.
 *
 * Do not weaken these assertions to `toMatchObject` — permissive matchers
 * are exactly what allowed the PR #300 regression to ship.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ethers } from 'ethers'
import { HavenClient } from './client.js'
import type { X402PaymentRequired, X402PaymentOption } from './types.js'

const DELEGATE_KEY = `0x${'01'.repeat(32)}`
const DELEGATE_ADDRESS = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1'
const SAFE_ADDRESS = '0x135a9215604711AC70d970e12Caa812c53537EF4'

// Base USDC, verbatim checksummed — case matters for EIP-712 (see header note).
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const accepted: X402PaymentOption = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: BASE_USDC,
  amount: '20000',
  payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' },
}

const paymentRequired: X402PaymentRequired = {
  x402Version: 2,
  error: 'Payment required',
  resource: {
    url: 'https://api.merchant.example/paid',
    description: 'wire-format invariant fixture',
    mimeType: 'application/json',
  },
  accepts: [accepted],
}

// EIP-3009 typed-data definition, mirrored from USDC's implementation.
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}

// The exact domain USDC v2 uses on Base mainnet.
const BASE_USDC_DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: 8453,
  verifyingContract: BASE_USDC,
}

interface DecodedAuthorization {
  from: string
  to: string
  value: string
  validAfter: string
  validBefore: string
  nonce: string
}

interface DecodedHeader {
  x402Version: number
  accepted: X402PaymentOption
  payload: {
    signature: string
    authorization: DecodedAuthorization
  }
}

function decodeHeader(header: string): DecodedHeader {
  return JSON.parse(atob(header)) as DecodedHeader
}

function makeHaven(): HavenClient {
  return new HavenClient({
    apiKey: 'sk_agent_test',
    delegateKey: DELEGATE_KEY,
    baseUrl: 'https://haven.example',
  })
}

/**
 * Build a signed X-PAYMENT header through the SDK's real signing path.
 * `createStandardX402Header` is private; reaching into it keeps each test
 * focused on the signing path without mocking a 5-request payment flow.
 */
async function buildHeader(
  haven: HavenClient = makeHaven(),
  pr: X402PaymentRequired = paymentRequired,
  option: X402PaymentOption = accepted,
): Promise<string> {
  const target = haven as unknown as {
    createStandardX402Header(pr: X402PaymentRequired, option: X402PaymentOption): Promise<string>
  }
  return target.createStandardX402Header(pr, option)
}

describe('EIP-3009 authorization fields', () => {
  it('carries exact from/to/value matching the delegate and the accepted option', async () => {
    const { payload } = decodeHeader(await buildHeader())
    const auth = payload.authorization

    expect(auth.from).toBe(DELEGATE_ADDRESS)
    expect(auth.to).toBe(accepted.payTo)
    expect(auth.value).toBe(accepted.amount)
    expect(typeof auth.value).toBe('string')
  })

  it('sets a sane validAfter/validBefore window', async () => {
    const before = Math.floor(Date.now() / 1000)
    const { payload } = decodeHeader(await buildHeader())
    const after = Math.floor(Date.now() / 1000)
    const auth = payload.authorization

    const validAfter = Number(auth.validAfter)
    const validBefore = Number(auth.validBefore)

    expect(Number.isFinite(validAfter)).toBe(true)
    expect(Number.isFinite(validBefore)).toBe(true)

    // validAfter must already be in effect (allowing 60s clock skew).
    expect(validAfter).toBeLessThanOrEqual(after + 60)
    // validBefore must be in the future, bounded by the option's timeout
    // (allowing the seconds the test itself took plus 60s skew).
    expect(validBefore).toBeGreaterThan(before)
    expect(validBefore).toBeLessThanOrEqual(after + accepted.maxTimeoutSeconds + 60)
  })

  it('uses a 32-byte hex nonce', async () => {
    const { payload } = decodeHeader(await buildHeader())
    expect(payload.authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/i)
  })

  it('uses fresh nonces for separate signings', async () => {
    const haven = makeHaven()
    const first = decodeHeader(await buildHeader(haven))
    const second = decodeHeader(await buildHeader(haven))
    expect(first.payload.authorization.nonce).not.toBe(second.payload.authorization.nonce)
  })
})

describe('nonce reuse across retries (same idempotency key)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reuses the cached header — and therefore the same nonce — when resuming the same payment', async () => {
    const resourceUrl = paymentRequired.resource.url
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(paymentRequired), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'pay_323',
        status: 'pending_signature',
        chain_id: 8453,
        safe_address: SAFE_ADDRESS,
        token: 'USDC',
        amount: '0.02',
        to: DELEGATE_ADDRESS,
        resource_url: resourceUrl,
        sign_data: {
          hash: `0x${'11'.repeat(32)}`,
          components: {
            safe: SAFE_ADDRESS,
            token: accepted.asset,
            to: DELEGATE_ADDRESS,
            amount: accepted.amount,
            payment_token: '0x0000000000000000000000000000000000000000',
            payment: '0',
            nonce: 1,
          },
          instructions: 'Sign with delegate key',
        },
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        payment_id: 'pay_323',
        status: 'confirmed',
        tx_hash: '0xabc',
        chain_id: 8453,
        token: 'USDC',
        amount: '0.02',
        to: DELEGATE_ADDRESS,
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ evidence: { id: 'ev-323' } }), { status: 202 }))

    const haven = makeHaven()
    const quote = await haven.quoteX402(resourceUrl, { method: 'GET' }, { idempotencyKey: 'invariant-nonce-reuse' })
    const response = await haven.payX402Quote(quote)
    expect(response.status).toBe(200)

    const retryInit = fetchMock.mock.calls[3][1] as RequestInit
    const sentHeader = new Headers(retryInit.headers).get('X-PAYMENT') ?? ''
    const sentNonce = decodeHeader(sentHeader).payload.authorization.nonce

    const callsBeforeResume = fetchMock.mock.calls.length
    const receipt = await haven.resumeAuthorizedX402({
      paymentId: 'pay_323',
      paymentRequired,
      idempotencyKey: 'invariant-nonce-reuse',
    })

    // Served from the receipt cache: no new network calls, identical header.
    expect(fetchMock.mock.calls.length).toBe(callsBeforeResume)
    expect(receipt.paymentHeader).toBe(sentHeader)
    expect(decodeHeader(receipt.paymentHeader!).payload.authorization.nonce).toBe(sentNonce)
  })
})

describe('EIP-712 signature recovery', () => {
  it('recovers to the delegate address under the Base USDC domain', async () => {
    const { payload } = decodeHeader(await buildHeader())

    const recovered = ethers.verifyTypedData(
      BASE_USDC_DOMAIN,
      TRANSFER_WITH_AUTHORIZATION_TYPES,
      payload.authorization,
      payload.signature,
    )

    expect(recovered).toBe(DELEGATE_ADDRESS)
    expect(recovered).toBe(payload.authorization.from)
  })

  it('does not recover to the delegate under a wrong-chain domain', async () => {
    const { payload } = decodeHeader(await buildHeader())

    const recoveredOnMainnet = ethers.verifyTypedData(
      { ...BASE_USDC_DOMAIN, chainId: 1 },
      TRANSFER_WITH_AUTHORIZATION_TYPES,
      payload.authorization,
      payload.signature,
    )

    expect(recoveredOnMainnet).not.toBe(DELEGATE_ADDRESS)
  })

  it('does not recover to the delegate under a wrong verifyingContract', async () => {
    const { payload } = decodeHeader(await buildHeader())

    const recoveredWrongContract = ethers.verifyTypedData(
      { ...BASE_USDC_DOMAIN, verifyingContract: '0x0000000000000000000000000000000000000001' },
      TRANSFER_WITH_AUTHORIZATION_TYPES,
      payload.authorization,
      payload.signature,
    )

    expect(recoveredWrongContract).not.toBe(DELEGATE_ADDRESS)
  })

  it('does not recover to the delegate under a wrong domain name or version', async () => {
    const { payload } = decodeHeader(await buildHeader())

    for (const domain of [
      { ...BASE_USDC_DOMAIN, name: 'USDC' },
      { ...BASE_USDC_DOMAIN, version: '1' },
    ]) {
      const recovered = ethers.verifyTypedData(
        domain,
        TRANSFER_WITH_AUTHORIZATION_TYPES,
        payload.authorization,
        payload.signature,
      )
      expect(recovered).not.toBe(DELEGATE_ADDRESS)
    }
  })
})

describe('asset address byte-sensitivity', () => {
  it('echoes the accepted asset address verbatim (checksummed, not lowercased)', async () => {
    const decoded = decodeHeader(await buildHeader())
    expect(decoded.accepted.asset).toBe(BASE_USDC)
  })

  it('preserves a lowercased input asset verbatim too — the SDK never rewrites case', async () => {
    const lowercased: X402PaymentOption = { ...accepted, asset: BASE_USDC.toLowerCase() }
    const pr: X402PaymentRequired = { ...paymentRequired, accepts: [lowercased] }
    const decoded = decodeHeader(await buildHeader(makeHaven(), pr, lowercased))
    expect(decoded.accepted.asset).toBe(BASE_USDC.toLowerCase())

    // The signature is still computed over the checksummed verifyingContract
    // (the x402 library normalizes via getAddress before hashing), so
    // recovery under the canonical domain still succeeds.
    const recovered = ethers.verifyTypedData(
      BASE_USDC_DOMAIN,
      TRANSFER_WITH_AUTHORIZATION_TYPES,
      decoded.payload.authorization,
      decoded.payload.signature,
    )
    expect(recovered).toBe(DELEGATE_ADDRESS)
  })
})
