/**
 * Search + Period over `filterEnrichedTransactions` (#4095).
 *
 * The route resolves names BEFORE filtering; these tests pin what the filter
 * itself matches — what the row SHOWS, per the issue: merchant/contact names,
 * another of the user's own accounts, the agent name, and the counterparty
 * address (partial, case-insensitive) — plus the window bounds and the
 * filter-before-paging guarantee.
 */
import { describe, expect, it } from 'vitest'
import { filterEnrichedTransactions, paginateByOffset } from '../orchestration.js'
import {
  counterpartyAddressOf,
  counterpartyAddressesOf,
  foldForSearch,
  type TransactionSearchIndex,
} from '../search.js'
import type { EnrichedTransaction } from '../types.js'

const CONTACT = '0xAAAA0000000000000000000000000000000000A1'
const MERCHANT = '0xBBBB0000000000000000000000000000000000B2'
const OWN_ACCOUNT = '0xCCCC0000000000000000000000000000000000C3'
const AGENT_ADDR = '0xDDDD0000000000000000000000000000000000D4'
const UNRELATED = '0xEEEE0000000000000000000000000000000000E5'

function tx(overrides: Partial<EnrichedTransaction> & { hash: string }): EnrichedTransaction {
  return {
    type: 'native',
    from: UNRELATED,
    to: CONTACT,
    value: '1000',
    valueFormatted: '10.00',
    asset: 'ETH',
    decimals: 18,
    direction: 'out',
    timestamp: 1_700_000_000,
    timestampSource: 'block',
    blockNumber: 1,
    isError: false,
    chainId: 8453,
    accountId: 'acc-1',
    accountAddress: OWN_ACCOUNT,
    accountName: 'Main',
    ...overrides,
  }
}

const index: TransactionSearchIndex = {
  contactNames: new Map([[CONTACT.toLowerCase(), 'Café Brasil']]),
  receiptNames: new Map([[MERCHANT.toLowerCase(), 'Kafé Veranda']]),
  accountNames: new Map([
    [`${OWN_ACCOUNT.toLowerCase()}:8453`, 'Savings'],
    // Same address, different chain — resolution is keyed by address AND chain.
    [`${OWN_ACCOUNT.toLowerCase()}:100`, 'Old Savings'],
  ]),
}

const feed: EnrichedTransaction[] = [
  tx({ hash: '0x1', to: CONTACT }), // contact name
  tx({ hash: '0x2', to: MERCHANT }), // receipt merchant name
  tx({ hash: '0x3', to: OWN_ACCOUNT }), // own account (internal transfer)
  tx({ hash: '0x4', to: AGENT_ADDR, agentName: 'Research agent' }), // agent name
  tx({ hash: '0x5', to: UNRELATED }), // matches nothing
]

function search(term: string, transactions = feed): EnrichedTransaction[] {
  return filterEnrichedTransactions(transactions, { search: term, searchIndex: index })
}

describe('foldForSearch (#4095 builder call: case + accent folding)', () => {
  it('folds case and strips accents', () => {
    expect(foldForSearch('Café Brasil')).toBe('cafe brasil')
    expect(foldForSearch('KAFÉ')).toBe('kafe')
  })
})

describe('counterpartyAddressOf', () => {
  it('reads `from` on incoming rows and the merchant address on x402 rows', () => {
    expect(counterpartyAddressOf(tx({ hash: '0xi', direction: 'in', from: CONTACT }))).toBe(CONTACT)
    expect(
      counterpartyAddressOf(
        tx({ hash: '0xx', to: OWN_ACCOUNT, x402MerchantAddress: MERCHANT }),
      ),
    ).toBe(MERCHANT)
  })
})

describe('counterpartyAddressesOf', () => {
  it('returns distinct addresses for the receipt-name read', () => {
    // Every feed row is outbound, so the counterparty is its `to` —
    // including the last row's bare address, which no name source covers.
    expect(counterpartyAddressesOf(feed)).toEqual([
      CONTACT,
      MERCHANT,
      OWN_ACCOUNT,
      AGENT_ADDR,
      UNRELATED,
    ])
  })
})

