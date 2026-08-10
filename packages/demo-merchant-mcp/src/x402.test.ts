import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { decodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequired } from '@x402/core/types'
import {
  createX402PaymentProcessor,
  PaymentError,
  SettlementRevertedError,
  PAYMENT_REQUIRED_HEADER,
  USDC_ADDRESS,
  type Eip3009Authorization,
  type SettlementClient,
} from './x402.js'

const MERCHANT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a' as const
const OTHER = '0x2222222222222222222222222222222222222222' as const
const PAYER_KEY = `0x${'01'.repeat(32)}` as const
const TX_HASH = `0x${'cd'.repeat(32)}` as const

function makeProcessor(client: Partial<SettlementClient> = {}) {
  const submit = vi.fn<SettlementClient['submit']>().mockResolvedValue(TX_HASH)
  const waitForReceipt = vi.fn<SettlementClient['waitForReceipt']>().mockResolvedValue(undefined)
  const settlementClient: SettlementClient = {
    submit,
    waitForReceipt,
    ...client,
  }
  return {
    settlementClient,
    submit: (client.submit ?? submit) as typeof submit,
    waitForReceipt: (client.waitForReceipt ?? waitForReceipt) as typeof waitForReceipt,
    processor: createX402PaymentProcessor(settlementClient),
  }
}

