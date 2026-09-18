import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AgentPaymentFailureCode, AgentPaymentNextAction } from '@haven_ai/sdk'
import { z } from 'zod'
import { HostedToolError, normalizeError, paymentWindowExpiredError } from './tools/support/errors.js'
import { refusalNextStep } from './tools/support/guidance.js'

/**
 * #3102 (epic #3105, slice 3/5) — CHARACTERIZATION of the hosted REFUSAL
 * sites that name a `next_action`, written BEFORE they were moved onto the
 * typed builder (commit a5b6aabc) and carried across it: every field pinned
 * there is unchanged, and each site now ALSO carries the typed step — a tool
 * with arguments that tool declares, or `next_tool_omitted_reason`. #3101 typed the 17 `buildAgentGuidance` sites; these are the
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
const RETRY = 're-call the same tool with the explicit context this message names; no tool can be named until you supply it'
const STOP = 'the user has to decide before anything is called again'
const STOP_SUG = 'the user has to decide before anything is called again; suggested_tool names the tool for after that'
const STATUS = (id: string) => ({ next_tool: 'mcp__haven__haven_get_payment_status', next_tool_server: 'haven', next_tool_name: 'haven_get_payment_status', next_tool_server_role: 'hosted', next_arguments: { payment_id: id } })
const OMIT = (reason: string) => ({ next_tool_omitted_reason: reason })

type Base = Omit<ConstructorParameters<typeof HostedToolError>[0], 'nextStep'>
type Site = {
  site: string
  base: Base
  step: Parameters<typeof refusalNextStep>[0] | 'window-expired-helper'
  expect: { next_action: string; suggested_tool?: string } & Record<string, unknown>
}

export const REFUSAL_SITES: Site[] = [
  { site: 'catalog-purchase.ts prepare: allowance short', base: { code: 'INSUFFICIENT_ALLOWANCE', message: 'm', statusCode: 402, suggestedTool: 'haven_get_allowances' }, step: { nextAction: A.FundAccountOrRaiseAllowance, nextTool: null, nextToolOmittedReason: 'the account needs funds or a higher allowance first; haven_get_allowances shows the numbers' }, expect: { next_action: 'fund_account_or_raise_allowance', suggested_tool: 'haven_get_allowances', ...OMIT('the account needs funds or a higher allowance first; haven_get_allowances shows the numbers') } },
  { site: 'paid-mcp-completion.ts merchant context: half-explicit pair', base: { code: 'INVALID_INPUT', message: 'm', statusCode: 400, paymentId: 'pay_1', status: 'invalid_input', phase: 'not_started' }, step: { nextAction: A.RetryWithExplicitContext, nextTool: null, nextToolOmittedReason: RETRY }, expect: { next_action: 'retry_with_explicit_context', ...OMIT(RETRY) } },
  { site: 'paid-mcp-completion.ts merchant context: unavailable', base: { code: F.MerchantCallContextUnavailable, message: 'm', statusCode: 409, paymentId: 'pay_1' }, step: { nextAction: A.RetryWithExplicitContext, nextTool: null, nextToolOmittedReason: RETRY }, expect: { next_action: 'retry_with_explicit_context', ...OMIT(RETRY) } },
  { site: 'paid-mcp-completion.ts window expired (helper)', base: { code: F.PaymentWindowExpired, message: 'm' }, step: 'window-expired-helper', expect: { next_action: 'payment_window_expired', suggested_tool: 'haven_pay_mcp_tool', ...OMIT('re-run the tool you called with the same idempotency_key; which tool depends on the flow (suggested_tool names the MCP one)') } },
  { site: 'paid-mcp-completion.ts timeout erc7710', base: { code: F.MerchantUnresponsiveAfterFunding, message: 'm', statusCode: 504, paymentId: 'pay_1', status: 'merchant_unresponsive_after_funding', phase: 'not_delivered', rail: 'erc7710', suggestedTool: 'haven_get_payment_status' }, step: { nextAction: A.CheckStatusLater, nextTool: 'haven_get_payment_status', nextArguments: { payment_id: 'pay_1' } }, expect: { next_action: 'check_status_later', suggested_tool: 'haven_get_payment_status', ...STATUS('pay_1') } },
  { site: 'paid-mcp-completion.ts timeout eip3009', base: { code: F.MerchantUnresponsiveAfterFunding, message: 'm', statusCode: 504, paymentId: 'pay_1', status: 'merchant_unresponsive_after_funding', phase: 'funded_but_unsettled', rail: 'x402', suggestedTool: 'haven_get_payment_status' }, step: { nextAction: A.SweepStrandedFunds, nextTool: 'haven_get_payment_status', nextArguments: { payment_id: 'pay_1' } }, expect: { next_action: 'sweep_stranded_funds', suggested_tool: 'haven_get_payment_status', ...STATUS('pay_1') } },
  { site: 'paid-mcp-completion.ts insecure target erc7710', base: { code: 'INSECURE_RETRY_TARGET', message: 'm', statusCode: 400, paymentId: 'pay_1', phase: 'not_delivered', rail: 'erc7710', suggestedTool: 'haven_quote_mcp_tool' }, step: { nextAction: A.RetryWithExplicitContext, nextTool: null, nextToolOmittedReason: 're-quote the merchant at its https URL; nothing moved' }, expect: { next_action: 'retry_with_explicit_context', suggested_tool: 'haven_quote_mcp_tool', ...OMIT('re-quote the merchant at its https URL; nothing moved') } },
  { site: 'paid-mcp-completion.ts insecure target eip3009', base: { code: 'INSECURE_RETRY_TARGET', message: 'm', statusCode: 400, paymentId: 'pay_1', phase: 'funded_but_unsettled', rail: 'x402', suggestedTool: 'haven_get_payment_status' }, step: { nextAction: A.SweepStrandedFunds, nextTool: 'haven_get_payment_status', nextArguments: { payment_id: 'pay_1' } }, expect: { next_action: 'sweep_stranded_funds', suggested_tool: 'haven_get_payment_status', ...STATUS('pay_1') } },
  { site: 'paid-mcp-completion.ts rejected after funding: merchant not ready', base: { code: F.MerchantRejectedAfterFunding, message: 'm', statusCode: 503, paymentId: 'pay_1', status: 'merchant_rejected_after_funding', phase: 'not_delivered', rail: 'erc7710', retryWithNewQuote: true }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: 'the merchant is not ready to settle; tell the user and re-quote later' }, expect: { next_action: 'stop_and_tell_user', ...OMIT('the merchant is not ready to settle; tell the user and re-quote later') } },
  { site: 'paid-mcp-completion.ts rejected after funding: erc7710', base: { code: F.MerchantRejectedAfterFunding, message: 'm', statusCode: 402, paymentId: 'pay_1', status: 'merchant_rejected_after_funding', phase: 'not_delivered', suggestedTool: 'haven_get_payment_status', rail: 'erc7710', retryWithNewQuote: true }, step: { nextAction: A.CheckStatusLater, nextTool: 'haven_get_payment_status', nextArguments: { payment_id: 'pay_1' } }, expect: { next_action: 'check_status_later', suggested_tool: 'haven_get_payment_status', ...STATUS('pay_1') } },
  { site: 'paid-mcp-completion.ts rejected after funding: eip3009', base: { code: F.MerchantRejectedAfterFunding, message: 'm', statusCode: 402, paymentId: 'pay_1', status: 'merchant_rejected_after_funding', phase: 'funded_but_unsettled', suggestedTool: 'haven_sweep_delegate' }, step: { nextAction: A.SweepStrandedFunds, nextTool: 'haven_sweep_delegate', nextArguments: {} }, expect: { next_action: 'sweep_stranded_funds', suggested_tool: 'haven_sweep_delegate', next_tool: 'mcp__haven__haven_sweep_delegate', next_tool_server: 'haven', next_tool_name: 'haven_sweep_delegate', next_tool_server_role: 'hosted', next_arguments: {} } },
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
  { site: 'catalog-entry.ts not found', base: { code: 'CATALOG_ENTRY_NOT_FOUND', message: 'm', statusCode: 404, suggestedTool: 'haven_discover_tools' }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP_SUG }, expect: { next_action: 'stop_and_tell_user', suggested_tool: 'haven_discover_tools', ...OMIT(STOP_SUG) } },
  { site: 'catalog-entry.ts unusable', base: { code: 'CATALOG_ENTRY_UNUSABLE', message: 'm', statusCode: 409, suggestedTool: 'haven_pay_mcp_tool' }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: STOP_SUG }, expect: { next_action: 'stop_and_tell_user', suggested_tool: 'haven_pay_mcp_tool', ...OMIT(STOP_SUG) } },
  { site: 'mcp-context.ts merchant not ready', base: { code: 'MERCHANT_NOT_READY', message: 'm', statusCode: 503, retryWithNewQuote: true }, step: { nextAction: A.StopAndTellUser, nextTool: null, nextToolOmittedReason: 'the merchant needs to recover first; re-quote after retry_after_s' }, expect: { next_action: 'stop_and_tell_user', ...OMIT('the merchant needs to recover first; re-quote after retry_after_s') } },
  { site: 'mcp-context.ts insecure merchant url', base: { code: 'INSECURE_RETRY_TARGET', message: 'm', statusCode: 400 }, step: { nextAction: A.RetryWithExplicitContext, nextTool: null, nextToolOmittedReason: "re-call with the merchant's https URL as merchant_url; nothing was funded or signed" }, expect: { next_action: 'retry_with_explicit_context', ...OMIT("re-call with the merchant's https URL as merchant_url; nothing was funded or signed") } },
  { site: 'mcp-context.ts mcp_transport unrecognised', base: { code: 'INVALID_INPUT', message: 'm', statusCode: 400, status: 'invalid_input', phase: 'not_started', rail: 'x402' }, step: { nextAction: A.RetryWithExplicitContext, nextTool: null, nextToolOmittedReason: RETRY }, expect: { next_action: 'retry_with_explicit_context', ...OMIT(RETRY) } },
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

const NEXT_KEYS = ['next_action', 'suggested_tool', 'next_tool', 'next_tool_server', 'next_tool_name', 'next_tool_server_role', 'next_arguments', 'next_tool_omitted_reason'] as const

describe('hosted refusal next-step emissions — characterization (#3102)', () => {
  it(`census: ${REFUSAL_SITE_COUNT} refusal steps are built in the hosted source (refusalNextStep calls; a bare nextAction on HostedToolError no longer compiles)`, () => {
    const source = hostedSource()
    const calls = [...source.matchAll(/(?<!function )refusalNextStep\(/g)].length
    expect(calls).toBe(REFUSAL_SITE_COUNT)
    expect(REFUSAL_SITES).toHaveLength(REFUSAL_SITE_COUNT)
  })

  for (const fixture of REFUSAL_SITES) {
    it(fixture.site, () => {
      const err = fixture.step === 'window-expired-helper'
        ? paymentWindowExpiredError({ paymentId: 'pay_1', status: 'expired', phase: 'expired', rail: 'x402' })
        : new HostedToolError({ ...fixture.base, nextStep: refusalNextStep(fixture.step) })
      const out = normalizeError(err) as unknown as Record<string, unknown>
      expect(out.success).toBe(false)
      const picked = Object.fromEntries(NEXT_KEYS.filter((k) => out[k] !== undefined).map((k) => [k, out[k]]))
      expect(picked).toEqual(fixture.expect)
    })
  }

  it('registry walk: every refusal names a tool whose arguments parse under its strict schema, or says why none follows', async () => {
    const { toolSchemas } = await import('./tools/contracts.js')
    for (const fixture of REFUSAL_SITES) {
      const err = fixture.step === 'window-expired-helper'
        ? paymentWindowExpiredError({ paymentId: 'pay_1', status: 'expired', phase: 'expired', rail: 'x402' })
        : new HostedToolError({ ...fixture.base, nextStep: refusalNextStep(fixture.step) })
      const out = normalizeError(err)
      if (out.next_tool) {
        const name = out.next_tool_name as keyof typeof toolSchemas
        expect(toolSchemas[name], fixture.site).toBeDefined()
        const parsed = z.object(toolSchemas[name]).strict().safeParse(out.next_arguments)
        expect(parsed.success, `${fixture.site}: ${JSON.stringify(out.next_arguments)}`).toBe(true)
        expect(out.next_tool_omitted_reason).toBeUndefined()
      } else {
        expect(typeof out.next_tool_omitted_reason, fixture.site).toBe('string')
        expect((out.next_tool_omitted_reason as string).length).toBeGreaterThan(10)
      }
      expect(out.next_action, fixture.site).toBeDefined()
    }
  })
})
