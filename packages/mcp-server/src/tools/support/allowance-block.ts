/**
 * Shared hosted-MCP support — the delegation-rail allowance block the hosted
 * payment tools attach to their successful results.
 *
 * Moved VERBATIM from `tools/plain-http-x402.ts` by #3497 (behavior-preserving
 * move): #3476 built it for `haven_pay_x402_quote` and declared it
 * capability-local because nothing else called it; #3497 item 4 wires the same
 * block into `haven_pay_mcp_tool`, which makes it a two-slice helper and
 * support is where the #2808 derived rule puts those.
 *
 * One-direction dependencies: imports only the SDK and nothing else. Never
 * imports a capability module.
 */
import { AgentPaymentWarningCode, HavenClient, type AgentPaymentWarning } from '@haven_ai/sdk'

/**
 * #3476 — the delegation-rail allowance block `haven_pay_x402_quote` attaches
 * to its successful results (and, since #3497, `haven_pay_mcp_tool` too): the
 * budget visibility the catalog preflight's `allowance` field already provides
 * on the guided path. Visibility ONLY: this never refuses. The tool's own
 * over-budget answer is the backend's (`pending_approval` / the typed 403 on
 * each settlement leg, both after this block has been computed), and the
 * on-chain enforcer remains the actual spend gate regardless of what this
 * block reports.
 *
 * Data source is deliberately `haven.getAllowances()` — `GET
 * /machine-payments/allowances`, the same derived-budget read
 * (`deriveDelegationBudgets` + the #1145 enforcer read, never
 * `agent_allowances`) behind `haven_get_allowances`, the settle-time
 * allowance summary and the old catalog preflight — NOT
 * `POST /machine-payments/budget-precheck`. The precheck is the #3054
 * DECISION surface: Haven refuses through the #3053 choke point there and
 * books a `payment_refusals` row (source `hosted_prepare`). A quote that
 * pre-checks through it would book a second, contradictory row — the ledger
 * would record a refusal while the tool proceeded to mint the intent the
 * plain-HTTP backend then answers itself — so this block reports the budget
 * figures through the pure read instead, and the #2706/#2082 pre-checks keep
 * owning the decision on both legs. In exchange the ledger stays a record of
 * what Haven decided, and the agent still sees `remaining_atomic` before
 * signing.
 *
 * Degradation mirrors the catalog block's own posture exactly
 * (`catalog-purchase.ts`, since #3464): a failed read is `sufficient: null`
 * plus an ALLOWANCE_CHECK_UNAVAILABLE warning — never an error, never a
 * refusal; a succeeded read whose remaining figure is the #1145 optimistic
 * fallback carries ALLOWANCE_READ_OPTIMISTIC. Non-delegation rails answer
 * `null` with the unavailable warning, matching the #3464 exhaustion proof:
 * a retired rail cannot purchase through the hosted tools at all, so there
 * is no budget figure to fabricate for it.
 */
export interface DelegationAllowanceBlock {
  rail: 'delegation'
  sufficient: boolean | null
  remaining_atomic?: string
  source: 'active_delegations'
  /** #3464: canonical camelCase twin of `remaining_atomic`, the spelling `haven_get_agent`'s `allowances[]` rows report. */
  remainingAtomic?: string
}

