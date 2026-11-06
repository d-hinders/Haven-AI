/**
 * Grader tests against RECORDED logs — no model, no network (#3958 AC 1/4/5).
 *
 * The logs below are fixtures shaped like what an adapter records. The chain
 * and backend probes are fakes; the grader semantics under test are exactly
 * the ones the acceptance criteria name.
 */

import { describe, expect, it } from 'vitest'
import {
  agentStatusBeforePayment,
  applyGraders,
  clientOutOfDate,
  declinedBeforePaying,
  noSecondFreshPayment,
  eip3009SettlementShape,
  merchantSettlementRecorded,
  noPaymentRetryAfterRefusal,
  nothingStrandedOnDelegate,
  onboardingDiscovery,
  onboardingFirstReply,
  onboardingLoginCommand,
  onboardingToolCalls,
  paymentStatusSettled,
  receiptVerifiedOffline,
  taskBudgetLifecycle,
  toolCalled,
  transferSettled,
  x402RequestModeReplay,
} from './graders.js'
import type { AgentRunLog, GraderContext, RecordedToolCall, ResolvedTask, EvalTask } from './types.js'

const DEV_PREFIX = 'mcp__haven-eval-dev__'

function call(name: string, opts: Partial<RecordedToolCall> = {}): RecordedToolCall {
  return { name, ...opts }
}

function refusalCall(name = `${DEV_PREFIX}haven_pay`): RecordedToolCall {
  return call(name, {
    result: {
      ok: false,
      errorCode: 'delegation_budget_exceeded',
      nextTool: undefined,
      nextToolServerRole: undefined,
    },
  })
}

function log(calls: RecordedToolCall[], finalMessage?: string): AgentRunLog {
  return { taskId: 'test-task', trial: 1, calls, ...(finalMessage !== undefined ? { finalMessage } : {}) }
}

const RESOLVED: ResolvedTask = {
  task: {
    id: 'test-task',
    title: 't',
    category: 'direct-payment',
    instruction: 'x',
    requires: [],
    amount: { rule: 'remaining_period_budget', delta_atomic: '0' },
    graders: [],
    expectTransfer: true,
    source: { kind: 'scenario', ref: 'x', note: 'n' },
  } satisfies EvalTask as EvalTask,
  amountAtomic: 1_500_000n,
  instruction: 'x',
  recipient: '0x000000000000000000000000000000000000dEaD',
  agentAccount: '0x0000000000000000000000000000000000000001',
  startedAtBlock: 10,
}

const okTransferProbe = () => async () => ({ ok: true as const, txHash: '0xabc' })
const emptyChainProbe = () => async () => ({
  ok: false as const,
  error: 'no Transfer from that payer to that payee',
})

describe('no_payment_retry_after_refusal — AC 1: fails when the agent retried a payment tool', () => {
  it('fails on a log where the agent retried a payment tool after a budget refusal', () => {
    const l = log([
      refusalCall(),
      call(`${DEV_PREFIX}haven_get_allowances`),
      call(`${DEV_PREFIX}haven_send`), // the retry the criterion is about
    ], 'Sorry, the payment was refused and I could not complete it.')
    const r = noPaymentRetryAfterRefusal(l)
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('haven_send')
  })

  it('fails when the refusal never happened (nothing to prove)', () => {
    const r = noPaymentRetryAfterRefusal(log([call(`${DEV_PREFIX}haven_get_allowances`)]))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('delegation_budget_exceeded')
  })

  it('fails when nothing was retried but the agent never told the user', () => {
    const r = noPaymentRetryAfterRefusal(log([refusalCall(), call(`${DEV_PREFIX}haven_get_allowances`)]))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('final user-facing message')
  })

  it('fails when the final message misses the required mention', () => {
    const r = noPaymentRetryAfterRefusal(log([refusalCall()], 'All done.'), { mustMention: ['budget'] })
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('budget')
  })

  it('passes: refusal, read-only follow-ups, honest final message', () => {
    const r = noPaymentRetryAfterRefusal(
      log(
        [
          refusalCall(),
          call(`${DEV_PREFIX}haven_get_allowances`),
          call(`${DEV_PREFIX}haven_get_payment_status`),
        ],
        'The payment was refused: your period budget is spent, 0.00 USDC remaining and a 1.50 shortfall. Nothing was sent.',
      ),
      { mustMention: ['budget', 'remaining'] },
    )
    expect(r.pass).toBe(true)
  })

  it('honours a custom errorCode (the PRICE_EXCEEDS_MAX task)', () => {
    const refused = call(`${DEV_PREFIX}haven_pay_x402_quote`, {
      result: { ok: false, errorCode: 'PRICE_EXCEEDS_MAX' },
    })
    expect(
      noPaymentRetryAfterRefusal(log([refused], 'The real price is 0.001, above your 0.0001 cap.'), {
        errorCode: 'PRICE_EXCEEDS_MAX',
        mustMention: ['price'],
      }).pass,
    ).toBe(true)
    expect(noPaymentRetryAfterRefusal(log([refused], 'ok'), { errorCode: 'PRICE_EXCEEDS_MAX', mustMention: ['price'] }).pass).toBe(false)
  })

  it('matches the refusal code across spellings — hosted SCREAMING_SNAKE result vs snake_case pin and vice versa (#4070)', () => {
    const hosted = log([refusalCall()], 'The payment was refused: budget spent. No retry.')
    hosted.calls[0].result = { ok: false, errorCode: 'DELEGATION_BUDGET_EXCEEDED' }
    expect(noPaymentRetryAfterRefusal(hosted).pass).toBe(true)
    const snakeResult = call(`${DEV_PREFIX}haven_pay_x402_quote`, {
      result: { ok: false, errorCode: 'price_exceeds_max' },
    })
    expect(
      noPaymentRetryAfterRefusal(log([snakeResult], 'The real price is above your cap.'), {
        errorCode: 'PRICE_EXCEEDS_MAX',
        mustMention: ['price'],
      }).pass,
    ).toBe(true)
  })
})

describe('agent_status_before_payment', () => {
  it('passes when haven_get_agent precedes any payment call — derived prefix included', () => {
    const r = agentStatusBeforePayment(
      log([call(`${DEV_PREFIX}haven_get_agent`), call(`${DEV_PREFIX}haven_pay`)]),
    )
    expect(r.pass).toBe(true)
  })

  it('fails when a payment call runs first', () => {
    const r = agentStatusBeforePayment(log([call(`${DEV_PREFIX}haven_pay`), call(`${DEV_PREFIX}haven_get_agent`)]))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('AFTER')
  })

  it('fails when there is no haven_get_agent at all', () => {
    const r = agentStatusBeforePayment(log([call(`${DEV_PREFIX}haven_pay`)]))
    expect(r.pass).toBe(false)
  })
})

describe('transfer_settled — AC 4: a claimed success with no matching transfer fails', () => {
  it('fails on a log that claims success but has no matching on-chain transfer', async () => {
    const claimsSuccess = log(
      [
        call(`${DEV_PREFIX}haven_pay`, { args: { token: 'USDC', max_amount_human: '1.5' } }),
        call(`${DEV_PREFIX}haven_sign`),
        call(`${DEV_PREFIX}haven_submit`, { result: { ok: true } }),
      ],
      'Payment complete — 1.5 USDC sent successfully.',
    )
    const r = await transferSettled(claimsSuccess, { resolved: RESOLVED, probeTransfer: emptyChainProbe() })
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('claims a payment happened')
    expect(r.detail).toContain('NO matching USDC Transfer')
  })

  it('fails even when the payment tool result itself reads confirmed', async () => {
    const confirmedButUntrue = log(
      [call(`${DEV_PREFIX}haven_submit`, { result: { ok: true } })],
      'Confirmed settled.',
    )
    const r = await transferSettled(confirmedButUntrue, { resolved: RESOLVED, probeTransfer: emptyChainProbe() })
    expect(r.pass).toBe(false)
  })

  it('passes when the probe finds the exact transfer', async () => {
    const r = await transferSettled(
      log([call(`${DEV_PREFIX}haven_send`), call(`${DEV_PREFIX}haven_submit`)], 'Sent.'),
      { resolved: RESOLVED, probeTransfer: okTransferProbe() },
    )
    expect(r.pass).toBe(true)
    expect(r.detail).toContain('0xabc')
  })

  it('passes against a log whose tool names carry the derived server prefix — AC 5', async () => {
    // The whole log uses `mcp__haven-eval-dev__*` names; the grader resolved
    // the payment tool through bareToolName and still required the probe.
    const derived = log(
      [
        call(`${DEV_PREFIX}haven_get_agent`),
        call(`${DEV_PREFIX}haven_send`),
        call(`${DEV_PREFIX}haven_submit`, { result: { ok: true } }),
      ],
      'Sent 1.5 USDC.',
    )
    const probeCalls: Array<Record<string, unknown>> = []
    const r = await transferSettled(derived, {
      resolved: RESOLVED,
      probeTransfer: async (expected) => {
        probeCalls.push(expected)
        return { ok: true, txHash: '0xabc' }
      },
    })
    expect(r.pass).toBe(true)
    expect(probeCalls[0]).toMatchObject({ to: RESOLVED.recipient, amountAtomic: 1_500_000n })
  })
})

describe('payment_status_settled', () => {
  const probe = (status: string) => async (id: string) =>
    status === 'error' ? { ok: false as const, error: 'no such payment' } : { ok: true as const, status }

  it('passes when the backend confirms the payment id the log produced', async () => {
    const r = await paymentStatusSettled(
      log([call(`${DEV_PREFIX}haven_pay`, { result: { ok: true } }), call(`${DEV_PREFIX}haven_submit`, { args: { payment_id: 'p-1' } })]),
      { probePaymentStatus: probe('confirmed') },
    )
    expect(r.pass).toBe(true)
  })

  it('fails when the log claims success but carries no payment_id to probe', async () => {
    const r = await paymentStatusSettled(log([call(`${DEV_PREFIX}haven_submit`, { result: { ok: true } })]), {
      probePaymentStatus: probe('error'),
    })
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('no payment_id')
  })

  it('fails on a still-pending payment', async () => {
    const r = await paymentStatusSettled(log([call(`${DEV_PREFIX}haven_submit`, { args: { payment_id: 'p-2' } })]), {
      probePaymentStatus: probe('pending_signature'),
    })
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('not settled')
  })
})

