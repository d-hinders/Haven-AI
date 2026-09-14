/**
 * The MERCHANT_SKIP_SETTLE_PRODUCT chain guard: the verify-without-settle QA
 * hook (#603) hands out goods against a merely well-FORMED authorization — no
 * settlement, and the only balance check lives inside the settlement call it
 * skips. A copy-pasted env var must not be able to enable that on mainnet.
 * Module-load guard, so each case re-imports x402.ts fresh under stubbed env.
 */
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { encodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequired } from '@x402/core/types'

const MERCHANT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a' as const
const PAYER_KEY = `0x${'01'.repeat(32)}` as const
const ZERO_TX_HASH = `0x${'0'.repeat(64)}`

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  vi.restoreAllMocks()
})

async function importX402With(env: Record<string, string>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  return import('./x402.js')
}

/** Self-contained eip3009 signer, mirroring x402.test.ts's `signedHeader` —
 *  duplicated (not imported) because this suite dynamically re-imports
 *  x402.js per case, and the domain's `chainId`/`name`/`version` must come
 *  from the SAME freshly-loaded module graph as the processor under test. */
async function signSkipSettleHeader(
  mod: typeof import('./x402.js'),
  chainId: number,
  pr: PaymentRequired,
): Promise<string> {
  const account = privateKeyToAccount(PAYER_KEY)
  const now = Math.floor(Date.now() / 1000)
  const accepted = pr.accepts[0]
  const authorization = {
    from: account.address,
    to: MERCHANT,
    value: accepted.amount,
    validAfter: String(now - 5),
    validBefore: String(now + 300),
    nonce: `0x${randomBytes(32).toString('hex')}`,
  }
  const signature = await account.signTypedData({
    domain: {
      name: accepted.extra?.name as string,
      version: accepted.extra?.version as string,
      chainId,
      verifyingContract: mod.USDC_ADDRESS,
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
      from: authorization.from,
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
    ...(pr.extensions ? { extensions: pr.extensions } : {}),
  }
  return encodePaymentSignatureHeader(payload)
}

describe('MERCHANT_SKIP_SETTLE_PRODUCT chain guard', () => {
  // Each case does a fresh `vi.resetModules()` + dynamic import of x402.ts
  // (and its transitive graph), which is consistently the slowest thing in
  // this package's suite and — as the full-package `npx vitest run` count
  // grows — flakes past the 5s default under collection-time load rather
  // than any actual regression. Give this module-reimport guard real headroom.
  it('refuses to start on mainnet with the flag set', async () => {
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {
        throw new Error('process.exit called')
      }) as never)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(
      importX402With({ MERCHANT_CHAIN_ID: '8453', MERCHANT_SKIP_SETTLE_PRODUCT: 'vpn_basic' }),
    ).rejects.toThrow('process.exit called')
    expect(exit).toHaveBeenCalledWith(1)
    expect(String(error.mock.calls[0]?.[0])).toContain('testnet-only')
  }, 15000)

  it('starts on Base Sepolia with the flag set', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as never)
    const mod = await importX402With({
      MERCHANT_CHAIN_ID: '84532',
      MERCHANT_SKIP_SETTLE_PRODUCT: 'vpn_basic',
    })
    expect(mod.createX402PaymentProcessor).toBeTypeOf('function')
    expect(exit).not.toHaveBeenCalled()
  }, 15000)

  it('starts on mainnet when the flag is unset', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as never)
    const mod = await importX402With({ MERCHANT_CHAIN_ID: '8453' })
    expect(mod.createX402PaymentProcessor).toBeTypeOf('function')
    expect(exit).not.toHaveBeenCalled()
  }, 15000)

  // #2969: the QA hook must be labelled honestly, not as an unsettled variant
  // of a real settlement. Mutation target: reverting `settlement` back to a
  // derived `settled: boolean` (or reusing `already_settled_earlier` here)
  // would pass every OTHER assertion in this file and fail only this one.
  it('the skip-settle path settles nothing, submits nothing, and carries settlement_unknown honestly (#2969)', async () => {
    const mod = await importX402With({
      MERCHANT_CHAIN_ID: '84532',
      MERCHANT_SKIP_SETTLE_PRODUCT: 'vpn_basic',
    })
    const products = await import('./products.js')
    const submit = vi.fn().mockResolvedValue(`0x${'cd'.repeat(32)}`)
    const waitForReceipt = vi.fn().mockResolvedValue(undefined)
    const processor = mod.createX402PaymentProcessor({ submit, waitForReceipt })

    const pr = processor.buildPaymentRequired({
      merchantAddress: MERCHANT,
      amountUsdc: 1_000n,
      resource: 'https://merchant.test/mcp',
      description: 'NordShield VPN Basic',
    })
    const header = await signSkipSettleHeader(mod, products.CHAIN_ID, pr)

    const settled = await processor.verifyAndSettle({
      productId: 'vpn_basic',
      paymentHeader: header,
      merchantAddress: MERCHANT,
      expectedAmount: 1_000n,
      paymentRequired: pr,
    })

    // Delivered (goods owed, hook is verify-without-settle by design)...
    expect(settled.from.toLowerCase()).toBe(privateKeyToAccount(PAYER_KEY).address.toLowerCase())
    // ...but never actually settled: no submission happened at all.
    expect(submit).not.toHaveBeenCalled()
    // The internal state is the explicit, honest label — not a boolean that
    // could be confused with the "paid earlier, no reference" state.
    expect(settled.settlement).toBe('settlement_unknown')
    expect(settled.settlement).not.toBe('already_settled_earlier')
    expect(settled.settlement).not.toBe('settled_onchain')
    // The x402 WIRE surface is unchanged: still the zero hash, unconditionally
    // (this is the protocol-facing field this issue explicitly leaves alone).
    expect(settled.txHash).toBe(ZERO_TX_HASH)
    expect(settled.paymentResponse.transaction).toBe(ZERO_TX_HASH)
  }, 15000)
})
