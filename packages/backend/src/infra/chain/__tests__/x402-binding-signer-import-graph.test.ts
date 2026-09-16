import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #3046: `x402-binding-signer.ts` must be importable WITHOUT the backend's
 * runtime env. The mcp-server's `x402-expected-wire-contract.test.ts` imports
 * it across the package boundary to prove the wire contract byte-for-byte,
 * and the MCP CI job carries no `DATABASE_URL`. #3023 pointed the flag import
 * at `config.ts`, whose module-level `config` object calls
 * `requireEnv('DATABASE_URL')` at evaluation — the suite could not load.
 *
 * Mutation that must redden this: re-point the `parseBooleanFlag` import in
 * `x402-binding-signer.ts` at `../../config.js`.
 */
describe('x402-binding-signer import graph (#3046)', () => {
  const saved: Record<string, string | undefined> = {}
  const REQUIRED = ['DATABASE_URL', 'JWT_SECRET'] as const

  beforeEach(() => {
    vi.resetModules()
    for (const k of REQUIRED) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    delete process.env.X402_EMIT_PAYER_CONTEXT
  })

  afterEach(() => {
    for (const k of REQUIRED) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    vi.resetModules()
  })

  it('imports with DATABASE_URL and JWT_SECRET unset — it must not evaluate config.ts', async () => {
    // Sanity: config.ts itself DOES refuse in this env, so a green here is
    // the binding signer's own import graph, not a lenient environment.
    await expect(import('../../../config.js')).rejects.toThrow(/DATABASE_URL/)
    vi.resetModules()
    const mod = await import('../x402-binding-signer.js')
    expect(typeof mod.readEmitPayerContext).toBe('function')
  })
})
