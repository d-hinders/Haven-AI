import { AgentPaymentFailureCode, AgentPaymentNextAction, HavenApiError, HavenError } from '@haven_ai/sdk'
import type { HostedToolError } from '../tools/support/errors.js'
import { paymentStatusHandoff, refusalNextStep } from '../tools/support/guidance.js'

/**
 * #3101–#3104: the hosted next-step FIXTURES, one per emission site — the
 * 17 `buildAgentGuidance` sites (`EMISSION_SITES`) and the 35 refusal steps
 * (`REFUSAL_SITES`: 31 site-thrown `HostedToolError`s plus the 4 generic
 * `normalizeError` branches #3214 added). Owned here so the characterization
 * tests and the cross-package parity walk read one list; the census constants
 * live beside their tests.
 */
const SIGNER = (name: string) => ({
  next_tool: `mcp__haven-signer__${name}`,
  next_tool_server: 'haven-signer',
  next_tool_name: name,
  next_tool_server_role: 'signer',
})
const HOSTED = (name: string) => ({
  next_tool: `mcp__haven__${name}`,
  next_tool_server: 'haven',
  next_tool_name: name,
  next_tool_server_role: 'hosted',
})

/**
 * `buildAgentGuidance(` call sites in the hosted non-test source — the
 * census `next-step-characterization.test.ts` enforces. #3475 follow-up
 * review round 1 (S3) added one: the missing-settlement-hash success no-op
 * that used to be a `refusalNextStep(` site. #3495 review round 1 (S5) adds
 * TWO more: `respondToNoSignDataReplay` in `state-direct-recovery.ts`
 * (shared by `haven_send`/`haven_pay`'s no-sign-data replay guard) is
 * written as two full call sites — confirmed and still-resolving — rather
 * than one call with a conditional spread, because `lint:next-steps`
 * requires a handoff to be named at the emission's OWN top level; a handoff
 * hidden behind a ternary spread reads as unnamed. #3529 adds one: the
 * reason-bearing evidence-refusal arm — a refused report whose backend
 * relayed a `reason` (only the eip3009 settlement seam emits one) is its
 * own emission, keyed on the reason's PRESENCE, never on payment status.
 * #3527 adds TWO more: `eip3009ConfirmedReplayResponse` (`guidance.ts`) is
 * the EIP-3009 twin of `settledReplayResponse` for a confirmed
 * `createX402Intent` replay, and it is two full call sites of its own
 * (merchant-leg verified/reported → done; otherwise → the #2290 remedy),
 * shared by `haven_prepare_catalog_purchase` step 9 and
 * `haven_pay_mcp_tool`'s 3009 branch.
 */
export const EMISSION_SITE_COUNT = 26
/**
 * Fixtures for those sites: the held-hash site has two branches, the three
 * null-id sites share one helper, the report-outcome accepted site has two
 * branches of its own (offer settlement evidence, or not — #3475
 * follow-up), the missing-settlement-hash success no-op is its own site
 * (#3475 follow-up review round 1, S3), and the no-sign-data replay guard
 * (#3495 review round 1, S5) is two full sites of its own (confirmed / still
 * resolving) — one fixture each, matching the two call sites. #3529 adds
 * one (the reason-bearing evidence-refusal arm). #3527 adds two more:
 * `eip3009ConfirmedReplayResponse`'s done-state and
 * funded-awaiting-merchant-remedy branches, one fixture each.
 */
export const EMISSION_FIXTURE_COUNT = 30

