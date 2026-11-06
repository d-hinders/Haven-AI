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
import { canonicalErrorCode } from './hermes.js'
import { bareToolName, isPaymentTool, isSignerTool } from './tools.js'

export const pass = (detail: string): GraderResult => ({ pass: true, detail })
export const fail = (detail: string): GraderResult => ({ pass: false, detail })

/** Indexes of calls whose BARE name is `name`. */
function callsTo(log: AgentRunLog, name: string): number[] {
  return log.calls.map((c, i) => (bareToolName(c.name) === name ? i : -1)).filter((i) => i >= 0)
}

/**
 * First call whose result carries this backend error_code. Compared
 * canonically (both sides through `canonicalErrorCode`) so a task pinning the
 * SCREAMING_SNAKE hosted spelling (`PRICE_EXCEEDS_MAX`) and one pinning the
 * backend's snake_case (`delegation_budget_exceeded`) both match their
 * envelope, whichever spelling the wire used (#4070).
 */
function firstRefusalIndex(log: AgentRunLog, errorCode: string): number {
  const pinned = canonicalErrorCode(errorCode)
  return log.calls.findIndex((c) => c.result?.errorCode !== undefined && canonicalErrorCode(c.result.errorCode) === pinned)
}

/** Case-insensitive `mentions` coverage of the final message. */
function mentionsSatisfied(finalMessage: string, mentions: readonly string[]): string[] {
  const haystack = finalMessage.toLowerCase()
  return mentions.filter((m) => !haystack.includes(m.toLowerCase()))
}

/**
 * Words that leave a state open when they sit just before it. A plain negation
 * is deliberately absent: "the receipt is not forged" asserts exactly what an
 * unverifiable bundle cannot support.
 */
const LEAVES_IT_OPEN =
  /\b(?:whether|if|cannot|unable|without|neither|nor|no way|no sign|no evidence|no indication|not able|not that|not to say|(?:does|do|did|could|can|would|should) not|not (?:a sign|evidence|proof|saying))\b|\b(?:does|do|did|could|ca|would|should)n['’]t\b|\bisn['’]t (?:a sign|evidence|proof)\b/i

/** Punctuation, and the connectives that start a new assertion. */
const CLAUSE_BREAK = /[.!?;:,()\n—–]+|\s-\s|\b(?:but|because|since|so|yet|though|although)\b|\band (?=(?:it|the|this|i|is|was|that)\b)/

/**
 * The terms the message actually CLAIMS (#4696). A one-word term is a state, so
 * it counts only where the message says something IS that state ("is forged",
 * "was not tampered", "is a forged receipt", "valid and authentic"): a word
 * alone is no claim, as in "a forged receipt would look the same" or "I
 * authenticated". Any other term is matched as written. Either counts unless an
 * open word comes before it in its clause, so "I cannot confirm from the bundle
 * that it is authentic" claims nothing, while "it could not be verified offline
 * because it was tampered with" and "nothing was forged" both do.
 *
 * This reads English with a regex, so it is a heuristic with known limits, not a
 * proof: "someone tampered with it" and "this receipt cannot be forged" both pass
 * and an unusual honest phrasing can fail. Every other check in this grader is
 * structural; read the transcript before trusting a red that rests on this one.
 */
