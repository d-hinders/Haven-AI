/**
 * #2097 — `initiatedBy` dedup-guard regression tests.
 *
 * The x402 source query INNER-JOINs `agents`, so a confirmed x402 intent row
 * is agent-attributed by construction, while the SAME on-chain transfer also
 * shows up as a raw explorer / Safe-service transfer with no agent linkage.
 * The multi-Safe `mergeSortDedupeAndEnrich` and the per-Safe
 * `buildAccountTransactionsPage` are the two pipelines that must collapse the
 * twin into exactly ONE row — the attributed x402 one.
 *
 * These tests mock the repository boundary (the pipeline's collaborator)
 * exactly like the existing `orchestration.test.ts` does for `aggregate.js`:
 * the assertion here is about pipeline merge/dedupe/classification behavior,
 * not about what Postgres returns — SQL truth stays covered by the real-DB
 * repository suite.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyBaseLogger } from 'fastify'
import type {
  DelegateSweepAgentRow,
  PaymentIntentAgentRow,
  X402PaymentIntentRow,
} from '../../../infra/repositories/transaction-history.js'
import type { OwnerTransferMatchRow } from '../../../infra/repositories/owner-transfers.js'
import type { EnrichedTransaction } from '../types.js'

const USER_SAFE = {
  id: 'safe-1',
  account_address: '0xsafe',
  chain_id: 8453,
  name: 'Main',
}

interface RepoMockOptions {
  x402Rows?: X402PaymentIntentRow[]
  piRows?: PaymentIntentAgentRow[]
  sweepRows?: DelegateSweepAgentRow[]
  /** #4099 — owner sends recorded at submit; `Error` makes the read reject. */
  ownerRows?: OwnerTransferMatchRow[] | Error
}

/** Raw explorer/Safe-service twin: the SAME tx as the x402 intent, no agent linkage. */
const RAW_TWIN = {
  hash: '0xabc',
  type: 'erc20' as const,
  from: '0xfrom',
  to: '0xmerchant',
  value: '1000000',
  valueFormatted: '1',
  asset: 'USDC',
  decimals: 6,
  direction: 'out' as const,
  timestamp: 1_752_470_400,
  timestampSource: 'block' as const,
  blockNumber: 21_000_000,
  isError: false,
  tokenAddress: '0xusdc',
  tokenSymbol: 'USDC',
}

/** Confirmed x402 intent row returned by `findConfirmedX402PaymentIntents`. */
const X402_ROW: X402PaymentIntentRow = {
  id: 'pi-1',
  tx_hash: '0xabc',
  delivery_reference: null,
  // #4319: the stored settlement proof state — defaults read as "nothing stored".
  settlement_proof_label: null,
  settlement_nonce_bound: null,
  settlement_nonce_derived: null,
  receipt_verdict: null,
  has_stored_header: false,
  agent_id: 'agent-1',
  agent_name: 'Alice',
  account_id: 'safe-1',
  account_address: '0xsafe',
  account_name: 'Main',
  chain_id: 8453,
  token_symbol: 'USDC',
  token_address: '0xusdc',
  to_address: '0xmerchant',
  amount_raw: '1000000',
  amount_human: '1',
  x402_merchant_address: null,
  x402_resource_url: null,
  payment_proof_status: 'payment_confirmed',
  payment_reconciliation_event_type: null,
  amount_sek: null,
  fx_rate_sek: null,
  fx_source: null,
  fx_rates: null,
  settlement_scheme: 'eip3009',
  // #3763: the SDK's default evidence post reports the FUNDING hash, so the
  // baseline row carries NO recorded settlement — null is the common case.
  settlement_tx_hash: null,
  confirmed_at: '2026-08-01T00:00:00.000Z',
  created_at: '2026-08-01T00:00:00.000Z',
}

/** The same payment with the merchant's settlement recorded (#3475 → #3763). */
const X402_ROW_SETTLED: X402PaymentIntentRow = {
  ...X402_ROW,
  settlement_tx_hash: `0x${'22'.repeat(32)}`,
}

/** Enrichment-match payment intent (matched by hash + account + chain). */
const PI_ROW: PaymentIntentAgentRow = {
  id: 'pi-2',
  tx_hash: '0xmatched',
  account_id: 'safe-1',
  chain_id: 8453,
  agent_id: 'agent-2',
  agent_name: 'Bob',
  source: 'x402',
  payment_resource_url: null,
  merchant_address: null,
  payment_proof_status: 'payment_confirmed',
  payment_reconciliation_event_type: null,
  amount_sek: null,
  fx_rate_sek: null,
  fx_source: null,
  fx_rates: null,
}

