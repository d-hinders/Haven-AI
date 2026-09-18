import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AgentPaymentFailureCode, AgentPaymentNextAction } from '@haven_ai/sdk'
import { HostedToolError, normalizeError, paymentWindowExpiredError } from './tools/support/errors.js'

/**
 * #3102 (epic #3105, slice 3/5) — CHARACTERIZATION of the hosted REFUSAL
 * sites that name a `next_action`, written BEFORE they are moved onto the
 * typed builder. #3101 typed the 17 `buildAgentGuidance` sites; these are the
 * other 27 (`nextAction:` lines in the hosted non-test source, minus the
 * builder's — the census below derives the number). Each fixture mirrors one
 * site's `HostedToolError` input (code, action, suggested_tool, whether a
 * payment id is known) and pins what `normalizeError` puts on the wire for
 * it. The structural commit keeps every pinned field byte-identical and ADDS
 * the typed next step (a tool + arguments, or `next_tool_omitted_reason`);
 * the delta per site is listed in the PR body and updated here in the same
 * commit.
 */
export const REFUSAL_SITE_COUNT = 27

const A = AgentPaymentNextAction
const F = AgentPaymentFailureCode

type Site = {
  site: string
  input: ConstructorParameters<typeof HostedToolError>[0]
  expect: { next_action: string; suggested_tool?: string }
}

