import { describe, expect, it } from 'vitest'
import {
  avgGas,
  buildComparisonTable,
  buildPilotEvidence,
  medianMs,
  type RailMeasurement,
} from './compare-lib.js'

describe('stats helpers', () => {
  it('medianMs handles odd, even and empty inputs', () => {
    expect(medianMs([5, 1, 3])).toBe(3)
    expect(medianMs([1, 2, 3, 10])).toBe(3) // rounded mean of 2 and 3
    expect(medianMs([])).toBeNull()
  })

  it('avgGas averages bigints and handles empty', () => {
    expect(avgGas([100n, 200n, 300n])).toBe(200n)
    expect(avgGas([])).toBeNull()
  })
})

describe('buildPilotEvidence', () => {
  it('mirrors the machine-payment-evidence column names', () => {
    const e = buildPilotEvidence({
      rail: 'erc4337-session',
      txHash: '0xabc',
      chainId: 84532,
      payer: '0xsafe',
      settlement: '0xrecipient',
      tokenAddress: '0xusdc',
      amountRaw: 10_000n,
    })
    expect(e).toEqual({
      rail: 'erc4337-session',
      tx_hash: '0xabc',
      chain_id: 84532,
      payer_address: '0xsafe',
      settlement_address: '0xrecipient',
      token_address: '0xusdc',
      amount_raw: '10000',
      proof_status: 'onchain_confirmed',
    })
  })
})

describe('buildComparisonTable', () => {
  const session: RailMeasurement = {
    rail: 'erc4337-session',
    sequentialLatenciesMs: [4000, 5000, 6000],
    gasUsed: [400_000n, 420_000n],
    concurrentAttempted: 3,
    concurrentLanded: 3,
    concurrentFailures: [],
  }
  const relayer: RailMeasurement = {
    rail: 'allowance-relayer',
    sequentialLatenciesMs: [9000, 11000],
    gasUsed: [],
    concurrentAttempted: 3,
    concurrentLanded: 1,
    concurrentFailures: ['stale allowance nonce', 'stale allowance nonce'],
  }

  it('renders one column per rail with the shared metrics', () => {
    const table = buildComparisonTable([session, relayer])
    expect(table).toContain('| metric | erc4337-session | allowance-relayer |')
    expect(table).toContain('| median latency (ms) | 5000 | 10000 |')
    expect(table).toContain('| avg gas / payment | 410000 | n/a |')
    expect(table).toContain('| concurrent probe | 3/3 landed | 1/3 landed |')
    expect(table).toContain('stale allowance nonce')
  })

  it('renders a single-rail table when the relayer side is skipped', () => {
    const table = buildComparisonTable([session])
    expect(table).toContain('| metric | erc4337-session |')
    expect(table).not.toContain('allowance-relayer')
  })
})
