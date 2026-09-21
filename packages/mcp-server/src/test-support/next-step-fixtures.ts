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

/** `buildAgentGuidance(` call sites in the hosted non-test source — the census `next-step-characterization.test.ts` enforces. */
export const EMISSION_SITE_COUNT = 17
/** Fixtures for those sites: the held-hash site has two branches, the three null-id sites share one helper. */
export const EMISSION_FIXTURE_COUNT = 19

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
  { site: 'plain-http-x402.ts report outcome accepted (no tool)', action: AgentPaymentNextAction.None, tool: null, reason: 'the merchant accepted the paid retry; the purchase is complete and no Haven tool follows', expect: { next_tool_omitted_reason: 'the merchant accepted the paid retry; the purchase is complete and no Haven tool follows' } } /* RE-DECIDED: additive reason, no tool before either */,
  { site: 'paid-mcp-completion.ts pending', action: AgentPaymentNextAction.CheckStatusLater, tool: 'haven_get_payment_status', args: { payment_id: 'pay_1' }, expect: { ...HOSTED('haven_get_payment_status'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'paid-mcp-completion.ts settle held-hash, can report', action: AgentPaymentNextAction.CheckStatusLater, tool: 'haven_report_settlement_evidence', args: { payment_id: 'pay_1', settlement_tx_hash: '0x' + 'ab'.repeat(32) }, expect: { ...HOSTED('haven_report_settlement_evidence'), next_arguments: { payment_id: 'pay_1', settlement_tx_hash: '0x' + 'ab'.repeat(32) } } },
  { site: 'paid-mcp-completion.ts settle held-hash, cannot report', action: AgentPaymentNextAction.CheckStatusLater, tool: 'haven_get_payment_status', args: { payment_id: 'pay_1' }, expect: { ...HOSTED('haven_get_payment_status'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'paid-mcp-completion.ts settle funding pending', action: AgentPaymentNextAction.CheckStatusLater, tool: 'haven_get_payment_status', args: { payment_id: 'pay_1' }, expect: { ...HOSTED('haven_get_payment_status'), next_arguments: { payment_id: 'pay_1' } } },
  // The four no-tool sites (no `nextTool:` line before #3101; the required input surfaced them).
  { site: 'paid-mcp-completion.ts complete settled', action: AgentPaymentNextAction.None, tool: null, reason: 'the purchase is settled; no Haven tool follows', expect: { next_tool_omitted_reason: 'the purchase is settled; no Haven tool follows' } } /* RE-DECIDED: additive reason */,
  { site: 'paid-mcp-completion.ts settle erc7710 settled', action: AgentPaymentNextAction.None, tool: null, reason: 'the purchase is settled; no Haven tool follows', expect: { next_tool_omitted_reason: 'the purchase is settled; no Haven tool follows' } } /* RE-DECIDED: additive reason */,
  { site: 'paid-mcp-completion.ts settle 3009 settled', action: AgentPaymentNextAction.None, tool: null, reason: 'the purchase is settled; no Haven tool follows', expect: { next_tool_omitted_reason: 'the purchase is settled; no Haven tool follows' } } /* RE-DECIDED: additive reason */,
  { site: 'state-direct-recovery.ts own HTTP retry', action: AgentPaymentNextAction.RetryOriginalX402Request, tool: null, reason: 'the next step is your own HTTP retry of the merchant with the payment_header above, not a Haven tool', expect: { next_tool_omitted_reason: 'the next step is your own HTTP retry of the merchant with the payment_header above, not a Haven tool' } } /* RE-DECIDED: additive reason */,
] as const


const A = AgentPaymentNextAction
const F = AgentPaymentFailureCode
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

/** Refusal fixtures: 31 HostedToolError sites (the eip3009 rejection carrying a live-state branch) + the 4 generic normalizeError branches #3214 added. */
export const REFUSAL_SITE_COUNT = 35
/** `refusalNextStep(` calls in the hosted source: 29 inline site steps + rejectedAfterFundingStep's 3 + stateErrorNextStep's 5 (round 3 of #3126 migrated the three check_funds cap refusals onto the builder) + #3214's 4 in normalizeError (the HavenApiError 4xx/5xx pair, HavenError, UNKNOWN_ERROR). */
export const REFUSAL_STEP_CALLS = 41

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
  { site: 'state-direct-recovery.ts check_funds: human cap too precise', base: { code: F.MaxAmountUnconvertible, message: 'm', statusCode: 400 }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP }, expect: { next_action: 'stop_and_tell_user', ...OMIT(STOP) } },
  { site: 'catalog-entry.ts not found', base: { code: 'CATALOG_ENTRY_NOT_FOUND', message: 'm', statusCode: 404, suggestedTool: 'haven_discover_tools' }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP_SUG }, expect: { next_action: 'stop_and_tell_user', suggested_tool: 'haven_discover_tools', ...OMIT(STOP_SUG) } },
  { site: 'catalog-entry.ts unusable', base: { code: 'CATALOG_ENTRY_UNUSABLE', message: 'm', statusCode: 409, suggestedTool: 'haven_pay_mcp_tool' }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP_SUG }, expect: { next_action: 'stop_and_tell_user', suggested_tool: 'haven_pay_mcp_tool', ...OMIT(STOP_SUG) } },
  { site: 'mcp-context.ts merchant not ready', base: { code: 'MERCHANT_NOT_READY', message: 'm', statusCode: 503, retryWithNewQuote: true }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: 'the merchant needs to recover first; re-quote after retry_after_s' }, expect: { next_action: 'stop_and_tell_user', ...OMIT('the merchant needs to recover first; re-quote after retry_after_s') } },
  { site: 'mcp-context.ts insecure merchant url', base: { code: 'INSECURE_RETRY_TARGET', message: 'm', statusCode: 400 }, step: { nextAction: A.RetryWithExplicitContext, nextTool: null, nextToolOmittedReason: "re-call with the merchant's https URL as merchant_url; nothing was funded or signed" }, expect: { next_action: 'retry_with_explicit_context', ...OMIT("re-call with the merchant's https URL as merchant_url; nothing was funded or signed") } },
  { site: 'mcp-context.ts mcp_transport unrecognised', base: { code: 'INVALID_INPUT', message: 'm', statusCode: 400, status: 'invalid_input', phase: 'not_started', rail: 'x402' }, step: { nextAction: A.RetryWithExplicitContext, nextTool: null, nextToolOmittedReason: RETRY }, expect: { next_action: 'retry_with_explicit_context', ...OMIT(RETRY) } },
  // #3214: the four GENERIC normalizeError branches — no HostedToolError site; `thrown` is what the test throws.
  { site: 'errors.ts normalizeError: HavenApiError 5xx', base: { code: 'API_ERROR', message: 'Expected an x402 quote response with HTTP 402, got HTTP 500.', statusCode: 500 }, step: { nextAction: A.RetryWithExplicitContext, nextTool: null, nextToolOmittedReason: RETRY_API }, thrown: new HavenApiError('Expected an x402 quote response with HTTP 402, got HTTP 500.', 500), expect: { next_action: 'retry_with_explicit_context', ...OMIT(RETRY_API) } },
  { site: 'errors.ts normalizeError: HavenApiError 4xx', base: { code: 'API_ERROR', message: 'refused as made', statusCode: 404 }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP_API }, thrown: new HavenApiError('refused as made', 404), expect: { next_action: 'stop_and_tell_user', ...OMIT(STOP_API) } },
  { site: 'errors.ts normalizeError: HavenError', base: { code: 'CONFIG_ERROR', message: 'cfg broke', statusCode: 500 }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP_HAVEN }, thrown: new HavenError('cfg broke', 'CONFIG_ERROR', 500), expect: { next_action: 'stop_and_tell_user', ...OMIT(STOP_HAVEN) } },
  { site: 'errors.ts normalizeError: UNKNOWN_ERROR (thrown non-Error)', base: { code: 'UNKNOWN_ERROR', message: 'a string failure' }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP_UNKNOWN }, thrown: 'a string failure', expect: { next_action: 'stop_and_tell_user', ...OMIT(STOP_UNKNOWN) } },
]

