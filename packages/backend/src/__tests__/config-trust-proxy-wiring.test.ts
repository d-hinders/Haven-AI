import { afterEach, describe, it, expect, vi } from 'vitest'

/**
 * The WIRING, not just the function (#2630, following the #2615 lesson).
 *
 * `config-trust-proxy.test.ts` proves `parseTrustProxyHops` behaves. It does
 * not prove `config.trustProxyHops` goes through it — and reverting the call
 * site to a bare `Number(process.env.TRUST_PROXY_HOPS) || 0` would leave that
 * suite green while silently reintroducing exactly the defect #2630 reports:
 * production booting on an unset `TRUST_PROXY_HOPS` with nothing in the logs
 * to say so.
 */
describe('config wires TRUST_PROXY_HOPS through parseTrustProxyHops (#2630)', () => {
  const saved = process.env.TRUST_PROXY_HOPS

  afterEach(() => {
    if (saved === undefined) delete process.env.TRUST_PROXY_HOPS
    else process.env.TRUST_PROXY_HOPS = saved
    vi.restoreAllMocks()
  })

  it('an unset TRUST_PROXY_HOPS warns at MODULE LOAD, and a set one does not', async () => {
    delete process.env.TRUST_PROXY_HOPS
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.resetModules()
    const unset = await import('../config.js')
    expect(unset.config.trustProxyHops).toBe(0)
    const unsetWarnings = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => /TRUST_PROXY_HOPS is not set/.test(m))
    expect(unsetWarnings).toHaveLength(1)

    // Positive control on the other side: configured NON-zero, and the unset
    // warning is gone.
    process.env.TRUST_PROXY_HOPS = '1'
    warn.mockClear()
    vi.resetModules()
    const set = await import('../config.js')
    expect(set.config.trustProxyHops).toBe(1)
    expect(
      warn.mock.calls.map((c) => String(c[0])).filter((m) => /TRUST_PROXY_HOPS is not set/.test(m)),
    ).toHaveLength(0)
  })

  it('an explicitly-set 0 warns at MODULE LOAD with the same message the parser emits (#2667)', async () => {
    // The wiring must route through parseTrustProxyHops for the 0 branch too:
    // a call site that inlined Number()||0 for the variable would silently
    // reintroduce the #2667 silence on the state the tier treats as
    // unconfigured, while every direct parser test stays green.
    process.env.TRUST_PROXY_HOPS = '0'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.resetModules()
    const mod = await import('../config.js')
    expect(mod.config.trustProxyHops).toBe(0)
    const zeroWarnings = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => /explicitly set to "0", which resolves to 0/.test(m))
    expect(zeroWarnings).toHaveLength(1)
    // Distinct from the unset warning — "you set 0" is a different operator
    // situation from "you set nothing".
    expect(
      warn.mock.calls.map((c) => String(c[0])).filter((m) => /TRUST_PROXY_HOPS is not set/.test(m)),
    ).toHaveLength(0)
  })
})
