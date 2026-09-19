import { describe, expect, it } from 'vitest'
import { x402ResourceServer } from '@x402/core/server'
import type { PaymentRequirements } from '@x402/core/types'
import { encodeXPaymentHeader, selectStoredAccepted, StoredAcceptedMismatchError } from '../x402-delegation.js'
const trusted = {
  amount: '1000', payTo: `0x${'cc'.repeat(20)}` as `0x${string}`,
  asset: `0x${'aa'.repeat(20)}` as `0x${string}`, maxTimeoutSeconds: 300,
  facilitatorAddresses: [`0x${'ff'.repeat(20)}`],
}
const option = {
  amount: trusted.amount, payTo: trusted.payTo, asset: trusted.asset, maxTimeoutSeconds: 300,
  scheme: 'exact', network: 'eip155:84532',
  extra: { assetTransferMethod: 'erc7710', name: 'USD Coin', version: '2',
    facilitatorAddresses: trusted.facilitatorAddresses, merchant: { tiers: ['a', 'b'], enabled: true } },
}
const payload = { delegationManager: `0x${'11'.repeat(20)}`, permissionContext: '0x22', delegator: `0x${'33'.repeat(20)}` } as const

describe('stored erc7710 accepted requirements', () => {
  it('selects the trusted option after unrelated options and passes the official matcher', () => {
    const selected = selectStoredAccepted({ accepts: [{ ...option, amount: '999' }, option] }, 'eip155:84532', trusted)
    const decoded = JSON.parse(Buffer.from(encodeXPaymentHeader('eip155:84532', payload, trusted, { accepted: selected }), 'base64').toString())
    expect(decoded.accepted).toEqual(option)
    const server = new x402ResourceServer()
    expect(server.findMatchingRequirements([option as PaymentRequirements], decoded)).toEqual(option)
  })
  it('matches canonical intent amounts while echoing the original decimal spelling', () => {
    const advertised = { ...option, amount: '001000' }
    const selected = selectStoredAccepted({ accepts: [advertised] }, option.network, trusted)
    const decoded = JSON.parse(Buffer.from(encodeXPaymentHeader(option.network, payload, trusted, { accepted: selected }), 'base64').toString())
    expect(decoded.accepted.amount).toBe('001000')
    expect(new x402ResourceServer().findMatchingRequirements([advertised as PaymentRequirements], decoded)).toEqual(advertised)
  })
  it.each(['1e3', '0x3e8', '-1000', '1000.0', '', '0'])('refuses a non-positive-decimal amount %s', amount => {
    expect(() => selectStoredAccepted({ accepts: [{ ...option, amount }] }, option.network, trusted)).toThrow()
  })
  it.each([
    { amount: '999' }, { payTo: `0x${'bb'.repeat(20)}` }, { asset: `0x${'bb'.repeat(20)}` },
    { maxTimeoutSeconds: 301 },
    { extra: { ...option.extra, facilitatorAddresses: [`0x${'ee'.repeat(20)}`] } },
  ])('refuses an erc7710 candidate that does not match the authorization %j', patch => {
    expect(() => selectStoredAccepted({ accepts: [{ ...option, ...patch }] }, 'eip155:84532', trusted))
      .toThrow(StoredAcceptedMismatchError)
  })
  it('refuses ambiguous options rather than guessing merchant metadata', () => {
    expect(() => selectStoredAccepted({ accepts: [option, { ...option, extra: { ...option.extra, name: 'Other' } }] }, 'eip155:84532', trusted))
      .toThrow(StoredAcceptedMismatchError)
  })

  // #3117 review: each of these shapes SETTLED before the echo guard existed.
  // Refusing them would dead-end an intent the agent has already signed, so
  // each one must still produce a settlement rather than a throw.
  it('matches an offer spelled with maxAmountRequired, the field the SDK authorizes against', () => {
    const advertised = { ...option, amount: '1', maxAmountRequired: '1000' }
    const selected = selectStoredAccepted({ accepts: [advertised] }, option.network, trusted)
    expect(selected).toEqual(advertised)
  })
  it('refuses a maxAmountRequired that disagrees with the authorized amount', () => {
    expect(() => selectStoredAccepted({ accepts: [{ ...option, maxAmountRequired: '999999' }] }, option.network, trusted))
      .toThrow(StoredAcceptedMismatchError)
  })
  it('matches when the SDK filtered or re-ordered the advertised facilitator list', () => {
    const extraPin = `0x${'ee'.repeat(20)}`
    const advertised = {
      ...option,
      extra: { ...option.extra, facilitatorAddresses: ['not-an-address', extraPin, ...trusted.facilitatorAddresses] },
    }
    expect(selectStoredAccepted({ accepts: [advertised] }, option.network, trusted)).toEqual(advertised)
  })
  it('matches when the authorize body pinned no facilitator at all', () => {
    expect(selectStoredAccepted({ accepts: [option] }, option.network, { ...trusted, facilitatorAddresses: undefined }))
      .toEqual(option)
  })
  it('matches checksum-cased addresses in the stored offer', () => {
    const advertised = {
      ...option,
      payTo: trusted.payTo.toUpperCase().replace('0X', '0x'),
      asset: trusted.asset.toUpperCase().replace('0X', '0x'),
      extra: { ...option.extra, facilitatorAddresses: [trusted.facilitatorAddresses[0].toUpperCase().replace('0X', '0x')] },
    }
    expect(selectStoredAccepted({ accepts: [advertised] }, option.network, trusted)).toEqual(advertised)
  })
  it('refuses a maxTimeoutSeconds quoted as a string rather than coercing it', () => {
    expect(() => selectStoredAccepted({ accepts: [{ ...option, maxTimeoutSeconds: '300' }] }, option.network, trusted))
      .toThrow(StoredAcceptedMismatchError)
  })
  it('treats deep-equal duplicate offers as one unambiguous offer', () => {
    expect(selectStoredAccepted({ accepts: [option, { ...option }] }, option.network, trusted)).toEqual(option)
  })
  // The de-dup key is key-order-independent on purpose — a plain
  // JSON.stringify would call these two an ambiguous pair.
  it('de-duplicates offers that differ only in key order, nested keys included', () => {
    const reordered = {
      network: option.network, scheme: option.scheme, maxTimeoutSeconds: option.maxTimeoutSeconds,
      asset: option.asset, payTo: option.payTo, amount: option.amount,
      extra: {
        merchant: { enabled: option.extra.merchant.enabled, tiers: option.extra.merchant.tiers },
        facilitatorAddresses: option.extra.facilitatorAddresses,
        version: option.extra.version, name: option.extra.name,
        assetTransferMethod: option.extra.assetTransferMethod,
      },
    }
    expect(selectStoredAccepted({ accepts: [option, reordered] }, option.network, trusted)).toEqual(option)
  })
  // Array ORDER is data, not formatting: two offers whose nested arrays differ must
  // stay distinct, so the de-dup must not collapse them into one.
  it('keeps offers differing only in nested array order distinct, and calls that ambiguous', () => {
    const swapped = { ...option, extra: { ...option.extra, merchant: { ...option.extra.merchant, tiers: ['b', 'a'] } } }
    expect(() => selectStoredAccepted({ accepts: [option, swapped] }, option.network, trusted))
      .toThrow(StoredAcceptedMismatchError)
  })
  // Containment can leave two offers matching where an exact pin set picks one.
  it('prefers the offer whose pin set equals the pins over a merely containing one', () => {
    const superset = {
      ...option,
      extra: { ...option.extra, facilitatorAddresses: [...trusted.facilitatorAddresses, `0x${'ee'.repeat(20)}`] },
    }
    expect(selectStoredAccepted({ accepts: [superset, option] }, option.network, trusted)).toEqual(option)
  })
  it('refuses when a trusted pin is absent from the advertised list', () => {
    const missing = { ...option, extra: { ...option.extra, facilitatorAddresses: [`0x${'ee'.repeat(20)}`] } }
    expect(() => selectStoredAccepted({ accepts: [missing] }, option.network, trusted))
      .toThrow(StoredAcceptedMismatchError)
  })
  it.each([
    { label: 'no accepts entries', accepts: [] },
    { label: 'no accepts key at all', accepts: undefined },
    { label: 'another network', accepts: [{ ...option, network: 'eip155:8453' }] },
    { label: 'another scheme', accepts: [{ ...option, scheme: 'other' }] },
    { label: 'only an eip3009 option', accepts: [{ ...option, extra: { ...option.extra, assetTransferMethod: 'eip3009' } }] },
  ])('keeps the legacy reconstruction when the challenge carries $label', ({ accepts }) => {
    expect(selectStoredAccepted({ ...(accepts ? { accepts } : {}) }, 'eip155:84532', trusted)).toBeUndefined()
  })
  it('preserves the challenge-absent legacy fallback', () => {
    expect(selectStoredAccepted(null, 'eip155:84532', trusted)).toBeUndefined()
    const decoded = JSON.parse(Buffer.from(encodeXPaymentHeader('eip155:84532', payload, trusted), 'base64').toString())
    expect(decoded.accepted.extra).toEqual({ assetTransferMethod: 'erc7710', facilitatorAddresses: trusted.facilitatorAddresses })
  })
})