/** Delegate-sweep attribution row returned by `findDelegateSweepAgentMatches`. */
const SWEEP_ROW: DelegateSweepAgentRow = {
  id: 'sweep-1',
  tx_hash: '0xsweep',
  account_id: 'safe-1',
  chain_id: 8453,
  agent_id: 'agent-3',
  agent_name: 'Carol',
  from_address: '0xdelegate',
  to_address: '0xsafe',
}

/** Raw transaction shape before the aggregation step tags Safe scope on it. */
type RawTx = Omit<
  EnrichedTransaction,
  'chainId' | 'accountId' | 'accountAddress' | 'accountName' | 'agentId' | 'agentName'
>

/** Tag a raw transaction with the Safe scope the aggregation step adds. */
function withSafe(tx: RawTx): EnrichedTransaction {
  return {
    ...tx,
    chainId: 8453,
    accountId: 'safe-1',
    accountAddress: '0xsafe',
    accountName: 'Main',
  }
}

const log = { warn: vi.fn() } as unknown as FastifyBaseLogger

function mockModules({ x402Rows = [], piRows = [], sweepRows = [], ownerRows = [] }: RepoMockOptions) {
  vi.resetModules()
  vi.doMock('../../../infra/repositories/owner-transfers.js', () => ({
    findOwnerTransferMatches:
      ownerRows instanceof Error
        ? vi.fn().mockRejectedValue(ownerRows)
        : vi.fn().mockResolvedValue(ownerRows),
  }))
  vi.doMock('../../../infra/repositories/transaction-history.js', () => ({
    findConfirmedX402PaymentIntents: vi.fn().mockResolvedValue(x402Rows),
    findPaymentIntentAgentMatches: vi.fn().mockResolvedValue(piRows),
    findDelegateSweepAgentMatches: vi.fn().mockResolvedValue(sweepRows),
    listBasicAccountsForUser: vi.fn(),
    listAgentsForTransactionFilters: vi.fn(),
    findAccountOwnership: vi.fn(),
    findMachinePaymentEvidenceDetail: vi.fn(),
  }))
  vi.doMock('../aggregate.js', () => ({
    fetchAccountTransactions: vi.fn().mockResolvedValue({
      transactions: [RAW_TWIN],
      hadFailures: false,
    }),
  }))
}

