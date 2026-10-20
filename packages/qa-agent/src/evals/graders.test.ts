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
  noPaymentRetryAfterRefusal,
  paymentStatusSettled,
  transferSettled,
  x402RequestModeReplay,
} from './graders.js'
import type { AgentRunLog, RecordedToolCall, ResolvedTask, EvalTask } from './types.js'

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
// the log shape the agent actually produced.
describe('over-budget-check-status-no-retry — graded on what the agent can actually do', () => {
  it('passes a refusal followed by an allowances check and an honest report', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const taskPath = fileURLToPath(new URL('./tasks/over-budget-check-status-no-retry.json', import.meta.url))
    const task = JSON.parse(readFileSync(taskPath, 'utf8')) as EvalTask
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
