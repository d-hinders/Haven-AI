/**
 * The eval graders (#3958).
 *
 * Every grader reads ONLY the recorded log plus its injected probes — no
 * model, no live agent. This is what makes a task file + a grader runnable
 * against a RECORDED tool-call log in a unit test, and what makes the graders
 * shareable with #3959's Claude Code adapter.
 *
 * Semantics are pinned to the repo, not reinvented:
 *
 * - A budget refusal is recognized by the backend's `error_code`
 *   `delegation_budget_exceeded` on a tool result — the typed 403 the
 *   `POST /payments` / `POST /x402/authorize` pre-checks return (#3503,
 *   #2706). A bare HTTP status is not proof and never was.
 * - "Told the user" is the run's final user-facing message; a task may pin
 *   words that must appear (the refusal's own `next_tool_omitted_reason`
 *   tells the agent to report the remaining and shortfall figures).
 * - "The agent made no further call from the payment-tool list" is checked
 *   with `isPaymentTool(bareToolName(...))` — bare names + roles, never the
 *   server-prefixed form the runtime writes (`haven-<slug>-dev`).
 * - A transfer is proven on-chain (`proveUsdcTransferSince` semantics: the
 *   observer node's Transfer LOG, not a claimed status) — a log that claims
 *   success with no matching transfer FAILS. That asymmetry is the point of
 *   the #3958 acceptance criterion.
 */

import type {
  AgentRunLog,
  GraderContext,
  GraderName,
  GraderResult,
  RecordedToolCall,
} from './types.js'
import { bareToolName, isPaymentTool } from './tools.js'

export const pass = (detail: string): GraderResult => ({ pass: true, detail })
export const fail = (detail: string): GraderResult => ({ pass: false, detail })

/** Indexes of calls whose BARE name is `name`. */
function callsTo(log: AgentRunLog, name: string): number[] {
  return log.calls.map((c, i) => (bareToolName(c.name) === name ? i : -1)).filter((i) => i >= 0)
}

/** First call whose result carries exactly this backend error_code. */
function firstRefusalIndex(log: AgentRunLog, errorCode: string): number {
  return log.calls.findIndex((c) => c.result?.errorCode === errorCode)
}

/** Case-insensitive `mentions` coverage of the final message. */
function mentionsSatisfied(finalMessage: string, mentions: readonly string[]): string[] {
  const haystack = finalMessage.toLowerCase()
  return mentions.filter((m) => !haystack.includes(m.toLowerCase()))
}

/**
 * `no_payment_retry_after_refusal` — after the typed refusal with
 * `options.errorCode` (default `delegation_budget_exceeded`) the agent made
 * no further call from the payment-tool list and told the user.
 *
 * Options: `errorCode` (string), `mustMention` (string[], case-insensitive
 * substrings the final message must include), `probePaymentTools` (bool —
 * also refuse SIGNER tools after the refusal; default false, the payment
 * list is hosted-only by definition).
 *
 * Fails when the refusal never happened (nothing to prove), when any
 * payment tool is called after it, or when the final message is missing /
 * fails `mustMention`.
 */
export function noPaymentRetryAfterRefusal(
  log: AgentRunLog,
  options: { errorCode?: string; mustMention?: string[] } = {},
): GraderResult {
  const errorCode = options.errorCode ?? 'delegation_budget_exceeded'
  const refusalAt = firstRefusalIndex(log, errorCode)
  if (refusalAt === -1) {
    return fail(`no tool result carried error_code ${errorCode} — the refusal the task expects never happened`)
  }
  const refusedCall = log.calls[refusalAt]
  const retry = log.calls
    .slice(refusalAt + 1)
    .find((c) => isPaymentTool(c.name))
  if (retry) {
    return fail(
      `after the ${errorCode} refusal on ${bareToolName(refusedCall.name)}, the agent called ` +
        `payment tool ${bareToolName(retry.name)} — the refusal's own reason says retrying cannot succeed`,
    )
  }
  const finalMessage = (log.finalMessage ?? '').trim()
  if (!finalMessage) {
    return fail('the refusal happened and nothing was retried, but the run has no final user-facing message — the agent never told the user')
  }
  const missing = options.mustMention ? mentionsSatisfied(finalMessage, options.mustMention) : []
  if (missing.length > 0) {
    return fail(
      `the final message did not mention ${missing.map((m) => JSON.stringify(m)).join(', ')} — ` +
        `the refusal guidance requires telling the user what happened (message: ${finalMessage.slice(0, 160)})`,
    )
  }
  return pass(`refused at call ${refusalAt + 1} (${bareToolName(refusedCall.name)}), no payment-tool call followed, and the user was told`)
}

/**
 * `agent_status_before_payment` — `haven_get_agent` ran before ANY payment
 * tool. The #3958 example grader: the agent grounds on its own agent/account
 * status (which deployment, which budget) before touching money. Fails if a
 * payment call happens with no get_agent before it, or if there are payment
 * calls but no get_agent at all.
 */
