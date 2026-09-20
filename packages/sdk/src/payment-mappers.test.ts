import { describe, expect, it, vi } from 'vitest'
import {
  mapPaymentReceipt,
  mapPaymentResult,
  mapPaymentStatusResult,
} from './payment-mappers.js'
import { paymentStateFromRaw, throwPaymentStateError } from './payment-state.js'
import type {
  RawHavenPaymentReceipt,
  RawPaymentStatusResult,
  RawStatusResponse,
  RawX402AuthorizeResponse,
} from './types.js'
import {
  AgentPaymentNextAction,
  AgentPaymentPhase,
  HavenApiError,
  HavenPaymentStateError,
} from './types.js'

function statusResponse(overrides: Partial<RawStatusResponse> = {}): RawStatusResponse {
  return {
    payment_id: 'pi_1',
    status: 'confirmed',
    token: 'USDC',
    amount: '1.25',
    to: '0xRecipient',
    tx_hash: '0xabc',
    chain_id: 8453,
    error_message: null,
    created_at: '2026-08-20T10:00:00.000Z',
    signed_at: '2026-08-20T10:00:01.000Z',
    submitted_at: '2026-08-20T10:00:02.000Z',
    confirmed_at: '2026-08-20T10:00:03.000Z',
    expires_at: '2026-08-20T10:05:00.000Z',
    ...overrides,
  }
}

function paymentStatusResponse(
  overrides: Partial<RawPaymentStatusResult> = {},
): RawPaymentStatusResult {
  return {
    payment_id: 'ar_1',
    kind: 'approval_request',
    rail: 'x402',
    status: 'executed',
    phase: AgentPaymentPhase.FundingSent,
    next_action: AgentPaymentNextAction.RetryOriginalX402Request,
    amount: '0.01',
    token: 'USDC',
    resource_url: 'https://merchant.example/data',
    merchant_address: '0xMerchant',
    tx_hash: '0xdef',
    expires_at: '2026-08-20T10:05:00.000Z',
    chain_id: 8453,
    message: 'Funding sent.',
    ...overrides,
  }
}

function rawReceipt(
  overrides: Partial<RawHavenPaymentReceipt> = {},
): RawHavenPaymentReceipt {
  return {
    id: 'receipt_1',
    payment_id: 'pi_1',
    rail: 'x402',
    proof_status: 'confirmed',
    tx_hash: '0xabc',
    chain_id: 8453,
    resource_url: 'https://merchant.example/data',
    merchant_address: '0xMerchant',
    payer_address: '0xPayer',
    settlement_address: '0xSettlement',
    token_symbol: 'USDC',
    token_address: '0xToken',
    amount_raw: '10000',
    amount_human: '0.01',
    challenge_id: null,
    idempotency_key: 'idem_1',
    payment_proof_header_name: 'PAYMENT-SIGNATURE',
    protocol_receipt_header_name: 'PAYMENT-RESPONSE',
    merchant_status: 200,
    confirmed_at: '2026-08-20T10:00:03.000Z',
    created_at: '2026-08-20T10:00:00.000Z',
    updated_at: '2026-08-20T10:00:03.000Z',
    ...overrides,
  }
}

