import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { decodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequired } from '@x402/core/types'
import {
  createX402PaymentProcessor,
  PaymentError,
  PAYMENT_REQUIRED_HEADER,
  USDC_ADDRESS,
  type Eip3009Authorization,
  type SettlementClient,
} from './x402.js'

const MERCHANT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a' as const
const OTHER = '0x2222222222222222222222222222222222222222' as const
const PAYER_KEY = `0x${'01'.repeat(32)}` as const
const TX_HASH = `0x${'cd'.repeat(32)}` as const

function makeProcessor(settle = vi.fn<SettlementClient['settle']>().mockResolvedValue(TX_HASH)) {
  return {
    settle,
    processor: createX402PaymentProcessor({ settle }),
  }
}

function paymentRequired(): PaymentRequired {
  return createX402PaymentProcessor({ settle: vi.fn() }).buildPaymentRequired({
    merchantAddress: MERCHANT,
    amountUsdc: 1_000n,
    resource: 'https://merchant.test/mcp',
    description: 'NordShield VPN Basic',
  })
}

async function signedHeader(
  pr: PaymentRequired,
  overrides: Partial<Eip3009Authorization> = {},
  acceptedOverrides: Partial<PaymentPayload['accepted']> = {},
): Promise<string> {
  const account = privateKeyToAccount(PAYER_KEY)
  const now = Math.floor(Date.now() / 1000)
  const accepted = { ...pr.accepts[0], ...acceptedOverrides }
  const authorization: Eip3009Authorization = {
    from: account.address,
    to: MERCHANT,
    value: accepted.amount,
    validAfter: String(now - 5),
    validBefore: String(now + 300),
    nonce: `0x${randomBytes(32).toString('hex')}`,
    ...overrides,
  }
  const signature = await account.signTypedData({
    domain: {
      name: 'USD Coin',
      version: '2',
      chainId: 8453,
      verifyingContract: USDC_ADDRESS,
    },
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
      from: authorization.from as `0x${string}`,
      to: authorization.to as `0x${string}`,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce as `0x${string}`,
    },
  })
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: pr.resource,
    accepted,
    payload: { authorization, signature },
  }
  return encodePaymentSignatureHeader(payload)
}

describe('x402 payment requirements', () => {
  it('builds a standards-aligned Base USDC payment-required response', () => {
    const { processor } = makeProcessor()
    const pr = processor.buildPaymentRequired({
      merchantAddress: MERCHANT,
      amountUsdc: 1_000n,
      resource: 'https://merchant.test/mcp',
      description: 'NordShield VPN Basic',
    })
    const header = processor.paymentRequiredHeader(pr)

    expect(PAYMENT_REQUIRED_HEADER).toBe('PAYMENT-REQUIRED')
    expect(decodePaymentRequiredHeader(header)).toEqual(pr)
    expect(pr).toMatchObject({
      x402Version: 2,
      resource: { url: 'https://merchant.test/mcp', mimeType: 'application/json' },
      accepts: [{
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '1000',
        payTo: MERCHANT,
        asset: USDC_ADDRESS,
        extra: { name: 'USD Coin', version: '2' },
      }],
    })
  })
})

describe('x402 payment verification and settlement', () => {
  it('settles a valid payment and returns a standard payment response header', async () => {
    const { processor, settle } = makeProcessor()
    const pr = paymentRequired()
    const header = await signedHeader(pr)

    const payment = await processor.verifyAndSettle({
      productId: 'vpn_basic',
      paymentHeader: header,
      merchantAddress: MERCHANT,
      expectedAmount: 1_000n,
      paymentRequired: pr,
    })

    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle.mock.calls[0][0]).toMatchObject({ to: MERCHANT, value: '1000' })
    expect(payment.txHash).toBe(TX_HASH)
    expect(payment.paymentResponse).toMatchObject({
      success: true,
      transaction: TX_HASH,
      network: 'eip155:8453',
      amount: '1000',
    })
    expect(payment.paymentResponseHeader).toBeTruthy()
  })

  it('dedupes a repeated payment for the same product in process memory', async () => {
    const { processor, settle } = makeProcessor()
    const pr = paymentRequired()
    const header = await signedHeader(pr)
    const input = {
      productId: 'vpn_basic' as const,
      paymentHeader: header,
      merchantAddress: MERCHANT,
      expectedAmount: 1_000n,
      paymentRequired: pr,
    }

    const first = await processor.verifyAndSettle(input)
    const second = await processor.verifyAndSettle(input)

    expect(first).toBe(second)
    expect(settle).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['wrong recipient', { to: OTHER }, undefined, 'not addressed'],
    ['wrong amount', { value: '999' }, undefined, 'Payment amount does not match'],
    ['expired authorization', { validBefore: '1' }, undefined, 'expired'],
    ['future validAfter', { validAfter: String(Math.floor(Date.now() / 1000) + 600) }, undefined, 'not valid yet'],
    ['mismatched accepted option', {}, { maxTimeoutSeconds: 299 }, 'accepted option does not match'],
  ] as const)('rejects %s', async (_name, authOverrides, acceptedOverrides, message) => {
    const { processor } = makeProcessor()
    const pr = paymentRequired()
    const header = await signedHeader(pr, authOverrides, acceptedOverrides)

    await expect(processor.verifyAndSettle({
      productId: 'vpn_basic',
      paymentHeader: header,
      merchantAddress: MERCHANT,
      expectedAmount: 1_000n,
      paymentRequired: pr,
    })).rejects.toThrow(message)
  })

  it('rejects a malformed nonce', async () => {
    const { processor } = makeProcessor()
    const pr = paymentRequired()
    const payload = decodePaymentSignatureHeader(await signedHeader(pr)) as PaymentPayload
    payload.payload = {
      ...payload.payload,
      authorization: {
        ...(payload.payload.authorization as Record<string, unknown>),
        nonce: '0x1234',
      },
    }

    await expect(processor.verifyAndSettle({
      productId: 'vpn_basic',
      paymentHeader: encodePaymentSignatureHeader(payload),
      merchantAddress: MERCHANT,
      expectedAmount: 1_000n,
      paymentRequired: pr,
    })).rejects.toThrow('nonce must be 32 bytes')
  })

  it('rejects a bad signature', async () => {
    const { processor } = makeProcessor()
    const pr = paymentRequired()
    const header = await signedHeader(pr, { from: OTHER })

    await expect(processor.verifyAndSettle({
      productId: 'vpn_basic',
      paymentHeader: header,
      merchantAddress: MERCHANT,
      expectedAmount: 1_000n,
      paymentRequired: pr,
    })).rejects.toBeInstanceOf(PaymentError)
  })
})
