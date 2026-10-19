/**
 * CLI-level tests for #3992: the wired backend payment probe (A1), per-trial
 * resolution + evidence scoping (A2 — false passes, false failures, mid-run
 * errors), and the tiered ordering with a once-only drainer (A3).
 *
 * Everything drives the PRODUCTION path: `runSuite` with the CLI's own
 * `buildGraderContext` / `createPerTrialResolver`, over simulated budgets —
 * no model, no network.
 */

import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyGraders } from './graders.js'
import { parseHermesSessionLog } from './hermes.js'
import { renderSummary, runSuite, type EvalAdapter } from './runner.js'
import { buildGraderContext, createPerTrialResolver, type BlockNumberSource } from './cli.js'
import { selectTaskSequence, loadTasks } from './tasks.js'
import { HavenApi } from '../lib/haven-api.js'
import type { BudgetUse } from '../lib/delegation-budget.js'
import type { AgentRunLog, EvalTask, RecordedToolCall } from './types.js'

const DEV_PREFIX = 'mcp__haven-eval-dev__'
const TASKS_DIR = join(fileURLToPath(import.meta.url), '..', 'tasks')

function call(name: string, opts: Partial<RecordedToolCall> = {}): RecordedToolCall {
  return { name, ...opts }
}

function log(taskId: string, trial: number, calls: RecordedToolCall[], finalMessage?: string): AgentRunLog {
  return { taskId, trial, calls, ...(finalMessage !== undefined ? { finalMessage } : {}) }
}

const fixedAmountTask = (id: string, overrides: Partial<EvalTask> = {}): EvalTask => ({
  id,
  title: id,
  category: 'direct-payment',
  instruction: 'Pay {amount} USDC to {recipient}.',
  requires: [],
  amount: { rule: 'remaining_period_budget', delta_atomic: '0' },
  graders: [{ name: 'transfer_settled' }],
  expectTransfer: true,
  tier: 1,
  source: { kind: 'issue', ref: '3992', note: 'test' },
  ...overrides,
})

const claimingSendLog = (taskId: string, trial: number): AgentRunLog =>
  log(taskId, trial, [call(`${DEV_PREFIX}haven_send`), call(`${DEV_PREFIX}haven_submit`, { result: { ok: true } })], 'Sent.')

// ── A1: the backend payment probe is wired ─────────────────────────────────

describe('A1: buildGraderContext wires probePaymentStatus into payment_status_settled', () => {
  // A live-shaped Hermes session: the payment id appears ONLY in the tool
  // RESULT (the create call's own response), not in a later call's args.
  const LIVE_SHAPED_JSONL = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: `${DEV_PREFIX}haven_pay_mcp_tool`, input: { token: 'USDC' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '{"success":true,"payment_id":"p-9"}' }] }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Paid; payment p-9 settled.' }] } }),
  ].join('\n')

  const fakeApi = (status: string) =>
    ({
      getPayment: vi.fn(async () => ({ ok: true, status, data: { status } })),
    }) as unknown as HavenApi & { getPayment: ReturnType<typeof vi.fn> }

  const provider: BlockNumberSource = { getBlockNumber: async () => 99 }

  it('a live-shaped log with a settled payment_id passes and the probe received it', async () => {
    const api = fakeApi('settled')
    const parsed = parseHermesSessionLog(LIVE_SHAPED_JSONL, { taskId: 't', trial: 1 })
    const results = await applyGraders(parsed, [{ name: 'payment_status_settled' }], buildGraderContext({ api, provider }))
    expect(results[0].pass).toBe(true)
    expect(api.getPayment).toHaveBeenCalledWith('p-9')
  })

  it('the same log with the probe reporting pending fails', async () => {
    const api = fakeApi('pending_signature')
    const parsed = parseHermesSessionLog(LIVE_SHAPED_JSONL, { taskId: 't', trial: 1 })
    const results = await applyGraders(parsed, [{ name: 'payment_status_settled' }], buildGraderContext({ api, provider }))
    expect(results[0].pass).toBe(false)
    expect(results[0].detail).toContain('not settled')
    expect(results[0].detail).toContain('p-9')
  })

  it('#4091: the probe parses the payment record amount into atomic units (0.001 → 1000)', async () => {
    const api = {
      getPayment: vi.fn(async () => ({ ok: true, status: 200, data: { status: 'settled', amount: '0.001' } })),
    } as unknown as HavenApi
    const parsed = parseHermesSessionLog(LIVE_SHAPED_JSONL, { taskId: 't', trial: 1 })
    const results = await applyGraders(parsed, [{ name: 'payment_status_settled' }], buildGraderContext({ api, provider }))
    expect(results[0].pass).toBe(true)
    expect(results[0].settledSpendAtomic).toBe('1000')
  })

  it('#4091: a record without a parsable amount omits the spend — the guard must never guess', async () => {
    const api = {
      getPayment: vi.fn(async () => ({ ok: true, status: 200, data: { status: 'settled' } })),
    } as unknown as HavenApi
    const parsed = parseHermesSessionLog(LIVE_SHAPED_JSONL, { taskId: 't', trial: 1 })
    const results = await applyGraders(parsed, [{ name: 'payment_status_settled' }], buildGraderContext({ api, provider }))
    expect(results[0].pass).toBe(true)
    expect(results[0].settledSpendAtomic).toBeUndefined()
  })
})