describe('payment result mappers', () => {
  it('preserves a server explorer URL and maps a zero-valued fee', () => {
    const buildExplorerUrl = vi.fn(() => 'https://fallback.example/tx/0xabc')

    const result = mapPaymentResult(
      statusResponse({
        explorer_url: 'https://server.example/tx/0xabc',
        fee: { amount: '0', token: 'USDC', basis_points: 0, applied: false },
      }),
      buildExplorerUrl,
    )

    expect(result.explorerUrl).toBe('https://server.example/tx/0xabc')
    expect(result.fee).toEqual({ amount: '0', token: 'USDC', basisPoints: 0, applied: false })
    expect(buildExplorerUrl).not.toHaveBeenCalled()
  })

  it('derives an explorer URL only when a transaction hash is present', () => {
    const buildExplorerUrl = vi.fn(() => 'https://fallback.example/tx/0xabc')

    expect(mapPaymentResult(statusResponse({ explorer_url: undefined }), buildExplorerUrl).explorerUrl)
      .toBe('https://fallback.example/tx/0xabc')
    expect(buildExplorerUrl).toHaveBeenCalledWith(8453, '0xabc')

    buildExplorerUrl.mockClear()
    expect(mapPaymentResult(statusResponse({ tx_hash: null }), buildExplorerUrl).explorerUrl).toBeNull()
    expect(buildExplorerUrl).not.toHaveBeenCalled()
  })

  it('keeps top-level status context authoritative and falls back within nested x402 context', () => {
    const result = mapPaymentStatusResult(paymentStatusResponse({
      payer_address: undefined,
      amount_atomic: '10000',
      asset: 'top-asset',
      network: null,
      description: undefined,
      idempotency_key: 'top-idem',
      x402: {
        amount_atomic: 'nested-amount',
        asset: 'nested-asset',
        network: 'eip155:8453',
        resource_url: null,
        merchant_address: null,
        description: 'nested-description',
        idempotency_key: null,
      },
    }))

    expect(result).toMatchObject({
      payerAddress: null,
      fee: null,
      amountAtomic: '10000',
      asset: 'top-asset',
      network: 'eip155:8453',
      description: 'nested-description',
      idempotencyKey: 'top-idem',
      x402: {
        amountAtomic: 'nested-amount',
        asset: 'nested-asset',
        network: 'eip155:8453',
        resourceUrl: 'https://merchant.example/data',
        merchantAddress: '0xMerchant',
        description: 'nested-description',
        idempotencyKey: 'top-idem',
      },
    })
  })

  it('preserves optional receipt ID presence independently', () => {
    const withoutOwners = mapPaymentReceipt(rawReceipt())
    expect(withoutOwners).not.toHaveProperty('paymentIntentId')
    expect(withoutOwners).not.toHaveProperty('approvalRequestId')

    const withOwners = mapPaymentReceipt(rawReceipt({
      payment_intent_id: undefined,
      approval_request_id: 'ar_1',
    }))
    expect(withOwners.paymentIntentId).toBeNull()
    expect(withOwners.approvalRequestId).toBe('ar_1')
    expect(withOwners.challengePayload).toBeUndefined()
  })

  // #2998: additive alongside deprecated `txHash`/`tx_hash` — names which
  // hash is funding and which is settlement, defaulting to null when the
  // server omits either (older backend, or the field genuinely has no
  // value on this row).
  it('mapPaymentReceipt carries funding_tx_hash / settlement_tx_hash, defaulting to null when absent', () => {
    const withoutEither = mapPaymentReceipt(rawReceipt())
    expect(withoutEither.fundingTxHash).toBeNull()
    expect(withoutEither.settlementTxHash).toBeNull()

    const withBoth = mapPaymentReceipt(rawReceipt({
      funding_tx_hash: '0xfunding',
      settlement_tx_hash: '0xsettlement',
    }))
    expect(withBoth.fundingTxHash).toBe('0xfunding')
    expect(withBoth.settlementTxHash).toBe('0xsettlement')

    const erc7710Shape = mapPaymentReceipt(rawReceipt({
      funding_tx_hash: null,
      settlement_tx_hash: '0xsettlement',
    }))
    expect(erc7710Shape.fundingTxHash).toBeNull()
    expect(erc7710Shape.settlementTxHash).toBe('0xsettlement')
  })

  // #2960: additive alongside `payerAddress`/`payer_address` — camelCases
  // the wire `parties` object, absent when the server does not send it.
  it('mapPaymentReceipt carries parties when present, undefined when absent', () => {
    expect(mapPaymentReceipt(rawReceipt()).parties).toBeUndefined()

    const withParties = mapPaymentReceipt(rawReceipt({
      parties: {
        treasury_account: '0xTreasury',
        delegate: '0xDelegate',
        delegate_account: null,
        merchant: '0xMerchant',
      },
    }))
    expect(withParties.parties).toEqual({
      treasuryAccount: '0xTreasury',
      delegate: '0xDelegate',
      delegateAccount: null,
      merchant: '0xMerchant',
    })
  })

  it('mapPaymentStatusResult carries parties when present, undefined when absent', () => {
    expect(mapPaymentStatusResult(paymentStatusResponse()).parties).toBeUndefined()

    const withParties = mapPaymentStatusResult(paymentStatusResponse({
      parties: {
        treasury_account: '0xTreasury',
        delegate: '0xDelegate',
        delegate_account: '0xDelegateAccount',
        merchant: '0xMerchant',
      },
    }))
    expect(withParties.parties).toEqual({
      treasuryAccount: '0xTreasury',
      delegate: '0xDelegate',
      delegateAccount: '0xDelegateAccount',
      merchant: '0xMerchant',
    })
  })
})