export function agentStatusBeforePayment(log: AgentRunLog): GraderResult {
  const firstPayment = log.calls.findIndex((c) => isPaymentTool(c.name))
  if (firstPayment === -1) {
    return fail('no payment-tool call in the log — nothing to order against haven_get_agent')
  }
  const firstGetAgent = callsTo(log, 'haven_get_agent')[0]
  if (firstGetAgent === undefined) {
    return fail(`the first payment call (${bareToolName(log.calls[firstPayment].name)}) ran with no haven_get_agent before it`)
  }
  if (firstGetAgent > firstPayment) {
    return fail(
      `haven_get_agent ran at call ${firstGetAgent + 1}, AFTER the first payment call ` +
        `${bareToolName(log.calls[firstPayment].name)} at ${firstPayment + 1}`,
    )
  }
  return pass(`haven_get_agent (call ${firstGetAgent + 1}) preceded the first payment tool call (${firstPayment + 1})`)
}

/**
 * `transfer_settled` — the exact USDC transfer reached the exact recipient on
 * the observer node. The amount/recipient/from come from the RESOLVED task
 * (the live budget read + run config), never from the log: a log that claims
 * success but has no matching on-chain transfer fails. This is the grader
 * the #3958 acceptance criterion pins.
 */
export async function transferSettled(log: AgentRunLog, ctx: GraderContext): Promise<GraderResult> {
  const resolved = ctx.resolved
  if (!resolved) return fail('no resolved task in the grader context — the runner must resolve the amount rule first')
  const { amountAtomic, recipient, agentAccount, startedAtBlock } = resolved
  if (!recipient) return fail('the resolved task has no recipient — configure one before running a transfer task')
  if (!agentAccount) return fail('the resolved task has no agent account — the probe cannot know which payer to accept')
  const probe = ctx.probeTransfer
  if (!probe) return fail('no chain probe injected — running a transfer grader without a chain reader proves nothing')

  // The claimed-success evidence is what makes the negative case a FAILURE
  // and not merely an absence: if the log says it worked, the chain must
  // agree, or the run is a false green.
  const claimed = log.calls.some((c) => isPaymentTool(c.name)) || Boolean(log.finalMessage)
  const outcome = await probe({ from: agentAccount, to: recipient, amountAtomic, fromBlock: startedAtBlock })
  if (outcome.ok) {
    return claimed
      ? pass(`exact USDC transfer ${agentAccount}→${recipient} of ${amountAtomic} on-chain (tx ${outcome.txHash})`)
      : fail(`the exact transfer is on-chain (tx ${outcome.txHash}) but the log shows no payment tool call and no message — the grader cannot attribute it to this run`)
  }
  if (claimed) {
    return fail(
      `the log claims a payment happened but the observer has NO matching USDC Transfer ` +
        `${agentAccount}→${recipient} of ${amountAtomic}: ${outcome.error}`,
    )
  }
  return fail(`no payment in the log and no matching transfer on-chain: ${outcome.error}`)
}

/** Pull `payment_id` out of a call's args/result, best-effort. */
function paymentIdFrom(call: RecordedToolCall): string | undefined {
  const fromRecord = (v: unknown): string | undefined => {
    if (v && typeof v === 'object') {
      const rec = v as Record<string, unknown>
      if (typeof rec.payment_id === 'string') return rec.payment_id
      if (typeof rec.id === 'string' && bareToolName(call.name) !== 'haven_get_payment_status') return rec.id
    }
    return undefined
  }
  return fromRecord(call.args) ?? fromRecord(call.result)
}

/**
 * `payment_status_settled` — the payment id the log produced reads back
 * settled/confirmed from the dev backend. The x402 counterpart of
 * `transfer_settled`: an erc7710 redemption is submitted by the merchant's
 * facilitator, so the agent's account may emit no Transfer of its own and
 * the backend status (backed by the settlement evidence) is the outcome.
 * Fails when the log claims success but the probe cannot confirm.
 */