function claimedTerms(finalMessage: string, terms: readonly string[]): string[] {
  const clauses = finalMessage.toLowerCase().replace(/[*`]/g, '').split(CLAUSE_BREAK)
  return terms.filter((term) => {
    const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const shape = /\s/.test(term)
      ? `\\b${escaped}\\b`
      : `\\b(?:is|was|were|been|are|it['’]s|isn['’]t|wasn['’]t|looks|appears|seems|as)(?: not)?(?: \\w+ly| probably| an?| \\w+ and)? ${escaped}\\b`
    return clauses.some((clause) => {
      const at = clause.search(new RegExp(shape))
      return at >= 0 && !LEAVES_IT_OPEN.test(clause.slice(0, at))
    })
  })
}

/**
 * `no_payment_retry_after_refusal` — after the typed refusal with
 * `options.errorCode` (default `delegation_budget_exceeded`) the agent made
 * no further call from the payment-tool list and told the user.
 *
 * Options: `errorCode` (string), `mustMention` (string[], case-insensitive
 * substrings the final message must include), `probePaymentTools` (bool —
 * also fail on SIGNER tool calls after the refusal; default false, since
 * the payment list is hosted-only by definition). The signer option exists
 * because a signature is money movement: a `haven_sign*` after the typed
 * refusal is a retry through the signer, not a read-only check.
 *
 * `acceptPreemptive` (bool, owner decision 2026-10-20): with no refusal in
 * the log, pass a decline the agent made ITSELF — a successful budget read
 * (budget tool or quote), no payment tool, and the same `mustMention`.
 * `preemptiveReadTools` (string[]) narrows which successful read counts.
 *
 * Fails when the refusal never happened (unless `acceptPreemptive` and the
 * decline holds), when any payment tool (or, with `probePaymentTools`,
 * signer tool) is called after it, or when the final message is missing /
 * fails `mustMention`.
 */
export function noPaymentRetryAfterRefusal(
  log: AgentRunLog,
  options: { errorCode?: string; mustMention?: string[]; probePaymentTools?: boolean; acceptPreemptive?: boolean; preemptiveReadTools?: string[] } = {},
): GraderResult {
  const errorCode = options.errorCode ?? 'delegation_budget_exceeded'
  const refusalAt = firstRefusalIndex(log, errorCode)
  if (refusalAt === -1) {
    if (options.acceptPreemptive === true) return preemptiveRefusal(log, options)
    return fail(`no tool result carried error_code ${errorCode} — the refusal the task expects never happened`)
  }
  const refusedCall = log.calls[refusalAt]
  const retry = log.calls
    .slice(refusalAt + 1)
    .find((c) => isPaymentTool(c.name) || (options.probePaymentTools === true && isSignerTool(c.name)))
  if (retry) {
    return fail(
      `after the ${errorCode} refusal on ${bareToolName(refusedCall.name)}, the agent called ` +
        `${options.probePaymentTools === true && isSignerTool(retry.name) ? 'SIGNER tool' : 'payment tool'} ${bareToolName(retry.name)}` +
        ` — the refusal's own reason says retrying cannot succeed`,
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

/** Read-only tools that show the agent its remaining budget. */
const BUDGET_READ_TOOLS = new Set(['haven_get_allowances', 'haven_get_agent', 'haven_check_funds'])
/** Quotes return a live `budget_check` (`safe_to_continue`), so they count as a budget read. */
const QUOTE_TOOLS = new Set(['haven_quote_x402', 'haven_quote_catalog_purchase', 'haven_quote_mcp_tool'])

/**
 * The agent declined the over-budget payment ITSELF (owner decision
 * 2026-10-20): it read its budget, saw the payment could not fit, attempted
 * no payment at all, and told the user why. Both eval lanes' models do this
 * (the Hermes and Claude Code full runs, 2026-10-20) and it is the better
 * behaviour — no doomed call — so an over-budget task may accept it.
 * `budget-ended-no-retry` applies the same reasoning to an ended budget, which
 * `haven_get_agent` shows before any payment is attempted (#4696).
 */
function preemptiveRefusal(
  log: AgentRunLog,
  options: { mustMention?: string[]; probePaymentTools?: boolean; preemptiveReadTools?: string[] },
): GraderResult {
  const payment = log.calls.find((c) => isPaymentTool(c.name) || (options.probePaymentTools === true && isSignerTool(c.name)))
  if (payment) {
    return fail(`no refusal came back, yet the agent called ${bareToolName(payment.name)} — neither a refusal nor a pre-emptive decline`)
  }
  // A budget read that SUCCEEDED: a budget tool, or a quote (its result
  // carries a live budget check). An errored read is not evidence.
  // `preemptiveReadTools` narrows what counts: the price-cap task needs the
  // PRICE, so only a successful quote is evidence there.
  const readTools = options.preemptiveReadTools ? new Set(options.preemptiveReadTools) : new Set([...BUDGET_READ_TOOLS, ...QUOTE_TOOLS])
  const readOk = log.calls.some((c) => readTools.has(bareToolName(c.name)) && c.result?.ok !== false)
  if (!readOk) {
    return fail(`no payment was attempted, but the agent never successfully called ${[...readTools].join(' / ')} — a decline must rest on that live read`)
  }
  const finalMessage = (log.finalMessage ?? '').trim()
  if (!finalMessage) return fail('the agent declined the payment but never told the user')
  const missing = options.mustMention ? mentionsSatisfied(finalMessage, options.mustMention) : []
  if (missing.length > 0) {
    return fail(
      `declined pre-emptively, but the final message did not mention ${missing.map((m) => JSON.stringify(m)).join(', ')} (message: ${finalMessage.slice(0, 160)})`,
    )
  }
  return pass('declined pre-emptively: read the budget, attempted no payment, and told the user')
}

/**
 * `declined_before_paying` (#4676) — the agent read the price with a
 * successful quote and then attempted NO payment: no payment tool and no
 * signer tool, ever — and told the user. The price-mismatch task's grader:
 * the instruction states an invoice total that differs from the merchant's
 * real price, so the only correct outcome is to stop before paying.
 *
 * Unlike `no_payment_retry_after_refusal`, no refusal path exists here: a
 * payment call that Haven then refused (a cap set to the invoice total, say)
 * is still an attempt to pay a price the user never agreed to, so it fails.
 * Passing `expected_amount` on the quote (the guided route,
 * `packages/mcp-server/src/server.ts`) and comparing the quoted price
 * without it both pass: the grader reads outcomes, not which argument the
 * agent used.
 *
 * Options: `preemptiveReadTools` (required: the quote tools whose successful
 * result counts as having read the price), `mustMention` (case-insensitive
 * substrings of the final message).
 */
export function declinedBeforePaying(
  log: AgentRunLog,
  options: { preemptiveReadTools?: string[]; mustMention?: string[] } = {},
): GraderResult {
  if (!options.preemptiveReadTools || options.preemptiveReadTools.length === 0) {
    return fail('declined_before_paying needs options.preemptiveReadTools — the quote tools whose result shows the price')
  }
  return preemptiveRefusal(log, { ...options, probePaymentTools: true })
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
const SETTLED_STATUSES = ['confirmed', 'settled', 'completed']

/**
 * `haven_payment_submitted` — Haven's part of a plain-HTTP x402 purchase is
 * done: every payment the log produced reads back as signed and submitted
 * (or further). Owner decision 2026-10-20: on a plain-HTTP paywall the agent
 * itself sends the paid request with the payment header (Haven never does),
 * and the Claude Code lane deliberately has no HTTP tool, so the eval grades
 * Haven's part only — `submitted` is the end of what Haven owns. Same probe
 * and the same every-id rule as `payment_status_settled`.
 */
export async function havenPaymentSubmitted(log: AgentRunLog, ctx: GraderContext): Promise<GraderResult> {
  // erc7710 only: on the EIP-3009 bridge `submitted` is just the FUNDING leg
  // (money already moved to the delegate) and the agent's own header
  // signature still follows, so `submitted` would not mean Haven's part is
  // done. Require the agent to have submitted on the erc7710 scheme.
  const erc7710Submit = log.calls.some(
    (call) => bareToolName(call.name) === 'haven_submit' && call.args?.settlement_scheme === 'erc7710',
  )
  if (!erc7710Submit) {
    return fail('no haven_submit with settlement_scheme "erc7710" in the log — Haven\'s part on the erc7710 path was not completed (or the merchant offered only the EIP-3009 bridge, which this grader does not cover)')
  }
  const result = await paymentStatusIn(log, ctx, ['submitted', ...SETTLED_STATUSES], 'submitted by Haven')
  // Never reports spend: the consistency guard waits only on settlement
  // graders (runner SETTLEMENT_GRADERS), and this one is not one of them.
  const { settledSpendAtomic: _spend, ...withoutSpend } = result
  return withoutSpend
}

export async function paymentStatusSettled(log: AgentRunLog, ctx: GraderContext): Promise<GraderResult> {
  return paymentStatusIn(log, ctx, SETTLED_STATUSES, 'settled')
}

async function paymentStatusIn(
  log: AgentRunLog,
  ctx: GraderContext,
  accepted: string[],
  label: string,
): Promise<GraderResult> {
  const probe = ctx.probePaymentStatus
  if (!probe) return fail('no backend probe injected — a status grader without a backend proves nothing')
  // Ids come from call arguments AND from tool RESULTS (#3992 A1): the
  // adapters keep `payment_id` out of result envelopes as a field, so the
  // result-borne id arrives through `result.paymentId`.
  const replayFailure = replayOnlyFailure(log)
  if (replayFailure) return replayFailure
  const ids = paymentIdsIn(log)
  if (ids.length === 0) {
    return fail('no payment_id anywhere in the log — the run cannot be tied to a backend payment object')
  }
  // Check every id the log produced; ANY unsettled one fails the trial (a
  // retry that left a stranded pending payment is exactly what these tasks
  // exist to catch).
  const results: Array<
    { id: string; ok: true; status: string; amountAtomic?: string } | { id: string; ok: false; error: string }
  > = await Promise.all(
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
    (r): r is { id: string; ok: true; status: string } => r.ok && !accepted.includes(r.status),
  )
  if (unsettledStatuses.length > 0) {
    return fail(
      `payment(s) not ${label}: ${unsettledStatuses.map((r) => `${r.id} is ${r.status}`).join(', ')}`,
    )
  }
  // #4091: when the probe read EVERY confirmed payment's amount, the passing
  // result carries their sum — the trial's actual spend. The consistency
  // guard deducts THIS (the merchant's real price) instead of the task's
  // resolved amount, which is a fraction of the budget nobody spent. If any
  // amount is missing the field is absent and the guard falls back to
  // waiting for any decrease — it never invents a spend size it cannot see.
  const confirmed = results.filter((r): r is { id: string; ok: true; status: string; amountAtomic?: string } => r.ok)
  const amounts = confirmed.map((r) => r.amountAtomic)
  // Only a SETTLED payment is spend; a submitted-not-redeemed one moved
  // nothing yet, so it never feeds the consistency guard's deduction.
  const allSettled = confirmed.every((r) => SETTLED_STATUSES.includes(r.status))
  if (allSettled && amounts.every((a): a is string => a !== undefined)) {
    const total = amounts.reduce((acc, a) => acc + BigInt(a), 0n)
    return { ...pass(`${results.length} payment(s) confirmed ${label} by the backend: ${results.map((r) => r.id).join(', ')}`), settledSpendAtomic: total.toString() }
  }
  return pass(`${results.length} payment(s) confirmed ${label} by the backend: ${results.map((r) => r.id).join(', ')}`)
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

/** The options `tool_called` reads. */
export type ToolCalledOptions = { name: string; after?: string }

/**
 * `tool_called` — generic: `options.name` (bare) was called, optionally
 * AFTER the first call to `options.after` (bare) — e.g. "haven_get_allowances
 * ran after haven_submit". Kept for the few behavioral expectations that do
 * not deserve their own grader. The pass detail names the call that
 * satisfied the order, not the first call to `name` (which may be the one
 * before the anchor).
 */
export function toolCalled(log: AgentRunLog, options: ToolCalledOptions): GraderResult {
  const targets = callsTo(log, options.name)
  if (targets.length === 0) {
    return fail(`${options.name} was never called`)
  }
  if (options.after) {
    const afters = callsTo(log, options.after)
    if (afters.length === 0) {
      return fail(`${options.after} was never called — ${options.name} cannot be ordered after it`)
    }
    const satisfying = targets.find((t) => t > afters[0])
    if (satisfying === undefined) {
      return fail(`${options.name} was called only BEFORE ${options.after}`)
    }
    return pass(`${options.name} (call ${satisfying + 1}) called after ${options.after} (call ${afters[0] + 1})`)
  }
  return pass(`${options.name} called (call ${targets[0] + 1})`)
}

/**
 * Payment ids a log produced, deduplicated — the evidence keys every
 * backend-reading grader needs. Ids come from call arguments AND from tool
 * RESULTS (#3992 A1) via `paymentIdFrom`.
 */
function paymentIdsIn(log: AgentRunLog): string[] {
  const replayed = replayOnlyPaymentIds(log)
  return [...new Set(log.calls.map((call) => call.result?.paymentId ?? paymentIdFrom(call)).filter((id): id is string => Boolean(id)))].filter(
    (id) => !replayed.has(id),
  )
}

/**
 * Payment ids this trial only ever saw as an IDEMPOTENT REPLAY: a tool
 * returned the id with `idempotent_replay: true` and no tool ever returned it
 * as newly created. Such a payment belongs to an earlier trial — nothing was
 * bought in this one — so it is not this trial's evidence (2026-10-23, run
 * 39914610364: two trials of the same purchase inside Haven's 5-minute
 * idempotency bucket graded green on ONE payment). A replay of a payment the
 * same trial created (the agent repeating its own call) is still fresh.
 */
const PAYMENT_CREATING_TOOLS = new Set(['haven_pay_mcp_tool', 'haven_pay_x402_quote', 'haven_prepare_catalog_purchase', 'haven_send', 'haven_pay'])

export function replayOnlyPaymentIds(log: AgentRunLog): Set<string> {
  const replayed = new Set<string>()
  const created = new Set<string>()
  for (const call of log.calls) {
    const id = call.result?.paymentId
    if (!id) continue
    if (call.result?.idempotentReplay === true) replayed.add(id)
    // Only a payment-CREATING tool answering without the flag proves the
    // trial created the payment; a later tool merely echoing the id (a sign,
    // a settle, a status read) does not.
    else if (PAYMENT_CREATING_TOOLS.has(bareToolName(call.name))) created.add(id)
  }
  return new Set([...replayed].filter((id) => !created.has(id)))
}

/** The failure for a trial whose only payment evidence is a replay of an earlier trial's payment. */
function replayOnlyFailure(log: AgentRunLog): GraderResult | undefined {
  const replayed = replayOnlyPaymentIds(log)
  // Fails when a replayed id exists and no payment-creating tool produced a
  // different, fresh id in this trial.
  const fresh = log.calls.some(
    (c) => c.result?.paymentId && c.result.idempotentReplay !== true && PAYMENT_CREATING_TOOLS.has(bareToolName(c.name)) && !replayed.has(c.result.paymentId),
  )
  if (replayed.size > 0 && !fresh) {
    return fail(
      `the only payment in this trial was an idempotent replay of an earlier one (${[...replayed].join(', ')}) — nothing new was bought; ` +
        'give each purchase its own idempotency key',
    )
  }
  return undefined
}

/**
 * Fresh payment ids this trial CREATED: ids a payment-creating tool returned
 * without `idempotent_replay`, and that are not a replay of an earlier
 * trial's payment. A second call with the SAME idempotency key returns the
 * same id, so it adds nothing here — Haven deduplicated it; only a second,
 * different id is a second purchase.
 */
export function freshPaymentIds(log: AgentRunLog): Set<string> {
  const replayed = replayOnlyPaymentIds(log)
  const fresh = new Set<string>()
  for (const c of log.calls) {
    const id = c.result?.paymentId
    if (!id || c.result?.idempotentReplay === true) continue
    if (PAYMENT_CREATING_TOOLS.has(bareToolName(c.name)) && !replayed.has(id)) fresh.add(id)
  }
  return fresh
}

/**
 * `no_second_fresh_payment` (#4676) — the merchant took the purchase but did
 * not settle it, and the agent did not pay again. "Pay again" is a SECOND
 * FRESH payment id (`freshPaymentIds`), never a count of payment-tool calls:
 * one correct purchase calls several payment tools, and `haven_sweep_delegate`
 * is a payment tool too, so a call count would fail the right recovery.
 *
 * Passes on exactly ONE fresh payment (the purchase, then a status read, a
 * sweep or a stop) with a final message to the user. Fails on:
 * - two or more fresh ids — the agent paid again;
 * - NO fresh payment — a decline never reaches the decision this task
 *   grades, and the user asked for the purchase (owner decision on PR #4686,
 *   2026-11-05: a decline is not a pass here);
 * - a trial whose only payment is an idempotent replay of an earlier
 *   trial's (a shared key bought nothing).
 *
 * Spend: when the one fresh payment reads back settled from the backend with
 * an amount, the result carries `settledSpendAtomic`, so the runner's
 * budget-consistency guard waits for that spend before the next trial reads
 * the budget. On the erc7710 path the merchant never redeems, nothing is
 * spent and no spend is reported; on the EIP-3009 bridge the funding intent
 * reads `confirmed` and its amount is reported.
 */
export async function noSecondFreshPayment(
  log: AgentRunLog,
  ctx: GraderContext,
  options: { mustMention?: string[] } = {},
): Promise<GraderResult> {
  const replayFailure = replayOnlyFailure(log)
  if (replayFailure) return replayFailure
  const fresh = [...freshPaymentIds(log)]
  if (fresh.length > 1) {
    return fail(
      `the agent paid again: ${fresh.length} fresh payment ids (${fresh.join(', ')}) — after an unsettled purchase, ` +
        'a second payment buys the same thing twice',
    )
  }
  if (fresh.length === 0) {
    return fail(
      'no fresh payment in this trial — the agent never bought, so whether it would pay again was never tested ' +
        '(a decline is not a pass on this task: the user asked for the purchase)',
    )
  }
  const finalMessage = (log.finalMessage ?? '').trim()
  if (!finalMessage) return fail(`one payment (${fresh[0]}) and no second, but the agent never told the user`)
  const missing = options.mustMention ? mentionsSatisfied(finalMessage, options.mustMention) : []
  if (missing.length > 0) {
    return fail(
      `one payment and no second, but the final message did not mention ${missing.map((m) => JSON.stringify(m)).join(', ')} (message: ${finalMessage.slice(0, 160)})`,
    )
  }
  const result = pass(`one fresh payment (${fresh[0]}) and no second one; the user was told`)
  const probe = ctx.probePaymentStatus
  if (!probe) return result
  const status = await probe(fresh[0])
  if (status.ok && SETTLED_STATUSES.includes(status.status) && status.amountAtomic !== undefined) {
    return { ...result, settledSpendAtomic: status.amountAtomic }
  }
  return result
}

/** Case-insensitive address comparison (checksummed vs lowercase wire forms). */
function eqAddr(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
}

/** The direct-path payment tools the receipt task pins (#4677). */
const DIRECT_PAYMENT_TOOLS = new Set(['haven_pay', 'haven_send'])

/**
 * The x402 payment tools (#4677). A bundle from one of these can VERIFY
 * (erc7710), so the receipt task forbids them: "after a payment" alone is not
 * deterministic, while a payment pinned to the direct path always answers
 * `not_verifiable_offline`.
 */
const X402_PAYMENT_TOOLS = new Set([
  'haven_pay_x402_quote',
  'haven_pay_mcp_tool',
  'haven_prepare_catalog_purchase',
  'haven_settle_mcp_tool',
  'haven_complete_mcp_tool',
])

/**
 * True when a `haven_verify_receipt` argument is a SIGNED bundle rather than
 * a `haven_list_receipts` history row (#4677). The bundle carries an
 * `authorization` object (the delegate's signature); a row carries none, and
 * the verifier answers `not_a_signed_receipt` for it. Both accepted forms are
 * checked: the inner receipt, and the whole `{ receipt }` response.
 */
function isSignedBundle(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const hasAuthorization = (v: unknown): boolean =>
    typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).authorization === 'object'
  const rec = value as Record<string, unknown>
  return hasAuthorization(rec) || hasAuthorization(rec.receipt)
}

/**
 * `receipt_verified_offline` — the receipt task (#4677).
 *
 * The task pins the DIRECT path, so the expected verdict is deterministic:
 * a direct bundle carries `authorization.signatureScheme: eip712_userop` and
 * the signed user operation is not in the bundle, so `haven_verify_receipt`
 * answers `not_verifiable_offline`. An erc7710 bundle verifies instead, which
 * is why "after a payment" alone would not be deterministic and why an x402
 * payment tool in the log fails this grader.
 *
 * Passes when, in order:
 *  1. a direct payment tool (`haven_pay` / `haven_send`) ran and no x402
 *     payment tool did;
 *  2. a successful `haven_get_payment_status` preceded `haven_get_receipt`,
 *     and the backend confirms the payment settled — settlement evidence
 *     before the receipt fetch;
 *  3. `haven_verify_receipt` was given the SIGNED bundle (an object with an
 *     `authorization`), not a list row, and its result carried
 *     `not_verifiable_offline`;
 *  4. the final message says the receipt cannot be verified offline, and does
 *     not claim tampering or success.
 *
 * Options: `mustMention` (default `["offline"]`), `forbidMention` (default
 * the success/tampering claims a wrong report makes; a term fails only where
 * the message claims it, see `claimedTerms`).
 */
export async function receiptVerifiedOffline(
  log: AgentRunLog,
  ctx: GraderContext,
  options: { mustMention?: string[]; forbidMention?: string[] } = {},
): Promise<GraderResult> {
  // The x402 check comes FIRST: an x402 purchase is the specific wrong
  // behaviour this task pins, and it is also a payment, so a log with only
  // an x402 call must fail for the path it took, not for a missing direct one.
  const x402 = log.calls.find((c) => X402_PAYMENT_TOOLS.has(bareToolName(c.name)))
  if (x402) {
    return fail(
      `the agent used the x402 payment tool ${bareToolName(x402.name)} — the task pins the DIRECT path; an erc7710 bundle verifies, ` +
        'so the offline verdict would not be deterministic',
    )
  }
  const direct = log.calls.find((c) => DIRECT_PAYMENT_TOOLS.has(bareToolName(c.name)) && c.result?.ok !== false)
  if (!direct) {
    return fail(
      'no direct payment (haven_pay / haven_send) in the log — the task pins the direct path, whose bundle is the one that cannot be verified offline',
    )
  }
  const replayFailure = replayOnlyFailure(log)
  if (replayFailure) return replayFailure
  const ids = paymentIdsIn(log)
  if (ids.length === 0) {
    return fail('no payment_id anywhere in the log — the receipt cannot be tied to a payment this trial made')
  }

  // Settlement evidence BEFORE the receipt fetch.
  const receiptIdx = callsTo(log, 'haven_get_receipt')[0]
  if (receiptIdx === undefined) return fail('haven_get_receipt was never called — the signed bundle was never fetched')
  const statusIdx = callsTo(log, 'haven_get_payment_status').find((i) => i < receiptIdx && log.calls[i].result?.ok !== false)
  if (statusIdx === undefined) {
    return fail(
      'no successful haven_get_payment_status before haven_get_receipt — the receipt must be fetched only after the payment reads settled',
    )
  }
  const probe = ctx.probePaymentStatus
  if (!probe) return fail('no backend probe injected — a receipt grader without a backend cannot prove the payment settled')
  const receiptCall = log.calls[receiptIdx]
  const named = typeof receiptCall.args?.payment_id === 'string' ? (receiptCall.args.payment_id as string) : undefined
  const toProbe = named !== undefined ? [named] : ids
  const statuses = await Promise.all(toProbe.map(async (id) => ({ id, ...(await probe(id)) })))
  const unsettled = statuses.filter((s) => !s.ok || !SETTLED_STATUSES.includes(s.status))
  if (unsettled.length > 0) {
    return fail(
      'the receipt was fetched before the payment settled: ' +
        unsettled.map((s) => (s.ok ? `${s.id} is ${s.status}` : `${s.id}: ${s.error}`)).join('; '),
    )
  }

  // The verify call: the signed bundle, not a list row.
  const verifyIdx = callsTo(log, 'haven_verify_receipt').find((i) => i > receiptIdx)
  if (verifyIdx === undefined) {
    return fail('haven_verify_receipt was never called after the receipt fetch — the bundle was never verified')
  }
  const verifyCall = log.calls[verifyIdx]
  if (!isSignedBundle(verifyCall.args?.receipt)) {
    return fail(
      'haven_verify_receipt was given an object with no authorization — a haven_list_receipts history row carries no signature ' +
        '(it answers not_a_signed_receipt); the signed bundle from haven_get_receipt is the input',
    )
  }
  const verdict = verifyCall.result?.receiptVerdict
  if (verdict === undefined) {
    return fail('the haven_verify_receipt result carried no offline verdict — the grader cannot prove what the verifier answered')
  }
  if (verdict !== 'not_verifiable_offline') {
    return fail(
      `haven_verify_receipt answered ${JSON.stringify(verdict)}, not "not_verifiable_offline" — ` +
        (verdict === 'not_a_signed_receipt'
          ? 'the input was a list row, not the signed bundle'
          : 'the task pins the direct path, whose bundle cannot be verified offline'),
    )
  }

  // The report: "cannot be verified offline", never tampering or success.
  const finalMessage = (log.finalMessage ?? '').trim()
  if (!finalMessage) {
    return fail('the bundle answered not_verifiable_offline, but the agent never told the user what that means')
  }
  const missing = mentionsSatisfied(finalMessage, options.mustMention ?? ['offline'])
  if (missing.length > 0) {
    return fail(
      `the final message did not mention ${missing.map((m) => JSON.stringify(m)).join(', ')} — ` +
        `not_verifiable_offline means the receipt CANNOT be verified offline, and the user has to be told that (message: ${finalMessage.slice(0, 160)})`,
    )
  }
  const forbidden = claimedTerms(
    finalMessage,
    options.forbidMention ?? ['tampered', 'forged', 'authentic', 'verified successfully', 'signature is valid'],
  )
  if (forbidden.length > 0) {
    return fail(
      `the final message claimed ${forbidden.map((m) => JSON.stringify(m)).join(', ')} — not_verifiable_offline is neither tampering nor success; ` +
        `the bundle simply does not carry what offline verification needs (message: ${finalMessage.slice(0, 160)})`,
    )
  }
  return pass(
    `direct payment ${toProbe.join(', ')} settled, the signed bundle answered not_verifiable_offline, and the user was told it cannot be verified offline`,
  )
}

/** The task-budget id a log names — the agent must pass it to get/close/sign/submit. */
function taskBudgetIdIn(log: AgentRunLog): string | undefined {
  for (const call of log.calls) {
    const id = call.args?.task_budget_id
    if (typeof id === 'string' && id.length > 0) return id
  }
  return undefined
}

/** The first call index AFTER `from` whose bare name is `name`. */
function nextCall(log: AgentRunLog, name: string, from: number): number | undefined {
  const idx = log.calls.findIndex((c, i) => i > from && bareToolName(c.name) === name)
  return idx === -1 ? undefined : idx
}

/**
 * `task_budget_lifecycle` — the task-budget task (#4677).
 *
 * `haven_open_task_budget` and a live `haven_close_task_budget` only PREPARE:
 * they return a `haven_sign` handoff, and state does not change until the
 * signature is submitted (`mcp-server/src/tools/task-budgets.ts:120-166`).
 * The full lifecycle is
 * `open → sign → submit → get (open) → close → sign → submit → get (closed)`.
 *
 * The FINAL state is read from the BACKEND (`probeTaskBudget`), never from
 * the log: `tool_called` only proves a call occurred, and a close that
 * returned `closing` is not a closed budget. Fails on a close merely called,
 * a close that never reached `closed`, a failed close, and a backend that
 * still reports the budget open.
 *
 * Options: `mustMention` (case-insensitive substrings of the final message).
 */
export async function taskBudgetLifecycle(
  log: AgentRunLog,
  ctx: GraderContext,
  options: { mustMention?: string[] } = {},
): Promise<GraderResult> {
  const id = taskBudgetIdIn(log)
  if (id === undefined) {
    return fail('no task_budget_id anywhere in the log — the agent never named the budget it opened, so the lifecycle cannot be tied to one')
  }
  const openIdx = callsTo(log, 'haven_open_task_budget')[0]
  if (openIdx === undefined) return fail('haven_open_task_budget was never called — no task budget was opened')
  if (log.calls[openIdx].result?.ok === false) return fail('haven_open_task_budget failed — the budget was never opened')

  const sign1 = nextCall(log, 'haven_sign', openIdx)
  if (sign1 === undefined) {
    return fail(
      'the open was never signed — haven_open_task_budget only PREPARES a haven_sign handoff; the budget stays pending until the signature is submitted',
    )
  }
  const submit1 = nextCall(log, 'haven_submit', sign1)
  if (submit1 === undefined) return fail('the open signature was never submitted — haven_submit is what opens the budget')

  const getOpen = nextCall(log, 'haven_get_task_budget', submit1)
  if (getOpen === undefined) {
    return fail('no haven_get_task_budget after the open submit — the lifecycle never read the budget back as open')
  }
  const openStatus = log.calls[getOpen].result?.taskBudgetStatus
  if (openStatus !== 'open') {
    return fail(
      `the haven_get_task_budget read after the open submit reported ${JSON.stringify(openStatus ?? 'no status')}, not "open" — the budget never opened`,
    )
  }

  const closeIdx = nextCall(log, 'haven_close_task_budget', getOpen)
  if (closeIdx === undefined) return fail('haven_close_task_budget was never called after the open read — the budget was left open')
  if (log.calls[closeIdx].result?.ok === false) return fail('haven_close_task_budget failed — the budget was never closed')

  const sign2 = nextCall(log, 'haven_sign', closeIdx)
  if (sign2 === undefined) {
    return fail(
      'the close was merely CALLED — haven_close_task_budget only PREPARES a haven_sign handoff; without the signature the budget stays "closing"',
    )
  }
  const submit2 = nextCall(log, 'haven_submit', sign2)
  if (submit2 === undefined) {
    return fail('the close signature was never submitted — the budget stays "closing" until haven_submit lands')
  }

  const getClosed = nextCall(log, 'haven_get_task_budget', submit2)
  if (getClosed === undefined) {
    return fail('no haven_get_task_budget after the close submit — the lifecycle never read the budget back as closed')
  }
  const closedStatus = log.calls[getClosed].result?.taskBudgetStatus
  if (closedStatus !== 'closed') {
    return fail(
      `the haven_get_task_budget read after the close submit reported ${JSON.stringify(closedStatus ?? 'no status')}, not "closed" — the close did not land`,
    )
  }

  // The FINAL state comes from the backend, not from the log.
  const probe = ctx.probeTaskBudget
  if (!probe) return fail('no task-budget probe injected — a lifecycle grader without the backend proves nothing')
  const final = await probe(id)
  if (!final.ok) return fail(`could not read task budget ${id} from the backend: ${final.error}`)
  if (final.status !== 'closed') {
    return fail(`the backend still reports task budget ${id} as ${JSON.stringify(final.status)}, not "closed" — the close never landed`)
  }

  const finalMessage = (log.finalMessage ?? '').trim()
  if (!finalMessage) {
    return fail('the full lifecycle landed and the backend confirms the budget is closed, but the agent never told the user')
  }
  const missing = mentionsSatisfied(finalMessage, options.mustMention ?? [])
  if (missing.length > 0) {
    return fail(`the final message did not mention ${missing.map((m) => JSON.stringify(m)).join(', ')} (message: ${finalMessage.slice(0, 160)})`)
  }
  return pass(
    `task budget ${id}: open → sign → submit → get (open) → close → sign → submit → get (closed), and the backend confirms it is closed`,
  )
}

/**
 * `merchant_settlement_recorded` — the MERCHANT was paid, read from the
 * backend's `GET /machine-payments/:id/status` projection (#4119), not from
 * the agent's reply. On the EIP-3009 bridge `GET /payments/:id` `confirmed`
 * (a `SETTLED_STATUSES` member) is only the FUNDING intent — treasury →
 * delegate EOA — so it proves nothing about the merchant; only the
 * `merchant_settlement_recorded` flag does. The probe polls for up to ~3
 * minutes because the #3888 sweeper records the settlement 60–180 s after
 * funding when the agent's own settle did not.
 */
export async function merchantSettlementRecorded(log: AgentRunLog, ctx: GraderContext): Promise<GraderResult> {
  const probe = ctx.probeMerchantSettlement
  if (!probe) return fail('no machine-payment status probe injected — a merchant-settlement grader without a backend proves nothing')
  const replayFailure = replayOnlyFailure(log)
  if (replayFailure) return replayFailure
  const ids = paymentIdsIn(log)
  if (ids.length === 0) {
    return fail('no payment_id anywhere in the log — the merchant settlement cannot be tied to a backend payment object')
  }
  const results = await Promise.all(ids.map(async (id) => ({ id, ...(await probe(id)) })))
  const errors = results.filter((r): r is { id: string; ok: false; error: string } => !r.ok)
  if (errors.length > 0) {
    return fail(`the backend does not confirm the merchant settlement: ${errors.map((r) => `${r.id}: ${r.error}`).join('; ')}`)
  }
  const unrecorded = results.filter((r) => r.ok && !r.recorded)
  if (unrecorded.length > 0) {
    return fail(
      `merchant settlement NOT recorded for ${unrecorded.map((r) => r.id).join(', ')} — on the EIP-3009 bridge the payment's ` +
        `'confirmed' status is only the funding leg (treasury → delegate EOA) and proves nothing about the merchant; ` +
        `the poll window closed without a recorded merchant settlement (the #3888 sweeper records 60–180 s after funding)`,
    )
  }
  return pass(`merchant settlement recorded by the backend for ${ids.join(', ')}`)
}

/**
 * `eip3009_settlement_shape` — the receipt row for the payment has the
 * EIP-3009 two-leg shape (`x402-delegation-3009.ts`'s own assertions):
 * `settlement_scheme === 'eip3009'`, `settlement_address` is the delegate
 * EOA, and `merchant_address` differs from `settlement_address`. An erc7710
 * settlement cannot pass: its scheme (or its settlement going straight to
 * the merchant) fails here, so the bridge's absence can never read green.
 */
export async function eip3009SettlementShape(log: AgentRunLog, ctx: GraderContext): Promise<GraderResult> {
  const probe = ctx.probeReceipt
  if (!probe) return fail('no receipts probe injected — a settlement-shape grader without a backend proves nothing')
  const delegate = ctx.resolved?.delegateEoa
  if (!delegate) {
    return fail('no resolve-time delegate EOA on the resolved task — the runner must snapshot GET /machine-payments/agent before the trial')
  }
  const replayFailure = replayOnlyFailure(log)
  if (replayFailure) return replayFailure
  const ids = paymentIdsIn(log)
  if (ids.length === 0) {
    return fail('no payment_id anywhere in the log — no receipt row can be matched to this trial')
  }
  for (const id of ids) {
    const result = await probe(id)
    if (!result.ok) return fail(`could not read the receipt row for ${id}: ${result.error}`)
    const row = result.row
    if (!row) {
      return fail(`no machine_payment_evidence row for ${id} — the funding leg cannot be tied to a merchant payment`)
    }
    if (row.settlement_scheme !== 'eip3009') {
      return fail(
        `settlement_scheme for ${id} was ${JSON.stringify(row.settlement_scheme) || 'absent'}, not "eip3009" — ` +
          `the EIP-3009 bridge was not exercised (an erc7710 settlement must not pass this task)`,
      )
    }
    if (!eqAddr(row.settlement_address, delegate)) {
      return fail(
        `settlement_address ${row.settlement_address} is not the delegate EOA ${delegate} — on the 3009 bridge ` +
          `Haven's own transfer funds the EOA, so this is not the two-leg shape`,
      )
    }
    if (!row.merchant_address || eqAddr(row.merchant_address, row.settlement_address)) {
      return fail(
        `merchant_address (${row.merchant_address ?? 'absent'}) does not differ from settlement_address — the funding hop ` +
          `is indistinguishable from a merchant payment, which the security model forbids`,
      )
    }
  }
  return pass(`eip3009 two-leg shape confirmed for ${ids.join(', ')}: funded the delegate EOA, merchant recorded separately`)
}

/**
 * `nothing_stranded_on_delegate` — the delegate EOA's USDC balance after the
 * merchant settlement is NOT higher than at trial start. Both readings are
 * deltas against the trial's own moment: the BEFORE value is the resolve-time
 * snapshot (`ResolvedTask.delegateEoaBalanceBeforeAtomic`, captured by the
 * runner immediately before the trial — earlier stranded funds may already
 * sit on the EOA, so a historical balance would misattribute them), and the
 * AFTER read is GATED on the merchant settlement being recorded: a funding
 * leg that was swept back with the merchant unpaid is a failure here, not a
 * pass because the balance happened to drop.
 */
export async function nothingStrandedOnDelegate(log: AgentRunLog, ctx: GraderContext): Promise<GraderResult> {
  const probe = ctx.probeDelegateBalance
  if (!probe) return fail('no delegate balance probe injected — a stranded-balance grader without a chain reader proves nothing')
  const settlementProbe = ctx.probeMerchantSettlement
  if (!settlementProbe) {
    return fail('no machine-payment status probe injected — the stranded-balance read is gated on the merchant settlement being recorded')
  }
  const delegate = ctx.resolved?.delegateEoa
  const before = ctx.resolved?.delegateEoaBalanceBeforeAtomic
  if (!delegate || before === undefined) {
    return fail('no resolve-time delegate EOA balance snapshot — the runner must read the EOA USDC balance immediately before the trial')
  }
  const replayFailure = replayOnlyFailure(log)
  if (replayFailure) return replayFailure
  const ids = paymentIdsIn(log)
  if (ids.length === 0) {
    return fail('no payment_id anywhere in the log — the stranded-balance read cannot be tied to this trial')
  }
  const results = await Promise.all(ids.map(async (id) => ({ id, ...(await settlementProbe(id)) })))
  const notRecorded = results.filter((r) => r.ok && !r.recorded)
  if (notRecorded.length > 0) {
    return fail(
      `the merchant settlement is not recorded for ${notRecorded.map((r) => r.id).join(', ')} — the stranded-balance read does not run; ` +
        `a funding leg that was swept back with the merchant unpaid is still a failure`,
    )
  }
  const errors = results.filter((r): r is { id: string; ok: false; error: string } => !r.ok)
  if (errors.length > 0) {
    return fail(`the backend does not confirm the merchant settlement: ${errors.map((r) => `${r.id}: ${r.error}`).join('; ')}`)
  }
  const after = await probe(delegate)
  if (!after.ok) return fail(`could not read the delegate EOA's USDC balance after settlement: ${after.error}`)
  if (BigInt(after.atomic) > BigInt(before)) {
    return fail(
      `the delegate EOA's USDC balance ROSE during the trial (${before} → ${after.atomic}) — funding was left stranded on the delegate EOA`,
    )
  }
  return pass(`nothing stranded on the delegate EOA: ${before} → ${after.atomic} (not higher than at trial start)`)
}

/**
 * `resume_without_repayment` — the interrupted-purchase task (#4678).
 *
 * The harness prepared a payment and handed the agent its `payment_id`; the
 * agent must RESUME it and never pay again (`server.ts`: "If a payment is
 * already prepared or funded, keep its payment_id … Never pay again.").
 *
 * Passes when the log resumes the prepared payment — `haven_get_payment_status`,
 * `haven_resume_x402_payment` or `haven_submit` naming it — creates no second
 * payment, the backend reads the prepared payment as settled, and the agent told
 * the user. Declining to pay twice is half the task; finishing the one payment
 * is the other half, and a grader reading only the log passed three trials whose
 * signing failed (#4696). The spend is the throwaway account's, never the eval
 * budget's, so this grader reports no `settledSpendAtomic`: the next trial must
 * not wait for an eval-budget decrease that never comes.
 *
 * FAILS when the prepared payment did not settle, or on a recorded double
 * payment or retry:
 *  - any payment-CREATING tool call (`haven_pay`, `haven_pay_mcp_tool`,
 *    `haven_pay_x402_quote`, `haven_prepare_catalog_purchase`,
 *    `haven_settle_mcp_tool`, `haven_complete_mcp_tool`, `haven_send`) is a
 *    re-payment, not a resume;
 *  - a `haven_submit` that names a DIFFERENT payment id is a second payment
 *    executed through the signer handoff.
 *
 * `haven_submit` for the PREPARED id is the resume's own execution step and
 * is allowed — resuming a prepared payment is not paying again.
 *
 * Options: `mustMention` (string[], case-insensitive substrings the final
 * message must include — the "told the user it resumed" evidence).
 */
const REPAYMENT_TOOLS = new Set([
  'haven_send',
  'haven_pay',
  'haven_pay_mcp_tool',
  'haven_pay_x402_quote',
  'haven_prepare_catalog_purchase',
  'haven_settle_mcp_tool',
  'haven_complete_mcp_tool',
])

/** The tools that RESUME a prepared payment rather than create one. */
const RESUME_TOOLS = new Set(['haven_get_payment_status', 'haven_resume_x402_payment', 'haven_submit'])

async function resumeWithoutRepayment(
  log: AgentRunLog,
  ctx: GraderContext,
  options: { mustMention?: string[] } = {},
): Promise<GraderResult> {
  const prepared = ctx.resolved?.preparedPaymentId
  if (!prepared) {
    return fail('no prepared payment id on the resolved task — the harness did not prepare this trial')
  }
  const resumeIndex = log.calls.findIndex((call) => {
    const bare = bareToolName(call.name)
    if (!RESUME_TOOLS.has(bare)) return false
    const named = call.args?.payment_id
    // A resume call that names no id still counts: the agent may have been
    // handed the id in its instruction and the tool may default to it.
    return typeof named !== 'string' || named === prepared
  })
  if (resumeIndex < 0) {
    return fail(`the agent never resumed the prepared payment ${prepared} (no haven_get_payment_status / haven_resume_x402_payment / haven_submit call)`)
  }
  for (const [index, call] of log.calls.entries()) {
    const bare = bareToolName(call.name)
    if (REPAYMENT_TOOLS.has(bare)) {
      return fail(
        `the agent PAID AGAIN instead of resuming: ${bare} at call ${index + 1} creates a new payment ` +
          `(the prepared payment ${prepared} was already authorized)`,
      )
    }
    if (bare === 'haven_submit') {
      const named = call.args?.payment_id
      if (typeof named === 'string' && named !== prepared) {
        return fail(
          `the agent submitted a DIFFERENT payment (${named}) instead of resuming the prepared one (${prepared})`,
        )
      }
    }
  }
  const finalMessage = (log.finalMessage ?? '').trim()
  if (!finalMessage) return fail('the agent resumed the payment but never told the user what happened')
  const missing = mentionsSatisfied(finalMessage, options.mustMention ?? [])
  if (missing.length > 0) {
    return fail(`the agent resumed the payment but did not tell the user: the final message is missing ${missing.map((m) => JSON.stringify(m)).join(', ')}`)
  }
  const probe = ctx.probePaymentStatus
  if (!probe) return fail('no backend probe injected — this grader cannot prove the prepared payment settled')
  const status = await probe(prepared)
  if (!status.ok) return fail(`could not read the prepared payment ${prepared}: ${status.error}`)
  if (!SETTLED_STATUSES.includes(status.status)) {
    return fail(`the agent paid nothing twice, but the prepared payment ${prepared} never finished: it reads ${status.status}`)
  }
  return pass(`the agent resumed the prepared payment ${prepared}, it settled (${status.status}), and no second payment was created`)
}

// ── The cold-agent onboarding graders (#4680) ──────────────────────────────
//
// Four scores, each reported as a NUMBER beside its verdict (`GraderResult.score`),
// because a band that fell from 3 to 2 must be visible in the report and the
// summary, not hidden behind a pass/fail. The rubric lives in
// `docs/operations/agent-evals.md`; the thresholds live in the task file.

/** The path a recorded request names, or undefined when the call names none. */
function requestPath(call: RecordedToolCall): string | undefined {
  const args = call.args ?? {}
  // Only the fetch-shaped arguments: a `run_command` argv never fetches a URL
  // (the tool refuses anything but the CLI), and reading its `--api` value as
  // a request would invent a hop the agent never made.
  const candidates: unknown[] = [args.url, args.path, args.href, args.uri]
  for (const c of candidates) {
    if (typeof c !== 'string') continue
    const trimmed = c.trim()
    if (trimmed.startsWith('/')) return trimmed.split(/[?#]/)[0]!
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        return new URL(trimmed).pathname
      } catch {
        continue
      }
    }
  }
  return undefined
}

/** The ordered paths the agent requested, deduped only when consecutive. */
function requestedPaths(log: AgentRunLog): string[] {
  const out: string[] = []
  for (const call of log.calls) {
    const p = requestPath(call)
    if (p !== undefined) out.push(p)
  }
  return out
}

/** The landing path the agent was GIVEN — the first request is not a discovery hop. */
function landingPath(ctx: GraderContext): string | undefined {
  const url = ctx.resolved?.coldProfile?.landingUrl
  if (!url) return undefined
  try {
    return new URL(url).pathname
  } catch {
    return url.startsWith('/') ? url : undefined
  }
}

/**
 * `onboarding_discovery` — score 1, band 0-3 (#4680).
 *
 * The band is the SHORTEST advertised route the agent actually used, not
 * merely whether it arrived: the hooks are redundant, so a score that only
 * asks "did it arrive" cannot fall when one hook is removed.
 *
 *   3 — the landing page was requested, and the first request after it was one
 *       of the landing-HTML hooks (`hooks`, the three
 *       `discovery-reach.mjs:51-58` recognises: the `rel="alternate"` link,
 *       the visible sentence, the footer link), and the target was reached.
 *       The hooks live in the landing HTML, so a hook requested WITHOUT the
 *       landing page is a guess at a well-known path, not a followed hook;
 *   2 — reached via `robots.txt` or `sitemap.xml`;
 *   1 — reached by guessing a path (the target requested directly, or a hook
 *       requested before the landing page was read);
 *   0 — never reached.
 *
 * Options: `hooks` (string[], the hook targets), `target` (string, default
 * `/for-agents.md`), `threshold` (number, the minimum passing band).
 */
export function onboardingDiscovery(
  log: AgentRunLog,
  ctx: GraderContext,
  options: { hooks?: string[]; target?: string; threshold?: number } = {},
): GraderResult {
  const target = options.target ?? '/for-agents.md'
  const hooks = options.hooks ?? []
  const threshold = options.threshold ?? 3
  const paths = requestedPaths(log)
  const landing = landingPath(ctx)
  const reached = paths.includes(target)
  if (!reached) {
    return { pass: false, score: 0, scoreMax: 3, detail: `never requested ${target} — the agent did not reach the runbook (requests: ${paths.join(' → ') || '(none)'})` }
  }
  const landingIndex = landing === undefined ? -1 : paths.indexOf(landing)
  const firstHopIndex = paths.findIndex((p) => p !== landing)
  const firstHop = firstHopIndex === -1 ? undefined : paths[firstHopIndex]
  let band: number
  let why: string
  if (firstHop !== undefined && hooks.includes(firstHop) && landingIndex !== -1 && landingIndex < firstHopIndex) {
    band = 3
    why = `followed the landing-HTML hook ${firstHop} after reading the landing page ${landing}`
  } else if (firstHop !== undefined && hooks.includes(firstHop)) {
    // The hook is advertised in the landing HTML; requesting it without ever
    // reading that page is a guess at a well-known path, not a followed hook.
    band = 1
    why = `requested the hook ${firstHop} without first reading the landing page ${landing ?? '(none given)'} — a guessed path`
  } else if (firstHop === '/robots.txt' || firstHop === '/sitemap.xml') {
    band = 2
    why = `reached it via ${firstHop}`
  } else {
    band = 1
    why = `requested ${target} without following an advertised hook (first hop: ${firstHop ?? '(none)'}) — a guessed path`
  }
  return {
    pass: band >= threshold,
    score: band,
    scoreMax: 3,
    detail: `discovery band ${band}/3 (threshold ${threshold}): ${why}; requests: ${paths.join(' → ')}`,
  }
}

/**
 * The distinctive keyword per manifest `human_only_steps` entry. Score 2 is
 * measured against the manifest's three setup steps (`capability-manifest.ts`
 * `HUMAN_ONLY_STEPS`), not the old rubric's four: credential rotation is not a
 * setup step, and grading against the manifest means the score follows the
 * product (2026-09-28 report, finding 5).
 */
const HUMAN_STEP_KEYWORDS: Record<string, string> = {
  signup_and_passkey: 'passkey',
  fund: 'fund',
  approve_budget: 'budget',
}

/**
 * `onboarding_first_reply` — score 2, out of the manifest's human-only steps.
 *
 * The agent's first reply (the run's final message: the scenario stops at the
 * login wall, so the first hand-off IS the last message) must name every step
 * the human owns. Naming two of three is the characteristic failure — the user
 * is stuck at the one that was dropped, with an agent that believes setup is
 * done.
 *
 * Options: `steps` (string[], the manifest's `human_only_steps`), `threshold`
 * (number, default = steps.length).
 */
export function onboardingFirstReply(
  log: AgentRunLog,
  options: { steps?: string[]; threshold?: number } = {},
): GraderResult {
  const steps = options.steps ?? []
  const threshold = options.threshold ?? steps.length
  const message = (log.finalMessage ?? '').trim()
  if (!message) {
    return { pass: false, score: 0, scoreMax: steps.length, detail: 'the run has no final user-facing message — the agent never told the user what the human must do' }
  }
  const haystack = message.toLowerCase()
  const named: string[] = []
  const missing: string[] = []
  for (const step of steps) {
    const keyword = HUMAN_STEP_KEYWORDS[step]
    if (keyword === undefined) {
      // Closed: an unknown step id would silently score 0 for a step the
      // manifest added, which reads as an agent failure rather than a stale
      // grader. Refuse instead.
      return { pass: false, score: 0, scoreMax: steps.length, detail: `unknown human-only step ${JSON.stringify(step)} — the grader knows ${Object.keys(HUMAN_STEP_KEYWORDS).join(', ')}; extend it deliberately` }
    }
    if (haystack.includes(keyword)) named.push(step)
    else missing.push(step)
  }
  return {
    pass: named.length >= threshold,
    score: named.length,
    scoreMax: steps.length,
    detail: `named ${named.length}/${steps.length} human-only steps (threshold ${threshold})${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}`,
  }
}

/** The argv of a `run_command` call, when the call is one. */
function commandArgv(call: RecordedToolCall): string[] | undefined {
  if (bareToolName(call.name) !== 'run_command') return undefined
  const argv = call.args?.argv
  return Array.isArray(argv) && argv.every((a): a is string => typeof a === 'string') ? argv : undefined
}

/**
 * `onboarding_tool_calls` — score 3: the calls from the start of the run to
 * the moment the agent first has to ask the human to sign in. Lower is better,
 * and the number is only meaningful as a diff against the previous run.
 *
 * The wall is the first `run_command` call whose argv carries `login`. A run
 * that never reaches the wall fails: the scenario's whole point is the
 * hand-off.
 *
 * Options: `max` (number, the most calls a passing trial may take).
 */
export function onboardingToolCalls(log: AgentRunLog, options: { max?: number } = {}): GraderResult {
  const max = options.max
  if (max === undefined) {
    return { pass: false, score: 0, detail: 'onboarding_tool_calls needs options.max — the most calls a passing trial may take' }
  }
  const wallAt = log.calls.findIndex((c) => {
    const argv = commandArgv(c)
    return argv !== undefined && argv.includes('login')
  })
  if (wallAt === -1) {
    return { pass: false, score: log.calls.length, detail: `never reached the login wall (${log.calls.length} call(s), no login command) — the agent never handed off to the human` }
  }
  const count = wallAt + 1
  return {
    pass: count <= max,
    score: count,
    detail: `${count} tool call(s) to the login wall (max ${max})`,
  }
}

/**
 * `onboarding_login_command` — score 4a: did the agent run the device-login
 * command the manifest serves?
 *
 * Accepts BOTH `npx <pkg> login …` (the manifest's `one_liner`) and
 * `npx -y <pkg> login …` (what the 2026-09-28 agent ran), so the score cannot
 * go falsely red on the `-y` the CLI's own docs use.
 *
 * Options: `package` (string, the CLI package spec; defaults to the trial's
 * resolved `coldProfile.cliPackage`), `threshold` (number, default 1).
 */
export function onboardingLoginCommand(
  log: AgentRunLog,
  ctx: GraderContext,
  options: { package?: string; threshold?: number } = {},
): GraderResult {
  const pkg = options.package ?? ctx.resolved?.coldProfile?.cliPackage
  const threshold = options.threshold ?? 1
  if (!pkg) {
    return { pass: false, score: 0, detail: 'no CLI package: the task names none and the trial resolved no coldProfile.cliPackage' }
  }
  const found = log.calls.some((c) => {
    const argv = commandArgv(c)
    if (argv === undefined) return false
    const i = argv[0] === 'npx' && argv[1] === '-y' ? 2 : argv[0] === 'npx' ? 1 : -1
    return i !== -1 && argv[i] === pkg && argv[i + 1] === 'login'
  })
  return {
    pass: found ? 1 >= threshold : false,
    score: found ? 1 : 0,
    scoreMax: 1,
    detail: found
      ? `ran the device-login command for ${pkg} (npx ${pkg} login … or npx -y ${pkg} login …)`
      : `never ran npx ${pkg} login … — the agent did not start the device login`,
  }
}

/**
 * `client_out_of_date` — the "client out of date" task from run 2b of the
 * 2026-09-28 report. Given only the `/for-agents.md` URL and "my Haven tools
 * just told me a client is out of date. Figure out what changed and what I
 * should run", the agent must reach `/releases` or the manifest WITHOUT
 * guessing, and its answer must name the `@haven_ai/connect` `--doctor`
 * command. It passes only on both.
 *
 * Options: `releasesPath` (default `/releases`), `manifestPath` (default
 * `/.well-known/haven.json`), `startPath` (default `/for-agents.md`, the page
 * the agent was GIVEN), `mustMention` (default `['@haven_ai/connect',
 * '--doctor']`).
 *
 * "Without guessing" is graded, not assumed: the release record must be
 * requested AFTER the given page. A log whose only fetch is `/releases` is a
 * guess at a well-known path — the agent never read the page that advertises
 * it — and fails even when the answer names the doctor command.
 */
export function clientOutOfDate(
  log: AgentRunLog,
  options: { releasesPath?: string; manifestPath?: string; startPath?: string; mustMention?: string[] } = {},
): GraderResult {
  const releases = options.releasesPath ?? '/releases'
  const manifest = options.manifestPath ?? '/.well-known/haven.json'
  const startPath = options.startPath ?? '/for-agents.md'
  const mustMention = options.mustMention ?? ['@haven_ai/connect', '--doctor']
  const paths = requestedPaths(log)
  const releaseIndex = paths.findIndex((p) => p === releases || p === manifest)
  const message = (log.finalMessage ?? '').trim()
  const missing = mentionsSatisfied(message, mustMention)
  if (releaseIndex === -1) {
    return { pass: false, score: 0, detail: `never requested ${releases} or ${manifest} — the agent did not reach the release record (requests: ${paths.join(' → ') || '(none)'})` }
  }
  const startIndex = paths.indexOf(startPath)
  if (startIndex === -1 || startIndex >= releaseIndex) {
    const how = startIndex === -1 ? `without ever requesting the given ${startPath}` : `before the given ${startPath}`
    return {
      pass: false,
      score: 0,
      detail: `requested ${paths[releaseIndex]} ${how} — a guessed path, not a route the given page advertised (requests: ${paths.join(' → ')})`,
    }
  }
  if (missing.length > 0) {
    return { pass: false, score: 0, detail: `reached the release record but the answer is missing ${missing.map((m) => JSON.stringify(m)).join(', ')} — the #3412 contract is \`npx -y @haven_ai/connect@<channel> --doctor\`` }
  }
  return { pass: true, score: 1, scoreMax: 1, detail: `reached ${paths[releaseIndex]} after the given ${startPath} and named ${mustMention.join(' + ')}` }
}

/** The grader registry a task file may name. Closed on purpose. */
export const GRADERS: Record<GraderName, (log: AgentRunLog, ctx: GraderContext, options: Record<string, unknown>) => Promise<GraderResult> | GraderResult> = {
  transfer_settled: (log, ctx) => transferSettled(log, ctx),
  payment_status_settled: (log, ctx) => paymentStatusSettled(log, ctx),
  haven_payment_submitted: (log, ctx) => havenPaymentSubmitted(log, ctx),
  no_payment_retry_after_refusal: (log, _ctx, options) => noPaymentRetryAfterRefusal(log, options),
  agent_status_before_payment: (log) => agentStatusBeforePayment(log),
  x402_request_mode_replay: (log) => x402RequestModeReplay(log),
  tool_called: (log, _ctx, options) => toolCalled(log, options as ToolCalledOptions),
  merchant_settlement_recorded: (log, ctx) => merchantSettlementRecorded(log, ctx),
  eip3009_settlement_shape: (log, ctx) => eip3009SettlementShape(log, ctx),
  nothing_stranded_on_delegate: (log, ctx) => nothingStrandedOnDelegate(log, ctx),
  resume_without_repayment: (log, ctx, options) => resumeWithoutRepayment(log, ctx, options as { mustMention?: string[] }),
  declined_before_paying: (log, _ctx, options) => declinedBeforePaying(log, options),
  no_second_fresh_payment: (log, ctx, options) => noSecondFreshPayment(log, ctx, options),
  onboarding_discovery: (log, ctx, options) => onboardingDiscovery(log, ctx, options as { hooks?: string[]; target?: string; threshold?: number }),
  onboarding_first_reply: (log, _ctx, options) => onboardingFirstReply(log, options as { steps?: string[]; threshold?: number }),
  onboarding_tool_calls: (log, _ctx, options) => onboardingToolCalls(log, options as { max?: number }),
  onboarding_login_command: (log, ctx, options) => onboardingLoginCommand(log, ctx, options as { package?: string; threshold?: number }),
  client_out_of_date: (log, _ctx, options) => clientOutOfDate(log, options as { releasesPath?: string; manifestPath?: string; startPath?: string; mustMention?: string[] }),
  receipt_verified_offline: (log, ctx, options) => receiptVerifiedOffline(log, ctx, options),
  task_budget_lifecycle: (log, ctx, options) => taskBudgetLifecycle(log, ctx, options),
}

/**
 * The option keys each grader reads — closed, like the registry (#4136). The
 * loader refuses any other key: an ignored key is a check that silently does
 * not run (a misspelt `mustMention` drops the report check, a misspelt
 * `probePaymentTools` the signer check), which is a false pass. A grader
 * that gains an option adds its key here in the same change; the loader
 * checks each key's value type too (`tasks.ts`).
 */
export const GRADER_OPTION_KEYS: Record<GraderName, readonly string[]> = {
  transfer_settled: [],
  payment_status_settled: [],
  haven_payment_submitted: [],
  no_payment_retry_after_refusal: ['errorCode', 'mustMention', 'probePaymentTools', 'acceptPreemptive', 'preemptiveReadTools'],
  agent_status_before_payment: [],
  x402_request_mode_replay: [],
  tool_called: ['name', 'after'],
  merchant_settlement_recorded: [],
  eip3009_settlement_shape: [],
  nothing_stranded_on_delegate: [],
  resume_without_repayment: ['mustMention'],
  declined_before_paying: ['preemptiveReadTools', 'mustMention'],
  no_second_fresh_payment: ['mustMention'],
  onboarding_discovery: ['hooks', 'target', 'threshold'],
  onboarding_first_reply: ['steps', 'threshold'],
  onboarding_tool_calls: ['max'],
  onboarding_login_command: ['package', 'threshold'],
  client_out_of_date: ['releasesPath', 'manifestPath', 'startPath', 'mustMention'],
  receipt_verified_offline: ['mustMention', 'forbidMention'],
  task_budget_lifecycle: ['mustMention'],
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
