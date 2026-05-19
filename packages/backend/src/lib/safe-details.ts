import { ethers } from 'ethers'
import { getProvider } from './allowance-module.js'
import { createCache } from './cache.js'

// Minimal Safe ABI for reading state
const SAFE_ABI = [
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
]

export interface SafeDetails {
  address: string
  owners: string[]
  threshold: number
  nonce: number
}

const safeDetailsCache = createCache<SafeDetails>(30_000)

export async function getSafeDetails(
  safeAddress: string,
  chainId: number,
): Promise<SafeDetails> {
  const cacheKey = `safe-details:${chainId}:${safeAddress.toLowerCase()}`

  return safeDetailsCache.getOrFetch(cacheKey, async () => {
    const provider = getProvider(chainId)
    const safeContract = new ethers.Contract(safeAddress, SAFE_ABI, provider)

    const [owners, threshold, nonce] = await Promise.all([
      safeContract.getOwners() as Promise<string[]>,
      safeContract.getThreshold() as Promise<bigint>,
      safeContract.nonce() as Promise<bigint>,
    ])

    return {
      address: safeAddress,
      owners: owners.map((owner: string) => owner),
      threshold: Number(threshold),
      nonce: Number(nonce),
    }
  })
}
