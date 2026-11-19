/**
 * #4989: the shared payment checks name the field a payment got wrong, and
 * carry the refusal code as structured data. The messages stay byte-identical,
 * so the demo merchant's answers do not change.
 */
import { describe, expect, it } from 'vitest'
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types'
import {
  PaymentError,
  assertPaymentOptionMatches,
  parseExactEvmPayload,
  selectQuotedPaymentOption,
  type PaymentAsset,
} from './payment-checks.js'

const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const PAY_TO = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const OTHER_ADDRESS = '0x0000000000000000000000000000000000000001'

const ASSET: PaymentAsset = {
  chainId: 84532,
  network: 'eip155:84532',
  usdcAddress: SEPOLIA_USDC,
  usdcDomainName: 'USDC',
  usdcDomainVersion: '2',
}

function option(over: Record<string, unknown> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'eip155:84532',
    amount: '10000',
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    asset: SEPOLIA_USDC,
    extra: { name: 'USDC', version: '2' },
    ...over,
  } as PaymentRequirements
}

function challenge(accepts: PaymentRequirements[]): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: 'https://merchant.example/v1/chat', description: 'One call.', mimeType: 'application/json' },
    accepts,
  } as PaymentRequired
}

/** The shared sentence, pinned: #4989 adds fields, never words. */
const MISMATCH_MESSAGE = 'Payment accepted option does not match a quoted settlement method'

describe('#4989: selectQuotedPaymentOption names the differing field', () => {
  it('names accepted.amount on a single-option challenge, and keeps the message byte-identical', () => {
    const quoted = option()
    const accepted = option({ amount: '1' })
    let thrown: unknown
    try {
      selectQuotedPaymentOption(accepted, challenge([quoted]))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(PaymentError)
    const err = thrown as PaymentError
    expect(err.message).toBe(MISMATCH_MESSAGE)
    expect(err.code).toBe('payment_mismatch')
    expect(err.field).toBe('accepted.amount')
    expect(err.expected).toBe('10000')
    expect(err.next).toContain('accepted.amount')
  })

  it('names accepted.payTo, accepted.asset and accepted.maxTimeoutSeconds on a single-option challenge', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ payTo: OTHER_ADDRESS }, 'accepted.payTo'],
      [{ asset: OTHER_ADDRESS }, 'accepted.asset'],
      [{ maxTimeoutSeconds: 299 }, 'accepted.maxTimeoutSeconds'],
    ]
    for (const [over, field] of cases) {
      const err = (() => {
        try {
          selectQuotedPaymentOption(option(over), challenge([option()]))
        } catch (e) {
          return e as PaymentError
        }
        throw new Error('expected a refusal')
      })()
      expect(err.field, field).toBe(field)
      expect(err.code).toBe('payment_mismatch')
    }
  })

  it('names accepted.network and accepted.extra.assetTransferMethod on a single-option challenge', () => {
    const network = (() => {
      try {
        selectQuotedPaymentOption(option({ network: 'eip155:8453' }), challenge([option()]))
      } catch (e) {
        return e as PaymentError
      }
      throw new Error('expected a refusal')
    })()
    expect(network.field).toBe('accepted.network')
    expect(network.expected).toBe('eip155:84532')

    const method = (() => {
      try {
        selectQuotedPaymentOption(option({ extra: { name: 'USDC', version: '2', assetTransferMethod: 'erc7710' } }), challenge([option()]))
      } catch (e) {
        return e as PaymentError
      }
      throw new Error('expected a refusal')
    })()
    expect(method.field).toBe('accepted.extra.assetTransferMethod')
    expect(method.expected).toBe('eip3009')
  })

  it('names a field when exactly one of several options shares the payment\'s method, scheme and network', () => {
    const eip3009 = option()
    const erc7710 = option({ extra: { name: 'USDC', version: '2', assetTransferMethod: 'erc7710' } })
    const err = (() => {
      try {
        selectQuotedPaymentOption(option({ amount: '1' }), challenge([eip3009, erc7710]))
      } catch (e) {
        return e as PaymentError
      }
      throw new Error('expected a refusal')
    })()
    expect(err.field).toBe('accepted.amount')
    expect(err.expected).toBe('10000')
  })

  it('names no field when several options exist and none shares the payment\'s method, scheme and network', () => {
    const eip3009 = option()
    const erc7710 = option({ extra: { name: 'USDC', version: '2', assetTransferMethod: 'erc7710' } })
    const err = (() => {
      try {
        selectQuotedPaymentOption(option({ network: 'eip155:8453' }), challenge([eip3009, erc7710]))
      } catch (e) {
        return e as PaymentError
      }
      throw new Error('expected a refusal')
    })()
    expect(err.message).toBe(MISMATCH_MESSAGE)
    expect(err.code).toBe('payment_mismatch')
    expect(err.field).toBeUndefined()
  })

  it('names no field when two options share the payment\'s method, scheme and network', () => {
    const first = option({ amount: '10000' })
    const second = option({ amount: '20000' })
    const err = (() => {
      try {
        selectQuotedPaymentOption(option({ amount: '1' }), challenge([first, second]))
      } catch (e) {
        return e as PaymentError
      }
      throw new Error('expected a refusal')
    })()
    expect(err.field).toBeUndefined()
  })
})

