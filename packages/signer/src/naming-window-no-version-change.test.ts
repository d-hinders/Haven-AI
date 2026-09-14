/**
 * #2908 (naming epic #2906, phase 1) — the binding decision, pinned.
 *
 * The naming rename must NOT move the expected-context version.
 * `sign_data.components.safe` (and its #2907 twin `payer_account`) is response
 * metadata, never part of the signed x402 expected-context payload, and the
 * version is content-derived on the signer side — so a v4 emit from the server
 * would make every installed signer fail closed on every payment. The SDK's
 * receipt builder is the lever instead (`x402-funding-leg.ts`).
 *
 * `version-skew.test.ts` is deliberately untouched by this slice; this file
 * asserts the same list from the naming slice's point of view so that a
 * later "tidy-up" widening to `[1, 2, 3, 4]` in the name of the rename shows
 * up as a red test naming the reason it must not.
 */
import { describe, expect, it } from 'vitest'
import { SUPPORTED_X402_EXPECTED_VERSIONS } from './core.js'
import { signerCompatibility } from './capabilities.js'

describe('naming window (#2908) leaves the expected-context contract alone', () => {
  it('SUPPORTED_X402_EXPECTED_VERSIONS is still [1, 2, 3]', () => {
    expect([...SUPPORTED_X402_EXPECTED_VERSIONS]).toEqual([1, 2, 3])
  })

  it('the advertised capability list is the same list', () => {
    expect(signerCompatibility().x402_expected_context_versions).toEqual([1, 2, 3])
  })
})
