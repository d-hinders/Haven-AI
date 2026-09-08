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

  it('unset and empty mean untrusted, and now WARN (#2630) — production ran silently disarmed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseTrustProxyHops(undefined)).toBe(0)
    expect(parseTrustProxyHops('')).toBe(0)
    expect(parseTrustProxyHops('  ')).toBe(0)
    expect(warn).toHaveBeenCalledTimes(3)
    for (const call of warn.mock.calls) {
      const message = String(call[0])
      expect(message).toMatch(/TRUST_PROXY_HOPS is not set/)
      expect(message).toMatch(/DISARMED/)
    }
    warn.mockRestore()
  })

  it('explicitly-set 0 now WARNS too, with its OWN message (#2667) — the disarmed state is the hazard, not a spelling', () => {
    // Inverted from #2630's silence pin: the tier returns NO limit at 0 hops
    // (middleware/rate-limit.ts), so "the operator chose 0" is not a
    // configuration to respect — there is no deployment where it is the
    // intended posture. Both raw spellings resolve to 0 and both warn.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseTrustProxyHops('0')).toBe(0)
    expect(parseTrustProxyHops('"0"')).toBe(0)
    expect(warn).toHaveBeenCalledTimes(2)
    for (const call of warn.mock.calls) {
      const message = String(call[0])
      expect(message).toMatch(/explicitly set to/)
      expect(message).toMatch(/resolves to 0/)
      expect(message).toMatch(/DISARMED/)
    }
    warn.mockRestore()
  })

  it('a deliberately-configured NON-zero value stays SILENT — the #2630 convention survives #2667', () => {
    // #2667 narrows the silence convention to values that CONFIGURE the tier.
    // 1 and 2 do; they stay quiet, exactly as #2630 pinned.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseTrustProxyHops('1')).toBe(1)
    expect(parseTrustProxyHops('2')).toBe(2)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('MUTATION PROOF: unset and "invalid" get DIFFERENT messages, not a shared one (#2630)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    parseTrustProxyHops(undefined)
    parseTrustProxyHops('true')
    const [unsetMsg, invalidMsg] = warn.mock.calls.map((c) => String(c[0]))
    expect(unsetMsg).toMatch(/TRUST_PROXY_HOPS is not set/)
    expect(invalidMsg).toMatch(/TRUST_PROXY_HOPS is set to "true", which is not a non-negative integer/)
    expect(unsetMsg).not.toBe(invalidMsg)
    warn.mockRestore()
  })

  it('MUTATION PROOF: all three disarmed spellings get THREE DIFFERENT messages (#2667)', () => {
    // Unset / explicitly-0 / garbage are three distinct operator situations
    // with three distinct remedies. The proof is PAIRWISE: every message
    // matches its own sentinel fragments and none matches a sibling's, so
    // merging any two messages into one — or pointing the explicit-0 branch at
    // either neighbour's string — reddens exactly this test.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    parseTrustProxyHops(undefined)
    parseTrustProxyHops('0')
    parseTrustProxyHops('"0"')
    parseTrustProxyHops('true')
    const messages = warn.mock.calls.map((c) => String(c[0]))
    expect(messages).toHaveLength(4)
    const [unsetMsg, zeroMsg0, zeroMsgQuoted, invalidMsg] = messages
    // Own-sentinel matches: each message names its own situation. The quoted
    // spelling embeds JSON.stringify('"0"') = "\"0\"" (the serializer escapes
    // the inner quotes), so it is matched by substring, not regex.
    expect(unsetMsg).toMatch(/TRUST_PROXY_HOPS is not set/)
    expect(zeroMsg0).toMatch(/explicitly set to "0", which resolves to 0/)
    expect(zeroMsgQuoted).toContain('\\"0\\"')
    expect(zeroMsgQuoted).toMatch(/which resolves to 0/)
    expect(invalidMsg).toMatch(/is set to "true", which is not a non-negative integer/)
    // Pairwise: no message carries a sibling's sentinel.
    expect(zeroMsg0).not.toMatch(/not set/)
    expect(zeroMsgQuoted).not.toMatch(/not set/)
    expect(unsetMsg).not.toMatch(/explicitly set to/)
    expect(invalidMsg).not.toMatch(/explicitly set to/)
    expect(unsetMsg).not.toMatch(/not a non-negative integer/)
    expect(zeroMsg0).not.toMatch(/not a non-negative integer/)
    expect(zeroMsgQuoted).not.toMatch(/not a non-negative integer/)
    // And the two zero spellings differ only in what the operator actually wrote.
    expect(zeroMsg0).not.toBe(zeroMsgQuoted)
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