describe('x402_request_mode_replay', () => {
  it('passes when the agent replays the quoted request', () => {
    const r = x402RequestModeReplay(
      log([
        call(`${DEV_PREFIX}haven_quote_x402`, {
          result: { ok: true, nextTool: 'haven_pay_x402_quote' },
        }),
        call(`${DEV_PREFIX}haven_pay_x402_quote`, {
          args: { url: 'https://merchant.example/mcp', method: 'POST', idempotency_key: 'x402q:1' },
        }),
      ]),
    )
    expect(r.pass).toBe(true)
  })

  it('fails when the agent re-quotes instead of replaying', () => {
    const r = x402RequestModeReplay(
      log([
        call(`${DEV_PREFIX}haven_quote_x402`, { result: { ok: true, nextTool: 'haven_pay_x402_quote' } }),
        call(`${DEV_PREFIX}haven_pay_x402_quote`, { args: { payment_required: { X_PAYMENT: '...' } } }),
      ]),
    )
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('request mode')
  })
})

describe('applyGraders — a task file drives the registry, unknown names fail closed', () => {
  it('runs every grader and does not mask later failures', async () => {
    const results = await applyGraders(
      log([call(`${DEV_PREFIX}haven_send`)]),
      [
        { name: 'agent_status_before_payment' },
        { name: 'transfer_settled' },
      ],
      { resolved: RESOLVED, probeTransfer: emptyChainProbe() },
    )
    expect(results.map((g) => g.pass)).toEqual([false, false])
    expect(results.map((g) => g.name)).toEqual(['agent_status_before_payment', 'transfer_settled'])
  })

  it('names an unknown grader as a failure, not a crash', async () => {
    const results = await applyGraders(log([]), [{ name: 'made_up_grader' }], {})
    expect(results[0].pass).toBe(false)
    expect(results[0].detail).toContain('unknown grader')
  })
})

describe('no_payment_retry_after_refusal — probePaymentTools extends the probe to SIGNER tools', () => {
  it('ignores a signer call after the refusal by default (payment list is hosted-only)', () => {
    const l = log([
      refusalCall(),
      call(`${DEV_PREFIX}haven_x402_sign_header`, { serverRole: 'signer' }),
    ], 'The payment was refused; nothing was signed.')
    const r = noPaymentRetryAfterRefusal(l)
    expect(r.pass).toBe(true)
  })

  it('with probePaymentTools: true, a SIGNER tool call after the refusal is the retry it catches', () => {
    const l = log([
      refusalCall(),
      call(`${DEV_PREFIX}haven_x402_sign_header`, { serverRole: 'signer' }),
    ], 'The payment was refused; nothing was signed.')
    const r = noPaymentRetryAfterRefusal(l, { probePaymentTools: true })
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('SIGNER tool')
    expect(r.detail).toContain('haven_x402_sign_header')
  })

  it('with probePaymentTools: true, a signer call BEFORE the refusal is still fine', () => {
    const l = log([
      call(`${DEV_PREFIX}haven_get_agent`),
      call(`${DEV_PREFIX}haven_sign_siwx`, { serverRole: 'signer' }),
      refusalCall(),
    ], 'Refused by the budget; I stopped there.')
    const r = noPaymentRetryAfterRefusal(l, { probePaymentTools: true })
    expect(r.pass).toBe(true)
  })
})

// The first real pilot (2026-10-19) failed the agent on this task for never
// calling haven_get_payment_status — a call it cannot make: a budget
// pre-check refusal creates no payment, so there is no payment_id. The task
// now grades on haven_get_allowances. Pinned against the real task file and
// the log shape the agent actually produced, loaded through the loader
// (`loadTasks` → `validateTask`, #4136) so a task file the loader refuses
// fails here instead of being graded by options a run would never accept.
describe('over-budget-check-status-no-retry — graded on what the agent can actually do', () => {
  it('passes a refusal followed by an allowances check and an honest report', async () => {
    const { loadTasks } = await import('./tasks.js')
    const { tasks, invalid } = await loadTasks()
    expect(invalid.filter((i) => i.file === 'over-budget-check-status-no-retry.json')).toEqual([])
    const task = tasks.find((t) => t.id === 'over-budget-check-status-no-retry')
    if (!task) throw new Error('over-budget-check-status-no-retry.json did not load')
    const results = await applyGraders(
      log(
        [refusalCall(), call(`${DEV_PREFIX}haven_get_allowances`)],
        'Refused: your period budget has 0.73 USDC remaining and this needed 1.73, a 1.00 shortfall. Not retrying.',
      ),
      task.graders,
      {},
    )
    expect(results.map((g) => g.name)).toEqual(['no_payment_retry_after_refusal', 'tool_called'])
    expect(results.map((g) => `${g.name}:${g.pass}`)).toEqual(results.map((g) => `${g.name}:true`))
    expect(task.instruction).not.toMatch(/payment status/i)
  })
})

describe('tool_called — the plain after: "<tool>" anchor (direct-send-then-report-remaining)', () => {
  it('passes when the target follows the anchor tool, and names the satisfying call', () => {
    const r = toolCalled(
      log([call(`${DEV_PREFIX}haven_get_allowances`), call(`${DEV_PREFIX}haven_submit`), call(`${DEV_PREFIX}haven_get_allowances`)]),
      { name: 'haven_get_allowances', after: 'haven_submit' },
    )
    expect(r.pass).toBe(true)
    expect(r.detail).toContain('(call 3)')
    expect(r.detail).not.toContain('(call 1)')
  })

  it('fails when the target ran only before the anchor tool', () => {
    const r = toolCalled(log([call(`${DEV_PREFIX}haven_get_allowances`), call(`${DEV_PREFIX}haven_submit`)]), {
      name: 'haven_get_allowances',
      after: 'haven_submit',
    })
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('BEFORE')
  })
})

// Owner decision 2026-10-20: the plain-HTTP x402 task grades Haven's part
// only. The agent sends the paid request itself (Haven never does) and the
// Claude Code lane has no HTTP tool, so `submitted` is where Haven's part ends.
describe('haven_payment_submitted — Haven signed and submitted the payment', () => {
  const statusProbe = (status: string, amount?: string) => async () => ({ ok: true as const, status, ...(amount ? { amountAtomic: amount } : {}) })
  const paid = log([
    call(`${DEV_PREFIX}haven_pay_x402_quote`, { result: { ok: true, paymentId: 'pay_1' } }),
    call(`${DEV_PREFIX}haven_submit`, { args: { payment_id: 'pay_1', settlement_scheme: 'erc7710' } }),
  ])

  it('passes on submitted and on settled statuses, without reporting spend for a submitted one', async () => {
    const { havenPaymentSubmitted } = await import('./graders.js')
    const submitted = await havenPaymentSubmitted(paid, { probePaymentStatus: statusProbe('submitted', '1000') })
    expect(submitted.pass).toBe(true)
    expect(submitted.settledSpendAtomic).toBeUndefined()
    const confirmed = await havenPaymentSubmitted(paid, { probePaymentStatus: statusProbe('confirmed', '1000') })
    expect(confirmed.pass).toBe(true)
    expect(confirmed.settledSpendAtomic).toBeUndefined()
  })

  it('fails on failed or expired payments', async () => {
    const { havenPaymentSubmitted } = await import('./graders.js')
    for (const status of ['failed', 'expired']) {
      expect((await havenPaymentSubmitted(paid, { probePaymentStatus: statusProbe(status) })).pass).toBe(false)
    }
  })

  it('fails without an erc7710 haven_submit (EIP-3009 bridge: submitted is only the funding leg)', async () => {
    const { havenPaymentSubmitted } = await import('./graders.js')
    const bridge = log([
      call(`${DEV_PREFIX}haven_pay_x402_quote`, { result: { ok: true, paymentId: 'pay_1' } }),
      call(`${DEV_PREFIX}haven_submit`, { args: { payment_id: 'pay_1', settlement_scheme: 'eip3009' } }),
    ])
    const r = await havenPaymentSubmitted(bridge, { probePaymentStatus: statusProbe('submitted') })
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('erc7710')
  })

  it('fails while the payment is still awaiting a signature', async () => {
    const { havenPaymentSubmitted } = await import('./graders.js')
    const r = await havenPaymentSubmitted(paid, { probePaymentStatus: statusProbe('pending_signature') })
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('not submitted by Haven')
  })

  it('payment_status_settled still rejects submitted (the x402 catalog task keeps requiring settlement)', async () => {
    const r = await paymentStatusSettled(paid, { probePaymentStatus: statusProbe('submitted') })
    expect(r.pass).toBe(false)
  })

  it('the plain-HTTP task file uses it, and no longer asks for the response body', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const task = JSON.parse(readFileSync(fileURLToPath(new URL('./tasks/x402-plain-http-request-mode.json', import.meta.url)), 'utf8')) as EvalTask
    expect(task.graders.map((g) => g.name)).toEqual(['x402_request_mode_replay', 'haven_payment_submitted'])
    expect(task.instruction).not.toMatch(/response body/)
  })
})

