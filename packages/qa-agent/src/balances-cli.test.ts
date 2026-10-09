/**
 * #3631 — the balances entry point. Missing config yields an `unknown` row
 * naming the variable (never a missing row) and a non-zero exit; a read
 * failure yields `unknown` and exit zero.
 */
import { describe, expect, it } from 'vitest'
import { ethers } from 'ethers'
import { CdpFaucetError } from './lib/faucet.js'
import {
  MERCHANT_TOPUP_TARGET_WEI,
  RELAYER_TOPUP_TARGET_WEI,
  type BalanceReadings,
  type BalancesReport,
} from './lib/balances.js'
import {
  CDP_FAUCET_CLAIM_WEI,
  deterministicClaimId,
  RELAYER_TOPUP_MAX_CLAIMS,
  runBalances,
  runTopUps,
  topUpLogLine,
  topUpMerchant,
  topUpRelayer,
  TOPUP_RUN_BUDGET_MS,
} from './balances-cli.js'

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
    const skipped = { status: 'skipped', claimsMade: 0, amountReceivedAtomic: '0', stopReason: 'missing-credentials' }
    expect(report.topUps).toEqual({ merchant: skipped, relayer: skipped })
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
    expect(report.topUps?.relayer?.amountReceivedAtomic).toBe(ethers.parseEther('0.025').toString())
  })

  it('a failed post-top-up relayer read keeps the pre-top-up reading, not an unknown row', async () => {
    let reads = 0
    const sequenced = {
      ...provider(),
      getBalance: async () => {
        if (++reads === 1) return ethers.parseEther('0.005')
        throw new Error('rpc down')
      },
    } as unknown as ethers.Provider
    const env = { ...FULL, QA_CDP_API_KEY_ID: 'key-id', QA_CDP_API_KEY_SECRET: 'key-secret' }
    const { report } = await runBalances([], env, {
      ...deps(),
      provider: sequenced,
      requestFaucet: async () => ({ transactionHash: `0x${'ab'.repeat(32)}` }),
      sleep: async () => {},
    })
    expect(reads).toBe(2)
    expect(report.rows.find((r) => r.key === 'relayer')).toMatchObject({ band: 'critical', balance: '0.005' })
    expect(report.history.at(-1)?.balances.relayer).toBe(ethers.parseEther('0.005').toString())
    expect(report.topUps?.relayer?.reason).toMatch(/post-top-up read failed .*pre-top-up reading/)
  })
})

/** A sequenced merchant `/healthz`: the Nth call returns the Nth balance (the last one repeats, `null` fails). */
const merchantHealthz = (balances: (bigint | null)[], chainId: number | undefined = 84532) => {
  let calls = 0
  const fetchImpl = (async () => {
    const wei = balances[Math.min(calls++, balances.length - 1)]
    if (wei === null) throw new Error('ECONNREFUSED')
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ...(chainId !== undefined ? { chain_id: chainId } : {}),
        settlement: { address: MERCHANT, native_balance_wei: wei.toString(), cost_per_settlement_wei: '2500000000000', warn_floor: 25, fail_floor: 12 },
      }),
    }
  }) as unknown as typeof fetch
  return { fetchImpl, calls: () => calls }
}

const MERCHANT = '0x' + 'cd'.repeat(20)
const CDP = { QA_CDP_API_KEY_ID: 'key-id', QA_CDP_API_KEY_SECRET: 'key-secret' }