describe('#4989: parseExactEvmPayload names the missing field', () => {
  it('a payload that is not an object is a PaymentError naming payload, not a TypeError', () => {
    const err = (() => {
      try {
        parseExactEvmPayload(undefined)
      } catch (e) {
        return e as PaymentError
      }
      throw new Error('expected a refusal')
    })()
    expect(err).toBeInstanceOf(PaymentError)
    expect(err.message).toBe('Invalid payment header: missing the payload object')
    expect(err.code).toBe('payment_invalid')
    expect(err.field).toBe('payload')
  })

  it('a payload without an authorization names payload.authorization', () => {
    const err = (() => {
      try {
        parseExactEvmPayload({ signature: `0x${'ab'.repeat(65)}` })
      } catch (e) {
        return e as PaymentError
      }
      throw new Error('expected a refusal')
    })()
    expect(err.message).toBe('Invalid payment header: missing EIP-3009 authorization')
    expect(err.field).toBe('payload.authorization')
  })

  it('a payload without a signature names payload.signature', () => {
    const err = (() => {
      try {
        parseExactEvmPayload({ authorization: { from: PAY_TO, to: PAY_TO, value: '1', validAfter: '0', validBefore: '1', nonce: `0x${'0'.repeat(64)}` } })
      } catch (e) {
        return e as PaymentError
      }
      throw new Error('expected a refusal')
    })()
    expect(err.message).toBe('Invalid payment header: missing EIP-3009 signature')
    expect(err.field).toBe('payload.signature')
  })
})

describe('#4989: assertPaymentOptionMatches carries the code and the field', () => {
  it('a wrong recipient is payment_mismatch naming accepted.payTo, with the message unchanged', () => {
    const err = (() => {
      try {
        assertPaymentOptionMatches(option({ payTo: OTHER_ADDRESS }), option(), PAY_TO as `0x${string}`, 10000n, 'eip3009', ASSET)
      } catch (e) {
        return e as PaymentError
      }
      throw new Error('expected a refusal')
    })()
    expect(err.message).toBe('Payment accepted option does not match merchant recipient')
    expect(err.code).toBe('payment_mismatch')
    expect(err.field).toBe('accepted.payTo')
    expect(err.expected).toBe(PAY_TO)
  })

  it('a wrong amount is payment_mismatch naming accepted.amount', () => {
    const err = (() => {
      try {
        assertPaymentOptionMatches(option({ amount: '1' }), option(), PAY_TO as `0x${string}`, 10000n, 'eip3009', ASSET)
      } catch (e) {
        return e as PaymentError
      }
      throw new Error('expected a refusal')
    })()
    expect(err.message).toBe('Payment amount does not match: expected 10000, got 1')
    expect(err.code).toBe('payment_mismatch')
    expect(err.field).toBe('accepted.amount')
  })

  it('missing USDC domain metadata keeps payment_invalid, its code before #4989, and still names accepted.extra', () => {
    // The pre-#4989 `localCheckError` regex did not match this message, so the
    // refusal answered `payment_invalid`. #4989 scopes the code migration to
    // the sites that regex matched; this one keeps its code.
    const err = (() => {
      try {
        assertPaymentOptionMatches(
          option({ extra: { name: 'USDC', version: '1' } }),
          option(),
          PAY_TO as `0x${string}`,
          10000n,
          'eip3009',
          ASSET,
        )
      } catch (e) {
        return e as PaymentError
      }
      throw new Error('expected a refusal')
    })()
    expect(err.message).toBe('Payment accepted option is missing the expected USDC domain metadata')
    expect(err.code).toBe('payment_invalid')
    expect(err.field).toBe('accepted.extra')
    expect(err.expected).toEqual({ name: 'USDC', version: '2' })
  })
})
