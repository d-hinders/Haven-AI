/**
 * #2097 — `initiatedBy` dedup-guard regression tests.
 *
 * The x402 source query INNER-JOINs `agents`, so a confirmed x402 intent row
 * is agent-attributed by construction, while the SAME on-chain transfer also
 * shows up as a raw explorer / Safe-service transfer with no agent linkage.
 * The multi-Safe `mergeSortDedupeAndEnrich` and the per-Safe
 * `buildSafeTransactionsPage` are the two pipelines that must collapse the
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
import type { EnrichedTransaction } from '../types.js'

const USER_SAFE = {
  id: 'safe-1',
  safe_address: '0xsafe',
  chain_id: 8453,
  name: 'Main',
}

interface RepoMockOptions {
  x402Rows?: X402PaymentIntentRow[]
  piRows?: PaymentIntentAgentRow[]
  sweepRows?: DelegateSweepAgentRow[]
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
  blockNumber: 21_000_000,
  isError: false,
  tokenAddress: '0xusdc',
  tokenSymbol: 'USDC',
}

/** Confirmed x402 intent row returned by `findConfirmedX402PaymentIntents`. */
const X402_ROW: X402PaymentIntentRow = {
  id: 'pi-1',
  tx_hash: '0xabc',
  agent_id: 'agent-1',
  agent_name: 'Alice',
  safe_id: 'safe-1',
  safe_address: '0xsafe',
  safe_name: 'Main',
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
  settlement_scheme: 'eip3009',
  confirmed_at: '2026-08-01T00:00:00.000Z',
  created_at: '2026-08-01T00:00:00.000Z',
}

/** Enrichment-match payment intent (matched by hash + safe + chain). */
const PI_ROW: PaymentIntentAgentRow = {
  id: 'pi-2',
  tx_hash: '0xmatched',
  safe_id: 'safe-1',
  chain_id: 8453,
  agent_id: 'agent-2',
  agent_name: 'Bob',
  source: 'x402',
  payment_resource_url: null,
  merchant_address: null,
  payment_proof_status: 'payment_confirmed',
  payment_reconciliation_event_type: null,
  amount_sek: null,
}

/** Delegate-sweep attribution row returned by `findDelegateSweepAgentMatches`. */
const SWEEP_ROW: DelegateSweepAgentRow = {
  id: 'sweep-1',
  tx_hash: '0xsweep',
  safe_id: 'safe-1',
  chain_id: 8453,
  agent_id: 'agent-3',
  agent_name: 'Carol',
  from_address: '0xdelegate',
  to_address: '0xsafe',
}

/** Raw transaction shape before the aggregation step tags Safe scope on it. */
type RawTx = Omit<
  EnrichedTransaction,
  'chainId' | 'safeId' | 'safeAddress' | 'safeName' | 'agentId' | 'agentName'
>

/** Tag a raw transaction with the Safe scope the aggregation step adds. */
function withSafe(tx: RawTx): EnrichedTransaction {
  return {
    ...tx,
    chainId: 8453,
    safeId: 'safe-1',
    safeAddress: '0xsafe',
    safeName: 'Main',
  }
}

const log = { warn: vi.fn() } as unknown as FastifyBaseLogger

function mockModules({ x402Rows = [], piRows = [], sweepRows = [] }: RepoMockOptions) {
  vi.resetModules()
  vi.doMock('../../../infra/repositories/transaction-history.js', () => ({
    findConfirmedX402PaymentIntents: vi.fn().mockResolvedValue(x402Rows),
    findPaymentIntentAgentMatches: vi.fn().mockResolvedValue(piRows),
    findDelegateSweepAgentMatches: vi.fn().mockResolvedValue(sweepRows),
    listBasicSafesForUser: vi.fn(),
    listAgentsForTransactionFilters: vi.fn(),
    findSafeOwnership: vi.fn(),
    findMachinePaymentEvidenceDetail: vi.fn(),
  }))
  vi.doMock('../aggregate.js', () => ({
    fetchSafeTransactions: vi.fn().mockResolvedValue({
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

    const { buildSafeTransactionsPage } = await import('../orchestration.js')
    const page = await buildSafeTransactionsPage({
      userId: 'user-1',
      safeId: 'safe-1',
      safeAddress: '0xsafe',
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
