/**
 * #3631 — the balances entry point. Missing config yields an `unknown` row
 * naming the variable (never a missing row) and a non-zero exit; a read
 * failure yields `unknown` and exit zero.
 */
import { describe, expect, it } from 'vitest'
import { ethers } from 'ethers'
import { runBalances } from './balances-cli.js'

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
    settlement: { address: '0x' + 'cd'.repeat(20), native_balance_wei: '10000000000000000', settlements_remaining: 100, warn_floor: 25, fail_floor: 12 },
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
})