export const REFUSAL_SITES: Site[] = [
  { site: 'catalog-purchase.ts prepare: allowance short', input: { code: 'INSUFFICIENT_ALLOWANCE', message: 'm', statusCode: 402, nextAction: A.FundAccountOrRaiseAllowance, suggestedTool: 'haven_get_allowances' }, expect: { next_action: 'fund_account_or_raise_allowance', suggested_tool: 'haven_get_allowances' } },
  { site: 'paid-mcp-completion.ts merchant context: half-explicit pair', input: { code: 'INVALID_INPUT', message: 'm', statusCode: 400, paymentId: 'pay_1', status: 'invalid_input', phase: 'not_started', nextAction: A.RetryWithExplicitContext }, expect: { next_action: 'retry_with_explicit_context' } },
  { site: 'paid-mcp-completion.ts merchant context: unavailable', input: { code: F.MerchantCallContextUnavailable, message: 'm', statusCode: 409, nextAction: A.RetryWithExplicitContext, paymentId: 'pay_1' }, expect: { next_action: 'retry_with_explicit_context' } },
  { site: 'paid-mcp-completion.ts window expired (helper)', input: paymentWindowExpiredError({ paymentId: 'pay_1', status: 'expired', phase: 'expired', nextAction: A.PaymentWindowExpired, rail: 'x402' }), expect: { next_action: 'payment_window_expired', suggested_tool: 'haven_pay_mcp_tool' } },
  { site: 'paid-mcp-completion.ts timeout erc7710', input: { code: F.MerchantUnresponsiveAfterFunding, message: 'm', statusCode: 504, paymentId: 'pay_1', status: 'merchant_unresponsive_after_funding', phase: 'not_delivered', nextAction: A.CheckStatusLater, rail: 'erc7710', suggestedTool: 'haven_get_payment_status' }, expect: { next_action: 'check_status_later', suggested_tool: 'haven_get_payment_status' } },
  { site: 'paid-mcp-completion.ts timeout eip3009', input: { code: F.MerchantUnresponsiveAfterFunding, message: 'm', statusCode: 504, paymentId: 'pay_1', status: 'merchant_unresponsive_after_funding', phase: 'funded_but_unsettled', nextAction: A.SweepStrandedFunds, rail: 'x402', suggestedTool: 'haven_get_payment_status' }, expect: { next_action: 'sweep_stranded_funds', suggested_tool: 'haven_get_payment_status' } },
  { site: 'paid-mcp-completion.ts insecure target erc7710', input: { code: 'INSECURE_RETRY_TARGET', message: 'm', statusCode: 400, paymentId: 'pay_1', phase: 'not_delivered', nextAction: A.RetryWithExplicitContext, rail: 'erc7710', suggestedTool: 'haven_quote_mcp_tool' }, expect: { next_action: 'retry_with_explicit_context', suggested_tool: 'haven_quote_mcp_tool' } },
  { site: 'paid-mcp-completion.ts insecure target eip3009', input: { code: 'INSECURE_RETRY_TARGET', message: 'm', statusCode: 400, paymentId: 'pay_1', phase: 'funded_but_unsettled', nextAction: A.SweepStrandedFunds, rail: 'x402', suggestedTool: 'haven_get_payment_status' }, expect: { next_action: 'sweep_stranded_funds', suggested_tool: 'haven_get_payment_status' } },
  { site: 'paid-mcp-completion.ts rejected after funding: merchant not ready', input: { code: F.MerchantRejectedAfterFunding, message: 'm', statusCode: 503, paymentId: 'pay_1', status: 'merchant_rejected_after_funding', phase: 'not_delivered', nextAction: A.StopAndTellUser, rail: 'erc7710', retryWithNewQuote: true }, expect: { next_action: 'stop_and_tell_user' } },
  { site: 'paid-mcp-completion.ts rejected after funding: erc7710', input: { code: F.MerchantRejectedAfterFunding, message: 'm', statusCode: 402, paymentId: 'pay_1', status: 'merchant_rejected_after_funding', phase: 'not_delivered', nextAction: A.CheckStatusLater, suggestedTool: 'haven_get_payment_status', rail: 'erc7710', retryWithNewQuote: true }, expect: { next_action: 'check_status_later', suggested_tool: 'haven_get_payment_status' } },
  { site: 'paid-mcp-completion.ts rejected after funding: eip3009', input: { code: F.MerchantRejectedAfterFunding, message: 'm', statusCode: 402, paymentId: 'pay_1', status: 'merchant_rejected_after_funding', phase: 'funded_but_unsettled', nextAction: A.SweepStrandedFunds, suggestedTool: 'haven_sweep_delegate' }, expect: { next_action: 'sweep_stranded_funds', suggested_tool: 'haven_sweep_delegate' } },
  { site: 'paid-mcp-completion.ts header preflight', input: { code: 'INVALID_PAYMENT_HEADER', message: 'm', statusCode: 400, paymentId: 'pay_1', status: 'invalid_payment_header', phase: 'not_started', nextAction: A.StopAndTellUser, suggestedTool: 'haven_sign_x402' }, expect: { next_action: 'stop_and_tell_user', suggested_tool: 'haven_sign_x402' } },
  { site: 'plain-http-x402.ts pay: insecure target', input: { code: 'INSECURE_RETRY_TARGET', message: 'm', statusCode: 400, nextAction: A.RetryWithExplicitContext }, expect: { next_action: 'retry_with_explicit_context' } },
  { site: 'plain-http-x402.ts pay: erc7710-only merchant on a 3009 account', input: { code: 'ERC7710_ONLY', message: 'm', statusCode: 400, nextAction: A.StopAndTellUser, suggestedTool: 'haven_quote_x402' }, expect: { next_action: 'stop_and_tell_user', suggested_tool: 'haven_quote_x402' } },
  { site: 'plain-http-x402.ts resume: insecure target', input: { code: 'INSECURE_RETRY_TARGET', message: 'm', statusCode: 400, nextAction: A.RetryWithExplicitContext, paymentId: 'pay_1', phase: 'funded_but_unsettled', suggestedTool: 'haven_get_payment_status' }, expect: { next_action: 'retry_with_explicit_context', suggested_tool: 'haven_get_payment_status' } },
  { site: 'cap-price.ts invalid max_amount', input: { code: 'INVALID_MAX_AMOUNT', message: 'm', statusCode: 400, nextAction: A.StopAndTellUser }, expect: { next_action: 'stop_and_tell_user' } },
  { site: 'cap-price.ts price exceeds max', input: { code: F.PriceExceedsMax, message: 'm', statusCode: 402, nextAction: A.StopAndTellUser }, expect: { next_action: 'stop_and_tell_user' } },
  { site: 'cap-price.ts both caps supplied', input: { code: 'INVALID_INPUT', message: 'm', statusCode: 400, nextAction: A.StopAndTellUser }, expect: { next_action: 'stop_and_tell_user' } },
  { site: 'cap-price.ts invalid human cap', input: { code: 'INVALID_INPUT', message: 'm', statusCode: 400, nextAction: A.StopAndTellUser }, expect: { next_action: 'stop_and_tell_user' } },
  { site: 'cap-price.ts unknown asset decimals', input: { code: F.MaxAmountUnconvertible, message: 'm', statusCode: 400, nextAction: A.StopAndTellUser }, expect: { next_action: 'stop_and_tell_user' } },
  { site: 'cap-price.ts human cap too precise', input: { code: F.MaxAmountUnconvertible, message: 'm', statusCode: 400, nextAction: A.StopAndTellUser }, expect: { next_action: 'stop_and_tell_user' } },
  { site: 'cap-price.ts rail cannot settle erc7710', input: { code: 'RAIL_UNSUPPORTED', message: 'm', statusCode: 403, nextAction: A.StopAndTellUser, suggestedTool: 'haven_get_agent' }, expect: { next_action: 'stop_and_tell_user', suggested_tool: 'haven_get_agent' } },
  { site: 'catalog-entry.ts not found', input: { code: 'CATALOG_ENTRY_NOT_FOUND', message: 'm', statusCode: 404, nextAction: A.StopAndTellUser, suggestedTool: 'haven_discover_tools' }, expect: { next_action: 'stop_and_tell_user', suggested_tool: 'haven_discover_tools' } },
  { site: 'catalog-entry.ts unusable', input: { code: 'CATALOG_ENTRY_UNUSABLE', message: 'm', statusCode: 409, nextAction: A.StopAndTellUser, suggestedTool: 'haven_pay_mcp_tool' }, expect: { next_action: 'stop_and_tell_user', suggested_tool: 'haven_pay_mcp_tool' } },
  { site: 'mcp-context.ts merchant not ready', input: { code: 'MERCHANT_NOT_READY', message: 'm', statusCode: 503, nextAction: A.StopAndTellUser, retryWithNewQuote: true }, expect: { next_action: 'stop_and_tell_user' } },
  { site: 'mcp-context.ts insecure merchant url', input: { code: 'INSECURE_RETRY_TARGET', message: 'm', statusCode: 400, nextAction: A.RetryWithExplicitContext }, expect: { next_action: 'retry_with_explicit_context' } },
  { site: 'mcp-context.ts mcp_transport unrecognised', input: { code: 'INVALID_INPUT', message: 'm', statusCode: 400, status: 'invalid_input', phase: 'not_started', nextAction: A.RetryWithExplicitContext, rail: 'x402' }, expect: { next_action: 'retry_with_explicit_context' } },
]

