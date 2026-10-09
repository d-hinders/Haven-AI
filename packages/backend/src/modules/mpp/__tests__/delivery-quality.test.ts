import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFindIntent, mockUpsert } = vi.hoisted(() => ({
  mockFindIntent: vi.fn(),
  mockUpsert: vi.fn(),
}))

vi.mock('../../../infra/repositories/machine-payments.js', () => ({
  findIntentForEvidenceScoped: (...args: unknown[]) => mockFindIntent(...args),
  upsertDeliveryQualityReport: (...args: unknown[]) => mockUpsert(...args),
}))

import {
  DELIVERY_QUALITY_NOTE_MAX,
  recordDeliveryQualityHandler,
} from '../delivery-quality.js'

const AGENT_ID = 'a1a1a1a1-0000-4000-8000-000000000001'
const PAYMENT_ID = 'b2b2b2b2-0000-4000-8000-000000000002'
const USER_ID = 'c3c3c3c3-0000-4000-8000-000000000003'

function settledIntent() {
  return {
    id: PAYMENT_ID,
    kind: 'payment_intent' as const,
    agent_id: AGENT_ID,
    user_id: USER_ID,
    account_address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    chain_id: 8453,
    token_symbol: 'USDC',
    token_address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    to_address: '0xcccccccccccccccccccccccccccccccccccccccc',
    amount_raw: '10000',
    amount_human: '0.01',
    tx_hash: `0x${'ab'.repeat(64)}`,
    status: 'confirmed',
  }
}

describe('recordDeliveryQualityHandler (#3770)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('records ok/unusable/partial on the agent’s own settled payment and echoes the stored row', async () => {
    mockFindIntent.mockResolvedValue(settledIntent())
    mockUpsert.mockResolvedValue({ quality: 'unusable', note: 'returned ":**\\n"', updated_at: '2026-10-08T12:00:00.000Z' })

    const result = await recordDeliveryQualityHandler(AGENT_ID, PAYMENT_ID, 'unusable', ' returned ":**\\n" ')

    expect(result.statusCode).toBe(200)
    expect(result.body).toEqual({
      payment_id: PAYMENT_ID,
      quality: 'unusable',
      note: 'returned ":**\\n"',
      updated_at: '2026-10-08T12:00:00.000Z',
    })
    // The write is the delivery report table ONLY — the user id comes from
    // the intent, never from the request.
    expect(mockUpsert).toHaveBeenCalledWith({
      paymentIntentId: PAYMENT_ID,
      agentId: AGENT_ID,
      userId: USER_ID,
      quality: 'unusable',
      note: 'returned ":**\\n"',
    })
  })

  it('refuses another agent’s payment (indistinguishable from unknown) with a 404', async () => {
    mockFindIntent.mockResolvedValue(null)

    const result = await recordDeliveryQualityHandler(AGENT_ID, PAYMENT_ID, 'unusable')

    expect(result.statusCode).toBe(404)
    expect(result.body).toEqual({ error: 'Payment not found' })
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('refuses an unsettled payment with a 409 — a report requires a delivery', async () => {
    mockFindIntent.mockResolvedValue({ ...settledIntent(), status: 'submitted' })

    const result = await recordDeliveryQualityHandler(AGENT_ID, PAYMENT_ID, 'unusable')

    expect(result.statusCode).toBe(409)
    expect(result.body).toEqual({
      error: 'Delivery quality can only be recorded on a settled payment',
    })
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('refuses a bad quality with a 400 before any lookup', async () => {
    const result = await recordDeliveryQualityHandler(AGENT_ID, PAYMENT_ID, 'fine' as 'ok')

    expect(result.statusCode).toBe(400)
    expect(mockFindIntent).not.toHaveBeenCalled()
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('refuses an over-bound note with a 400 before any write', async () => {
    const result = await recordDeliveryQualityHandler(
      AGENT_ID,
      PAYMENT_ID,
      'ok',
      'x'.repeat(DELIVERY_QUALITY_NOTE_MAX + 1),
    )

    expect(result.statusCode).toBe(400)
    expect(mockFindIntent).not.toHaveBeenCalled()
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('writes a null note for blank input and never for undefined', async () => {
    mockFindIntent.mockResolvedValue(settledIntent())
    mockUpsert.mockResolvedValue({ quality: 'ok', note: null, updated_at: 't' })

    await recordDeliveryQualityHandler(AGENT_ID, PAYMENT_ID, 'ok', '   ')
    expect(mockUpsert.mock.calls[0][0].note).toBeNull()

    await recordDeliveryQualityHandler(AGENT_ID, PAYMENT_ID, 'ok')
    expect(mockUpsert.mock.calls[1][0].note).toBeNull()
  })
})
