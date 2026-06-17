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
