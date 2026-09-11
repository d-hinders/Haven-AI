import { describe, expect, it } from 'vitest'
import { RETRY_SWEEP_INTERVAL_DEFAULT_MS, RETRY_SWEEP_INTERVAL_FLOOR_MS, parseRetrySweepIntervalMs } from '../config.js'

/** `HAVEN_ACCOUNTING_RETRY_SWEEP_INTERVAL_MS` (#2866, review on #2899). */
describe('parseRetrySweepIntervalMs (#2866)', () => {
  it('defaults to 5 minutes when unset, empty, 0 or not a number', () => {
    for (const raw of [undefined, null, '', '0', 'abc']) expect(parseRetrySweepIntervalMs(raw), String(raw)).toBe(RETRY_SWEEP_INTERVAL_DEFAULT_MS)
    expect(RETRY_SWEEP_INTERVAL_DEFAULT_MS).toBe(300_000)
  })
  it('accepts a sane value', () => {
    expect(parseRetrySweepIntervalMs('120000')).toBe(120_000)
  })
  it('never goes below the 10 s floor — a negative value must not spin the interval', () => {
    // MUTATION TARGET: without the floor, -5 reaches setInterval and Node clamps it to 1 ms.
    expect(parseRetrySweepIntervalMs('-5')).toBe(RETRY_SWEEP_INTERVAL_FLOOR_MS)
    expect(parseRetrySweepIntervalMs('1')).toBe(RETRY_SWEEP_INTERVAL_FLOOR_MS)
    expect(RETRY_SWEEP_INTERVAL_FLOOR_MS).toBe(10_000)
  })
})
