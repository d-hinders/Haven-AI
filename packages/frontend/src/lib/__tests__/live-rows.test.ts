import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_GROUP_LIVE_OPTIONS,
  LIVE_ROW_CAP,
  TRANSACTION_LIVE_OPTIONS,
  activityGroupLiveKey,
  liveRowKeys,
  sameLiveKeys,
  transactionLiveKey,
  transactionOutcome,
  type DashboardActivityGroup,
} from '@/lib/live-rows'
import type { AggregatedTransaction } from '@/types/transactions'

/**
 * #4708: the two surfaces have SEPARATE fixtures, because their shapes differ.
 * `/transactions` rows keep a stable identity when they confirm, so the
 * snapshot maps identity → outcome; dashboard groups carry the outcome in
 * their key and advance `latestAt` when a second payment joins them.
 */

// ── Transactions fixture: rows with a stable identity ───────────────────────

function row(overrides: Partial<AggregatedTransaction> = {}): AggregatedTransaction {
  return {
    hash: '0xaaa',
    type: 'native',
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    value: '1000000',
    valueFormatted: '1',
    asset: 'USDC',
    decimals: 6,
    direction: 'out',
    timestamp: 1_800_000_000,
    blockNumber: 1,
    isError: false,
    chainId: 8453,
    accountId: 'safe-1',
    accountAddress: '0x1111111111111111111111111111111111111111',
    accountName: 'Main',
    ...overrides,
  }
}

function poll(
  rows: AggregatedTransaction[],
  previous: ReadonlyMap<string, string | number> | null,
) {
  return liveRowKeys(rows, previous, TRANSACTION_LIVE_OPTIONS)
}

// ── Dashboard fixture: groups whose key changes with the outcome ────────────

const MERCHANT = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'

function group(overrides: Partial<DashboardActivityGroup> = {}): DashboardActivityGroup {
  return {
    count: 1,
    sumAtomic: '12500000',
    tokenSymbol: 'USDC',
    decimals: 6,
    latestAt: '2026-11-08T10:00:00.000Z',
    agentId: 'agent-1',
    agentName: 'Research assistant',
    source: 'x402',
    x402ResourceUrl: 'https://research.example/report',
    to: MERCHANT,
    merchantName: null,
    activityType: null,
    direction: 'out',
    status: 'confirmed',
    approxAmount: '134.5000',
    approxCurrency: 'SEK',
    ...overrides,
  }
}

function groupPoll(
  groups: DashboardActivityGroup[],
  previous: ReadonlyMap<string, string | number> | null,
) {
  return liveRowKeys(groups, previous, ACTIVITY_GROUP_LIVE_OPTIONS)
}

describe('liveRowKeys — the shared comparison (#4708)', () => {
  it('plays nothing on the first load, and still returns the snapshot', () => {
    const { keys, snapshot } = poll([row()], null)
    expect(keys.size).toBe(0)
    expect(snapshot.get(transactionLiveKey(row()))).toBe('confirmed')
  })

  it('plays a new confirmed row on the next poll, once', () => {
    const first = poll([row()], null)
    const second = poll([row(), row({ hash: '0xbbb', timestamp: 1_800_000_100 })], first.snapshot)
    expect([...second.keys]).toEqual([transactionLiveKey(row({ hash: '0xbbb' }))])

    // The poll after that sees the same rows and plays nothing.
    const third = poll([row(), row({ hash: '0xbbb', timestamp: 1_800_000_100 })], second.snapshot)
    expect(third.keys.size).toBe(0)
  })

  it('caps one poll at the newest three', () => {
    const first = poll([], null)
    const arrivals = [0, 1, 2, 3, 4].map((n) =>
      row({ hash: `0x${n}`, timestamp: 1_800_000_000 + n }),
    )
    const { keys } = poll(arrivals, first.snapshot)
    expect(keys.size).toBe(LIVE_ROW_CAP)
    // The newest three, not the first three the feed happened to list.
    expect([...keys].sort()).toEqual(
      [transactionLiveKey(arrivals[2]), transactionLiveKey(arrivals[3]), transactionLiveKey(arrivals[4])].sort(),
    )
  })

  it('honours a caller-supplied cap', () => {
    const first = poll([], null)
    const arrivals = [0, 1, 2].map((n) => row({ hash: `0x${n}`, timestamp: 1_800_000_000 + n }))
    const { keys } = liveRowKeys(arrivals, first.snapshot, { ...TRANSACTION_LIVE_OPTIONS, cap: 1 })
    expect([...keys]).toEqual([transactionLiveKey(arrivals[2])])
  })
})

