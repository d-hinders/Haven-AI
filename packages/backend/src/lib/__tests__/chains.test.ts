import { describe, it, expect } from 'vitest'

// Set the served-chains env before importing (config reads it at import time).
// Dev's shape: serves Base Sepolia only.
process.env.HAVEN_DEPLOY_CHAIN_IDS = '84532'
const { isDeployableChain, deployableChainIds, isSupportedChain } = await import('../chains.js')

describe('served-chains guard (#679)', () => {
  it('isDeployableChain restricts deploys to the configured set', () => {
    expect(isDeployableChain(84532)).toBe(true) // served
    expect(isDeployableChain(8453)).toBe(false) // supported, but not served here (dev = Sepolia only)
    expect(isDeployableChain(999999)).toBe(false) // not even in the registry
  })

  it('deployableChainIds returns the configured served chains', () => {
    expect(deployableChainIds()).toEqual([84532])
  })

  it('a served chain is still a supported chain', () => {
    expect(isSupportedChain(84532)).toBe(true)
  })
})
