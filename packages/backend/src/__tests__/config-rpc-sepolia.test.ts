import { describe, it, expect, vi } from 'vitest'
import { warnPublicBaseSepoliaRpc } from '../config.js'

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
  it('the public default resolves unchanged but WARNS once, naming the operator remedy', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(warnPublicBaseSepoliaRpc('https://sepolia.base.org')).toBe('https://sepolia.base.org')
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0][0])
    expect(message).toMatch(/RPC_URL_BASE_SEPOLIA is not set/)
    expect(message).toMatch(/https:\/\/sepolia\.base\.org/)
    expect(message).toMatch(/Set RPC_URL_BASE_SEPOLIA/)
    warn.mockRestore()
  })

  it('a configured provider endpoint is passed through SILENTLY — that is the configured state, not a defect', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(warnPublicBaseSepoliaRpc('https://example.invalid/rpc')).toBe('https://example.invalid/rpc')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
