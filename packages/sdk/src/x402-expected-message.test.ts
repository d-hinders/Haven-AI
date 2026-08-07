/**
 * Regression test for the x402 expected-context message builder.
 *
 * `expiresAt` enters the SIGNED x402 expected-context message. The backend
 * populates it from a Postgres TIMESTAMPTZ column, which the pg driver returns
 * as a Date object at runtime (despite the `string` TS type). The internal
 * `stableStringify` previously had no Date branch, so a Date serialized to `{}`
 * — the backend signed `"expiresAt":{}` while the edge signer recomputed
 * `"expiresAt":"<ISO>"`, breaking signature verification against the real
 * backend (unit tests passed because they used ISO strings, never Dates).
 *
 * These tests lock in: a Date and its ISO string produce the SAME signed
 * message, and the message never contains the empty-object form.
 */
import { describe, it, expect } from 'vitest'
import { buildX402ExpectedMessage } from './x402.js'

const BASE = {
  paymentId: 'pay_x402',
  payloadHash: `0x${'cd'.repeat(32)}`,
  resourceUrl: 'https://merchant.test/paid',
  merchantTo: '0x000000000000000000000000000000000000dEaD',
  amount: '40000',
  asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  network: 'base',
}

describe('buildX402ExpectedMessage — expiresAt Date/string equivalence', () => {
  const iso = '2026-06-17T09:17:08.488Z'

  it('produces an identical signed message for a Date and its ISO string', () => {
    const fromDate = buildX402ExpectedMessage({ ...BASE, expiresAt: new Date(iso) as unknown as string })
    const fromIso = buildX402ExpectedMessage({ ...BASE, expiresAt: iso })
    expect(fromDate).toBe(fromIso)
  })

  it('never serializes expiresAt as an empty object', () => {
    const fromDate = buildX402ExpectedMessage({ ...BASE, expiresAt: new Date(iso) as unknown as string })
    expect(fromDate).not.toContain('"expiresAt":{}')
    expect(fromDate).toContain(`"expiresAt":"${iso}"`)
  })

  it('omits expiresAt entirely when not provided (back-compat with pre-#399 signers)', () => {
    const message = buildX402ExpectedMessage({ ...BASE })
    expect(message).not.toContain('expiresAt')
  })
})

/**
 * #1138 — expected-context versioning.
 *
 * The v1 message is a CHARACTERIZATION test: existing edge signers in the wild
 * recompute it byte-for-byte, so adding v2 must not perturb it by even a
 * character. The v2 cases pin the property that makes delegation-rail signing
 * safe — the typed-data commitment is inside the signed message, and the two
 * versions cannot be mistaken for one another.
 */
describe('buildX402ExpectedMessage — v1/v2 (#1138)', () => {
  it('v1 is byte-identical to the pre-#1138 message when no typedDataHash is given', () => {
    // Locked literal, not a re-derivation: a test that recomputes the message
    // the same way the code does would pass through any change to both.
    expect(buildX402ExpectedMessage(BASE)).toBe(
      'Haven x402 expected context v1\n' +
        '{"amount":"40000","asset":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",' +
        '"kind":"haven.x402.expected","merchantTo":"0x000000000000000000000000000000000000dead",' +
        `"network":"base","payloadHash":"0x${'cd'.repeat(32)}","paymentId":"pay_x402",` +
        '"resourceUrl":"https://merchant.test/paid","version":1}',
    )
  })

  it('switches to v2 and commits to the digest when typedDataHash is present', () => {
    const message = buildX402ExpectedMessage({ ...BASE, typedDataHash: `0x${'ab'.repeat(32)}` })
    expect(message.startsWith('Haven x402 expected context v2\n')).toBe(true)
    expect(message).toContain(`"typedDataHash":"0x${'ab'.repeat(32)}"`)
    expect(message).toContain('"version":2')
  })

  it('lower-cases the digest so casing cannot split the binding', () => {
    const upper = buildX402ExpectedMessage({ ...BASE, typedDataHash: `0x${'AB'.repeat(32)}` })
    const lower = buildX402ExpectedMessage({ ...BASE, typedDataHash: `0x${'ab'.repeat(32)}` })
    expect(upper).toBe(lower)
  })

  it('makes a v2 context unrepresentable as v1 — the downgrade this exists to stop', () => {
    const v1 = buildX402ExpectedMessage(BASE)
    const v2 = buildX402ExpectedMessage({ ...BASE, typedDataHash: `0x${'ab'.repeat(32)}` })
    expect(v2).not.toBe(v1)
    // The version appears in BOTH the header line and the signed payload, so a
    // v2 message cannot be re-read as a v1 one by stripping the prefix.
    expect(v1).not.toContain('typedDataHash')
    expect(v1).toContain('"version":1')
  })
})