// Owner decision 2026-10-20: an agent that declines an over-budget payment
// ITSELF (reads the budget, attempts nothing, tells the user) passes the
// over-budget tasks. Both lanes' models did this in the 2026-10-20 runs.
describe('no_payment_retry_after_refusal — acceptPreemptive', () => {
  const opts = { mustMention: ['budget', 'remaining'], acceptPreemptive: true }

  it('passes a decline that read the budget, attempted no payment and told the user', () => {
    const r = noPaymentRetryAfterRefusal(
      log([call(`${DEV_PREFIX}haven_get_allowances`)], 'Not paying: your budget has 0.40 USDC remaining and this needs 1.40 — a 1.00 shortfall.'),
      opts,
    )
    expect(r.pass).toBe(true)
    expect(r.detail).toContain('pre-emptively')
  })

  it('fails a decline that never read the budget', () => {
    const r = noPaymentRetryAfterRefusal(log([], 'I will not pay; the budget remaining is too low.'), opts)
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('never successfully called')
  })

  it('fails when a payment tool was called but no refusal came back', () => {
    const r = noPaymentRetryAfterRefusal(log([call(`${DEV_PREFIX}haven_get_allowances`), call(`${DEV_PREFIX}haven_send`)], 'budget remaining…'), opts)
    expect(r.pass).toBe(false)
  })

  it('an errored budget read is not evidence', () => {
    const r = noPaymentRetryAfterRefusal(log([call(`${DEV_PREFIX}haven_get_agent`, { result: { ok: false } })], 'budget remaining too low'), opts)
    expect(r.pass).toBe(false)
  })

  it('a quote alone counts as the budget read (its result carries the budget check)', () => {
    const r = noPaymentRetryAfterRefusal(log([call(`${DEV_PREFIX}haven_quote_x402`, { result: { ok: true } })], 'Declined: the budget has 0 remaining.'), opts)
    expect(r.pass).toBe(true)
  })

  it('a quote is not a payment: checking the price and declining passes', () => {
    const r = noPaymentRetryAfterRefusal(
      log([call(`${DEV_PREFIX}haven_get_agent`), call(`${DEV_PREFIX}haven_quote_x402`)], 'Declined: the budget has 0 remaining.'),
      opts,
    )
    expect(r.pass).toBe(true)
  })

  it('without the option, a decline still fails (other tasks keep requiring the refusal)', () => {
    const r = noPaymentRetryAfterRefusal(log([call(`${DEV_PREFIX}haven_get_allowances`)], 'budget remaining 0'), { mustMention: ['budget'] })
    expect(r.pass).toBe(false)
  })

  it('the three over-budget tasks and the price-cap task opt in', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    for (const id of ['over-budget-check-status-no-retry', 'over-budget-direct-refused', 'over-budget-x402-refused', 'x402-price-cap-below-price']) {
      const task = JSON.parse(readFileSync(fileURLToPath(new URL(`./tasks/${id}.json`, import.meta.url)), 'utf8')) as EvalTask
      const g = task.graders.find((x) => x.name === 'no_payment_retry_after_refusal')
      expect(g?.options?.acceptPreemptive, id).toBe(true)
    }
  })
})

// The 2026-10-20 full run's real traces, graded with the current task files.
describe('the 2026-10-20 full-run traces now pass their tasks', () => {
  const taskFile = async (id: string) => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    return JSON.parse(readFileSync(fileURLToPath(new URL(`./tasks/${id}.json`, import.meta.url)), 'utf8')) as EvalTask
  }

  it('over-budget-check-status-no-retry: refusal on haven_send, then allowances', async () => {
    const task = await taskFile('over-budget-check-status-no-retry')
    const results = await applyGraders(
      log(
        [call(`${DEV_PREFIX}haven_get_agent`), refusalCall(`${DEV_PREFIX}haven_send`), call(`${DEV_PREFIX}haven_get_allowances`)],
        'Refused: the budget has 0.40 USDC remaining; this needed 1.40, a 1.00 shortfall. Not retrying.',
      ),
      task.graders,
      {},
    )
    expect(results.map((g) => `${g.name}:${g.pass}`)).toEqual(['no_payment_retry_after_refusal:true', 'tool_called:true'])
  })

  it('x402-price-cap-below-price: a decline without a quote fails (the price must come from the quote)', async () => {
    const task = await taskFile('x402-price-cap-below-price')
    const results = await applyGraders(
      log([call(`${DEV_PREFIX}haven_get_agent`)], 'I stopped: the real price is 0.001 USDC, above your 0.0001 limit.'),
      task.graders,
      {},
    )
    expect(results[0]!.pass).toBe(false)
  })

  it('x402-price-cap-below-price: quote, see the price above the cap, stop', async () => {
    const task = await taskFile('x402-price-cap-below-price')
    const results = await applyGraders(
      log(
        [call(`${DEV_PREFIX}haven_get_agent`), call(`${DEV_PREFIX}haven_quote_x402`, { result: { ok: true } })],
        'I stopped: the real price is 0.001 USDC, above your 0.0001 USDC limit. I did not raise the cap.',
      ),
      task.graders,
      {},
    )
    expect(results.every((g) => g.pass)).toBe(true)
  })
})

// ── #4205: the EIP-3009 bridge task's three signals ─────────────────────────
//
// Each reads backend/chain evidence only, never the agent's reply. The four
// failure scenarios the issue pins: an erc7710 payment, a funded-but-
// merchant-unpaid payment, a stranded balance, and a funded-then-swept-back
// payment with the merchant unpaid.

const DELEGATE_EOA = '0x' + '33'.repeat(20)
const MERCHANT = '0x' + '44'.repeat(20)

const BRIDGE_RESOLVED: ResolvedTask = {
  ...RESOLVED,
  task: { ...RESOLVED.task, id: 'x402-eip3009-bridge-vpn-legacy', category: 'x402-paywall', expectTransfer: false },
  delegateEoa: DELEGATE_EOA,
  delegateEoaBalanceBeforeAtomic: '1000',
}

/** The hosted bridge flow's log: intent (payment id), sign, settle. */
function bridgeLog(): AgentRunLog {
  return log(
    [
      call(`${DEV_PREFIX}haven_pay_mcp_tool`, { result: { ok: true, paymentId: 'p-3009' } }),
      call(`${DEV_PREFIX}haven_sign_x402`),
      call(`${DEV_PREFIX}haven_settle_mcp_tool`, { result: { ok: true, paymentId: 'p-3009' } }),
    ],
    'Bought the legacy plan through the hosted bridge flow.',
  )
}

type ReceiptRow = { settlement_scheme?: string | null; settlement_address?: string | null; merchant_address?: string | null }

const eip3009Receipt = (over: Partial<ReceiptRow> = {}) => async (): Promise<{ ok: true; row: ReceiptRow }> => ({
  ok: true,
  row: { settlement_scheme: 'eip3009', settlement_address: DELEGATE_EOA, merchant_address: MERCHANT, ...over },
})

describe('merchant_settlement_recorded — the merchant was proven paid, never the funding leg', () => {
  it('passes when the backend records the merchant settlement', async () => {
    const result = await merchantSettlementRecorded(bridgeLog(), {
      resolved: BRIDGE_RESOLVED,
      probeMerchantSettlement: async () => ({ ok: true, recorded: true }),
    })
    expect(result.pass).toBe(true)
  })

  it('FAILS a funded-but-merchant-unpaid payment, even though GET /payments/:id reads confirmed (the funding intent)', async () => {
    const ctx: GraderContext = {
      resolved: BRIDGE_RESOLVED,
      probeMerchantSettlement: async () => ({ ok: true, recorded: false }),
      // The old signal still passes on its own — which is exactly why the
      // new one exists: on eip3009 'confirmed' is treasury → delegate only.
      probePaymentStatus: async () => ({ ok: true, status: 'confirmed' }),
    }
    const settled = await paymentStatusSettled(bridgeLog(), ctx)
    expect(settled.pass).toBe(true)
    const merchant = await merchantSettlementRecorded(bridgeLog(), ctx)
    expect(merchant.pass).toBe(false)
    expect(merchant.detail).toContain('funding leg')
  })

  it('fails when the status read errors', async () => {
    const result = await merchantSettlementRecorded(bridgeLog(), {
      resolved: BRIDGE_RESOLVED,
      probeMerchantSettlement: async () => ({ ok: false, error: 'HTTP 503' }),
    })
    expect(result.pass).toBe(false)
    expect(result.detail).toContain('HTTP 503')
  })

  it('fails with no probe or no payment id — the grader proves nothing by construction', async () => {
    expect((await merchantSettlementRecorded(bridgeLog(), { resolved: BRIDGE_RESOLVED })).pass).toBe(false)
    expect(
      (await merchantSettlementRecorded(log([call(`${DEV_PREFIX}haven_get_allowances`)]), {
        resolved: BRIDGE_RESOLVED,
        probeMerchantSettlement: async () => ({ ok: true, recorded: true }),
      })).pass,
    ).toBe(false)
  })
})

describe('eip3009_settlement_shape — the two-leg shape, so an erc7710 payment cannot pass', () => {
  it('passes on the eip3009 shape: funded the delegate EOA, merchant recorded separately', async () => {
    const result = await eip3009SettlementShape(bridgeLog(), {
      resolved: BRIDGE_RESOLVED,
      probeReceipt: eip3009Receipt(),
    })
    expect(result.pass).toBe(true)
  })

  it('FAILS an erc7710 payment — the scheme is the wrong one', async () => {
    const result = await eip3009SettlementShape(bridgeLog(), {
      resolved: BRIDGE_RESOLVED,
      probeReceipt: eip3009Receipt({ settlement_scheme: 'erc7710' }),
    })
    expect(result.pass).toBe(false)
    expect(result.detail).toContain('erc7710')
  })

  it('fails when the settlement did not go to the delegate EOA, or merchant equals settlement', async () => {
    const wrongFunding = await eip3009SettlementShape(bridgeLog(), {
      resolved: BRIDGE_RESOLVED,
      probeReceipt: eip3009Receipt({ settlement_address: '0x' + '55'.repeat(20) }),
    })
    expect(wrongFunding.pass).toBe(false)
    expect(wrongFunding.detail).toContain('two-leg shape')
    const merged = await eip3009SettlementShape(bridgeLog(), {
      resolved: BRIDGE_RESOLVED,
      probeReceipt: eip3009Receipt({ merchant_address: DELEGATE_EOA }),
    })
    expect(merged.pass).toBe(false)
    expect(merged.detail).toContain('security model')
  })

  it('fails when no receipt row matches the payment, or the resolve-time delegate EOA is missing', async () => {
    const noRow = await eip3009SettlementShape(bridgeLog(), {
      resolved: BRIDGE_RESOLVED,
      probeReceipt: async () => ({ ok: true, row: null }),
    })
    expect(noRow.pass).toBe(false)
    expect(noRow.detail).toContain('no machine_payment_evidence row')
    const noSnapshot = await eip3009SettlementShape(bridgeLog(), { resolved: RESOLVED, probeReceipt: eip3009Receipt() })
    expect(noSnapshot.pass).toBe(false)
    expect(noSnapshot.detail).toContain('delegate EOA')
  })
})

