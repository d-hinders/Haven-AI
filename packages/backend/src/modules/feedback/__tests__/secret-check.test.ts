import { describe, expect, it } from 'vitest'
import { detectLabelledSecret } from '../secret-check.js'

/**
 * Backend unit tests for `detectLabelledSecret` (#3597 round 2, N-b).
 *
 * `secret-check-parity.test.ts` pins the regex literals byte-identical
 * against the CLI's copy; this proves the backend's own copy actually
 * BEHAVES as those literals promise, on the same ordinary-word fixture the
 * CLI test uses.
 */
describe('detectLabelledSecret (#3597)', () => {
  it('MUTATION PROOF (N1): an ordinary word starting "ey" is not refused — the JWT pattern requires "eyJ"', () => {
    expect(detectLabelledSecret('my eyebrow.test.ts file needs a fix')).toBeNull()
    expect(detectLabelledSecret('an eyelet.config.js change')).toBeNull()
  })

  it('still refuses a real session JWT shape', () => {
    expect(detectLabelledSecret('token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl')).toBe('session_jwt')
  })
})