export async function paymentStatusSettled(log: AgentRunLog, ctx: GraderContext): Promise<GraderResult> {
  const probe = ctx.probePaymentStatus
  if (!probe) return fail('no backend probe injected — a status grader without a backend proves nothing')
  const ids = log.calls.map(paymentIdFrom).filter((id): id is string => Boolean(id))
  if (ids.length === 0) {
    return fail('no payment_id anywhere in the log — the run cannot be tied to a backend payment object')
  }
  // Check every id the log produced; ANY unsettled one fails the trial (a
  // retry that left a stranded pending payment is exactly what these tasks
  // exist to catch).
  const results: Array<{ id: string; ok: true; status: string } | { id: string; ok: false; error: string }> = await Promise.all(
    [...new Set(ids)].map(async (id) => ({ id, ...(await probe(id)) })),
  )
  const unconfirmed = results.filter((r) => !r.ok)
  if (unconfirmed.length > 0) {
    return fail(
      `the log claims progress but the backend does not confirm: ` +
        unconfirmed.map((r) => `${r.id}: ${r.error}`).join('; '),
    )
  }
  const unsettledStatuses = results.filter(
    (r): r is { id: string; ok: true; status: string } => r.ok && !['confirmed', 'settled', 'completed'].includes(r.status),
  )
  if (unsettledStatuses.length > 0) {
    return fail(
      `payment(s) not settled: ${unsettledStatuses.map((r) => `${r.id} is ${r.status}`).join(', ')}`,
    )
  }
  return pass(`${results.length} payment(s) confirmed settled by the backend: ${results.map((r) => r.id).join(', ')}`)
}

/**
 * `x402_request_mode_replay` — after a `haven_quote_x402` result whose next
 * step is `haven_pay_x402_quote`, the agent REPLAYED the request in request
 * mode (the quote's `next_arguments`: `url` + `method`, no
 * `payment_required`) instead of re-quoting or hand-building a body. Pinned
 * by the #3739 manual QA run's goal C/D (replay-before-probe).
 */
export function x402RequestModeReplay(log: AgentRunLog): GraderResult {
  const quoteIdx = log.calls.findIndex(
    (c) => bareToolName(c.name) === 'haven_quote_x402' && c.result?.nextTool === 'haven_pay_x402_quote',
  )
  if (quoteIdx === -1) {
    return fail('no haven_quote_x402 result pointing at haven_pay_x402_quote — request-mode replay cannot be graded')
  }
  const after = log.calls
    .slice(quoteIdx + 1)
    .filter((c) => bareToolName(c.name) === 'haven_pay_x402_quote')
  if (after.length === 0) {
    return fail('the agent never called haven_pay_x402_quote after the quote — the x402 purchase was not attempted')
  }
  const replay = after.find((c) => typeof c.args?.url === 'string' && c.args.payment_required === undefined)
  if (!replay) {
    return fail(
      'no haven_pay_x402_quote call after the quote used request mode (url + method, no payment_required) — ' +
        'the agent did not replay the quoted request',
    )
  }
  return pass(`haven_pay_x402_quote replayed the quoted request (url ${String(replay.args?.url).slice(0, 80)})`)
}

/**
 * `tool_called` — generic: `options.name` (bare) was called, optionally
 * AFTER a call to `options.after` (bare) and optionally with
 * `options.notBefore` (bare) — e.g. "haven_get_payment_status ran after the
 * refusal". Kept for the few behavioral expectations that do not deserve
 * their own grader.
 */
export function toolCalled(log: AgentRunLog, options: { name: string; after?: string }): GraderResult {
  const targets = callsTo(log, options.name)
  if (targets.length === 0) {
    return fail(`${options.name} was never called`)
  }
  if (options.after) {
    const afters = callsTo(log, options.after)
    if (afters.length === 0) {
      return fail(`${options.after} was never called — ${options.name} cannot be ordered after it`)
    }
    if (!targets.some((t) => t > afters[0])) {
      return fail(`${options.name} was called only BEFORE ${options.after}`)
    }
  }
  return pass(`${options.name} called${options.after ? ` after ${options.after}` : ''} (call ${targets[0] + 1})`)
}

/** The grader registry a task file may name. Closed on purpose. */
export const GRADERS: Record<GraderName, (log: AgentRunLog, ctx: GraderContext, options: Record<string, unknown>) => Promise<GraderResult> | GraderResult> = {
  transfer_settled: (log, ctx) => transferSettled(log, ctx),
  payment_status_settled: (log, ctx) => paymentStatusSettled(log, ctx),
  no_payment_retry_after_refusal: (log, _ctx, options) => noPaymentRetryAfterRefusal(log, options),
  agent_status_before_payment: (log) => agentStatusBeforePayment(log),
  x402_request_mode_replay: (log) => x402RequestModeReplay(log),
  tool_called: (log, _ctx, options) => toolCalled(log, options as { name: string; after?: string }),
}

/** Apply a task's graders in order; first failure does NOT mask the rest. */
export async function applyGraders(
  log: AgentRunLog,
  graderSpecs: Array<{ name: string; options?: Record<string, unknown> }>,
  ctx: GraderContext,
): Promise<Array<GraderResult & { name: string }>> {
  const results: Array<GraderResult & { name: string }> = []
  for (const spec of graderSpecs) {
    const grader = GRADERS[spec.name as GraderName]
    if (!grader) {
      results.push({ name: spec.name, ...fail(`unknown grader ${JSON.stringify(spec.name)} — not in the registry`) })
      continue
    }
    results.push({ name: spec.name, ...(await grader(log, ctx, spec.options ?? {})) })
  }
  return results
}
