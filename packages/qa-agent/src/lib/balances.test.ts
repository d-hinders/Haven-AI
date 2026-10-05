/**
 * #3631 — the runway maths and the per-wallet rows behind the standing
 * `QA wallet balances low` issue. Thresholds, not ethers: providers and
 * `/healthz` are stubs.
 */
import { describe, expect, it } from 'vitest'
import { ethers } from 'ethers'
import {
  appendHistory,
  burnPerDay,
  classify,
  collectBalances,
  MIN_READINGS,
  readingsFor,
  RELAYER_FALLBACK_FLOOR_WEI,
  runwayDays,
  TREASURY_FALLBACK_FLOOR_ATOMIC,
  type BalanceSources,
  type HistoryEntry,
} from './balances.js'
import { TREASURY_RUN_COST_ATOMIC } from './preflight.js'

const USDC = (n: number) => BigInt(Math.round(n * 1_000_000))
const ETH = (n: number) => ethers.parseEther(String(n))

/** A provider that answers USDC `balanceOf` and native `getBalance`. */
function provider(usdcAtomic: bigint | Error, weiByAddress: Record<string, bigint | Error> = {}): ethers.Provider {
  return {
    call: async () => {
      if (usdcAtomic instanceof Error) throw usdcAtomic
      return ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [usdcAtomic])
    },
    getBalance: async (address: string) => {
      const v = weiByAddress[address.toLowerCase()] ?? weiByAddress[address]
      if (v instanceof Error) throw v
      return v ?? 0n
    },
  } as unknown as ethers.Provider
}

const TREASURY = '0x9281d7c312e67859c65f4A3449F0548ea2f90974'
const RELAYER = '0x' + 'ab'.repeat(20)
const SETTLEMENT = '0x' + 'cd'.repeat(20)

const api = (address = TREASURY) => ({ getAgent: async () => ({ ok: true, status: 200, data: { account_address: address } }) }) as never

