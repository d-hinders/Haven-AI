/**
 * The chain facts the proxy needs, keyed by its ONE network setting
 * (docs/architecture/12-merchant-kit.md §3, §2): the CAIP-2 id, the USDC
 * contract and its EIP-712 signing domain. There is no default network.
 *
 * Not imported from `@haven_ai/core`: core carries the token address but not
 * the USDC signing-domain name and version. `chains.test.ts` pins the chain id
 * and USDC address here to core's registry, so a drift is a red test.
 */
import type { Address } from 'viem'
import type { PaymentAsset } from '@haven_ai/merchant-payments'

export interface ProxyChain extends PaymentAsset {
  /** Display name, for the startup log. */
  label: string
  testnet: boolean
}

export const PROXY_CHAINS: Readonly<Record<string, ProxyChain>> = {
  'eip155:8453': {
    chainId: 8453,
    network: 'eip155:8453',
    label: 'Base mainnet',
    testnet: false,
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
    usdcDomainName: 'USD Coin',
    usdcDomainVersion: '2',
  },
  'eip155:84532': {
    chainId: 84532,
    network: 'eip155:84532',
    label: 'Base Sepolia testnet',
    testnet: true,
    usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address,
    usdcDomainName: 'USDC',
    usdcDomainVersion: '2',
  },
}

export function chainForNetwork(network: string): ProxyChain | undefined {
  return Object.prototype.hasOwnProperty.call(PROXY_CHAINS, network) ? PROXY_CHAINS[network] : undefined
}
