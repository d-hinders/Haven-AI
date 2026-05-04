import { JsonRpcProvider, Wallet, formatEther, parseEther } from 'ethers'
import { config } from '../config.js'
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
 * Returns a signer connected to the given chain's RPC, funded by RELAYER_PRIVATE_KEY.
 * The signer is reused across calls for the same chainId (cached).
 */
export function getRelayer(chainId: number): Wallet {
  let relayer = relayers.get(chainId)
  if (!relayer) {
    if (!config.relayerPrivateKey) {
      throw new Error('RELAYER_PRIVATE_KEY environment variable is not set')
    }
    relayer = new Wallet(config.relayerPrivateKey, getProvider(chainId))
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
