/**
 * #3669 (decision (c), #3635) — the SUPPORTED list is explicit and narrower
 * than the KNOWN registry: chain 100 resolves (history) but is not served.
 * `HAVEN_DEPLOY_CHAIN_IDS` is deliberately left unset here, so
 * `deployableChainIds()` falls back to the supported list.
 */
import { describe, expect, it } from 'vitest'

delete process.env.HAVEN_DEPLOY_CHAIN_IDS
const chains = await import('../chains.js')

describe('supported vs known chains (#3669)', () => {
  it('the supported list is exactly Base and Base Sepolia', () => {
    expect([...chains.SUPPORTED_CHAIN_IDS]).toEqual([8453, 84532])
  })

  it('every supported chain is also known', () => {
    for (const id of chains.SUPPORTED_CHAIN_IDS) expect(chains.isKnownChain(id)).toBe(true)
  })

  it('chain 100 is known but not supported or deployable', () => {
    expect(chains.isKnownChain(100)).toBe(true)
    expect(chains.isSupportedChain(100)).toBe(false)
    expect(chains.isDeployableChain(100)).toBe(false)
    expect(chains.isKnownChain(999999)).toBe(false)
  })

  it('getChain still resolves chain 100 so history renders', () => {
    const gnosis = chains.getChain(100)
    expect(gnosis.name).toBe('Gnosis Chain')
    expect(gnosis.nativeCurrency.decimals).toBe(18)
    expect(chains.getExplorerUrl(100, 'address', '0xabc')).toBe('https://gnosisscan.io/address/0xabc')
    expect(chains.settlementTokenForChain(100)?.decimals).toBe(6)
  })

  it('deployableChainIds() with no deploy list is the supported list', () => {
    expect(chains.deployableChainIds()).toEqual([8453, 84532])
  })
})