describe('Transactions — rows with a stable identity (#4708)', () => {
  it('a new failed row does not play', () => {
    const first = poll([], null)
    const { keys } = poll([row({ isError: true })], first.snapshot)
    expect(keys.size).toBe(0)
  })

  it('a new pending row does not play', () => {
    const first = poll([], null)
    const { keys } = poll([row({ paymentFlowStatus: 'confirming_merchant' })], first.snapshot)
    expect(keys.size).toBe(0)
  })

  it('a pending row that confirms plays then, once — its identity never changed', () => {
    const pending = row({ paymentFlowStatus: 'confirming_merchant' })
    const first = poll([pending], null)
    expect(first.snapshot.get(transactionLiveKey(pending))).toBe('pending')

    const confirmed = row()
    expect(transactionLiveKey(confirmed)).toBe(transactionLiveKey(pending))
    const second = poll([confirmed], first.snapshot)
    expect([...second.keys]).toEqual([transactionLiveKey(confirmed)])

    const third = poll([confirmed], second.snapshot)
    expect(third.keys.size).toBe(0)
  })

  it('a non-terminal proof status is pending; a terminal one is confirmed', () => {
    expect(transactionOutcome(row({ paymentProofStatus: 'payment_confirmed' }))).toBe('pending')
    expect(transactionOutcome(row({ paymentProofStatus: 'protocol_receipt_attached' }))).toBe('confirmed')
    expect(transactionOutcome(row({ paymentProofStatus: 'merchant_response_observed' }))).toBe('confirmed')
    expect(transactionOutcome(row({ paymentProofStatus: null }))).toBe('confirmed')
    expect(transactionOutcome(row({ isError: true }))).toBe('failed')
  })

  it('the identity is accountId:hash:type — the React key without its index', () => {
    // The `ownTransfer` fold (#4265) can put two rows under one hash; the
    // index is a React-key tiebreaker, never part of the identity.
    const leg = row({ hash: '0xfold', type: 'native' })
    expect(transactionLiveKey(leg)).toBe('safe-1:0xfold:native')
    expect(transactionLiveKey({ ...leg })).toBe(transactionLiveKey(leg))
    // A different account or type is a different row.
    expect(transactionLiveKey({ ...leg, accountId: 'safe-2' })).not.toBe(transactionLiveKey(leg))
    expect(transactionLiveKey({ ...leg, type: 'erc20' })).not.toBe(transactionLiveKey(leg))
  })

  it('a row that survives a poll unchanged never plays again', () => {
    const rows = [row(), row({ hash: '0xbbb', timestamp: 1_800_000_100 })]
    const first = poll(rows, null)
    const second = poll(rows, first.snapshot)
    const third = poll(rows, second.snapshot)
    expect(second.keys.size).toBe(0)
    expect(third.keys.size).toBe(0)
  })
})

