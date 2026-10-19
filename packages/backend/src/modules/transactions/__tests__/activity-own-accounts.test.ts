/**
 * #4099 — a send to another of the user's own accounts is named by that
 * account in the dashboard activity feed instead of "New recipient". The
 * receiving side stays a deposit until the frontend half reads the name.
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

  it('the receiving side stays an unnamed deposit, grouped with the day’s other deposits', async () => {
    // Naming it waits for the frontend half (the client's inbound label must
    // read merchantName first); until then a separate named inbound group
    // would render as a second "Deposit" row.
    const result = await groups([
      row({ direction: 'in', from: STRANGER, to: MY_ACCOUNT }),
      row({ direction: 'in', from: RESERVE, to: MY_ACCOUNT }),
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
