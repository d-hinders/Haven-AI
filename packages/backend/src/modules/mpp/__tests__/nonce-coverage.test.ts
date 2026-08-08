/**
 * All four sign-hash builders consult the nonce coordinator (#1196).
 *
 * #692 wired it into ONE call site. The other three built a `sign_hash` from a
 * raw on-chain nonce, so a stale read meant a revert and a retry there — safe,
 * because the #693 preflight covers every path, but exactly the failure #692
 * set out to remove. This asserts the wiring structurally: a test that mocked
 * its way to a green result would not have caught the gap either.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const SIGN_HASH_BUILDERS = [
  ['x402 authorize', '../../x402/legacy-authorize.ts'],
  ['payments', '../../../routes/payments.ts'],
  ['mpp send', '../send.ts'],
  ['mpp authorize', '../authorize.ts'],
] as const

describe('every legacy-rail sign_hash builder is nonce-coordinated (#1196)', () => {
  it.each(SIGN_HASH_BUILDERS)('%s waits for a fresh nonce', (_name, rel) => {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
    // It builds a transfer hash…
    expect(src).toMatch(/generateTransferHash\(/)
    // …so it must resolve the nonce through the coordinator first.
    expect(src).toMatch(/waitForFreshAllowanceNonce\(/)
  })

  it.each(SIGN_HASH_BUILDERS)('%s PREFETCHES the shared watermark', (_name, rel) => {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
    // Prefetched alongside the chain reads, and handed over — not left for the
    // coordinator to fetch serially on the request path.
    expect(src).toMatch(/readSharedWatermark\(/)
    expect(src).toMatch(/\{ sharedWatermark \}/)
  })
})
