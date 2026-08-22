import { describe, it, expect, vi } from 'vitest'
import { parseTrustProxyHops } from '../config.js'

/**
 * #1670: the parser's job is to never DISARM silently. The tier returns no
 * limit at 0 hops by design, so a value that quietly parses to 0 leaves the
 * front door unthrottled while the operator believes it is protected — the
 * exact incident that motivated this: the first dev rollout set the variable
 * and probes still went unthrottled, with nothing anywhere saying why.
 */
describe('parseTrustProxyHops (#1670)', () => {
  it('a plain count parses', () => {
    expect(parseTrustProxyHops('1')).toBe(1)
    expect(parseTrustProxyHops('2')).toBe(2)
  })

  it('unset and empty mean untrusted, with no warning — that is the default, not an error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseTrustProxyHops(undefined)).toBe(0)
    expect(parseTrustProxyHops('')).toBe(0)
    expect(parseTrustProxyHops('  ')).toBe(0)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('MUTATION PROOF: dashboard paste artefacts — quotes, whitespace — still arm', () => {
    // Number('"1"') is NaN. Without the quote-stripping, an operator pasting
    // the value with quotes gets a silently disarmed tier and no signal.
    expect(parseTrustProxyHops('"1"')).toBe(1)
    expect(parseTrustProxyHops("'1'")).toBe(1)
    expect(parseTrustProxyHops(' 1 ')).toBe(1)
    expect(parseTrustProxyHops('" 1 "')).toBe(1)
  })

  it('garbage warns LOUDLY and disarms — never guesses a hop count', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // `true` especially: it is the spoofable Fastify mode this setting exists
    // to avoid, and must never be coerced into a count.
    for (const bad of ['true', 'yes', '1.5', '-1', 'one']) {
      expect(parseTrustProxyHops(bad), bad).toBe(0)
    }
    expect(warn).toHaveBeenCalledTimes(5)
    expect(String(warn.mock.calls[0][0])).toMatch(/DISARMED/)
    warn.mockRestore()
  })
})
