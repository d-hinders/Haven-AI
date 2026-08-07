/**
 * #716 (epic #713): post-settlement delegate reconciliation. After a settle
 * proof, standard-x402 funding should have LEFT the delegate — a balance at or
 * above THIS payment's amount is flagged as a reconciliation event at payment
 * time instead of being discovered by the sweep later.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockQuery, mockGetTokenBalance } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetTokenBalance: vi.fn(),
}))

vi.mock('../../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))
vi.mock('../../../lib/allowance-module.js', () => ({
  getTokenBalance: (...a: unknown[]) => mockGetTokenBalance(...a),
}))
vi.mock('../../../lib/fiat-values.js', () => ({ getBookTimeSekValue: vi.fn() }))
vi.mock('../../../lib/fee/fee-module.js', () => ({ quoteFee: vi.fn(), recordSettledFee: vi.fn() }))
vi.mock('../../../lib/reporting/feed-orchestrator.js', () => ({ feedSettledPaymentBestEffort: vi.fn() }))

const { reconcileDelegateResidueAfterSettlement } = await import('../evidence.js')

const AGENT_ID = '11111111-1111-1111-1111-111111111111'
const DELEGATE = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1'

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'intent-1',
    agent_id: AGENT_ID,
    user_id: '22222222-2222-2222-2222-222222222222',
    safe_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
    chain_id: 8453,
    token_symbol: 'USDC',
    token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    to_address: DELEGATE.toLowerCase(), // standard x402: funding goes to the delegate
    amount_raw: '20000',
    amount_human: '0.02',
    tx_hash: `0x${'ab'.repeat(32)}`,
    status: 'confirmed',
    payment_rail: 'x402',
    payment_resource_url: 'https://merchant.example/data',
    x402_resource_url: 'https://merchant.example/data',
    merchant_address: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
    ...overrides,
  } as never
}

beforeEach(() => {
  mockQuery.mockReset()
  mockGetTokenBalance.mockReset()
})

describe('reconcileDelegateResidueAfterSettlement (#716)', () => {
  it('flags residue when the delegate still holds at least the funded amount', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ delegate_address: DELEGATE }] })
      .mockResolvedValueOnce({ rows: [] }) // event INSERT
    mockGetTokenBalance.mockResolvedValueOnce(25_000n) // ≥ 20000 funded

    await reconcileDelegateResidueAfterSettlement(payment(), AGENT_ID)

    const insert = mockQuery.mock.calls.find(([sql]) =>
      /INSERT INTO machine_payment_reconciliation_events/.test(sql as string),
    )
    expect(insert).toBeDefined()
    expect(insert![0]).toContain("'delegate_residue_after_settlement'")
    expect(insert![0]).toContain('ON CONFLICT (payment_intent_id, event_type)')
    const details = JSON.parse(insert![1][8] as string)
    expect(details).toMatchObject({
      observed_balance_atomic: '25000',
      payment_amount_raw: '20000',
      delegate_address: DELEGATE,
    })
  })

  it('stays silent below the payment amount — ambient dust is the #714 monitor’s job', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ delegate_address: DELEGATE }] })
    mockGetTokenBalance.mockResolvedValueOnce(19_999n)

    await reconcileDelegateResidueAfterSettlement(payment(), AGENT_ID)
    expect(mockQuery.mock.calls).toHaveLength(1) // only the delegate lookup
  })

  it('never reads balances that are not ours: merchant-direct payTo is skipped', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ delegate_address: DELEGATE }] })

    await reconcileDelegateResidueAfterSettlement(
      payment({ to_address: '0x15179876c595922999C2d5DC7c23Cc7711fE799a' }),
      AGENT_ID,
    )
    expect(mockGetTokenBalance).not.toHaveBeenCalled()
  })
})
