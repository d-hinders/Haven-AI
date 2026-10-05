/**
 * #3638 (epic #3634, Gnosis removal 2c): the SDK's explorer links and x402
 * network tables cover Haven's two networks — Base (8453) and Base Sepolia
 * (84532) — and nothing else.
 */
import { describe, expect, it } from 'vitest'
import { buildExplorerUrl, explorerUrlOrEmpty } from './x402-protocol.js'
import {
  SUPPORTED_X402_NETWORKS,
  resolveTokenBySymbol,
  resolveTokenFromAddress,
  selectPaymentOption,
} from './x402.js'

const HASH = '0x' + 'ab'.repeat(32)
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const EURE_ON_CHAIN_100 = '0xcB444e90D8198415266c6a2724b7900fb12FC56E'

const option = (network: string, asset: string) =>
  ({ scheme: 'exact', network, maxAmountRequired: '1000', amount: '1000', asset, payTo: '0x' + 'cc'.repeat(20), resource: 'https://m.test/r' }) as never

describe('buildExplorerUrl (#3638)', () => {
  it('Base Sepolia links to sepolia.basescan.org — before, it fell back to MAINNET basescan', () => {
    expect(buildExplorerUrl(84532, HASH)).toBe(`https://sepolia.basescan.org/tx/${HASH}`)
  })

  it('Base links to basescan.org, and an absent chain still means Base', () => {
    expect(buildExplorerUrl(8453, HASH)).toBe(`https://basescan.org/tx/${HASH}`)
    expect(buildExplorerUrl(undefined, HASH)).toBe(`https://basescan.org/tx/${HASH}`)
  })

  it('chain 100 and any unknown chain get NO link, never another chain’s explorer', () => {
    expect(buildExplorerUrl(100, HASH)).toBe('')
    expect(buildExplorerUrl(1, HASH)).toBe('')
    expect(explorerUrlOrEmpty(100, HASH)).toBe('')
    expect(explorerUrlOrEmpty(84532, null)).toBe('')
  })
})

describe('x402 networks and tokens (#3638)', () => {
  it('SUPPORTED_X402_NETWORKS lists Base and Base Sepolia only', () => {
    expect(Object.keys(SUPPORTED_X402_NETWORKS).sort()).toEqual(['base', 'base-sepolia', 'eip155:8453', 'eip155:84532'])
  })

  it('a 402 offering only eip155:100 yields no supported option; Base and Base Sepolia still select', () => {
    expect(selectPaymentOption([option('eip155:100', EURE_ON_CHAIN_100)])).toBeNull()
    expect(selectPaymentOption([option('eip155:100', EURE_ON_CHAIN_100), option('eip155:84532', SEPOLIA_USDC)])).toMatchObject({ network: 'eip155:84532' })
    expect(selectPaymentOption([option('eip155:8453', BASE_USDC)])).toMatchObject({ network: 'eip155:8453' })
  })

  it('chain-100 token addresses and symbols resolve to nothing', () => {
    expect(resolveTokenFromAddress(EURE_ON_CHAIN_100)).toBeNull()
    expect(resolveTokenFromAddress(EURE_ON_CHAIN_100, 'eip155:100')).toBeNull()
    expect(resolveTokenBySymbol(100, 'EURe')).toBeNull()
    expect(resolveTokenFromAddress(SEPOLIA_USDC, 'eip155:84532')).toEqual({ symbol: 'USDC', decimals: 6 })
    expect(resolveTokenBySymbol(8453, 'USDC')).toEqual({ symbol: 'USDC', decimals: 6 })
  })

  it('a NAMED network resolves only in its own table — never another chain’s decimals', () => {
    // Before #3638 an unregistered network fell back to the cross-chain table,
    // binding Base USDC's 6 decimals to an option on another chain.
    expect(resolveTokenFromAddress(BASE_USDC, 'eip155:100')).toBeNull()
    expect(resolveTokenFromAddress(BASE_USDC, 'eip155:1')).toBeNull()
    expect(resolveTokenFromAddress(BASE_USDC, 'eip155:8453')).toEqual({ symbol: 'USDC', decimals: 6 })
    // No network named: the cross-chain lookup still answers (#1351 contract).
    expect(resolveTokenFromAddress(BASE_USDC)).toEqual({ symbol: 'USDC', decimals: 6 })
  })
})
