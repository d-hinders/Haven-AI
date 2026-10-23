/**
 * #3631 — the balances entry point. Missing config yields an `unknown` row
 * naming the variable (never a missing row) and a non-zero exit; a read
 * failure yields `unknown` and exit zero.
 */
import { describe, expect, it, vi } from 'vitest'
import { ethers } from 'ethers'
import { CdpFaucetError } from './lib/faucet.js'
import {
  MERCHANT_TOPUP_TARGET_WEI,
  RELAYER_TOPUP_TARGET_WEI,
  type BalanceReadings,
  type BalancesReport,
} from './lib/balances.js'
import {
  CDP_FAUCET_CLAIM_USDC_ATOMIC,
  CDP_FAUCET_CLAIM_WEI,
  deterministicClaimId,
  EVAL_TOPUP_MAX_CLAIMS,
  RELAYER_TOPUP_MAX_CLAIMS,
  runBalances,
  runTopUps,
  topUpEvalAccount,
  topUpLogLine,
  topUpMerchant,
  topUpRelayer,
  TOPUP_RUN_BUDGET_MS,
  CLAIM_CONFIRM_CAP_MS,
  CLAIM_CONFIRM_POLL_MS,
  waitForClaims,
} from './balances-cli.js'
import { EVAL_TOPUP_TARGET_ATOMIC } from './lib/balances.js'

const TREASURY = '0x9281d7c312e67859c65f4A3449F0548ea2f90974'
const RELAYER = '0x' + 'ab'.repeat(20)
const EVAL_HERMES = '0x' + 'ef'.repeat(20)
const EVAL_CLAUDE = '0x' + 'fe'.repeat(20)

const provider = (fail = false) =>
  ({
    call: async () => {
      if (fail) throw new Error('rpc down')
      // 25 USDC: above the eval target, so the eval loops are `not-needed`
      // unless a test drives the eval balance below it.
      return ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [25_000_000n])
    },
    getBalance: async () => {
      if (fail) throw new Error('rpc down')
      return ethers.parseEther('0.5')
    },
    // Every claim is mined at once unless a test says otherwise (#3896): a stub
    // without this method would make the confirmation wait pass vacuously.
    getTransactionReceipt: async () => ({ status: 1 }),
  }) as unknown as ethers.Provider

/** Distinct, well-formed transaction hashes, so a wait cannot pass by de-duplicating. */
let hashSeq = 0
const nextHash = () => ethers.zeroPadValue(ethers.toBeHex(++hashSeq), 32)

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
  QA_DELEGATION_AGENT_API_KEY: '«redacted:sk_…»',
  QA_DEMO_MERCHANT_URL: 'https://merchant.test',
  QA_DEV_RELAYER_ADDRESS: RELAYER,
  QA_EVAL_HERMES_ACCOUNT: EVAL_HERMES,
  QA_EVAL_CLAUDE_ACCOUNT: EVAL_CLAUDE,
}
const deps = (fail = false) => ({ provider: provider(fail), fetchImpl: healthz, api, now: new Date('2026-10-05T06:00:00Z') })

