import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #4654 (epic #4484, Railway incident 2026-10-21): the incident itself.
 *
 * `relayer-balance-monitor` logged `relayer balance read failed … invalid
 * BytesLike value` for chains 8453 and 84532, and the echoed value was the
 * production `RELAYER_PRIVATE_KEY` (#4487). This suite reproduces that path
 * end-to-end: the REAL `getRelayer` and the REAL `relayerPrivateKeyForChain`
 * run, with only the spend summary stubbed (it is a database read, not part of
 * the key path). The existing `relayer-balance-monitor.test.ts` mocks
 * `../relayer.js` and `config.js` wholesale, so a case added there would never
 * construct a wallet and could not catch this.
 *
 * Both supported chains get a malformed key so neither reaches a provider: the
 * refusal happens before `getProvider`, which is also why no RPC dial occurs.
 */
const SENTINEL = 'deadbeef'.repeat(8)
const MARKER = SENTINEL.slice(0, 16)

const ECHOING_FORMS: Array<[string, string]> = [
  ['a quoted value', `"0x${SENTINEL}"`],
  ['a NAME=-prefixed value', `RELAYER_PRIVATE_KEY=0x${SENTINEL}`],
  ['a value with an internal non-hex character', `0x${SENTINEL.slice(0, 32)}zz${SENTINEL.slice(32)}`],
]

vi.mock('../relayer-spend-guard.js', () => ({
  relayerSpendSummary: async () => [],
}))

const { runRelayerBalanceMonitor } = await import('../relayer-balance-monitor.js')

const CLEARED = ['RELAYER_PRIVATE_KEY', 'RELAYER_PRIVATE_KEY_8453', 'RELAYER_PRIVATE_KEY_84532'] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of CLEARED) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of CLEARED) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe('runRelayerBalanceMonitor — a malformed key never reaches the log (#4654)', () => {
  it.each(ECHOING_FORMS)('with %s, no captured log field carries the value', async (_label, raw) => {
    process.env.RELAYER_PRIVATE_KEY_8453 = raw
    process.env.RELAYER_PRIVATE_KEY_84532 = raw

    const warn = vi.fn()
    const info = vi.fn()
    await runRelayerBalanceMonitor({ warn, info })

    const calls = [...warn.mock.calls, ...info.mock.calls]
    expect(calls.length).toBeGreaterThan(0)
    expect(JSON.stringify(calls)).not.toContain(MARKER)

    // The failure is the monitor's own catch, and the error it logged came from
    // the helper inside the REAL getRelayer — it names the variable and carries
    // no part of the value.
    const failures = warn.mock.calls.filter((c) => c[1] === 'relayer balance read failed')
    expect(failures.length).toBe(2)
    for (const [fields] of failures) {
      const err = String((fields as { err: string }).err)
      expect(err).toMatch(/RELAYER_PRIVATE_KEY_845(3|32)/)
      expect(err).not.toContain(MARKER)
    }
  })
})