describe('initiatedBy dedup guard (#2097)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('multi-Safe feed: x402 intent + raw twin collapse to ONE attributed row (initiatedBy=agent)', async () => {
    mockModules({ x402Rows: [X402_ROW] })

    const { mergeSortDedupeAndEnrich } = await import('../orchestration.js')
    const merged = [withSafe(RAW_TWIN)]

    const result = await mergeSortDedupeAndEnrich('user-1', [USER_SAFE], merged)

    const rowsForHash = result.filter((tx) => tx.hash === '0xabc')
    expect(rowsForHash).toHaveLength(1)
    // The survivor is the attributed x402 row (from = Safe address), not the
    // raw twin (from = counterparty) — the x402 merge removes the twin before
    // dedupe, and the identity-key dedupe would collapse them anyway.
    expect(rowsForHash[0]).toMatchObject({
      from: '0xsafe',
      agentId: 'agent-1',
      agentName: 'Alice',
      initiatedBy: 'agent',
      source: 'x402',
    })
  })

  it('per-Safe page: x402 intent + raw twin collapse to ONE attributed row (initiatedBy=agent)', async () => {
    mockModules({ x402Rows: [X402_ROW] })

    const { buildAccountTransactionsPage } = await import('../orchestration.js')
    const page = await buildAccountTransactionsPage({
      userId: 'user-1',
      accountId: 'safe-1',
      accountAddress: '0xsafe',
      chainId: 8453,
      log,
      fresh: false,
      page: 1,
      limit: 10,
    })

    const rowsForHash = page.transactions.filter((tx) => tx.hash === '0xabc')
    expect(rowsForHash).toHaveLength(1)
    expect(page.transactions).toHaveLength(1)
    expect(rowsForHash[0]).toMatchObject({
      from: '0xsafe',
      agentId: 'agent-1',
      agentName: 'Alice',
      initiatedBy: 'agent',
    })
  })

  it('#3763: an eip3009 row WITH a recorded settlement still collapses to ONE row, carrying both legs', async () => {
    mockModules({ x402Rows: [X402_ROW_SETTLED] })

    const { mergeSortDedupeAndEnrich } = await import('../orchestration.js')
    const merged = [withSafe(RAW_TWIN)]

    const result = await mergeSortDedupeAndEnrich('user-1', [USER_SAFE], merged)

    // The recorded settlement must NOT break the twin collapse: the funding
    // hash still keys the identity, so the raw explorer twin and the x402
    // row are ONE row — the settlement does not split the payment in two.
    const rowsForHash = result.filter((tx) => tx.hash === '0xabc')
    expect(rowsForHash).toHaveLength(1)
    expect(rowsForHash[0]).toMatchObject({
      // `hash` keeps its FUNDING meaning; the legs travel named.
      hash: '0xabc',
      fundingTxHash: '0xabc',
      settlementTxHash: `0x${'22'.repeat(32)}`,
      initiatedBy: 'agent',
      source: 'x402',
    })
    // And no second row exists for the settlement hash itself.
    expect(result.filter((tx) => tx.hash === X402_ROW_SETTLED.settlement_tx_hash)).toHaveLength(0)
  })

  it('enrichment classifies: matched outbound=agent, lone outbound=unknown, inbound=undefined', async () => {
    const rawMatched = withSafe({ ...RAW_TWIN, hash: '0xmatched' })
    const rawLone = withSafe({ ...RAW_TWIN, hash: '0xlone', from: '0xwallet', to: '0xsomeone' })
    const rawInbound = withSafe({
      ...RAW_TWIN,
      hash: '0xin',
      from: '0xsomeone',
      to: '0xsafe',
      direction: 'in',
    })
    mockModules({ x402Rows: [], piRows: [PI_ROW], sweepRows: [] })

    const { mergeSortDedupeAndEnrich } = await import('../orchestration.js')
    const result = await mergeSortDedupeAndEnrich(
      'user-1',
      [USER_SAFE],
      [rawMatched, rawLone, rawInbound],
    )

    const byHash = new Map(result.map((tx) => [tx.hash, tx]))
    // Enrichment matched `0xmatched` to PI_ROW: agent attribution + 'agent'.
    expect(byHash.get('0xmatched')).toMatchObject({
      agentId: 'agent-2',
      agentName: 'Bob',
      initiatedBy: 'agent',
    })
    // `0xlone` stayed unattributed: outbound raw transfer → 'unknown'.
    expect(byHash.get('0xlone')).toMatchObject({
      agentId: undefined,
      initiatedBy: 'unknown',
    })
    // `0xin` is inbound: no initiator record at all.
    expect(byHash.get('0xin')?.initiatedBy).toBeUndefined()
  })

  it('a delegate sweep row keeps its agent attribution and is initiatedBy=agent', async () => {
    const rawSweep = withSafe({ ...RAW_TWIN, hash: '0xsweep', from: '0xdelegate', to: '0xsafe' })
    mockModules({ x402Rows: [], piRows: [], sweepRows: [SWEEP_ROW] })

    const { mergeSortDedupeAndEnrich } = await import('../orchestration.js')
    const result = await mergeSortDedupeAndEnrich('user-1', [USER_SAFE], [rawSweep])

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      agentId: 'agent-3',
      agentName: 'Carol',
      activityType: 'delegate_sweep',
      initiatedBy: 'agent',
    })
  })
})

