/**
 * `ChainClient` implementation for the legacy AllowanceModule rail (#994).
 *
 * Wraps EXISTING `ethers` code rather than reimplementing it: `getProvider`
 * is `lib/allowance-module.ts`'s own per-chain cached `ethers.JsonRpcProvider`
 * (also what the relayer and the rest of the legacy rail use), and the
 * native/ERC-20 balance-read split below is a verbatim relocation of what
 * `routes/balances.ts` used to do inline with its own
 * `new ethers.Contract(...)` — moved here, not rewritten, so #994's route
 * substitution only changes WHERE this runs, never WHAT it does.
 */
import { ethers } from 'ethers'
import { getProvider } from '../../rails/allowance-module.js'
import type { ChainClient } from '../../domain/chain-client.js'
import { assertErc20TokenAddress } from './token-address-guard.js'

// Minimal ERC-20 ABI for balanceOf — same single-function ABI
// routes/balances.ts declared inline before #994.
const ERC20_BALANCE_OF_ABI = ['function balanceOf(address account) view returns (uint256)']

export const ethersChainClient: ChainClient = {
  async getNativeBalance(chainId, address) {
    return getProvider(chainId).getBalance(address)
  },

  async getTokenBalance(chainId, tokenAddress, address) {
    assertErc20TokenAddress(tokenAddress)
    const contract = new ethers.Contract(tokenAddress, ERC20_BALANCE_OF_ABI, getProvider(chainId))
    return (await contract.balanceOf(address)) as bigint
  },

  normaliseAddress(address) {
    return ethers.getAddress(address.toLowerCase())
  },
}
