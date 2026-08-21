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
})
