import { AgentPaymentNextAction, HavenSigningError, type NextStep } from '@haven_ai/sdk/edge'
import { signerRefusalStep } from './next-step.js'

/**
 * #3169: `haven_sign` called with a bare `payload_hash` — no `payment_id`, no
 * `typed_data` / `typed_data_b64`, no `x402_expected` — is refused, always.
 *
 * Until #3169 that arm was `signPaymentHash`: raw secp256k1 over caller-supplied
 * bytes with no Haven binding, no amount, no merchant, no shape check and no
 * domain separation — a blind-signing oracle for the delegate key. A digest of
 * an EIP-3009 `TransferWithAuthorization` from the delegate wallet signed that
 * way is a valid transfer; a digest of a MetaMask `Delegation` signed that way
 * bypasses the #1476 refusal, which keys on the payload's SHAPE and a hash has
 * none. The arm's only legitimate caller was the AllowanceModule rail, which
 * #1986 retired (`execution-rail.ts` resolves to `delegation | retired_session
 * | retired_allowance`); the surviving rail validates typed data and rejects a
 * raw hash on-chain (AA24, #1254).
 *
 * Structured like the other signer refusals (#3001/#3103): a named code an
 * agent can route on, a `next_action`, and a typed next step. No tool can fix
 * this from inside the call — the remedy is calling THIS tool with an input
 * the signer can verify — so the step names none and says why.
 */
export const BARE_HASH_REFUSED = 'BARE_HASH_REFUSED' as const

export class HavenBareHashRefusedError extends HavenSigningError {
  declare readonly code: typeof BARE_HASH_REFUSED
  readonly next_action = AgentPaymentNextAction.StopAndTellUser
  readonly step: NextStep

  constructor() {
    super(
      'Refusing to sign a bare payload_hash. A hash carries no shape, amount, merchant or ' +
        'binding, so this signer cannot tell a Haven payment from a transfer out of the delegate ' +
        'wallet or a delegation of its authority — and the only rail that ever validated a raw ' +
        'hash signature is retired. Call this tool with { payment_id } (the signer fetches and ' +
        'verifies the Haven-signed context itself), or with typed_data / typed_data_b64 (the ' +
        'account validates that EIP-712 payload), or with x402_expected for an x402 funding leg.',
    )
    ;(this as { code: string }).code = BARE_HASH_REFUSED
    this.name = 'HavenBareHashRefusedError'
    this.step = signerRefusalStep({
      nextAction: AgentPaymentNextAction.StopAndTellUser,
      nextTool: null,
      nextToolOmittedReason:
        'call haven_sign again with payment_id (preferred), typed_data / typed_data_b64, or x402_expected — a bare payload_hash is never signed',
    })
  }
}
