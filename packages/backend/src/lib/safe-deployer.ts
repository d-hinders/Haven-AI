/**
 * Relay-sponsored Safe deployment.
 *
 * Calls SafeProxyFactory.createProxyWithNonce() from the relayer wallet so
 * the user does not need to pay gas or sign a blockchain transaction.
 * The specified ownerAddress becomes the sole owner (threshold 1).
 */

import { ethers } from 'ethers'
import { getRelayerWallet, getProvider } from './allowance-module.js'
import { getChain } from './chains.js'

const ZERO = '0x0000000000000000000000000000000000000000'

const PROXY_FACTORY_ABI = [
  'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
  'event ProxyCreation(address proxy, address singleton)',
]

const SAFE_SETUP_ABI = [
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
]

export interface SafeDeployResult {
  safeAddress: string
  txHash: string
}

export async function relaySafeDeploy(
  chainId: number,
  ownerAddress: string,
): Promise<SafeDeployResult> {
  const chain = getChain(chainId)
  const relayer = getRelayerWallet(chainId)

  // Encode Safe.setup() initializer: single owner, threshold 1, no modules
  const safeIface = new ethers.Interface(SAFE_SETUP_ABI)
  const initializer = safeIface.encodeFunctionData('setup', [
    [ownerAddress],
    1,
    ZERO,
    '0x',
    chain.contracts.fallbackHandler,
    ZERO,
    0,
    ZERO,
  ])

  const saltNonce = BigInt(Math.floor(Math.random() * 1_000_000_000))

  const factory = new ethers.Contract(
    chain.contracts.safeProxyFactory,
    PROXY_FACTORY_ABI,
    relayer,
  )

  const tx = await factory.createProxyWithNonce(
    chain.contracts.safeSingletonL2,
    initializer,
    saltNonce,
  )

  const receipt = await tx.wait()

  // Extract Safe address from ProxyCreation event
  const factoryIface = new ethers.Interface(PROXY_FACTORY_ABI)
  const proxyCreationTopic = factoryIface.getEvent('ProxyCreation')!.topicHash

  const log = (receipt.logs as ethers.Log[]).find(
    (l) =>
      l.address.toLowerCase() === chain.contracts.safeProxyFactory.toLowerCase() &&
      l.topics[0] === proxyCreationTopic,
  )

  if (!log) {
    throw new Error('ProxyCreation event not found in deployment receipt')
  }

  const decoded = factoryIface.decodeEventLog('ProxyCreation', log.data, log.topics)
  return { safeAddress: decoded.proxy as string, txHash: receipt.hash as string }
}