// ── A2, false pass: evidence scoped to each trial ──────────────────────────

describe('A2 false pass: a trial that paid nothing cannot pass on an earlier transfer', () => {
  const probeCalls: Array<{ from: string; to: string; amountAtomic: bigint; fromBlock?: number }> = []
  // Only trial 1's transfer exists on-chain (from its own start block on).
  const probeTransfer = async (expected: { from: string; to: string; amountAtomic: bigint; fromBlock?: number }) => {
    probeCalls.push(expected)
    return expected.fromBlock === 10 ? { ok: true as const, txHash: '0x1' } : { ok: false as const, error: 'no Transfer from that payer to that payee since that block' }
  }
  const graderContext = { probeTransfer }

  it('two trials of one fixed-amount task: trial 2 claims success and FAILS; each probe got its own fromBlock', async () => {
    const task = fixedAmountTask('fixed-amount-send')
    // The per-trial resolver the CLI builds: same amount, but a FRESH block
    // immediately before each trial.
    const report = await runSuite({
      tasks: [task],
      resolveForTrial: async (t, trial) => ({ task: t, amountAtomic: 1_000n, instruction: 'x', recipient: '0xrec', agentAccount: '0xagent', startedAtBlock: trial * 10 }),
      adapter: {
        name: 'fake',
        runTask: async (resolved, trial) => claimingSendLog(resolved.task.id, trial),
      },
      trials: 2,
      graderContext,
    })
    expect(probeCalls.map((c) => c.fromBlock)).toEqual([10, 20])
    expect(probeCalls.every((c) => c.amountAtomic === 1_000n)).toBe(true)
    const trials = report.tasks[0].trials
    expect(trials[0].pass).toBe(true)
    expect(trials[1].pass).toBe(false)
    expect(trials[1].detail).toContain('claims a payment happened')
    expect(trials[1].detail).toContain('NO matching USDC Transfer')
  })

  it('across two different tasks with the same amount and recipient: the second cannot ride the first', async () => {
    probeCalls.length = 0
    const a = fixedAmountTask('send-a')
    const b = fixedAmountTask('send-b')
    let n = 0
    const report = await runSuite({
      tasks: [a, b],
      resolveForTrial: async (t) => ({ task: t, amountAtomic: 1_000n, instruction: 'x', recipient: '0xrec', agentAccount: '0xagent', startedAtBlock: ++n === 1 ? 10 : 20 }),
      adapter: { name: 'fake', runTask: async (resolved, trial) => claimingSendLog(resolved.task.id, trial) },
      trials: 1,
      graderContext,
    })
    expect(probeCalls.map((c) => c.fromBlock)).toEqual([10, 20])
    expect(report.tasks[0].passAll).toBe(true)
    expect(report.tasks[1].passAll).toBe(false)
  })
})

