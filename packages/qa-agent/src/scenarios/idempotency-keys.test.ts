/**
 * #1534 — every money-flow leg that BUYS something must supply its own
 * per-attempt idempotency key.
 *
 * `qa-dev.yml` retries the whole suite ~30s after a failure, well inside the
 * SDK's 5-minute idempotency bucket. A leg that supplies no key inherits the
 * synthesised one, attempt 2 collapses onto attempt 1's settled payment, and
 * the #1521 guard correctly refuses to re-authorize it. The leg then reports a
 * failure that attempt 1 caused — the retry tests a dirtied slate, not a clean
 * one, which is the opposite of what a flake-retry is for.
 *
 * That is how `x402-sweep-recovery` went red on 2026-08-18 having passed on
 * attempt 1, and #1520 fixed only the two legs it happened to touch.
 *
 * These rules are derived from the sources rather than checked against a list
 * of leg names. A hand-maintained list is the defect #1526 fixed twice in one
 * day — and it is also how #1520's fix reached two legs and stopped.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const DIR = fileURLToPath(new URL('.', import.meta.url))

const scenarios = readdirSync(DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'types.ts')
  .map((f) => ({ name: f, src: readFileSync(join(DIR, f), 'utf8') }))

describe('#1534 — per-attempt idempotency keys', () => {
  it('finds the scenario files at all (a vacuous pass would hide everything below)', () => {
    expect(scenarios.length).toBeGreaterThan(5)
  })

  it.each(scenarios)('$name does not hand-roll an idempotency key', ({ src }) => {
    // `Date.now()` is per-attempt-distinct in practice but collides inside a
    // millisecond, and duplicating the helper is how the two spellings drifted
    // apart in the first place. One helper, one meaning.
    const handRolled = /idempotency_?[kK]ey:\s*`[^`]*\$\{Date\.now\(\)\}/.test(src)
    expect(handRolled, 'use freshPurchaseIdempotencyKey() instead of a Date.now() key').toBe(false)
  })

  it.each(scenarios)('$name supplies a key wherever it drives a merchant purchase', ({ src }) => {
    // A purchase through the SDK client is the shape that inherits the
    // synthesised bucket key. Hosted-tool calls pass `idempotency_key`
    // explicitly and are covered by the rule above.
    const buysViaClient = /client\.fetch\(\s*`\$\{ctx\.cfg\.demoMerchantUrl\}/.test(src)
    if (!buysViaClient) return
    expect(
      src.includes('freshPurchaseIdempotencyKey'),
      'a leg that buys through client.fetch must pass freshPurchaseIdempotencyKey — ' +
        'otherwise the SDK synthesises a 5-minute bucket key and the suite retry ' +
        'replays the previous attempt\'s settled payment (#1534)',
    ).toBe(true)
  })

  it('every key the legs do supply comes from the shared helper', () => {
    const offenders = scenarios
      .filter(({ src }) => /idempotency_?[kK]ey:/.test(src))
      .filter(({ src }) => !src.includes('freshPurchaseIdempotencyKey'))
      .map(({ name }) => name)
    expect(offenders, 'these supply a key from somewhere other than the shared helper').toEqual([])
  })
})