function healthz(body: unknown, status = 200): typeof fetch {
  return (async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch
}
const merchantOk = healthz({
  settlement: { address: SETTLEMENT, native_balance_wei: ETH(0.01).toString(), settlements_remaining: 100, warn_floor: 25, fail_floor: 12 },
})

/** A falling series of `days` daily readings ending at `end`, dropping `perDay` each day. */
function falling(end: bigint, perDay: bigint, days: number): bigint[] {
  return Array.from({ length: days }, (_, i) => end + perDay * BigInt(days - 1 - i))
}

describe('burnPerDay', () => {
  it('is the median of the negative day-over-day deltas', () => {
    expect(burnPerDay([100n, 90n, 70n, 60n])).toBe(10n) // drops 10, 20, 10 → median 10
    expect(burnPerDay([100n, 90n, 70n, 60n, 30n])).toBe(15n) // drops 10, 20, 10, 30 → (10+20)/2
  })

  it('ignores top-ups: a refill never reads as negative burn or shortens the median', () => {
    expect(burnPerDay([100n, 90n, 500n, 490n, 480n])).toBe(10n)
  })

  it('is null with no negative delta (flat or only topped up)', () => {
    expect(burnPerDay([100n, 100n, 200n])).toBeNull()
    expect(burnPerDay([100n])).toBeNull()
  })
})

describe('runwayDays', () => {
  it('is balance ÷ burn, one decimal; null when nothing burns', () => {
    expect(runwayDays(70n, 10n)).toBe(7)
    expect(runwayDays(69n, 10n)).toBe(6.9)
    expect(runwayDays(70n, null)).toBeNull()
    expect(runwayDays(70n, 0n)).toBeNull()
  })
})

describe('classify', () => {
  const floors = { criticalFloor: TREASURY_RUN_COST_ATOMIC, fallbackFloor: TREASURY_FALLBACK_FLOOR_ATOMIC }

  it(`fewer than ${MIN_READINGS} readings uses the fallback floor (USDC)`, () => {
    const few = [USDC(2), USDC(1.5)]
    expect(classify({ balance: USDC(1.5), readings: few, ...floors })).toMatchObject({ band: 'ok', basis: 'fallback' })
    expect(classify({ balance: USDC(0.99), readings: few, ...floors })).toMatchObject({ band: 'warn', basis: 'fallback' })
    expect(classify({ balance: USDC(0.033), readings: few, ...floors })).toMatchObject({ band: 'critical', basis: 'fallback' })
  })

  it('observed burn: runway just above 7 days is ok, just below is warn (USDC)', () => {
    const burn = USDC(0.1)
    const above = falling(USDC(0.71), burn, MIN_READINGS) // 7.1 days
    const below = falling(USDC(0.69), burn, MIN_READINGS) // 6.9 days
    expect(classify({ balance: above.at(-1)!, readings: above, ...floors })).toMatchObject({ band: 'ok', basis: 'observed', runway: 7.1 })
    expect(classify({ balance: below.at(-1)!, readings: below, ...floors })).toMatchObject({ band: 'warn', basis: 'observed', runway: 6.9 })
  })

  it('observed burn: runway below 1 day is critical, and below the one-run floor is critical whatever the runway', () => {
    const fast = falling(USDC(0.5), USDC(0.6), MIN_READINGS) // 0.8 days
    expect(classify({ balance: fast.at(-1)!, readings: fast, ...floors }).band).toBe('critical')
    const slowButEmpty = falling(USDC(0.03), 1n, MIN_READINGS) // runway huge, but under 0.034 USDC
    expect(classify({ balance: slowButEmpty.at(-1)!, readings: slowButEmpty, ...floors }).band).toBe('critical')
  })

  it('observed but flat: no burn means ok unless below the one-run floor', () => {
    const flat = Array.from({ length: MIN_READINGS }, () => USDC(0.5))
    expect(classify({ balance: USDC(0.5), readings: flat, ...floors })).toMatchObject({ band: 'ok', runway: null })
  })

  it('ETH units: the relayer fallback floor (0.01 ETH) is both warn and critical until history exists', () => {
    const relayerFloors = { criticalFloor: RELAYER_FALLBACK_FLOOR_WEI, fallbackFloor: RELAYER_FALLBACK_FLOOR_WEI }
    expect(classify({ balance: ETH(0.0101), readings: [ETH(0.0101)], ...relayerFloors }).band).toBe('ok')
    expect(classify({ balance: ETH(0.0099), readings: [ETH(0.0099)], ...relayerFloors }).band).toBe('critical')
    const burning = falling(ETH(0.05), ETH(0.01), MIN_READINGS) // 5 days at 0.01 ETH/day
    expect(classify({ balance: burning.at(-1)!, readings: burning, ...relayerFloors })).toMatchObject({ band: 'warn', runway: 5 })
  })
})

describe('history', () => {
  it('replaces today, keeps order, and caps at 14 days', () => {
    let h: HistoryEntry[] = []
    for (let d = 1; d <= 16; d++) h = appendHistory(h, `2026-10-${String(d).padStart(2, '0')}`, { treasury: BigInt(d) })
    h = appendHistory(h, '2026-10-16', { treasury: 99n })
    expect(h).toHaveLength(14)
    expect(h[0]!.date).toBe('2026-10-03')
    expect(readingsFor(h, 'treasury').at(-1)).toBe(99n)
  })

  it('a day a wallet was unreadable is skipped, not read as zero', () => {
    const h: HistoryEntry[] = [
      { date: '2026-10-01', balances: { treasury: '100' } },
      { date: '2026-10-02', balances: {} },
      { date: '2026-10-03', balances: { treasury: '90' } },
    ]
    expect(readingsFor(h, 'treasury')).toEqual([100n, 90n])
  })
})

describe('collectBalances', () => {
  const now = new Date('2026-10-05T06:00:00Z')

  it('emits all three wallets with address, balance and band', async () => {
    const src: BalanceSources = {
      api: api(),
      demoMerchantUrl: 'https://merchant.test',
      relayerAddress: RELAYER,
      provider: provider(USDC(5), { [RELAYER]: ETH(0.5) }),
      fetchImpl: merchantOk,
    }
    const report = await collectBalances(src, [], now)
    expect(report.rows.map((r) => [r.key, r.band, r.balance, r.address])).toEqual([
      ['treasury', 'ok', '5', TREASURY],
      ['merchant', 'ok', '0.01', SETTLEMENT],
      ['relayer', 'ok', '0.5', RELAYER],
    ])
    expect(report.configMissing).toBe(false)
    expect(report.history).toEqual([
      { date: '2026-10-05', balances: { treasury: '5000000', merchant: ETH(0.01).toString(), relayer: ETH(0.5).toString() } },
    ])
  })

  it('a treasury below 7 days of observed runway is warn, naming balance and runway', async () => {
    // Six earlier days falling 0.1 USDC/day to 0.6; today reads 0.5 → 7 readings.
    const history: HistoryEntry[] = falling(USDC(0.6), USDC(0.1), MIN_READINGS - 1).map((v, i) => ({
      date: new Date(Date.UTC(2026, 8, 29 + i)).toISOString().slice(0, 10),
      balances: { treasury: v.toString() },
    }))
    const src: BalanceSources = {
      api: api(),
      demoMerchantUrl: 'https://merchant.test',
      relayerAddress: RELAYER,
      provider: provider(USDC(0.5), { [RELAYER]: ETH(0.5) }),
      fetchImpl: merchantOk,
    }
    const report = await collectBalances(src, history, now)
    const treasury = report.rows.find((r) => r.key === 'treasury')!
    expect(treasury).toMatchObject({ band: 'warn', basis: 'observed', balance: '0.5', burnPerDay: '0.1', runwayDays: 5 })
  })

  it('the merchant floors convert from settlements: below its fail floor is critical', async () => {
    const lowMerchant = healthz({
      settlement: { address: SETTLEMENT, native_balance_wei: '1100', settlements_remaining: 11, warn_floor: 25, fail_floor: 12 },
    })
    const src: BalanceSources = { api: api(), demoMerchantUrl: 'https://m.test', relayerAddress: RELAYER, provider: provider(USDC(5), { [RELAYER]: ETH(1) }), fetchImpl: lowMerchant }
    const report = await collectBalances(src, [], now)
    expect(report.rows.find((r) => r.key === 'merchant')!.band).toBe('critical')
  })

  it('a read failure is unknown with a reason, never a missing row, and not config-missing', async () => {
    const src: BalanceSources = {
      api: api(),
      demoMerchantUrl: 'https://merchant.test',
      relayerAddress: RELAYER,
      provider: provider(new Error('rpc down'), { [RELAYER]: new Error('rpc down') }),
      fetchImpl: healthz({}, 503),
    }
    const report = await collectBalances(src, [], now)
    expect(report.rows.map((r) => r.band)).toEqual(['unknown', 'unknown', 'unknown'])
    expect(report.rows.every((r) => typeof r.reason === 'string' && r.reason.length > 0)).toBe(true)
    expect(report.configMissing).toBe(false)
    expect(report.history[0]!.balances).toEqual({})
  })
})