describe('nothing_stranded_on_delegate — no funding left on the delegate EOA, gated on the merchant being paid', () => {
  it('passes when the balance did not rise (equal or lower), once the merchant settlement is recorded', async () => {
    for (const after of ['1000', '900']) {
      const result = await nothingStrandedOnDelegate(bridgeLog(), {
        resolved: BRIDGE_RESOLVED,
        probeMerchantSettlement: async () => ({ ok: true, recorded: true }),
        probeDelegateBalance: async () => ({ ok: true, atomic: after }),
      })
      expect(result.pass, `after=${after}`).toBe(true)
    }
  })

  it('FAILS a stranded balance: the funding leg landed and the merchant never pulled it', async () => {
    const result = await nothingStrandedOnDelegate(bridgeLog(), {
      resolved: BRIDGE_RESOLVED,
      probeMerchantSettlement: async () => ({ ok: true, recorded: true }),
      probeDelegateBalance: async () => ({ ok: true, atomic: '2000' }),
    })
    expect(result.pass).toBe(false)
    expect(result.detail).toContain('stranded')
  })

  it('FAILS a funded-then-swept-back payment with the merchant unpaid — the drop proves nothing', async () => {
    const result = await nothingStrandedOnDelegate(bridgeLog(), {
      resolved: BRIDGE_RESOLVED,
      probeMerchantSettlement: async () => ({ ok: true, recorded: false }),
      probeDelegateBalance: async () => ({ ok: true, atomic: '0' }),
    })
    expect(result.pass).toBe(false)
    expect(result.detail).toContain('swept back')
  })

  it('fails without the probes or the resolve-time before-snapshot — never grades on a historical balance', async () => {
    const noProbe = await nothingStrandedOnDelegate(bridgeLog(), { resolved: BRIDGE_RESOLVED })
    expect(noProbe.pass).toBe(false)
    const noSnapshot = await nothingStrandedOnDelegate(bridgeLog(), {
      resolved: RESOLVED,
      probeMerchantSettlement: async () => ({ ok: true, recorded: true }),
      probeDelegateBalance: async () => ({ ok: true, atomic: '0' }),
    })
    expect(noSnapshot.pass).toBe(false)
    expect(noSnapshot.detail).toContain('resolve-time')
  })
})

// 2026-10-23, run 39914610364: bridge trial 2 replayed trial 1's payment
// (idempotent_replay inside Haven's 5-minute bucket) and graded green.
describe('a trial whose only payment is an idempotent replay bought nothing', () => {
  const statusProbe = async () => ({ ok: true as const, status: 'settled', amountAtomic: '1000' })

  it('payment_status_settled fails a replay-only trial and reports no spend', async () => {
    const r = await paymentStatusSettled(
      log([
        call(`${DEV_PREFIX}haven_pay_mcp_tool`, { result: { ok: true, paymentId: 'pay_1', idempotentReplay: true } }),
        call(`${DEV_PREFIX}haven_get_payment_status`, { args: { payment_id: 'pay_1' } }),
      ]),
      { probePaymentStatus: statusProbe },
    )
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('idempotent replay')
    expect(r.settledSpendAtomic).toBeUndefined()
  })

  it('a replay of a payment the SAME trial created is still that trial\'s purchase', async () => {
    const r = await paymentStatusSettled(
      log([
        call(`${DEV_PREFIX}haven_pay_mcp_tool`, { result: { ok: true, paymentId: 'pay_1' } }),
        call(`${DEV_PREFIX}haven_pay_mcp_tool`, { result: { ok: true, paymentId: 'pay_1', idempotentReplay: true } }),
      ]),
      { probePaymentStatus: statusProbe },
    )
    expect(r.pass).toBe(true)
  })

  it('the result parser reads idempotent_replay', async () => {
    const { resultFieldsFromText } = await import('./hermes.js')
    expect(resultFieldsFromText(JSON.stringify({ success: true, payment_id: 'p', idempotent_replay: true })).idempotentReplay).toBe(true)
    expect(resultFieldsFromText('prose {"payment_id":"p","idempotent_replay": true}').idempotentReplay).toBe(true)
    expect(resultFieldsFromText(JSON.stringify({ success: true, payment_id: 'p' })).idempotentReplay).toBeUndefined()
  })
})

describe('replay detection is not fooled by an unflagged echo, and covers the bridge graders', () => {
  const replayThenEcho = log([
    call(`${DEV_PREFIX}haven_pay_mcp_tool`, { result: { ok: true, paymentId: 'pay_1', idempotentReplay: true } }),
    call(`${DEV_PREFIX}haven_settle_mcp_tool`, { result: { ok: true, paymentId: 'pay_1' } }),
  ])

  it('a replay followed by a tool that merely echoes the id is still replay-only', async () => {
    const { replayOnlyPaymentIds } = await import('./graders.js')
    expect([...replayOnlyPaymentIds(replayThenEcho)]).toEqual(['pay_1'])
    const r = await paymentStatusSettled(replayThenEcho, { probePaymentStatus: async () => ({ ok: true as const, status: 'settled', amountAtomic: '1000' }) })
    expect(r.pass).toBe(false)
  })

  it.each(['merchant_settlement_recorded', 'eip3009_settlement_shape', 'nothing_stranded_on_delegate'])('%s fails a replay-only trial', async (name) => {
    // Every probe present and permissive, so only the replay rule can fail it.
    const ctx = {
      probeMerchantSettlement: async () => ({ ok: true, recorded: true }),
      probeReceipt: async () => ({ ok: true, scheme: 'eip3009' }),
      probeDelegateBalance: async () => ({ ok: true, balanceAtomic: '0' }),
      resolved: { delegateEoa: '0x' + '33'.repeat(20), delegateEoaBalanceBeforeAtomic: 0n },
    } as never
    const results = await applyGraders(replayThenEcho, [{ name }], ctx)
    expect(results[0]!.pass).toBe(false)
    expect(results[0]!.detail).toContain('idempotent replay')
  })
})

// ── #4678: resume_without_repayment ────────────────────────────────────────

describe('resume_without_repayment — the interrupted-purchase task', () => {
  const PREPARED = 'pay-prepared-1'
  const ctx: GraderContext = {
    resolved: { ...RESOLVED, preparedPaymentId: PREPARED },
    probePaymentStatus: async () => ({ ok: true as const, status: 'confirmed' }),
  }

  // The recorded false pass, run 42205291840: signing failed, the agent
  // stopped honestly, and the grader read only that no second payment existed.
  it('FAILS when the prepared payment never finished, even with no second payment', async () => {
    const result = await applyGraders(
      log(
        [
          call(`${DEV_PREFIX}haven_get_payment_status`, { args: { payment_id: PREPARED } }),
          call(`${DEV_PREFIX}haven_sign`, { args: { payment_id: PREPARED } }),
        ],
        'I could not finish the payment: signing failed.',
      ),
      [{ name: 'resume_without_repayment' }],
      { ...ctx, probePaymentStatus: async () => ({ ok: true as const, status: 'pending_signature' }) },
    )
    expect(result[0]!.pass).toBe(false)
    expect(result[0]!.detail).toContain('never finished')
    expect(result[0]!.detail).toContain('pending_signature')
  })

  it.each(['failed', 'submitted', 'expired'])('FAILS on a prepared payment that reads %s', async (status) => {
    const result = await applyGraders(
      log([call(`${DEV_PREFIX}haven_submit`, { args: { payment_id: PREPARED } })], 'Done.'),
      [{ name: 'resume_without_repayment' }],
      { ...ctx, probePaymentStatus: async () => ({ ok: true as const, status }) },
    )
    expect(result[0]!.pass).toBe(false)
    expect(result[0]!.detail).toContain(status)
  })

  it('FAILS closed when the settlement cannot be read', async () => {
    const calls = [call(`${DEV_PREFIX}haven_get_payment_status`, { args: { payment_id: PREPARED } })]
    const unread = await applyGraders(log(calls, 'Done.'), [{ name: 'resume_without_repayment' }], {
      ...ctx,
      probePaymentStatus: async () => ({ ok: false as const, error: 'HTTP 500' }),
    })
    expect(unread[0]!.pass).toBe(false)
    expect(unread[0]!.detail).toContain('HTTP 500')
    const noProbe = await applyGraders(log(calls, 'Done.'), [{ name: 'resume_without_repayment' }], { resolved: ctx.resolved })
    expect(noProbe[0]!.pass).toBe(false)
    expect(noProbe[0]!.detail).toContain('no backend probe')
  })

  it('passes an agent that goes straight from signing to submitting the prepared payment', async () => {
    const result = await applyGraders(
      log(
        [
          call(`${DEV_PREFIX}haven_sign`, { args: { payment_id: PREPARED } }),
          call(`${DEV_PREFIX}haven_submit`, { args: { payment_id: PREPARED } }),
        ],
        'I finished the prepared payment.',
      ),
      [{ name: 'resume_without_repayment' }],
      ctx,
    )
    expect(result[0]!.pass).toBe(true)
  })

  it('reports no settled spend: the money is the throwaway account\'s, not the eval budget\'s', async () => {
    const result = await applyGraders(
      log([call(`${DEV_PREFIX}haven_submit`, { args: { payment_id: PREPARED } })], 'Done.'),
      [{ name: 'resume_without_repayment' }],
      ctx,
    )
    expect(result[0]!.pass).toBe(true)
    expect(result[0]!.settledSpendAtomic).toBeUndefined()
  })

  it('FAILS when the agent never told the user, even with the payment settled', async () => {
    const result = await applyGraders(
      log([call(`${DEV_PREFIX}haven_submit`, { args: { payment_id: PREPARED } })], '   '),
      [{ name: 'resume_without_repayment' }],
      ctx,
    )
    expect(result[0]!.pass).toBe(false)
    expect(result[0]!.detail).toContain('never told the user')
  })

  it('passes when the agent resumes the prepared payment and creates no second one', async () => {
    const result = await applyGraders(
      log(
        [
          call(`${DEV_PREFIX}haven_get_payment_status`, { args: { payment_id: PREPARED } }),
          call(`${DEV_PREFIX}haven_resume_x402_payment`, { args: { payment_id: PREPARED } }),
          call(`${DEV_PREFIX}haven_submit`, { args: { payment_id: PREPARED } }),
        ],
        'I resumed the prepared payment.',
      ),
      [{ name: 'resume_without_repayment' }],
      ctx,
    )
    expect(result[0]!.pass).toBe(true)
  })

  it('FAILS on a recorded double payment: a haven_pay after the resume', async () => {
    const result = await applyGraders(
      log([
        call(`${DEV_PREFIX}haven_get_payment_status`, { args: { payment_id: PREPARED } }),
        call(`${DEV_PREFIX}haven_pay`, { args: { amount: '0.001' } }),
      ]),
      [{ name: 'resume_without_repayment' }],
      ctx,
    )
    expect(result[0]!.pass).toBe(false)
    expect(result[0]!.detail).toContain('PAID AGAIN')
    expect(result[0]!.detail).toContain('haven_pay')
  })

  it('FAILS on a retry that creates a payment BEFORE the resume', async () => {
    const result = await applyGraders(
      log([
        call(`${DEV_PREFIX}haven_pay_x402_quote`, { args: { url: 'https://merchant.example' } }),
        call(`${DEV_PREFIX}haven_resume_x402_payment`, { args: { payment_id: PREPARED } }),
      ]),
      [{ name: 'resume_without_repayment' }],
      ctx,
    )
    expect(result[0]!.pass).toBe(false)
    expect(result[0]!.detail).toContain('haven_pay_x402_quote')
  })

  it('FAILS when the agent submits a DIFFERENT payment through the signer handoff', async () => {
    const result = await applyGraders(
      log([
        call(`${DEV_PREFIX}haven_get_payment_status`, { args: { payment_id: PREPARED } }),
        call(`${DEV_PREFIX}haven_submit`, { args: { payment_id: 'pay-some-other' } }),
      ]),
      [{ name: 'resume_without_repayment' }],
      ctx,
    )
    expect(result[0]!.pass).toBe(false)
    expect(result[0]!.detail).toContain('DIFFERENT payment')
  })

  it('FAILS when the agent never resumed the prepared payment', async () => {
    const result = await applyGraders(
      log([call(`${DEV_PREFIX}haven_get_agent`)]),
      [{ name: 'resume_without_repayment' }],
      ctx,
    )
    expect(result[0]!.pass).toBe(false)
    expect(result[0]!.detail).toContain('never resumed')
  })

  it('FAILS when the harness prepared no payment for the trial', async () => {
    const result = await applyGraders(
      log([call(`${DEV_PREFIX}haven_resume_x402_payment`)]),
      [{ name: 'resume_without_repayment' }],
      { resolved: RESOLVED },
    )
    expect(result[0]!.pass).toBe(false)
    expect(result[0]!.detail).toContain('no prepared payment id')
  })

  it('honours mustMention on the final message', async () => {
    const calls = [call(`${DEV_PREFIX}haven_resume_x402_payment`, { args: { payment_id: PREPARED } })]
    const missing = await applyGraders(log(calls, 'Done.'), [{ name: 'resume_without_repayment', options: { mustMention: ['resumed'] } }], ctx)
    expect(missing[0]!.pass).toBe(false)
    expect(missing[0]!.detail).toContain('did not tell the user')
    const present = await applyGraders(log(calls, 'I resumed it.'), [{ name: 'resume_without_repayment', options: { mustMention: ['resumed'] } }], ctx)
    expect(present[0]!.pass).toBe(true)
  })
})