describe('qa:balances entry point', () => {
  it('full config: five rows, exit 0', async () => {
    const { report, exitCode } = await runBalances([], FULL, deps())
    expect(exitCode).toBe(0)
    expect(report.rows.map((r) => [r.key, r.band])).toEqual([
      ['treasury', 'ok'],
      ['merchant', 'ok'],
      ['relayer', 'ok'],
      ['eval-hermes', 'ok'],
      ['eval-claude', 'ok'],
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
      expect(report.rows).toHaveLength(5)
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
    expect(report.rows.map((r) => r.band)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown'])
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
    expect(report.topUps).toEqual({
      merchant: { ...skipped, unit: 'ETH' },
      'eval-hermes': { ...skipped, unit: 'USDC' },
      'eval-claude': { ...skipped, unit: 'USDC' },
      relayer: { ...skipped, unit: 'ETH' },
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
      requestFaucet: async ({ address }) => { addresses.push(address); return { transactionHash: nextHash() } },
      sleep: async () => {},
    })
    expect(h.calls()).toBe(2)
    expect(addresses.length).toBe(Number((MERCHANT_TOPUP_TARGET_WEI - low + CDP_FAUCET_CLAIM_WEI - 1n) / CDP_FAUCET_CLAIM_WEI))
    expect(new Set(addresses)).toEqual(new Set([MERCHANT]))
    const row = report.rows.find((r) => r.key === 'merchant')!
    expect(row.band).not.toBe('critical')
    expect(row.balance).toBe('0.004')
    expect(report.history.at(-1)?.balances.merchant).toBe(MERCHANT_TOPUP_TARGET_WEI.toString())
    expect(report.topUps?.merchant).toMatchObject({
      status: 'attempted',
      stopReason: 'target-requests-complete',
      amountReceivedAtomic: (MERCHANT_TOPUP_TARGET_WEI - low).toString(),
    })
  })

  it('re-reads the merchant only after both loops have run', async () => {
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
      requestFaucet: async ({ address }) => { events.push(address === MERCHANT ? 'merchant-claim' : 'relayer-claim'); return { transactionHash: nextHash() } },
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
      requestFaucet: async () => ({ transactionHash: nextHash() }),
      sleep: async () => {},
    })
    expect(h.calls()).toBe(2)
    expect(report.rows.find((r) => r.key === 'merchant')).toMatchObject({ band: 'critical' })
    expect(report.history.at(-1)?.balances.merchant).toBe(low.toString())
    expect(report.topUps?.merchant?.reason).toMatch(/post-top-up read failed/)
  })
})

describe('qa:balances merchant claim confirmation (#3896)', () => {
  /**
   * A chain where each claim is mined only after `mineAfter` receipt reads of
   * it, and a `/healthz` that shows the claims' ETH only once EVERY claim is
   * mined, so a re-read that skips the wait sees the pre-top-up balance.
   */
  const chain = (start: bigint, { mineAfter = 2, throwFirst = false, never = false } = {}) => {
    const claims = new Map<string, number>()
    let receiptCalls = 0
    const mined = (h: string) => !never && (claims.get(h) ?? 0) > mineAfter
    const provider = {
      ...provider_(),
      getTransactionReceipt: async (h: string) => {
        receiptCalls++
        const n = (claims.get(h) ?? 0) + 1
        claims.set(h, n)
        if (throwFirst && n === 1) throw new Error('rpc 429')
        return mined(h) ? { status: 1 } : null
      },
    } as unknown as ethers.Provider
    const requestFaucet = async () => {
      const h = nextHash()
      claims.set(h, 0)
      return { transactionHash: h }
    }
    let fetches = 0
    const fetchImpl = (async () => {
      fetches++
      const all = claims.size > 0 && [...claims.keys()].every(mined)
      const wei = all ? start + BigInt(claims.size) * CDP_FAUCET_CLAIM_WEI : start
      return {
        ok: true, status: 200,
        json: async () => ({ chain_id: 84532, settlement: { address: MERCHANT, native_balance_wei: wei.toString(), cost_per_settlement_wei: '2500000000000', warn_floor: 25, fail_floor: 12 } }),
      }
    }) as unknown as typeof fetch
    return { provider, requestFaucet, fetchImpl, receiptCalls: () => receiptCalls, fetches: () => fetches, claims }
  }
  const provider_ = provider

  it('waits for every claim to be mined, then the row, history and amount show the increase', async () => {
    const start = MERCHANT_TOPUP_TARGET_WEI - 3n * CDP_FAUCET_CLAIM_WEI
    const c = chain(start)
    const { report } = await runBalances([], { ...FULL, ...CDP }, {
      ...deps(), provider: c.provider, fetchImpl: c.fetchImpl, requestFaucet: c.requestFaucet, sleep: async () => {},
    })
    expect(c.claims.size).toBe(3)
    expect(report.rows.find((r) => r.key === 'merchant')?.balance).toBe('0.004')
    expect(report.history.at(-1)?.balances.merchant).toBe(MERCHANT_TOPUP_TARGET_WEI.toString())
    expect(report.topUps?.merchant).toMatchObject({ amountReceivedAtomic: (3n * CDP_FAUCET_CLAIM_WEI).toString() })
    expect(report.topUps?.merchant?.reason).toBeUndefined()
  })

  it('a receipt read that throws is retried, never fatal', async () => {
    const start = MERCHANT_TOPUP_TARGET_WEI - CDP_FAUCET_CLAIM_WEI
    const c = chain(start, { throwFirst: true })
    const { report, exitCode } = await runBalances([], { ...FULL, ...CDP }, {
      ...deps(), provider: c.provider, fetchImpl: c.fetchImpl, requestFaucet: c.requestFaucet, sleep: async () => {},
    })
    expect(exitCode).toBe(0)
    expect(report.topUps?.merchant?.amountReceivedAtomic).toBe(CDP_FAUCET_CLAIM_WEI.toString())
  })

  it('a claim that never confirms ends the wait at the cap; the re-read still happens and says so', async () => {
    const start = MERCHANT_TOPUP_TARGET_WEI - CDP_FAUCET_CLAIM_WEI
    const c = chain(start, { never: true })
    let now = 0
    const { report } = await runBalances([], { ...FULL, ...CDP }, {
      ...deps(), provider: c.provider, fetchImpl: c.fetchImpl, requestFaucet: c.requestFaucet,
      nowMs: () => now,
      sleep: async (ms) => { now += ms },
    })
    expect(now).toBeGreaterThanOrEqual(CLAIM_CONFIRM_CAP_MS)
    expect(now).toBeLessThan(CLAIM_CONFIRM_CAP_MS + 10_000)
    expect(c.fetches()).toBe(2)
    expect(report.topUps?.merchant?.reason).toMatch(/1 claim\(s\) unconfirmed at re-read/)
    expect(report.topUps?.merchant?.amountReceivedAtomic).toBe('0')
  })

  it('an attempted top-up with no accepted claim makes no receipt call', async () => {
    const c = chain(MERCHANT_TOPUP_TARGET_WEI - CDP_FAUCET_CLAIM_WEI)
    const { report } = await runBalances([], { ...FULL, ...CDP }, {
      ...deps(), provider: c.provider, fetchImpl: c.fetchImpl, sleep: async () => {},
      requestFaucet: async () => { throw new CdpFaucetError('rate_limited', 'CDP faucet returned HTTP 429', 429) },
    })
    expect(report.topUps?.merchant).toMatchObject({ status: 'attempted', claimsMade: 0, stopReason: 'rate-limited' })
    expect(c.receiptCalls()).toBe(0)
  })

  it('waitForClaims stops at an early cap (the shared top-up deadline), not only after its sweep bound', async () => {
    let now = 0
    const unconfirmed = await waitForClaims([nextHash()], { getTransactionReceipt: async () => null }, {
      capAt: 7_000,
      nowMs: () => now,
      sleep: async (ms) => { now += ms },
    })
    expect(unconfirmed).toBe(1)
    expect(now).toBeLessThanOrEqual(7_000 + 3_000)
  })

  it('the shared top-up deadline caps the wait in runBalances, not only the 60 s cap', async () => {
    const c = chain(MERCHANT_TOPUP_TARGET_WEI - CDP_FAUCET_CLAIM_WEI, { never: true })
    let now = 0
    const { report } = await runBalances([], { ...FULL, ...CDP }, {
      ...deps(), provider: c.provider, fetchImpl: c.fetchImpl,
      // The claim itself uses up all but 5 s of the six-minute budget.
      requestFaucet: async () => { now = TOPUP_RUN_BUDGET_MS - 5_000; return c.requestFaucet() },
      nowMs: () => now,
      sleep: async (ms) => { now += ms },
    })
    expect(report.topUps?.merchant?.reason).toMatch(/1 claim\(s\) unconfirmed at re-read/)
    expect(now).toBeLessThanOrEqual(TOPUP_RUN_BUDGET_MS + CLAIM_CONFIRM_POLL_MS)
  })

  it('waitForClaims starts no batch once the cap has passed, so a slow RPC cannot hold the job', async () => {
    let now = 0
    let calls = 0
    const hashes = Array.from({ length: 12 }, () => nextHash())
    const unconfirmed = await waitForClaims(hashes, {
      // Every read takes 20 s of the injected clock, as a hung RPC hitting its timeout would.
      getTransactionReceipt: async () => { calls++; now += 20_000; return null },
    }, { capAt: 10_000, nowMs: () => now, sleep: async (ms) => { now += ms } })
    expect(unconfirmed).toBe(12)
    expect(calls).toBe(5) // one batch, then the cap stops the rest
  })

  it('waitForClaims cuts off a hung receipt read at the cap', async () => {
    // Faked clock (the repo-wide x402-scenario pattern). A real-timer
    // wall-clock assertion here measured the CI runner, not the code: on a
    // contended runner the 100 ms deadline fired ~3 s late and the cap went
    // red (#3963) — one failed run on a sha that passed it five other times.
    // With faked timers the property is exact: the never-settling read is
    // provably not awaited once the simulated clock reaches the cap.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const wait = waitForClaims([nextHash()], {
        getTransactionReceipt: () => new Promise(() => {}),
      } as never, { capAt: Date.now() + 100 })
      await vi.advanceTimersByTimeAsync(100)
      expect(await wait).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('waitForClaims keeps at most 5 receipt reads in flight', async () => {
    let inFlight = 0
    let maxInFlight = 0
    await waitForClaims(Array.from({ length: 12 }, () => nextHash()), {
      getTransactionReceipt: async () => {
        maxInFlight = Math.max(maxInFlight, ++inFlight)
        await new Promise((r) => setTimeout(r, 1))
        inFlight--
        return { status: 1 } as never
      },
    }, { capAt: Date.now() + 60_000 })
    expect(maxInFlight).toBe(5)
  })

  it('waitForClaims ends after its sweep bound even with a no-op sleep and the real clock', async () => {
    let calls = 0
    const unconfirmed = await waitForClaims([nextHash()], {
      getTransactionReceipt: async () => { calls++; throw new Error('rpc down') },
    }, { capAt: Date.now() + 60_000, sleep: async () => {} })
    expect(unconfirmed).toBe(1)
    expect(calls).toBe(Math.ceil(CLAIM_CONFIRM_CAP_MS / CLAIM_CONFIRM_POLL_MS) + 1)
  })

  it('the relayer\'s claims are never waited on', async () => {
    const receipts: string[] = []
    const relayerHashes = new Set<string>()
    const low = {
      ...provider(),
      getBalance: async () => ethers.parseEther('0.005'),
      getTransactionReceipt: async (h: string) => { receipts.push(h); return { status: 1 } },
    } as unknown as ethers.Provider
    await runBalances([], { ...FULL, ...CDP }, {
      ...deps(), provider: low,
      fetchImpl: merchantHealthz([MERCHANT_TOPUP_TARGET_WEI - CDP_FAUCET_CLAIM_WEI, MERCHANT_TOPUP_TARGET_WEI]).fetchImpl,
      requestFaucet: async ({ address }) => {
        const h = nextHash()
        if (address !== MERCHANT) relayerHashes.add(h)
        return { transactionHash: h }
      },
      sleep: async () => {},
    })
    expect(relayerHashes.size).toBeGreaterThan(0)
    expect(receipts.length).toBe(1)
    expect(receipts.filter((h) => relayerHashes.has(h))).toEqual([])
  })

  it('waitForClaims never polls a malformed hash and counts it unconfirmed', async () => {
    let calls = 0
    const unconfirmed = await waitForClaims(['0x1234', nextHash()], {
      getTransactionReceipt: async () => { calls++; return { status: 1 } as never },
    }, { capAt: Date.now() + 60_000, sleep: async () => {} })
    expect(unconfirmed).toBe(1)
    expect(calls).toBe(1)
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
    'eval-hermes': { ok: false, reason: 'unused' },
    'eval-claude': { ok: false, reason: 'unused' },
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
    expect(Number(MERCHANT_TOPUP_TARGET_WEI / CDP_FAUCET_CLAIM_WEI)).toBe(40)
  })

  for (const [label, readings, stopReason, reason] of [
    ['at the target', merchantReadings(MERCHANT_TOPUP_TARGET_WEI), 'not-needed', /at or above its 0\.004 ETH target/],
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
    expect(topUpLogLine('merchant', { status: 'skipped', claimsMade: 0, amountReceivedAtomic: '0', unit: 'ETH', stopReason: 'missing-credentials' }))
      .toBe('merchant top-up: skipped: no CDP credentials')
    expect(topUpLogLine('merchant', { status: 'skipped', claimsMade: 0, amountReceivedAtomic: '0', unit: 'ETH', stopReason: 'wrong-chain', reason: 'merchant /healthz reports chain 8453, not 84532' }))
      .toBe('merchant top-up: skipped (wrong-chain) — merchant /healthz reports chain 8453, not 84532')
    expect(topUpLogLine('relayer', { status: 'attempted', claimsMade: 2, amountReceivedAtomic: '200000000000000', unit: 'ETH', stopReason: 'target-requests-complete' }))
      .toBe('relayer top-up: 2 claim(s), 0.0002 ETH, target-requests-complete')
    expect(topUpLogLine('relayer', undefined)).toBeNull()
  })

  it('the eval lines carry USDC units (#3997)', () => {
    expect(topUpLogLine('eval-hermes', { status: 'attempted', claimsMade: 3, amountReceivedAtomic: '3000000', unit: 'USDC', stopReason: 'target-requests-complete' }))
      .toBe('eval-hermes top-up: 3 claim(s), 3 USDC, target-requests-complete')
    expect(topUpLogLine('eval-claude', { status: 'skipped', claimsMade: 0, amountReceivedAtomic: '0', unit: 'USDC', stopReason: 'unreadable', reason: 'the eval account is not configured (QA_EVAL_CLAUDE_ACCOUNT)' }))
      .toBe('eval-claude top-up: skipped (unreadable) — the eval account is not configured (QA_EVAL_CLAUDE_ACCOUNT)')
  })
})

const topUpFixture = (band: 'ok' | 'warn' | 'critical' | 'unknown', atomic = 0n) => {
  const readings = {
    treasury: { ok: false, reason: 'unused' },
    merchant: { ok: false, reason: 'unused' },
    relayer: band === 'unknown'
      ? { ok: false, reason: 'read failed' }
      : { ok: true, address: RELAYER, atomic, criticalFloor: 1n, fallbackFloor: 1n },
    'eval-hermes': { ok: false, reason: 'unused' },
    'eval-claude': { ok: false, reason: 'unused' },
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

const evalReadings = (hermes: bigint | null, claude: bigint | null = null, hermesAddress = EVAL_HERMES): BalanceReadings =>
  ({
    treasury: { ok: false, reason: 'unused' },
    merchant: { ok: false, reason: 'unused' },
    relayer: { ok: false, reason: 'unused' },
    'eval-hermes': hermes === null
      ? { ok: false, reason: 'not configured: QA_EVAL_HERMES_ACCOUNT is unset' }
      : { ok: true, address: hermesAddress, atomic: hermes, criticalFloor: 3_000_000n, fallbackFloor: 21_000_000n },
    'eval-claude': claude === null
      ? { ok: false, reason: 'not configured: QA_EVAL_CLAUDE_ACCOUNT is unset' }
      : { ok: true, address: EVAL_CLAUDE, atomic: claude, criticalFloor: 3_000_000n, fallbackFloor: 21_000_000n },
  }) as BalanceReadings

describe('eval faucet top-up loop (#3997)', () => {
  const env = { ...CDP, GITHUB_RUN_ID: '123' }

  it('below the 21 USDC target: bounded 1-USDC claims with token "usdc", capped at 10', async () => {
    const calls: { address: string; token: string }[] = []
    const result = await topUpEvalAccount('eval-hermes', evalReadings(5_000_000n), env, {
      requestFaucet: async ({ address, token }) => {
        calls.push({ address, token: token! })
        return { transactionHash: nextHash() }
      },
      sleep: async () => {},
    })
    // 21 - 5 = 16 USDC needed at 1 per claim, capped at the per-run cap.
    expect(calls).toHaveLength(EVAL_TOPUP_MAX_CLAIMS)
    expect(calls.every((c) => c.address === EVAL_HERMES && c.token === 'usdc')).toBe(true)
    expect(result).toMatchObject({ status: 'attempted', claimsMade: EVAL_TOPUP_MAX_CLAIMS, unit: 'USDC', stopReason: 'claim-cap-reached' })
  })

  it('at or above the target: makes no faucet request', async () => {
    let calls = 0
    const result = await topUpEvalAccount('eval-hermes', evalReadings(EVAL_TOPUP_TARGET_ATOMIC), env, {
      requestFaucet: async () => { calls++; throw new Error('unexpected') },
    })
    expect(calls).toBe(0)
    expect(result).toMatchObject({ status: 'skipped', stopReason: 'not-needed', unit: 'USDC' })
    expect(result.reason).toMatch(/at or above its 21 USDC target/)
  })

  it('a 429 stops after one call', async () => {
    let calls = 0
    const result = await topUpEvalAccount('eval-hermes', evalReadings(0n), env, {
      requestFaucet: async () => { calls++; throw new CdpFaucetError('rate_limited', 'CDP faucet returned HTTP 429', 429) },
      sleep: async () => {},
    })
    expect(calls).toBe(1)
    expect(result).toMatchObject({ claimsMade: 0, stopReason: 'rate-limited', unit: 'USDC' })
  })

  it('an unconfigured account is skipped with its variable named, and never requested', async () => {
    let calls = 0
    const result = await topUpEvalAccount('eval-hermes', evalReadings(null), env, {
      requestFaucet: async () => { calls++; throw new Error('unexpected') },
    })
    expect(calls).toBe(0)
    expect(result).toMatchObject({ status: 'skipped', stopReason: 'unreadable', unit: 'USDC' })
    expect(result.reason).toMatch(/not configured: QA_EVAL_HERMES_ACCOUNT is unset/)
  })
})

it('the eval claim ids carry their own token-bearing namespaces; merchant and relayer pins stay unchanged', () => {
  for (const claim of [1, 2, 20]) {
    expect(deterministicClaimId('eval-hermes', '123', '1', claim)).not.toBe(deterministicClaimId('eval-claude', '123', '1', claim))
    expect(deterministicClaimId('eval-hermes', '123', '1', claim)).not.toBe(deterministicClaimId('relayer', '123', '1', claim))
    expect(deterministicClaimId('eval-hermes', '123', '1', claim)).not.toBe(deterministicClaimId('merchant', '123', '1', claim))
  }
})

describe('eval top-up end to end (#3997)', () => {
  it('claims USDC, waits for the claims to be mined, then re-reads the eval account', async () => {
    const events: string[] = []
    let calls = 0
    const sequenced = {
      getBalance: async () => ethers.parseEther('0.5'),
      getTransactionReceipt: async () => { events.push('receipt'); return { status: 1 } },
      call: async () => {
        // Reads 1-2: the treasury and the pre-top-up eval read (5 USDC);
        // later reads: the post-top-up re-read (5 + 10 claims = 15 USDC).
        const atomic = ++calls <= 2 ? 5_000_000n : 15_000_000n
        events.push(calls <= 2 ? 'eval-read-pre' : 'eval-read-post')
        return ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [atomic])
      },
    } as unknown as ethers.Provider
    const env: Record<string, string> = { ...FULL, ...CDP }
    delete env.QA_EVAL_CLAUDE_ACCOUNT
    const { report, exitCode } = await runBalances([], env, {
      ...deps(),
      provider: sequenced,
      requestFaucet: async ({ address, token }) => {
        events.push(`claim:${token}:${address === EVAL_HERMES ? 'eval' : 'other'}`)
        return { transactionHash: nextHash() }
      },
      sleep: async () => {},
    })
    expect(exitCode).toBe(0)
    expect(events.filter((e) => e.startsWith('claim:'))).toEqual(Array(10).fill('claim:usdc:eval'))
    // The wait happens before the re-read (#3896).
    expect(events.lastIndexOf('receipt')).toBeLessThan(events.indexOf('eval-read-post'))
    const row = report.rows.find((r) => r.key === 'eval-hermes')!
    expect(row).toMatchObject({ balance: '15', unit: 'USDC' })
    expect(report.topUps?.['eval-hermes']).toMatchObject({
      status: 'attempted',
      claimsMade: 10,
      unit: 'USDC',
      amountReceivedAtomic: '10000000',
    })
    expect(report.topUps?.['eval-claude']).toMatchObject({ status: 'skipped', stopReason: 'unreadable' })
    expect(report.topUps?.['eval-claude']?.reason).toMatch(/not configured: QA_EVAL_CLAUDE_ACCOUNT is unset/)
  })

  it('with both eval variables unset: exit 0, not-configured unknown rows, and no faucet request at all', async () => {
    const env: Record<string, string> = { ...FULL, ...CDP }
    delete env.QA_EVAL_HERMES_ACCOUNT
    delete env.QA_EVAL_CLAUDE_ACCOUNT
    let requests = 0
    const { report, exitCode } = await runBalances([], env, {
      ...deps(),
      requestFaucet: async () => { requests++; throw new Error('unexpected faucet request') },
      sleep: async () => {},
    })
    expect(exitCode).toBe(0)
    expect(requests).toBe(0)
    for (const key of ['eval-hermes', 'eval-claude'] as const) {
      const row = report.rows.find((r) => r.key === key)!
      expect(row.band).toBe('unknown')
      expect(row.configMissing).toBeUndefined()
      expect(row.reason).toMatch(/not configured/)
    }
    expect(report.topUps?.['eval-hermes']).toMatchObject({ status: 'skipped', stopReason: 'unreadable' })
  })
})

describe('the USDC loops run before the relayer under one deadline (#3997)', () => {
  const env = { ...CDP, GITHUB_RUN_ID: '123' }
  const fixtures = () => {
    const readings = {
      treasury: { ok: false, reason: 'unused' },
      merchant: { ok: true, address: MERCHANT, atomic: MERCHANT_TOPUP_TARGET_WEI, criticalFloor: 1n, fallbackFloor: 1n, chainId: 84532 },
      relayer: { ok: true, address: RELAYER, atomic: 5_000_000_000_000_000n, criticalFloor: 1n, fallbackFloor: 1n },
      'eval-hermes': { ok: true, address: EVAL_HERMES, atomic: 5_000_000n, criticalFloor: 3_000_000n, fallbackFloor: 21_000_000n },
      'eval-claude': { ok: false, reason: 'unused' },
    } as BalanceReadings
    const report = {
      checkedAt: '2026-10-05T06:00:00Z', history: [], configMissing: false,
      rows: [{ key: 'relayer', name: 'Dev backend relayer (84532)', unit: 'ETH', band: 'critical' }],
    } as BalancesReport
    return { readings, report }
  }

  it('a relayer loop that would use up the deadline cannot starve the USDC loops', async () => {
    const { readings, report } = fixtures()
    let now = 0
    const order: string[] = []
    const result = await runTopUps(readings, report, env, {
      // Each accepted claim spends the whole budget: the first loop to claim ends it.
      requestFaucet: async ({ address, token }) => {
        order.push(`${token}:${address}`)
        now += TOPUP_RUN_BUDGET_MS
        return { transactionHash: nextHash() }
      },
      sleep: async () => {},
      nowMs: () => now,
    })
    expect(order[0]).toBe(`usdc:${EVAL_HERMES}`)
    expect(result['eval-hermes']).toMatchObject({ claimsMade: 1, unit: 'USDC' })
    expect(result.relayer).toMatchObject({ claimsMade: 0, stopReason: 'run-budget-exhausted' })
  })
})
