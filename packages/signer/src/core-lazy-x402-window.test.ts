import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { AgentPaymentFailureCode, addressFromKey, buildX402ExpectedMessage } from '@haven_ai/sdk/edge'
import { buildFundingLegUserOp } from '@haven_ai/sdk/test-support'
import { createEdgeSigner } from './core.js'
import { createToolHandlers, type ToolPayload, type ToolSuccess } from './tools.js'

// #3173 review r2: the payment window is asserted open BEFORE the lazy
// `x402/schemes` load and again AFTER it, because the first load in a process
// costs real time. This mock makes "the load" jump the clock past the window,
// so the re-check must (a) refuse with PaymentWindowExpired and (b) retire the
// binding exactly like the first check, so a retry gets the precise remedy —
// never a header, never a dangling binding.
vi.mock('x402/schemes', () => {
  vi.setSystemTime(new Date('2099-06-01T00:00:00.000Z'))
  return {
    exact: {
      evm: {
        createPaymentHeader: async () => {
          throw new Error('a header must not be built after the window closed during the load')
        },
      },
    },
  }
})

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const BINDING_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
const PAYMENT_REQUIRED = {
  x402Version: 1,
  resource: { url: 'https://merchant.test/paid', description: 'paid data' },
  accepts: [{ scheme: 'exact', network: 'base', amount: '1000000', asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', payTo: '0x000000000000000000000000000000000000dEaD', maxTimeoutSeconds: 60 }],
}

// #3281: a REAL funding leg (the shared builder) — this key's own account
// redeeming one budget delegation, transferring the quoted amount of the
// quoted token to this key's own delegate EOA. `payloadHash` is the
// `payload_hash` `haven_sign` binds against, `digest` its `typed_data_hash`.
const FUNDING = buildFundingLegUserOp({
  delegate: addressFromKey(TEST_KEY) as `0x${string}`,
  asset: PAYMENT_REQUIRED.accepts[0].asset as `0x${string}`,
  amount: PAYMENT_REQUIRED.accepts[0].amount,
  chainId: 8453, // PAYMENT_REQUIRED's network ('base')
})
const FUNDING_TYPED_DATA = FUNDING.typedData
const HASH = FUNDING.payloadHash as string
const FUNDING_DIGEST = FUNDING.digest

async function expectedX402(expiresAt: string) {
  const expected = {
    payment_id: 'pay_x402',
    payload_hash: HASH,
    resource_url: PAYMENT_REQUIRED.resource.url,
    merchant_to: PAYMENT_REQUIRED.accepts[0].payTo,
    amount: PAYMENT_REQUIRED.accepts[0].amount,
    asset: PAYMENT_REQUIRED.accepts[0].asset,
    network: PAYMENT_REQUIRED.accepts[0].network,
    expires_at: expiresAt,
    typed_data_hash: FUNDING_DIGEST,
  }
  const message = buildX402ExpectedMessage({
    paymentId: expected.payment_id, payloadHash: expected.payload_hash, resourceUrl: expected.resource_url,
    merchantTo: expected.merchant_to, amount: expected.amount, asset: expected.asset, network: expected.network, expiresAt: expected.expires_at,
    typedDataHash: expected.typed_data_hash,
  })
  const account = privateKeyToAccount(BINDING_KEY)
  return { ...expected, auth: { version: 2 as const, message, signature: await account.signMessage({ message }), signer: account.address } }
}

function ok<T = unknown>(payload: ToolPayload): ToolSuccess<T> {
  if (!payload.success) throw new Error(`expected success, got failure: ${payload.message}`)
  return payload as ToolSuccess<T>
}

describe('the window is re-checked after the lazy x402 load (#3173 review r2)', () => {
  beforeAll(() => vi.useFakeTimers({ now: new Date('2026-09-20T00:00:00.000Z') }))
  afterAll(() => vi.useRealTimers())

  it('a window that closes during the load refuses PaymentWindowExpired and RETIRES the binding', async () => {
    const handlers = createToolHandlers(createEdgeSigner(TEST_KEY, { x402BindingSigner: privateKeyToAccount(BINDING_KEY).address }))
    // Open at the first check (30 s ahead of the fake clock) — the mocked load then jumps to 2099.
    const signed = ok<{ x402_binding: string }>(
      await handlers.haven_sign({
        payload_hash: HASH,
        typed_data: FUNDING_TYPED_DATA,
        x402_expected: await expectedX402('2026-09-20T00:00:30.000Z'),
      }),
    )
    const first = await handlers.haven_x402_sign_header({ payment_required: PAYMENT_REQUIRED, x402_binding: signed.data.x402_binding })
    if (first.success) throw new Error('expected a failure payload')
    expect(first.code).toBe(AgentPaymentFailureCode.PaymentWindowExpired)
    expect(first.statusCode).toBe(410)

    // The binding was retired with the window reason — a retry says so, and does not dangle.
    const retry = await handlers.haven_x402_sign_header({ payment_required: PAYMENT_REQUIRED, x402_binding: signed.data.x402_binding })
    if (retry.success) throw new Error('expected a failure payload')
    expect(retry.message).toMatch(/window/i)
    expect(retry.message).toMatch(/retired|no header exists/i)
  })
})
