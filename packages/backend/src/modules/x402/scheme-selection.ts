/**
 * The erc7710-vs-eip3009 settlement-scheme decision (#946, #1058), extracted
 * verbatim from `routes/x402.ts`'s authorize handler as pure functions so the
 * decision is unit-testable without HTTP. Evaluation ORDER matches the
 * pre-#996 route exactly:
 *
 *   1. `validateGenericSchemeRail` — rail-generic guards (erc7710/
 *      facilitatorAddresses require a delegation-rail account), run BEFORE
 *      token resolution so a confused client fails on the scheme mismatch
 *      rather than an unrelated asset error.
 *   2. `deriveFundingShape` — once inside the delegation-rail branch, the
 *      payTo shape (merchant vs the agent's own delegate EOA) selects erc7710
 *      vs the EIP-3009 funding leg.
 *   3. `validateDelegationSchemeShape` — the delegation-rail-only
 *      cross-checks once the shape is known.
 */
import type { AgentContext } from '../../middleware/agentAuth.js'
import type { X402HandlerResult } from './types.js'

export function validateGenericSchemeRail(
  agent: AgentContext,
  settlementScheme: string | undefined,
  facilitatorAddresses: string[] | undefined,
): X402HandlerResult | null {
  // #946: settlementScheme is validated for EVERY rail — a legacy-rail agent
  // requesting erc7710 must fail loudly, not silently get the 3009 two-leg.
  if (settlementScheme === 'erc7710' && agent.execution_rail !== 'delegation') {
    return {
      code: 400,
      body: {
        error: 'erc7710 settlement requires a delegation-rail account — the legacy AllowanceModule rail settles via EIP-3009 only',
      },
    }
  }
  // #1058: facilitator addresses pin the settlement child's redeemer caveat.
  // Garbage here would either brick the child (unredeemable) or silently
  // skip the pin — both are caller errors that must fail loudly.
  if (facilitatorAddresses !== undefined && agent.execution_rail !== 'delegation') {
    // Same scheme confusion the erc7710 settlementScheme rejection above
    // fails loudly on — a legacy-rail client believing a redeemer pin
    // exists must not silently proceed unpinned.
    return {
      code: 400,
      body: { error: 'facilitatorAddresses applies to erc7710 direct settlement, which requires a delegation-rail account' },
    }
  }
  return null
}

/**
 * The payTo shape selects the scheme: the standard-x402 SDK contract sends
 * payTo = the agent's own delegate EOA (the funding target) with
 * merchantPayTo = the merchant, while erc7710 callers send the merchant as
 * payTo.
 */
export function deriveFundingShape(payTo: string, delegateAddress: string): boolean {
  return payTo.toLowerCase() === delegateAddress.toLowerCase()
}

export function validateDelegationSchemeShape(
  fundingShape: boolean,
  settlementScheme: string | undefined,
  facilitatorAddresses: string[] | undefined,
): X402HandlerResult | null {
  if (settlementScheme === 'eip3009' && !fundingShape) {
    return {
      code: 400,
      body: {
        error: 'eip3009 settlement requires payTo = the agent delegate EOA (the funding target) and merchantPayTo = the merchant',
      },
    }
  }
  if (settlementScheme === 'erc7710' && fundingShape) {
    return {
      code: 400,
      body: { error: 'erc7710 settlement requires payTo = the merchant, not the agent delegate EOA' },
    }
  }
  if (facilitatorAddresses !== undefined && fundingShape) {
    // #1058: on the 3009 two-leg the merchant settles via EIP-3009 — a
    // redeemer pin is meaningless there and forwarding it means the
    // client confused its schemes.
    return {
      code: 400,
      body: { error: 'facilitatorAddresses applies to erc7710 direct settlement only — the EIP-3009 funding leg has no redeemer' },
    }
  }
  return null
}