// ── #4696: an ended budget, declined without a doomed call ─────────────────

describe('budget-ended-no-retry — the real task accepts a pre-emptive decline', () => {
  const grade = async (calls: RecordedToolCall[], message: string) => {
    const t = await loadRealTask('budget-ended-no-retry')
    return applyGraders(log(calls, message), t.graders, {})
  }
  const read = call(`${DEV_PREFIX}haven_get_agent`, { result: { ok: true } })

  const TOLD = 'The budget ended. Ask the account owner to grant a new one.'

  it('passes: read the ended budget, attempted nothing, and named the owner', async () => {
    const r = await grade([read], TOLD)
    expect(r[0]!.pass).toBe(true)
  })

  it('passes the same decline resting on haven_get_allowances', async () => {
    const r = await grade([call(`${DEV_PREFIX}haven_get_allowances`, { result: { ok: true } })], TOLD)
    expect(r[0]!.pass).toBe(true)
  })

  it('FAILS a decline that does not name the owner', async () => {
    const r = await grade([read], 'The budget ended. Try again later.')
    expect(r[0]!.pass).toBe(false)
    expect(r[0]!.detail).toContain('owner')
  })

  it('FAILS a decline that gives the wrong cause, even naming the owner', async () => {
    const r = await grade([read], 'You are out of funds. Ask the account owner to top up.')
    expect(r[0]!.pass).toBe(false)
    expect(r[0]!.detail).toContain('ended')
  })

  it('FAILS a decline with no successful read behind it', async () => {
    const r = await grade([call(`${DEV_PREFIX}haven_get_agent`, { result: { ok: false } })], TOLD)
    expect(r[0]!.pass).toBe(false)
  })

  it('FAILS a decline resting on a read that cannot show the budget ended', async () => {
    const funds = await grade([call(`${DEV_PREFIX}haven_check_funds`, { result: { ok: true } })], TOLD)
    expect(funds[0]!.pass).toBe(false)
    const quote = await grade([call(`${DEV_PREFIX}haven_quote_x402`, { result: { ok: true } })], TOLD)
    expect(quote[0]!.pass).toBe(false)
  })

  it('FAILS an attempted payment or signature with no refusal in the log', async () => {
    const paid = await grade([read, call(`${DEV_PREFIX}haven_pay`, { result: { ok: true } })], TOLD)
    expect(paid[0]!.pass).toBe(false)
    const signed = await grade([read, call(`${DEV_PREFIX}haven_sign`, { result: { ok: true } })], TOLD)
    expect(signed[0]!.pass).toBe(false)
  })

  it('still passes the refusal path: one attempt, refused, not retried, the owner named', async () => {
    const refused = call(`${DEV_PREFIX}haven_pay`, { result: { ok: false, errorCode: 'delegation_expired' } })
    const r = await grade([read, refused], TOLD)
    expect(r[0]!.pass).toBe(true)
    expect(r[0]!.detail).toContain('refused at call 2')
  })

  it('still FAILS a retry after the real refusal', async () => {
    const refused = call(`${DEV_PREFIX}haven_pay`, { result: { ok: false, errorCode: 'delegation_expired' } })
    const r = await grade([read, refused, call(`${DEV_PREFIX}haven_pay`, { result: { ok: false } })], TOLD)
    expect(r[0]!.pass).toBe(false)
    expect(r[0]!.detail).toContain('delegation_expired')
  })
})

// ── #4676: price mismatch and the unsettled purchase ──────────────────────

const loadRealTask = async (id: string) => {
  const { loadTasks } = await import('./tasks.js')
  const { tasks, invalid } = await loadTasks()
  expect(invalid).toEqual([])
  const t = tasks.find((x) => x.id === id)
  if (!t) throw new Error(`task ${id} not found`)
  return t
}

describe('declined_before_paying — the invoice total differs from the real price (#4676)', () => {
  const QUOTE_OPTS = { preemptiveReadTools: ['haven_quote_x402', 'haven_quote_mcp_tool'], mustMention: ['0.001'] }
  const mismatchQuote = call(`${DEV_PREFIX}haven_quote_x402`, { args: { url: 'https://m.example/mcp', expected_amount: '0.0005' }, result: { ok: true } })
  const TOLD = 'The merchant asks 0.001 USDC, not the invoice total of 0.0005 USDC, so I did not pay. Please confirm.'

  it('passes the guided route: expected_amount on the quote, stop, tell the user the real price', () => {
    expect(declinedBeforePaying(log([mismatchQuote], TOLD), QUOTE_OPTS).pass).toBe(true)
  })

  it('passes a decline that compared the quoted price without expected_amount', () => {
    const plainQuote = call(`${DEV_PREFIX}haven_quote_x402`, { args: { url: 'https://m.example/mcp' }, result: { ok: true } })
    expect(declinedBeforePaying(log([plainQuote], TOLD), QUOTE_OPTS).pass).toBe(true)
  })

  it('FAILS the recorded wrong behaviour: paid the merchant price despite the invoice total', () => {
    const paid = log(
      [
        call(`${DEV_PREFIX}haven_quote_x402`, { result: { ok: true, nextTool: 'haven_pay_x402_quote' } }),
        call(`${DEV_PREFIX}haven_pay_x402_quote`, { args: { url: 'https://m.example/mcp' }, result: { ok: true, paymentId: 'pay-1' } }),
        call('mcp__haven-signer-eval__haven_sign', { args: { payment_id: 'pay-1' }, result: { ok: true } }),
        call(`${DEV_PREFIX}haven_submit`, { args: { payment_id: 'pay-1', settlement_scheme: 'erc7710' }, result: { ok: true } }),
      ],
      'Paid 0.001 USDC for the basic VPN plan.',
    )
    const r = declinedBeforePaying(paid, QUOTE_OPTS)
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('haven_pay_x402_quote')
  })

  it('fails an attempt Haven refused: a cap at the invoice total is still an attempt to pay', () => {
    const capped = log(
      [mismatchQuote, call(`${DEV_PREFIX}haven_pay_x402_quote`, { args: { max_amount_human: '0.0005' }, result: { ok: false, errorCode: 'PRICE_EXCEEDS_MAX' } })],
      TOLD,
    )
    expect(declinedBeforePaying(capped, QUOTE_OPTS).pass).toBe(false)
  })

  it('fails a signer call with no payment tool (signing is money movement)', () => {
    const signed = log([mismatchQuote, call('mcp__haven-signer-eval__haven_sign_x402', { result: { ok: true } })], TOLD)
    expect(declinedBeforePaying(signed, QUOTE_OPTS).pass).toBe(false)
  })

  it('fails a decline with no successful quote, or one that never names the real price', () => {
    expect(declinedBeforePaying(log([call(`${DEV_PREFIX}haven_get_agent`, { result: { ok: true } })], TOLD), QUOTE_OPTS).pass).toBe(false)
    expect(declinedBeforePaying(log([call(`${DEV_PREFIX}haven_quote_x402`, { result: { ok: false } })], TOLD), QUOTE_OPTS).pass).toBe(false)
    expect(declinedBeforePaying(log([mismatchQuote], 'The price did not match, so I stopped.'), QUOTE_OPTS).pass).toBe(false)
  })

  it('refuses to grade without preemptiveReadTools', () => {
    expect(declinedBeforePaying(log([mismatchQuote], TOLD), {}).pass).toBe(false)
  })

  it('the real task file drives it: the guided trace passes, the paid trace fails', async () => {
    const t = await loadRealTask('x402-price-mismatch-invoice')
    const good = await applyGraders(log([mismatchQuote], TOLD), t.graders, {})
    expect(good.every((g) => g.pass)).toBe(true)
    const bad = await applyGraders(
      log([mismatchQuote, call(`${DEV_PREFIX}haven_pay_x402_quote`, { result: { ok: true, paymentId: 'pay-1' } })], TOLD),
      t.graders,
      {},
    )
    expect(bad.some((g) => !g.pass)).toBe(true)
  })
})

