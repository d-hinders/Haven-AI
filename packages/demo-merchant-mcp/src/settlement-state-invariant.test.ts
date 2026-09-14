import { describe, expect, it } from 'vitest'

import { assertSettlementConsistent } from './x402.js'

const ZERO = `0x${'0'.repeat(64)}` as const
const REAL = `0x${'ab'.repeat(32)}` as const

// #2969: `SettledPayment.settlement` is caller-supplied, so the only thing
// that keeps it from drifting away from the wire hash is this invariant.
describe('assertSettlementConsistent (#2969)', () => {
  it('accepts the three legitimate pairings', () => {
    expect(() => assertSettlementConsistent(REAL, 'settled_onchain')).not.toThrow()
    expect(() => assertSettlementConsistent(ZERO, 'already_settled_earlier')).not.toThrow()
    expect(() => assertSettlementConsistent(ZERO, 'settlement_unknown')).not.toThrow()
  })

  it('refuses a zero hash claimed as settled_onchain — the #2969 defect shape', () => {
    expect(() => assertSettlementConsistent(ZERO, 'settled_onchain')).toThrow(/contradicts/)
  })

  it('refuses a real hash labelled as unsettled', () => {
    expect(() => assertSettlementConsistent(REAL, 'settlement_unknown')).toThrow(/contradicts/)
    expect(() => assertSettlementConsistent(REAL, 'already_settled_earlier')).toThrow(/contradicts/)
  })
})
