/**
 * Task-file + loader tests (#3958 AC 2: at least 10 task files, each citing
 * its source). These read the REAL task directory — a broken starter task
 * fails the suite here, not on the partner's machine.
 */

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { anyTaskUsesTarget, loadTasks, orderTasksForSequence, renderInstruction, resolveTask, validateTask } from './tasks.js'
import { HOSTED_TOOLS, SIGNER_TOOLS } from './tools.js'
import type { EvalTask } from './types.js'

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

  it('renders {target} when the x402 target is configured', () => {
    const t = { instruction: 'Buy the paid resource at {target}.', amount: { rule: 'remaining_period_budget' as const, delta_atomic: '0' } } as never
    expect(renderInstruction(t as never, 0n, '0xabc', 'https://demo.example')).toBe('Buy the paid resource at https://demo.example.')
  })

  it('leaves {target} visibly unconfigured when the env is missing — never silently empty', () => {
    const t = { instruction: 'Buy the paid resource at {target}.', amount: { rule: 'remaining_period_budget' as const, delta_atomic: '0' } } as never
    expect(renderInstruction(t as never, 0n)).toContain('(x402 target not configured)')
  })
})

describe('validateTask — the fraction_of_remaining amount rule', () => {
  const base = {
    id: 'test-task',
    title: 'T',
    category: 'direct-payment',
    instruction: 'Pay {amount} to {recipient}.',
    requires: [],
    amount: { rule: 'fraction_of_remaining', fraction: '1/4' },
    graders: [{ name: 'transfer_settled' }],
    expectTransfer: true,
    source: { kind: 'scenario', ref: 'x.ts', note: 'n' },
  }

  it('accepts a strict fraction', () => {
    expect(validateTask(structuredClone(base), 'x.json')).toBeNull()
  })

  it('rejects fraction "1/1" — the whole budget is remaining_period_budget with delta 0', () => {
    const t = { ...structuredClone(base), amount: { rule: 'fraction_of_remaining', fraction: '1/1' } }
    expect(validateTask(t, 'x.json')).toContain('STRICT fraction')
  })

  it('rejects fraction "0/4" — a 0 amount is unpayable', () => {
    const t = { ...structuredClone(base), amount: { rule: 'fraction_of_remaining', fraction: '0/4' } }
    expect(validateTask(t, 'x.json')).toContain('non-zero')
  })

  it('rejects a malformed fraction', () => {
    const t = { ...structuredClone(base), amount: { rule: 'fraction_of_remaining', fraction: 'quarter' } }
    expect(validateTask(t, 'x.json')).toContain('"N/D"')
  })

  it('rejects an over-budget task with a fraction — a slice can never go over', () => {
    const t = { ...structuredClone(base), category: 'over-budget', graders: [{ name: 'no_payment_retry_after_refusal' }], expectTransfer: false }
    expect(validateTask(t, 'x.json')).toContain('can never go OVER')
  })
})

