import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  recordMachinePaymentEvidenceBase,
  recordMachinePaymentEvidenceBaseById,
  tryRecordMachinePaymentEvidenceBaseById,
  type MachinePaymentEvidenceSource,
} from '../evidence.js'

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

vi.mock('../../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../../../infra/fiat-values.js', () => ({
  getBookTimeSekValue: (...args: unknown[]) => mockGetBookTimeSekValue(...args),
}))

vi.mock('../../fee/index.js', () => ({
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

vi.mock('../../reporting/index.js', () => ({
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
      // #2085: `{ kind: 'approval_request', status: 'confirmed' }` was the
      // fifth case. It exercised the approval branch's different expected
      // status ('executed'), which no read can produce — see
      // `infra/repositories/__tests__/approval-kind-unconstructible.test.ts`.
    ]

    for (const overrides of cases) {
      await recordMachinePaymentEvidenceBase(payment(overrides))
    }

    expect(mockGetBookTimeSekValue).not.toHaveBeenCalled()
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockRecordSettledFee).not.toHaveBeenCalled()
    expect(mockFeedSettledPaymentBestEffort).not.toHaveBeenCalled()
  })

  // ── #2213: each early return, classified ────────────────────────────────
  //
  // The test above pins that all four return WITHOUT writing. It cannot pin
  // WHY, and before #2213 there was no why to pin: all four were the same
  // silent `return`, indistinguishable from a successful write to any caller.
  //
  // Three of them are "nothing to record" — the payment is not (yet) an
  // evidence-bearing settled protocol payment, and a caller reaching them is
  // behaving correctly. One is "failed to record": `resource_url` is NOT NULL
  // on `machine_payment_evidence`, so a settled x402 payment without one can
  // never enter the accounting feed. Collapsing that fourth case into the
  // other three is the defect #2213 fixes; separating them is the whole point,
  // so each is asserted on its own rather than as a set.

  it('NOTHING TO RECORD: a non-protocol rail is not_applicable, not a failure', async () => {
    await expect(
      recordMachinePaymentEvidenceBase(payment({ payment_rail: 'manual', source: 'manual' })),
    ).resolves.toEqual({ status: 'not_applicable', reason: 'not_protocol_rail' })
  })

  it('NOTHING TO RECORD: an unsettled status is not_applicable — evidence is settlement-time proof', async () => {
    await expect(
      recordMachinePaymentEvidenceBase(payment({ status: 'pending_signature' })),
    ).resolves.toEqual({ status: 'not_applicable', reason: 'not_settled' })
  })

  it('NOTHING TO RECORD: a missing tx hash is not_applicable — the row whose turn has not come', async () => {
    await expect(
      recordMachinePaymentEvidenceBase(payment({ tx_hash: null })),
    ).resolves.toEqual({ status: 'not_applicable', reason: 'not_settled' })
  })

  it('FAILED: a settled protocol payment with no resource URL can never be booked — the #2213 gap', async () => {
    await expect(
      recordMachinePaymentEvidenceBase(payment({
        payment_resource_url: null,
        x402_resource_url: null,
      })),
    ).resolves.toEqual({ status: 'failed', reason: 'missing_resource_url' })
  })

  it('POSITIVE CONTROL: a complete settled protocol payment reports recorded', async () => {
    await expect(recordMachinePaymentEvidenceBase(payment())).resolves.toEqual({
      status: 'recorded',
    })
    expect(mockQuery).toHaveBeenCalledOnce()
  })

  it('uses the payment intent conflict target and id column for payment intent evidence', async () => {
    await recordMachinePaymentEvidenceBase(payment({ kind: 'payment_intent' }))

    const { sql, params } = evidenceInsert()
    expect(sql).toContain('ON CONFLICT (payment_intent_id)')
    expect(sql).not.toContain('ON CONFLICT (approval_request_id)')
    expect(params[0]).toBe('33333333-3333-3333-3333-333333333333')
    expect(params[1]).toBeNull()
  })

  it('NEVER writes an approval-anchored evidence row (#2085)', async () => {
    // Replaces a test that asserted the opposite branch. That branch could not
    // run — evidence is written only from `FIND_INTENT_FOR_EVIDENCE_SQL`,
    // which hardcodes the kind — so the old test pinned a shape production
    // could not emit.
    //
    // Inverted rather than deleted, because the READ side is deliberately
    // still live: migration 070 dropped `approval_requests` with CASCADE so
    // historical evidence rows would SURVIVE holding `approval_request_id`,
    // and `mapEvidence` still surfaces it as their `payment_id`. This asserts
    // only that nothing NEW is anchored that way.
    await recordMachinePaymentEvidenceBase(payment({ status: 'confirmed' }))

    const { sql, params } = evidenceInsert()
    expect(sql).toContain('ON CONFLICT (payment_intent_id)')
    expect(sql).not.toContain('ON CONFLICT (approval_request_id)')
    expect(params[1]).toBeNull()
  })
})

/**
 * #2213: the two wrappers between a caller and the seam. Each had its own
 * silent no-op, and each is now classified — `intent_not_found` and
 * `write_threw` are FAILURES: the caller named a payment id it believes exists,
 * so neither is "nothing to record".
 *
 * `tryRecord…` still SWALLOWS the throw — that contract is deliberate and
 * unchanged, so a settlement is never blocked by evidence recording. What
 * changed is that the swallow is now reportable.
 */
describe('#2213 evidence-recording wrappers report failure', () => {
  it('FAILED: recordMachinePaymentEvidenceBaseById on an unreadable intent is intent_not_found', async () => {
    // No mock needed and none wanted: the suite default already answers every
    // query with zero rows, which IS "no such intent for this agent". Nothing
    // here depends on call order, so nothing here mocks positionally (#1227).
    await expect(
      recordMachinePaymentEvidenceBaseById('33333333-3333-3333-3333-333333333333'),
    ).resolves.toEqual({ status: 'failed', reason: 'intent_not_found' })
  })

  it('FAILED: tryRecord… still swallows a throw, but now reports write_threw', async () => {
    const log = { warn: vi.fn() }
    // Blanket, not positional: every query in this test fails, which is the
    // shape of the outage being characterised.
    mockQuery.mockRejectedValue(new Error('connection terminated'))

    await expect(
      tryRecordMachinePaymentEvidenceBaseById(
        '33333333-3333-3333-3333-333333333333',
        '11111111-1111-1111-1111-111111111111',
        log,
      ),
    ).resolves.toEqual({ status: 'failed', reason: 'write_threw' })
    // Swallowed, not rethrown — and warned, exactly as before.
    expect(log.warn).toHaveBeenCalledOnce()
  })
})