// ── A2, false failures: production sequencing over the 10 starter tasks ────

const paying = new Set([
  'direct-send-get-agent-first',
  'direct-send-partial-budget',
  'direct-send-then-report-remaining',
  'direct-send-full-remaining',
  'x402-catalog-guided-purchase',
  'x402-plain-http-request-mode',
])

function successLogFor(taskId: string): AgentRunLog {
  switch (taskId) {
    case 'direct-send-get-agent-first':
      return log(taskId, 1, [call(`${DEV_PREFIX}haven_get_agent`), call(`${DEV_PREFIX}haven_send`), call(`${DEV_PREFIX}haven_submit`, { result: { ok: true } })], 'Sent.')
    case 'direct-send-partial-budget':
      return log(taskId, 1, [call(`${DEV_PREFIX}haven_send`), call(`${DEV_PREFIX}haven_submit`, { result: { ok: true, paymentId: 'p-1' } })], 'Sent, payment p-1.')
    case 'direct-send-then-report-remaining':
      return log(taskId, 1, [call(`${DEV_PREFIX}haven_send`), call(`${DEV_PREFIX}haven_submit`, { result: { ok: true } }), call(`${DEV_PREFIX}haven_get_allowances`)], 'Sent; 7.5 USDC remains.')
    case 'x402-catalog-guided-purchase':
      return log(taskId, 1, [call(`${DEV_PREFIX}haven_prepare_catalog_purchase`), call(`${DEV_PREFIX}haven_pay_mcp_tool`, { result: { ok: true, paymentId: 'p-2' } })], 'Bought the VPN product.')
    case 'x402-plain-http-request-mode':
      return log(taskId, 1, [
        call(`${DEV_PREFIX}haven_quote_x402`, { result: { ok: true, nextTool: 'haven_pay_x402_quote' } }),
        call(`${DEV_PREFIX}haven_pay_x402_quote`, { args: { url: 'https://merchant.example/mcp' } }),
        call(`${DEV_PREFIX}haven_pay_mcp_tool`, { result: { ok: true, paymentId: 'p-3' } }),
      ], 'Replayed and got the body.')
    case 'direct-send-full-remaining':
      return log(taskId, 1, [call(`${DEV_PREFIX}haven_send`), call(`${DEV_PREFIX}haven_submit`, { result: { ok: true } }), call(`${DEV_PREFIX}haven_get_allowances`)], 'Sent everything.')
    default:
      return log(taskId, 1, [call(`${DEV_PREFIX}haven_get_allowances`)], 'Nothing to spend.')
  }
}

function refusalLogFor(taskId: string, errorCode = 'delegation_budget_exceeded'): AgentRunLog {
  if (taskId === 'over-budget-check-status-no-retry') {
    return log(taskId, 1, [
      // No haven_get_payment_status: a budget pre-check refusal creates no
      // payment, so there is no payment_id to check (pilot, 2026-10-19).
      call(`${DEV_PREFIX}haven_pay`, { result: { ok: false, errorCode } }),
      call(`${DEV_PREFIX}haven_get_allowances`),
    ], 'Refused: your period budget is spent — 0.00 USDC remaining, shortfall 1.00. Not retrying.')
  }
  if (taskId === 'x402-price-cap-below-price') {
    return log(taskId, 1, [call(`${DEV_PREFIX}haven_quote_x402`, { result: { ok: false, errorCode: 'PRICE_EXCEEDS_MAX' } })], 'The real price is 0.001 USDC, above your 0.0001 cap. Stopping.')
  }
  return log(taskId, 1, [call(`${DEV_PREFIX}haven_pay`, { result: { ok: false, errorCode } })], 'Refused by the period budget — nothing remains. Not retrying.')
}