describe('filterEnrichedTransactions search (#4095)', () => {
  it('finds a row by the contact name it shows — case- and accent-insensitively', () => {
    expect(search('cafe').map((t) => t.hash)).toEqual(['0x1'])
    expect(search('CAFÉ BRASIL').map((t) => t.hash)).toEqual(['0x1'])
  })

  it('finds a row by a receipt-merchant name', () => {
    expect(search('veranda').map((t) => t.hash)).toEqual(['0x2'])
  })

  it('finds an internal transfer by the OTHER account\'s name — on the right chain only', () => {
    expect(search('savings').map((t) => t.hash)).toEqual(['0x3'])

    // Same address on chain 100 resolves to 'Old Savings' — the row on 8453
    // must not match it. `Savings` still matches because the account's own
    // name is the same word; use the distinct label to prove the key.
    const crossChain = [tx({ hash: '0x6', to: OWN_ACCOUNT, chainId: 100 })]
    expect(search('old savings', crossChain).map((t) => t.hash)).toEqual(['0x6'])
    expect(search('old savings', [tx({ hash: '0x7', to: OWN_ACCOUNT })])).toEqual([])
  })

  it('finds a row by agent name', () => {
    expect(search('research').map((t) => t.hash)).toEqual(['0x4'])
  })

  it('matches a PARTIAL address, case-insensitively (builder call)', () => {
    expect(search('bbb0').map((t) => t.hash)).toEqual(['0x2'])
    expect(search(MERCHANT.toLowerCase()).map((t) => t.hash)).toEqual(['0x2'])
  })

  it('returns nothing for a term no row shows, rather than everything', () => {
    expect(search('zanzibar')).toEqual([])
  })

  it('a blank search is no filter at all', () => {
    expect(search('   ').length).toBe(feed.length)
    expect(filterEnrichedTransactions(feed, { searchIndex: index }).length).toBe(feed.length)
  })
})

describe('filterEnrichedTransactions window (#4095)', () => {
  const NOW = Date.parse('2026-10-19T12:00:00Z')
  const rows = (ts: number) => [tx({ hash: '0xa', timestamp: Math.floor(ts / 1000) })]

  it('includes a row exactly at the window start, excludes one at the end', () => {
    const window = { startMs: NOW - 7 * 24 * 60 * 60 * 1000, endMs: NOW }
    expect(filterEnrichedTransactions(rows(window.startMs), { window })).toHaveLength(1)
    expect(filterEnrichedTransactions(rows(window.endMs), { window })).toHaveLength(0)
    expect(filterEnrichedTransactions(rows(window.endMs - 1), { window })).toHaveLength(1)
  })
})

describe('filters apply BEFORE paging (#4095 acceptance criterion)', () => {
  it('page 2 of a filtered set continues the filtered set', () => {
    // Six rows, only two inside the period: paging the filtered set must
    // surface those two across pages 1 and 2 — not rows 2 and 3 of the raw
    // feed.
    const window = { startMs: 0, endMs: 2_000_000 }
    const rows = [
      tx({ hash: '0x1', timestamp: 100 }),
      tx({ hash: '0x2', timestamp: 3_000_000 }),
      tx({ hash: '0x3', timestamp: 200 }),
      tx({ hash: '0x4', timestamp: 4_000_000 }),
      tx({ hash: '0x5', timestamp: 300 }),
      tx({ hash: '0x6', timestamp: 5_000_000 }),
    ]
    const filtered = filterEnrichedTransactions(rows, { window })
    expect(filtered.map((t) => t.hash)).toEqual(['0x1', '0x3', '0x5'])

    const page1 = paginateByOffset(filtered, 0, 2)
    const page2 = paginateByOffset(filtered, 2, 2)
    expect(page1.page.map((t) => t.hash)).toEqual(['0x1', '0x3'])
    expect(page1.hasMore).toBe(true)
    expect(page2.page.map((t) => t.hash)).toEqual(['0x5'])
    expect(page2.hasMore).toBe(false)
  })

  it('search and window compose with the existing direction/chain filters', () => {
    const filtered = filterEnrichedTransactions(feed, {
      direction: 'out',
      chainId: 8453,
      search: 'cafe',
      searchIndex: index,
    })
    expect(filtered.map((t) => t.hash)).toEqual(['0x1'])
  })
})