export const EMISSION_SITES = [
  { site: 'catalog-purchase.ts prepare erc7710', action: AgentPaymentNextAction.SignAndSubmitPayment, tool: 'haven_sign', args: { payment_id: 'pay_1' }, expect: { ...SIGNER('haven_sign'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'catalog-purchase.ts prepare 3009', action: AgentPaymentNextAction.SignAndSubmitPayment, tool: 'haven_sign_x402', args: { payment_id: 'pay_1' }, expect: { ...SIGNER('haven_sign_x402'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'catalog-purchase.ts prepare window-expired (payment_id unknown)', action: AgentPaymentNextAction.StopAndTellUser, handoff: paymentStatusHandoff(undefined), expect: { next_tool_omitted_reason: 'no payment_id is known for this refusal, so haven_get_payment_status cannot be named; nothing was funded or signed' } } /* RE-DECIDED: was next_tool + { payment_id: null } */,
  { site: 'catalog-purchase.ts pay erc7710', action: AgentPaymentNextAction.SignAndSubmitPayment, tool: 'haven_sign', args: { payment_id: 'pay_1' }, expect: { ...SIGNER('haven_sign'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'catalog-purchase.ts pay 3009', action: AgentPaymentNextAction.SignAndSubmitPayment, tool: 'haven_sign_x402', args: { payment_id: 'pay_1' }, expect: { ...SIGNER('haven_sign_x402'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'catalog-purchase.ts pay window-expired (payment_id unknown)', action: AgentPaymentNextAction.StopAndTellUser, handoff: paymentStatusHandoff(undefined), expect: { next_tool_omitted_reason: 'no payment_id is known for this refusal, so haven_get_payment_status cannot be named; nothing was funded or signed' } } /* RE-DECIDED: was next_tool + { payment_id: null } */,
  { site: 'plain-http-x402.ts pay erc7710', action: AgentPaymentNextAction.SignAndSubmitPayment, tool: 'haven_sign', args: { payment_id: 'pay_1' }, expect: { ...SIGNER('haven_sign'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'plain-http-x402.ts pay 3009', action: AgentPaymentNextAction.SignAndSubmitPayment, tool: 'haven_sign_x402', args: { payment_id: 'pay_1' }, expect: { ...SIGNER('haven_sign_x402'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'plain-http-x402.ts pay window-expired (payment_id unknown)', action: AgentPaymentNextAction.StopAndTellUser, handoff: paymentStatusHandoff(undefined), expect: { next_tool_omitted_reason: 'no payment_id is known for this refusal, so haven_get_payment_status cannot be named; nothing was funded or signed' } } /* RE-DECIDED: was next_tool + { payment_id: null } */,
  { site: 'plain-http-x402.ts report outcome rejected', action: AgentPaymentNextAction.SweepStrandedFunds, tool: 'haven_sweep_delegate', args: {}, expect: { ...HOSTED('haven_sweep_delegate'), next_arguments: {} } },
  { site: 'plain-http-x402.ts report outcome accepted, no settlement offer (no tool)', action: AgentPaymentNextAction.None, tool: null, reason: 'the merchant accepted the paid retry; the purchase is complete and no Haven tool follows', expect: { next_tool_omitted_reason: 'the merchant accepted the paid retry; the purchase is complete and no Haven tool follows' } } /* RE-DECIDED: additive reason, no tool before either */,
  // #3475 follow-up: an eip3009 acceptance with no merchant settlement recorded yet names haven_report_settlement_evidence, payment_id only — see the owner decision in plain-http-x402.ts.
  // Review round 1 (S1): next_action stays None here (the same fallback the
  // "no settlement offer" branch above uses) — the offer rides next_tool /
  // next_arguments / reason only, so AgentPaymentNextAction.AwaitingSettlementEvidence's
  // published meaning (an erc7710 payment past its settlement window) is
  // never reused for a different fact.
  { site: 'plain-http-x402.ts report outcome accepted, eip3009 unsettled (offer settlement evidence)', action: AgentPaymentNextAction.None, tool: 'haven_report_settlement_evidence', args: { payment_id: 'pay_1' }, expect: { ...HOSTED('haven_report_settlement_evidence'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'paid-mcp-completion.ts pending', action: AgentPaymentNextAction.CheckStatusLater, tool: 'haven_get_payment_status', args: { payment_id: 'pay_1' }, expect: { ...HOSTED('haven_get_payment_status'), next_arguments: { payment_id: 'pay_1' } } },
  // #3529: the reason-bearing evidence refusal is its own arm — keyed on the
  // relayed reason's PRESENCE (only the eip3009 settlement seam emits one),
  // never on payment status. Same poll-status handoff as the pending arm.
  { site: 'paid-mcp-completion.ts report settlement evidence: reason-bearing refusal', action: AgentPaymentNextAction.CheckStatusLater, tool: 'haven_get_payment_status', args: { payment_id: 'pay_1' }, expect: { ...HOSTED('haven_get_payment_status'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'paid-mcp-completion.ts settle held-hash, can report', action: AgentPaymentNextAction.CheckStatusLater, tool: 'haven_report_settlement_evidence', args: { payment_id: 'pay_1', settlement_tx_hash: '0x' + 'ab'.repeat(32) }, expect: { ...HOSTED('haven_report_settlement_evidence'), next_arguments: { payment_id: 'pay_1', settlement_tx_hash: '0x' + 'ab'.repeat(32) } } },
  { site: 'paid-mcp-completion.ts settle held-hash, cannot report', action: AgentPaymentNextAction.CheckStatusLater, tool: 'haven_get_payment_status', args: { payment_id: 'pay_1' }, expect: { ...HOSTED('haven_get_payment_status'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'paid-mcp-completion.ts settle funding pending', action: AgentPaymentNextAction.CheckStatusLater, tool: 'haven_get_payment_status', args: { payment_id: 'pay_1' }, expect: { ...HOSTED('haven_get_payment_status'), next_arguments: { payment_id: 'pay_1' } } },
  // #3475 follow-up review round 1 (S3): a call with no settlement_tx_hash is a SUCCESS no-op, not a refusal — moved here from REFUSAL_SITES.
  { site: 'paid-mcp-completion.ts report settlement evidence: no hash supplied (success no-op)', action: AgentPaymentNextAction.None, tool: null, reason: 'no settlement hash was supplied; nothing was checked or recorded', expect: { next_tool_omitted_reason: 'no settlement hash was supplied; nothing was checked or recorded' } },
  // The four no-tool sites (no `nextTool:` line before #3101; the required input surfaced them).
  { site: 'paid-mcp-completion.ts complete settled', action: AgentPaymentNextAction.None, tool: null, reason: 'the purchase is settled; no Haven tool follows', expect: { next_tool_omitted_reason: 'the purchase is settled; no Haven tool follows' } } /* RE-DECIDED: additive reason */,
  { site: 'paid-mcp-completion.ts settle erc7710 settled', action: AgentPaymentNextAction.None, tool: null, reason: 'the purchase is settled; no Haven tool follows', expect: { next_tool_omitted_reason: 'the purchase is settled; no Haven tool follows' } } /* RE-DECIDED: additive reason */,
  { site: 'paid-mcp-completion.ts settle 3009 settled', action: AgentPaymentNextAction.None, tool: null, reason: 'the purchase is settled; no Haven tool follows', expect: { next_tool_omitted_reason: 'the purchase is settled; no Haven tool follows' } } /* RE-DECIDED: additive reason */,
  // #3417: the settled idempotent replay of an erc7710 prepare (shared by the three prepare sites via catchSettledReplay).
  { site: 'guidance.ts settled idempotent replay (no tool)', action: AgentPaymentNextAction.None, tool: null, reason: 'this idempotency_key already settled; there is nothing left to sign, settle or pay', expect: { next_tool_omitted_reason: 'this idempotency_key already settled; there is nothing left to sign, settle or pay' } },
  // #3423: the settle-side variant of the same builder (a repeated haven_settle_mcp_tool); same call site, its own reason.
  { site: 'guidance.ts settled re-settle (no tool)', action: AgentPaymentNextAction.None, tool: null, reason: 'this payment already settled; there is nothing left to sign, settle or pay', expect: { next_tool_omitted_reason: 'this payment already settled; there is nothing left to sign, settle or pay' } },
  { site: 'state-direct-recovery.ts own HTTP retry', action: AgentPaymentNextAction.RetryOriginalX402Request, tool: null, reason: 'the next step is your own HTTP retry of the merchant with the payment_header above, not a Haven tool', expect: { next_tool_omitted_reason: 'the next step is your own HTTP retry of the merchant with the payment_header above, not a Haven tool' } } /* RE-DECIDED: additive reason */,
  // #3277: haven_send / haven_pay success — the direct-payment byte-free handoff, always named (refusal recovery, the #1547 pattern; signer_compatibility rides the result alongside these fields and stays off this next-step census).
  { site: 'state-direct-recovery.ts haven_send success', action: AgentPaymentNextAction.SignAndSubmitPayment, tool: 'haven_sign', args: { payment_id: 'pay_1' }, expect: { ...SIGNER('haven_sign'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'state-direct-recovery.ts haven_pay success', action: AgentPaymentNextAction.SignAndSubmitPayment, tool: 'haven_sign', args: { payment_id: 'pay_1' }, expect: { ...SIGNER('haven_sign'), next_arguments: { payment_id: 'pay_1' } } },
  // #3495 review S5: a same-key replay of an already-progressed payment
  // (no sign_data at all) — respondToNoSignDataReplay, shared by both
  // haven_send and haven_pay, so it is ONE source call site with two
  // branches: confirmed (no tool follows) and still-resolving (poll status).
  { site: 'state-direct-recovery.ts no-sign-data replay: confirmed (no tool)', action: AgentPaymentNextAction.None, tool: null, reason: 'this idempotency_key already settled; there is nothing left to sign', expect: { next_tool_omitted_reason: 'this idempotency_key already settled; there is nothing left to sign' } },
  { site: 'state-direct-recovery.ts no-sign-data replay: still resolving', action: AgentPaymentNextAction.CheckStatusLater, tool: 'haven_get_payment_status', args: { payment_id: 'pay_1' }, expect: { ...HOSTED('haven_get_payment_status'), next_arguments: { payment_id: 'pay_1' } } },
  // #3527: guidance.ts's eip3009ConfirmedReplayResponse — the EIP-3009 twin of the erc7710 settled-replay answer, shared by haven_prepare_catalog_purchase step 9 and haven_pay_mcp_tool's 3009 branch.
  { site: 'guidance.ts eip3009 confirmed replay: merchant leg verified/reported (no tool)', action: AgentPaymentNextAction.None, tool: null, reason: 'this idempotency_key already funded this payment and the merchant leg is recorded; there is nothing left to sign or pay', expect: { next_tool_omitted_reason: 'this idempotency_key already funded this payment and the merchant leg is recorded; there is nothing left to sign or pay' } },
  { site: 'guidance.ts eip3009 confirmed replay: funded-awaiting-merchant (poll status)', action: AgentPaymentNextAction.RetryOriginalX402Request, tool: 'haven_get_payment_status', args: { payment_id: 'pay_1' }, expect: { ...HOSTED('haven_get_payment_status'), next_arguments: { payment_id: 'pay_1' } } },
] as const


const A = AgentPaymentNextAction
const F = AgentPaymentFailureCode
/** #3416: pinned verbatim here, not imported, so a reworded reason reddens the fixture. */
const RAIL_UNAVAILABLE_OMITTED_REASON =
  "this Haven deployment cannot serve this chain's payments until its operator provisions it; retrying gets the same answer, so tell the user"
/** #3500: pinned verbatim, not imported, so a reworded reason reddens the fixture. */
const TASK_BUDGET_EXCEEDED_OMITTED_REASON =
  "the task budget's cap is spent and is enforced on-chain, so retrying cannot succeed; close it and open a new one, or pay without it, after telling the user"
/** #3504: pinned verbatim, not imported, so a reworded reason reddens the fixture. */
const DELEGATION_BUDGET_EXCEEDED_OMITTED_REASON =
  "the agent's period budget is spent and is enforced on-chain, so retrying cannot succeed; the wallet owner can raise the budget in Haven or wait for the period to reset; tell the user the remaining and shortfall figures on this failure"
/** #3494: pinned verbatim, not imported, so a reworded reason reddens the fixture. */
const SIGNATURE_REJECTED_OMITTED_REASON =
  'the account rejected this signature during on-chain validation; retrying this payment_id cannot succeed — update the signer, then create a NEW payment, after telling the user'
/** #3494: pinned verbatim, not imported, so a reworded reason reddens the fixture. */
const ONCHAIN_EXECUTION_FAILED_OMITTED_REASON =
  'this payment_id already failed on-chain and cannot be retried; tell the user what the message says, and create a new payment if they still want to pay'
/** #3609: pinned verbatim here, not imported, so a reworded reason reddens the fixture. */
const PREPARE_REVERTED_OMITTED_REASON =
  'the payment reverted during on-chain simulation (see revert_reason); nothing was signed or moved and retrying the same payment reverts again — tell the user the reason; a budget, recipient or expiry caveat is changed by the wallet owner in Haven'
/** #3731: pinned verbatim, not imported, so a reworded reason reddens the fixture. */
const PREPARE_REVERTED_FUNDING_OMITTED_REASON =
  'the account does not hold enough of the token to fund this payment; the revert already proves the shortfall and the body carries no token or amount to check with — tell the user the account needs funds, and the payment can be re-made once it is funded'
/** #3494 review round 1 (S1): pinned verbatim, not imported, so a reworded reason reddens the fixture. */
const ACCOUNT_VALIDATION_FAILED_OMITTED_REASON =
  'the account rejected this payment during on-chain validation (not a signature cause); retrying this payment_id cannot succeed — create a new payment, after telling the user'
/** #3564: pinned verbatim, not imported, so a reworded reason reddens the fixture (the no-payment_id arm). */
const SUBMISSION_OUTCOME_UNKNOWN_OMITTED_REASON =
  'the payment was submitted but its on-chain outcome is not known yet, and no payment id is available to poll; do not create a new payment for this — tell the user, who can check the account\'s activity or the userOpHash before paying again'
const RETRY = 're-call the same tool with the explicit context this message names; no tool can be named until you supply it'
const STOP = 'the user has to decide before anything is called again'
const STOP_SUG = 'the user has to decide before anything is called again; suggested_tool names the tool for after that'
// #3214: the generic branches' reasons — byte-identical to errors.ts, which the registry walk enforces.
const RETRY_API = 'the upstream call failed transiently; re-call the same tool with the same arguments (and the same idempotency_key where the tool has one) once before telling the user'
const STOP_API = 'the upstream call was refused as made (4xx); re-calling it the same way cannot succeed, so tell the user what failed'
const STOP_HAVEN = 'the client failed before an upstream answer (code and message say how); re-calling it the same way will fail the same way, so tell the user'
const STOP_UNKNOWN = 'the failure had no recognizable shape (no code, no status); re-calling it the same way will fail the same way, so tell the user'
const STATUS = (id: string) => ({ next_tool: 'mcp__haven__haven_get_payment_status', next_tool_server: 'haven', next_tool_name: 'haven_get_payment_status', next_tool_server_role: 'hosted', next_arguments: { payment_id: id } })
const OMIT = (reason: string) => ({ next_tool_omitted_reason: reason })

type Base = Omit<ConstructorParameters<typeof HostedToolError>[0], 'nextStep'>
type Site = {
  site: string
  base: Base
  step: Parameters<typeof refusalNextStep>[0] | 'window-expired-helper'
  expect: { next_action: string; suggested_tool?: string } & Record<string, unknown>
  /**
   * #3214: a GENERIC `normalizeError` branch — no site throws a
   * `HostedToolError` here; the test throws THIS instead. `base`/`step`
   * mirror the branch's literal for the reader and are unused when set.
   */
  thrown?: unknown
}

/**
 * Refusal fixtures: 33 site-thrown `HostedToolError` rows (the eip3009
 * rejection carrying a live-state branch) + the 7 generic `normalizeError`
 * branches (the HavenApiError 4xx/5xx pair, `HavenError` and UNKNOWN_ERROR
 * from #3214, #3416's typed rail-unavailable branch, #3500's typed
 * task-budget-exceeded branch and #3504's typed delegation-budget-exceeded
 * branch — the last three no site throws; the test throws the typed
 * `HavenApiError` the branch reads).
 * #3475 follow-up review round 1 (S3): the missing-settlement-hash case is a
 * SUCCESS no-op, not a refusal — its fixture moved to `EMISSION_SITES`.
 */
export const REFUSAL_SITE_COUNT = 48
/** `refusalNextStep(` calls in the hosted source: 30 inline site steps + rejectedAfterFundingStep's 3 + stateErrorNextStep's 5 (round 3 of #3126 migrated the three check_funds cap refusals onto the builder; #3213 added the symbol-resolution refusal) + #3214's 4 in normalizeError (the HavenApiError 4xx/5xx pair, HavenError, UNKNOWN_ERROR) + #3329's 3 (task-budgets.ts's unresolvable-token and over-precise-amount refusals, and state-direct-recovery.ts's haven_submit payment_id/task_budget_id/sub_budget_id exactly-one refusal (#3506 widened it to three ids; still one refusalNextStep site)) + #3423's 1 (catalog-entry.ts's http-row refusal, split out of the combined mcp-row check) + #3416's 1 in normalizeError (the typed rail_unavailable_for_chain 503) + #3500's 1 in normalizeError (the typed task_budget_exceeded 403) + #3504's 1 in normalizeError (the typed delegation_budget_exceeded 403). + #3506 review S2's 2 (state-direct-recovery.ts haven_submit sub_budget_id: the close_needs_reprepare and close_outcome_unconfirmed recovery refusals). + #3494's 2 in normalizeError (the typed signature_rejected and onchain_execution_failed 502s on `POST /payments/:id/sign`) + #3494 review round 1's 1 more in normalizeError (the typed account_validation_failed 502 on the same route). + #3564's 2 in normalizeError (the typed submission_outcome_unknown 502, replacing #3494 round 2's one stop-only arm: the payment_id arm names the status read, the no-id arm stops — no id to poll, so check_status_later's default tool is uncallable). + #3609's 1 in normalizeError (the typed prepare_reverted 502 on `POST /payments` and the x402 funding leg). + #3731's 1 more in the same branch (the insufficient-balance arm of the typed prepare_reverted 502 — the funding step beside the caveat stop). + #3747's 7 (the merchant-egress refusal sites: mcp-context's pre-intent quote/probe refusal, plain-http-x402's pre-funding refusal, and paid-mcp-completion's delivery-time refusal branches). + 1 in identity-gate.ts (the hosted dispatch gate's rejected-key refusal). */
export const REFUSAL_STEP_CALLS = 66

export const REFUSAL_SITES: Site[] = [
  { site: 'catalog-purchase.ts prepare: allowance short', base: { code: 'INSUFFICIENT_ALLOWANCE', message: 'm', statusCode: 402, suggestedTool: 'haven_get_allowances' }, step: { nextAction: A.FundAccountOrRaiseAllowance, nextTool: null, nextToolOmittedReason: 'the account needs funds or a higher allowance first; haven_get_allowances shows the numbers' }, expect: { next_action: 'fund_account_or_raise_allowance', suggested_tool: 'haven_get_allowances', ...OMIT('the account needs funds or a higher allowance first; haven_get_allowances shows the numbers') } },
  { site: 'paid-mcp-completion.ts merchant context: half-explicit pair', base: { code: 'INVALID_INPUT', message: 'm', statusCode: 400, paymentId: 'pay_1', status: 'invalid_input', phase: 'not_started' }, step: { nextAction: A.RetryWithExplicitContext, nextTool: null, nextToolOmittedReason: RETRY }, expect: { next_action: 'retry_with_explicit_context', ...OMIT(RETRY) } },
  { site: 'paid-mcp-completion.ts merchant context: unavailable', base: { code: F.MerchantCallContextUnavailable, message: 'm', statusCode: 409, paymentId: 'pay_1' }, step: { nextAction: A.RetryWithExplicitContext, nextTool: null, nextToolOmittedReason: RETRY }, expect: { next_action: 'retry_with_explicit_context', ...OMIT(RETRY) } },
  { site: 'paid-mcp-completion.ts window expired (helper)', base: { code: F.PaymentWindowExpired, message: 'm' }, step: 'window-expired-helper', expect: { next_action: 'payment_window_expired', suggested_tool: 'haven_pay_mcp_tool', ...OMIT('re-run the tool you called with the same idempotency_key; which tool depends on the flow (suggested_tool names the MCP one)') } },
  { site: 'paid-mcp-completion.ts timeout erc7710', base: { code: F.MerchantUnresponsiveAfterFunding, message: 'm', statusCode: 504, paymentId: 'pay_1', status: 'merchant_unresponsive_after_funding', phase: 'not_delivered', rail: 'erc7710', suggestedTool: 'haven_get_payment_status' }, step: { nextAction: A.CheckStatusLater, nextTool: 'haven_get_payment_status', nextArguments: { payment_id: 'pay_1' } }, expect: { next_action: 'check_status_later', suggested_tool: 'haven_get_payment_status', ...STATUS('pay_1') } },
  { site: 'paid-mcp-completion.ts timeout eip3009', base: { code: F.MerchantUnresponsiveAfterFunding, message: 'm', statusCode: 504, paymentId: 'pay_1', status: 'merchant_unresponsive_after_funding', phase: 'funded_but_unsettled', rail: 'x402', suggestedTool: 'haven_get_payment_status' }, step: { nextAction: A.SweepStrandedFunds, nextTool: 'haven_get_payment_status', nextArguments: { payment_id: 'pay_1' } }, expect: { next_action: 'sweep_stranded_funds', suggested_tool: 'haven_get_payment_status', ...STATUS('pay_1') } },
  { site: 'paid-mcp-completion.ts insecure target erc7710', base: { code: 'INSECURE_RETRY_TARGET', message: 'm', statusCode: 400, paymentId: 'pay_1', phase: 'not_delivered', rail: 'erc7710', suggestedTool: 'haven_quote_mcp_tool' }, step: { nextAction: A.RetryWithExplicitContext, nextTool: null, nextToolOmittedReason: 're-quote the merchant at its https URL; nothing moved' }, expect: { next_action: 'retry_with_explicit_context', suggested_tool: 'haven_quote_mcp_tool', ...OMIT('re-quote the merchant at its https URL; nothing moved') } },
  { site: 'paid-mcp-completion.ts insecure target eip3009', base: { code: 'INSECURE_RETRY_TARGET', message: 'm', statusCode: 400, paymentId: 'pay_1', phase: 'funded_but_unsettled', rail: 'x402', suggestedTool: 'haven_get_payment_status' }, step: { nextAction: A.SweepStrandedFunds, nextTool: 'haven_sweep_delegate', nextArguments: {} }, expect: { next_action: 'sweep_stranded_funds', suggested_tool: 'haven_get_payment_status', next_tool: 'mcp__haven__haven_sweep_delegate', next_tool_server: 'haven', next_tool_name: 'haven_sweep_delegate', next_tool_server_role: 'hosted', next_arguments: {} } },
  { site: 'paid-mcp-completion.ts rejected after funding: merchant not ready', base: { code: F.MerchantRejectedAfterFunding, message: 'm', statusCode: 503, paymentId: 'pay_1', status: 'merchant_rejected_after_funding', phase: 'not_delivered', rail: 'erc7710', retryWithNewQuote: true }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: 'the merchant is not ready to settle; tell the user and re-quote later' }, expect: { next_action: 'stop_and_tell_user', ...OMIT('the merchant is not ready to settle; tell the user and re-quote later') } },
  { site: 'paid-mcp-completion.ts rejected after funding: erc7710', base: { code: F.MerchantRejectedAfterFunding, message: 'm', statusCode: 402, paymentId: 'pay_1', status: 'merchant_rejected_after_funding', phase: 'not_delivered', suggestedTool: 'haven_get_payment_status', rail: 'erc7710', retryWithNewQuote: true }, step: { nextAction: A.CheckStatusLater, nextTool: 'haven_get_payment_status', nextArguments: { payment_id: 'pay_1' } }, expect: { next_action: 'check_status_later', suggested_tool: 'haven_get_payment_status', ...STATUS('pay_1') } },
  { site: 'paid-mcp-completion.ts rejected after funding: eip3009', base: { code: F.MerchantRejectedAfterFunding, message: 'm', statusCode: 402, paymentId: 'pay_1', status: 'merchant_rejected_after_funding', phase: 'funded_but_unsettled', suggestedTool: 'haven_sweep_delegate' }, step: { nextAction: A.SweepStrandedFunds, nextTool: 'haven_sweep_delegate', nextArguments: {} }, expect: { next_action: 'sweep_stranded_funds', suggested_tool: 'haven_sweep_delegate', next_tool: 'mcp__haven__haven_sweep_delegate', next_tool_server: 'haven', next_tool_name: 'haven_sweep_delegate', next_tool_server_role: 'hosted', next_arguments: {} } },
  { site: 'paid-mcp-completion.ts rejected after funding: eip3009, live state is not a sweep', base: { code: F.MerchantRejectedAfterFunding, message: 'm', statusCode: 402, paymentId: 'pay_1', status: 'funded_but_unsettled', phase: 'funded_but_unsettled', suggestedTool: 'haven_sweep_delegate' }, step: { nextAction: A.RetryOriginalX402Request, nextTool: 'haven_get_payment_status', nextArguments: { payment_id: 'pay_1' } }, expect: { next_action: 'retry_original_x402_request', suggested_tool: 'haven_sweep_delegate', ...STATUS('pay_1') } },
  { site: 'paid-mcp-completion.ts header preflight', base: { code: 'INVALID_PAYMENT_HEADER', message: 'm', statusCode: 400, paymentId: 'pay_1', status: 'invalid_payment_header', phase: 'not_started', suggestedTool: 'haven_sign_x402' }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP_SUG }, expect: { next_action: 'stop_and_tell_user', suggested_tool: 'haven_sign_x402', ...OMIT(STOP_SUG) } },
  { site: 'plain-http-x402.ts pay: insecure target', base: { code: 'INSECURE_RETRY_TARGET', message: 'm', statusCode: 400 }, step: { nextAction: A.RetryWithExplicitContext, nextTool: null, nextToolOmittedReason: 're-call with the https URL you quoted as url; nothing was funded or signed' }, expect: { next_action: 'retry_with_explicit_context', ...OMIT('re-call with the https URL you quoted as url; nothing was funded or signed') } },
  { site: 'plain-http-x402.ts pay: erc7710-only merchant on a 3009 account', base: { code: 'ERC7710_ONLY', message: 'm', statusCode: 400, suggestedTool: 'haven_quote_x402' }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP_SUG }, expect: { next_action: 'stop_and_tell_user', suggested_tool: 'haven_quote_x402', ...OMIT(STOP_SUG) } },
  { site: 'plain-http-x402.ts resume: insecure target', base: { code: 'INSECURE_RETRY_TARGET', message: 'm', statusCode: 400, paymentId: 'pay_1', phase: 'funded_but_unsettled', suggestedTool: 'haven_get_payment_status' }, step: { nextAction: A.RetryWithExplicitContext, nextTool: null, nextToolOmittedReason: 're-call with the https URL you originally quoted as url; the status and sweep exits are in the message' }, expect: { next_action: 'retry_with_explicit_context', suggested_tool: 'haven_get_payment_status', ...OMIT('re-call with the https URL you originally quoted as url; the status and sweep exits are in the message') } },
  { site: 'cap-price.ts invalid max_amount', base: { code: 'INVALID_MAX_AMOUNT', message: 'm', statusCode: 400 }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP }, expect: { next_action: 'stop_and_tell_user', ...OMIT(STOP) } },
  { site: 'cap-price.ts price exceeds max', base: { code: F.PriceExceedsMax, message: 'm', statusCode: 402 }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP }, expect: { next_action: 'stop_and_tell_user', ...OMIT(STOP) } },
  { site: 'cap-price.ts both caps supplied', base: { code: 'INVALID_INPUT', message: 'm', statusCode: 400 }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP }, expect: { next_action: 'stop_and_tell_user', ...OMIT(STOP) } },
  { site: 'cap-price.ts invalid human cap', base: { code: 'INVALID_INPUT', message: 'm', statusCode: 400 }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP }, expect: { next_action: 'stop_and_tell_user', ...OMIT(STOP) } },
  { site: 'cap-price.ts unknown asset decimals', base: { code: F.MaxAmountUnconvertible, message: 'm', statusCode: 400 }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP }, expect: { next_action: 'stop_and_tell_user', ...OMIT(STOP) } },
  { site: 'cap-price.ts human cap too precise', base: { code: F.MaxAmountUnconvertible, message: 'm', statusCode: 400 }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP }, expect: { next_action: 'stop_and_tell_user', ...OMIT(STOP) } },
  { site: 'cap-price.ts rail cannot settle erc7710', base: { code: 'RAIL_UNSUPPORTED', message: 'm', statusCode: 403, suggestedTool: 'haven_get_agent' }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP_SUG }, expect: { next_action: 'stop_and_tell_user', suggested_tool: 'haven_get_agent', ...OMIT(STOP_SUG) } },
  { site: 'state-direct-recovery.ts check_funds: both-or-neither amount', base: { code: 'INVALID_INPUT', message: 'm', statusCode: 400 }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP }, expect: { next_action: 'stop_and_tell_user', ...OMIT(STOP) } },
  { site: 'state-direct-recovery.ts check_funds: unrecognised token address', base: { code: F.MaxAmountUnconvertible, message: 'm', statusCode: 400 }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP }, expect: { next_action: 'stop_and_tell_user', ...OMIT(STOP) } },
  { site: 'state-direct-recovery.ts check_funds: symbol resolves to no or several allowances (#3213)', base: { code: 'INVALID_INPUT', message: 'm', statusCode: 400 }, step: { nextAction: A.RetryWithExplicitContext, nextTool: 'haven_get_allowances', nextArguments: {} }, expect: { next_action: 'retry_with_explicit_context', next_tool: 'mcp__haven__haven_get_allowances', next_tool_server: 'haven', next_tool_name: 'haven_get_allowances', next_tool_server_role: 'hosted', next_arguments: {} } },
  { site: 'state-direct-recovery.ts check_funds: human cap too precise', base: { code: F.MaxAmountUnconvertible, message: 'm', statusCode: 400 }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP }, expect: { next_action: 'stop_and_tell_user', ...OMIT(STOP) } },
  { site: 'catalog-entry.ts not found', base: { code: 'CATALOG_ENTRY_NOT_FOUND', message: 'm', statusCode: 404, suggestedTool: 'haven_discover_tools' }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP_SUG }, expect: { next_action: 'stop_and_tell_user', suggested_tool: 'haven_discover_tools', ...OMIT(STOP_SUG) } },
  { site: 'catalog-entry.ts unusable', base: { code: 'CATALOG_ENTRY_UNUSABLE', message: 'm', statusCode: 409, suggestedTool: 'haven_pay_mcp_tool' }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP_SUG }, expect: { next_action: 'stop_and_tell_user', suggested_tool: 'haven_pay_mcp_tool', ...OMIT(STOP_SUG) } },
  // #3423 item 1: an http catalog row hands off to haven_quote_x402, not the mcp-only haven_pay_mcp_tool fallback above.
  { site: 'catalog-entry.ts http row', base: { code: 'CATALOG_ENTRY_UNUSABLE', message: 'm', statusCode: 409, suggestedTool: 'haven_quote_x402' }, step: { nextAction: A.RetryWithExplicitContext, nextTool: 'haven_quote_x402', nextArguments: { url: 'https://merchant.example/paid' } }, expect: { next_action: 'retry_with_explicit_context', suggested_tool: 'haven_quote_x402', next_tool: 'mcp__haven__haven_quote_x402', next_tool_server: 'haven', next_tool_name: 'haven_quote_x402', next_tool_server_role: 'hosted', next_arguments: { url: 'https://merchant.example/paid' } } },
  { site: 'mcp-context.ts merchant not ready', base: { code: 'MERCHANT_NOT_READY', message: 'm', statusCode: 503, retryWithNewQuote: true }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: 'the merchant needs to recover first; re-quote after retry_after_s' }, expect: { next_action: 'stop_and_tell_user', ...OMIT('the merchant needs to recover first; re-quote after retry_after_s') } },
  { site: 'mcp-context.ts insecure merchant url', base: { code: 'INSECURE_RETRY_TARGET', message: 'm', statusCode: 400 }, step: { nextAction: A.RetryWithExplicitContext, nextTool: null, nextToolOmittedReason: "re-call with the merchant's https URL as merchant_url; nothing was funded or signed" }, expect: { next_action: 'retry_with_explicit_context', ...OMIT("re-call with the merchant's https URL as merchant_url; nothing was funded or signed") } },
  { site: 'mcp-context.ts mcp_transport unrecognised', base: { code: 'INVALID_INPUT', message: 'm', statusCode: 400, status: 'invalid_input', phase: 'not_started', rail: 'x402' }, step: { nextAction: A.RetryWithExplicitContext, nextTool: null, nextToolOmittedReason: RETRY }, expect: { next_action: 'retry_with_explicit_context', ...OMIT(RETRY) } },
  // #3214: the four GENERIC normalizeError branches — no HostedToolError site; `thrown` is what the test throws.
  { site: 'errors.ts normalizeError: HavenApiError 5xx', base: { code: 'API_ERROR', message: 'Expected an x402 quote response with HTTP 402, got HTTP 500.', statusCode: 500 }, step: { nextAction: A.RetryWithExplicitContext, nextTool: null, nextToolOmittedReason: RETRY_API }, thrown: new HavenApiError('Expected an x402 quote response with HTTP 402, got HTTP 500.', 500), expect: { next_action: 'retry_with_explicit_context', ...OMIT(RETRY_API) } },
  // #3416: the typed chain-unavailable 503 is a stop, not the 5xx retry above.
  { site: 'errors.ts normalizeError: rail unavailable for chain (typed 503)', base: { code: 'RAIL_UNAVAILABLE_FOR_CHAIN', message: 'cannot serve chain 84532', statusCode: 503 }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: RAIL_UNAVAILABLE_OMITTED_REASON }, thrown: new HavenApiError('cannot serve chain 84532', 503, { error_code: 'rail_unavailable_for_chain', chain_id: 84532 }), expect: { next_action: 'stop_and_tell_user', ...OMIT(RAIL_UNAVAILABLE_OMITTED_REASON) } },
  // #3500: the typed task-budget 403 names its own code and reason, not the generic 4xx API_ERROR below.
  { site: 'errors.ts normalizeError: task budget exceeded (typed 403)', base: { code: 'TASK_BUDGET_EXCEEDED', message: 'task budget spent', statusCode: 403 }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: TASK_BUDGET_EXCEEDED_OMITTED_REASON }, thrown: new HavenApiError('task budget spent', 403, { error_code: 'task_budget_exceeded', task_budget_id: 'tb_1', remaining_atomic: '0' }), expect: { next_action: 'stop_and_tell_user', ...OMIT(TASK_BUDGET_EXCEEDED_OMITTED_REASON) } },
  // #3504: the typed delegation-budget 403 keeps the backend's own fund_account_or_raise_allowance step and figures, not the generic 4xx API_ERROR below.
  { site: 'errors.ts normalizeError: delegation budget exceeded (typed 403)', base: { code: 'DELEGATION_BUDGET_EXCEEDED', message: 'period budget exceeded', statusCode: 403 }, step: { nextAction: A.FundAccountOrRaiseAllowance, nextTool: null, nextToolOmittedReason: DELEGATION_BUDGET_EXCEEDED_OMITTED_REASON }, thrown: new HavenApiError('period budget exceeded', 403, { error_code: 'delegation_budget_exceeded', phase: 'insufficient_funds', next_action: 'fund_account_or_raise_allowance', rail: 'x402', remaining_atomic: '500', shortfall_atomic: '500' }), expect: { next_action: 'fund_account_or_raise_allowance', ...OMIT(DELEGATION_BUDGET_EXCEEDED_OMITTED_REASON) } },
  // #3564: the typed submission_outcome_unknown 502 is a POLL, not the 5xx retry below — the backend books the intent outcome-pending (never failed), so the status read IS the follow-up. With the body's payment_id the step names haven_get_payment_status with the id; without it, the reason says why no new payment may be created and the user checks the account's activity.
  { site: 'errors.ts normalizeError: submission outcome unknown (typed 502, payment_id known)', base: { code: 'SUBMISSION_OUTCOME_UNKNOWN', message: 'on-chain submission outcome unknown', statusCode: 502 }, step: { nextAction: A.CheckStatusLater, nextTool: 'haven_get_payment_status', nextArguments: { payment_id: 'pay_1' } }, thrown: new HavenApiError('on-chain submission outcome unknown', 502, { error_code: 'submission_outcome_unknown', payment_id: 'pay_1', user_op_hash: '0x' + 'cd'.repeat(32) }), expect: { next_action: 'check_status_later', ...STATUS('pay_1') } },
  { site: 'errors.ts normalizeError: submission outcome unknown (typed 502, no payment_id)', base: { code: 'SUBMISSION_OUTCOME_UNKNOWN', message: 'on-chain submission outcome unknown', statusCode: 502 }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: SUBMISSION_OUTCOME_UNKNOWN_OMITTED_REASON }, thrown: new HavenApiError('on-chain submission outcome unknown', 502, { error_code: 'submission_outcome_unknown' }), expect: { next_action: 'stop_and_tell_user', ...OMIT(SUBMISSION_OUTCOME_UNKNOWN_OMITTED_REASON) } },
  // #3494 review round 1 (S1): the account rejected this PAYMENT during
  // validation, but not its signature — never names the signer.
  { site: 'errors.ts normalizeError: account validation failed, not a signature cause (typed 502)', base: { code: 'ACCOUNT_VALIDATION_FAILED', message: 'the account rejected this payment during on-chain validation', statusCode: 502 }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: ACCOUNT_VALIDATION_FAILED_OMITTED_REASON }, thrown: new HavenApiError('the account rejected this payment during on-chain validation', 502, { error_code: 'account_validation_failed' }), expect: { next_action: 'stop_and_tell_user', ...OMIT(ACCOUNT_VALIDATION_FAILED_OMITTED_REASON) } },
  // #3494: the typed signature-rejected 502 (`POST /payments/:id/sign`, AA24 only — see errors.ts's own doc comment) is a stop, naming its own code — not the generic 5xx retry-once branch above.
  { site: 'errors.ts normalizeError: signature rejected (typed 502)', base: { code: 'SIGNATURE_REJECTED', message: 'the account rejected this signature during on-chain validation', statusCode: 502 }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: SIGNATURE_REJECTED_OMITTED_REASON }, thrown: new HavenApiError('the account rejected this signature during on-chain validation', 502, { error_code: 'signature_rejected' }), expect: { next_action: 'stop_and_tell_user', ...OMIT(SIGNATURE_REJECTED_OMITTED_REASON) } },
  { site: 'errors.ts normalizeError: prepare reverted (typed 502, #3609)', base: { code: 'PREPARE_REVERTED', message: 'The payment reverted during on-chain simulation', statusCode: 502 }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: PREPARE_REVERTED_OMITTED_REASON }, thrown: new HavenApiError('The payment reverted during on-chain simulation', 502, { error_code: 'prepare_reverted', refusal_reason: 'delegation_expired', revert_reason: 'TimestampEnforcer:expired-delegation' }), expect: { next_action: 'stop_and_tell_user', ...OMIT(PREPARE_REVERTED_OMITTED_REASON) } },
  // #3731: a `revert_cause: insufficient_balance` body is a FUNDING case — the real remedy, not the caveat text.
  { site: 'errors.ts normalizeError: prepare reverted, insufficient balance (typed 502, #3731)', base: { code: 'PREPARE_REVERTED', message: 'The account does not hold enough of the token for this payment', statusCode: 502 }, step: { nextAction: A.FundAccountOrRaiseAllowance, nextTool: null, nextToolOmittedReason: PREPARE_REVERTED_FUNDING_OMITTED_REASON }, thrown: new HavenApiError('The account does not hold enough of the token for this payment', 502, { error_code: 'prepare_reverted', refusal_reason: 'onchain_revert', revert_reason: 'ERC20: transfer amount exceeds balance', revert_cause: 'insufficient_balance' }), expect: { next_action: 'fund_account_or_raise_allowance', ...OMIT(PREPARE_REVERTED_FUNDING_OMITTED_REASON) } },
  // #3494, review round 2 (N3): every other `POST /payments/:id/sign` on-chain/bundler failure, INCLUDING a SubmittedUserOpFailedError whose op executed and reverted (a KNOWN, confirmed outcome — never submission_outcome_unknown) — still a stop (the intent already failed), not the generic 5xx retry-once branch above.
  { site: 'errors.ts normalizeError: onchain execution failed (typed 502)', base: { code: 'ONCHAIN_EXECUTION_FAILED', message: 'On-chain execution failed', statusCode: 502 }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: ONCHAIN_EXECUTION_FAILED_OMITTED_REASON }, thrown: new HavenApiError('On-chain execution failed', 502, { error_code: 'onchain_execution_failed' }), expect: { next_action: 'stop_and_tell_user', ...OMIT(ONCHAIN_EXECUTION_FAILED_OMITTED_REASON) } },
  { site: 'identity-gate.ts requireAgentIdentity: key not accepted (401)', base: { code: 'AGENT_IDENTITY_UNVERIFIED', message: 'm', statusCode: 401 }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: 'the agent API key was not accepted; the user must fix the key or reconnect the agent before any tool can run' }, expect: { next_action: 'stop_and_tell_user', ...OMIT('the agent API key was not accepted; the user must fix the key or reconnect the agent before any tool can run') } },
  { site: 'errors.ts normalizeError: HavenApiError 4xx', base: { code: 'API_ERROR', message: 'refused as made', statusCode: 404 }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP_API }, thrown: new HavenApiError('refused as made', 404), expect: { next_action: 'stop_and_tell_user', ...OMIT(STOP_API) } },
  { site: 'errors.ts normalizeError: HavenError', base: { code: 'CONFIG_ERROR', message: 'cfg broke', statusCode: 500 }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP_HAVEN }, thrown: new HavenError('cfg broke', 'CONFIG_ERROR', 500), expect: { next_action: 'stop_and_tell_user', ...OMIT(STOP_HAVEN) } },
  { site: 'errors.ts normalizeError: UNKNOWN_ERROR (thrown non-Error)', base: { code: 'UNKNOWN_ERROR', message: 'a string failure' }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP_UNKNOWN }, thrown: 'a string failure', expect: { next_action: 'stop_and_tell_user', ...OMIT(STOP_UNKNOWN) } },
]

