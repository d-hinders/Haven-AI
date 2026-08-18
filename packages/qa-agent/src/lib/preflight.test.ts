/**
 * #1530 — the preflight exists because the harness could not see the resource
 * that broke 2026-08-17. These tests pin the behaviour that matters:
 * a below-floor resource BLOCKS, and an unknown one does not.
 */
import { describe, it, expect, vi } from 'vitest'
import { ethers } from 'ethers'
import {
  checkMerchantSettlement,
  checkDelegateResidual,
  runPreflight,
  formatPreflight,
} from './preflight.js'
import type { QaConfig } from '../config.js'

const MERCHANT = 'https://merchant.example'
const SETTLEMENT = '0xC03F7c03d20f3DC32d3b8dAD6EeA90a3be4822c1'
const KEY = `0x${'01'.repeat(32)}`

function health(settlement: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ status: 'ok', ...(settlement === undefined ? {} : { settlement }) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch
}

const baseCfg: QaConfig = {
  apiUrl: 'https://haven.example',
  agentApiKey: 'sk_agent_test',
  delegateKey: KEY,
  paymentTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
}

/** A provider stub — these tests are about thresholds, not about ethers. */
function providerWithUsdc(raw: bigint): ethers.Provider {
  return { call: async () => ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [raw]) } as unknown as ethers.Provider
}

describe('checkMerchantSettlement', () => {
  it('BLOCKS on the 2026-08-17 outage shape', async () => {
    const check = await checkMerchantSettlement(
      MERCHANT,
      health({ address: SETTLEMENT, native_balance_wei: '255000000000', settlements_remaining: 0, ok: false }),
    )
    expect(check.ok).toBe(false)
    expect(check.address).toBe(SETTLEMENT)
    expect(check.headroom).toBe('0 settlement(s)')
    // The detail must name the consequence, not just the number — the whole
    // failure was that "255 gwei" appeared nowhere and meant nothing.
    expect(check.detail).toMatch(/top this wallet up/)
  })

  it('passes a funded wallet', async () => {
    const check = await checkMerchantSettlement(
      MERCHANT,
      health({ address: SETTLEMENT, native_balance_wei: '1469790000000000', settlements_remaining: 587, ok: true }),
    )
    expect(check.ok).toBe(true)
    expect(check.detail).toBeUndefined()
  })

  it('is UNKNOWN, not failed, against a merchant deployed before #1530', async () => {
    // Rolling this out must not red-line every run until the merchant ships.
    const check = await checkMerchantSettlement(MERCHANT, health(undefined))
    expect(check.ok).toBeNull()
    expect(check.detail).toMatch(/deployed before #1530/)
  })

  it('is UNKNOWN when the merchant cannot read its own balance', async () => {
    const check = await checkMerchantSettlement(
      MERCHANT,
      health({ address: SETTLEMENT, ok: null, error: 'rpc timeout' }),
    )
    expect(check.ok).toBeNull()
    expect(check.detail).toBe('rpc timeout')
  })

  it('is UNKNOWN when the merchant is unreachable', async () => {
    const failing = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const check = await checkMerchantSettlement(MERCHANT, failing)
    expect(check.ok).toBeNull()
    expect(check.detail).toMatch(/ECONNREFUSED/)
  })

  it('is UNKNOWN on a non-200 /healthz', async () => {
    const notFound = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch
    const check = await checkMerchantSettlement(MERCHANT, notFound)
    expect(check.ok).toBeNull()
    expect(check.detail).toMatch(/HTTP 503/)
  })
})

describe('checkDelegateResidual', () => {
  it('reports a clean delegate without comment', async () => {
    const check = await checkDelegateResidual('legacy', KEY, providerWithUsdc(0n))
    expect(check.ok).toBe(true)
    expect(check.balance).toBe('0.0 USDC')
    expect(check.detail).toBeUndefined()
  })

  it('flags a non-zero starting residual as possible stranding, without blocking', async () => {
    // Legs deliberately leave sub-floor dust, so this is a finding, not a gate.
    const check = await checkDelegateResidual('legacy', KEY, providerWithUsdc(1000n))
    expect(check.ok).toBe(true)
    expect(check.detail).toMatch(/stranded/)
  })
})

describe('runPreflight', () => {
  it('blocks the run when any resource is definitively below floor', async () => {
    const result = await runPreflight(
      { ...baseCfg, demoMerchantUrl: MERCHANT },
      {
        fetchImpl: health({ address: SETTLEMENT, native_balance_wei: '255000000000', settlements_remaining: 0, ok: false }),
        provider: providerWithUsdc(0n),
      },
    )
    expect(result.blocked).toBe(true)
  })

  it('does NOT block on unknowns — a blind spot is not a failure', async () => {
    const result = await runPreflight(
      { ...baseCfg, demoMerchantUrl: MERCHANT },
      { fetchImpl: health(undefined), provider: providerWithUsdc(0n) },
    )
    expect(result.blocked).toBe(false)
    expect(result.checks.some((c) => c.ok === null)).toBe(true)
  })

  it('skips the merchant check entirely when no merchant is configured', async () => {
    const result = await runPreflight(baseCfg, { provider: providerWithUsdc(0n) })
    expect(result.checks.some((c) => c.name.includes('merchant'))).toBe(false)
  })

  it('covers the delegation-rail delegate when that identity is configured', async () => {
    const result = await runPreflight(
      { ...baseCfg, delegationDelegateKey: `0x${'02'.repeat(32)}` },
      { provider: providerWithUsdc(0n) },
    )
    expect(result.checks.filter((c) => c.name.includes('delegate residual'))).toHaveLength(2)
  })
})

describe('formatPreflight', () => {
  it('renders the failing case so the cause is readable without opening anything', async () => {
    const result = await runPreflight(
      { ...baseCfg, demoMerchantUrl: MERCHANT },
      {
        fetchImpl: health({ address: SETTLEMENT, native_balance_wei: '255000000000', settlements_remaining: 0, ok: false }),
        provider: providerWithUsdc(0n),
      },
    )
    const out = formatPreflight(result)
    expect(out).toContain('✗ merchant settlement wallet (gas)')
    expect(out).toContain(SETTLEMENT)
    expect(out).toContain('0 settlement(s)')
  })
})
