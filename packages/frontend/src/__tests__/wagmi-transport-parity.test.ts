/**
 * Every chain Haven OFFERS has a wagmi transport (#1971).
 *
 * ── The defect this exists to make impossible ────────────────────────────────
 *
 * `lib/chains.ts` owns which chains the product offers (`SUPPORTED_CHAIN_IDS`,
 * read by every network picker, by wallet network-validation, and by
 * `DEFAULT_CHAIN_ID`). `lib/wagmi.ts` owns which chains the app can actually
 * TALK to. For as long as both existed, they were two hand-maintained lists,
 * and they disagreed: chains.ts offered 8453 **and** 84532, wagmi.ts registered
 * only `base`.
 *
 * Nothing failed. `@wagmi/core`'s `getClient` catches `ChainNotConfiguredError`
 * and returns `undefined`, so `usePublicClient({ chainId: 84532 })` was
 * `undefined`, and every consumer guards on exactly that and returns:
 *
 *     if (!publicClient || !safeAddress) { setLoading(false); return }
 *
 * No request, no error, no visible failure — just the empty branch of a surface
 * that had data. The dev deployment DEFAULTS to 84532
 * (`NEXT_PUBLIC_HAVEN_CHAIN_ID=84532`, `.env.dev.example:1`), so this was live
 * for real users, and the screenshot harness's fixture sits there too, which is
 * why no JSON-RPC request had ever left the browser in a capture run (#1935).
 *
 * ── Why it asserts through `getClient` and not against a list ────────────────
 *
 * The cheap version of this test compares two arrays of chain ids. That would
 * pass on a config whose `transports` map is keyed correctly and whose entries
 * are unusable, and it restates the code rather than exercising it. This calls
 * the SAME `@wagmi/core` function the hooks call, on the real exported config,
 * and asserts what the hooks actually need: a defined client. It is the
 * mechanism that failed, so it is the mechanism that is guarded.
 *
 * Deliberately NOT asserted: which transport, how many endpoints, or that the
 * two lists are equal in the other direction. Registering a transport for a
 * chain not currently offered is harmless; offering a chain with no transport
 * is the defect.
 */
import { describe, expect, it } from 'vitest'
import { getClient } from '@wagmi/core'
import { config } from '@/lib/wagmi'
import { SUPPORTED_CHAIN_IDS, DEFAULT_CHAIN_ID, getChainConfig } from '@/lib/chains'

describe('wagmi transport parity', () => {
  it.each(SUPPORTED_CHAIN_IDS)(
    'chain %i is offered to users AND has a usable wagmi client',
    (chainId) => {
      const client = getClient(config, { chainId })
      expect(
        client,
        `chain ${chainId} (${getChainConfig(chainId).name}) is in SUPPORTED_CHAIN_IDS — it is ` +
          'offered in network pickers and can be a Safe\'s chain — but wagmi has no transport ' +
          'for it, so getClient() returns undefined and every usePublicClient/useWalletClient ' +
          'consumer silently renders its empty branch. Register it in lib/wagmi.ts.',
      ).toBeDefined()
      expect(client?.chain?.id).toBe(chainId)
    },
  )

  it('the build-time default chain has a usable wagmi client', () => {
    // DEFAULT_CHAIN_ID comes from NEXT_PUBLIC_HAVEN_CHAIN_ID at build time, so a
    // deployment can select a chain no test file names. Asserted separately
    // because it is the value a real user lands on with no picker interaction.
    expect(
      getClient(config, { chainId: DEFAULT_CHAIN_ID }),
      `DEFAULT_CHAIN_ID is ${DEFAULT_CHAIN_ID} and wagmi has no transport for it — every ` +
        'chain-fed surface would render empty for a user who never touches a network picker.',
    ).toBeDefined()
  })

  it('a chain the app does NOT offer yields no client — the guard can say no', () => {
    // Proves the instrument. Without this, a `getClient` that returned a client
    // for anything at all would make every assertion above vacuously true.
    expect(getClient(config, { chainId: 1 })).toBeUndefined()
  })
})