describe('A2 false failures: runSuite with the CLI resolver over a simulated budget', () => {
  /** Emulates readOnchainBudget's refusal semantics: an exhausted budget is an error unless the caller expects it. */
  const simulatedBudget = () => {
    let remaining = 10_000_000n
    const reads: bigint[] = []
    const readBudget = async (use: BudgetUse): Promise<{ remaining: bigint } | { error: string }> => {
      reads.push(remaining)
      if (use !== 'exhausted-ok' && remaining <= 0n) return { error: 'the USDC budget is already exhausted — every amount would be refused' }
      return { remaining }
    }
    return {
      get remaining() {
        return remaining
      },
      readBudget,
      /** The trial's settled payment leaves the simulated budget. */
      settle: (amount: bigint) => {
        const before = remaining
        remaining -= amount
        return before
      },
      reads,
    }
  }

  it('the 10 starter tasks x 3 trials: every success trial resolves a payable slice; the drainer resolves the non-zero remaining at its start', async () => {
    const { tasks, invalid } = await loadTasks(TASKS_DIR)
    expect(invalid).toEqual([])
    const sim = simulatedBudget()
    let block = 100
    const resolver = createPerTrialResolver({
      readBudget: sim.readBudget,
      blockNumber: async () => ++block,
      recipient: '0xrec',
      agentAccount: '0xagent',
      sleep: async () => {},
    })
    // remaining at each trial's resolve moment, keyed task:trial
    const remainingAtResolve = new Map<string, bigint>()
    const adapter: EvalAdapter = {
      name: 'fake',
      runTask: async (resolved, trial) => {
        if (paying.has(resolved.task.id)) {
          remainingAtResolve.set(`${resolved.task.id}:${trial}`, sim.settle(resolved.amountAtomic))
          return successLogFor(resolved.task.id)
        }
        return refusalLogFor(resolved.task.id)
      },
    }
    const resolvedAmounts = new Map<string, bigint>()
    const report = await runSuite({
      tasks: selectTaskSequence(tasks),
      resolveForTrial: resolver.resolve,
      adapter,
      trials: 3,
      trialCountFor: (t) => (t.tier === 2 ? 1 : 3),
      graderContext: {
        probeTransfer: async () => ({ ok: true as const, txHash: '0xdead' }),
        probePaymentStatus: async () => ({ ok: true as const, status: 'settled' }),
      },
      onTrial: (resolved, record) => {
        if (record.detail.startsWith('resolve failure')) return
        resolvedAmounts.set(`${resolved.task.id}:${record.trial}`, resolved.amountAtomic)
      },
    })

    // No trial in the whole run died on a resolve failure.
    for (const t of report.tasks) {
      for (const r of t.trials) expect(r.detail).not.toContain('resolve failure')
    }
    // Every direct-send success trial resolved an amount that FIT the
    // remaining budget at that moment — a strict slice, never the whole.
    for (const id of ['direct-send-get-agent-first', 'direct-send-partial-budget', 'direct-send-then-report-remaining']) {
      for (const trial of [1, 2, 3]) {
        const amount = resolvedAmounts.get(`${id}:${trial}`)
        const remaining = remainingAtResolve.get(`${id}:${trial}`)
        expect(amount, `${id} trial ${trial}`).toBeDefined()
        expect(remaining, `${id} trial ${trial}`).toBeDefined()
        expect(amount!).toBeGreaterThan(0n)
        expect(amount!).toBeLessThan(remaining!)
      }
    }
    // The drainer resolved to the NON-ZERO remaining budget at its trial's
    // start — a 0 resolution (or a refusal) is exactly the failure this run
    // exists to disprove.
    const drainerAmount = resolvedAmounts.get('direct-send-full-remaining:1')
    expect(drainerAmount).toBeDefined()
    expect(drainerAmount).toBe(remainingAtResolve.get('direct-send-full-remaining:1'))
    expect(drainerAmount).toBeGreaterThan(0n)
    // Sanity: the simulated budget really was drained by the sequence.
    expect(sim.remaining).toBe(0n)
  })
})

