/**
 * Shared hosted-MCP support — error normalization and the hosted tool error.
 *
 * Extracted VERBATIM from `tools.ts` by #2808 (behavior-preserving move).
 * `HostedToolError` is the one thrown shape every hosted tool refuses
 * through; `normalizeError`/`runTool` are the single failure envelope every
 * handler returns through. Every planned capability slice (#2809–#2812)
 * crosses this boundary, so it lives in shared support — never copied.
 *
 * The payment-window expiry mapping lives here too: it EXISTS to convert raw
 * relay failures into the normalized `payment_window_expired` HostedToolError,
 * and `normalizeError`'s HavenPaymentStateError branch reads the same
 * predicate — one home, no drift.
 *
 * One-direction dependencies: imports only the SDK, zod, and the #2807
 * contract seam (`../contracts.js`). Never imports a capability module.
 */
import { z } from 'zod/v3'
import {
  HavenApiError,
  HavenError,
  HavenPaymentStateError,
  AgentPaymentFailureCode,
  AgentPaymentNextAction,
  type HavenClient,
  type NextStep,
} from '@haven_ai/sdk'
import { refusalNextStep } from './guidance.js'
import type { ToolFailure, ToolPayload } from '../contracts.js'

export class HostedToolError extends Error {
  readonly code: string
  readonly statusCode?: number
  readonly paymentId?: string
  readonly status?: string
  readonly phase?: string
  /** Derived from `nextStep` (#3102): a refusal names an action only through its typed step. */
  readonly nextAction?: string
  readonly rail?: string
  readonly idempotencyKey?: string | null
  readonly retryWithNewQuote?: boolean
  readonly suggestedTool?: string
  /** #3101 (decision 7): the typed next step a refusal hands the agent, emitted by `normalizeError`. */
  readonly nextStep?: NextStep

  constructor(input: {
    code: string
    message: string
    statusCode?: number
    paymentId?: string
    status?: string
    phase?: string
    rail?: string
    idempotencyKey?: string | null
    retryWithNewQuote?: boolean
    suggestedTool?: string
    /** #3102: the typed next step; the only way a refusal names a `next_action`. */
    nextStep?: NextStep
  }) {
    super(input.message)
    this.name = 'HostedToolError'
    this.code = input.code
    this.statusCode = input.statusCode
    this.paymentId = input.paymentId
    this.status = input.status
    this.phase = input.phase
    this.nextAction = input.nextStep?.next_action
    this.rail = input.rail
    this.idempotencyKey = input.idempotencyKey
    this.retryWithNewQuote = input.retryWithNewQuote
    this.suggestedTool = input.suggestedTool
    this.nextStep = input.nextStep
  }
}

export async function runTool<T>(fn: () => Promise<T>): Promise<ToolPayload<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (err) {
    return normalizeError(err)
  }
}

export function isX402PaymentWindowExpired(state: {
  rail?: string
  status?: string
  phase?: string
  nextAction?: string
}): boolean {
  return state.rail === 'x402' && (state.status === 'expired' || state.phase === 'expired')
}

export function paymentWindowExpiredError(state: {
  paymentId: string
  status: string
  phase: string
  rail: string
  idempotencyKey?: string | null
}): HostedToolError {
  const idempotencyGuidance = state.idempotencyKey
    ? ` Re-quote with haven_pay_mcp_tool using the same idempotency_key (${state.idempotencyKey}).`
    : ' Re-quote with haven_pay_mcp_tool using the same idempotency_key from the original call.'
  return new HostedToolError({
    code: AgentPaymentFailureCode.PaymentWindowExpired,
    message: `The x402 payment window expired before completion.${idempotencyGuidance}`,
    statusCode: 410,
    paymentId: state.paymentId,
    status: state.status,
    phase: state.phase,
    // #3102: which tool to re-run depends on the flow this helper serves
    // (paid-MCP, catalog, plain HTTP), so the step names none; the
    // idempotency key in the message is the argument that matters.
    nextStep: refusalNextStep({
      nextAction: AgentPaymentNextAction.PaymentWindowExpired,
      nextTool: null,
      nextToolOmittedReason:
        're-run the tool you called with the same idempotency_key; which tool depends on the flow (suggested_tool names the MCP one)',
    }),
    rail: state.rail,
    idempotencyKey: state.idempotencyKey,
    retryWithNewQuote: true,
    suggestedTool: 'haven_pay_mcp_tool',
  })
}