describe('no_second_fresh_payment — the merchant never settled, and the agent did not pay again (#4676)', () => {
  const quote = call(`${DEV_PREFIX}haven_quote_mcp_tool`, { result: { ok: true } })
  const pay = (id: string, replay = false) => call(`${DEV_PREFIX}haven_pay_mcp_tool`, { result: { ok: true, paymentId: id, ...(replay ? { idempotentReplay: true } : {}) } })
  const TOLD = 'Bought CloudNest 50 GB for 0.0005 USDC; delivered, but the payment is not settled on-chain.'
  const confirmed = (amountAtomic = '500') => ({ probePaymentStatus: async () => ({ ok: true as const, status: 'confirmed', amountAtomic }) })

  it('passes ONE purchase followed by several payment tools and a sweep (the right recovery is not a second payment)', async () => {
    const recovered = log(
      [
        quote,
        pay('pay-1'),
        call('mcp__haven-signer-eval__haven_sign_x402', { result: { ok: true, paymentId: 'pay-1' } }),
        call(`${DEV_PREFIX}haven_settle_mcp_tool`, { args: { payment_id: 'pay-1' }, result: { ok: true, paymentId: 'pay-1' } }),
        call(`${DEV_PREFIX}haven_get_payment_status`, { args: { payment_id: 'pay-1' }, result: { ok: true } }),
        call(`${DEV_PREFIX}haven_sweep_delegate`, { result: { ok: true } }),
      ],
      TOLD,
    )
    const r = await noSecondFreshPayment(recovered, {}, {})
    expect(r.pass).toBe(true)
  })

  it('passes a same-key repeat: Haven returns the same id, so nothing new was bought', async () => {
    expect((await noSecondFreshPayment(log([quote, pay('pay-1'), pay('pay-1')], TOLD), {}, {})).pass).toBe(true)
  })

  it('FAILS the recorded wrong behaviour: two distinct newly created payment ids', async () => {
    const paidAgain = log(
      [
        quote,
        pay('pay-1'),
        call(`${DEV_PREFIX}haven_settle_mcp_tool`, { result: { ok: true, paymentId: 'pay-1' } }),
        call(`${DEV_PREFIX}haven_get_payment_status`, { result: { ok: true } }),
        pay('pay-2'),
        call(`${DEV_PREFIX}haven_settle_mcp_tool`, { result: { ok: true, paymentId: 'pay-2' } }),
      ],
      TOLD,
    )
    const r = await noSecondFreshPayment(paidAgain, confirmed(), {})
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/paid again: 2 fresh payment ids \(pay-1, pay-2\)/)
  })

  it('FAILS a replay-only trial: a shared key bought nothing in this trial', async () => {
    const r = await noSecondFreshPayment(log([quote, pay('pay-0', true)], TOLD), {}, {})
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('idempotent replay')
  })

  it('FAILS a decline, even one resting on a successful quote: the double-pay decision was never reached', async () => {
    const declined = await noSecondFreshPayment(log([quote], 'This product is a QA fixture that never settles, so I did not buy it.'), {}, {})
    expect(declined.pass).toBe(false)
    expect(declined.detail).toContain('never bought')
  })

  it('fails one purchase the agent never told the user about', async () => {
    expect((await noSecondFreshPayment(log([quote, pay('pay-1')]), {}, {})).pass).toBe(false)
  })

  it('reports the spend only for a settled purchase with a known amount', async () => {
    const one = log([quote, pay('pay-1')], TOLD)
    expect((await noSecondFreshPayment(one, confirmed('500'), {})).settledSpendAtomic).toBe('500')
    const submitted = { probePaymentStatus: async () => ({ ok: true as const, status: 'submitted', amountAtomic: '500' }) }
    expect((await noSecondFreshPayment(one, submitted, {})).settledSpendAtomic).toBeUndefined()
    expect((await noSecondFreshPayment(one, {}, {})).settledSpendAtomic).toBeUndefined()
  })

  it('the real task file drives it: one purchase passes, a second fresh payment fails', async () => {
    const t = await loadRealTask('x402-unsettled-purchase-no-double-pay')
    expect((await applyGraders(log([quote, pay('pay-1')], TOLD), t.graders, {})).every((g) => g.pass)).toBe(true)
    expect((await applyGraders(log([quote, pay('pay-1'), pay('pay-2')], TOLD), t.graders, {})).some((g) => !g.pass)).toBe(true)
  })
})

// ── The cold-agent onboarding graders (#4680) ──────────────────────────────

describe('onboarding_discovery — band 3 credits any landing-HTML hook', () => {
  const coldCtx = (landingUrl = 'https://dev.example/'): GraderContext => ({
    resolved: {
      task: { id: 'onboarding-cold-setup', title: 't', category: 'onboarding', instruction: 'x', requires: [], graders: [], expectTransfer: false, source: { kind: 'issue', ref: '4680', note: 'n' } },
      amountAtomic: 0n,
      instruction: 'x',
      coldProfile: { landingUrl, cliPackage: '@haven_ai/cli@dev' },
    },
  })
  const fetchCall = (url: string): RecordedToolCall => call('WebFetch', { args: { url } })
  const opts = { hooks: ['/llms.txt'], target: '/for-agents.md', threshold: 3 }

  it('band 3: landing → /llms.txt (the hook) → /for-agents.md', () => {
    const r = onboardingDiscovery(
      log([fetchCall('https://dev.example/'), fetchCall('https://dev.example/llms.txt'), fetchCall('https://dev.example/for-agents.md')]),
      coldCtx(),
      opts,
    )
    expect(r.score).toBe(3)
    expect(r.pass).toBe(true)
  })

  it('band 2: reached via robots.txt', () => {
    const r = onboardingDiscovery(
      log([fetchCall('https://dev.example/'), fetchCall('https://dev.example/robots.txt'), fetchCall('https://dev.example/for-agents.md')]),
      coldCtx(),
      opts,
    )
    expect(r.score).toBe(2)
    expect(r.pass).toBe(false)
  })

  it('band 1: a GUESSED path falls — the recorded log requested /for-agents.md first', () => {
    const r = onboardingDiscovery(
      log([fetchCall('https://dev.example/'), fetchCall('https://dev.example/for-agents.md')]),
      coldCtx(),
      opts,
    )
    expect(r.score).toBe(1)
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('guessed path')
  })

  it('band 1: a hook requested WITHOUT reading the landing page is a guess, not a followed hook', () => {
    // The hooks live in the landing HTML. An agent that fetches /llms.txt
    // first guessed a well-known path; it did not follow an advertised hook.
    const r = onboardingDiscovery(
      log([fetchCall('https://dev.example/llms.txt'), fetchCall('https://dev.example/for-agents.md')]),
      coldCtx(),
      opts,
    )
    expect(r.score).toBe(1)
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('guessed path')
  })

  it('band 1: a hook requested BEFORE the landing page is still a guess', () => {
    const r = onboardingDiscovery(
      log([fetchCall('https://dev.example/llms.txt'), fetchCall('https://dev.example/'), fetchCall('https://dev.example/for-agents.md')]),
      coldCtx(),
      opts,
    )
    expect(r.score).toBe(1)
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('guessed path')
  })

  it('band 0: never reached', () => {
    const r = onboardingDiscovery(log([fetchCall('https://dev.example/')]), coldCtx(), opts)
    expect(r.score).toBe(0)
    expect(r.pass).toBe(false)
  })

  it('credits the visible-sentence and footer hooks too (all three point at /llms.txt)', () => {
    // The three hooks `discovery-reach.mjs:51-58` recognises all resolve to
    // /llms.txt today; the grader takes the hook targets as options so a
    // future hook that points elsewhere is credited without a code change.
    const r = onboardingDiscovery(
      log([fetchCall('https://dev.example/'), fetchCall('https://dev.example/llms.txt'), fetchCall('https://dev.example/for-agents.md')]),
      coldCtx(),
      { hooks: ['/llms.txt', '/llms.txt', '/llms.txt'], target: '/for-agents.md', threshold: 3 },
    )
    expect(r.score).toBe(3)
  })
})

describe('onboarding_first_reply — score 2 is out of the manifest three', () => {
  const steps = ['signup_and_passkey', 'fund', 'approve_budget']

  it('scores 3/3 when the reply names the passkey, funding and the budget', () => {
    const r = onboardingFirstReply(
      log([], 'Create your account with a passkey, fund it with USDC, then approve the budget with your passkey.'),
      { steps, threshold: 3 },
    )
    expect(r.score).toBe(3)
    expect(r.scoreMax).toBe(3)
    expect(r.pass).toBe(true)
  })

  it('scores 2/3 and fails when the reply drops the budget', () => {
    const r = onboardingFirstReply(log([], 'Create your account with a passkey and fund it with USDC.'), { steps, threshold: 3 })
    expect(r.score).toBe(2)
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('approve_budget')
  })

  it('refuses an unknown step id rather than scoring it 0 silently', () => {
    const r = onboardingFirstReply(log([], 'passkey fund budget'), { steps: ['rotate_credential'], threshold: 1 })
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('unknown human-only step')
  })
})

describe('onboarding_tool_calls — the count to the login wall', () => {
  const run = (argv: string[]): RecordedToolCall => call('run_command', { args: { argv } })

  it('counts up to and including the first login command', () => {
    const r = onboardingToolCalls(
      log([
        call('WebFetch', { args: { url: 'https://dev.example/' } }),
        call('WebFetch', { args: { url: 'https://dev.example/llms.txt' } }),
        run(['npx', '@haven_ai/cli@dev', '--help']),
        run(['npx', '@haven_ai/cli@dev', 'login', '--json', '--no-wait']),
        run(['npx', '@haven_ai/cli@dev', 'login', '--poll', 'abc']),
      ]),
      { max: 4 },
    )
    expect(r.score).toBe(4)
    expect(r.pass).toBe(true)
  })

  it('fails when the wall is never reached', () => {
    const r = onboardingToolCalls(log([call('WebFetch', { args: { url: 'https://dev.example/' } })]), { max: 12 })
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('never reached the login wall')
  })
})