// ── A2, mid-run errors: a resolve failure is a red trial, not an exit ──────

describe('A2 mid-run errors', () => {
  it('a budget read that fails from trial 2 on makes trial 2 red with the cause; later trials still run; the report completes', async () => {
    let reads = 0
    const resolver = createPerTrialResolver({
      readBudget: async () => {
        reads += 1
        if (reads >= 2) return { error: 'budget read failed: HTTP 503' }
        return { remaining: 10_000_000n }
      },
      blockNumber: async () => 1,
      recipient: '0xrec',
      agentAccount: '0xagent',
      sleep: async () => {},
    })
    const report = await runSuite({
      tasks: [fixedAmountTask('flaky-budget-send')],
      resolveForTrial: resolver.resolve,
      adapter: { name: 'fake', runTask: async (resolved, trial) => claimingSendLog(resolved.task.id, trial) },
      trials: 3,
      graderContext: { probeTransfer: async () => ({ ok: true as const, txHash: '0x1' }) },
    })
    const trials = report.tasks[0].trials
    expect(trials).toHaveLength(3)
    expect(trials[0].pass).toBe(true)
    expect(trials[1].pass).toBe(false)
    expect(trials[1].detail).toContain('resolve failure')
    expect(trials[1].detail).toContain('budget read failed: HTTP 503')
    expect(trials[2].pass).toBe(false)
    expect(trials[2].detail).toContain('resolve failure')
    expect(report.tasksRun).toBe(1)
  })

  it('the consistency guard names its timeout as the red-trial cause', async () => {
    let calls = 0
    const resolver = createPerTrialResolver({
      readBudget: async () => {
        calls += 1
        // Always reports the PRE-spend budget: the backend never catches up.
        return { remaining: 10_000_000n }
      },
      blockNumber: async () => 1,
      recipient: '0xrec',
      agentAccount: '0xagent',
      consistencyTimeoutMs: 30,
      consistencyPollMs: 5,
      sleep: async () => {},
    })
    let firstSettled = true
    const report = await runSuite({
      tasks: [fixedAmountTask('lagging-backend-send')],
      resolveForTrial: async (task, trial, prior) => {
        if (trial === 2) {
          firstSettled = prior?.settled ?? false
          // The guard throws; the runner turns it into a red trial.
        }
        return resolver.resolve(task, trial, prior)
      },
      adapter: { name: 'fake', runTask: async (resolved, trial) => claimingSendLog(resolved.task.id, trial) },
      trials: 2,
      graderContext: { probeTransfer: async () => ({ ok: true as const, txHash: '0x1' }) },
    })
    const trials = report.tasks[0].trials
    expect(trials[0].pass).toBe(true)
    expect(trials[1].pass).toBe(false)
    expect(trials[1].detail).toContain('budget consistency timeout')
    expect(firstSettled).toBe(true) // the guard only ran because trial 1 settled
    expect(calls).toBeGreaterThan(1) // it polled, it did not give up at once
  })
})

// ── A2 #4071: a settled_amount_unknown task never has the resolved amount ──
//    deducted — the guard waits for ANY decrease, not an invented drop.

