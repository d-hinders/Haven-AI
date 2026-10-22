import { describe, expect, it } from 'vitest'
import {
  deriveFundingShape,
  validateDelegationSchemeShape,
} from '../scheme-selection.js'

/**
 * The erc7710-vs-eip3009 settlement-scheme decision (#946, #1058), now
 * directly unit-testable without HTTP as a moved seam (#996). The HTTP-level
 * suites (x402.test.ts, x402-delegation.test.ts) already pin every one of
 * these branches through the route — these tests pin the DECISION FUNCTIONS
 * themselves and the evaluation order between them, which the route tests
 * cannot isolate from token resolution / persistence side effects.
 *
 * #2245 deleted `validateGenericSchemeRail` and the six cases that pinned it.
 * They asserted the rail-GENERIC guards — "erc7710 / facilitatorAddresses
 * require a delegation-rail account" — which ran above the rail resolution and
 * so answered a retired-rail account with a 400 instead of the #1986 410. That
 * behaviour is now the rail seam's, and it is pinned where the rest of the
 * retirement is pinned, at the route:
 * `routes/__tests__/allowance-rail-retired.test.ts` → "a caller-supplied
 * settlementScheme cannot divert the tombstone (#2245)". Everything left in
 * this file is delegation-rail-INTERNAL and never sees another rail.
 */

const MERCHANT = '0x' + '33'.repeat(20)
const DELEGATE = '0x' + '11'.repeat(20)
const OTHER = '0x' + '44'.repeat(20)
/** A payee that never trips the #4243 check: merchantPayTo absent. */
const NO_PAYEE = { payTo: MERCHANT, merchantPayTo: undefined }

describe('deriveFundingShape (#946) — payTo shape selects the scheme', () => {
  it('is true when payTo IS the agent delegate EOA (case-insensitive)', () => {
    expect(deriveFundingShape(DELEGATE, DELEGATE)).toBe(true)
    expect(deriveFundingShape(DELEGATE.toUpperCase(), DELEGATE)).toBe(true)
  })

  it('is false when payTo is the merchant', () => {
    expect(deriveFundingShape(MERCHANT, DELEGATE)).toBe(false)
  })
})

describe('validateDelegationSchemeShape (#946, #1058) — delegation-rail cross-checks', () => {
  it('rejects settlementScheme eip3009 when the shape is NOT funding (payTo = merchant)', () => {
    const result = validateDelegationSchemeShape(false, 'eip3009', undefined, NO_PAYEE)
    expect(result?.code).toBe(400)
    expect((result?.body as { error: string }).error).toMatch(/agent delegate EOA/)
  })

  it('rejects settlementScheme erc7710 when the shape IS funding (payTo = delegate EOA)', () => {
    const result = validateDelegationSchemeShape(true, 'erc7710', undefined, NO_PAYEE)
    expect(result?.code).toBe(400)
    expect((result?.body as { error: string }).error).toMatch(/payTo = the merchant/)
  })

  it('rejects facilitatorAddresses on the funding (3009) shape — no redeemer there', () => {
    const result = validateDelegationSchemeShape(true, undefined, [MERCHANT], NO_PAYEE)
    expect(result?.code).toBe(400)
    expect((result?.body as { error: string }).error).toMatch(/EIP-3009 funding leg has no redeemer/)
  })

  it('allows facilitatorAddresses on the non-funding (erc7710) shape', () => {
    expect(validateDelegationSchemeShape(false, undefined, [MERCHANT], NO_PAYEE)).toBeNull()
  })

  it('allows a consistent erc7710 request: shape=false, scheme=erc7710', () => {
    expect(validateDelegationSchemeShape(false, 'erc7710', undefined, NO_PAYEE)).toBeNull()
  })

  it('allows a consistent eip3009 request: shape=true, scheme=eip3009', () => {
    expect(validateDelegationSchemeShape(true, 'eip3009', undefined, NO_PAYEE)).toBeNull()
  })

  it('allows an unspecified settlementScheme on either shape', () => {
    expect(validateDelegationSchemeShape(true, undefined, undefined, NO_PAYEE)).toBeNull()
    expect(validateDelegationSchemeShape(false, undefined, undefined, NO_PAYEE)).toBeNull()
  })
})

describe('validateDelegationSchemeShape (#4243) — erc7710 merchantPayTo must equal payTo', () => {
  it('refuses a differing merchantPayTo on the erc7710 shape, declared or not', () => {
    for (const scheme of ['erc7710', undefined]) {
      const result = validateDelegationSchemeShape(false, scheme, undefined, { payTo: MERCHANT, merchantPayTo: OTHER })
      expect(result?.code).toBe(400)
      expect(String((result?.body as { error: string }).error)).toMatch(/merchantPayTo, when sent, must equal payTo/)
    }
  })

  it('accepts an absent merchantPayTo, or one equal to payTo in any case', () => {
    expect(validateDelegationSchemeShape(false, 'erc7710', undefined, { payTo: MERCHANT, merchantPayTo: undefined })).toBeNull()
    const LETTERED = '0x' + 'ab'.repeat(20)
    expect(validateDelegationSchemeShape(false, 'erc7710', undefined, { payTo: LETTERED, merchantPayTo: '0x' + 'AB'.repeat(20) })).toBeNull()
  })

  it('leaves the EIP-3009 funding leg alone, where merchantPayTo legitimately differs from payTo', () => {
    expect(validateDelegationSchemeShape(true, 'eip3009', undefined, { payTo: DELEGATE, merchantPayTo: MERCHANT })).toBeNull()
    expect(validateDelegationSchemeShape(true, undefined, undefined, { payTo: DELEGATE, merchantPayTo: MERCHANT })).toBeNull()
  })
})
