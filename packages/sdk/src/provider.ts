import { ethers } from 'ethers'

export function createJsonRpcProvider(url: string): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(url)
}

export function createWallet(privateKey: string, provider: ethers.JsonRpcProvider): ethers.Wallet {
  return new ethers.Wallet(privateKey, provider)
}

/**
 * `runner` is a `ContractRunner`, not a `Signer`: a read-only call such as
 * `balanceOf` only needs a provider, and requiring a signer would have forced
 * the #1521 balance check to construct a wallet it never uses.
 */
export function createErc20Contract(
  address: string,
  abi: readonly string[],
  runner: ethers.ContractRunner,
): ethers.Contract {
  return new ethers.Contract(address, abi as string[], runner)
}