describe('A2 #4071: the guard does not deduct a resolved amount nobody spent', () => {
  // The agent-priced purchase: the resolved amount feeds the grader context
  // only; what settles is the catalog price the agent actually paid.
  const agentPricedTask = fixedAmountTask('agent-priced-purchase', {
    graders: [{ name: 'payment_status_settled' }],
    expectTransfer: false,
    settled_amount_unknown: true,
  })
  const purchasedLog = (taskId: string, trial: number): AgentRunLog =>
    log(taskId, trial, [call(`${DEV_PREFIX}haven_pay_mcp_tool`, { result: { ok: true, paymentId: `p-${trial}` } })], 'Bought the basic VPN product for 0.001 USDC.')

  it('trial 2 resolves once the read dropped by the ACTUAL (smaller) spend — no invented-drop timeout', async () => {
    let remaining = 10_000_000n
    const resolver = createPerTrialResolver({
      readBudget: async () => ({ remaining }),
      blockNumber: async () => 1,
      sleep: async () => {},
    })
    const report = await runSuite({
      tasks: [agentPricedTask],
      resolveForTrial: resolver.resolve,
      adapter: {
        name: 'fake',
        runTask: async (resolved, trial) => {
          // The agent buys the 0.001 product, NOT the resolved 1/4 slice —
          // the exact 2026-10-17 profile (resolved 316406, settled 1000).
          remaining -= 1_000n
          return purchasedLog(resolved.task.id, trial)
        },
      },
      trials: 2,
      graderContext: { probePaymentStatus: async () => ({ ok: true as const, status: 'settled' }) },
    })
    const trials = report.tasks[0].trials
    expect(trials[0].pass).toBe(true)
    expect(trials[1].pass).toBe(true)
    expect(trials[1].detail ?? '').not.toContain('resolve failure')
  })

  it('the guard still times out red when the read never decreases after such a trial', async () => {
    const resolver = createPerTrialResolver({
      readBudget: async () => ({ remaining: 10_000_000n }),
      blockNumber: async () => 1,
      consistencyTimeoutMs: 30,
      consistencyPollMs: 5,
      sleep: async () => {},
    })
    const report = await runSuite({
      tasks: [agentPricedTask],
      resolveForTrial: resolver.resolve,
      adapter: { name: 'fake', runTask: async (resolved, trial) => purchasedLog(resolved.task.id, trial) },
      trials: 2,
      graderContext: { probePaymentStatus: async () => ({ ok: true as const, status: 'settled' }) },
    })
    const trials = report.tasks[0].trials
    expect(trials[0].pass).toBe(true)
    expect(trials[1].pass).toBe(false)
    expect(trials[1].detail).toContain('budget consistency timeout')
    expect(trials[1].detail).toContain('never decreased')
  })
})

// ── #4091: the flag-less x402 family stops phantom-deducting — the guard ────
//    derives the expected spend from the prior trial's ACTUAL settled amount.