describe('resolveTask — fraction_of_remaining slices the live remaining budget', () => {
  const task = {
    id: 'test-task',
    title: 'T',
    category: 'direct-payment' as const,
    instruction: 'Pay {amount} USDC to {recipient}.',
    requires: [],
    amount: { rule: 'fraction_of_remaining' as const, fraction: '1/4' },
    graders: [],
    expectTransfer: false,
    source: { kind: 'scenario' as const, ref: 'x', note: 'n' },
  }

  it('resolves floor(remaining × fraction) — bigint math, no float', async () => {
    const r = await resolveTask(task, { budget: async () => ({ remaining: 10_000_001n }), recipient: '0xabc' })
    expect('resolved' in r).toBe(true)
    if ('resolved' in r) {
      expect(r.resolved.amountAtomic).toBe(2_500_000n) // 10.000001 × 1/4 floored
      expect(r.resolved.instruction).toContain('2.5 USDC')
    }
  })

  it('the § 4 sequence property: every success task still resolves a PAYABLE amount after the earlier transfers', async () => {
    // 30 nightly sessions share ONE period budget — resolve the suite the way
    // the CLI does (one live read per task, each transfer deducted from the
    // next read) and assert no later success task collapses to a refusal.
    const slice1 = { ...task } as typeof task
    const slice2 = { ...task, id: 'slice-2' }
    const slice3 = { ...task, id: 'slice-3' }
    let remaining = 10_000_000n // 10 USDC of period budget for the whole night
    for (const t of [slice1, slice2, slice3]) {
      const r = await resolveTask(t, { budget: async () => ({ remaining }) })
      expect('resolved' in r).toBe(true)
      if (!('resolved' in r)) continue
      expect(r.resolved.amountAtomic).toBeGreaterThan(0n) // payable, not a guaranteed refusal
      expect(r.resolved.amountAtomic).toBeLessThan(remaining) // a slice, never the whole remaining budget
      remaining -= r.resolved.amountAtomic // the transfer landed; the next read sees less
    }
    // And the budget did NOT hit zero after the success legs.
    expect(remaining).toBeGreaterThan(0n)
  })

  it('orderTasksForSequence runs the full-remaining drainer LAST — the real 10-task set is payable in one invocation', async () => {
    const { tasks } = await loadTasks(TASKS_DIR)
    const ordered = orderTasksForSequence(tasks)
    expect(ordered[ordered.length - 1]!.id).toBe('direct-send-full-remaining')
    // Simulate the CLI: one live read per task, every transfer deducted.
    let remaining = 10_000_000n
    for (const t of ordered) {
      if (t.category === 'over-budget') continue // over-budget legs refuse by design; skip the deduction
      const r = await resolveTask(t, { budget: async () => ({ remaining }) })
      expect('resolved' in r).toBe(true)
      if (!('resolved' in r)) continue
      if (t.id === 'direct-send-full-remaining') {
        expect(r.resolved.amountAtomic).toBe(remaining) // the drainer, on purpose
      } else {
        expect(r.resolved.amountAtomic).toBeGreaterThan(0n) // every earlier task still payable
      }
      remaining -= r.resolved.amountAtomic
    }
  })

  it('orderTasksForSequence is stable for tasks that do not drain', () => {
    const mk = (id: string, amount: EvalTask['amount']) =>
      ({ id, title: id, category: 'direct-payment', instruction: 'x', requires: [], amount, graders: [], expectTransfer: true, source: { kind: 'issue', ref: '1', note: 'n' } }) as EvalTask
    const ordered = orderTasksForSequence([
      mk('a-fraction', { rule: 'fraction_of_remaining', fraction: '1/4' }),
      mk('b-drainer', { rule: 'remaining_period_budget', delta_atomic: '0' }),
      mk('c-over', { rule: 'remaining_period_budget', delta_atomic: '1000000' }),
    ])
    expect(ordered.map((t) => t.id)).toEqual(['a-fraction', 'c-over', 'b-drainer'])
  })
})

describe('anyTaskUsesTarget — the single-invocation target config (#3958 AC: one 10×3 run)', () => {
  it('is true when any task instruction renders {target} (the two x402 URL tasks)', () => {
    const tasks = [
      { instruction: 'Pay {amount} to {recipient}.' },
      { instruction: 'Buy the paid resource at {target}.' },
    ] as never[]
    expect(anyTaskUsesTarget(tasks)).toBe(true)
  })

  it('is false for an address-only suite', () => {
    const tasks = [
      { instruction: 'Pay {amount} to {recipient}.' },
      { instruction: 'Pay your entire remaining budget to {recipient}.' },
    ] as never[]
    expect(anyTaskUsesTarget(tasks)).toBe(false)
  })

  it('the real task dir: exactly the two x402 URL tasks use {target}, and the loader validates them', async () => {
    const { tasks, invalid } = await loadTasks(TASKS_DIR)
    expect(invalid).toEqual([])
    expect(tasks.filter((t) => t.instruction.includes('{target}')).map((t) => t.id).sort()).toEqual([
      'x402-plain-http-request-mode',
      'x402-price-cap-below-price',
    ])
    // And the direct sends still render {recipient} — the two placeholder kinds
    // cannot be one env var.
    expect(tasks.filter((t) => t.instruction.includes('{recipient}')).length).toBeGreaterThanOrEqual(4)
  })

  it('resolveTask renders the x402 target into the instruction', async () => {
    const task = {
      id: 'x402-test',
      title: 'T',
      category: 'x402-paywall' as const,
      instruction: 'Buy the paid resource at {target}.',
      requires: [],
      amount: { rule: 'remaining_period_budget' as const, delta_atomic: '0' },
      graders: [],
      expectTransfer: false,
      source: { kind: 'issue' as const, ref: '3958', note: 'n' },
    }
    const r = await resolveTask(task, {
      budget: async () => ({ remaining: 5_000_000n }),
      x402Target: 'https://demo-merchant.example',
    })
    expect('resolved' in r).toBe(true)
    if ('resolved' in r) expect(r.resolved.instruction).toContain('https://demo-merchant.example')
  })
})
