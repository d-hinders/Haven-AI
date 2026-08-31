/**
 * #2290: the signer half of the funded-but-undelivered resume path.
 *
 * The backend now serves `GET /x402/:id/sign-context` for an eip3009 x402
 * intent whose funding leg confirmed but whose merchant leg was never
 * delivered, and for that state ONLY it mints a fresh `expires_at` into the
 * Haven-signed expected context instead of re-serving the row's spent quote
 * window. That decision is invisible from the backend's own tests: what makes
 * it necessary lives here, in `assertX402PaymentWindowOpen`.
 *
 * So this proves the mechanism from the signer's side, with the stale window
 * as its own control:
 *
 * - a funded-retry context (v2, fresh window) mints a binding and builds a
 *   real merchant header, with no funding submit anywhere in the flow;
 * - the SAME context carrying the window the stored row would have supplied
 *   is refused, and refused for the window rather than for the binding.
 *
 * Without the second case the first proves only that a header can be built —
 * not that minting the window fresh was load-bearing. The backend test that
 * asserts a future `expires_at` on the wire cannot reach that conclusion,
 * because nothing over there consumes the value.
 */
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { hashTypedData } from 'viem'
import { buildX402ExpectedMessage } from '@haven_ai/sdk'
import { createEdgeSigner } from './core.js'
import { createToolHandlers, type ToolPayload } from './tools.js'

/** Narrow the tool union, surfacing the refusal message when it went the other way. */
function ok(payload: ToolPayload): { success: true; data: unknown } {
  if (!payload.success) throw new Error(`expected success, got failure: ${payload.message}`)
  return payload
}
function refused(payload: ToolPayload): { success: false; message: string } {
  if (payload.success) throw new Error('expected a refusal, got success')
  return payload
}

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const BINDING_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
const BINDING_SIGNER = privateKeyToAccount(BINDING_KEY).address
const PAYMENT_ID = 'pay_funded_retry'
const FUNDING_HASH = '0x' + 'cd'.repeat(32)

/**
 * The merchant's own EIP-712 domain, carried through the rebuild by
 * `machine_metadata.payment_required` (#1355) rather than inferred from the
 * network. A wrong domain yields a signature the facilitator rejects, which
 * is why the backend re-serves the stored blob verbatim.
 */
const MERCHANT_EXTRA = { name: 'USD Coin', version: '2' }

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
      extra: MERCHANT_EXTRA,
    },
  ],
}

/** Stands in for the funding UserOp typed data the rebuild re-serves. */
const TYPED_DATA = {
  domain: { name: 'HavenFundedRetry', version: '1', chainId: 8453 },
  types: { Payload: [{ name: 'hash', type: 'bytes32' }] },
  primaryType: 'Payload',
  message: { hash: FUNDING_HASH },
}

/** The window the funded-retry rebuild mints: `now + 10 minutes`. */
const FRESH_WINDOW = new Date(Date.now() + 10 * 60 * 1000).toISOString()
/** The window the stored row carries: the quote that bounded the spent leg. */
const SPENT_QUOTE_WINDOW = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()

/**
 * A v2 expected context exactly as `rebuildDelegationSignContext` emits it for
 * a funded retry — same payload hash, same typed-data digest commitment, only
 * `expiresAt` varying between the two cases.
 */
async function fundedRetryContext(expiresAt: string) {
  const context = {
    paymentId: PAYMENT_ID,
    payloadHash: FUNDING_HASH,
    resourceUrl: PAYMENT_REQUIRED.resource.url,
    merchantTo: PAYMENT_REQUIRED.accepts[0].payTo,
    amount: PAYMENT_REQUIRED.accepts[0].amount,
    asset: PAYMENT_REQUIRED.accepts[0].asset,
    network: PAYMENT_REQUIRED.accepts[0].network,
    expiresAt,
    typedDataHash: hashTypedData(TYPED_DATA as never),
  }
  const message = buildX402ExpectedMessage(context as never)
  const account = privateKeyToAccount(BINDING_KEY)
  return {
    payment_id: context.paymentId,
    payload_hash: context.payloadHash,
    resource_url: context.resourceUrl,
    merchant_to: context.merchantTo,
    amount: context.amount,
    asset: context.asset,
    network: context.network,
    expires_at: context.expiresAt,
    typed_data_hash: context.typedDataHash,
    auth: {
      version: 2 as const,
      message,
      signature: await account.signMessage({ message }),
      signer: account.address,
    },
  }
}

function handlers() {
  return createToolHandlers(createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER }))
}

describe('#2290 — a funded-retry context builds a merchant header', () => {
  it('mints a binding and builds a real header from the fresh window', async () => {
    const tools = handlers()
    const signed = ok(
      await tools.haven_sign_x402({
        payload_hash: FUNDING_HASH,
        typed_data: TYPED_DATA,
        x402_expected: await fundedRetryContext(FRESH_WINDOW),
        payment_required: PAYMENT_REQUIRED,
      }),
    )

    const data = signed.data as { x402_binding: string; payment_header: string }
    expect(data.x402_binding).toBeTruthy()
    // The deliverable: a non-empty header the agent can retry the merchant
    // with. Nothing in this flow submits a funding transaction — the signer
    // has no network seam, and the funding leg is already on-chain.
    expect(typeof data.payment_header).toBe('string')
    expect(data.payment_header.length).toBeGreaterThan(0)
  })

  it('carries the merchant EIP-712 domain into the header it builds', async () => {
    const tools = handlers()
    const signed = ok(
      await tools.haven_sign_x402({
        payload_hash: FUNDING_HASH,
        typed_data: TYPED_DATA,
        x402_expected: await fundedRetryContext(FRESH_WINDOW),
        payment_required: PAYMENT_REQUIRED,
      }),
    )
    // The signer picks the accepted option from the merchant's own blob, so
    // the domain it signs against is the merchant's rather than a default
    // inferred from `network`.
    const accepted = (signed.data as { accepted: { extra?: unknown } }).accepted
    expect(accepted.extra).toEqual(MERCHANT_EXTRA)
  })

  it('CONTROL: the spent quote window is refused — the fresh mint is load-bearing', async () => {
    // Byte-for-byte the same context but for `expires_at`, and Haven-signed
    // over that value too, so this is the window check refusing and not the
    // binding check. Re-serving the stored row here would have left the whole
    // #2290 path inert for exactly the payments it exists to rescue.
    const tools = handlers()
    const signed = refused(
      await tools.haven_sign_x402({
        payload_hash: FUNDING_HASH,
        typed_data: TYPED_DATA,
        x402_expected: await fundedRetryContext(SPENT_QUOTE_WINDOW),
        payment_required: PAYMENT_REQUIRED,
      }),
    )
    expect(signed.message).toMatch(/window expired/i)
  })
})
