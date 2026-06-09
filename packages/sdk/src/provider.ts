import { ethers } from 'ethers'

export function createJsonRpcProvider(url: string): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(url)
}
