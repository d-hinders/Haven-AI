/**
 * Regression test for the x402 merchant-leg transport bug.
 *
 * `haven_x402_sign_header`'s `payment_required` param was typed `z.unknown()`,
 * which serialises to empty JSON Schema `{}`. Some MCP clients then send the
 * object as a JSON *string*, so `paymentRequired.accepts` was `undefined` and
 * header building failed with "No compatible payment option found". The tool
 * handler now parses a stringified value defensively. This test exercises the
 * handler (not just the EdgeSigner) with a stringified payment_required.
 */
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { buildX402ExpectedMessage } from '@haven_ai/sdk'
import { createEdgeSigner } from './core.js'
import { createToolHandlers } from './tools.js'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const BINDING_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
const BINDING_SIGNER = privateKeyToAccount(BINDING_KEY).address
const FUNDING_HASH = '0x' + 'cd'.repeat(32)
// expires_at is part of the signed binding and required by the tool schema, so
// every x402_expected fixture carries it (matching the hosted server's output).
const EXPIRES_AT = '2099-01-01T00:00:00.000Z'

const PAYMENT_REQUIRED = {
  x402Version: 2,
  resource: { url: 'https://merchant.test/paid', description: 'paid data' },
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      amount: '40000',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      payTo: '0x000000000000000000000000000000000000dEaD',
      maxTimeoutSeconds: 300,
    },
  ],
}

async function expectedX402() {
  const context = {
    paymentId: 'pay_x402',
    payloadHash: FUNDING_HASH,
    resourceUrl: PAYMENT_REQUIRED.resource.url,
    merchantTo: PAYMENT_REQUIRED.accepts[0].payTo,
    amount: PAYMENT_REQUIRED.accepts[0].amount,
    asset: PAYMENT_REQUIRED.accepts[0].asset,
    network: PAYMENT_REQUIRED.accepts[0].network,
    expiresAt: EXPIRES_AT,
  }
  const message = buildX402ExpectedMessage(context)
  const account = privateKeyToAccount(BINDING_KEY)
  return { ...context, auth: { version: 1 as const, message, signature: await account.signMessage({ message }), signer: account.address } }
}

function ok(payload: { success: boolean; data?: unknown; message?: string }): { success: true; data: unknown } {
  if (!payload.success) throw new Error(`expected success, got failure: ${payload.message}`)
  return payload as { success: true; data: unknown }
}

describe('haven_x402_sign_header transport robustness', () => {
  async function bindingFor(handlers: ReturnType<typeof createToolHandlers>) {
    const signed = ok(
      await handlers.haven_sign({
        payload_hash: FUNDING_HASH,
        x402_expected: {
          payment_id: 'pay_x402',
          payload_hash: FUNDING_HASH,
          resource_url: PAYMENT_REQUIRED.resource.url,
          merchant_to: PAYMENT_REQUIRED.accepts[0].payTo,
          amount: PAYMENT_REQUIRED.accepts[0].amount,
          asset: PAYMENT_REQUIRED.accepts[0].asset,
          network: PAYMENT_REQUIRED.accepts[0].network,
          expires_at: EXPIRES_AT,
          auth: (await expectedX402()).auth,
        },
      }),
    )
    return (signed.data as { x402_binding: string }).x402_binding
  }

  it('builds a header when payment_required arrives as a JSON STRING (the transport bug)', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const handlers = createToolHandlers(signer)
    const x402Binding = await bindingFor(handlers)

    const result = ok(
      await handlers.haven_x402_sign_header({
        // The bug: the object serialised to a string by the MCP transport.
        payment_required: JSON.stringify(PAYMENT_REQUIRED),
        x402_binding: x402Binding,
      }),
    )
    expect(typeof (result.data as { payment_header: string }).payment_header).toBe('string')
    expect((result.data as { payment_header: string }).payment_header.length).toBeGreaterThan(0)
  })

  it('still works when payment_required arrives as a proper object', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const handlers = createToolHandlers(signer)
    const x402Binding = await bindingFor(handlers)

    const result = ok(
      await handlers.haven_x402_sign_header({
        payment_required: PAYMENT_REQUIRED,
        x402_binding: x402Binding,
      }),
    )
    expect((result.data as { payment_header: string }).payment_header.length).toBeGreaterThan(0)
  })
})

describe('haven_sign_x402 (one-shot funding + header signing)', () => {
  it('signs the funding hash AND builds the merchant header in one call', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const handlers = createToolHandlers(signer)

    const result = ok(
      await handlers.haven_sign_x402({
        payload_hash: FUNDING_HASH,
        x402_expected: {
          payment_id: 'pay_x402',
          payload_hash: FUNDING_HASH,
          resource_url: PAYMENT_REQUIRED.resource.url,
          merchant_to: PAYMENT_REQUIRED.accepts[0].payTo,
          amount: PAYMENT_REQUIRED.accepts[0].amount,
          asset: PAYMENT_REQUIRED.accepts[0].asset,
          network: PAYMENT_REQUIRED.accepts[0].network,
          expires_at: EXPIRES_AT,
          auth: (await expectedX402()).auth,
        },
        payment_required: PAYMENT_REQUIRED,
      }),
    )

    const data = result.data as {
      signature: string
      x402_binding: string
      payment_header: string
      accepted: unknown
    }
    expect(data.signature).toMatch(/^0x[0-9a-f]+$/i)
    expect(data.x402_binding.length).toBeGreaterThan(0)
    expect(typeof data.payment_header).toBe('string')
    expect(data.payment_header.length).toBeGreaterThan(0)
    expect(data.accepted).toBeDefined()
  })

  it('coerces a stringified payment_required in the one-shot path too', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const handlers = createToolHandlers(signer)

    const result = ok(
      await handlers.haven_sign_x402({
        payload_hash: FUNDING_HASH,
        x402_expected: {
          payment_id: 'pay_x402',
          payload_hash: FUNDING_HASH,
          resource_url: PAYMENT_REQUIRED.resource.url,
          merchant_to: PAYMENT_REQUIRED.accepts[0].payTo,
          amount: PAYMENT_REQUIRED.accepts[0].amount,
          asset: PAYMENT_REQUIRED.accepts[0].asset,
          network: PAYMENT_REQUIRED.accepts[0].network,
          expires_at: EXPIRES_AT,
          auth: (await expectedX402()).auth,
        },
        payment_required: JSON.stringify(PAYMENT_REQUIRED),
      }),
    )
    expect((result.data as { payment_header: string }).payment_header.length).toBeGreaterThan(0)
  })
})
