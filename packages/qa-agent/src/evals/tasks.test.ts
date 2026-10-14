/**
 * Task-file + loader tests (#3958 AC 2: at least 10 task files, each citing
 * its source). These read the REAL task directory — a broken starter task
 * fails the suite here, not on the partner's machine.
 */

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTasks, renderInstruction, resolveTask, validateTask } from './tasks.js'
import { HOSTED_TOOLS, SIGNER_TOOLS } from './tools.js'

const TASKS_DIR = join(fileURLToPath(import.meta.url), '..', 'tasks')

describe('the starter task set (read from disk)', () => {
  it('loads at least 10 valid task files — AC 2', async () => {
    const { tasks, invalid } = await loadTasks(TASKS_DIR)
    expect(invalid).toEqual([])
    expect(tasks.length).toBeGreaterThanOrEqual(10)
  })

  it('every task cites a concrete source with a note', async () => {
    const { tasks } = await loadTasks(TASKS_DIR)
    for (const t of tasks) {
      expect(t.source.ref.trim().length).toBeGreaterThan(0)
      expect(t.source.note.trim().length).toBeGreaterThan(0)
      if (t.source.kind === 'bug-report') expect(t.source.ref).toMatch(/^docs\/bug-reports\//)
      if (t.source.kind === 'scenario') expect(t.source.ref).toMatch(/^packages\/qa-agent\/src\/scenarios\//)
    }
  })

  it('covers all three required categories', async () => {
    const { tasks } = await loadTasks(TASKS_DIR)
    const categories = new Set(tasks.map((t) => t.category))
    expect(categories).toContain('direct-payment')
    expect(categories).toContain('x402-paywall')
    expect(categories).toContain('over-budget')
  })

  it('every referenced grader exists in the closed registry', async () => {
    const { tasks } = await loadTasks(TASKS_DIR)
    for (const t of tasks) {
      for (const g of t.graders) expect(g.name).toMatch(/^(transfer_settled|payment_status_settled|no_payment_retry_after_refusal|agent_status_before_payment|x402_request_mode_replay|tool_called)$/)
    }
  })
})

describe('validateTask — the coherence rules', () => {
  const base = {
    id: 'test-task',
    title: 'T',
    category: 'direct-payment',
    instruction: 'Pay {amount} to {recipient}.',
    requires: [],
    amount: { rule: 'remaining_period_budget', delta_atomic: '0' },
    graders: [{ name: 'transfer_settled' }],
    expectTransfer: true,
    source: { kind: 'scenario', ref: 'x.ts', note: 'n' },
  }

  it('accepts the well-formed base', () => {
    expect(validateTask(structuredClone(base), 'x.json')).toBeNull()
  })

  it('rejects an unknown grader name', () => {
    const t = { ...structuredClone(base), graders: [{ name: 'vibes' }] }
    expect(validateTask(t, 'x.json')).toContain('unknown grader')
  })

  it('rejects a missing source citation', () => {
    const { source, ...rest } = structuredClone(base)
    expect(validateTask(rest, 'x.json')).toContain('source')
  })

  it('rejects a non-remaining_period_budget amount rule', () => {
    const t = { ...structuredClone(base), amount: { rule: 'fixed', delta_atomic: '5' } }
    expect(validateTask(t, 'x.json')).toContain('remaining_period_budget')
  })

  it('rejects expectTransfer without a transfer grader — the transfer would never be proven', () => {
    const t = { ...structuredClone(base), graders: [{ name: 'agent_status_before_payment' }] }
    expect(validateTask(t, 'x.json')).toContain('transfer would never be proven')
  })

  it('rejects an over-budget task that renders {amount} but never goes over', () => {
    const t = { ...structuredClone(base), category: 'over-budget', graders: [{ name: 'no_payment_retry_after_refusal' }], expectTransfer: false }
    expect(validateTask(t, 'x.json')).toContain('OVER the live remaining budget')
  })

  it('accepts an over-budget x402 task whose refusal is setup-driven (no {amount})', () => {
    const t = {
      ...structuredClone(base),
      category: 'over-budget',
      instruction: 'Buy the product. If refused, tell me why.',
      graders: [{ name: 'no_payment_retry_after_refusal' }],
      expectTransfer: false,
    }
    expect(validateTask(t, 'x.json')).toBeNull()
  })
})

describe('resolveTask — amounts are budget-aware (#3958 § 4)', () => {
  const task = {
    id: 'test-task',
    title: 'T',
    category: 'over-budget' as const,
    instruction: 'Pay {amount} USDC to {recipient}.',
    requires: [],
    amount: { rule: 'remaining_period_budget' as const, delta_atomic: '1000000' },
    graders: [],
    expectTransfer: false,
    source: { kind: 'scenario' as const, ref: 'x', note: 'n' },
  }

  it('adds the delta to a LIVE remaining budget and renders the human amount', async () => {
    const r = await resolveTask(task, {
      budget: async () => ({ remaining: 2_500_000n }),
      recipient: '0xabc',
    })
    expect('resolved' in r).toBe(true)
    if ('resolved' in r) {
      expect(r.resolved.amountAtomic).toBe(3_500_000n)
      expect(r.resolved.instruction).toContain('3.5 USDC')
      expect(r.resolved.instruction).toContain('0xabc')
    }
  })

  it('refuses to guess when the budget read fails — no fallback amount', async () => {
    const r = await resolveTask(task, { budget: async () => ({ error: 'HTTP 503' }) })
    expect(r).toEqual({ error: expect.stringContaining('budget read failed') })
  })
})

describe('the tool lists the loader re-checks', () => {
  it('hosted + signer names never overlap', () => {
    for (const h of HOSTED_TOOLS) expect(SIGNER_TOOLS).not.toContain(h)
  })
})

describe('renderInstruction', () => {
  it('leaves unknown placeholders alone', () => {
    const t = { instruction: 'Buy {thing} for {amount}.', amount: { rule: 'remaining_period_budget' as const, delta_atomic: '0' } } as never
    expect(renderInstruction(t as never, 1_000_000n)).toBe('Buy {thing} for 1.')
  })
})