function paymentRequired(): PaymentRequired {
  return createX402PaymentProcessor({
    submit: vi.fn(),
    waitForReceipt: vi.fn(),
  }).buildPaymentRequired({
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

describe('formatUsdc precision (#1279)', () => {
  it('renders past-2^53 base units exactly — no Number round-trip', async () => {
    const { formatUsdc } = await import('./products.js')
    // 2^60 base units: Number-math renders ...770.981888, bigint math is exact.
    expect(formatUsdc(1152921504606846976n)).toBe('1152921504606.846976')
    expect(formatUsdc(1_000n)).toBe('0.001')
    expect(formatUsdc(0n)).toBe('0')
    expect(formatUsdc(500n)).toBe('0.0005')
  })
})

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
    const { processor, submit, waitForReceipt } = makeProcessor()
    const pr = paymentRequired()
    const header = await signedHeader(pr)

    const payment = await processor.verifyAndSettle({
      productId: 'vpn_basic',
      paymentHeader: header,
      merchantAddress: MERCHANT,
      expectedAmount: 1_000n,
      paymentRequired: pr,
    })

    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0][0]).toMatchObject({ to: MERCHANT, value: '1000' })
    expect(waitForReceipt).toHaveBeenCalledWith(TX_HASH)
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
    const { processor, submit } = makeProcessor()
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
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('retries receipt confirmation without resubmitting after a submitted tx times out', async () => {
    const waitForReceipt = vi
      .fn<SettlementClient['waitForReceipt']>()
      .mockRejectedValueOnce(new Error('receipt timeout'))
      .mockResolvedValueOnce(undefined)
    const { processor, submit } = makeProcessor({ waitForReceipt })
    const pr = paymentRequired()
    const header = await signedHeader(pr)
    const input = {
      productId: 'vpn_basic' as const,
      paymentHeader: header,
      merchantAddress: MERCHANT,
      expectedAmount: 1_000n,
      paymentRequired: pr,
    }

    await expect(processor.verifyAndSettle(input)).rejects.toThrow('receipt timeout')
    const retry = await processor.verifyAndSettle(input)

    expect(retry.txHash).toBe(TX_HASH)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(waitForReceipt).toHaveBeenCalledTimes(2)
  })

  it('RESUBMITS after a mined-and-reverted settlement tx — the dead hash is not retried forever (#1278)', async () => {
    // A revert is final for the SUBMISSION, not the authorization. Before the
    // fix the attempt kept its txHash, so every replay re-confirmed the same
    // dead hash and the buyer could never complete this authorization.
    const secondTx = `0x${'ee'.repeat(32)}` as const
    const submit = vi
      .fn<SettlementClient['submit']>()
      .mockResolvedValueOnce(TX_HASH)
      .mockResolvedValueOnce(secondTx)
    const waitForReceipt = vi
      .fn<SettlementClient['waitForReceipt']>()
      .mockRejectedValueOnce(new SettlementRevertedError(`USDC settlement transaction reverted on-chain: ${TX_HASH}`))
      .mockResolvedValueOnce(undefined)
    const { processor } = makeProcessor({ submit, waitForReceipt })
    const pr = paymentRequired()
    const header = await signedHeader(pr)
    const input = {
      productId: 'vpn_basic' as const,
      paymentHeader: header,
      merchantAddress: MERCHANT,
      expectedAmount: 1_000n,
      paymentRequired: pr,
    }

    await expect(processor.verifyAndSettle(input)).rejects.toThrow(/reverted on-chain.*resubmit/s)
    const retry = await processor.verifyAndSettle(input)

    expect(retry.txHash).toBe(secondTx)
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('a transient receipt error still re-confirms the SAME hash — no double submit (#1278)', async () => {
    // The counterpart guard: only a PROVEN revert clears the attempt. A
    // transient fetch failure must keep the hash, else a slow-but-successful
    // tx could be double-submitted.
    const waitForReceipt = vi
      .fn<SettlementClient['waitForReceipt']>()
      .mockRejectedValueOnce(new Error('rpc hiccup'))
      .mockResolvedValueOnce(undefined)
    const { processor, submit } = makeProcessor({ waitForReceipt })
    const pr = paymentRequired()
    const header = await signedHeader(pr)
    const input = {
      productId: 'vpn_basic' as const,
      paymentHeader: header,
      merchantAddress: MERCHANT,
      expectedAmount: 1_000n,
      paymentRequired: pr,
    }

    await expect(processor.verifyAndSettle(input)).rejects.toThrow('rpc hiccup')
    const retry = await processor.verifyAndSettle(input)
    expect(retry.txHash).toBe(TX_HASH)
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('a process restart cannot double-deliver: on-chain nonce uniqueness is the backstop (#1279)', async () => {
    // The in-memory attempts/settled maps die with the process. A replayed
    // header against a FRESH processor re-runs submit(), and the real chain
    // rejects the reused EIP-3009 nonce — goods must NOT be delivered on that
    // rejection. This is the restart semantics the audit found untested.
    const pr = paymentRequired()
    const header = await signedHeader(pr)
    const input = {
      productId: 'vpn_basic' as const,
      paymentHeader: header,
      merchantAddress: MERCHANT,
      expectedAmount: 1_000n,
      paymentRequired: pr,
    }

    const first = makeProcessor()
    const settledFirst = await first.processor.verifyAndSettle(input)
    expect(settledFirst.txHash).toBe(TX_HASH)

    // "Restart": a brand-new processor with empty maps, against chain state
    // where the nonce is now used — submit reverts.
    const submit = vi
      .fn<SettlementClient['submit']>()
      .mockRejectedValue(new Error('execution reverted: authorization is used'))
    const second = makeProcessor({ submit })
    await expect(second.processor.verifyAndSettle(input)).rejects.toThrow('authorization is used')
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('the same authorization cannot settle a DIFFERENT product on the 3009 rail (#1279)', async () => {
    // Pinned on the erc7710 rail only until now; the cross-product guard is
    // shared code and the 3009 twin keeps it honest for both.
    const pr = paymentRequired()
    const header = await signedHeader(pr)
    const { processor } = makeProcessor()
    const base = {
      paymentHeader: header,
      merchantAddress: MERCHANT,
      expectedAmount: 1_000n,
      paymentRequired: pr,
    }

    await processor.verifyAndSettle({ ...base, productId: 'vpn_basic' as const })
    await expect(
      processor.verifyAndSettle({ ...base, productId: 'vpn_pro' as const }),
    ).rejects.toThrow('already settled a different product')
  })

  it('validBefore = 0 is refused as expired — EIP-3009 means never-valid, not no-expiry (#1279)', async () => {
    const pr = paymentRequired()
    const header = await signedHeader(pr, { validBefore: '0' })
    const { processor } = makeProcessor()
    await expect(
      processor.verifyAndSettle({
        productId: 'vpn_basic' as const,
        paymentHeader: header,
        merchantAddress: MERCHANT,
        expectedAmount: 1_000n,
        paymentRequired: pr,
      }),
    ).rejects.toThrow('expired')
  })

  it('a validity window far past the quoted timeout is refused (#1279)', async () => {
    const pr = paymentRequired()
    const now = Math.floor(Date.now() / 1000)
    const header = await signedHeader(pr, { validBefore: String(now + 365 * 24 * 3600) })
    const { processor } = makeProcessor()
    await expect(
      processor.verifyAndSettle({
        productId: 'vpn_basic' as const,
        paymentHeader: header,
        merchantAddress: MERCHANT,
        expectedAmount: 1_000n,
        paymentRequired: pr,
      }),
    ).rejects.toThrow('far longer than the quoted')
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