export async function paymentWindowExpiredErrorFor(
  haven: HavenClient,
  paymentId: string,
  err: unknown,
): Promise<HostedToolError | null> {
  if (err instanceof HavenPaymentStateError && isX402PaymentWindowExpired(err.state)) {
    return paymentWindowExpiredError(err.state)
  }
  if (!(err instanceof HavenApiError) || err.statusCode !== 410) return null
  try {
    const status = await haven.getPaymentStatus(paymentId)
    if (isX402PaymentWindowExpired(status)) return paymentWindowExpiredError(status)
  } catch {
    // Preserve the original API error if the status lookup cannot confirm this
    // was an x402 funding-window expiry.
  }
  return null
}

/** The `next_tool` family of a NextStep, for the failure envelope (additive, #3101). */
function nextStepWireFields(step: NextStep): Pick<ToolFailure, 'next_tool' | 'next_tool_server' | 'next_tool_name' | 'next_tool_server_role' | 'next_arguments' | 'next_tool_omitted_reason'> {
  return {
    ...(step.next_tool ? { next_tool: step.next_tool } : {}),
    ...(step.next_tool_server ? { next_tool_server: step.next_tool_server } : {}),
    ...(step.next_tool_name ? { next_tool_name: step.next_tool_name } : {}),
    ...(step.next_tool_server_role ? { next_tool_server_role: step.next_tool_server_role } : {}),
    ...(step.next_arguments ? { next_arguments: step.next_arguments } : {}),
    ...(step.next_tool_omitted_reason ? { next_tool_omitted_reason: step.next_tool_omitted_reason } : {}),
  }
}

/** #3102: the typed step for a payment-state refusal, from the per-action default table. */
function stateErrorNextStep(nextAction: string, paymentId: string | undefined): NextStep {
  const action = nextAction as AgentPaymentNextAction
  if (action === AgentPaymentNextAction.CheckStatusLater && paymentId) {
    return refusalNextStep({ nextAction: action, nextTool: 'haven_get_payment_status', nextArguments: { payment_id: paymentId } })
  }
  if (action === AgentPaymentNextAction.SweepStrandedFunds) {
    return refusalNextStep({ nextAction: action, nextTool: 'haven_sweep_delegate', nextArguments: {} })
  }
  if (action === AgentPaymentNextAction.CheckStatusLater) {
    return refusalNextStep({ nextAction: action, nextTool: null, nextToolOmittedReason: 'no payment_id is known for this state, so haven_get_payment_status cannot be named' })
  }
  if (action === AgentPaymentNextAction.RetryOriginalX402Request) {
    return refusalNextStep({ nextAction: action, nextTool: null, nextToolOmittedReason: 'the retry is your own HTTP call with the payment header; haven_resume_x402_payment hands the context back if you lost it' })
  }
  return refusalNextStep({
    nextAction: action,
    nextTool: null,
    nextToolOmittedReason: 'the payment is in a state this tool cannot act on; next_action and message say what can',
  })
}

/** #3416: the backend's `error_code` for a chain this deployment cannot serve a bundler leg on. */
const RAIL_UNAVAILABLE_ERROR_CODE = 'rail_unavailable_for_chain'
const RAIL_UNAVAILABLE_OMITTED_REASON =
  "this Haven deployment cannot serve this chain's payments until its operator provisions it; retrying gets the same answer, so tell the user"

/** #3500: the backend's `error_code` for a payment an open task budget's cap cannot cover. */
const TASK_BUDGET_EXCEEDED_ERROR_CODE = 'task_budget_exceeded'
const TASK_BUDGET_EXCEEDED_OMITTED_REASON =
  "the task budget's cap is spent and is enforced on-chain, so retrying cannot succeed; close it and open a new one, or pay without it, after telling the user"

