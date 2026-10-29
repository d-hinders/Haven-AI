/**
 * #4354 — the erc7710 settlement seam writes the funnel's last step when, and
 * only when, its confirm wins.
 *
 * On erc7710 the merchant redeems the delegation and Haven submits nothing, so
 * `POST /payments/:id/sign` (the only emitter before #4354) never runs for the
 * payment: this seam's confirm is where it settles. The wiring is what is
 * under test here, so the collaborators the seam does not own are stubbed —
 * the on-chain verifier, the guarded confirm and fiat — and the funnel
 * emitter is a spy. What the insert itself writes (once per user, confirmed
 * rows only, the rail label) is proven on real Postgres in
 * `infra/repositories/__tests__/first-payment-settled.db.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { verifier, authorizations, funnel } = vi.hoisted(() => ({
  verifier: { verifySettlementTransferTx: vi.fn() },
  authorizations: { confirmObservedSettlement: vi.fn() },
  funnel: { emitFirstPaymentSettled: vi.fn() },
}))
vi.mock('../../../infra/chain/settlement-transfer-verifier.js', () => verifier)
vi.mock('../../../infra/repositories/x402-authorizations.js', () => authorizations)
vi.mock('../../../infra/repositories/onboarding-funnel.js', () => funnel)
vi.mock('../../../infra/fiat-values.js', () => ({
  getFiatValuesForTokenAmount: vi.fn(async () => ({ usd: 0.1, eur: 0.09, sek: 1 })),
}))

import { observeErc7710Settlement, type ObservableSettlementIntent } from '../settlement-observed.js'

const TX = `0x${'ab'.repeat(32)}`

function intent(overrides: Partial<ObservableSettlementIntent> = {}): ObservableSettlementIntent {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    agent_id: '55555555-5555-4555-8555-555555555555',
    chain_id: 84532,
    account_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
    to_address: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
    token_symbol: 'USDC',
    token_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    amount_raw: '100000',
    amount_human: '0.10',
    status: 'submitted',
    tx_hash: null,
    delegation_hash: `0x${'12'.repeat(32)}`,
    created_at: new Date().toISOString(),
    source: 'x402',
    payment_rail: 'x402',
    execution_rail: 'delegation',
    machine_metadata: { settlement_scheme: 'erc7710' },
    ...overrides,
  }
}

describe('observeErc7710Settlement — first_payment_settled wiring (#4354)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifier.verifySettlementTransferTx.mockResolvedValue({ outcome: 'verified', delegationBound: true })
    authorizations.confirmObservedSettlement.mockResolvedValue(true)
  })

  it('a verified settlement whose confirm wins emits for that payment, once, after the confirm', async () => {
    const result = await observeErc7710Settlement(intent(), TX)

    expect(result.outcome).toBe('confirmed')
    expect(funnel.emitFirstPaymentSettled).toHaveBeenCalledTimes(1)
    expect(funnel.emitFirstPaymentSettled).toHaveBeenCalledWith(intent().id)
    const confirmOrder = authorizations.confirmObservedSettlement.mock.invocationCallOrder[0]
    const emitOrder = funnel.emitFirstPaymentSettled.mock.invocationCallOrder[0]
    expect(emitOrder).toBeGreaterThan(confirmOrder)
  })

  it('a confirm that matched nothing (moved row, replay or ambiguity guard) emits nothing', async () => {
    authorizations.confirmObservedSettlement.mockResolvedValue(false)
    const result = await observeErc7710Settlement(intent(), TX)
    expect(result.outcome).toBe('unverified')
    expect(funnel.emitFirstPaymentSettled).not.toHaveBeenCalled()
  })

  it('an unverified transaction emits nothing and never reaches the confirm', async () => {
    verifier.verifySettlementTransferTx.mockResolvedValue({ outcome: 'mismatch', reason: 'wrong amount' })
    const result = await observeErc7710Settlement(intent(), TX)
    expect(result.outcome).toBe('unverified')
    expect(authorizations.confirmObservedSettlement).not.toHaveBeenCalled()
    expect(funnel.emitFirstPaymentSettled).not.toHaveBeenCalled()
  })

  it('a row that is not a pending erc7710 settlement emits nothing', async () => {
    const result = await observeErc7710Settlement(intent({ machine_metadata: { settlement_scheme: 'eip3009' } }), TX)
    expect(result.outcome).toBe('not_applicable')
    expect(funnel.emitFirstPaymentSettled).not.toHaveBeenCalled()
  })
})
