import { describe, expect, it } from 'vitest'
import type { DelegationBudget } from '@/hooks/useDelegationBudget'
import {
  findOccupyingBudget,
  isReplacedButEnabled,
  occupiesSlot,
  replacedButEnabledBudgets,
} from '../budget-slot'

const NOW = 1_800_000_000
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const PAY_TO = '0x' + 'f0'.repeat(20)

function row(overrides: Partial<DelegationBudget> = {}): DelegationBudget {
  return {
    id: 'b1',
    token_address: USDC,
    recipient_address: null,
    delegation_hash: '0x' + 'ab'.repeat(32),
    version: 1,
    status: 'active',
    budget_atomic: '5000000',
    period_seconds: 86_400,
    expires_at: NOW + 3600,
    start_date: String(NOW - 60),
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  }
}

/**
 * #3933: the replaced-but-enabled predicate is ROW-LEVEL — `replaced` and
 * unexpired — and never `live_delegation_count`, which also counts unsigned
 * `pending` rows and expired rows.
 */
describe('isReplacedButEnabled', () => {
  it('is true for a replaced row that has not expired', () => {
    expect(isReplacedButEnabled(row({ status: 'replaced' }), NOW)).toBe(true)
  })

  it('is false for a replaced row that has expired — expiry ends it on-chain', () => {
    expect(isReplacedButEnabled(row({ status: 'replaced', expires_at: NOW - 1 }), NOW)).toBe(false)
    // The boundary: expiring exactly now is expired.
    expect(isReplacedButEnabled(row({ status: 'replaced', expires_at: NOW }), NOW)).toBe(false)
  })

  it('is false for active, revoked and pending rows, however far their expiry', () => {
    for (const status of ['active', 'revoked', 'pending'] as const) {
      expect(isReplacedButEnabled(row({ status, expires_at: NOW + 999_999 }), NOW)).toBe(false)
    }
  })
})

describe('replacedButEnabledBudgets', () => {
  it('keeps only the replaced, unexpired rows', () => {
    const keep = row({ status: 'replaced', delegation_hash: '0x01' })
    const rows = [
      row({ status: 'active', delegation_hash: '0x02' }),
      keep,
      row({ status: 'replaced', expires_at: NOW - 10, delegation_hash: '0x03' }),
      row({ status: 'revoked', delegation_hash: '0x04' }),
      row({ status: 'pending', delegation_hash: '0x05' }),
    ]
    expect(replacedButEnabledBudgets(rows, NOW)).toEqual([keep])
  })

  it('is empty for a list that has not loaded', () => {
    expect(replacedButEnabledBudgets(null, NOW)).toEqual([])
  })
})

/** #3933: the backend's occupancy rule — active AND unexpired. */
describe('occupiesSlot', () => {
  it('active and unexpired occupies; expired, replaced, revoked and pending do not', () => {
    expect(occupiesSlot(row(), NOW)).toBe(true)
    expect(occupiesSlot(row({ expires_at: NOW - 1 }), NOW)).toBe(false)
    for (const status of ['replaced', 'revoked', 'pending'] as const) {
      expect(occupiesSlot(row({ status }), NOW)).toBe(false)
    }
  })
})

describe('findOccupyingBudget', () => {
  it('matches the (token, recipient) slot case-insensitively', () => {
    const pinned = row({ recipient_address: PAY_TO.toUpperCase().replace('0X', '0x') })
    expect(findOccupyingBudget([pinned], { tokenAddress: USDC.toLowerCase(), recipientAddress: PAY_TO }, NOW)).toBe(pinned)
  })

  it('an open slot matches only an open row, and a pinned slot only its recipient', () => {
    const open = row({ recipient_address: null, delegation_hash: '0x01' })
    const pinned = row({ recipient_address: PAY_TO, delegation_hash: '0x02' })
    expect(findOccupyingBudget([pinned, open], { tokenAddress: USDC, recipientAddress: null }, NOW)).toBe(open)
    expect(findOccupyingBudget([open, pinned], { tokenAddress: USDC, recipientAddress: PAY_TO }, NOW)).toBe(pinned)
    expect(findOccupyingBudget([open], { tokenAddress: USDC, recipientAddress: PAY_TO }, NOW)).toBeNull()
  })

  it('a different token is a different slot', () => {
    expect(findOccupyingBudget([row()], { tokenAddress: '0x' + '77'.repeat(20) }, NOW)).toBeNull()
  })

  it('an expired or non-active row does not occupy the slot', () => {
    expect(findOccupyingBudget([row({ expires_at: NOW - 1 })], { tokenAddress: USDC }, NOW)).toBeNull()
    expect(findOccupyingBudget([row({ status: 'replaced' })], { tokenAddress: USDC }, NOW)).toBeNull()
  })

  it('with several live rows in one slot (a re-key pair), the newest wins, like the backend', () => {
    const older = row({ delegation_hash: '0x01', created_at: '2026-09-01T00:00:00Z' })
    const newer = row({ delegation_hash: '0x02', created_at: '2026-09-02T00:00:00Z' })
    expect(findOccupyingBudget([older, newer], { tokenAddress: USDC }, NOW)).toBe(newer)
    expect(findOccupyingBudget([newer, older], { tokenAddress: USDC }, NOW)).toBe(newer)
  })
})