/** #3504: the backend's `error_code` for a payment the delegation's period budget cannot cover. */
const DELEGATION_BUDGET_EXCEEDED_ERROR_CODE = 'delegation_budget_exceeded'
const DELEGATION_BUDGET_EXCEEDED_OMITTED_REASON =
  "the agent's period budget is spent and is enforced on-chain, so retrying cannot succeed; the wallet owner can raise the budget in Haven or wait for the period to reset; tell the user the remaining and shortfall figures on this failure"

/**
 * #3494: the backend's `error_code` when the delegate account rejected the
 * UserOperation signature during on-chain validation (`POST
 * /payments/:id/sign`, ERC-4337 `AA24 signature error` — the ONE AA2x code
 * this backend attributes to the signer; see `ACCOUNT_VALIDATION_FAILED`
 * below for the rest of the family). The intent is already `failed`; this
 * payment_id has nothing left to resubmit — a NEW payment, signed by a
 * corrected signer, is the only path.
 */
const SIGNATURE_REJECTED_ERROR_CODE = 'signature_rejected'
const SIGNATURE_REJECTED_OMITTED_REASON =
  'the account rejected this signature during on-chain validation; retrying this payment_id cannot succeed — update the signer, then create a NEW payment, after telling the user'

/**
 * #3494 review round 1 (S1): every OTHER ERC-4337 AA2x validation failure —
 * a real `validateUserOp` rejection, but NOT evidence the signature itself
 * is wrong (AA24 alone is `signature_rejected` above). Deliberately never
 * names the signer: the remedy is a new payment, not a signer update.
 */
const ACCOUNT_VALIDATION_FAILED_ERROR_CODE = 'account_validation_failed'
const ACCOUNT_VALIDATION_FAILED_OMITTED_REASON =
  'the account rejected this payment during on-chain validation (not a signature cause); retrying this payment_id cannot succeed — create a new payment, after telling the user'

/**
 * #3494: the backend's `error_code` for every other `POST /payments/:id/sign`
 * on-chain/bundler failure — the one case this route cannot classify as a
 * signature, account-validation or budget cause, INCLUDING a
 * `SubmittedUserOpFailedError` whose `reverted` flag is `true` (round 2,
 * N3): the op executed and reverted is a KNOWN, confirmed outcome (the execution call reverts, so no token transfer and no delegation spend; only the EntryPoint nonce and the paymaster's sponsored gas are consumed), unlike
 * `SUBMISSION_OUTCOME_UNKNOWN` below. Still a failed intent, so still
 * stop-and-tell, never the generic 5xx "retry once" below (there is no live
 * state left on this payment_id for a retry to find).
 */
const ONCHAIN_EXECUTION_FAILED_ERROR_CODE = 'onchain_execution_failed'
const ONCHAIN_EXECUTION_FAILED_OMITTED_REASON =
  'this payment_id already failed on-chain and cannot be retried; tell the user what the message says, and create a new payment if they still want to pay'

/**
 * #3494 review round 1 (B1, double-pay risk), round 2 (B1', N3): the
 * backend's `error_code` when `sendUserOperation` resolved but the receipt
 * wait itself errored or timed out — `SubmittedUserOpFailedError` with
 * `reverted: false` (the default) — so the UserOp MAY have landed, and
 * Haven never learned the outcome. The SAME error class's `reverted: true`
 * case (the op executed and reverted — a KNOWN outcome, no funds moved)
 * answers `ONCHAIN_EXECUTION_FAILED` above instead; this code is strictly
 * the "truly unknown" half.
 *
 * Round 2 (B1'): `next_action` is `stop_and_tell_user`, NOT
 * `check_status_later` — the sign route's `failSubmittedIntent` already
 * marked this intent `failed` BEFORE this response was built, so
 * `haven_get_payment_status` on this same payment_id will answer "failed"
 * immediately and forever. Polling status can never come back "landed";
 * naming it as the next step would read as a promise this code cannot keep,
 * and round 1's wording made exactly that promise ("poll status, pay again
 * once it confirms this one did not settle") — which invites reading the
 * permanent "failed" answer AS that confirmation, and paying again. The
 * honest remedy is a human check against the account's REAL activity (not
 * this payment's own status): Haven's own activity view, or the
 * UserOperation hash on a block explorer.
 */
const SUBMISSION_OUTCOME_UNKNOWN_ERROR_CODE = 'submission_outcome_unknown'