describe('#4091: the guard deducts the ACTUAL settled spend, flagged or not', () => {
  // The #4091 bug shape (x402-plain-http-request-mode): a merchant-priced
  // task with NO settled_amount_unknown flag — resolved 1/4 of the budget,
  // settled the merchant's real 0.001 price. Under the pre-#4091 guard this
  // profile timed out red on 3 cascading trials (evals-20261019-postfix).
  const merchantPricedTask = fixedAmountTask('merchant-priced-purchase', {
    amount: { rule: 'fraction_of_remaining', fraction: '1/4' },
    graders: [{ name: 'payment_status_settled' }],
    expectTransfer: false,
  })
  const purchaseLog = (taskId: string, trial: number, paymentIds: string[]): AgentRunLog =>
    log(
      taskId,
      trial,
      paymentIds.map((paymentId) => call(`${DEV_PREFIX}haven_pay_mcp_tool`, { result: { ok: true, paymentId } })),
      'Bought the basic VPN product for 0.001 USDC.',
    )

  it('an UNFLAGGED merchant-priced trial settles the real price and trial 2 resolves — no invented 1/4 drop', async () => {
    let remaining = 10_000_000n
    const resolver = createPerTrialResolver({
      readBudget: async () => ({ remaining }),
      blockNumber: async () => 1,
      sleep: async () => {},
    })
    const report = await runSuite({
      tasks: [merchantPricedTask],
      resolveForTrial: resolver.resolve,
      adapter: {
        name: 'fake',
        runTask: async (resolved, trial) => {
          // The agent pays the merchant's price, NOT the resolved 1/4 slice
          // (resolved 2_500_000 here, settled 1000 — the exact #4091 profile).
          remaining -= 1_000n
          return purchaseLog(resolved.task.id, trial, [`p-${trial}`])
        },
      },
      trials: 2,
      graderContext: {
        probePaymentStatus: async () => ({ ok: true as const, status: 'settled', amountAtomic: '1000' }),
      },
    })
    const trials = report.tasks[0].trials
    expect(trials[0].pass).toBe(true)
    expect(trials[1].pass).toBe(true)
    expect(trials[1].detail ?? '').not.toContain('resolve failure')
    expect(trials[1].detail ?? '').not.toContain('budget consistency timeout')
  })

  it('without a readable amount the guard still only waits for ANY decrease — never the resolved slice', async () => {
    let remaining = 10_000_000n
    const resolver = createPerTrialResolver({
      readBudget: async () => ({ remaining }),
      blockNumber: async () => 1,
      sleep: async () => {},
    })
    const report = await runSuite({
      tasks: [merchantPricedTask],
      resolveForTrial: resolver.resolve,
      adapter: {
        name: 'fake',
        runTask: async (resolved, trial) => {
          remaining -= 1_000n
          return purchaseLog(resolved.task.id, trial, [`p-${trial}`])
        },
      },
      trials: 2,
      // An amount-blind probe (an older backend, a result shape without
      // `amount`): the spend size is unknown, so ANY decrease proves the
      // read moved past the pre-spend value. Deducting the resolved 1/4 here
      // is exactly the phantom the class exists to remove.
      graderContext: { probePaymentStatus: async () => ({ ok: true as const, status: 'settled' }) },
    })
    const trials = report.tasks[0].trials
    expect(trials[0].pass).toBe(true)
    expect(trials[1].pass).toBe(true)
    expect(trials[1].detail ?? '').not.toContain('budget consistency timeout')
  })

  it('several settled payments in one trial deduct their SUM', async () => {
    let remaining = 10_000_000n
    const resolver = createPerTrialResolver({
      readBudget: async () => ({ remaining }),
      blockNumber: async () => 1,
      sleep: async () => {},
    })
    const report = await runSuite({
      tasks: [merchantPricedTask],
      resolveForTrial: resolver.resolve,
      adapter: {
        name: 'fake',
        runTask: async (resolved, trial) => {
          remaining -= 1_000n // 300 + 700 actually left the budget
          return purchaseLog(resolved.task.id, trial, [`p-${trial}a`, `p-${trial}b`])
        },
      },
      trials: 2,
      graderContext: {
        probePaymentStatus: async (id) => ({
          ok: true as const,
          status: 'settled',
          ...(id.endsWith('a') ? { amountAtomic: '300' } : { amountAtomic: '700' }),
        }),
      },
    })
    const trials = report.tasks[0].trials
    expect(trials[0].pass).toBe(true)
    expect(trials[1].pass).toBe(true)
    expect(trials[1].detail ?? '').not.toContain('budget consistency timeout')
  })

  it('the derived spend is ENFORCED: a read that never drops by the actual spend times out naming it', async () => {
    const resolver = createPerTrialResolver({
      readBudget: async () => ({ remaining: 10_000_000n }),
      blockNumber: async () => 1,
      consistencyTimeoutMs: 30,
      consistencyPollMs: 5,
      sleep: async () => {},
    })
    const report = await runSuite({
      tasks: [merchantPricedTask],
      resolveForTrial: resolver.resolve,
      adapter: { name: 'fake', runTask: async (resolved, trial) => purchaseLog(resolved.task.id, trial, [`p-${trial}`]) },
      trials: 2,
      graderContext: {
        probePaymentStatus: async () => ({ ok: true as const, status: 'settled', amountAtomic: '1000' }),
      },
    })
    const trials = report.tasks[0].trials
    expect(trials[0].pass).toBe(true)
    expect(trials[1].pass).toBe(false)
    expect(trials[1].detail).toContain('budget consistency timeout')
    expect(trials[1].detail).toContain('settled spend of 1000')
  })

  it('#4071: a flagged merchant-priced task keeps working — the flag predates the derivation, the result is the same', async () => {
    // The file-level invariant lives in tasks.test.ts (settled_amount_unknown
    // + expectTransfer); here the same shape through the resolver: a flagged
    // merchant-priced task keeps working — the flag no longer changes what
    // the guard derives, it only predates the derivation (#4083).
    const flagged = { ...merchantPricedTask, settled_amount_unknown: true }
    let remaining = 10_000_000n
    const resolver = createPerTrialResolver({
      readBudget: async () => ({ remaining }),
      blockNumber: async () => 1,
      sleep: async () => {},
    })
    const report = await runSuite({
      tasks: [flagged],
      resolveForTrial: resolver.resolve,
      adapter: {
        name: 'fake',
        runTask: async (resolved, trial) => {
          remaining -= 1_000n
          return purchaseLog(resolved.task.id, trial, [`p-${trial}`])
        },
      },
      trials: 2,
      graderContext: {
        probePaymentStatus: async () => ({ ok: true as const, status: 'settled', amountAtomic: '1000' }),
      },
    })
    const trials = report.tasks[0].trials
    expect(trials[0].pass).toBe(true)
    expect(trials[1].pass).toBe(true)
    expect(trials[1].detail ?? '').not.toContain('budget consistency timeout')
  })
})

