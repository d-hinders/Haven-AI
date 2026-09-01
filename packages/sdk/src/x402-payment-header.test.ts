import { describe, expect, it } from 'vitest'
import { HavenClient } from './client.js'
import {
  validateStandardX402PaymentHeader,
  X402PaymentHeaderValidationError,
} from './x402.js'

const KEY = `0x${'12'.repeat(32)}`
const PAYMENT_REQUIRED = {
  x402Version: 2,
  resource: { url: 'https://merchant.test/paid' },
  accepts: [{
    scheme: 'exact',
    network: 'base',
    amount: '1000000',
    maxAmountRequired: '1500000',
    asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
    maxTimeoutSeconds: 60,
    extra: { name: 'USD Coin', version: '2' },
  }],
}

async function signedHeader() {
  const haven = new HavenClient({ apiKey: 'sk_agent_test', delegateKey: KEY })
  // Header minting lives on the private funding-leg module since #1618.
  const header = await (haven as unknown as {
    fundingLeg: {
      createPaymentHeader(
        paymentRequired: typeof PAYMENT_REQUIRED,
        option: (typeof PAYMENT_REQUIRED.accepts)[number],
      ): Promise<string>
    }
  }).fundingLeg.createPaymentHeader(PAYMENT_REQUIRED, PAYMENT_REQUIRED.accepts[0])
  return { header, payer: haven.delegateAddress! }
}

function context(payer: string) {
  return {
    merchantTo: PAYMENT_REQUIRED.accepts[0].payTo,
    amountAtomic: PAYMENT_REQUIRED.accepts[0].maxAmountRequired,
    asset: PAYMENT_REQUIRED.accepts[0].asset,
    network: PAYMENT_REQUIRED.accepts[0].network,
    resourceUrl: PAYMENT_REQUIRED.resource.url,
    payer,
    chainId: 8453,
  }
}

describe('validateStandardX402PaymentHeader (#1398)', () => {
  it('accepts an exact v2 header signed by the persisted delegate', async () => {
    const { header, payer } = await signedHeader()
    await expect(validateStandardX402PaymentHeader(header, context(payer))).resolves.toBeUndefined()
  })

  it('rejects malformed input with a value-free error', async () => {
    await expect(validateStandardX402PaymentHeader('not-a-header', context('0x0000000000000000000000000000000000000001')))
      .rejects.toEqual(expect.any(X402PaymentHeaderValidationError))
  })

  it('rejects an otherwise well-formed header whose signed payer differs from the intent', async () => {
    const { header } = await signedHeader()
    await expect(validateStandardX402PaymentHeader(header, context('0x0000000000000000000000000000000000000001')))
      .rejects.toEqual(expect.any(X402PaymentHeaderValidationError))
  })

  // ── #2361: the v2 envelope's resource/extensions echoes ──────────────────
  // The widened key set is EXACTLY {resource, extensions} on top of the
  // required three — each case below pins one direction of that boundary, so
  // a mutation that widens further (any-key tolerance) or narrows back (the
  // pre-#2361 3-key wall, which would refuse every echoing signer) fails.

  function rewrap(header: string, mutate: (decoded: Record<string, unknown>) => void): string {
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as Record<string, unknown>
    mutate(decoded)
    return Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64')
  }

  it('accepts the envelope with both echoes present (#2361)', async () => {
    const { header, payer } = await signedHeader()
    const withEchoes = rewrap(header, (decoded) => {
      decoded.extensions = { bazaar: { info: { method: 'GET' } } }
    })
    await expect(validateStandardX402PaymentHeader(withEchoes, context(payer))).resolves.toBeUndefined()
  })

  it('still accepts the pre-#2361 three-key envelope a v0.1.33-and-earlier signer emits', async () => {
    // The true old-signer shape, exercised end-to-end rather than inferred
    // from hasOnlyKeys' semantics: strip BOTH echoes and the validator must
    // accept — a deployed echo-less signer is never refused by the hosted
    // relay preflight.
    const { header, payer } = await signedHeader()
    const bare = rewrap(header, (decoded) => {
      delete decoded.resource
      delete decoded.extensions
    })
    const decoded = JSON.parse(Buffer.from(bare, 'base64').toString('utf8')) as Record<string, unknown>
    expect(Object.keys(decoded).sort()).toEqual(['accepted', 'payload', 'x402Version'])
    await expect(validateStandardX402PaymentHeader(bare, context(payer))).resolves.toBeUndefined()
  })

  it('still rejects a stray top-level key beyond the echoes', async () => {
    const { header, payer } = await signedHeader()
    const stray = rewrap(header, (decoded) => {
      decoded.network = 'base'
    })
    await expect(validateStandardX402PaymentHeader(stray, context(payer)))
      .rejects.toEqual(expect.any(X402PaymentHeaderValidationError))
  })

  it('rejects a non-object resource or extensions echo', async () => {
    const { header, payer } = await signedHeader()
    const badResource = rewrap(header, (decoded) => {
      decoded.resource = 'https://merchant.test/paid'
    })
    await expect(validateStandardX402PaymentHeader(badResource, context(payer)))
      .rejects.toEqual(expect.any(X402PaymentHeaderValidationError))
    const badExtensions = rewrap(header, (decoded) => {
      decoded.extensions = ['bazaar']
    })
    await expect(validateStandardX402PaymentHeader(badExtensions, context(payer)))
      .rejects.toEqual(expect.any(X402PaymentHeaderValidationError))
  })
})