export function normalizeError(err: unknown): ToolFailure {
  if (err instanceof HostedToolError) {
    return {
      success: false,
      code: err.code,
      message: err.message,
      suggested_tool: err.suggestedTool,
      statusCode: err.statusCode,
      paymentId: err.paymentId,
      status: err.status,
      phase: err.phase,
      next_action: err.nextAction,
      rail: err.rail,
      idempotency_key: err.idempotencyKey,
      retry_with_new_quote: err.retryWithNewQuote,
      // #3101: the typed next step rides on refusals exactly as on successes.
      ...(err.nextStep ? nextStepWireFields(err.nextStep) : {}),
    }
  }
  if (err instanceof z.ZodError) {
    return {
      success: false,
      code: 'INVALID_INPUT',
      message: err.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; '),
      statusCode: 400,
    }
  }
  if (err instanceof HavenPaymentStateError) {
    if (isX402PaymentWindowExpired(err.state)) {
      return normalizeError(paymentWindowExpiredError(err.state))
    }
    return {
      success: false,
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
      paymentId: err.paymentId,
      status: err.status,
      phase: err.phase,
      next_action: err.nextAction,
      rail: err.state.rail,
      idempotency_key: err.state.idempotencyKey,
      // #3102: the SDK's state error names an action the backend chose; the
      // step follows decision 9's default table (check_status_later → the
      // status read, sweep_stranded_funds → the sweep) and says why none
      // follows otherwise — so no hosted refusal carries a bare next_action.
      ...nextStepWireFields(stateErrorNextStep(err.nextAction, err.paymentId)),
    }
  }
  // #3416: the backend's typed "this deployment has no bundler credential for
  // this chain" refusal. It is a 5xx (503), but it is NOT transient: retrying
  // gets the same answer until an operator provisions the chain. So it must
  // not fall into the 5xx branch below, which tells the agent to retry once.
  if (
    err instanceof HavenApiError &&
    (err.body as { error_code?: string } | undefined)?.error_code === RAIL_UNAVAILABLE_ERROR_CODE
  ) {
    const step = refusalNextStep({
      nextAction: AgentPaymentNextAction.StopAndTellUser,
      nextTool: null,
      nextToolOmittedReason: RAIL_UNAVAILABLE_OMITTED_REASON,
    })
    return {
      success: false,
      code: 'RAIL_UNAVAILABLE_FOR_CHAIN',
      message: err.message,
      statusCode: err.statusCode,
      paymentId: err.paymentId,
      next_action: step.next_action,
      ...nextStepWireFields(step),
    }
  }
  // #3500: a payment the task budget's cap cannot cover. A 403 would already
  // say stop, but under the generic API_ERROR code; the agent needs to know
  // it is the TASK BUDGET that is spent (so it can close it and open a new
  // one), not the agent's budget, and never to retry.
  if (
    err instanceof HavenApiError &&
    (err.body as { error_code?: string } | undefined)?.error_code === TASK_BUDGET_EXCEEDED_ERROR_CODE
  ) {
    const body = err.body as { task_budget_id?: string; remaining_atomic?: string | null }
    const step = refusalNextStep({
      nextAction: AgentPaymentNextAction.StopAndTellUser,
      nextTool: null,
      nextToolOmittedReason: TASK_BUDGET_EXCEEDED_OMITTED_REASON,
    })
    return {
      success: false,
      code: 'TASK_BUDGET_EXCEEDED',
      message: err.message,
      statusCode: err.statusCode,
      paymentId: err.paymentId,
      ...(body.task_budget_id ? { task_budget_id: body.task_budget_id } : {}),
      ...(body.remaining_atomic !== undefined ? { remaining_atomic: body.remaining_atomic } : {}),
      next_action: step.next_action,
      ...nextStepWireFields(step),
    }
  }
  // #3504: a payment the delegation's period budget cannot cover. The same
  // condition already reached the agent as the catalog path's typed
  // DELEGATION_BUDGET_EXCEEDED refusal (catalog-purchase.ts step 6); every
  // other tool relayed the backend's typed 403 as the generic 4xx API_ERROR
  // below, dropping the backend's own next_action and the remaining/shortfall
  // figures. The backend's body carries the taxonomy field for field on every
  // path that answers it (delegation-authorize.ts both schemes, mpp
  // budget-precheck, the direct POST /payments pre-check), so this branch
  // relays the decision: the body's fund_account_or_raise_allowance step with
  // a reason naming the remedy, and the atomic figures the agent reports.
  if (
    err instanceof HavenApiError &&
    (err.body as { error_code?: string } | undefined)?.error_code === DELEGATION_BUDGET_EXCEEDED_ERROR_CODE
  ) {
    const body = err.body as {
      remaining_atomic?: string | null
      shortfall_atomic?: string | null
      phase?: string
      rail?: string
    }
    const step = refusalNextStep({
      nextAction: AgentPaymentNextAction.FundAccountOrRaiseAllowance,
      nextTool: null,
      nextToolOmittedReason: DELEGATION_BUDGET_EXCEEDED_OMITTED_REASON,
    })
    return {
      success: false,
      code: 'DELEGATION_BUDGET_EXCEEDED',
      message: err.message,
      statusCode: err.statusCode,
      paymentId: err.paymentId,
      ...(body.remaining_atomic !== undefined ? { remaining_atomic: body.remaining_atomic } : {}),
      ...(body.shortfall_atomic !== undefined ? { shortfall_atomic: body.shortfall_atomic } : {}),
      ...(body.phase !== undefined ? { phase: body.phase } : {}),
      ...(body.rail !== undefined ? { rail: body.rail } : {}),
      next_action: step.next_action,
      ...nextStepWireFields(step),
    }
  }
  // #3494: `POST /payments/:id/sign` (every rail it relays, including the
  // EIP-3009 funding leg) now carries a typed `error_code` on its failure
  // 502, which this generic-5xx-means-retry-once branch predates. Each of the
  // four typed codes below (and the two budget codes above) means the intent
  // is ALREADY FAILED —
  // `failSubmittedIntent` booked it on the row before the response was sent
  // — so "retry once" is never the right next step whatever caused it.
  // #3494 review round 1 (B1, double-pay risk), round 2 (B1'): checked
  // BEFORE every other sign-failure branch — this is the one case where
  // "create a new payment" is the WRONG instruction, because the submitted
  // UserOp may have landed. `next_action` is `stop_and_tell_user`, NOT
  // `check_status_later`: the backend already marked this intent `failed`
  // before answering, so `haven_get_payment_status` on this same
  // payment_id would answer "failed" forever and can never confirm the
  // outcome — naming it would promise a resolution this code cannot
  // deliver. See the constant's own doc comment for the full reasoning.
  if (
    err instanceof HavenApiError &&
    (err.body as { error_code?: string } | undefined)?.error_code === SUBMISSION_OUTCOME_UNKNOWN_ERROR_CODE
  ) {
    const body = err.body as { payment_id?: string; user_op_hash?: string }
    const userOpHashClause = body.user_op_hash
      ? `UserOperation ${body.user_op_hash}`
      : 'the UserOperation hash'
    const reason =
      'The payment was submitted but its on-chain outcome is unknown — it may have moved funds even ' +
      'though Haven recorded it as failed. Do NOT create a new payment. Tell the user to check the ' +
      `account's activity in Haven (or ${userOpHashClause} on a block explorer) before paying again.`
    const step = refusalNextStep({
      nextAction: AgentPaymentNextAction.StopAndTellUser,
      nextTool: null,
      nextToolOmittedReason: reason,
    })
    return {
      success: false,
      code: 'SUBMISSION_OUTCOME_UNKNOWN',
      message: err.message,
      statusCode: err.statusCode,
      paymentId: body.payment_id,
      next_action: step.next_action,
      ...nextStepWireFields(step),
    }
  }
  if (
    err instanceof HavenApiError &&
    (err.body as { error_code?: string } | undefined)?.error_code === ACCOUNT_VALIDATION_FAILED_ERROR_CODE
  ) {
    const step = refusalNextStep({
      nextAction: AgentPaymentNextAction.StopAndTellUser,
      nextTool: null,
      nextToolOmittedReason: ACCOUNT_VALIDATION_FAILED_OMITTED_REASON,
    })
    return {
      success: false,
      code: 'ACCOUNT_VALIDATION_FAILED',
      message: err.message,
      statusCode: err.statusCode,
      paymentId: err.paymentId,
      next_action: step.next_action,
      ...nextStepWireFields(step),
    }
  }
  if (
    err instanceof HavenApiError &&
    (err.body as { error_code?: string } | undefined)?.error_code === SIGNATURE_REJECTED_ERROR_CODE
  ) {
    const step = refusalNextStep({
      nextAction: AgentPaymentNextAction.StopAndTellUser,
      nextTool: null,
      nextToolOmittedReason: SIGNATURE_REJECTED_OMITTED_REASON,
    })
    return {
      success: false,
      code: 'SIGNATURE_REJECTED',
      message: err.message,
      statusCode: err.statusCode,
      paymentId: err.paymentId,
      next_action: step.next_action,
      ...nextStepWireFields(step),
    }
  }
  if (
    err instanceof HavenApiError &&
    (err.body as { error_code?: string } | undefined)?.error_code === ONCHAIN_EXECUTION_FAILED_ERROR_CODE
  ) {
    const step = refusalNextStep({
      nextAction: AgentPaymentNextAction.StopAndTellUser,
      nextTool: null,
      nextToolOmittedReason: ONCHAIN_EXECUTION_FAILED_OMITTED_REASON,
    })
    return {
      success: false,
      code: 'ONCHAIN_EXECUTION_FAILED',
      message: err.message,
      statusCode: err.statusCode,
      paymentId: err.paymentId,
      next_action: step.next_action,
      ...nextStepWireFields(step),
    }
  }
  if (err instanceof HavenApiError) {
    // #3214: the #3102 rule — no hosted refusal carries a bare next_action —
    // now covers the generic branches too. A 5xx (or status-less) upstream
    // answer is usually transient — the live 500 that filed this re-ran the
    // same quote with the same arguments and succeeded — so the step says
    // retry the same call once; no tool is named because normalizeError sees
    // every tool's errors (the message and the agent's own last call say
    // which), and the idempotency key, where the tool has one, must not
    // change. A 4xx is the call refused as made: retrying it the same way
    // cannot succeed.
    const step =
      err.statusCode !== undefined && err.statusCode < 500
        ? refusalNextStep({
            nextAction: AgentPaymentNextAction.StopAndTellUser,
            nextTool: null,
            nextToolOmittedReason:
              'the upstream call was refused as made (4xx); re-calling it the same way cannot succeed, so tell the user what failed',
          })
        : refusalNextStep({
            nextAction: AgentPaymentNextAction.RetryWithExplicitContext,
            nextTool: null,
            nextToolOmittedReason:
              'the upstream call failed transiently; re-call the same tool with the same arguments (and the same idempotency_key where the tool has one) once before telling the user',
          })
    return {
      success: false,
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
      paymentId: err.paymentId,
      next_action: step.next_action,
      ...nextStepWireFields(step),
    }
  }
  if (err instanceof HavenError) {
    return {
      success: false,
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
      paymentId: err.paymentId,
      // #3214: a client-side Haven failure (no upstream answer to retry) —
      // the step says stop rather than send the agent into a doomed retry.
      next_action: AgentPaymentNextAction.StopAndTellUser,
      ...nextStepWireFields(
        refusalNextStep({
          nextAction: AgentPaymentNextAction.StopAndTellUser,
          nextTool: null,
          nextToolOmittedReason:
            'the client failed before an upstream answer (code and message say how); re-calling it the same way will fail the same way, so tell the user',
        }),
      ),
    }
  }
  return {
    success: false,
    code: 'UNKNOWN_ERROR',
    message: err instanceof Error ? err.message : String(err),
    // #3214: even a refusal with no code or status carries the family —
    // the agent is told to stop instead of reading the dead end as an answer.
    next_action: AgentPaymentNextAction.StopAndTellUser,
    ...nextStepWireFields(
      refusalNextStep({
        nextAction: AgentPaymentNextAction.StopAndTellUser,
        nextTool: null,
        nextToolOmittedReason:
          'the failure had no recognizable shape (no code, no status); re-calling it the same way will fail the same way, so tell the user',
      }),
    ),
  }
}