describe('qa:balances merchant top-up (#3836)', () => {
  it('re-reads /healthz after the top-up and uses that reading for the row and today’s history', async () => {
    const low = 28_855_666_942_768n // #3654's 2026-10-09 reading
    const h = merchantHealthz([low, MERCHANT_TOPUP_TARGET_WEI])
    const addresses: string[] = []
    const { report } = await runBalances([], { ...FULL, ...CDP }, {
      ...deps(),
      fetchImpl: h.fetchImpl,
      requestFaucet: async ({ address }) => { addresses.push(address); return { transactionHash: `0x${'ab'.repeat(32)}` } },
      sleep: async () => {},
    })
    expect(h.calls()).toBe(2)
    expect(addresses.length).toBe(Number((MERCHANT_TOPUP_TARGET_WEI - low + CDP_FAUCET_CLAIM_WEI - 1n) / CDP_FAUCET_CLAIM_WEI))
    expect(new Set(addresses)).toEqual(new Set([MERCHANT]))
    const row = report.rows.find((r) => r.key === 'merchant')!
    expect(row.band).not.toBe('critical')
    expect(row.balance).toBe('0.002')
    expect(report.history.at(-1)?.balances.merchant).toBe(MERCHANT_TOPUP_TARGET_WEI.toString())
    expect(report.topUps?.merchant).toMatchObject({
      status: 'attempted',
      stopReason: 'target-requests-complete',
      amountReceivedAtomic: (MERCHANT_TOPUP_TARGET_WEI - low).toString(),
    })
  })

  it('re-reads the merchant only after the relayer loop too (time for the faucet transactions to be mined)', async () => {
    const events: string[] = []
    let fetches = 0
    const fetchImpl = (async () => {
      events.push(++fetches === 1 ? 'merchant-read' : 'merchant-reread')
      const wei = fetches === 1 ? MERCHANT_TOPUP_TARGET_WEI - CDP_FAUCET_CLAIM_WEI : MERCHANT_TOPUP_TARGET_WEI
      return {
        ok: true, status: 200,
        json: async () => ({ chain_id: 84532, settlement: { address: MERCHANT, native_balance_wei: wei.toString(), cost_per_settlement_wei: '2500000000000', warn_floor: 25, fail_floor: 12 } }),
      }
    }) as unknown as typeof fetch
    const low = { ...provider(), getBalance: async () => ethers.parseEther('0.005') } as unknown as ethers.Provider
    await runBalances([], { ...FULL, ...CDP }, {
      ...deps(),
      provider: low,
      fetchImpl,
      requestFaucet: async ({ address }) => { events.push(address === MERCHANT ? 'merchant-claim' : 'relayer-claim'); return { transactionHash: `0x${'ab'.repeat(32)}` } },
      sleep: async () => {},
    })
    const reread = events.indexOf('merchant-reread')
    expect(reread).toBeGreaterThan(events.lastIndexOf('relayer-claim'))
    expect(events.lastIndexOf('relayer-claim')).toBeGreaterThan(events.indexOf('merchant-claim'))
  })

  it('a failed post-top-up /healthz read keeps the pre-top-up reading (critical stays critical)', async () => {
    const low = 28_855_666_942_768n
    const h = merchantHealthz([low, null])
    const { report } = await runBalances([], { ...FULL, ...CDP }, {
      ...deps(),
      fetchImpl: h.fetchImpl,
      requestFaucet: async () => ({ transactionHash: `0x${'ab'.repeat(32)}` }),
      sleep: async () => {},
    })
    expect(h.calls()).toBe(2)
    expect(report.rows.find((r) => r.key === 'merchant')).toMatchObject({ band: 'critical' })
    expect(report.history.at(-1)?.balances.merchant).toBe(low.toString())
    expect(report.topUps?.merchant?.reason).toMatch(/post-top-up read failed/)
  })
})

const merchantReadings = (
  atomic: bigint | null,
  opts: { chainId?: number; address?: string } = {},
): BalanceReadings => {
  // `'chainId' in opts`, not a default: `{ chainId: undefined }` means "no chain_id".
  const chainId = 'chainId' in opts ? opts.chainId : 84532
  const address = opts.address ?? MERCHANT
  return {
    treasury: { ok: false, reason: 'unused' },
    merchant: atomic === null
      ? { ok: false, address, reason: 'read failed' }
      : { ok: true, address, atomic, criticalFloor: 30_000_000_000_000n, fallbackFloor: 62_500_000_000_000n, ...(chainId !== undefined ? { chainId } : {}) },
    relayer: { ok: false, reason: 'unused' },
  } as BalanceReadings
}

