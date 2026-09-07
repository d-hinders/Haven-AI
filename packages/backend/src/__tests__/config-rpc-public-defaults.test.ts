import { afterEach, describe, it, expect, vi } from 'vitest'
import { warnPublicBaseMainnetRpc, warnPublicBaseSepoliaRpc } from '../config.js'

/**
 * #2511: the public Base Sepolia RPC default must be distinguishable from a
 * configured value. When `RPC_URL_BASE_SEPOLIA` is unset the backend writes
 * on-chain legs through the SHARED public endpoint, and a provider outage
 * there surfaces as qa-dev failures whose 502 bodies carry
 * `URL: https://sepolia.base.org` — run 33796886018 produced eight of them
 * with no Haven change involved. The warning exists so the logs say so at
 * boot, on the pattern `parseTrustProxyHops` set: never silent where an
 * operator would otherwise believe the endpoint was chosen on purpose.
 */
describe('warnPublicBaseSepoliaRpc (#2511)', () => {
  it('unset resolves to the public default, WARNS once, and names the operator remedy', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(warnPublicBaseSepoliaRpc(undefined)).toBe('https://sepolia.base.org')
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0][0])
    expect(message).toMatch(/RPC_URL_BASE_SEPOLIA is not set/)
    expect(message).toMatch(/https:\/\/sepolia\.base\.org/)
    expect(message).toMatch(/Set RPC_URL_BASE_SEPOLIA/)
    warn.mockRestore()
  })

  it('empty and whitespace count as unset — Railway can store an empty string, and "cleared" must warn like "never configured"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(warnPublicBaseSepoliaRpc('')).toBe('https://sepolia.base.org')
    expect(warnPublicBaseSepoliaRpc('   ')).toBe('https://sepolia.base.org')
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('a configured provider endpoint is passed through SILENTLY — that is the configured state, not a defect', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(warnPublicBaseSepoliaRpc('https://example.invalid/rpc')).toBe('https://example.invalid/rpc')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('MUTATION PROOF: explicitly SET to the same public URL stays silent — the warning keys on the raw value, not the resolved one', () => {
    // If the branch keyed on the resolved URL instead, this deliberate
    // configuration would produce a warning whose first clause ("is not set")
    // is factually wrong in the operator's own logs.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(warnPublicBaseSepoliaRpc('https://sepolia.base.org')).toBe('https://sepolia.base.org')
    expect(warnPublicBaseSepoliaRpc('  https://sepolia.base.org  ')).toBe('https://sepolia.base.org')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})


/**
 * #2615: the same signal for Base MAINNET, which had none. Production ran on
 * the shared public node with no evidence of any kind — `RPC_URL` was set
 * (Gnosis only) and looked like "RPC is configured", which is the trap the
 * issue names.
 *
 * These assert the MAINNET consequence specifically, not just "a warning
 * fired". A generalised function that silently reused the Sepolia prose would
 * pass a bare `toHaveBeenCalled` and tell an operator the wrong thing about
 * real money.
 */
describe('warnPublicBaseMainnetRpc (#2615)', () => {
  it('unset resolves to the public default, WARNS once, and names the MAINNET consequence', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(warnPublicBaseMainnetRpc(undefined)).toBe('https://mainnet.base.org')
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0][0])
    expect(message).toMatch(/RPC_URL_BASE is not set/)
    expect(message).toMatch(/https:\/\/mainnet\.base\.org/)
    expect(message).toMatch(/Set RPC_URL_BASE/)
    // The consequence is the money one, not a copy of the qa-dev sentence.
    expect(message).toMatch(/MAINNET/)
    expect(message).not.toMatch(/qa-dev/)
    warn.mockRestore()
  })

  it('a configured endpoint is passed through SILENTLY — proven by running it both ways', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Positive control FIRST: the spy can see a warning at all.
    warnPublicBaseMainnetRpc(undefined)
    expect(warn).toHaveBeenCalledTimes(1)

    expect(warnPublicBaseMainnetRpc('https://base.provider.example/rpc')).toBe('https://base.provider.example/rpc')
    // Still one — the configured call added nothing.
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('a variable deliberately SET to the public URL stays silent — set is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(warnPublicBaseMainnetRpc('https://mainnet.base.org')).toBe('https://mainnet.base.org')
    expect(warnPublicBaseMainnetRpc('  https://mainnet.base.org  ')).toBe('https://mainnet.base.org')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('empty and whitespace are UNSET — the operator cleared it, same signal', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(warnPublicBaseMainnetRpc('')).toBe('https://mainnet.base.org')
    expect(warnPublicBaseMainnetRpc('   ')).toBe('https://mainnet.base.org')
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('the two chains do not share a message — a copy-paste generalisation would collapse them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warnPublicBaseSepoliaRpc(undefined)
    warnPublicBaseMainnetRpc(undefined)
    const [sepolia, mainnet] = warn.mock.calls.map((c) => String(c[0]))
    expect(sepolia).not.toBe(mainnet)
    expect(sepolia).toMatch(/RPC_URL_BASE_SEPOLIA/)
    // Guard the substring trap: RPC_URL_BASE_SEPOLIA contains RPC_URL_BASE.
    expect(mainnet).toMatch(/RPC_URL_BASE is not set/)
    expect(mainnet).not.toMatch(/RPC_URL_BASE_SEPOLIA/)
    warn.mockRestore()
  })
})

/**
 * The WIRING, not just the function (#2615).
 *
 * The tests above prove `warnPublicBaseMainnetRpc` behaves. They do not prove
 * `config.rpcUrlBase` goes through it — and that gap is not hypothetical: it
 * is exactly the state this issue found. `rpcUrlBase` was a bare
 * `optionalEnv('RPC_URL_BASE', …)` for as long as the warning existed for
 * Sepolia, so a suite that only exercised the function would have been green
 * on the whole defect.
 *
 * Reverting the call site to `optionalEnv` is a surviving mutation against
 * every other test in this file. This one reddens on it.
 */
describe('config wires the mainnet RPC through the warning (#2615)', () => {
  const saved = process.env.RPC_URL_BASE

  afterEach(() => {
    if (saved === undefined) delete process.env.RPC_URL_BASE
    else process.env.RPC_URL_BASE = saved
    vi.restoreAllMocks()
  })

  it('an unset RPC_URL_BASE warns at MODULE LOAD, and a set one does not', async () => {
    delete process.env.RPC_URL_BASE
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.resetModules()
    const unset = await import('../config.js')
    expect(unset.config.rpcUrlBase).toBe('https://mainnet.base.org')
    const mainnetWarnings = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => /RPC_URL_BASE is not set/.test(m))
    expect(mainnetWarnings).toHaveLength(1)

    // Positive control on the other side: configured, and the warning is gone.
    process.env.RPC_URL_BASE = 'https://base.provider.example/rpc'
    warn.mockClear()
    vi.resetModules()
    const set = await import('../config.js')
    expect(set.config.rpcUrlBase).toBe('https://base.provider.example/rpc')
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => /RPC_URL_BASE is not set/.test(m))).toHaveLength(0)
  })
})

/**
 * The trim, pinned because it is a BEHAVIOUR CHANGE (#2615, found by review).
 *
 * `rpcUrlBase` used to resolve through `optionalEnv`, which is
 * `process.env[k] || fallback` and never trims. Moving it onto `warnPublicRpc`
 * changed two inputs, and the PR body originally claimed the only runtime
 * effect was a log line — which was false. These tests make the change
 * deliberate and guarded rather than incidental.
 */
describe('warnPublicRpc trims, and optionalEnv did not (#2615)', () => {
  it('whitespace-only counts as UNSET — not as a literal whitespace RPC URL', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // optionalEnv would have returned '   ' here and built a provider from it.
    expect(warnPublicBaseMainnetRpc('   ')).toBe('https://mainnet.base.org')
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('a padded URL is trimmed and stays SILENT — the raw value is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The dashboard paste artefact. optionalEnv kept the spaces.
    expect(warnPublicBaseMainnetRpc('  https://base.provider.example/rpc  '))
      .toBe('https://base.provider.example/rpc')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
