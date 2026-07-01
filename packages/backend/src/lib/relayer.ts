import { JsonRpcProvider, Wallet, formatEther, parseEther } from 'ethers'
import { relayerPrivateKeyForChain } from '../config.js'
import { getChain } from './chains.js'

const providers = new Map<number, JsonRpcProvider>()
const relayers = new Map<number, Wallet>()

function getProvider(chainId: number): JsonRpcProvider {
  let provider = providers.get(chainId)
  if (!provider) {
    provider = new JsonRpcProvider(getChain(chainId).rpcUrl)
    providers.set(chainId, provider)
  }
  return provider
}

/**
 * Returns a signer connected to the given chain's RPC, funded by the relayer key
 * for that chain — `RELAYER_PRIVATE_KEY_<chainId>` with a global
 * `RELAYER_PRIVATE_KEY` fallback (#640). This is the signer that submits Safe
 * **deploys** and **execTransaction**, so it must resolve per chain to honour the
 * per-chain relayer isolation; otherwise a single backend serving multiple chains
 * would deploy/exec on every chain with the same key (e.g. a prod Base Sepolia
 * deploy run by the mainnet relayer key → unfunded on Sepolia). Cached per chainId.
 */
export function getRelayer(chainId: number): Wallet {
  let relayer = relayers.get(chainId)
  if (!relayer) {
    const key = relayerPrivateKeyForChain(chainId)
    if (!key) {
      throw new Error(
        `No relayer key for chain ${chainId} — set RELAYER_PRIVATE_KEY_${chainId} or RELAYER_PRIVATE_KEY`,
      )
    }
    relayer = new Wallet(key, getProvider(chainId))
    relayers.set(chainId, relayer)
  }
  return relayer
}

export async function warnIfRelayerLow(
  chainId: number,
  minBalanceWei: bigint = parseEther('0.01'),
): Promise<void> {
  const relayer = getRelayer(chainId)
  const provider = relayer.provider
  if (!provider) {
    throw new Error(`Relayer provider not configured for chain ${chainId}`)
  }
  const balance = await provider.getBalance(relayer.address)

  if (balance < minBalanceWei) {
    console.warn(
      `Relayer balance is low on chain ${chainId}: ${formatEther(balance)} < ${formatEther(minBalanceWei)}`,
    )
  }
}
