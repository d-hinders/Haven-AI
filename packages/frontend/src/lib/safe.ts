import {
  encodeFunctionData,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
  getContractAddress,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  concat,
  pad,
  toHex,
} from 'viem'
import { getChainConfig } from './chains'

const ZERO = '0x0000000000000000000000000000000000000000' as Address

// ── ABIs (only the functions we need) ────────────────────────────────
const SAFE_SETUP_ABI = [
  {
    name: 'setup',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_owners', type: 'address[]' },
      { name: '_threshold', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'fallbackHandler', type: 'address' },
      { name: 'paymentToken', type: 'address' },
      { name: 'payment', type: 'uint256' },
      { name: 'paymentReceiver', type: 'address' },
    ],
    outputs: [],
  },
] as const

const PROXY_FACTORY_ABI = [
  {
    name: 'createProxyWithNonce',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_singleton', type: 'address' },
      { name: 'initializer', type: 'bytes' },
      { name: 'saltNonce', type: 'uint256' },
    ],
    outputs: [{ name: 'proxy', type: 'address' }],
  },
  {
    name: 'ProxyCreation',
    type: 'event',
    inputs: [
      { name: 'proxy', type: 'address', indexed: false },
      { name: 'singleton', type: 'address', indexed: false },
    ],
  },
] as const

export type DeployStage = 'signing' | 'confirming' | 'registering'

/**
 * Deploy a new Safe on the specified chain (default: Gnosis Chain).
 *
 * The connected wallet becomes the sole owner with a threshold of 1.
 * Returns the deployed Safe address.
 */
export async function deploySafe(
  walletClient: WalletClient,
  publicClient: PublicClient,
  owner: Address,
  chainId: number = 100,
  onProgress?: (stage: DeployStage, data?: { txHash?: Hash }) => void,
): Promise<{ safeAddress: Address; txHash: Hash }> {
  const chainCfg = getChainConfig(chainId)
  const SAFE_PROXY_FACTORY = chainCfg.contracts.safeProxyFactory
  const SAFE_SINGLETON_L2 = chainCfg.contracts.safeSingletonL2
  const FALLBACK_HANDLER = chainCfg.contracts.fallbackHandler

  // 1. Encode the Safe.setup() initializer
  const initializer = encodeFunctionData({
    abi: SAFE_SETUP_ABI,
    functionName: 'setup',
    args: [
      [owner],       // owners
      1n,            // threshold
      ZERO,          // to  (no delegate call)
      '0x',          // data
      FALLBACK_HANDLER,
      ZERO,          // paymentToken
      0n,            // payment
      ZERO,          // paymentReceiver
    ],
  })

  // 2. Use a random salt nonce
  const saltNonce = BigInt(Math.floor(Math.random() * 1_000_000_000))

  // 3. Call ProxyFactory.createProxyWithNonce()
  onProgress?.('signing')
  const txHash = await walletClient.writeContract({
    address: SAFE_PROXY_FACTORY,
    abi: PROXY_FACTORY_ABI,
    functionName: 'createProxyWithNonce',
    args: [SAFE_SINGLETON_L2, initializer, saltNonce],
    chain: chainCfg.viemChain,
    account: owner,
  })

  // 4. Wait for the tx to be mined and extract the deployed proxy address
  onProgress?.('confirming', { txHash })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })

  // Find the ProxyCreation event
  const proxyCreationTopic = keccak256(
    new TextEncoder().encode('ProxyCreation(address,address)') as unknown as Uint8Array,
  )

  // The ProxyCreation event in Safe Proxy Factory v1.3.0 is NOT indexed,
  // so the proxy address is in the event data, not topics
  const creationLog = receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === SAFE_PROXY_FACTORY.toLowerCase() &&
      log.topics[0] === proxyCreationTopic,
  )

  if (!creationLog) {
    throw new Error('Safe deployment transaction succeeded but ProxyCreation event not found')
  }

  // Decode the proxy address from event data (first 32 bytes = address)
  const safeAddress = ('0x' + creationLog.data.slice(26, 66)) as Address

  onProgress?.('registering', { txHash })
  return { safeAddress, txHash }
}
