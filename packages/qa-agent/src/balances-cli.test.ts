/**
 * #3631 — the balances entry point. Missing config yields an `unknown` row
 * naming the variable (never a missing row) and a non-zero exit; a read
 * failure yields `unknown` and exit zero.
 */
import { describe, expect, it } from 'vitest'
import { ethers } from 'ethers'
import { CdpFaucetError } from './lib/faucet.js'
import { RELAYER_TOPUP_TARGET_WEI, type BalanceReadings, type BalancesReport } from './lib/balances.js'
import { CDP_FAUCET_CLAIM_WEI, RELAYER_TOPUP_MAX_CLAIMS, runBalances, topUpRelayer } from './balances-cli.js'

const TREASURY = '0x9281d7c312e67859c65f4A3449F0548ea2f90974'
const RELAYER = '0x' + 'ab'.repeat(20)

const provider = (fail = false) =>
  ({
    call: async () => {
      if (fail) throw new Error('rpc down')
      return ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [5_000_000n])
    },
    getBalance: async () => {
      if (fail) throw new Error('rpc down')
      return ethers.parseEther('0.5')
    },
  }) as unknown as ethers.Provider

const healthz = (async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    settlement: { address: '0x' + 'cd'.repeat(20), native_balance_wei: '10000000000000000', settlements_remaining: 100, cost_per_settlement_wei: '100000000000000', warn_floor: 25, fail_floor: 12 },
  }),
})) as unknown as typeof fetch

const api = { getAgent: async () => ({ ok: true, status: 200, data: { account_address: TREASURY } }) } as never

const FULL = {
  QA_HAVEN_API_URL: 'https://api.test',
  QA_DELEGATION_AGENT_API_KEY: 'sk_agent_test',
  QA_DEMO_MERCHANT_URL: 'https://merchant.test',
  QA_DEV_RELAYER_ADDRESS: RELAYER,
}
const deps = (fail = false) => ({ provider: provider(fail), fetchImpl: healthz, api, now: new Date('2026-10-05T06:00:00Z') })

describe('qa:balances entry point', () => {
  it('full config: three rows, exit 0', async () => {
    const { report, exitCode } = await runBalances([], FULL, deps())
    expect(exitCode).toBe(0)
    expect(report.rows.map((r) => [r.key, r.band])).toEqual([
      ['treasury', 'ok'],
      ['merchant', 'ok'],
      ['relayer', 'ok'],
    ])
  })

  for (const [missing, key] of [
    ['QA_HAVEN_API_URL', 'treasury'],
    ['QA_DELEGATION_AGENT_API_KEY', 'treasury'],
    ['QA_DEMO_MERCHANT_URL', 'merchant'],
    ['QA_DEV_RELAYER_ADDRESS', 'relayer'],
  ] as const) {
    it(`without ${missing}: the ${key} row stays, unknown, naming the variable — and the run exits non-zero`, async () => {
      const env: Record<string, string> = { ...FULL }
      delete env[missing]
      const { report, exitCode } = await runBalances([], env, deps())
      expect(exitCode).toBe(1)
      expect(report.rows).toHaveLength(3)
      const row = report.rows.find((r) => r.key === key)!
      expect(row).toMatchObject({ band: 'unknown', configMissing: true, reason: `config missing: ${missing}` })
    })
  }

  it('a read failure is unknown with a reason, and the run exits zero', async () => {
    const failingFetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const { report, exitCode } = await runBalances([], FULL, { ...deps(true), fetchImpl: failingFetch })
    expect(exitCode).toBe(0)
    expect(report.rows.map((r) => r.band)).toEqual(['unknown', 'unknown', 'unknown'])
    expect(report.rows.every((r) => !r.configMissing && /read failed|could not reach/.test(r.reason ?? ''))).toBe(true)
  })

  it('missing CDP credentials only skips top-up; it never changes rows, configMissing, or exit code', async () => {
    const low = {
      ...deps(),
      provider: {
        ...provider(),
        getBalance: async () => ethers.parseEther('0.005'),
      } as unknown as ethers.Provider,
    }
    const { report, exitCode } = await runBalances([], FULL, low)
    expect(exitCode).toBe(0)
    expect(report.configMissing).toBe(false)
    expect(report.rows.find((r) => r.key === 'relayer')?.band).toBe('critical')
    expect(report.topUp).toEqual({
      status: 'skipped', claimsMade: 0, amountReceivedAtomic: '0', stopReason: 'missing-credentials',
    })
  })

  it('uses the post-top-up relayer reading for both the row and today’s history', async () => {
    let reads = 0
    const sequenced = {
      ...provider(),
      getBalance: async () => (++reads === 1 ? ethers.parseEther('0.005') : RELAYER_TOPUP_TARGET_WEI),
    } as unknown as ethers.Provider
    const env = { ...FULL, QA_CDP_API_KEY_ID: 'key-id', QA_CDP_API_KEY_SECRET: 'key-secret' }
    const { report } = await runBalances([], env, {
      ...deps(),
      provider: sequenced,
      requestFaucet: async () => ({ transactionHash: `0x${'ab'.repeat(32)}` }),
      sleep: async () => {},
    })
    expect(reads).toBe(2)
    expect(report.rows.find((r) => r.key === 'relayer')).toMatchObject({ band: 'ok', balance: '0.03' })
    expect(report.history.at(-1)?.balances.relayer).toBe(RELAYER_TOPUP_TARGET_WEI.toString())
    expect(report.topUp?.amountReceivedAtomic).toBe(ethers.parseEther('0.025').toString())
  })
})