describe('owner sends read as the owner’s (#4099)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  /** The owner's send to their own second account, as the explorer lists it on the sender. */
  const ownerSend = () => withSafe({ ...RAW_TWIN, hash: '0xowner', from: '0xsafe', to: '0xreserve' })
  const OWNER_ROW: OwnerTransferMatchRow = {
    tx_hash: '0xowner',
    account_id: 'safe-1',
    chain_id: 8453,
    token_address: '0xUSDC',
    to_address: '0xRESERVE',
    amount_raw: '1000000',
  }

  it('a recorded owner send is initiatedBy=human, not unknown', async () => {
    mockModules({ ownerRows: [OWNER_ROW] })
    const { mergeSortDedupeAndEnrich } = await import('../orchestration.js')
    const [row] = await mergeSortDedupeAndEnrich('user-1', [USER_SAFE], [ownerSend()])
    expect(row).toMatchObject({ hash: '0xowner', agentId: undefined, initiatedBy: 'human' })
  })

  it('an owner send with no record — every send before #4099 — stays unknown; no heuristic claims it', async () => {
    // Same shape as a real owner send: outbound, from the owner's own
    // account, to another account the owner holds. Without a record it is
    // indistinguishable from any unattributed transfer, and must say so.
    mockModules({ ownerRows: [] })
    const { mergeSortDedupeAndEnrich } = await import('../orchestration.js')
    const [row] = await mergeSortDedupeAndEnrich('user-1', [USER_SAFE], [ownerSend()])
    expect(row.initiatedBy).toBe('unknown')
  })

  it('a record matches only its own (hash, account, chain): another account or chain stays unknown', async () => {
    mockModules({
      ownerRows: [
        { ...OWNER_ROW, account_id: 'safe-2' },
        { ...OWNER_ROW, chain_id: 84532 },
      ],
    })
    const { mergeSortDedupeAndEnrich } = await import('../orchestration.js')
    const [row] = await mergeSortDedupeAndEnrich('user-1', [USER_SAFE], [ownerSend()])
    expect(row.initiatedBy).toBe('unknown')
  })

  it('the receiving side of an own-account transfer is inbound and carries no initiator', async () => {
    mockModules({ ownerRows: [OWNER_ROW] })
    const { mergeSortDedupeAndEnrich } = await import('../orchestration.js')
    const inbound = withSafe({ ...RAW_TWIN, hash: '0xowner', from: '0xother', to: '0xsafe', direction: 'in' })
    const [row] = await mergeSortDedupeAndEnrich('user-1', [USER_SAFE], [inbound])
    expect(row.initiatedBy).toBeUndefined()
  })

  it('only the owner’s own transfer in a shared tx reads human — a bundled agent spend stays unknown (Antonio, review 2)', async () => {
    // One bundler transaction, two outbound transfers from the same account:
    // the owner's send to the reserve, and an agent redemption to a merchant
    // with no matched intent. Same hash, same account, same chain.
    mockModules({ ownerRows: [OWNER_ROW] })
    const { mergeSortDedupeAndEnrich } = await import('../orchestration.js')
    const agentSpend = withSafe({ ...RAW_TWIN, hash: '0xowner', from: '0xsafe', to: '0xmerchant', value: '2500000' })
    const result = await mergeSortDedupeAndEnrich('user-1', [USER_SAFE], [ownerSend(), agentSpend])
    const byTo = new Map(result.map((tx) => [tx.to, tx.initiatedBy]))
    expect(byTo.get('0xreserve')).toBe('human')
    expect(byTo.get('0xmerchant')).toBe('unknown')
  })

  it('a record whose token, recipient or amount differs from the row does not match', async () => {
    for (const mismatch of [
      { token_address: '0xother' },
      { to_address: '0xelsewhere' },
      { amount_raw: '999999' },
    ]) {
      mockModules({ ownerRows: [{ ...OWNER_ROW, ...mismatch }] })
      const { mergeSortDedupeAndEnrich } = await import('../orchestration.js')
      const [row] = await mergeSortDedupeAndEnrich('user-1', [USER_SAFE], [ownerSend()])
      expect(row.initiatedBy).toBe('unknown')
    }
  })

  it('agent attribution wins over an owner record on the same row', async () => {
    mockModules({
      piRows: [PI_ROW],
      ownerRows: [{ ...OWNER_ROW, tx_hash: '0xmatched', to_address: '0xmerchant' }],
    })
    const { mergeSortDedupeAndEnrich } = await import('../orchestration.js')
    const [row] = await mergeSortDedupeAndEnrich('user-1', [USER_SAFE], [withSafe({ ...RAW_TWIN, hash: '0xmatched' })])
    expect(row).toMatchObject({ agentId: 'agent-2', initiatedBy: 'agent' })
  })

  it('a failed owner-record read leaves the row unknown and keeps the agent attribution', async () => {
    mockModules({ piRows: [PI_ROW], ownerRows: new Error('db down') })
    const { mergeSortDedupeAndEnrich } = await import('../orchestration.js')
    const result = await mergeSortDedupeAndEnrich('user-1', [USER_SAFE], [
      ownerSend(),
      withSafe({ ...RAW_TWIN, hash: '0xmatched' }),
    ])
    const byHash = new Map(result.map((tx) => [tx.hash, tx]))
    expect(byHash.get('0xowner')?.initiatedBy).toBe('unknown')
    expect(byHash.get('0xmatched')).toMatchObject({ agentId: 'agent-2', initiatedBy: 'agent' })
  })
})
