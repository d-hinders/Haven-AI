import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `config.ts` runs `dotenv.config()` on <cwd>/.env and <repo-root>/.env BEFORE
// `requireEnv`, so in a checkout that carries a root `.env` (every developer
// machine) deleting the variables from `process.env` is not enough — dotenv
// puts them straight back and the sanity assertion below would fail with
// "promise resolved instead of rejecting". Disabling dotenv here makes the
// test about the import graph, not about whose `.env` is on disk (review of
// #3047). The mutation below still reddens: with dotenv inert, `config.ts`
// throws on the bare env exactly as it does in CI.
vi.mock('dotenv', () => ({
  default: { config: () => ({ error: new Error('dotenv disabled in this guard (#3046)') }) },
}))

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
  // The flag is cleared too so `readEmitPayerContext` cannot refuse on a
  // developer's shell value and masquerade as the import-graph failure.
  const CLEARED = ['DATABASE_URL', 'JWT_SECRET', 'X402_EMIT_PAYER_CONTEXT'] as const

  beforeEach(() => {
    vi.resetModules()
    for (const k of CLEARED) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of CLEARED) {
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
