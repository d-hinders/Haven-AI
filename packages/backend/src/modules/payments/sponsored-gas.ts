/**
 * Sponsored-gas recording for the delegation payment path (#3837).
 *
 * `POST /payments/:id/sign` calls `recordSponsoredUserOpGas` around the
 * `submitDelegationPayment` seam — on the success path (the receipt's
 * `actualGasCost`), on a landed-but-REVERTED op (the cost rides the widened
 * `SubmittedUserOpFailedError`), and on `receipt_unconfirmed` (cost NULL:
 * no receipt was ever seen). It sits OUTSIDE the `confirmSubmittedIntent`
 * booking flow — the route calls it directly on the submit seam, never
 * inside the booking — so a metric write can never gate a booking.
 *
 * Failure direction: AWAITED-AND-SWALLOWED. The route awaits the call (the
 * write is deterministic in tests and lands before the response), and every
 * failure is caught and warned — a recording failure NEVER fails a payment,
 * the same rule as the relayer spend guard (#717). Stated in the PR per the
 * issue's acceptance criterion.
 *
 * erc7710 settlement is NOT recorded here: the merchant redeems the
 * [child, budget] chain and Haven submits nothing (`modules/x402/settle.ts`).
 */
import { insertSponsoredUserOpGas, type SponsoredLeg, type SponsoredUserOpOutcome } from '../../infra/repositories/sponsored-userop-gas.js'

export type { SponsoredLeg, SponsoredUserOpOutcome }

export interface SponsoredUserOpGasRecord {
  paymentIntentId: string | null
  agentId: string | null
  userId: string | null
  chainId: number
  leg: SponsoredLeg
  outcome: SponsoredUserOpOutcome
  userOpHash?: string | null
  txHash?: string | null
  actualGasUsed?: bigint | null
  actualGasCost?: bigint | null
}

/**
 * `payment_rail === 'x402'` is the x402 EIP-3009 funding leg (written by
 * `modules/x402/delegation-authorize.ts`); every other payment_rail that
 * reaches the delegation submit seam is a direct payment. erc7710 intents
 * never reach it (refused before the claim, `routes/payments.ts`).
 */
export function sponsoredLegOf(paymentRail: string | null | undefined): SponsoredLeg {
  return paymentRail === 'x402' ? 'x402_funding' : 'direct'
}

/** Best-effort persistence — never throws. */
export async function recordSponsoredUserOpGas(record: SponsoredUserOpGasRecord): Promise<void> {
  try {
    await insertSponsoredUserOpGas(record)
  } catch (err) {
    console.warn(
      `sponsored-gas: could not record ${record.leg}/${record.outcome} UserOp gas for payment ${record.paymentIntentId ?? 'unknown'} (${err instanceof Error ? err.message : String(err)})`,
    )
  }
}
