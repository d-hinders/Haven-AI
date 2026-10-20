/**
 * #4107 — the OPTIONAL pre-trade token-safety check of the hosted MCP surface.
 *
 * A pre-trade "is this token a honeypot / taxed / admin-controlled" check is a
 * natural guardrail before an agent acts on a Base swap. Haven has no swap
 * signing surface — `haven_sign` signs only Haven-prepared payloads — so there
 * is no pre-sign hook to wire; what fits the agent-first surface is an
 * ADVISORY tool the agent can call before acting on a token trade. It never
 * blocks anything and never spends: an unavailable check is reported as
 * exactly that, never as a pass, and nothing in Haven consults it
 * automatically (CASP: off-chain policy is never the real spend control).
 *
 * The check is the free preview endpoint of the x402-data-api operator (Grey
 * Ridge, https://x402-data-api.sigrunner.workers.dev) — same response shape as
 * the operator's PAID `/gate/swap` resource. That paid resource is a SPEND, so
 * this module deliberately contains NO payment machinery: the operator's paid
 * gate is reachable only through the standard hosted x402 rail
 * (`haven_quote_x402` → `haven_pay_x402_quote`), where the price comes from
 * the 402 the quote fetches, the cap is the agent's own explicit argument, and
 * every budget and authority gate of that rail applies unchanged. The
 * successful result names the ready-to-quote `/gate/swap` URL in
 * `paid_gate.url`; it never fetches it.
 *
 * The preview call runs under the hosted merchant-egress policy (#3747): the
 * URL is asserted before connecting, redirects are never followed (any 3xx is
 * an unavailable check, not a hop), and the body is read under the policy's
 * while-reading byte cap with a short timeout — the operator's own measured
 * p95 is ~3.4s (a short-window measurement, not an SLA), so the check treats
 * the operator as untrusted for availability.
 */
import {
  AgentPaymentNextAction,
  HavenClient,
  MerchantEgressResponseCapError,
  readBodyCapped,
  strictMerchantEgressPolicy,
} from '@haven_ai/sdk'
import type { HostedToolHandlers, HostedToolName } from './contracts.js'
import { HostedToolError, egressRefusalBeforeIntent, normalizeError, runTool } from './support/errors.js'
import { refusalNextStep } from './support/guidance.js'
import { parseStrict } from './parsing.js'

export const TOKEN_SAFETY_TOOLS = [
  'haven_check_token_safety',
] as const satisfies readonly HostedToolName[]

export type TokenSafetyToolName = (typeof TOKEN_SAFETY_TOOLS)[number]

/** The operator's base URL — pinned, not an argument: a caller-choosable "safety check" is a spoofing vector. */
const GATE_BASE_URL = 'https://x402-data-api.sigrunner.workers.dev'
const GATE_OPERATOR = 'x402-data-api (operator: Grey Ridge)'
/** Fallback for a policy without explicit budgets; the #3747 quote budget is 15s. */
const PREVIEW_FALLBACK_TIMEOUT_MS = 15_000
/** Fallback byte cap; the #3747 hosted caps are far larger and always win. */
const PREVIEW_FALLBACK_MAX_BYTES = 256 * 1024

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

interface OperatorGateBody {
  token?: unknown
  side?: unknown
  notional_usd?: unknown
  decision?: unknown
  verdict?: unknown
  reason?: unknown
  risk_score?: unknown
  flags?: unknown
  liquidity_usd?: unknown
  impact_pct_of_pool?: unknown
  token_meta?: unknown
  analyzed_at?: unknown
  disclaimer?: unknown
  trial?: unknown
  error?: unknown
}