export async function delegationAllowanceBlock(
  haven: HavenClient,
  agent: Awaited<ReturnType<HavenClient['getAgent']>> | undefined,
  amountAtomic: string,
  token: string,
): Promise<{ allowance: DelegationAllowanceBlock | null; warnings: AgentPaymentWarning[] }> {
  // The tool's own prefetch is REUSED, never repeated: a second getAgent
  // here would break the #1348 round-trip budget this file pins ("exactly
  // ONE agent fetch" per pay). `undefined` means the prefetch's non-throwing
  // `.then(a => a, () => undefined)` caught a failed read — the same
  // convention that yields the 3009 path — and degrades here too. A block
  // present on the result is never fabricated: it is either the real read or
  // the catalog's degraded `sufficient: null` shape, never an error and
  // never a refusal.
  if (!agent) {
    return {
      // Rail unknown — no block at all rather than one stamped 'delegation'
      // (the #3464 rule: never fabricate a rail-labeled row). The warning
      // carries the degrade.
      allowance: null,
      warnings: [
        {
          code: AgentPaymentWarningCode.AllowanceCheckUnavailable,
          message:
            'Could not read the agent record, so the execution rail — and with it the ' +
            'delegation budget figure — is unknown. Proceeding without a budget figure — ' +
            'the on-chain policy remains the actual spend gate; this only affects the guidance shown here.',
        },
      ],
    }
  }
  if (agent.executionRail !== 'delegation') {
    // Two distinct reasons, two messages: a rail the backend NAMED is retired
    // (the #3464 wording), an absent one could not be read at all. Neither
    // fabricates a delegation-rail block.
    const railName: string = agent.executionRail ?? 'unknown'
    return {
      allowance: null,
      warnings: [
        {
          code: AgentPaymentWarningCode.AllowanceCheckUnavailable,
          message:
            railName === 'unknown'
              ? 'The agent record carries no execution rail, so no delegation budget figure is ' +
                'reported. The on-chain policy remains the actual spend gate; this only affects ' +
                'the guidance shown here.'
              : `This agent's account is on the '${railName}' rail, which is retired and cannot purchase — ` +
                'no budget figure is reported. The on-chain policy remains the actual spend gate; ' +
                're-onboard the account on the delegation rail to pay this merchant.',
        },
      ],
    }
  }
  try {
    const summary = await haven.getAllowances()
    const match = summary.allowances.find(
      (entry: { tokenAddress: string }) => entry.tokenAddress.toLowerCase() === token.toLowerCase(),
    )
    if (!match) {
      return {
        allowance: { rail: 'delegation', sufficient: false, remaining_atomic: '0', source: 'active_delegations', remainingAtomic: '0' },
        warnings: [
          {
            code: AgentPaymentWarningCode.AllowanceCheckUnavailable,
            message:
              'No active delegation budget row covers the asset this payment authorizes, so the ' +
              'reported remaining budget is zero and this amount will be declined at prepare — ' +
              'ask the wallet owner to grant a budget in Haven. The on-chain policy remains the ' +
              'actual spend gate either way.',
          },
        ],
      }
    }
    const warnings: AgentPaymentWarning[] = []
    if (match.onchain.remainingIsFromChain === false) {
      warnings.push({
        code: AgentPaymentWarningCode.AllowanceReadOptimistic,
        message:
          'The reported remaining delegation budget could not be read live from chain, so ' +
          `${match.onchain.remaining} atomic is the configured full budget, not a confirmed ` +
          'live figure. The on-chain policy (the budget caveat enforcer) remains the actual ' +
          'spend gate at redemption regardless of this report.',
      })
    }
    return {
      allowance: {
        rail: 'delegation',
        sufficient: BigInt(match.onchain.remaining) >= BigInt(amountAtomic),
        remaining_atomic: match.onchain.remaining,
        source: 'active_delegations',
        remainingAtomic: match.onchain.remaining,
      },
      warnings,
    }
  } catch (err) {
    // Degradation is the catalog's own catch shape: the block stays present
    // with `sufficient: null` and no remaining figure, plus the unavailable
    // warning — never an error, never a refusal. The on-chain policy remains
    // the actual spend gate either way.
    return {
      allowance: { rail: 'delegation', sufficient: null, source: 'active_delegations' },
      warnings: [
        {
          code: AgentPaymentWarningCode.AllowanceCheckUnavailable,
          message:
            'Could not read the active delegation budget ' +
            `for this agent (${err instanceof Error ? err.message : String(err)}). Proceeding without a budget figure — ` +
            'the on-chain policy remains the actual spend gate; this only affects the guidance shown here.',
        },
      ],
    }
  }
}