describe('list scope survives the receipt mapper (#3132)', () => {
  it('carries scope when the backend states it, as the two decided values', () => {
    const receipt = mapPaymentReceipt(rawReceipt({ scope: { source: 'agent', filter: null } }))
    expect(receipt.scope).toEqual({ source: 'agent', filter: null })
  })

  it('leaves scope undefined on an older backend that does not send it — never invents one', () => {
    expect(mapPaymentReceipt(rawReceipt())).not.toHaveProperty('scope')
  })
})

describe('receipt vocabulary converges on the transaction names (#3134)', () => {
  // Each pair is asserted from the RAW column, not from its twin: a test that
  // only compared receipt.source to receipt.rail would pass if the mapper
  // pointed both at the wrong column.
  it('emits the four survivors from the same columns the old names read', () => {
    const receipt = mapPaymentReceipt(rawReceipt({
      rail: 'x402',
      proof_status: 'pending',
      resource_url: 'https://merchant.example/paid',
      merchant_address: '0xMerchantTwin',
    }))
    expect(receipt.source).toBe('x402')
    expect(receipt.paymentProofStatus).toBe('pending')
    expect(receipt.x402ResourceUrl).toBe('https://merchant.example/paid')
    expect(receipt.x402MerchantAddress).toBe('0xMerchantTwin')
  })

  it('keeps the deprecated twins for one full release, byte-equal to the survivors', () => {
    const receipt = mapPaymentReceipt(rawReceipt({
      rail: 'x402',
      proof_status: 'pending',
      resource_url: 'https://merchant.example/paid',
      merchant_address: null,
    }))
    expect(receipt.rail).toBe('x402')
    expect(receipt.proofStatus).toBe('pending')
    expect(receipt.resourceUrl).toBe('https://merchant.example/paid')
    expect(receipt.merchantAddress).toBeNull()
    expect(receipt.x402MerchantAddress).toBeNull()
    // The removal condition lives on mapPaymentReceipt; when all three release
    // clocks have moved, invert these four `toHaveProperty` lines.
    for (const twin of ['rail', 'proofStatus', 'resourceUrl', 'merchantAddress']) {
      expect(receipt).toHaveProperty(twin)
    }
  })

  it('does not rename the wire — the raw receipt keys are the backend contract', () => {
    const raw = rawReceipt()
    expect(Object.keys(raw)).toEqual(expect.arrayContaining([
      'rail', 'proof_status', 'resource_url', 'merchant_address',
    ]))
    for (const camel of ['source', 'paymentProofStatus', 'x402ResourceUrl', 'x402MerchantAddress']) {
      expect(raw).not.toHaveProperty(camel)
    }
  })
})

