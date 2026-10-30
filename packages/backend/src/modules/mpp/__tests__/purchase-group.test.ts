/**
 * #4534: the purchase correlation key's derivation.
 *
 * The map is deliberately small and explicit — one entry per merchant, naming
 * the field the merchant's own document carries and the route verb that is the
 * purchase leg. These cases pin that shape: a merchant outside the map
 * contributes nothing, a body without the mapped field contributes nothing,
 * and nothing is ever inferred from a clock.
 */
import { describe, expect, it } from 'vitest'
import {
  merchantHost,
  normalizePurchaseGroupId,
  purchaseGroupFromMerchantResponse,
  purchaseGroupRoleForResourceUrl,
  resolvePurchaseGroup,
  routeVerb,
} from '../purchase-group.js'

const CREATE_URL = 'https://api.bitrefill.com/x402/invoice/create'
const PAY_URL = 'https://api.bitrefill.com/x402/invoice/pay'
const STATUS_URL = 'https://api.bitrefill.com/x402/invoice/status'

describe('merchantHost / routeVerb', () => {
  it('reads the lowercased host and the last path segment', () => {
    expect(merchantHost('https://API.Bitrefill.com/x402/invoice/pay')).toBe('api.bitrefill.com')
    expect(routeVerb('https://api.bitrefill.com/x402/invoice/pay')).toBe('pay')
    expect(routeVerb('https://api.bitrefill.com/x402/invoice/pay/')).toBe('pay')
  })

  it('answers null for an unparseable URL or one with no path', () => {
    expect(merchantHost('not a url')).toBeNull()
    expect(merchantHost(null)).toBeNull()
    expect(routeVerb('not a url')).toBeNull()
    expect(routeVerb('https://api.bitrefill.com/')).toBeNull()
  })
})

describe('normalizePurchaseGroupId', () => {
  it('trims a usable string and refuses everything else', () => {
    expect(normalizePurchaseGroupId('  inv_abc  ')).toBe('inv_abc')
    expect(normalizePurchaseGroupId('')).toBeNull()
    expect(normalizePurchaseGroupId('   ')).toBeNull()
    expect(normalizePurchaseGroupId(42)).toBeNull()
    expect(normalizePurchaseGroupId({ id: 'x' })).toBeNull()
    expect(normalizePurchaseGroupId(null)).toBeNull()
    // Over-long is REFUSED, never truncated: a shortened key would group the
    // wrong documents.
    expect(normalizePurchaseGroupId('x'.repeat(129))).toBeNull()
    expect(normalizePurchaseGroupId('x'.repeat(128))).toBe('x'.repeat(128))
  })
})

describe('purchaseGroupFromMerchantResponse', () => {
  it('reads Bitrefill invoice_id and names the leg from the route', () => {
    expect(purchaseGroupFromMerchantResponse(CREATE_URL, { invoice_id: 'inv_abc' })).toEqual({
      purchaseGroupId: 'inv_abc',
      role: 'fee',
      basis: 'merchant_response',
    })
    expect(purchaseGroupFromMerchantResponse(PAY_URL, { invoice_id: 'inv_abc' })).toEqual({
      purchaseGroupId: 'inv_abc',
      role: 'purchase',
      basis: 'merchant_response',
    })
    expect(purchaseGroupFromMerchantResponse(STATUS_URL, { invoice_id: 'inv_abc' })).toEqual({
      purchaseGroupId: 'inv_abc',
      role: 'fee',
      basis: 'merchant_response',
    })
  })

  it('reads the id from the merchant\'s `data` wrapper too', () => {
    expect(purchaseGroupFromMerchantResponse(PAY_URL, { data: { invoice_id: 'inv_nested' } })).toEqual({
      purchaseGroupId: 'inv_nested',
      role: 'purchase',
      basis: 'merchant_response',
    })
  })

  it('contributes nothing for a merchant outside the map', () => {
    expect(
      purchaseGroupFromMerchantResponse('https://api.other-merchant.com/x402/invoice/pay', {
        invoice_id: 'inv_abc',
      }),
    ).toBeNull()
  })

  it('contributes nothing when the body carries no mapped field', () => {
    expect(purchaseGroupFromMerchantResponse(PAY_URL, { status: 'paid' })).toBeNull()
    expect(purchaseGroupFromMerchantResponse(PAY_URL, { invoice_id: 42 })).toBeNull()
    expect(purchaseGroupFromMerchantResponse(PAY_URL, { invoice_id: '   ' })).toBeNull()
    expect(purchaseGroupFromMerchantResponse(PAY_URL, null)).toBeNull()
    expect(purchaseGroupFromMerchantResponse(PAY_URL, ['inv_abc'])).toBeNull()
  })

  it('groups even when the route verb is unrecognised — the role is null, not a guess', () => {
    expect(
      purchaseGroupFromMerchantResponse('https://api.bitrefill.com/x402/invoice/refund', {
        invoice_id: 'inv_abc',
      }),
    ).toEqual({ purchaseGroupId: 'inv_abc', role: null, basis: 'merchant_response' })
  })
})

describe('resolvePurchaseGroup', () => {
  it('prefers the merchant\'s own id over an agent-supplied key', () => {
    expect(
      resolvePurchaseGroup({
        merchantUrl: PAY_URL,
        merchantResponse: { invoice_id: 'inv_merchant' },
        agentGroupId: 'agent-key',
      }),
    ).toEqual({ purchaseGroupId: 'inv_merchant', role: 'purchase', basis: 'merchant_response' })
  })

  it('falls back to the agent-supplied key when the merchant supplies none', () => {
    expect(
      resolvePurchaseGroup({
        merchantUrl: 'https://api.other-merchant.com/x402/invoice/pay',
        merchantResponse: { invoice_id: 'inv_abc' },
        agentGroupId: 'agent-key',
      }),
    ).toEqual({ purchaseGroupId: 'agent-key', role: null, basis: 'agent_supplied' })
  })

  it('answers null when neither source supplies a usable key', () => {
    expect(resolvePurchaseGroup({ merchantUrl: PAY_URL })).toBeNull()
    expect(resolvePurchaseGroup({ merchantUrl: PAY_URL, agentGroupId: '   ' })).toBeNull()
  })

  it('never derives a group from a time window', () => {
    // Two calls with the same body but different wall-clock moments resolve to
    // the same group; two calls with DIFFERENT bodies never merge, however
    // close together they are. The function reads no clock at all.
    const a = resolvePurchaseGroup({ merchantUrl: PAY_URL, merchantResponse: { invoice_id: 'inv_a' } })
    const b = resolvePurchaseGroup({ merchantUrl: PAY_URL, merchantResponse: { invoice_id: 'inv_b' } })
    expect(a?.purchaseGroupId).toBe('inv_a')
    expect(b?.purchaseGroupId).toBe('inv_b')
    expect(a?.purchaseGroupId).not.toBe(b?.purchaseGroupId)
  })
})

describe('purchaseGroupRoleForResourceUrl', () => {
  it('classifies an existing group member from its own stored route', () => {
    expect(purchaseGroupRoleForResourceUrl(PAY_URL)).toBe('purchase')
    expect(purchaseGroupRoleForResourceUrl(CREATE_URL)).toBe('fee')
    expect(purchaseGroupRoleForResourceUrl(STATUS_URL)).toBe('fee')
    expect(purchaseGroupRoleForResourceUrl('https://api.other-merchant.com/x402/invoice/pay')).toBeNull()
    expect(purchaseGroupRoleForResourceUrl(null)).toBeNull()
  })
})
