import { ethers } from 'ethers'

export function createJsonRpcProvider(url: string): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(url)
}

export function createWallet(privateKey: string, provider: ethers.JsonRpcProvider): ethers.Wallet {
  return new ethers.Wallet(privateKey, provider)
}

export function createErc20Contract(
  address: string,
  abi: readonly string[],
  signer: ethers.Signer,
): ethers.Contract {
  return new ethers.Contract(address, abi as string[], signer)
}
