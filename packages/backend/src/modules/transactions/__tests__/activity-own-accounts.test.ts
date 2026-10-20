/**
 * #4099 — a transfer between two of the user's own accounts is named by the
 * other account on both sides of the dashboard activity feed, instead of
 * "New recipient" (sender) or an anonymous "Deposit" (receiver).
 *
 * Pure grouping behaviour over in-memory rows: no database involved.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../infra/prices.js', () => ({
  getTokenPrice: async () => ({ usd: 1, eur: 0.9, sek: 10.76 }),
}))

import { buildActivityGroups, ownAccountNameResolver } from '../activity.js'
import type { EnrichedTransaction } from '../types.js'

const NOW = Date.parse('2026-10-19T12:00:00Z')
const MY_ACCOUNT = '0x98ffbf30459a98fd80face18f519967769641f76'
const RESERVE = '0x16A14580Dd6847C505C8CECAFfF3d36F1FC1ee2e'
const STRANGER = '0x' + 'cd'.repeat(20)
const CHAIN = 84532

const ACCOUNTS = [
  { account_address: MY_ACCOUNT, chain_id: CHAIN, name: 'My account' },
  { account_address: RESERVE, chain_id: CHAIN, name: 'Reserve' },
]

let seq = 0
function row(overrides: Partial<EnrichedTransaction>): EnrichedTransaction {
  return {
    hash: `0x${String(++seq).padStart(4, '0').repeat(16)}`,
    type: 'erc20',
    from: MY_ACCOUNT,
    to: RESERVE,
    value: '1000000',
    valueFormatted: '1.0',
    asset: 'USDC',
    tokenSymbol: 'USDC',
    tokenAddress: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    decimals: 6,
    direction: 'out',
    timestamp: Math.floor(NOW / 1000) - 3600,
    timestampSource: 'block',
    blockNumber: null,
    isError: false,
    chainId: CHAIN,
    accountId: 'acc-my',
    accountAddress: MY_ACCOUNT,
    accountName: 'My account',
    ...overrides,
  }
}

function groups(transactions: EnrichedTransaction[], resolveMerchantName?: (a: string) => string | null) {
  return buildActivityGroups({
    transactions,
    truncated: false,
    tz: 'UTC',
    now: NOW,
    resolveMerchantName,
    resolveOwnAccountName: ownAccountNameResolver(ACCOUNTS),
  })
}

describe('own-account transfers in the activity feed (#4099)', () => {
  it('names the sending side of a transfer to another own account', async () => {
    const result = await groups([row({ direction: 'out', from: MY_ACCOUNT, to: RESERVE })])
    expect(result[0].merchantName).toBe('Reserve')
  })

  it('names the receiving side by the sending own account', async () => {
    const result = await groups([
      row({
        direction: 'in',
        from: MY_ACCOUNT,
        to: RESERVE,
        accountId: 'acc-reserve',
        accountAddress: RESERVE,
        accountName: 'Reserve',
      }),
    ])
    expect(result[0]).toMatchObject({ direction: 'in', merchantName: 'My account' })
  })

  it('a transfer in from an own account gets its own group; the day’s other deposits stay one unnamed group', async () => {
    const result = await groups([
      row({ direction: 'in', from: STRANGER, to: MY_ACCOUNT }),
      row({ direction: 'in', from: '0x' + 'ef'.repeat(20), to: MY_ACCOUNT }),
      row({ direction: 'in', from: RESERVE, to: MY_ACCOUNT }),
    ])
    expect(result).toHaveLength(2)
    const named = result.find((g) => g.merchantName === 'Reserve')
    const deposits = result.find((g) => g.merchantName === null)
    expect(named).toMatchObject({ count: 1, direction: 'in' })
    expect(deposits).toMatchObject({ count: 2, direction: 'in' })
  })

  it('an inbound group key never collides with an outbound one to the same address', async () => {
    // Direction is not part of the group key; the `own:` prefix keeps a send
    // TO the reserve and a transfer FROM it as two rows.
    const result = await groups([
      row({ direction: 'out', from: MY_ACCOUNT, to: RESERVE }),
      row({ direction: 'in', from: RESERVE, to: MY_ACCOUNT }),
    ])
    expect(result.map((g) => [g.direction, g.merchantName]).sort()).toEqual([
      ['in', 'Reserve'],
      ['out', 'Reserve'],
    ])
  })

  it('the receiving side prefers a contact name for the sending own account, like the send side', async () => {
    const result = await groups(
      [row({ direction: 'in', from: RESERVE, to: MY_ACCOUNT })],
      (address) => (address.toLowerCase() === RESERVE.toLowerCase() ? 'Savings (contact)' : null),
    )
    expect(result[0].merchantName).toBe('Savings (contact)')
  })

  it('a contact name alone never names a deposit — only an own-account sender is named', async () => {
    const result = await groups(
      [row({ direction: 'in', from: STRANGER, to: MY_ACCOUNT })],
      (address) => (address.toLowerCase() === STRANGER ? 'Some contact' : null),
    )
    expect(result[0]).toMatchObject({ merchantName: null })
  })

  it('an inbound row from an own account\'s address on another chain stays an unnamed deposit', async () => {
    const result = await groups([
      row({ direction: 'in', from: STRANGER, to: MY_ACCOUNT, chainId: 8453 }),
      row({ direction: 'in', from: RESERVE, to: MY_ACCOUNT, chainId: 8453 }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ count: 2, merchantName: null })
  })

  it('a contact name wins over the own-account name; a stranger stays unresolved', async () => {
    const result = await groups(
      [row({ to: RESERVE }), row({ to: STRANGER })],
      (address) => (address.toLowerCase() === RESERVE.toLowerCase() ? 'Savings (contact)' : null),
    )
    const byTo = new Map(result.map((g) => [g.to.toLowerCase(), g.merchantName]))
    expect(byTo.get(RESERVE.toLowerCase())).toBe('Savings (contact)')
    expect(byTo.get(STRANGER)).toBeNull()
  })

  it('the lookup is chain-scoped: the same address on another chain is not that account', async () => {
    const result = await groups([row({ to: RESERVE, chainId: 8453 })])
    expect(result[0].merchantName).toBeNull()
  })
})
