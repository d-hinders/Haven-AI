import { describe, expect, it } from 'vitest'
import { x402ResourceServer } from '@x402/core/server'
import type { PaymentRequirements } from '@x402/core/types'
import { encodeXPaymentHeader, selectStoredAccepted } from '../x402-delegation.js'
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
  it.each([
    { amount: '999' }, { payTo: `0x${'bb'.repeat(20)}` }, { asset: `0x${'bb'.repeat(20)}` },
    { network: 'eip155:8453' }, { scheme: 'other' }, { maxTimeoutSeconds: 301 },
    { extra: { ...option.extra, assetTransferMethod: 'eip3009' } },
    { extra: { ...option.extra, facilitatorAddresses: [`0x${'ee'.repeat(20)}`] } },
  ])('refuses mismatched selected requirements %j', patch => {
    expect(() => selectStoredAccepted({ accepts: [{ ...option, ...patch }] }, 'eip155:84532', trusted)).toThrow()
  })
  it('refuses ambiguous options rather than guessing merchant metadata', () => {
    expect(() => selectStoredAccepted({ accepts: [option, { ...option, extra: { ...option.extra, name: 'Other' } }] }, 'eip155:84532', trusted)).toThrow()
  })
  it('refuses present empty challenges but preserves the challenge-absent legacy fallback', () => {
    expect(() => selectStoredAccepted({ accepts: [] }, 'eip155:84532', trusted)).toThrow()
    expect(selectStoredAccepted(null, 'eip155:84532', trusted)).toBeUndefined()
    const decoded = JSON.parse(Buffer.from(encodeXPaymentHeader('eip155:84532', payload, trusted), 'base64').toString())
    expect(decoded.accepted.extra).toEqual({ assetTransferMethod: 'erc7710', facilitatorAddresses: trusted.facilitatorAddresses })
  })
})
