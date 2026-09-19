/**
 * Every address a transaction row carries is emitted in ONE form, from both
 * row-producing boundaries, and an x402 row's unknown block is `null` (#3129).
 *
 * The field observation this pins, 2026-09-18 on dev: `from` and
 * `tokenAddress` checksummed beside `to` and `x402MerchantAddress` lowercase,
 * **in the same row**, with `blockNumber: 0` on all five rows. Any consumer
 * comparing two of those addresses with `===` gets a false negative on a
 * payment record.
 *
 * The guard below walks the row rather than listing fields, so a NEW address
 * field that skips normalisation fails without anyone remembering to extend a
 * list — which is the acceptance criterion "a new field cannot be added and
 * silently skip it", expressed as a test rather than a convention.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ethers } from 'ethers'

const mockFindConfirmedX402PaymentIntents = vi.fn()
const mockFetchNormal = vi.fn()
const mockFetchInternal = vi.fn()
const mockFetchERC20 = vi.fn()

// Collaborators these tests do not own — a repository and the explorer HTTP
// client — not `db.js` and no positional chains (`lint:db-mocks`' two counts).
vi.mock('../../../infra/repositories/transaction-history.js', () => ({
  findConfirmedX402PaymentIntents: mockFindConfirmedX402PaymentIntents,
}))
vi.mock('../../../infra/explorer-api.js', () => ({
  fetchNormalTransactions: mockFetchNormal,
  fetchInternalTransactions: mockFetchInternal,
  fetchERC20Transfers: mockFetchERC20,
}))

const { fetchConfirmedX402Transactions } = await import('../x402.js')
const { fetchAccountTransactions } = await import('../aggregate.js')

const CHAIN_ID = 8453
const ACCOUNT = ethers.getAddress('0xab5801a7d398351b8be11c439e05c5b3259aec9b')
const MERCHANT = ethers.getAddress('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
const USDC = ethers.getAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')

const ADDRESS_SHAPED = /^0x[0-9a-fA-F]{40}$/

/**
 * Every address-shaped string value on `row`, as `[field, value]`. Walks the
 * row so a newly added address field is covered automatically.
 */
function addressFields(row: Record<string, unknown>): [string, string][] {
  return Object.entries(row).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === 'string' && ADDRESS_SHAPED.test(entry[1]),
  )
}

function expectEveryAddressCanonical(row: Record<string, unknown>): void {
  const fields = addressFields(row)
  // The guard is only evidence if it found something to check.
  expect(fields.length).toBeGreaterThan(0)
  for (const [field, value] of fields) {
    expect(value, `${field} is not in canonical (checksummed) form`).toBe(
      ethers.getAddress(value.toLowerCase()),
    )
  }
}

const logStub = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
} as unknown as Parameters<typeof fetchAccountTransactions>[0]['log']

beforeEach(() => {
  vi.clearAllMocks()
})