describe('merchant faucet top-up loop (#3836)', () => {
  const env = { ...CDP, GITHUB_RUN_ID: '123' }
  const accept = (log: string[]) => async ({ address }: { address: string }) => {
    log.push(address)
    return { transactionHash: `0x${'ab'.repeat(32)}` }
  }

  // The trigger is the balance, not the band: a merchant reading `ok` on the
  // fallback basis (above 0.0000625 ETH) is still topped up below the target.
  for (const [label, atomic] of [
    ['band ok (above the fallback warn floor)', 1_000_000_000_000_000n],
    ['band critical (below the fail floor)', 28_855_666_942_768n],
  ] as const) {
    it(`${label}: claims to the merchant address until the target`, async () => {
      const calls: string[] = []
      const result = await topUpMerchant(merchantReadings(atomic), env, { requestFaucet: accept(calls), sleep: async () => {} })
      const expected = Number((MERCHANT_TOPUP_TARGET_WEI - atomic + CDP_FAUCET_CLAIM_WEI - 1n) / CDP_FAUCET_CLAIM_WEI)
      expect(calls).toEqual(Array(expected).fill(MERCHANT))
      expect(result).toMatchObject({ status: 'attempted', claimsMade: expected, stopReason: 'target-requests-complete' })
    })
  }

  it('the claim count is bounded by ceil(target / claim) — an injected target exercises the bound', async () => {
    const calls: string[] = []
    const target = 3n * CDP_FAUCET_CLAIM_WEI + 1n
    const result = await topUpMerchant(merchantReadings(0n), env, { requestFaucet: accept(calls), sleep: async () => {}, merchantTargetWei: target })
    expect(calls).toHaveLength(4)
    expect(result.claimsMade).toBe(4)
    // With the real constants, the most a zero balance can need.
    expect(Number(MERCHANT_TOPUP_TARGET_WEI / CDP_FAUCET_CLAIM_WEI)).toBe(20)
  })

  for (const [label, readings, stopReason, reason] of [
    ['at the target', merchantReadings(MERCHANT_TOPUP_TARGET_WEI), 'not-needed', /at or above its 0\.002 ETH target/],
    ['unknown', merchantReadings(null), 'unreadable', /could not be read/],
    ['on chain 8453', merchantReadings(0n, { chainId: 8453 }), 'wrong-chain', /reports chain 8453/],
    ['with no chain_id', merchantReadings(0n, { chainId: undefined }), 'wrong-chain', /reports no chain_id/],
    ['with an invalid address', merchantReadings(0n, { address: 'not-an-address' }), 'invalid-address', /not an address/],
  ] as const) {
    it(`${label}: makes no faucet request and says why`, async () => {
      let calls = 0
      const result = await topUpMerchant(readings, env, { requestFaucet: async () => { calls++; throw new Error('unexpected') } })
      expect(calls).toBe(0)
      expect(result).toMatchObject({ status: 'skipped', claimsMade: 0, stopReason })
      expect(result.reason).toMatch(reason)
    })
  }

  it('merchant and relayer idempotency keys differ, and the relayer key is unchanged from #3655', () => {
    for (const claim of [1, 2, 20]) {
      expect(deterministicClaimId('merchant', '123', '1', claim)).not.toBe(deterministicClaimId('relayer', '123', '1', claim))
    }
    // Pinned: sha256("qa-relayer-topup:123:1:<claim>") as #3655 shipped it.
    expect(deterministicClaimId('relayer', '123', '1', 1)).toBe('e1bb47b6-5c5b-4dc8-8a33-4dd4205a8a46')
    expect(deterministicClaimId('relayer', '123', '1', 2)).toBe('8e9152a7-cd2f-4c72-818d-e02015e6c26b')
  })
})

