/**
 * #3495 (review correction, 2026-09-30) — `generateDirectIdempotencyKey`'s
 * own contract: a fresh, RANDOM key per call, never derived from the
 * payment's parameters.
 *
 * The handler-level tests in `tools/state-direct-recovery.test.ts` prove the
 * INTEGRATION this exists for: two no-key `haven_send`/`haven_pay` calls with
 * identical arguments are two DIFFERENT payments (never silently collapsed
 * into one), and a caller who deliberately wants the SAME payment echoes the
 * key back (`include_signing_payload: true` opt-in re-run). This file proves
 * the generator itself never gives two calls the same key by construction —
 * the property that first design (a bucketed hash of token/amount/recipient)
 * violated: two genuinely separate sends of the same amount to the same
 * recipient within the same window would have collided, and the backend
 * would have silently replayed the first one for the second call.
 */
import { describe, it, expect } from 'vitest'
import { generateDirectIdempotencyKey } from './mcp-context.js'

describe('generateDirectIdempotencyKey (#3495)', () => {
  it('is shaped "direct:" + a UUID', () => {
    const key = generateDirectIdempotencyKey()
    expect(key).toMatch(/^direct:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('never repeats across many calls — no bucketing, no collision by construction', () => {
    const keys = new Set(Array.from({ length: 1000 }, () => generateDirectIdempotencyKey()))
    expect(keys.size).toBe(1000)
  })
})