describe('x402-synthesized rows (#3129)', () => {
  function intentRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'intent-1',
      tx_hash: '0x' + 'ab'.repeat(32),
      agent_id: 'agent-1',
      agent_name: 'Buyer',
      account_id: 'account-1',
      account_address: ACCOUNT, // checksummed in the DB …
      account_name: 'Main',
      chain_id: CHAIN_ID,
      token_symbol: 'USDC',
      token_address: USDC, // … and so is this …
      to_address: MERCHANT.toLowerCase(), // … while these two are lowercase.
      amount_raw: '1000000',
      amount_human: '1.00',
      x402_merchant_address: MERCHANT.toLowerCase(),
      x402_resource_url: 'https://merchant.example/resource',
      payment_proof_status: 'payment_confirmed',
      payment_reconciliation_event_type: null,
      amount_sek: null,
      fx_rate_sek: null,
      fx_source: null,
      settlement_scheme: 'erc7710',
      confirmed_at: '2026-09-18T10:00:00.000Z',
      created_at: '2026-09-18T09:59:00.000Z',
      ...overrides,
    }
  }

  it('emits every address in one canonical form, from a row that mixes both', async () => {
    mockFindConfirmedX402PaymentIntents.mockResolvedValue([intentRow()])

    const [row] = await fetchConfirmedX402Transactions('user-1', [
      { id: 'account-1', account_address: ACCOUNT, chain_id: CHAIN_ID, name: 'Main' },
    ])

    // The four fields the field run saw disagree on — now agreeing.
    expect(row.from).toBe(ACCOUNT)
    expect(row.to).toBe(MERCHANT)
    expect(row.tokenAddress).toBe(USDC)
    expect(row.x402MerchantAddress).toBe(MERCHANT)
    expect(row.accountAddress).toBe(ACCOUNT)
    expectEveryAddressCanonical(row as unknown as Record<string, unknown>)
  })

  it('CONTROL: the fixture really does mix forms, so the assertion above can fail', async () => {
    const fixture = intentRow()
    expect(fixture.account_address).not.toBe(fixture.account_address.toLowerCase())
    expect(fixture.x402_merchant_address).toBe(fixture.x402_merchant_address?.toLowerCase())
  })

  it('reports an unknown block as null, never 0', async () => {
    mockFindConfirmedX402PaymentIntents.mockResolvedValue([intentRow()])

    const [row] = await fetchConfirmedX402Transactions('user-1', [
      { id: 'account-1', account_address: ACCOUNT, chain_id: CHAIN_ID, name: 'Main' },
    ])

    expect(row.blockNumber).toBeNull()
    // The row carries a real settlement hash, which is exactly why `0` was
    // misleading: it read as "block zero" beside a transaction that exists.
    expect(row.hash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('keeps a null merchant address null rather than inventing one', async () => {
    mockFindConfirmedX402PaymentIntents.mockResolvedValue([
      intentRow({ x402_merchant_address: null }),
    ])

    const [row] = await fetchConfirmedX402Transactions('user-1', [
      { id: 'account-1', account_address: ACCOUNT, chain_id: CHAIN_ID, name: 'Main' },
    ])

    expect(row.x402MerchantAddress).toBeNull()
    // `to` falls back to `to_address`, and that fallback is normalised too.
    expect(row.to).toBe(MERCHANT)
  })
})

describe('explorer-derived rows (#3129)', () => {
  const leg = <T,>(rows: T[]) => ({ rows, hasMore: false })

  it('checksums lowercase explorer addresses and keeps the real block number', async () => {
    mockFetchNormal.mockResolvedValue(
      leg([
        {
          blockNumber: '31337',
          timeStamp: '1758189600',
          hash: '0x' + 'cd'.repeat(32),
          // Etherscan (Gnosis) returns lowercase; Blockscout (Base) checksums.
          // `chains.ts` maps Base→blockscout-v2 and Gnosis→etherscan-v2, which
          // is the opposite of what the provider names suggest.
          from: ACCOUNT.toLowerCase(),
          to: MERCHANT.toLowerCase(),
          value: '5',
          gas: '21000',
          gasUsed: '21000',
          isError: '0',
          functionName: '',
        },
      ]),
    )
    mockFetchInternal.mockResolvedValue(leg([]))
    mockFetchERC20.mockResolvedValue(
      leg([
        {
          blockNumber: '31338',
          timeStamp: '1758189700',
          hash: '0x' + 'ef'.repeat(32),
          from: ACCOUNT.toLowerCase(),
          to: MERCHANT.toLowerCase(),
          value: '1000000',
          contractAddress: USDC.toLowerCase(),
          tokenName: 'USD Coin',
          tokenSymbol: 'USDC',
          tokenDecimal: '6',
        },
      ]),
    )

    const { transactions } = await fetchAccountTransactions({
      accountId: 'account-1',
      accountAddress: ACCOUNT,
      chainId: CHAIN_ID,
      log: logStub,
      fresh: true,
    })

    expect(transactions.length).toBe(2)
    for (const row of transactions) {
      expectEveryAddressCanonical(row as unknown as Record<string, unknown>)
      // The explorer legs DO populate the block — the zeros in the field run
      // were the x402 path, not a failed `parseInt` here.
      expect(row.blockNumber).toBeGreaterThan(0)
    }
    expect(transactions.map((t) => t.blockNumber)).toEqual([31338, 31337])
  })

  it('leaves an empty counterparty empty — the documented no-counterparty value', async () => {
    mockFetchNormal.mockResolvedValue(
      leg([
        {
          blockNumber: '31339',
          timeStamp: '1758189800',
          hash: '0x' + '01'.repeat(32),
          from: ACCOUNT.toLowerCase(),
          to: '', // `explorer-api.ts`: `tx.to?.hash ?? ''`
          value: '7',
          gas: '21000',
          gasUsed: '21000',
          isError: '0',
          functionName: '',
        },
      ]),
    )
    mockFetchInternal.mockResolvedValue(leg([]))
    mockFetchERC20.mockResolvedValue(leg([]))

    const { transactions } = await fetchAccountTransactions({
      accountId: 'account-2',
      accountAddress: ACCOUNT,
      chainId: CHAIN_ID,
      log: logStub,
      fresh: true,
    })

    expect(transactions[0].to).toBe('')
    expect(transactions[0].from).toBe(ACCOUNT)
  })
})

describe('assembled wire row (#3129)', () => {
  /**
   * `accountAddress` is attached during ASSEMBLY (`orchestration.ts`), not by
   * either row producer, so it skipped the boundary that the two producers go
   * through. It is checksummed today only because
   * `computeHybridAccountAddress` happens to write it that way — every lookup
   * is `LOWER(account_address) = LOWER($2)`, so nothing enforces it.
   *
   * The failure this pins: one account row stored lowercase (a backfill, an
   * import, a manual fix) puts that account's explorer rows' lowercase
   * `accountAddress` in the SAME response as its x402 rows' checksummed one —
   * the issue's exact defect, one field over.
   */
  it('canonicalises an accountAddress the database stored lowercase', async () => {
    mockFindConfirmedX402PaymentIntents.mockResolvedValue([])
    mockFetchNormal.mockResolvedValue({
      rows: [
        {
          blockNumber: '31340',
          timeStamp: '1758189900',
          hash: '0x' + '02'.repeat(32),
          from: ACCOUNT.toLowerCase(),
          to: MERCHANT.toLowerCase(),
          value: '9',
          gas: '21000',
          gasUsed: '21000',
          isError: '0',
          functionName: '',
        },
      ],
      hasMore: false,
    })
    mockFetchInternal.mockResolvedValue({ rows: [], hasMore: false })
    mockFetchERC20.mockResolvedValue({ rows: [], hasMore: false })

    const { aggregateAccountTransactions } = await import('../orchestration.js')
    const { merged: transactions } = await aggregateAccountTransactions(
      [
        {
          id: 'account-1',
          // The form nothing prevents the column from holding.
          account_address: ACCOUNT.toLowerCase(),
          chain_id: CHAIN_ID,
          name: 'Main',
        },
      ],
      logStub,
      true,
    )

    expect(transactions.length).toBeGreaterThan(0)
    expect(transactions[0].accountAddress).toBe(ACCOUNT)
    expectEveryAddressCanonical(transactions[0] as unknown as Record<string, unknown>)
  })

  /**
   * The per-account page is the SECOND assembly point, and there the address
   * is the URL path parameter — so its casing is whatever the caller typed,
   * not merely whatever the column holds.
   */
  it('canonicalises an accountAddress that arrived as a URL path parameter', async () => {
    mockFindConfirmedX402PaymentIntents.mockResolvedValue([])
    mockFetchNormal.mockResolvedValue({
      rows: [
        {
          blockNumber: '31341',
          timeStamp: '1758190000',
          hash: '0x' + '03'.repeat(32),
          from: ACCOUNT.toLowerCase(),
          to: MERCHANT.toLowerCase(),
          value: '11',
          gas: '21000',
          gasUsed: '21000',
          isError: '0',
          functionName: '',
        },
      ],
      hasMore: false,
    })
    mockFetchInternal.mockResolvedValue({ rows: [], hasMore: false })
    mockFetchERC20.mockResolvedValue({ rows: [], hasMore: false })

    const { buildAccountTransactionsPage } = await import('../orchestration.js')
    const page = await buildAccountTransactionsPage({
      userId: 'user-1',
      accountId: 'account-1',
      // The form a caller can put in the URL.
      accountAddress: ACCOUNT.toLowerCase(),
      chainId: CHAIN_ID,
      log: logStub,
      fresh: true,
      page: 1,
      limit: 10,
    })

    expect(page.transactions.length).toBeGreaterThan(0)
    expect(page.transactions[0].accountAddress).toBe(ACCOUNT)
    expectEveryAddressCanonical(page.transactions[0] as unknown as Record<string, unknown>)
  })
})