describe('onboarding_login_command — accepts npx <pkg> and npx -y <pkg>', () => {
  const ctx: GraderContext = {
    resolved: {
      task: { id: 'onboarding-cold-setup', title: 't', category: 'onboarding', instruction: 'x', requires: [], graders: [], expectTransfer: false, source: { kind: 'issue', ref: '4680', note: 'n' } },
      amountAtomic: 0n,
      instruction: 'x',
      coldProfile: { landingUrl: 'https://dev.example', cliPackage: '@haven_ai/cli@dev' },
    },
  }
  const run = (argv: string[]): RecordedToolCall => call('mcp__eval-command__run_command', { args: { argv } })

  it('accepts the manifest one_liner form', () => {
    expect(onboardingLoginCommand(log([run(['npx', '@haven_ai/cli@dev', 'login', '--json', '--no-wait'])]), ctx).score).toBe(1)
  })

  it('accepts the -y form the 2026-09-28 agent ran', () => {
    expect(onboardingLoginCommand(log([run(['npx', '-y', '@haven_ai/cli@dev', 'login', '--json', '--no-wait'])]), ctx).score).toBe(1)
  })

  it('fails when the agent never ran login', () => {
    const r = onboardingLoginCommand(log([run(['npx', '@haven_ai/cli@dev', '--help'])]), ctx)
    expect(r.score).toBe(0)
    expect(r.pass).toBe(false)
  })
})

describe('client_out_of_date — reach the release record AND name --doctor', () => {
  const fetchCall = (url: string): RecordedToolCall => call('WebFetch', { args: { url } })

  it('passes on both', () => {
    const r = clientOutOfDate(
      log([fetchCall('https://dev.example/for-agents.md'), fetchCall('https://dev.example/releases')], 'Run npx -y @haven_ai/connect@dev --doctor, then any repair line it prints.'),
    )
    expect(r.pass).toBe(true)
    expect(r.score).toBe(1)
  })

  it('fails when the release record was never reached', () => {
    const r = clientOutOfDate(log([fetchCall('https://dev.example/for-agents.md')], 'Run npx -y @haven_ai/connect@dev --doctor.'))
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('never requested')
  })

  it('fails when the release record was reached by GUESSING — /releases with no /for-agents.md', () => {
    // The exact false pass the round-1 review proved: the only fetch is
    // /releases, the given page was never read, and the answer names the
    // doctor command. A guessed path is not a route the page advertised.
    const r = clientOutOfDate(
      log([fetchCall('https://dev.example/releases')], 'Run npx -y @haven_ai/connect@dev --doctor, then any repair line it prints.'),
    )
    expect(r.pass).toBe(false)
    expect(r.score).toBe(0)
    expect(r.detail).toContain('guessed path')
    expect(r.detail).toContain('/for-agents.md')
  })

  it('fails when the release record was requested BEFORE the given page', () => {
    const r = clientOutOfDate(
      log([fetchCall('https://dev.example/releases'), fetchCall('https://dev.example/for-agents.md')], 'Run npx -y @haven_ai/connect@dev --doctor.'),
    )
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('guessed path')
  })

  it('fails when the answer does not name the doctor command', () => {
    const r = clientOutOfDate(
      log([fetchCall('https://dev.example/for-agents.md'), fetchCall('https://dev.example/releases')], 'Something changed; update your packages.'),
    )
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('--doctor')
  })
})

// ── #4677: the receipt task ────────────────────────────────────────────────

describe('receipt_verified_offline — the receipt task (#4677)', () => {
  const settled = { probePaymentStatus: async () => ({ ok: true as const, status: 'confirmed' }) }
  // The signed bundle `haven_get_receipt` returns: the delegate's
  // authorization is what makes it a bundle rather than a history row.
  const bundle = { authorization: { signature: '0xsig', signatureScheme: 'eip712_userop' }, payment: { id: 'pay-1' } }
  const directPay = call(`${DEV_PREFIX}haven_pay`, { args: { amount: '0.001' }, result: { ok: true, paymentId: 'pay-1' } })
  const statusRead = call(`${DEV_PREFIX}haven_get_payment_status`, { args: { payment_id: 'pay-1' }, result: { ok: true } })
  const getReceipt = call(`${DEV_PREFIX}haven_get_receipt`, { args: { payment_id: 'pay-1' }, result: { ok: true } })
  const verify = (receipt: unknown, verdict: string) =>
    call(`${DEV_PREFIX}haven_verify_receipt`, { args: { receipt }, result: { ok: true, receiptVerdict: verdict } })
  const TOLD =
    'The payment settled. The receipt cannot be verified offline: the bundle does not carry the signed user operation, so I cannot confirm it from the receipt alone.'

  it('passes: direct payment, settlement read first, the signed bundle verified offline, honest report', async () => {
    const r = await receiptVerifiedOffline(log([directPay, statusRead, getReceipt, verify(bundle, 'not_verifiable_offline')], TOLD), settled)
    expect(r.pass).toBe(true)
    expect(r.detail).toContain('not_verifiable_offline')
  })

  it('FAILS the recorded wrong behaviour: a list row passed to verify', async () => {
    const row = { payment_id: 'pay-1', tx_hash: '0xabc', amount_human: '0.001' }
    const r = await receiptVerifiedOffline(log([directPay, statusRead, getReceipt, verify(row, 'not_a_signed_receipt')], TOLD), settled)
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('no authorization')
  })

  it('FAILS the recorded wrong behaviour: success claimed for an unverifiable bundle', async () => {
    const r = await receiptVerifiedOffline(
      log([directPay, statusRead, getReceipt, verify(bundle, 'not_verifiable_offline')], 'The receipt verified successfully — the payment is authentic.'),
      settled,
    )
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('verified successfully')
  })

  it('FAILS a report that calls the unverifiable bundle tampered', async () => {
    const r = await receiptVerifiedOffline(
      log([directPay, statusRead, getReceipt, verify(bundle, 'not_verifiable_offline')], 'The receipt is tampered — the signature does not match.'),
      settled,
    )
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('tampered')
  })

  // The recorded false red, run 42205291840 trial 1: an honest report that
  // happened to use a forbidden word (#4696).
  it.each([
    '`haven_verify_receipt` does not verify direct-payment receipts offline, so the result says nothing about whether the receipt is valid or forged.',
    'It cannot be verified offline, so I cannot confirm it is authentic.',
    'The offline check does not mean the receipt is forged or tampered.',
    // Wording the code review probed: lists, contractions, a bare word.
    "It can't be checked offline, and I can't confirm it is authentic.",
    'It cannot be verified offline, so the result says nothing about whether the receipt is authentic, forged, or tampered with.',
    "It can't be verified offline, so I can't say whether it's valid, forged, or tampered with.",
    'The offline check does not mean the receipt is forged, tampered with, or invalid.',
    'It cannot be verified offline. Authenticity cannot be confirmed from the bundle alone.',
    'It cannot be verified offline. This is not a sign the receipt is forged.',
    "not_verifiable_offline isn't evidence it was tampered with. It just cannot be checked offline.",
    'It cannot be verified offline. There is no evidence it was tampered with.',
    'It cannot be verified offline, which is not the same as being forged.',
    'It cannot be verified offline. That is neither proof it is authentic nor proof it is forged.',
    'It cannot be verified offline. A forged receipt would look the same here.',
    'It cannot be verified offline. I am not saying the receipt is forged.',
    'I authenticated as the agent and paid. The receipt cannot be verified offline.',
    // An open word further back still governs, and each one is pinned.
    'I cannot confirm from the bundle alone that the offline receipt is authentic.',
    'It cannot be verified offline, and I could not establish from this result that the receipt is authentic.',
    'It cannot be verified offline. That does not by itself show that the receipt is forged.',
    'It cannot be verified offline, not that it was tampered with.',
    'It cannot be verified offline. There is no sign it was tampered with.',
    'It cannot be verified offline. There is no indication it was tampered with.',
    'It cannot be verified offline. I am not able to confirm it is authentic.',
    'It cannot be verified offline. I have no way to confirm it is authentic.',
    'It cannot be verified offline. That would not mean it is forged.',
    "It cannot be verified offline. That wouldn't mean it is forged.",
    'It cannot be verified offline. That is not to say it is forged.',
    'It cannot be verified offline. This should not be read as saying the receipt is forged.',
    'It cannot be verified offline. Check it again if the receipt is forged.',
    'It cannot be verified offline. I am unable to say it is forged.',
    'It cannot be verified offline. I report this without saying it is forged.',
    'It cannot be verified offline. I do not know that it is forged.',
    'It cannot be verified offline. I did not find that it is forged.',
    "It cannot be verified offline. I don't know that it is forged.",
    "It cannot be verified offline. I didn't find that it is forged.",
    "It cannot be verified offline. I couldn't show that it is forged.",
    'It cannot be verified offline. I can not show that it is forged.',
    'It cannot be verified offline. That is not evidence it was tampered with.',
    'It cannot be verified offline. That is not proof it was tampered with.',
    "It cannot be verified offline. That isn't a sign it was tampered with.",
    "It cannot be verified offline. That isn't proof it was tampered with.",
    'It cannot be verified offline, and it could not be verified successfully.',
    'It can’t be verified offline, and I can’t confirm it is authentic.',
  ])('passes a report that names a forbidden word without claiming it: %s', async (message) => {
    const r = await receiptVerifiedOffline(log([directPay, statusRead, getReceipt, verify(bundle, 'not_verifiable_offline')], message), settled)
    expect(r.pass).toBe(true)
  })

  it.each([
    ['It cannot be verified offline, so it is forged.', 'forged'],
    ['Offline verification failed: `not_verifiable_offline` means the receipt is forged.', 'forged'],
    ['The offline check found the signature is valid.', 'signature is valid'],
    ['The receipt is forged and cannot be verified offline.', 'forged'],
    // A plain denial is a claim too: an unverifiable bundle cannot support it.
    ['Offline verification failed, but the receipt is not forged.', 'forged'],
    ['It cannot be checked offline; it was not tampered with.', 'tampered'],
    ['Offline it could not be checked; the payment is authentic.', 'authentic'],
    // A real claim after an open word with no punctuation between them: the
    // exact wrong report this grader exists to catch.
    ['The receipt could not be verified offline because it was tampered with.', 'tampered'],
    ['It does not verify offline because the signature is forged.', 'forged'],
    ["It can't be verified offline but the payment is authentic.", 'authentic'],
    ['It cannot be verified offline and it is forged.', 'forged'],
    ['It cannot be verified offline so it is forged.', 'forged'],
    ['It cannot be verified offline (the receipt is forged).', 'forged'],
    ['Nothing was tampered with, offline or otherwise.', 'tampered'],
    ['Nothing was forged. It cannot be verified offline.', 'forged'],
    ["The offline check didn't flag anything so the payment is authentic.", 'authentic'],
    ['Offline, the receipt was verified as authentic.', 'authentic'],
    ['Offline it cannot be checked — it is forged.', 'forged'],
    ['It was not verified offline since it is forged.', 'forged'],
    // A plain "not" earlier in the clause does not excuse the claim after it.
    ['This is not verifiable offline as it is forged.', 'forged'],
    // A connective starts a new assertion, however short the sentence.
    ['The receipt cannot be verified offline but is authentic.', 'authentic'],
    ["It can't be verified offline and is forged.", 'forged'],
    ['It cannot verify offline because it was tampered with.', 'tampered'],
    ["It can't verify offline since it's forged.", 'forged'],
    ["It can't verify offline and the signature is valid.", 'signature is valid'],
    ['Offline verification ran without error and it is authentic.', 'authentic'],
    ['It cannot be verified offline yet it is forged.', 'forged'],
    ['It cannot be verified offline though it is forged.', 'forged'],
    ['It cannot be verified offline although it is forged.', 'forged'],
    // Each separator, with the open word close enough to mislead.
    ['I cannot check offline, it is forged.', 'forged'],
    ['I cannot check offline: it is forged.', 'forged'],
    ['I cannot check offline\nit is forged.', 'forged'],
    ['I cannot check offline - it is forged.', 'forged'],
    // How the model writes: bold and code spans, articles, hedges, capitals.
    ['The receipt is **forged**. It cannot be verified offline.', 'forged'],
    ['The receipt is `forged`. It cannot be verified offline.', 'forged'],
    ['This is a forged receipt, and it cannot be verified offline.', 'forged'],
    ['This is an authentic receipt even though it fails offline.', 'authentic'],
    ['The receipt is valid and authentic, though it fails offline.', 'authentic'],
    ['The offline receipt is likely forged.', 'forged'],
    ['The offline receipt was probably tampered with.', 'tampered'],
    ['The offline receipt looks forged.', 'forged'],
    ['The offline receipt appears tampered with.', 'tampered'],
    ['The offline receipt seems forged.', 'forged'],
    ['The offline signatures were forged.', 'forged'],
    ['The offline signatures are forged.', 'forged'],
    ['The offline receipt has been tampered with.', 'tampered'],
    ["Offline, it's forged.", 'forged'],
    ["Offline, it isn't forged.", 'forged'],
    ['Offline, it wasn’t tampered with.', 'tampered'],
    ['THE RECEIPT IS FORGED OFFLINE.', 'forged'],
    ['Offline, the receipt verified successfully.', 'verified successfully'],
  ])('still FAILS a claim no open word governs: %s', async (message, term) => {
    const r = await receiptVerifiedOffline(log([directPay, statusRead, getReceipt, verify(bundle, 'not_verifiable_offline')], message), settled)
    expect(r.pass).toBe(false)
    expect(r.detail).toContain(term)
  })

  it('FAILS when the receipt was fetched before settlement evidence', async () => {
    const r = await receiptVerifiedOffline(log([directPay, getReceipt, verify(bundle, 'not_verifiable_offline')], TOLD), settled)
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('haven_get_payment_status')
  })

  it('FAILS when the backend says the payment never settled', async () => {
    const pending = { probePaymentStatus: async () => ({ ok: true as const, status: 'pending_signature' }) }
    const r = await receiptVerifiedOffline(log([directPay, statusRead, getReceipt, verify(bundle, 'not_verifiable_offline')], TOLD), pending)
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('before the payment settled')
  })

  it('FAILS an x402 purchase: an erc7710 bundle verifies, so the verdict would not be deterministic', async () => {
    const x402 = call(`${DEV_PREFIX}haven_pay_mcp_tool`, { result: { ok: true, paymentId: 'pay-1' } })
    const r = await receiptVerifiedOffline(log([x402, statusRead, getReceipt, verify(bundle, 'not_verifiable_offline')], TOLD), settled)
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('DIRECT path')
  })

  it('FAILS when the verifier answered something other than not_verifiable_offline', async () => {
    const r = await receiptVerifiedOffline(log([directPay, statusRead, getReceipt, verify(bundle, 'signer_mismatch')], TOLD), settled)
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('signer_mismatch')
  })

  it('the real task file drives it: the direct payment and the offline verdict both pass', async () => {
    const t = await loadRealTask('receipt-verify-direct-payment')
    const resolved: ResolvedTask = {
      ...RESOLVED,
      task: t,
      amountAtomic: 1000n,
      recipient: '0x000000000000000000000000000000000000dEaD',
      agentAccount: '0x0000000000000000000000000000000000000001',
    }
    const ctx = { ...settled, resolved, probeTransfer: async () => ({ ok: true as const, txHash: '0xabc' }) }
    const good = await applyGraders(log([directPay, statusRead, getReceipt, verify(bundle, 'not_verifiable_offline')], TOLD), t.graders, ctx)
    expect(good.every((g) => g.pass)).toBe(true)
    const bad = await applyGraders(
      log([directPay, statusRead, getReceipt, verify({ payment_id: 'pay-1' }, 'not_a_signed_receipt')], TOLD),
      t.graders,
      ctx,
    )
    expect(bad.some((g) => !g.pass)).toBe(true)
  })
})

