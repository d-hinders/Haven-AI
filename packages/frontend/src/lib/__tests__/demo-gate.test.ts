import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `isDemoPageVisible` (#3477): production always 404s, and so does a
 * non-production build whose default chain has no faucet — the second gate
 * exists because a misconfigured non-production build could otherwise
 * default to a real-money chain and still pass the env-name check alone.
 *
 * `DEFAULT_CHAIN_ID` (`lib/chains.ts`) is computed once at module load from
 * `NEXT_PUBLIC_HAVEN_CHAIN_ID`, so changing it per test needs
 * `vi.resetModules()` plus a dynamic re-import — `vi.stubEnv` alone would not
 * be seen by an already-loaded module.
 */
describe('isDemoPageVisible (#3477)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  async function loadGate() {
    vi.resetModules()
    return import('@/lib/demo-gate')
  }

  it.each(['', 'production', 'prod'])(
    '404s on production (NEXT_PUBLIC_HAVEN_ENV=%j), even with a testnet default chain configured',
    async (value) => {
      vi.stubEnv('NEXT_PUBLIC_HAVEN_ENV', value)
      vi.stubEnv('NEXT_PUBLIC_HAVEN_CHAIN_ID', '84532')
      vi.stubEnv('HAVEN_DEMO_PAGE_VISIBLE', '')
      const { isDemoPageVisible } = await loadGate()
      expect(isDemoPageVisible()).toBe(false)
    },
  )

  it('404s on a non-production build whose default chain has no faucet (production\'s mainnet default)', async () => {
    vi.stubEnv('NEXT_PUBLIC_HAVEN_ENV', 'dev')
    vi.stubEnv('NEXT_PUBLIC_HAVEN_CHAIN_ID', '')
    vi.stubEnv('HAVEN_DEMO_PAGE_VISIBLE', '')
    const { isDemoPageVisible } = await loadGate()
    // No NEXT_PUBLIC_HAVEN_CHAIN_ID configured falls back to Base mainnet
    // (`lib/chains.ts`'s ACTIVE_CHAIN default), which has no faucet.
    expect(isDemoPageVisible()).toBe(false)
  })

  it('renders on the real dev configuration: non-production env, Base Sepolia default chain', async () => {
    vi.stubEnv('NEXT_PUBLIC_HAVEN_ENV', 'dev')
    vi.stubEnv('NEXT_PUBLIC_HAVEN_CHAIN_ID', '84532')
    vi.stubEnv('HAVEN_DEMO_PAGE_VISIBLE', '')
    const { isDemoPageVisible } = await loadGate()
    expect(isDemoPageVisible()).toBe(true)
  })

  it('the HAVEN_DEMO_PAGE_VISIBLE override renders even under the production convention', async () => {
    // This is exactly the visual-regression Playwright server's shape: no
    // NEXT_PUBLIC_HAVEN_ENV, no NEXT_PUBLIC_HAVEN_CHAIN_ID — production by
    // convention — with only the server-only override set, and no VERCEL
    // (Playwright's server runs outside Vercel).
    vi.stubEnv('NEXT_PUBLIC_HAVEN_ENV', '')
    vi.stubEnv('NEXT_PUBLIC_HAVEN_CHAIN_ID', '')
    vi.stubEnv('HAVEN_DEMO_PAGE_VISIBLE', '1')
    vi.stubEnv('VERCEL', '')
    const { isDemoPageVisible } = await loadGate()
    expect(isDemoPageVisible()).toBe(true)
  })

  it('the override does nothing on Vercel, even if HAVEN_DEMO_PAGE_VISIBLE were set there by mistake', async () => {
    vi.stubEnv('NEXT_PUBLIC_HAVEN_ENV', '')
    vi.stubEnv('NEXT_PUBLIC_HAVEN_CHAIN_ID', '')
    vi.stubEnv('HAVEN_DEMO_PAGE_VISIBLE', '1')
    // Vercel sets this on every build, in every one of its own environments.
    vi.stubEnv('VERCEL', '1')
    const { isDemoPageVisible } = await loadGate()
    expect(isDemoPageVisible()).toBe(false)
  })

  it('is NOT a NEXT_PUBLIC_-prefixed variable — production config never sets it, and Next never inlines it client-side', () => {
    const source = readFileSync(join(__dirname, '..', 'demo-gate.ts'), 'utf8')
    expect(source).toContain('HAVEN_DEMO_PAGE_VISIBLE')
    expect(source).not.toContain('NEXT_PUBLIC_HAVEN_DEMO')
  })
})
