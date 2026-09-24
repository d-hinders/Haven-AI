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
 * later "tidy-up" widening in the name of the rename shows up as a red test
 * naming the reason it must not.
 *
 * #3272 (criterion 8, owner decision 2026-09-24) moved the list from
 * `[1, 2, 3]` to `[2, 3]` for an UNRELATED, deliberate reason: Haven's own
 * internal x402 expected-context v1 (a bare-hash binding format from the
 * retired Safe rail — not the x402 PROTOCOL version) is retired outright,
 * along with `signX402FundingHash`. That is the one widening/narrowing this
 * file is not testing against; the naming-window property below still holds
 * for whatever the CURRENT list is.
 */
import { describe, expect, it } from 'vitest'
import { SUPPORTED_X402_EXPECTED_VERSIONS } from './core.js'
import { signerCompatibility } from './capabilities.js'

describe('naming window (#2908) leaves the expected-context contract alone', () => {
  it('SUPPORTED_X402_EXPECTED_VERSIONS is [2, 3] (#3272: v1 retired, unrelated to the #2908 naming window)', () => {
    expect([...SUPPORTED_X402_EXPECTED_VERSIONS]).toEqual([2, 3])
  })

  it('the advertised capability list is the same list', () => {
    expect(signerCompatibility().x402_expected_context_versions).toEqual([2, 3])
  })
})
