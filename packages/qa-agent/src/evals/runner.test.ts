/**
 * Runner tests: k trials, pass rate, pass^k, wall time, and the rule that an
 * adapter failure is a RED TRIAL, not a crash — a nightly run must finish
 * and report.
 */

import { describe, expect, it } from 'vitest'
import { medianMs, renderSummary, runSuite, type EvalAdapter } from './runner.js'
import type { AgentRunLog, EvalTask, ResolvedTask } from './types.js'

const TASK: EvalTask = {
  id: 'runner-test',
  title: 'Runner test task',
  category: 'direct-payment',
  instruction: 'x',
  requires: [],
  amount: { rule: 'remaining_period_budget', delta_atomic: '0' },
  graders: [{ name: 'agent_status_before_payment' }],
  expectTransfer: false,
  source: { kind: 'issue', ref: '3958', note: 'test' },
}

function resolved(): ResolvedTask {
  return { task: TASK, amountAtomic: 1n, instruction: 'x' }
}

function logWith(calls: AgentRunLog['calls']): AgentRunLog {
  return { taskId: TASK.id, trial: 1, calls }
}

const fakeAdapter = (name: string, behavior: (trial: number) => Promise<AgentRunLog>): EvalAdapter => ({
  name,
  runTask: (_t, trial) => behavior(trial),
})

describe('runSuite', () => {
  it('collects pass rate, pass^k and per-trial wall time', async () => {
    let n = 0
    const report = await runSuite({
      resolved: [resolved()],
      adapter: fakeAdapter('fake', async () => {
        n += 1
        return logWith(n === 1 ? [{ name: 'haven_get_agent' }, { name: 'haven_pay' }] : [{ name: 'haven_pay' }])
      }),
      trials: 2,
    })
    expect(report.trialsPerTask).toBe(2)
    const task = report.tasks[0]
    expect(task.passRate).toBe(0.5)
    expect(task.passAll).toBe(false)
    expect(task.trials[0].pass).toBe(true)
    expect(task.trials[1].pass).toBe(false)
    expect(task.trials[1].detail).toContain('no haven_get_agent')
    expect(task.slowestSessionMs).toBeGreaterThanOrEqual(0)
  })

  it('pass^k holds only when EVERY trial passed', async () => {
    const report = await runSuite({
      resolved: [resolved()],
      adapter: fakeAdapter('fake', async () => logWith([{ name: 'haven_get_agent' }, { name: 'haven_pay' }])),
      trials: 3,
    })
    expect(report.tasks[0].passAll).toBe(true)
    expect(report.tasksPassingAll).toBe(1)
  })

  it('an adapter failure is a red trial with the cause, not an exception', async () => {
    const report = await runSuite({
      resolved: [resolved()],
      adapter: fakeAdapter('fake', async () => {
        throw new Error('hermes exited 137')
      }),
      trials: 2,
    })
    const t = report.tasks[0]
    expect(t.passAll).toBe(false)
    expect(t.trials.every((r) => !r.pass)).toBe(true)
    expect(t.trials[0].detail).toContain('adapter failure')
    expect(t.trials[0].detail).toContain('hermes exited 137')
  })
})

describe('renderSummary', () => {
  it('names pass^k, the slowest session and each failing trial', async () => {
    const report = await runSuite({
      resolved: [resolved()],
      adapter: fakeAdapter('fake', async () => logWith([{ name: 'haven_pay' }])),
      trials: 1,
    })
    const summary = renderSummary(report)
    expect(summary).toContain('fail')
    expect(summary).toContain('runner-test')
    expect(summary).toContain('no haven_get_agent')
    expect(summary).toContain('issue: 3958')
  })
})

describe('medianMs', () => {
  it('is the middle value for odd counts and the mean of the middle two for even', () => {
    expect(medianMs([])).toBe(0)
    expect(medianMs([5])).toBe(5)
    expect(medianMs([30, 10, 20])).toBe(20)
    expect(medianMs([10, 20, 30, 40])).toBe(25)
    expect(medianMs([40, 10])).toBe(25)
  })
})
