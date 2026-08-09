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

// Third column: the site's divert marker — the coverage decision whose queue/
// insufficient branch returns WITHOUT signing (mpp send diverts on a raw
// comparison rather than decideCoverage).
const SIGN_HASH_BUILDERS = [
  ['x402 authorize', '../../x402/legacy-authorize.ts', 'decideCoverage('],
  ['payments', '../../../routes/payments.ts', 'decideCoverage('],
  ['mpp send', '../send.ts', 'amountRaw > effective.remaining'],
  ['mpp authorize', '../authorize.ts', 'decideCoverage('],
] as const

describe('every legacy-rail sign_hash builder is nonce-coordinated (#1196)', () => {
  it.each(SIGN_HASH_BUILDERS)('%s waits for a fresh nonce AND USES the result', (_name, rel) => {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
    // It builds a transfer hash…
    expect(src).toMatch(/generateTransferHash\(/)

    // …so it must resolve the nonce through the coordinator AND assign the
    // result back. Asserting the call alone was this test's own tautology,
    // found by mutation in the promotion-batch review: dropping the
    // assignment — `await waitForFreshAllowanceNonce(` instead of
    // `onChainAllowance.nonce = await …` — let the stale raw nonce flow into
    // the sign hash with all 1579 tests green. The call was never the point;
    // the assignment is.
    expect(src).toMatch(/onChainAllowance\.nonce\s*=\s*await\s+waitForFreshAllowanceNonce\(/)
  })

  it.each(SIGN_HASH_BUILDERS)('%s PREFETCHES the shared watermark', (_name, rel) => {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
    // Prefetched alongside the chain reads, and handed over — not left for the
    // coordinator to fetch serially on the request path.
    expect(src).toMatch(/readSharedWatermark\(/)
    expect(src).toMatch(/\{ sharedWatermark \}/)
  })

  it.each(SIGN_HASH_BUILDERS)('%s waits only AFTER the divert branch (#1209)', (_name, rel, divert) => {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8')
    // The queue/insufficient branches sign nothing, so the bounded wait must
    // not tax them: the coordinator assignment sits below the coverage
    // decision, next to the hash it feeds. Position, not just presence — the
    // #1196 assertions above stay true under either ordering.
    const divertAt = src.indexOf(divert)
    const waitAt = src.indexOf('onChainAllowance.nonce = await waitForFreshAllowanceNonce(')
    expect(divertAt, `divert marker missing: ${divert}`).toBeGreaterThan(-1)
    expect(waitAt, 'coordinator assignment missing').toBeGreaterThan(-1)
    expect(waitAt, 'the wait must come after the divert decision').toBeGreaterThan(divertAt)
  })
})