const topUpFixture = (band: 'ok' | 'warn' | 'critical' | 'unknown', atomic = 0n) => {
  const readings = {
    treasury: { ok: false, reason: 'unused' },
    merchant: { ok: false, reason: 'unused' },
    relayer: band === 'unknown'
      ? { ok: false, reason: 'read failed' }
      : { ok: true, address: RELAYER, atomic, criticalFloor: 1n, fallbackFloor: 1n },
  } as BalanceReadings
  const report = {
    checkedAt: '2026-10-05T06:00:00Z', history: [], configMissing: false,
    rows: [{ key: 'relayer', name: 'Dev backend relayer (84532)', unit: 'ETH', band }],
  } as BalancesReport
  return { readings, report }
}

describe('relayer faucet top-up loop', () => {
  const env = { QA_CDP_API_KEY_ID: 'key-id', QA_CDP_API_KEY_SECRET: 'key-secret', GITHUB_RUN_ID: '123' }

  for (const band of ['critical', 'warn'] as const) {
    it(`${band}: claims until the 0.03 ETH target`, async () => {
      const { readings, report } = topUpFixture(band, RELAYER_TOPUP_TARGET_WEI - 2n * CDP_FAUCET_CLAIM_WEI)
      let calls = 0
      const result = await topUpRelayer(readings, report, env, {
        requestFaucet: async () => { calls++; return { transactionHash: `0x${'ab'.repeat(32)}` } },
        sleep: async () => {},
      })
      expect(calls).toBe(2)
      expect(result).toMatchObject({ claimsMade: 2, amountReceivedAtomic: '0', stopReason: 'target-requests-complete' })
    })
  }

  it('never exceeds the 300-claim cap', async () => {
    const { readings, report } = topUpFixture('critical', 0n)
    let calls = 0
    const result = await topUpRelayer(readings, report, env, {
      requestFaucet: async () => { calls++; return { transactionHash: `0x${'ab'.repeat(32)}` } },
      sleep: async () => {},
    })
    expect(calls).toBe(RELAYER_TOPUP_MAX_CLAIMS)
    expect(result).toMatchObject({ claimsMade: RELAYER_TOPUP_MAX_CLAIMS, stopReason: 'claim-cap-reached' })
  })

  for (const band of ['ok', 'unknown'] as const) {
    it(`${band}: makes no faucet request`, async () => {
      const { readings, report } = topUpFixture(band, 0n)
      let calls = 0
      const result = await topUpRelayer(readings, report, env, { requestFaucet: async () => { calls++; throw new Error('unexpected') } })
      expect(calls).toBe(0)
      expect(result.stopReason).toBe('not-needed')
    })
  }

  it('a 429 stops immediately and records the accepted amount', async () => {
    const { readings, report } = topUpFixture('critical', 0n)
    let calls = 0
    const result = await topUpRelayer(readings, report, env, {
      requestFaucet: async () => { calls++; throw new CdpFaucetError('rate_limited', 'CDP faucet returned HTTP 429', 429) },
      sleep: async () => {},
    })
    expect(calls).toBe(1)
    expect(result).toMatchObject({ claimsMade: 0, amountReceivedAtomic: '0', stopReason: 'rate-limited' })
  })

  it('any other faucet error also stops after one call', async () => {
    const { readings, report } = topUpFixture('critical', 0n)
    let calls = 0
    const result = await topUpRelayer(readings, report, env, {
      requestFaucet: async () => { calls++; throw new CdpFaucetError('http_error', 'CDP faucet failed', 503) },
      sleep: async () => {},
    })
    expect(calls).toBe(1)
    expect(result.stopReason).toBe('faucet-error')
  })

  it('stops before another request when the six-minute run budget is exhausted', async () => {
    const { readings, report } = topUpFixture('critical', 0n)
    let calls = 0
    let clockReads = 0
    const result = await topUpRelayer(readings, report, env, {
      requestFaucet: async () => { calls++; return { transactionHash: `0x${'ab'.repeat(32)}` } },
      sleep: async () => {},
      nowMs: () => (clockReads++ === 0 ? 0 : 6 * 60_000),
    })
    expect(calls).toBe(0)
    expect(result.stopReason).toBe('run-budget-exhausted')
  })
})