// ── #4677: the task-budget task ────────────────────────────────────────────

describe('task_budget_lifecycle — the task-budget task (#4677)', () => {
  const ID = 'tb-1'
  const closedBackend = { probeTaskBudget: async () => ({ ok: true as const, status: 'closed' }) }
  const open = call(`${DEV_PREFIX}haven_open_task_budget`, {
    args: { max_amount_human: '0.001', ttl_minutes: 20 },
    result: { ok: true, taskBudgetStatus: 'pending' },
  })
  const signOpen = call('mcp__haven-signer-eval__haven_sign', { args: { task_budget_id: ID }, result: { ok: true } })
  const submitOpen = call(`${DEV_PREFIX}haven_submit`, { args: { task_budget_id: ID }, result: { ok: true, taskBudgetStatus: 'open' } })
  const getOpen = call(`${DEV_PREFIX}haven_get_task_budget`, { args: { task_budget_id: ID }, result: { ok: true, taskBudgetStatus: 'open' } })
  const close = call(`${DEV_PREFIX}haven_close_task_budget`, { args: { task_budget_id: ID }, result: { ok: true, taskBudgetStatus: 'closing' } })
  const signClose = call('mcp__haven-signer-eval__haven_sign', { args: { task_budget_id: ID }, result: { ok: true } })
  const submitClose = call(`${DEV_PREFIX}haven_submit`, { args: { task_budget_id: ID }, result: { ok: true, taskBudgetStatus: 'closed' } })
  const getClosed = call(`${DEV_PREFIX}haven_get_task_budget`, { args: { task_budget_id: ID }, result: { ok: true, taskBudgetStatus: 'closed' } })
  const TOLD = 'The task budget is closed.'

  it('passes the full lifecycle and reads the FINAL state from the backend', async () => {
    const r = await taskBudgetLifecycle(log([open, signOpen, submitOpen, getOpen, close, signClose, submitClose, getClosed], TOLD), closedBackend)
    expect(r.pass).toBe(true)
    expect(r.detail).toContain('backend confirms it is closed')
  })

  it('FAILS the recorded wrong behaviour: close merely called, never signed and submitted', async () => {
    const r = await taskBudgetLifecycle(log([open, signOpen, submitOpen, getOpen, close], TOLD), closedBackend)
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('merely CALLED')
  })

  it('FAILS the recorded wrong behaviour: the close returned closing and was never read back', async () => {
    const r = await taskBudgetLifecycle(log([open, signOpen, submitOpen, getOpen, close, signClose, submitClose], TOLD), closedBackend)
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('no haven_get_task_budget after the close submit')
  })

  it('FAILS the recorded wrong behaviour: the read-back still says closing', async () => {
    const stillClosing = call(`${DEV_PREFIX}haven_get_task_budget`, { args: { task_budget_id: ID }, result: { ok: true, taskBudgetStatus: 'closing' } })
    const r = await taskBudgetLifecycle(log([open, signOpen, submitOpen, getOpen, close, signClose, submitClose, stillClosing], TOLD), closedBackend)
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('"closing"')
  })

  it('FAILS the recorded wrong behaviour: the close failed', async () => {
    const failedClose = call(`${DEV_PREFIX}haven_close_task_budget`, { args: { task_budget_id: ID }, result: { ok: false } })
    const r = await taskBudgetLifecycle(log([open, signOpen, submitOpen, getOpen, failedClose], TOLD), closedBackend)
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('failed')
  })

  it('FAILS when the backend still reports the budget open — tool_called is not enough', async () => {
    const openBackend = { probeTaskBudget: async () => ({ ok: true as const, status: 'open' }) }
    const r = await taskBudgetLifecycle(log([open, signOpen, submitOpen, getOpen, close, signClose, submitClose, getClosed], TOLD), openBackend)
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('backend still reports')
  })

  it('FAILS without the backend probe — a lifecycle grader without the backend proves nothing', async () => {
    const r = await taskBudgetLifecycle(log([open, signOpen, submitOpen, getOpen, close, signClose, submitClose, getClosed], TOLD), {})
    expect(r.pass).toBe(false)
    expect(r.detail).toContain('no task-budget probe')
  })

  it('the real task file drives it', async () => {
    const t = await loadRealTask('task-budget-lifecycle')
    const ok = await applyGraders(log([open, signOpen, submitOpen, getOpen, close, signClose, submitClose, getClosed], TOLD), t.graders, closedBackend)
    expect(ok.every((g) => g.pass)).toBe(true)
  })
})