function gateUrl(path: 'preview' | 'paid', token: string, side: string, notionalUsd: number): string {
  const query = new URLSearchParams({ token, side, notional_usd: String(notionalUsd) })
  return `${GATE_BASE_URL}/gate/swap${path === 'paid' ? '' : '/preview'}?${query.toString()}`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The one refusal this tool raises: the check could not be completed. The
 * message and the omitted next step both say the check did NOT run — an
 * unavailable check must never read as a pass — and that nothing was spent,
 * because the only endpoint this tool touches is the free preview.
 */
function checkUnavailable(reason: string): HostedToolError {
  return new HostedToolError({
    code: 'TOKEN_SAFETY_CHECK_UNAVAILABLE',
    statusCode: 502,
    message:
      `The token-safety check did NOT run: ${reason} An unavailable check is NOT a pass — ` +
      'treat the token as unchecked. Nothing was spent: this tool only calls the operator\'s ' +
      'free preview. Retry haven_check_token_safety, or run the paid gate yourself through the ' +
      'standard x402 rail (haven_quote_x402 with the /gate/swap URL for this token, then ' +
      'haven_pay_x402_quote) under your normal budget gates.',
    nextStep: refusalNextStep({
      nextAction: AgentPaymentNextAction.RetryWithExplicitContext,
      nextTool: null,
      nextToolOmittedReason:
        're-call haven_check_token_safety to retry the free check (no payment); the paid ' +
        '/gate/swap analysis runs through haven_quote_x402 then haven_pay_x402_quote under ' +
        'your normal budget gates',
    }),
  })
}

export function createTokenSafetyHandlers(haven: HavenClient): HostedToolHandlers<TokenSafetyToolName> {
  return {
    haven_check_token_safety: async (input) => {
      let args: Record<string, any>
      try {
        args = parseStrict('haven_check_token_safety', input)
      } catch (err) {
        return normalizeError(err)
      }
      return runTool(async () => {
        const token = args.token as string
        const side = args.side as 'buy' | 'sell'
        const notionalUsd = args.notional_usd as number

        // The egress policy runs BEFORE anything connects — a stricter
        // embedder-supplied policy (or a future SDK default) refuses here as
        // it would for any merchant the agent chose.
        const egress = haven.merchantEgress ?? strictMerchantEgressPolicy()
        const previewUrl = gateUrl('preview', token, side, notionalUsd)
        try {
          egress.assertUrl(previewUrl)
        } catch (err) {
          throw egressRefusalBeforeIntent(err, 'url')
        }

        const timeoutMs = egress.timeouts?.discovery ?? egress.timeouts?.quote ?? PREVIEW_FALLBACK_TIMEOUT_MS
        let response: Response
        try {
          response = await fetch(previewUrl, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
        } catch (err) {
          throw checkUnavailable(`the preview request failed (${errorMessage(err)}).`)
        }
        // Redirects are never followed: the pinned operator URL is the only
        // host this tool talks to, so a redirect is an unavailable check, not
        // a hop.
        if (REDIRECT_STATUSES.has(response.status)) {
          throw checkUnavailable(`the operator answered HTTP ${response.status} (a redirect), and redirects are not followed.`)
        }
        if (!response.ok) {
          if (response.status === 429) {
            // The operator meters the free preview (3 real-token checks/day/IP).
            // A 429 means the free trial is exhausted for this egress IP today — it
            // is NOT a result and NOT a pass. The paid /gate/swap resource is
            // unmetered and returns the same response shape, so name its exact URL
            // for THIS token to make the upgrade actionable (still no payment here —
            // the agent quotes it through the standard x402 rail under its budget).
            const paidGateUrl = gateUrl('paid', token, side, notionalUsd)
            throw checkUnavailable(
              `the operator's free preview is rate-limited (HTTP 429: 3 real-token checks/day/IP ` +
              `exhausted for this egress host). The unmetered paid analysis for this exact token is ` +
              `${paidGateUrl} — quote it with haven_quote_x402, then haven_pay_x402_quote, under your normal budget gates.`,
            )
          }
          throw checkUnavailable(`the operator answered HTTP ${response.status}.`)
        }

        let bodyText: string
        try {
          bodyText = await readBodyCapped(response, egress.maxResponseBytes ?? PREVIEW_FALLBACK_MAX_BYTES)
        } catch (err) {
          if (err instanceof MerchantEgressResponseCapError) {
            throw checkUnavailable(`the operator's response exceeded the ${err.limitBytes}-byte read cap.`)
          }
          throw checkUnavailable(`the operator's response could not be read (${errorMessage(err)}).`)
        }

        let body: OperatorGateBody
        try {
          body = JSON.parse(bodyText) as OperatorGateBody
        } catch {
          throw checkUnavailable('the response was not JSON.')
        }
        if (typeof body !== 'object' || body === null) {
          throw checkUnavailable('the response was not a JSON object.')
        }
        if (typeof body.error === 'string') {
          throw checkUnavailable(`the operator refused the check: ${body.error}`)
        }
        if (typeof body.decision !== 'string' || typeof body.verdict !== 'string') {
          throw checkUnavailable('the response did not carry the operator\'s decision and verdict.')
        }

        return {
          token: body.token ?? token,
          side: body.side ?? side,
          notional_usd: body.notional_usd ?? notionalUsd,
          decision: body.decision,
          verdict: body.verdict,
          reason: body.reason ?? null,
          risk_score: body.risk_score ?? null,
          flags: Array.isArray(body.flags) ? body.flags : [],
          liquidity_usd: body.liquidity_usd ?? null,
          impact_pct_of_pool: body.impact_pct_of_pool ?? null,
          token_meta: body.token_meta ?? null,
          analyzed_at: body.analyzed_at ?? null,
          disclaimer: body.disclaimer ?? null,
          trial: body.trial ?? null,
          check: {
            source: `free preview endpoint of ${GATE_OPERATOR}`,
            payment_made: false,
          },
          paid_gate: {
            url: gateUrl('paid', token, side, notionalUsd),
            note:
              'The operator\'s full paid analysis of any Base ERC-20, same response shape. ' +
              'This tool never pays: reach it only through the standard x402 rail — ' +
              'haven_quote_x402 { url } then haven_pay_x402_quote { url, max_amount_human } ' +
              '(the cap is required) — under your normal budget and authority gates. The ' +
              'operator documents ~$0.008 USDC on Base; the 402 your quote fetches is the ' +
              'authoritative price, and it is a short-window measurement, not an SLA.',
          },
        }
      })
    },
  }
}
