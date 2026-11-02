import { describe, expect, it } from 'vitest'
import type { PaymentActivityItem } from '@/hooks/useAgentActivity'
import { transactionRowBadge } from '@/lib/transaction-presentation'
import { activityToTransaction } from '../AgentActivityTab'

/**
 * #4267: the agent feed's eip3009 legs reach the shared detail panel by name,
 * so an agent-tab row with a recorded settlement reads "Settled (verified)"
 * (#4320) and lists both transactions, exactly as on /transactions. The
 * activity read's snake_case settlement state maps to the wire's camelCase
 * fields here (#4319).
 */
const FUNDING = `0x${'cd'.repeat(32)}`
const SETTLEMENT = `0x${'ef'.repeat(32)}`

function item(overrides: Partial<PaymentActivityItem> = {}): PaymentActivityItem {
  return {
    type: 'payment',
    id: 'pay-1',
    token: 'USDC',
    amount: '1.00',
    to: '0x2222222222222222222222222222222222222222',
    status: 'confirmed',
    tx_hash: FUNDING,
    funding_tx_hash: FUNDING,
    settlement_tx_hash: SETTLEMENT,
    settlement_scheme: 'eip3009',
    source: 'x402',
    chain_id: 8453,
    explorer_url: `https://basescan.org/tx/${SETTLEMENT}`,
    created_at: '2026-10-22T12:00:00Z',
    ...overrides,
  }
}

describe('activityToTransaction — the eip3009 legs (#4267)', () => {
  it('carries the scheme and both hashes onto the row', () => {
    const row = activityToTransaction(item(), 'Atlas', 'Main')
    expect(row.settlementScheme).toBe('eip3009')
    expect(row.settlementTxHash).toBe(SETTLEMENT)
    expect(row.fundingTxHash).toBe(FUNDING)
  })

  it('maps the snake_case settlement state to the wire fields (#4320)', () => {
    const row = activityToTransaction(
      item({ settlement_tracking: 'verified', settlement_proof: 'receipt' }),
      'Atlas',
      'Main',
    )
    expect(row.settlementTracking).toBe('verified')
    expect(row.settlementProof).toBe('receipt')
    // Absent on an older backend's payload — never an invented state.
    const bare = activityToTransaction(item({ settlement_tracking: undefined }), 'Atlas', 'Main')
    expect(bare.settlementTracking).toBeNull()
    expect(bare.settlementProof).toBeNull()
  })

  it('carries erc7710 too — one transaction, so no settlement hash', () => {
    const row = activityToTransaction(
      item({ settlement_scheme: 'erc7710', settlement_tx_hash: null, funding_tx_hash: null }),
      'Atlas',
      'Main',
    )
    expect(row.settlementScheme).toBe('erc7710')
  })

  it('maps an unknown scheme to null and absent hashes to null', () => {
    const row = activityToTransaction(
      item({ settlement_scheme: 'something-new', settlement_tx_hash: undefined, funding_tx_hash: undefined }),
      'Atlas',
      'Main',
    )
    expect(row.settlementScheme).toBeNull()
    expect(row.settlementTxHash).toBeNull()
    expect(row.fundingTxHash).toBeNull()
  })
})

/**
 * #4608 (owner decision 2026-11-02): an agent Activity row carries NO badge
 * for a confirmed payment, like Transactions — the epic's ledger-row rule
 * wins over DS:886's "Sent everywhere" on rows. The detail panel keeps
 * "Sent" through its own fallback, which `TransactionDetailPanel.test.tsx`
 * pins on the rendered word.
 */
describe('activityToTransaction — a confirmed row carries no badge (#4608)', () => {
  it('leaves statusBadge off a confirmed payment, so the row renders no badge', () => {
    const row = activityToTransaction(item({ status: 'confirmed' }), 'Atlas', 'Main')
    expect(row.statusBadge).toBeUndefined()
    // The shared precedence finds nothing to render: the row is badge-less.
    expect(transactionRowBadge(row)).toBeNull()
  })

  it('keeps the badge on every other status', () => {
    expect(activityToTransaction(item({ status: 'pending_signature' }), 'Atlas', 'Main').statusBadge).toEqual({
      label: 'Awaiting signature',
      tone: 'brand',
    })
    expect(activityToTransaction(item({ status: 'submitted' }), 'Atlas', 'Main').statusBadge).toEqual({
      label: 'Submitted',
      tone: 'brand',
    })
    expect(activityToTransaction(item({ status: 'failed' }), 'Atlas', 'Main').statusBadge).toEqual({
      label: 'Failed',
      tone: 'danger',
    })
    expect(activityToTransaction(item({ status: 'expired' }), 'Atlas', 'Main').statusBadge).toEqual({
      label: 'Expired',
      tone: 'neutral',
    })
  })

  it('still resolves to "Sent" in the detail panel — its fallback, not the row', () => {
    const row = activityToTransaction(item({ status: 'confirmed' }), 'Atlas', 'Main')
    // `TransactionDetailPanel.tsx:286`:
    //   transactionRowBadge(tx) ?? { label: 'Sent', tone: 'success' }
    // The row contributes nothing, so the panel's own word is what shows.
    expect(transactionRowBadge(row) ?? { label: 'Sent', tone: 'success' }).toEqual({
      label: 'Sent',
      tone: 'success',
    })
  })
})