describe('raw payment state mapping', () => {
  it('#2262: approved is fail-closed — stop, never a wait instruction', () => {
    // `approved` sat literally between two branches #2101 had already
    // converted and was the last arm emitting a wait. It was an
    // `approval_requests` status (table dropped, #2055) and no repository
    // write sets `payment_intents.status` to it, so nothing can mint it — the
    // wait pointed at a user-execution step on a rail that answers 410.
    const state = paymentStateFromRaw('x402 payment', {
      payment_id: 'ar_3',
      status: 'approved',
    } as RawX402AuthorizeResponse)
    expect(state?.nextAction).toBe(AgentPaymentNextAction.StopAndTellUser)
    expect(state?.nextAction).not.toBe(AgentPaymentNextAction.WaitForUserToCompletePayment)
    // The phase label is deliberately unchanged — #2101 and #2145 converted
    // next actions only, and this value already documents itself as retired.
    expect(state?.phase).toBe(AgentPaymentPhase.UserExecutionRequired)
    expect(state?.message).toMatch(/no live Haven rail produces/)
    expect(state?.message).toMatch(/Nothing is waiting to be completed/)
    // The generic template is what used to render here, and it embedded the
    // retired next action verbatim into agent-facing text.
    expect(state?.message).not.toContain('wait_for_user_to_complete_payment')
    expect(state?.message).not.toContain('is approved; next_action=')
  })

  it('#2262: no status fallback in this module answers with a wait', () => {
    // Positive control against the reverse defect: a build that answered
    // StopAndTellUser for EVERY status would pass the assertion above. These
    // three statuses must keep their own distinct, non-stop verdicts.
    const verdicts = (['pending_signature', 'submitted', 'confirmed', 'expired'] as const).map(
      (status) =>
        paymentStateFromRaw('x402 payment', {
          payment_id: 'ar_4',
          status,
        } as RawX402AuthorizeResponse)?.nextAction,
    )
    expect(verdicts).toEqual([
      AgentPaymentNextAction.SignAndSubmitPayment,
      AgentPaymentNextAction.CheckStatusLater,
      AgentPaymentNextAction.None,
      AgentPaymentNextAction.RequestAgainIfUserStillWantsIt,
    ])

    // And no status this module maps may answer with either retired wait.
    const retiredWaits: string[] = [
      AgentPaymentNextAction.WaitForUserApproval,
      AgentPaymentNextAction.WaitForUserToCompletePayment,
    ]
    for (const status of [
      'pending_signature', 'submitted', 'confirmed', 'pending', 'pending_approval',
      'approved', 'proposed', 'executed', 'rejected', 'expired', 'failed',
    ]) {
      const nextAction = paymentStateFromRaw('x402 payment', {
        payment_id: 'ar_5',
        status,
      } as RawX402AuthorizeResponse)?.nextAction
      expect(nextAction, `status ${status} must not answer with a retired wait`).not.toBeUndefined()
      expect(retiredWaits, `status ${status} answered with a retired wait`).not.toContain(nextAction)
    }
  })

  it('#2145: executed is fail-closed — stop, never a retry instruction', () => {
    // `executed` was the last #2101 sibling still mapped to
    // retry_original_x402_request. It was an `approval_requests` status
    // (table dropped, #2055) and cannot be constructed as a
    // payment_intents.status, so a retry instruction here pointed at a state
    // nothing can mint. The reachable retry producer is the backend's
    // funded-but-undelivered projection, which arrives via `next_action`.
    const state = paymentStateFromRaw('x402 payment', {
      payment_id: 'ar_2',
      status: 'executed',
    } as RawX402AuthorizeResponse)
    expect(state?.nextAction).toBe(AgentPaymentNextAction.StopAndTellUser)
    expect(state?.message).toMatch(/Do not retry/)
    expect(state?.message).toMatch(/review this payment in Haven/)
  })

  it('normalizes pending and preserves top-level-before-protocol field precedence', () => {
    const raw: RawX402AuthorizeResponse = {
      payment_id: 'ar_1',
      status: 'pending',
      requested: '2.50',
      merchant_to: '0xFallbackMerchant',
      amount_atomic: '2500000',
      asset: 'top-asset',
      network: null,
      x402: {
        amount_atomic: 'nested-amount',
        asset: 'nested-asset',
        network: 'eip155:8453',
        resource_url: 'https://merchant.example/data',
        merchant_address: '0xNestedMerchant',
        description: 'nested-description',
        idempotency_key: 'nested-idem',
      },
    }

    expect(paymentStateFromRaw('x402 payment', raw)).toEqual({
      paymentId: 'ar_1',
      kind: 'approval_request',
      rail: 'direct',
      status: 'pending_approval',
      phase: AgentPaymentPhase.UserApprovalRequired,
      // #2101: STOP, not wait. The phase is a retained descriptive label; the
      // nextAction is the field agents follow FIRST, and no approval can ever
      // arrive to end a wait (410 on the legacy rail per #1986; 403/502 at
      // prepare on the delegation rail; `approval_requests` dropped by #2055).
      nextAction: AgentPaymentNextAction.StopAndTellUser,
      amount: '2.50',
      token: '',
      resourceUrl: null,
      merchantAddress: '0xFallbackMerchant',
      txHash: null,
      expiresAt: '',
      chainId: 0,
      // #2101: the minted message must NOT promise an approval that will never
      // arrive — no live rail queues a payment (410 on the legacy rail, #1986;
      // 403/502 at prepare on the delegation rail; `approval_requests` dropped
      // by #2055). The fail-closed branch stays, but it tells the agent to stop.
      message: "x402 payment is not payable: it is outside the agent's on-chain budget and no approval is pending (payment_id: ar_1). Ask the user to grant or raise the budget in Haven.",
      amountAtomic: '2500000',
      asset: 'top-asset',
      network: 'eip155:8453',
      description: 'nested-description',
      idempotencyKey: 'nested-idem',
      x402: {
        amountAtomic: 'nested-amount',
        asset: 'nested-asset',
        network: 'eip155:8453',
        resourceUrl: 'https://merchant.example/data',
        merchantAddress: '0xNestedMerchant',
        description: 'nested-description',
        idempotencyKey: 'nested-idem',
      },
      mpp: undefined,
    })
  })

  it('preserves server-supplied phase, next action, message, kind, and MPP context', () => {
    const raw: RawX402AuthorizeResponse = {
      payment_id: 'pi_1',
      kind: 'payment_intent',
      rail: 'mpp',
      status: 'future_status',
      phase: AgentPaymentPhase.PaymentSubmitted,
      next_action: AgentPaymentNextAction.CheckStatusLater,
      message: 'Server guidance.',
      amount: '3',
      token: 'USDC',
      challenge_id: 'top-challenge',
      mpp: {
        amount_atomic: null,
        asset: null,
        network: null,
        resource_url: null,
        merchant_address: null,
        description: null,
        idempotency_key: null,
        challenge_id: null,
      },
    }

    const state = paymentStateFromRaw('Payment', raw)
    expect(state).toMatchObject({
      kind: 'payment_intent',
      rail: 'mpp',
      status: 'future_status',
      phase: AgentPaymentPhase.PaymentSubmitted,
      nextAction: AgentPaymentNextAction.CheckStatusLater,
      message: 'Server guidance.',
      mpp: { challengeId: 'top-challenge' },
    })
  })

  it('returns null when neither wire metadata nor status fallbacks provide a contract', () => {
    expect(paymentStateFromRaw('Payment', {
      payment_id: 'pi_1',
      status: 'future_status',
    })).toBeNull()
  })

  it('throws the typed state error with the status-specific HTTP code and raw body', () => {
    const raw: RawX402AuthorizeResponse = {
      payment_id: 'ar_1',
      status: 'rejected',
    }

    let caught: unknown
    try {
      throwPaymentStateError('x402 payment', raw)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(HavenPaymentStateError)
    expect(caught).toMatchObject({
      message: 'The user rejected this payment request (payment_id: ar_1).',
      statusCode: 409,
      body: raw,
      paymentId: 'ar_1',
      status: 'rejected',
      phase: AgentPaymentPhase.Rejected,
      nextAction: AgentPaymentNextAction.StopAndTellUser,
    })
  })

  it('preserves the legacy API-error fallback when no structured state can be built', () => {
    const raw: RawX402AuthorizeResponse = {
      payment_id: '',
      status: 'pending_approval',
    }

    let caught: unknown
    try {
      throwPaymentStateError('Payment', raw)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(HavenApiError)
    expect(caught).not.toBeInstanceOf(HavenPaymentStateError)
    expect(caught).toMatchObject({
      // #2101: declined, not queued — see the note above.
      message: "Payment exceeds the agent's on-chain budget and was declined; no approval is pending and none will arrive (payment_id: ).",
      statusCode: 202,
      body: raw,
    })
  })
})
