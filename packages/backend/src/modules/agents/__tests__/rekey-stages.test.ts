/**
 * The re-key ordering invariant (#1698, epic #1694).
 *
 * "Revoke must precede issue, never the reverse" is the acceptance criterion
 * that most needs a test that can FAIL, because the correct order is also the
 * natural order — an implementation that never enforces anything passes a
 * happy-path test. So every case here is written as a REFUSAL, and the
 * mutation each one catches is named in the test.
 */
import { describe, expect, it } from 'vitest'
import {
  assertStageAllows,
  assertTransition,
  canTransition,
  IN_FLIGHT_STAGES,
  leavesAgentWithoutAuthority,
  REKEY_STAGES,
  RekeyOrderingError,
  RekeyTransitionError,
  STAGE_REQUIRED_FOR,
  type RekeyStage,
} from '../rekey-stages.js'

describe('issue can never precede revoke', () => {
  it('REFUSES issue at every stage that has not been through the revoke', () => {
    // The load-bearing assertion of the whole slice. `metered` is only
    // reachable via `revoked`, so requiring it here forbids issue-first
    // structurally rather than by convention.
    for (const stage of ['preflight', 'completed', 'abandoned'] as RekeyStage[]) {
      expect(() => assertStageAllows('issue', stage)).toThrow(RekeyOrderingError)
    }
    expect(() => assertStageAllows('issue', 'metered')).not.toThrow()
  })

  it('MUTATION TARGET — issue at preflight is the two-live-keys failure, and it throws', () => {
    // Mutating STAGE_REQUIRED_FOR.issue from 'metered' to 'preflight' makes
    // this the failing test. It is the single most important refusal in the
    // slice: issuing before revoking leaves two simultaneously live keys on a
    // funded account.
    let thrown: unknown
    try {
      assertStageAllows('issue', 'preflight')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(RekeyOrderingError)
    const err = thrown as RekeyOrderingError
    expect(err.actual).toBe('preflight')
    expect(err.required).toBe('metered')
    // The refusal has to explain the asymmetry, not merely decline.
    expect(err.message).toMatch(/two live keys/)
  })

  it('the required stage for issue is metered, not revoked and not preflight', () => {
    // A weaker-but-plausible implementation requires only `revoked` — which
    // would issue against a meter that was never read, i.e. against the FULL
    // budget. That is a budget leak wearing correct ordering.
    expect(STAGE_REQUIRED_FOR.issue).toBe('metered')
    expect(() => assertStageAllows('issue', 'revoked')).toThrow(RekeyOrderingError)
  })
})

describe('the meter is read after the revoke, never before', () => {
  it('REFUSES a meter read at preflight', () => {
    // #1694's review amendment. Reading before the revoke leaves a window in
    // which a payment lands and the carried remainder over-counts it.
    expect(() => assertStageAllows('readMeter', 'preflight')).toThrow(RekeyOrderingError)
    expect(() => assertStageAllows('readMeter', 'revoked')).not.toThrow()
  })

  it('MUTATION TARGET — a meter read before the revoke fails here', () => {
    // Mutating STAGE_REQUIRED_FOR.readMeter to 'preflight' makes this fail.
    expect(STAGE_REQUIRED_FOR.readMeter).toBe('revoked')
    let thrown: unknown
    try {
      assertStageAllows('readMeter', 'preflight')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(RekeyOrderingError)
    expect((thrown as RekeyOrderingError).message).toMatch(/cannot move while it is being carried/)
  })

  it('refuses a second meter read once metered', () => {
    // A frozen measurement is taken once. Re-reading would be harmless on a
    // truly frozen meter and is refused anyway, because "harmless because
    // nothing moved" is the assumption the ordering exists to not need.
    expect(() => assertStageAllows('readMeter', 'metered')).toThrow(RekeyOrderingError)
  })
})

describe('the transition graph is forward-only', () => {
  it('has no edge back to preflight from anywhere', () => {
    // The revoke landed on-chain; no row update un-lands it.
    for (const stage of REKEY_STAGES) {
      expect(canTransition(stage, 'preflight')).toBe(false)
    }
  })

  it('MUTATION TARGET — skipping the revoke is not a legal transition', () => {
    expect(canTransition('preflight', 'metered')).toBe(false)
    expect(canTransition('preflight', 'issued')).toBe(false)
    expect(canTransition('preflight', 'completed')).toBe(false)
    expect(() => assertTransition('preflight', 'issued')).toThrow(RekeyTransitionError)
  })

  it('allows exactly the intended path', () => {
    expect(canTransition('preflight', 'revoked')).toBe(true)
    expect(canTransition('revoked', 'metered')).toBe(true)
    expect(canTransition('metered', 'issued')).toBe(true)
    expect(canTransition('issued', 'completed')).toBe(true)
  })

  it('treats completed and abandoned as terminal', () => {
    for (const stage of REKEY_STAGES) {
      expect(canTransition('completed', stage)).toBe(false)
      expect(canTransition('abandoned', stage)).toBe(false)
    }
  })

  it('lets an owner abandon from every live stage', () => {
    for (const stage of IN_FLIGHT_STAGES) {
      expect(canTransition(stage, 'abandoned')).toBe(true)
    }
  })
})

describe('an agent with no authority is said so out loud', () => {
  it('reports the stages in which the old grant is gone and the new one is not live', () => {
    expect(leavesAgentWithoutAuthority('preflight')).toBe(false)
    expect(leavesAgentWithoutAuthority('revoked')).toBe(true)
    expect(leavesAgentWithoutAuthority('metered')).toBe(true)
    // `issued` still counts: the delegations exist but are `pending` until
    // the owner signs them, so nothing redeems yet.
    expect(leavesAgentWithoutAuthority('issued')).toBe(true)
    expect(leavesAgentWithoutAuthority('completed')).toBe(false)
  })
})
