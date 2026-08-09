/**
 * `ChainClient` implementation for the delegation rail (#994).
 *
 * Wraps the SAME `createPublicClient` + `chainForId` + RPC-URL construction
 * `lib/hybrid-provisioning.ts` already uses for the delegation rail's own
 * reads — no new client-construction pattern introduced here.
 *
 * Nothing on the delegation rail reaches for a plain balance read or address
 * checksum directly today (no route in #994's ten calls into this file yet
 * with `rail: 'delegation'`); this implementation exists so `getChainClient`
 * is a genuine two-SDK choice rather than a single hardcoded path, per the
 * issue's acceptance criteria ("Both implementations exist... and wrap
 * existing logic").
 *
 * Because it has no callers, only tests keep it honest: `__tests__/
 * chain-client.test.ts` runs one conformance suite against BOTH
 * implementations (#1149). That suite exists because they had already
 * drifted — this file used to answer a zero token address with the NATIVE
 * balance while `ethers-client.ts` built a contract at `0x0`.
 */
import { createPublicClient, http, getAddress as viemGetAddress, erc20Abi, type Address as ViemAddress } from 'viem'
import { getChain } from '../../domain/chains.js'
import { chainForId } from '../../rails/delegation-contracts.js'
import type { ChainClient } from '../../domain/chain-client.js'
import { assertErc20TokenAddress } from './token-address-guard.js'

function publicClientFor(chainId: number) {
  return createPublicClient({
    chain: chainForId(chainId),
    transport: http(getChain(chainId).rpcUrl),
  })
}

export const viemChainClient: ChainClient = {
  async getNativeBalance(chainId, address) {
    return publicClientFor(chainId).getBalance({ address: address as ViemAddress })
  },

  async getTokenBalance(chainId, tokenAddress, address) {
    assertErc20TokenAddress(tokenAddress)
    return publicClientFor(chainId).readContract({
      address: tokenAddress as ViemAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [address as ViemAddress],
    })
  },

  normaliseAddress(address) {
    return viemGetAddress(address.toLowerCase() as ViemAddress)
  },
}