describe('both wallets under one budget (#3836)', () => {
  const env = { ...CDP, GITHUB_RUN_ID: '123' }
  const bothLow = () => {
    const readings = merchantReadings(MERCHANT_TOPUP_TARGET_WEI - 2n * CDP_FAUCET_CLAIM_WEI)
    readings.relayer = { ok: true, address: RELAYER, atomic: RELAYER_TOPUP_TARGET_WEI - 2n * CDP_FAUCET_CLAIM_WEI, criticalFloor: 1n, fallbackFloor: 1n }
    const report = {
      checkedAt: '2026-10-05T06:00:00Z', history: [], configMissing: false,
      rows: [{ key: 'relayer', name: 'Dev backend relayer (84532)', unit: 'ETH', band: 'critical' }],
    } as BalancesReport
    return { readings, report }
  }

  it('claims for the merchant before the relayer', async () => {
    const { readings, report } = bothLow()
    const order: string[] = []
    const result = await runTopUps(readings, report, env, {
      requestFaucet: async ({ address }) => { order.push(address); return { transactionHash: `0x${'ab'.repeat(32)}` } },
      sleep: async () => {},
    })
    expect(order).toEqual([MERCHANT, MERCHANT, RELAYER, RELAYER])
    expect(result.merchant.claimsMade).toBe(2)
    expect(result.relayer.claimsMade).toBe(2)
  })

  it('each loop sends its own wallet namespace as X-Idempotency-Key (no replay across wallets)', async () => {
    const { readings, report } = bothLow()
    const keys: Record<string, string[]> = {}
    await runTopUps(readings, report, env, {
      requestFaucet: async ({ address, idempotencyKey }) => {
        ;(keys[address] ??= []).push(idempotencyKey!)
        return { transactionHash: `0x${'ab'.repeat(32)}` }
      },
      sleep: async () => {},
    })
    expect(keys[MERCHANT]).toEqual([1, 2].map((c) => deterministicClaimId('merchant', '123', undefined, c)))
    expect(keys[RELAYER]).toEqual([1, 2].map((c) => deterministicClaimId('relayer', '123', undefined, c)))
    expect(keys[MERCHANT]!.filter((k) => keys[RELAYER]!.includes(k))).toEqual([])
  })

  it('a merchant 429 ends only the merchant loop', async () => {
    const { readings, report } = bothLow()
    const order: string[] = []
    const result = await runTopUps(readings, report, env, {
      requestFaucet: async ({ address }) => {
        order.push(address)
        if (address === MERCHANT) throw new CdpFaucetError('rate_limited', 'CDP faucet returned HTTP 429', 429)
        return { transactionHash: `0x${'ab'.repeat(32)}` }
      },
      sleep: async () => {},
    })
    expect(order).toEqual([MERCHANT, RELAYER, RELAYER])
    expect(result.merchant.stopReason).toBe('rate-limited')
    expect(result.relayer).toMatchObject({ claimsMade: 2, stopReason: 'target-requests-complete' })
  })

  it('both loops stop at the one shared deadline (fake clock)', async () => {
    const { readings, report } = bothLow()
    let now = 0
    const order: string[] = []
    const result = await runTopUps(readings, report, env, {
      // Each accepted claim costs half the budget: the merchant spends it all.
      requestFaucet: async ({ address }) => { order.push(address); now += TOPUP_RUN_BUDGET_MS / 2; return { transactionHash: `0x${'ab'.repeat(32)}` } },
      sleep: async () => {},
      nowMs: () => now,
    })
    expect(order).toEqual([MERCHANT, MERCHANT])
    expect(result.merchant.stopReason).toBe('target-requests-complete')
    expect(result.relayer).toMatchObject({ claimsMade: 0, stopReason: 'run-budget-exhausted' })
  })
})

describe('top-up log lines', () => {
  it('one line per wallet, naming it, with distinct skip wording', () => {
    expect(topUpLogLine('merchant', { status: 'skipped', claimsMade: 0, amountReceivedAtomic: '0', stopReason: 'missing-credentials' }))
      .toBe('merchant top-up: skipped: no CDP credentials')
    expect(topUpLogLine('merchant', { status: 'skipped', claimsMade: 0, amountReceivedAtomic: '0', stopReason: 'wrong-chain', reason: 'merchant /healthz reports chain 8453, not 84532' }))
      .toBe('merchant top-up: skipped (wrong-chain) — merchant /healthz reports chain 8453, not 84532')
    expect(topUpLogLine('relayer', { status: 'attempted', claimsMade: 2, amountReceivedAtomic: '200000000000000', stopReason: 'target-requests-complete' }))
      .toBe('relayer top-up: 2 claim(s), 0.0002 ETH, target-requests-complete')
    expect(topUpLogLine('relayer', undefined)).toBeNull()
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

  it('uses distinct idempotency keys for GitHub re-run attempts', async () => {
    const { readings, report } = topUpFixture(
      'critical',
      RELAYER_TOPUP_TARGET_WEI - CDP_FAUCET_CLAIM_WEI,
    )
    const keys: string[] = []
    for (const attempt of ['1', '2']) {
      await topUpRelayer(readings, report, { ...env, GITHUB_RUN_ATTEMPT: attempt }, {
        requestFaucet: async ({ idempotencyKey }) => {
          keys.push(idempotencyKey!)
          return { transactionHash: `0x${'ab'.repeat(32)}` }
        },
        sleep: async () => {},
      })
    }
    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toBe(keys[1])
  })

  for (const band of ['ok', 'unknown'] as const) {
    it(`${band}: makes no faucet request`, async () => {
      const { readings, report } = topUpFixture(band, 0n)
      let calls = 0
      const result = await topUpRelayer(readings, report, env, { requestFaucet: async () => { calls++; throw new Error('unexpected') } })
      expect(calls).toBe(0)
      expect(result.stopReason).toBe('not-needed')
      expect(result.reason).toBe('the relayer was not `warn` or `critical`')
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