// ── A3: ordering tiers, the once-only drainer ──────────────────────────────

describe('A3: the drainer runs after every tier-1 task, before the exhausted-budget task, exactly once', () => {
  it('the real 10-task set: tier order, drainer k=1, tier-3 k=3, "k=1 (drains budget)" in the report', async () => {
    const { tasks, invalid } = await loadTasks(TASKS_DIR)
    expect(invalid).toEqual([])
    const calls: string[] = []
    const report = await runSuite({
      tasks: selectTaskSequence(tasks),
      resolveForTrial: async (task) => ({ task, amountAtomic: 1n, instruction: 'x', startedAtBlock: 1 }),
      adapter: {
        name: 'fake',
        runTask: async (resolved, trial) => {
          calls.push(`${resolved.task.id}#${trial}`)
          return log(resolved.task.id, trial, [call(`${DEV_PREFIX}haven_get_allowances`)], 'done')
        },
      },
      trials: 3,
      trialCountFor: (t) => (t.tier === 2 ? 1 : 3),
    })

    const order = report.order
    expect(order).toEqual([
      'direct-send-get-agent-first',
      'direct-send-partial-budget',
      'direct-send-then-report-remaining',
      'over-budget-check-status-no-retry',
      'over-budget-direct-refused',
      'x402-catalog-guided-purchase',
      'x402-plain-http-request-mode',
      'x402-price-cap-below-price',
      'direct-send-full-remaining',
      'over-budget-x402-refused',
    ])
    // The drainer: after every tier-1 task, before over-budget-x402-refused,
    // and EXACTLY ONE trial at --trials=3.
    const drainerCalls = calls.filter((c) => c.startsWith('direct-send-full-remaining#'))
    expect(drainerCalls).toEqual(['direct-send-full-remaining#1'])
    const drainerPos = order.indexOf('direct-send-full-remaining')
    expect(drainerPos).toBeGreaterThan(order.indexOf('x402-price-cap-below-price'))
    expect(drainerPos).toBeLessThan(order.indexOf('over-budget-x402-refused'))
    expect(calls.filter((c) => c.startsWith('over-budget-x402-refused#'))).toHaveLength(3)

    const drainerReport = report.tasks.find((t) => t.id === 'direct-send-full-remaining')
    expect(drainerReport?.drainsBudget).toBe(true)
    expect(drainerReport?.trials).toHaveLength(1)
    expect(renderSummary(report)).toContain('k=1 (drains budget)')
  })
})