function hostedSource(): string {
  const parts = [readFileSync(fileURLToPath(new URL('./tools.ts', import.meta.url)), 'utf8')]
  const walk = (dir: URL) => {
    for (const entry of readdirSync(fileURLToPath(dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(new URL(`${entry.name}/`, dir))
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
        parts.push(readFileSync(fileURLToPath(new URL(entry.name, dir)), 'utf8'))
    }
  }
  walk(new URL('./tools/', import.meta.url))
  return parts.join('\n')
}

describe('hosted refusal next-step emissions — characterization (#3102)', () => {
  it(`census: ${REFUSAL_SITE_COUNT} refusal sites name a next_action (nextAction: lines minus the builder's call sites)`, () => {
    const source = hostedSource()
    const lines = [...source.matchAll(/^\s*nextAction:/gm)].length
    const builderCalls = [...source.matchAll(/(?<!function )buildAgentGuidance\(/g)].length
    expect(lines - builderCalls).toBe(REFUSAL_SITE_COUNT)
    expect(REFUSAL_SITES).toHaveLength(REFUSAL_SITE_COUNT)
  })

  for (const fixture of REFUSAL_SITES) {
    it(fixture.site, () => {
      const err = fixture.input instanceof HostedToolError ? fixture.input : new HostedToolError(fixture.input)
      const out = normalizeError(err) as unknown as Record<string, unknown>
      expect(out.success).toBe(false)
      expect(out.next_action).toBe(fixture.expect.next_action)
      expect(out.suggested_tool).toBe(fixture.expect.suggested_tool)
      // Pre-#3102: no refusal carries a typed next step.
      expect('next_tool' in out && out.next_tool !== undefined).toBe(false)
      expect('next_tool_omitted_reason' in out && out.next_tool_omitted_reason !== undefined).toBe(false)
    })
  }
})
