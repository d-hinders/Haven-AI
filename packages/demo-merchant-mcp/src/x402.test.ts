import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { decodePaymentRequiredHeader, decodePaymentSignatureHeader, encodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequired } from '@x402/core/types'
import {
  createX402PaymentProcessor,
  DEMO_MERCHANT_EXTENSIONS,
  PaymentError,
  SettlementRevertedError,
  PAYMENT_REQUIRED_HEADER,
  USDC_ADDRESS,
  type Eip3009Authorization,
  type SettlementClient,
} from './x402.js'
import {
  TRUSTED_DELEGATION_MANAGER,
  hostedMerchantBaseUrlForChain,
  isTrustedDelegationManagerForChain,
  merchantEnvironmentForChain,
  trustedDelegationManagerForChain,
} from './products.js'

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
    // #2361: echo the challenge's extensions — the spec MUST this merchant
    // now enforces, so the fixture client behaves like a compliant one.
    ...(pr.extensions ? { extensions: pr.extensions } : {}),
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
  it('maps dev and prod chains to the correct hosted merchant URLs', () => {
    expect(merchantEnvironmentForChain(84532)).toBe('dev')
    expect(hostedMerchantBaseUrlForChain(84532)).toBe('https://demo-merchant-dev-84e4.up.railway.app')
    expect(merchantEnvironmentForChain(8453)).toBe('prod')
    expect(hostedMerchantBaseUrlForChain(8453)).toBe('https://enthusiastic-blessing-production-171f.up.railway.app')
  })

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

  it('pins the same trusted DelegationManager for hosted Base environments', () => {
    expect(trustedDelegationManagerForChain(8453)).toBe(TRUSTED_DELEGATION_MANAGER)
    expect(trustedDelegationManagerForChain(84532)).toBe(TRUSTED_DELEGATION_MANAGER)
    expect(isTrustedDelegationManagerForChain(TRUSTED_DELEGATION_MANAGER, 8453)).toBe(true)
    expect(isTrustedDelegationManagerForChain('0x000000000000000000000000000000000000dEaD', 8453)).toBe(false)
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

  // ── #2361: the x402 v2 extensions-echo rule, enforced ─────────────────────
  // "The client must include at least the info received; it may append
  // additional info but cannot delete or overwrite existing info." This
  // merchant enforcing it is what stops the QA harness validating
  // Haven-against-Haven — a Haven client that stops echoing fails HERE,
  // on Sepolia, instead of at the first strict mainnet facilitator (#2360).
  describe('extensions echo rule (#2361)', () => {
    function settleInput(pr: PaymentRequired, header: string) {
      return {
        productId: 'vpn_basic' as const,
        paymentHeader: header,
        merchantAddress: MERCHANT,
        expectedAmount: 1_000n,
        paymentRequired: pr,
      }
    }

    it('the 402 challenge advertises the extensions block the rule enforces', () => {
      const pr = paymentRequired()
      expect(pr.extensions).toEqual(DEMO_MERCHANT_EXTENSIONS)
    })

    it('rejects a payment that DROPS the advertised extensions', async () => {
      const { processor } = makeProcessor()
      const pr = paymentRequired()
      const payload = decodePaymentSignatureHeader(await signedHeader(pr)) as PaymentPayload
      delete (payload as { extensions?: unknown }).extensions

      await expect(processor.verifyAndSettle(settleInput(pr, encodePaymentSignatureHeader(payload))))
        .rejects.toThrow('must echo the challenge\'s extensions')
    })

    it('rejects a version-mismatch dodge: declaring x402Version 1 does not skip the echo rule', async () => {
      // Reviewer probe on #2361: the first cut early-returned on
      // `payload.x402Version !== 2`, so a payload that dropped the echo AND
      // declared v1 settled successfully. This merchant only issues v2
      // challenges — a version mismatch is a refusal, never an exemption.
      const { processor } = makeProcessor()
      const pr = paymentRequired()
      const payload = decodePaymentSignatureHeader(await signedHeader(pr)) as PaymentPayload
      delete (payload as { extensions?: unknown }).extensions
      ;(payload as { x402Version: number }).x402Version = 1

      await expect(processor.verifyAndSettle(settleInput(pr, encodePaymentSignatureHeader(payload))))
        .rejects.toThrow('does not match the challenge')
    })

    it('rejects a version mismatch even when the extensions are echoed PERFECTLY', async () => {
      // #2397: the dodge test above mismatches the version AND drops the echo,
      // so it pins the ORDER — move the version check below the subset check
      // and that test fails, because the dropped echo is caught first and the
      // message changes. What it does NOT pin is that the version check runs
      // at all when the echo is fine. This one does: the echo is byte-perfect,
      // so the version check is the only thing that can refuse this payload,
      // and it has to do so unconditionally rather than as an exemption.
      // Measured, not assumed — gate the version check on a missing echo and
      // this is the only test in the file that fails.
      const { processor, submit } = makeProcessor()
      const pr = paymentRequired()
      const payload = decodePaymentSignatureHeader(await signedHeader(pr)) as PaymentPayload
      // Precondition: the helper really did echo the challenge verbatim, so a
      // later change to signedHeader cannot quietly turn this into the drop case.
      expect((payload as { extensions?: unknown }).extensions).toEqual(DEMO_MERCHANT_EXTENSIONS)
      ;(payload as { x402Version: number }).x402Version = 1

      await expect(processor.verifyAndSettle(settleInput(pr, encodePaymentSignatureHeader(payload))))
        .rejects.toThrow('does not match the challenge')
      expect(submit).not.toHaveBeenCalled()
    })

    it('rejects a payment that OVERWRITES advertised extension info', async () => {
      const { processor } = makeProcessor()
      const pr = paymentRequired()
      const payload = decodePaymentSignatureHeader(await signedHeader(pr)) as PaymentPayload
      ;(payload as { extensions?: Record<string, unknown> }).extensions = {
        'haven-demo': { version: '999', echoRule: 'rewritten' },
      }

      await expect(processor.verifyAndSettle(settleInput(pr, encodePaymentSignatureHeader(payload))))
        .rejects.toThrow('append-only, never delete or overwrite')
    })

    it('accepts a payment that APPENDS to the echoed extensions', async () => {
      const { processor, submit } = makeProcessor()
      const pr = paymentRequired()
      const payload = decodePaymentSignatureHeader(await signedHeader(pr)) as PaymentPayload
      ;(payload as { extensions?: Record<string, unknown> }).extensions = {
        ...DEMO_MERCHANT_EXTENSIONS,
        clientNote: { sdk: 'haven' },
      }

      const settled = await processor.verifyAndSettle(
        settleInput(pr, encodePaymentSignatureHeader(payload)),
      )
      expect(settled.txHash).toBe(TX_HASH)
      expect(submit).toHaveBeenCalledTimes(1)
    })

    // #2403: the branches below were documented in the README (#2383) from
    // code inspection and a live capture, and pinned by nothing. Each one is
    // mutation-proven against the specific guard it covers; the mutation that
    // reds it by name is recorded on the PR.
    it.each([
      ['an array', [DEMO_MERCHANT_EXTENSIONS]],
      ['a string', 'haven-demo'],
      ['null', null],
    ])('rejects an echo that is %s rather than an object', async (_shape, echoed) => {
      const { processor, submit } = makeProcessor()
      const pr = paymentRequired()
      const payload = decodePaymentSignatureHeader(await signedHeader(pr)) as PaymentPayload
      ;(payload as { extensions?: unknown }).extensions = echoed

      await expect(processor.verifyAndSettle(settleInput(pr, encodePaymentSignatureHeader(payload))))
        .rejects.toThrow('must echo the challenge\'s extensions')
      expect(submit).not.toHaveBeenCalled()
    })

    it('rejects an echo that DROPS the advertised top-level key', async () => {
      const { processor, submit } = makeProcessor()
      const pr = paymentRequired()
      const payload = decodePaymentSignatureHeader(await signedHeader(pr)) as PaymentPayload
      // An object, so the presence guard passes; the advertised `haven-demo`
      // key is gone, so containment is what has to refuse it.
      ;(payload as { extensions?: Record<string, unknown> }).extensions = { clientNote: { sdk: 'haven' } }

      await expect(processor.verifyAndSettle(settleInput(pr, encodePaymentSignatureHeader(payload))))
        .rejects.toThrow('append-only, never delete or overwrite')
      expect(submit).not.toHaveBeenCalled()
    })

    it('rejects an echo that DROPS a nested advertised key (echoRule)', async () => {
      const { processor, submit } = makeProcessor()
      const pr = paymentRequired()
      const payload = decodePaymentSignatureHeader(await signedHeader(pr)) as PaymentPayload
      // The top-level key is present and `version` is unchanged; only the
      // nested `echoRule` is missing, so this reaches the recursive branch of
      // objectContainsSubset and nothing shallower can refuse it.
      ;(payload as { extensions?: Record<string, unknown> }).extensions = {
        'haven-demo': { version: DEMO_MERCHANT_EXTENSIONS['haven-demo'].version },
      }

      await expect(processor.verifyAndSettle(settleInput(pr, encodePaymentSignatureHeader(payload))))
        .rejects.toThrow('append-only, never delete or overwrite')
      expect(submit).not.toHaveBeenCalled()
    })

    it('rejects an EMPTY extensions object — {} is an object, not an echo', async () => {
      const { processor, submit } = makeProcessor()
      const pr = paymentRequired()
      const payload = decodePaymentSignatureHeader(await signedHeader(pr)) as PaymentPayload
      ;(payload as { extensions?: Record<string, unknown> }).extensions = {}

      await expect(processor.verifyAndSettle(settleInput(pr, encodePaymentSignatureHeader(payload))))
        .rejects.toThrow('append-only, never delete or overwrite')
      expect(submit).not.toHaveBeenCalled()
    })

    it('accepts a payment without an echo when the challenge advertised no extensions', async () => {
      // The rule is keyed on what the CHALLENGE advertised. This merchant
      // always advertises, so the branch is defensive — but it is the
      // difference between "echo what you were given" and "always send
      // extensions", and the spec MUST is the former.
      const { processor, submit } = makeProcessor()
      const pr = paymentRequired()
      delete (pr as { extensions?: unknown }).extensions
      // The helper echoes only what the challenge carries, so this payload has
      // no `extensions` at all.
      const payload = decodePaymentSignatureHeader(await signedHeader(pr)) as PaymentPayload
      expect((payload as { extensions?: unknown }).extensions).toBeUndefined()

      const settled = await processor.verifyAndSettle(
        settleInput(pr, encodePaymentSignatureHeader(payload)),
      )
      expect(settled.txHash).toBe(TX_HASH)
      expect(submit).toHaveBeenCalledTimes(1)
    })
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