describe('Dashboard — groups whose key changes with the outcome (#4708)', () => {
  it('plays nothing on the first load', () => {
    const { keys, snapshot } = groupPoll([group()], null)
    expect(keys.size).toBe(0)
    expect(snapshot.get(activityGroupLiveKey(group()))).toBe(Date.parse(group().latestAt))
  })

  it('a new confirmed group plays once', () => {
    const first = groupPoll([group()], null)
    const second = groupPoll(
      [group(), group({ x402ResourceUrl: 'https://other.example/x', latestAt: '2026-11-08T11:00:00.000Z' })],
      first.snapshot,
    )
    expect([...second.keys]).toEqual([
      activityGroupLiveKey(group({ x402ResourceUrl: 'https://other.example/x' })),
    ])
  })

  it('a new pending or failed group does not play', () => {
    const first = groupPoll([], null)
    expect(groupPoll([group({ status: 'pending' })], first.snapshot).keys.size).toBe(0)
    expect(groupPoll([group({ status: 'failed' })], first.snapshot).keys.size).toBe(0)
  })

  it('a pending group that confirms plays then, once — the key carries the outcome', () => {
    const pending = group({ status: 'pending' })
    const first = groupPoll([pending], null)
    expect(activityGroupLiveKey(pending)).not.toBe(activityGroupLiveKey(group()))

    const second = groupPoll([group()], first.snapshot)
    expect([...second.keys]).toEqual([activityGroupLiveKey(group())])

    const third = groupPoll([group()], second.snapshot)
    expect(third.keys.size).toBe(0)
  })

  it('a second payment in an existing group plays — count rises, latestAt advances, the key does not change', () => {
    const first = groupPoll([group()], null)
    const second = groupPoll(
      [group({ count: 2, sumAtomic: '25000000', latestAt: '2026-11-08T10:05:00.000Z' })],
      first.snapshot,
    )
    expect([...second.keys]).toEqual([activityGroupLiveKey(group())])
  })

  it('the key is stable across polls when nothing changed', () => {
    const first = groupPoll([group()], null)
    const second = groupPoll([group()], first.snapshot)
    expect(second.keys.size).toBe(0)
  })

  it('the key ignores the display name but keeps the counterparty and the day', () => {
    const base = activityGroupLiveKey(group())
    // A contact renamed mid-session is not a new group.
    expect(activityGroupLiveKey(group({ merchantName: 'Acme Ltd' }))).toBe(base)
    // A different counterparty, resource, agent, token, direction or day is.
    expect(activityGroupLiveKey(group({ to: '0x9999999999999999999999999999999999999999' }))).not.toBe(base)
    expect(activityGroupLiveKey(group({ x402ResourceUrl: 'https://other.example/x' }))).not.toBe(base)
    expect(activityGroupLiveKey(group({ agentId: null }))).not.toBe(base)
    expect(activityGroupLiveKey(group({ tokenSymbol: 'ETH' }))).not.toBe(base)
    expect(activityGroupLiveKey(group({ direction: 'in' }))).not.toBe(base)
    expect(activityGroupLiveKey(group({ latestAt: '2026-11-07T10:00:00.000Z' }))).not.toBe(base)
  })

  it('caps one poll at the newest three groups', () => {
    const first = groupPoll([], null)
    const arrivals = [0, 1, 2, 3, 4].map((n) =>
      group({
        x402ResourceUrl: `https://r${n}.example/x`,
        latestAt: `2026-11-08T1${n}:00:00.000Z`,
      }),
    )
    const { keys } = groupPoll(arrivals, first.snapshot)
    expect(keys.size).toBe(LIVE_ROW_CAP)
    expect([...keys].sort()).toEqual(
      [arrivals[2], arrivals[3], arrivals[4]].map(activityGroupLiveKey).sort(),
    )
  })
})

describe('sameLiveKeys', () => {
  it('compares by content, not identity', () => {
    expect(sameLiveKeys(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true)
    expect(sameLiveKeys(new Set(['a']), new Set(['a', 'b']))).toBe(false)
    expect(sameLiveKeys(new Set(['a']), new Set(['b']))).toBe(false)
    expect(sameLiveKeys(new Set(), new Set())).toBe(true)
  })
})
