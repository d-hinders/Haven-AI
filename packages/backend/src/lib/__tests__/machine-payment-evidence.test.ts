import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  recordMachinePaymentEvidenceBase,
  type MachinePaymentEvidenceSource,
} from '../machine-payment-evidence.js'

const {
  mockQuery,
  mockGetBookTimeSekValue,
  mockRecordSettledFee,
  mockFeedSettledPaymentBestEffort,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetBookTimeSekValue: vi.fn(),
  mockRecordSettledFee: vi.fn(),
  mockFeedSettledPaymentBestEffort: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../fiat-values.js', () => ({
  getBookTimeSekValue: (...args: unknown[]) => mockGetBookTimeSekValue(...args),
}))

vi.mock('../fee/fee-module.js', () => ({
  quoteFee: vi.fn((input) => ({
    paymentId: input.paymentId,
    rail: input.rail,
    grossAtomic: input.grossAtomic,
    token: input.token,
    userId: input.userId,
    feeAtomic: 0n,
    feeToken: input.token,
    basisPoints: 0,
    isZero: true,
  })),
  recordSettledFee: (...args: unknown[]) => mockRecordSettledFee(...args),
}))

vi.mock('../reporting/feed-orchestrator.js', () => ({
  feedSettledPaymentBestEffort: (...args: unknown[]) => mockFeedSettledPaymentBestEffort(...args),
}))

const TX_HASH = `0x${'ab'.repeat(32)}`

function payment(overrides: Partial<MachinePaymentEvidenceSource> = {}): MachinePaymentEvidenceSource {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    kind: 'payment_intent',
    agent_id: '11111111-1111-1111-1111-111111111111',
    user_id: '22222222-2222-2222-2222-222222222222',
    safe_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
    chain_id: 8453,
    token_symbol: 'USDC',
    token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    to_address: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
    amount_raw: '12500000',
    amount_human: '12.5',
    tx_hash: TX_HASH,
    status: 'confirmed',
    source: 'x402',
    payment_rail: 'x402',
    payment_resource_url: 'https://merchant.example/data',
    x402_resource_url: null,
    merchant_address: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
    x402_merchant_address: null,
    machine_challenge_id: 'challenge-123',
    machine_idempotency_key: 'mpp-key-123',
    x402_idempotency_key: 'x402-key-123',
    machine_metadata: { protocol: 'x402' },
    confirmed_at: '2026-06-19T10:00:00.000Z',
    ...overrides,
  }
}

function evidenceInsert() {
  expect(mockQuery).toHaveBeenCalledTimes(1)
  const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
  return { sql, params }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-06-19T10:01:02.003Z'))
  mockQuery.mockResolvedValue({ rows: [] })
  mockGetBookTimeSekValue.mockResolvedValue({
    amountSek: 132.5,
    fxRate: 10.6,
    fxSource: 'coingecko_spot',
  })
  mockRecordSettledFee.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('recordMachinePaymentEvidenceBase', () => {
  it('freezes book-time FX values while re-settlement updates non-FX evidence fields', async () => {
    await recordMachinePaymentEvidenceBase(payment())

    const { sql, params } = evidenceInsert()
    expect(sql).toContain(
      'amount_sek = COALESCE(machine_payment_evidence.amount_sek, EXCLUDED.amount_sek)',
    )
    expect(sql).toContain(
      'fx_rate_sek = COALESCE(machine_payment_evidence.fx_rate_sek, EXCLUDED.fx_rate_sek)',
    )
    expect(sql).toContain(
      'fx_source = COALESCE(machine_payment_evidence.fx_source, EXCLUDED.fx_source)',
    )
    expect(sql).toContain(
      'fx_at = COALESCE(machine_payment_evidence.fx_at, EXCLUDED.fx_at)',
    )

    const excludedColumns = [
      'rail',
      'tx_hash',
      'chain_id',
      'resource_url',
      'merchant_address',
      'payer_address',
      'settlement_address',
      'token_symbol',
      'token_address',
      'amount_raw',
      'amount_human',
      'challenge_id',
      'idempotency_key',
      'confirmed_at',
    ]
    for (const column of excludedColumns) {
      expect(sql).toContain(`${column} = EXCLUDED.${column}`)
      expect(sql).not.toContain(`${column} = COALESCE(`)
    }
    expect(sql).toContain(
      'challenge_payload = COALESCE(machine_payment_evidence.challenge_payload, EXCLUDED.challenge_payload)',
    )

    expect(params.slice(19, 23)).toEqual([
      132.5,
      10.6,
      'coingecko_spot',
      '2026-06-19T10:01:02.003Z',
    ])
    expect(mockGetBookTimeSekValue).toHaveBeenCalledWith('USDC', '12.5')
    expect(mockRecordSettledFee).toHaveBeenCalledOnce()
    expect(mockFeedSettledPaymentBestEffort).toHaveBeenCalledWith(
      '22222222-2222-2222-2222-222222222222',
      '33333333-3333-3333-3333-333333333333',
    )
  })

  it('writes evidence with null SEK fields when book-time pricing is unavailable', async () => {
    mockGetBookTimeSekValue.mockResolvedValueOnce(null)

    await recordMachinePaymentEvidenceBase(payment())

    const { params } = evidenceInsert()
    expect(params.slice(19, 23)).toEqual([null, null, null, null])
    expect(mockRecordSettledFee).toHaveBeenCalledOnce()
    expect(mockFeedSettledPaymentBestEffort).toHaveBeenCalledOnce()
  })

  it('uses the legacy x402 resource URL when the generic payment resource URL is absent', async () => {
    await recordMachinePaymentEvidenceBase(payment({
      payment_resource_url: null,
      x402_resource_url: 'https://legacy.example/x402',
    }))

    const { params } = evidenceInsert()
    expect(params[7]).toBe('https://legacy.example/x402')
  })

  it('returns before pricing or writes unless the payment is protocol-settled with a tx hash and resource URL', async () => {
    const cases: Array<Partial<MachinePaymentEvidenceSource>> = [
      { payment_rail: 'manual', source: 'manual' },
      { status: 'pending_signature' },
      { tx_hash: null },
      { payment_resource_url: null, x402_resource_url: null },
      { kind: 'approval_request', status: 'confirmed' },
    ]

    for (const overrides of cases) {
      await recordMachinePaymentEvidenceBase(payment(overrides))
    }

    expect(mockGetBookTimeSekValue).not.toHaveBeenCalled()
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockRecordSettledFee).not.toHaveBeenCalled()
    expect(mockFeedSettledPaymentBestEffort).not.toHaveBeenCalled()
  })

  it('uses the payment intent conflict target and id column for payment intent evidence', async () => {
    await recordMachinePaymentEvidenceBase(payment({ kind: 'payment_intent' }))

    const { sql, params } = evidenceInsert()
    expect(sql).toContain('ON CONFLICT (payment_intent_id)')
    expect(sql).not.toContain('ON CONFLICT (approval_request_id)')
    expect(params[0]).toBe('33333333-3333-3333-3333-333333333333')
    expect(params[1]).toBeNull()
  })

  it('uses the approval request conflict target and id column for approval evidence', async () => {
    await recordMachinePaymentEvidenceBase(payment({
      kind: 'approval_request',
      status: 'executed',
    }))

    const { sql, params } = evidenceInsert()
    expect(sql).toContain('ON CONFLICT (approval_request_id) WHERE approval_request_id IS NOT NULL')
    expect(params[0]).toBeNull()
    expect(params[1]).toBe('33333333-3333-3333-3333-333333333333')
  })
})
