/**
 * #3495 — `buildDirectIdempotencyKey`'s own contract, direct (pun intended).
 *
 * The handler-level tests in `tools/state-direct-recovery.test.ts` prove the
 * INTEGRATION: a generated key is echoed and a same-key re-run replays. This
 * file proves the GENERATOR itself has the property that integration relies
 * on implicitly — deterministic, bucketed the same way
 * `buildX402IdempotencyKey` (`@haven_ai/sdk`'s `x402.ts`) already is, so an
 * agent that retries within the bucket (a dropped response, a runtime
 * restart) reaches the SAME key without having to remember one, and two
 * unrelated payments never collide.
 */
import { describe, it, expect } from 'vitest'
import { buildDirectIdempotencyKey } from './mcp-context.js'

const BASE = { token: 'USDC', amount: '1.00', recipient: '0xabc' }
const NOW = 1_800_000_000_000 // arbitrary fixed instant

describe('buildDirectIdempotencyKey (#3495)', () => {
  it('is deterministic: identical params + identical bucket produce the identical key', () => {
    const a = buildDirectIdempotencyKey(BASE, NOW)
    const b = buildDirectIdempotencyKey(BASE, NOW)
    expect(a).toBe(b)
  })

  it('is shaped "direct:" + 16 lowercase hex characters', () => {
    const key = buildDirectIdempotencyKey(BASE, NOW)
    expect(key).toMatch(/^direct:[0-9a-f]{16}$/)
  })

  it('is token/amount/recipient-sensitive — no two distinct payments collide', () => {
    const base = buildDirectIdempotencyKey(BASE, NOW)
    expect(buildDirectIdempotencyKey({ ...BASE, token: 'ETH' }, NOW)).not.toBe(base)
    expect(buildDirectIdempotencyKey({ ...BASE, amount: '2.00' }, NOW)).not.toBe(base)
    expect(buildDirectIdempotencyKey({ ...BASE, recipient: '0xdef' }, NOW)).not.toBe(base)
  })

  it('is case-insensitive on token and recipient (matches the backend’s own lower-casing)', () => {
    const lower = buildDirectIdempotencyKey(BASE, NOW)
    const upper = buildDirectIdempotencyKey({ ...BASE, token: 'usdc', recipient: '0xABC' }, NOW)
    expect(upper).toBe(lower)
  })

  it('task_budget_id / sub_budget_id are part of the key — a task-scoped and a period-budget send of the same amount never collide', () => {
    const period = buildDirectIdempotencyKey(BASE, NOW)
    const task = buildDirectIdempotencyKey({ ...BASE, taskBudgetId: 'tb_1' }, NOW)
    const sub = buildDirectIdempotencyKey({ ...BASE, subBudgetId: 'sb_1' }, NOW)
    expect(task).not.toBe(period)
    expect(sub).not.toBe(period)
    expect(task).not.toBe(sub)
  })

  it('stays the SAME across a retry a few seconds later — inside the bucket', () => {
    const first = buildDirectIdempotencyKey(BASE, NOW)
    const retry = buildDirectIdempotencyKey(BASE, NOW + 5_000)
    expect(retry).toBe(first)
  })

  it('changes once the retry crosses the bucket boundary — a deliberate re-send is a new payment', () => {
    const first = buildDirectIdempotencyKey(BASE, NOW)
    // #3495: bucket width mirrors the x402 tools' 300_000ms exactly.
    const later = buildDirectIdempotencyKey(BASE, NOW + 300_000)
    expect(later).not.toBe(first)
  })
})
