/**
 * #3132 — the two silent fallbacks on the x402-synthesized row, fixed with
 * one pattern: mark the substitution, do not hide it.
 *
 * - `paymentProofStatus` arrives through a LEFT JOIN; with no evidence row it
 *   is recorded as NOTHING, and the row now says null instead of the
 *   placeholder 'payment_confirmed' (enrichment.ts always passed the column
 *   through — one endpoint, one behaviour).
 * - `timestamp` keeps its `confirmed_at ?? created_at` sort-key fallback but
 *   `timestampSource` names the column that produced it and `confirmedAt`
 *   carries the recorded (nullable) confirmation time.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ethers } from 'ethers'

const mockFindConfirmedX402PaymentIntents = vi.fn()

vi.mock('../../../infra/repositories/transaction-history.js', () => ({
  findConfirmedX402PaymentIntents: mockFindConfirmedX402PaymentIntents,
}))

const { fetchConfirmedX402Transactions } = await import('../x402.js')

const CHAIN_ID = 8453
const ACCOUNT = ethers.getAddress('0xab5801a7d398351b8be11c439e05c5b3259aec9b')
const MERCHANT = ethers.getAddress('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
const USDC = ethers.getAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
const SAFES = [{ id: 'account-1', account_address: ACCOUNT, chain_id: CHAIN_ID, name: 'Main' }]

function intentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'intent-1',
    tx_hash: '0x' + 'ab'.repeat(32),
    agent_id: 'agent-1',
    agent_name: 'Buyer',
    account_id: 'account-1',
    account_address: ACCOUNT,
    account_name: 'Main',
    chain_id: CHAIN_ID,
    token_symbol: 'USDC',
    token_address: USDC,
    to_address: MERCHANT,
    amount_raw: '1000000',
    amount_human: '1.00',
    x402_merchant_address: MERCHANT,
    x402_resource_url: 'https://merchant.example/resource',
    payment_proof_status: 'protocol_receipt_attached',
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

beforeEach(() => {
  vi.clearAllMocks()
})

describe('proof status is recorded or null, never a placeholder (#3132)', () => {
  it('a confirmed payment with NO evidence row reports no proof status — and the flow status it always had', async () => {
    mockFindConfirmedX402PaymentIntents.mockResolvedValue([intentRow({ payment_proof_status: null })])
    const [row] = await fetchConfirmedX402Transactions('user-1', SAFES)
    expect(row.paymentProofStatus).toBeNull()
    // The lifecycle landed on confirming_merchant for the placeholder too, so
    // fixing the fabricated field moves no flow status.
    expect(row.paymentFlowStatus).toBe('confirming_merchant')
    expect(row.paymentAttentionReason).toBeNull()
  })

  it('a recorded proof status is passed through unchanged and still drives the lifecycle', async () => {
    mockFindConfirmedX402PaymentIntents.mockResolvedValue([intentRow()])
    const [row] = await fetchConfirmedX402Transactions('user-1', SAFES)
    expect(row.paymentProofStatus).toBe('protocol_receipt_attached')
    expect(row.paymentFlowStatus).toBe('paid')
  })
})

describe('the timestamp fallback is marked, not hidden (#3132)', () => {
  it('with a confirmation time: timestamp is it, timestampSource says so, confirmedAt carries it', async () => {
    mockFindConfirmedX402PaymentIntents.mockResolvedValue([intentRow()])
    const [row] = await fetchConfirmedX402Transactions('user-1', SAFES)
    expect(row.timestamp).toBe(Math.floor(Date.parse('2026-09-18T10:00:00.000Z') / 1000))
    expect(row.timestampSource).toBe('confirmed_at')
    expect(row.confirmedAt).toBe('2026-09-18T10:00:00.000Z')
  })

  it('without one: timestamp falls back to created_at, timestampSource SAYS created_at, confirmedAt is null — the receipts view\'s value', async () => {
    mockFindConfirmedX402PaymentIntents.mockResolvedValue([intentRow({ confirmed_at: null })])
    const [row] = await fetchConfirmedX402Transactions('user-1', SAFES)
    expect(row.timestamp).toBe(Math.floor(Date.parse('2026-09-18T09:59:00.000Z') / 1000))
    expect(row.timestampSource).toBe('created_at')
    expect(row.confirmedAt).toBeNull()
  })

  it('the source restates the query\'s own predicate: a synthesized row is source x402 by construction', async () => {
    mockFindConfirmedX402PaymentIntents.mockResolvedValue([intentRow()])
    const [row] = await fetchConfirmedX402Transactions('user-1', SAFES)
    expect(row.source).toBe('x402')
  })
})
