/**
 * #420 invariant: a within-budget payment **settles on-chain** and is logged.
 *
 * RE-BASED onto the delegation rail (#2016). It used to drive the seeded
 * legacy AllowanceModule identity: `POST /payments` → sign `sign_data.hash`
 * with raw ECDSA → poll. Since #1986 that account answers HTTP 410 ("the Safe
 * rail is retired"), so the leg could not pass again — it was one of the two
 * honest reds in the 2026-08-25 `qa-dev` failure.
 *
 * The invariant survives the rail; only the instrument changed. On the
 * delegation rail the same request returns EIP-712 typed data the delegate
 * signs (`eip712_userop`), and the budget delegation authorizes the transfer
 * on-chain. This is also the suite's positive control for its two over-budget
 * siblings: it is the leg that proves the money path can still say YES, which
 * is what makes their refusals mean something.
 */

import { signUserOpTypedDataForDelegation } from '@haven_ai/sdk'
import { HavenApi } from '../lib/haven-api.js'
import { readOnchainBudget } from '../lib/delegation-budget.js'
import { type Scenario, type ScenarioContext, pass, fail, skip } from './types.js'

/** Small enough to be cheap against the standing 1 USDC/day budget. */
const AMOUNT = '0.01'
const AMOUNT_ATOMIC = 10_000n

export const withinBudgetSettle: Scenario = {
  name: 'within-budget-settle',
  invariant: 'A payment inside the budget settles on-chain and is logged as a receipt.',
  async run(ctx: ScenarioContext) {
    if (!ctx.cfg.delegationAgentApiKey || !ctx.cfg.delegationDelegateKey) {
      return skip(
        'QA_DELEGATION_AGENT_API_KEY / QA_DELEGATION_DELEGATE_PRIVATE_KEY not set — ' +
          'the direct-payment settle leg runs on the delegation rail since #2016',
      )
    }
    const api = new HavenApi(ctx.cfg, ctx.cfg.delegationAgentApiKey)

    // Establish the precondition rather than assume it: a leg that fails
    // because the budget is spent must say so, not report a settle defect.
    const budget = await readOnchainBudget(api)
    if ('error' in budget) return fail(`precondition: ${budget.error}`)
    if (budget.remaining < AMOUNT_ATOMIC) {
      return fail(
        `precondition: remaining budget ${budget.remaining} < ${AMOUNT_ATOMIC} atomic — ` +
          'this is budget exhaustion, not a settlement failure',
      )
    }

    const created = await api.createPayment('USDC', AMOUNT, ctx.cfg.paymentTo)
    const typedData = created.data.sign_data?.typed_data
    if (!created.ok || !created.data.payment_id || !typedData) {
      return fail(
        `create payment did not return a signable intent (HTTP ${created.status}, status ${created.data.status ?? '?'}): ${created.data.error ?? created.data.message ?? ''}`,
      )
    }
    if (created.data.sign_data?.signature_scheme !== 'eip712_userop') {
      // The rail is a property of the account; a different scheme here means
      // the identity is not the one this leg claims to be exercising.
      return fail(
        `expected the delegation rail's 'eip712_userop' scheme, got '${created.data.sign_data?.signature_scheme ?? 'none'}'`,
      )
    }
    const { payment_id } = created.data

    // Signed client-side with the delegate key — Haven signs nothing.
    const signature = await signUserOpTypedDataForDelegation(
      ctx.cfg.delegationDelegateKey,
      typedData as never,
    )

    const signed = await api.signPayment(payment_id, signature)
    if (!signed.ok) {
      const raw = signed.data.details ?? signed.data.error ?? `HTTP ${signed.status}`
      const phrase = raw.split('(transaction=')[0].trim()
      return fail(`execution failed: ${phrase}`)
    }

    // The confirmed payment record (terminal status + tx_hash, read back from
    // GET /payments/:id) is the agent-visible receipt.
    const settled = await api.pollUntilSettled(payment_id)
    if (settled.status !== 'confirmed' || !settled.tx_hash) {
      return fail(`payment ended '${settled.status}' (tx ${settled.tx_hash ?? 'none'}; ${settled.error_message ?? ''})`)
    }

    return pass(`settled ${AMOUNT} USDC on-chain + receipt confirmed (tx ${settled.tx_hash})`)
  },
}
