/**
 * The erc7710-vs-eip3009 settlement-scheme decision (#946, #1058), extracted
 * verbatim from `routes/x402.ts`'s authorize handler as pure functions so the
 * decision is unit-testable without HTTP.
 *
 * Everything here is **delegation-rail-internal** and runs only after
 * `authorizeX402` has resolved the rail, so every function below may assume a
 * `delegation` account:
 *
 *   1. `deriveFundingShape` — the payTo shape (merchant vs the agent's own
 *      delegate EOA) selects erc7710 vs the EIP-3009 funding leg.
 *   2. `validateDelegationSchemeShape` — the cross-checks once the shape is
 *      known.
 *
 * **What used to sit above them, and why it is gone (#2245).**
 * `validateGenericSchemeRail` ran BEFORE the rail resolution and refused
 * `settlementScheme: 'erc7710'` / a present `facilitatorAddresses` from a
 * non-delegation account with a 400. Its #946 rationale — "a legacy-rail agent
 * requesting erc7710 must fail loudly, not silently get the 3009 two-leg" —
 * predates #1986, which fail-closes the whole rail: the loud failure is now the
 * 410 tombstone, and it is the more accurate one. The old 400 said "the legacy
 * AllowanceModule rail settles via EIP-3009 only", asserting on a money-path
 * route that a retired rail settles at all, and it let one optional caller
 * field decide WHICH refusal a retired-rail account saw — contradicting the
 * #993 single-seam claim in `docs/regulatory/casp-risk-guardrails.md`.
 *
 * Deleted rather than reworded because both guards were exactly redundant with
 * the seam, not merely adjacent to it: both tested
 * `agent.execution_rail !== 'delegation'`, and `resolveExecutionRail` is fed
 * `agent.execution_rail ?? null` from the SAME field and answers `delegation`
 * for exactly the literal `'delegation'`. So every input the guards refused is
 * an input the rail gate refuses one step later, and nothing they refused can
 * now reach the delegation branch. That total overlap is what makes the
 * deletion a message change rather than a permission change.
 */
import type { X402HandlerResult } from './types.js'

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
