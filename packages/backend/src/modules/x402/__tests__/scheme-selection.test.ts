import { describe, expect, it } from 'vitest'
import {
  deriveFundingShape,
  validateDelegationSchemeShape,
  validateGenericSchemeRail,
} from '../scheme-selection.js'
import type { AgentContext } from '../../../middleware/agentAuth.js'

/**
 * The erc7710-vs-eip3009 settlement-scheme decision (#946, #1058), now
 * directly unit-testable without HTTP as a moved seam (#996). The HTTP-level
 * suites (x402.test.ts, x402-delegation.test.ts) already pin every one of
 * these branches through the route — these tests pin the DECISION FUNCTIONS
 * themselves and the evaluation order between them, which the route tests
 * cannot isolate from token resolution / persistence side effects.
 */

function agent(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    id: 'agent-1',
    user_id: 'user-1',
    name: 'A',
    delegate_address: '0x' + '11'.repeat(20),
    safe_address: '0x' + '22'.repeat(20),
    chain_id: 8453,
    status: 'active',
    execution_rail: 'delegation',
    ...overrides,
  }
}

const MERCHANT = '0x' + '33'.repeat(20)
const DELEGATE = '0x' + '11'.repeat(20)

describe('validateGenericSchemeRail (#946, #1058) — rail-generic guards', () => {
  it('allows erc7710 on the delegation rail', () => {
    expect(validateGenericSchemeRail(agent({ execution_rail: 'delegation' }), 'erc7710', undefined)).toBeNull()
  })

  it('rejects erc7710 on a legacy-rail agent', () => {
    const result = validateGenericSchemeRail(agent({ execution_rail: 'legacy' }), 'erc7710', undefined)
    expect(result?.code).toBe(400)
    expect((result?.body as { error: string }).error).toMatch(/delegation-rail account/)
  })

  it('allows eip3009 on a legacy-rail agent (no rail restriction on that scheme)', () => {
    expect(validateGenericSchemeRail(agent({ execution_rail: 'legacy' }), 'eip3009', undefined)).toBeNull()
  })

  it('rejects facilitatorAddresses on a legacy-rail agent, regardless of settlementScheme', () => {
    const result = validateGenericSchemeRail(agent({ execution_rail: 'legacy' }), undefined, [MERCHANT])
    expect(result?.code).toBe(400)
    expect((result?.body as { error: string }).error).toMatch(/facilitatorAddresses/)
  })

  it('allows facilitatorAddresses on a delegation-rail agent', () => {
    expect(validateGenericSchemeRail(agent({ execution_rail: 'delegation' }), undefined, [MERCHANT])).toBeNull()
  })

  it('checks settlementScheme BEFORE facilitatorAddresses — evaluation order', () => {
    // Both would independently fail on a legacy rail; the erc7710 message
    // must surface first, matching the pre-#996 route's if-chain order.
    const result = validateGenericSchemeRail(agent({ execution_rail: 'legacy' }), 'erc7710', [MERCHANT])
    expect((result?.body as { error: string }).error).toMatch(/delegation-rail account/)
  })
})

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
    const result = validateDelegationSchemeShape(false, 'eip3009', undefined)
    expect(result?.code).toBe(400)
    expect((result?.body as { error: string }).error).toMatch(/agent delegate EOA/)
  })

  it('rejects settlementScheme erc7710 when the shape IS funding (payTo = delegate EOA)', () => {
    const result = validateDelegationSchemeShape(true, 'erc7710', undefined)
    expect(result?.code).toBe(400)
    expect((result?.body as { error: string }).error).toMatch(/payTo = the merchant/)
  })

  it('rejects facilitatorAddresses on the funding (3009) shape — no redeemer there', () => {
    const result = validateDelegationSchemeShape(true, undefined, [MERCHANT])
    expect(result?.code).toBe(400)
    expect((result?.body as { error: string }).error).toMatch(/EIP-3009 funding leg has no redeemer/)
  })

  it('allows facilitatorAddresses on the non-funding (erc7710) shape', () => {
    expect(validateDelegationSchemeShape(false, undefined, [MERCHANT])).toBeNull()
  })

  it('allows a consistent erc7710 request: shape=false, scheme=erc7710', () => {
    expect(validateDelegationSchemeShape(false, 'erc7710', undefined)).toBeNull()
  })

  it('allows a consistent eip3009 request: shape=true, scheme=eip3009', () => {
    expect(validateDelegationSchemeShape(true, 'eip3009', undefined)).toBeNull()
  })

  it('allows an unspecified settlementScheme on either shape', () => {
    expect(validateDelegationSchemeShape(true, undefined, undefined)).toBeNull()
    expect(validateDelegationSchemeShape(false, undefined, undefined)).toBeNull()
  })
})
