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
  checkDelegationTreasury,
  TREASURY_RUN_COST_ATOMIC,
  runPreflight,
  formatPreflight,
} from './preflight.js'
import type { HavenApi } from './haven-api.js'
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

describe('TREASURY_RUN_COST_ATOMIC', () => {
  it('includes the funded-but-undelivered crash/resume leg', () => {
    // 0.010 direct settle + seven 0.001 settling merchant legs (including
    // #2159) + 0.006 fresh-agent funding + 0.004 lifecycle net funding.
    expect(TREASURY_RUN_COST_ATOMIC).toBe(27_000n)
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

const TREASURY = '0x9a4c2b7e1d0f3a85c6e4b21d9f0ae873c5d1b042'

/** An agent-identity API stub — these tests are about the check, not HavenApi. */
function agentApi(response: { ok: boolean; status: number; data: { safe_address?: string } }): Pick<HavenApi, 'getAgent'> {
  return { getAgent: async () => response }
}

describe('checkDelegationTreasury', () => {
  it('passes a funded treasury and states headroom in legs', async () => {
    const check = await checkDelegationTreasury(
      agentApi({ ok: true, status: 200, data: { safe_address: TREASURY } }),
      providerWithUsdc(900_000n), // 0.9 USDC — the provisioning balance
    )
    expect(check.ok).toBe(true)
    expect(check.address).toBe(TREASURY)
    expect(check.balance).toBe('0.9 USDC')
    expect(check.headroom).toBe('~900 leg(s)')
    expect(check.detail).toBeUndefined()
  })

  it('BLOCKS on the #2074 shape — an empty treasury names itself, its token, and the remedy', async () => {
    const check = await checkDelegationTreasury(
      agentApi({ ok: true, status: 200, data: { safe_address: TREASURY } }),
      providerWithUsdc(0n),
    )
    expect(check.ok).toBe(false)
    expect(check.address).toBe(TREASURY)
    expect(check.balance).toBe('0.0 USDC')
    // The detail must be actionable without opening anything else: the token
    // contract, "any source works", and the failure it prevents.
    expect(check.detail).toContain('0x036CbD53842c5426634e7929541eC2318f3dCF7e')
    expect(check.detail).toMatch(/any source/)
    expect(check.detail).toMatch(/transfer amount exceeds balance/)
  })

  it('blocks just below a full run cost and passes at exactly it', async () => {
    const below = await checkDelegationTreasury(
      agentApi({ ok: true, status: 200, data: { safe_address: TREASURY } }),
      providerWithUsdc(TREASURY_RUN_COST_ATOMIC - 1n),
    )
    expect(below.ok).toBe(false)
    const at = await checkDelegationTreasury(
      agentApi({ ok: true, status: 200, data: { safe_address: TREASURY } }),
      providerWithUsdc(TREASURY_RUN_COST_ATOMIC),
    )
    expect(at.ok).toBe(true)
  })

  it('is UNKNOWN, not failed, on a non-200 from the identity endpoint', async () => {
    const check = await checkDelegationTreasury(
      agentApi({ ok: false, status: 503, data: {} }),
      providerWithUsdc(0n),
    )
    expect(check.ok).toBeNull()
    expect(check.detail).toMatch(/HTTP 503/)
  })

  it('is UNKNOWN when the identity carries no safe_address', async () => {
    const check = await checkDelegationTreasury(
      agentApi({ ok: true, status: 200, data: {} }),
      providerWithUsdc(0n),
    )
    expect(check.ok).toBeNull()
    expect(check.detail).toMatch(/safe_address/)
  })

  it('is UNKNOWN when the API is unreachable — never a thrown error', async () => {
    const check = await checkDelegationTreasury(
      { getAgent: async () => { throw new Error('ECONNREFUSED') } },
      providerWithUsdc(0n),
    )
    expect(check.ok).toBeNull()
    expect(check.detail).toMatch(/ECONNREFUSED/)
  })

  it('is UNKNOWN when the RPC balance read fails', async () => {
    const failingProvider = { call: async () => { throw new Error('rpc timeout') } } as unknown as ethers.Provider
    const check = await checkDelegationTreasury(
      agentApi({ ok: true, status: 200, data: { safe_address: TREASURY } }),
      failingProvider,
    )
    expect(check.ok).toBeNull()
    expect(check.detail).toMatch(/rpc timeout/)
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

  it('skips the treasury check when no delegation agent key is configured', async () => {
    const result = await runPreflight(baseCfg, { provider: providerWithUsdc(0n) })
    expect(result.checks.some((c) => c.name.includes('treasury'))).toBe(false)
  })

  it('covers — and blocks on — the treasury when the delegation identity is configured', async () => {
    const result = await runPreflight(
      { ...baseCfg, delegationAgentApiKey: 'qa_key' },
      {
        provider: providerWithUsdc(0n),
        api: agentApi({ ok: true, status: 200, data: { safe_address: TREASURY } }),
      },
    )
    expect(result.checks.filter((c) => c.name.includes('treasury'))).toHaveLength(1)
    expect(result.blocked).toBe(true)
  })

  it('covers the delegation-rail delegate when that identity is configured', async () => {
    const result = await runPreflight(
      { ...baseCfg, delegationDelegateKey: `0x${'02'.repeat(32)}` },
      { provider: providerWithUsdc(0n) },
    )
    expect(result.checks.filter((c) => c.name.includes('delegate residual'))).toHaveLength(1)
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
