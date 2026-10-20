/**
 * Task-file + loader tests (#3958 AC 2: at least 10 task files, each citing
 * its source). These read the REAL task directory — a broken starter task
 * fails the suite here, not on the partner's machine.
 *
 * The suite's production sequencing (per-trial resolution over a simulated
 * budget) is driven in `cli.test.ts` — these tests own the task FILES: the
 * loader, the coherence rules (incl. the #3992 tier field), and the
 * selection pipeline (tiered order, limit-before-shuffle).
 */

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  anyTaskUsesTarget,
  loadTasks,
  orderTasksForSequence,
  renderInstruction,
  resolveTask,
  seededShuffle,
  selectTaskSequence,
  shuffleWithinTiers,
  validateTask,
} from './tasks.js'
import { GRADER_OPTION_KEYS } from './graders.js'
import { HOSTED_TOOLS, SIGNER_TOOLS } from './tools.js'
import type { EvalTask, GraderName } from './types.js'

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

  it('the tier field is present on the real set: exactly one drainer (tier 2) and one exhausted-budget task (tier 3)', async () => {
    const { tasks } = await loadTasks(TASKS_DIR)
    expect(tasks.filter((t) => t.tier === 2).map((t) => t.id)).toEqual(['direct-send-full-remaining'])
    expect(tasks.filter((t) => t.tier === 3).map((t) => t.id)).toEqual(['over-budget-x402-refused'])
    expect(tasks.filter((t) => (t.tier ?? 1) === 1)).toHaveLength(tasks.length - 2)
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

  // #4071: the settled spend is the agent's own purchase — the amount must be
  // honest about not being the spend, and a transfer probe would contradict it.
  it('rejects settled_amount_unknown=true with expectTransfer — transfer_settled probes an amount that is not the spend', () => {
    const t = { ...structuredClone(base), settled_amount_unknown: true }
    expect(validateTask(t, 'x.json')).toContain('settled_amount_unknown=true with expectTransfer')
  })

  it('rejects a non-boolean settled_amount_unknown', () => {
    const t = { ...structuredClone(base), graders: [{ name: 'payment_status_settled' }], expectTransfer: false, settled_amount_unknown: 'yes' }
    expect(validateTask(t, 'x.json')).toContain('settled_amount_unknown must be boolean')
  })

  it('accepts a payment_status_settled task with settled_amount_unknown=true', () => {
    const t = { ...structuredClone(base), graders: [{ name: 'payment_status_settled' }], expectTransfer: false, settled_amount_unknown: true }
    expect(validateTask(t, 'x.json')).toBeNull()
  })
})

describe('validateTask — grader options are closed (#4136)', () => {
  // An over-budget base that carries both graders the option rules touch.
  const base = {
    id: 'test-task',
    title: 'T',
    category: 'over-budget',
    instruction: 'Pay {amount} to {recipient}.',
    requires: [],
    amount: { rule: 'remaining_period_budget', delta_atomic: '1000000' },
    graders: [
      { name: 'no_payment_retry_after_refusal', options: { mustMention: ['budget'] } },
      { name: 'tool_called', options: { name: 'haven_get_allowances', afterRefusal: 'delegation_budget_exceeded' } },
    ],
    expectTransfer: false,
    source: { kind: 'scenario', ref: 'x.ts', note: 'n' },
  }
  const withGraders = (graders: unknown[]) => ({ ...structuredClone(base), graders })

  it('accepts the well-formed base (afterRefusal agreeing with the default errorCode)', () => {
    expect(validateTask(structuredClone(base), 'x.json')).toBeNull()
  })

  it.each(Object.keys(GRADER_OPTION_KEYS) as GraderName[])('rejects an unknown option key on %s', (name) => {
    const options: Record<string, unknown> = { misspeltKey: true }
    if (name === 'tool_called') options.name = 'haven_get_allowances'
    const t = withGraders([{ name, options }])
    expect(validateTask(t, 'x.json')).toContain('unknown option key(s) "misspeltKey"')
  })

  it('rejects the misspellings that would each be a false pass: mustMention, probePaymentTools, afterRefusal', () => {
    expect(validateTask(withGraders([{ name: 'no_payment_retry_after_refusal', options: { mustMentions: ['budget'] } }]), 'x.json'))
      .toContain('"mustMentions"')
    expect(validateTask(withGraders([{ name: 'no_payment_retry_after_refusal', options: { probePaymentTool: true } }]), 'x.json'))
      .toContain('"probePaymentTool"')
    expect(validateTask(withGraders([{ name: 'tool_called', options: { name: 'haven_get_allowances', afterRefusel: 'delegation_budget_exceeded' } }]), 'x.json'))
      .toContain('"afterRefusel"')
  })

  it('rejects after together with afterRefusal', () => {
    const t = withGraders([
      base.graders[0],
      { name: 'tool_called', options: { name: 'haven_get_allowances', after: 'haven_pay', afterRefusal: 'delegation_budget_exceeded' } },
    ])
    expect(validateTask(t, 'x.json')).toContain('after OR afterRefusal, not both')
  })

  it("rejects an afterRefusal that differs from the task's no_payment_retry_after_refusal errorCode (explicit and default)", () => {
    const explicit = withGraders([
      { name: 'no_payment_retry_after_refusal', options: { errorCode: 'PRICE_EXCEEDS_MAX' } },
      base.graders[1],
    ])
    expect(validateTask(explicit, 'x.json')).toContain('differs from no_payment_retry_after_refusal')
    const byDefault = withGraders([
      base.graders[0],
      { name: 'tool_called', options: { name: 'haven_get_allowances', afterRefusal: 'PRICE_EXCEEDS_MAX' } },
    ])
    expect(validateTask(byDefault, 'x.json')).toContain('"delegation_budget_exceeded"')
    // The comparison is canonical, as the graders' own refusal match is.
    const sameCodeOtherSpelling = withGraders([
      { name: 'no_payment_retry_after_refusal', options: { errorCode: 'PRICE_EXCEEDS_MAX' } },
      { name: 'tool_called', options: { name: 'haven_get_allowances', afterRefusal: 'price_exceeds_max' } },
    ])
    expect(validateTask(sameCodeOtherSpelling, 'x.json')).toBeNull()
  })

  it('rejects a grader named after an Object.prototype key ("constructor"), with and without options', () => {
    expect(validateTask(withGraders([{ name: 'constructor' }]), 'x.json')).toContain('unknown grader "constructor"')
    expect(validateTask(withGraders([{ name: 'constructor', options: { name: 'haven_pay' } }]), 'x.json')).toContain('unknown grader "constructor"')
  })

  // Every key GRADER_OPTION_KEYS lists, with a well-typed value. Hard-coded
  // on purpose: a key dropped from the table turns its row red, and the
  // coverage test below makes a key added to the table bring its own row.
  const WELL_TYPED: Array<[GraderName, string, unknown]> = [
    ['no_payment_retry_after_refusal', 'errorCode', 'delegation_budget_exceeded'],
    ['no_payment_retry_after_refusal', 'mustMention', ['budget']],
    ['no_payment_retry_after_refusal', 'probePaymentTools', true],
    ['tool_called', 'name', 'haven_get_allowances'],
    ['tool_called', 'after', 'haven_submit'],
    ['tool_called', 'afterRefusal', 'delegation_budget_exceeded'],
  ]

  it.each(WELL_TYPED)('accepts %s option %s with a well-typed value', (grader, key, value) => {
    const options: Record<string, unknown> = grader === 'tool_called' ? { name: 'haven_get_allowances' } : {}
    options[key] = value
    expect(validateTask(withGraders([{ name: grader, options }]), 'x.json')).toBeNull()
  })

  it('the well-typed table covers exactly the keys GRADER_OPTION_KEYS lists', () => {
    const listed = Object.entries(GRADER_OPTION_KEYS).flatMap(([g, keys]) => keys.map((k) => `${g}.${k}`))
    expect(WELL_TYPED.map(([g, k]) => `${g}.${k}`).sort()).toEqual(listed.sort())
  })

  it('rejects a non-boolean probePaymentTools — "true" would silently disable the signer check', () => {
    for (const value of ['true', 1, null]) {
      expect(validateTask(withGraders([{ name: 'no_payment_retry_after_refusal', options: { probePaymentTools: value } }]), 'x.json'))
        .toContain('options.probePaymentTools must be a boolean')
    }
  })

  it('rejects a mustMention that is not an array of non-empty strings', () => {
    for (const value of ['budget', [1], [''], null]) {
      expect(validateTask(withGraders([{ name: 'no_payment_retry_after_refusal', options: { mustMention: value } }]), 'x.json'))
        .toContain('options.mustMention must be an array of non-empty strings')
    }
  })

  it.each([
    ['no_payment_retry_after_refusal', 'errorCode'],
    ['tool_called', 'afterRefusal'],
    ['tool_called', 'name'],
    ['tool_called', 'after'],
  ] as Array<[GraderName, string]>)('rejects %s option %s that is not a non-empty string', (grader, key) => {
    for (const value of ['', 1, null]) {
      const options: Record<string, unknown> = grader === 'tool_called' && key !== 'name' ? { name: 'haven_get_allowances' } : {}
      options[key] = value
      expect(validateTask(withGraders([{ name: grader, options }]), 'x.json')).toContain(`options.${key} must be a non-empty string`)
    }
  })

  it('rejects an unknown tool name in name or after', () => {
    expect(validateTask(withGraders([base.graders[0], { name: 'tool_called', options: { name: 'haven_get_allowance' } }]), 'x.json'))
      .toContain('options.name must be a known bare tool name')
    expect(validateTask(withGraders([base.graders[0], { name: 'tool_called', options: { name: 'haven_get_allowances', after: 'haven_pay_x402' } }]), 'x.json'))
      .toContain('options.after must be a known bare tool name')
  })
})

describe('validateTask — the ordering tier (#3992 A3: membership comes from the task file)', () => {
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

  it('accepts an explicit tier 1', () => {
    expect(validateTask({ ...structuredClone(base), tier: 1 }, 'x.json')).toBeNull()
  })

  it('rejects an out-of-range tier', () => {
    expect(validateTask({ ...structuredClone(base), tier: 4 }, 'x.json')).toContain('tier must be 1')
    expect(validateTask({ ...structuredClone(base), tier: 'two' }, 'x.json')).toContain('tier must be 1')
  })

  it('tier 2 must BE the drainer shape: a direct payment of the entire remaining budget', () => {
    expect(validateTask({ ...structuredClone(base), tier: 2 }, 'x.json')).toBeNull()
    const slice = { ...structuredClone(base), tier: 2, amount: { rule: 'fraction_of_remaining', fraction: '1/4' } }
    expect(validateTask(slice, 'x.json')).toContain('tier 2 is the budget drainer')
    const overBudget = {
      ...structuredClone(base),
      tier: 2,
      category: 'over-budget',
      graders: [{ name: 'no_payment_retry_after_refusal' }],
      expectTransfer: false,
      amount: { rule: 'remaining_period_budget', delta_atomic: '1000000' },
    }
    expect(validateTask(overBudget, 'x.json')).toContain('tier 2 is the budget drainer')
  })

  it('tier 3 must declare an EXHAUSTED-budget precondition in requires', () => {
    const exhausted = {
      ...structuredClone(base),
      tier: 3,
      category: 'over-budget',
      instruction: 'Buy the product. If refused, tell me why.',
      requires: ['EXHAUSTED-period-budget-below-0.001-USDC'],
      graders: [{ name: 'no_payment_retry_after_refusal' }],
      expectTransfer: false,
    }
    expect(validateTask(exhausted, 'x.json')).toBeNull()
    const noPrecondition = { ...exhausted, requires: ['demo-merchant-catalog'] }
    expect(validateTask(noPrecondition, 'x.json')).toContain('EXHAUSTED')
  })

  it('tier 3 cannot also expect a transfer', () => {
    const t = {
      ...structuredClone(base),
      tier: 3,
      requires: ['EXHAUSTED-period-budget'],
    }
    expect(validateTask(t, 'x.json')).toContain('cannot also expect a transfer')
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

describe('the hosted and signer tool lists', () => {
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

  it('the § 4 resolver property: successive slices of a SHRINKING budget stay payable and never take the whole', async () => {
    // The resolver-level property the production sequencing exercises (the
    // full production path is driven in cli.test.ts): resolve the same task
    // the way the per-trial resolver does — one live read per trial, each
    // settled transfer deducted from the next read — and no trial collapses
    // to a refusal.
    let remaining = 10_000_000n // 10 USDC of period budget for the whole night
    for (let trial = 1; trial <= 3; trial++) {
      const r = await resolveTask(task, { budget: async () => ({ remaining }) })
      expect('resolved' in r).toBe(true)
      if (!('resolved' in r)) continue
      expect(r.resolved.amountAtomic).toBeGreaterThan(0n) // payable, not a guaranteed refusal
      expect(r.resolved.amountAtomic).toBeLessThan(remaining) // a slice, never the whole remaining budget
      remaining -= r.resolved.amountAtomic // the transfer landed; the next read sees less
    }
    // And the budget did NOT hit zero after the success legs.
    expect(remaining).toBeGreaterThan(0n)
  })
})

describe('the tiered run order (#3992 A3)', () => {
  const mk = (id: string, tier: number | undefined, amount: EvalTask['amount'], category: EvalTask['category'] = 'direct-payment') =>
    ({ id, title: id, category, instruction: 'x', requires: [], tier, amount, graders: [], expectTransfer: true, source: { kind: 'issue', ref: '1', note: 'n' } }) as EvalTask

  it('tier 1 in file order, the drainer in tier 2, exhausted-budget tasks in tier 3', async () => {
    const { tasks } = await loadTasks(TASKS_DIR)
    const ordered = orderTasksForSequence(tasks)
    expect(ordered.map((t) => t.id)).toEqual([
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
  })

  it('is stable for same-tier tasks and defaults missing tiers to 1', () => {
    const ordered = orderTasksForSequence([
      mk('b', 1, { rule: 'remaining_period_budget', delta_atomic: '0' }),
      mk('c', undefined, { rule: 'fraction_of_remaining', fraction: '1/4' }),
      mk('a', 1, { rule: 'remaining_period_budget', delta_atomic: '1000000' }),
      mk('d', 3, { rule: 'remaining_period_budget', delta_atomic: '0' }, 'over-budget'),
    ])
    expect(ordered.map((t) => t.id)).toEqual(['b', 'c', 'a', 'd'])
  })
})

describe('selectTaskSequence — tier order, limit BEFORE shuffle, shuffle within tiers (#3992 B)', () => {
  const mk = (id: string, tier: number): EvalTask =>
    ({ id, title: id, category: 'direct-payment', instruction: 'x', requires: [], tier, amount: { rule: 'remaining_period_budget', delta_atomic: '0' }, graders: [], expectTransfer: true, source: { kind: 'issue', ref: '1', note: 'n' } }) as EvalTask

  const tasks = [mk('t1-a', 1), mk('t1-b', 1), mk('t1-c', 1), mk('t1-d', 1), mk('t1-e', 1), mk('t1-f', 1), mk('drainer', 2), mk('exhausted', 3)]

  it('no shuffle: the canonical tiered order', () => {
    expect(selectTaskSequence(tasks).map((t) => t.id)).toEqual(['t1-a', 't1-b', 't1-c', 't1-d', 't1-e', 't1-f', 'drainer', 'exhausted'])
  })

  it('the same seed gives the same order, and the tiers are preserved', () => {
    const once = selectTaskSequence(tasks, { shuffleSeed: 1234 })
    const twice = selectTaskSequence(tasks, { shuffleSeed: 1234 })
    expect(once.map((t) => t.id)).toEqual(twice.map((t) => t.id))
    expect(once.map((t) => t.tier)).toEqual([...once.map((t) => t.tier ?? 1)].sort((a, b) => a - b))
    expect([...once].sort((a, b) => a.id.localeCompare(b.id)).map((t) => t.id)).toEqual([...tasks].sort((a, b) => a.id.localeCompare(b.id)).map((t) => t.id))
  })

  it('the --limit subset is chosen from the canonical order BEFORE any shuffle — the 5-task slice is shuffle-stable', () => {
    const plain = selectTaskSequence(tasks, { limit: 5 })
    const shuffled = selectTaskSequence(tasks, { limit: 5, shuffleSeed: 99 })
    expect(plain.map((t) => t.id)).toEqual(['t1-a', 't1-b', 't1-c', 't1-d', 't1-e'])
    expect([...shuffled].sort((a, b) => a.id.localeCompare(b.id)).map((t) => t.id)).toEqual(['t1-a', 't1-b', 't1-c', 't1-d', 't1-e'])
  })

  it('seededShuffle is a permutation and is deterministic', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8]
    expect([...seededShuffle(items, 7)].sort((a, b) => a - b)).toEqual(items)
    expect(seededShuffle(items, 7)).toEqual(seededShuffle(items, 7))
    expect(seededShuffle(items, 8)).not.toEqual(seededShuffle(items, 9))
  })

  it('shuffleWithinTiers never moves a task across its tier boundary', () => {
    const shuffled = shuffleWithinTiers(tasks, 31337)
    expect(shuffled.filter((t) => t.tier === 1).map((t) => t.id)).toEqual(shuffled.filter((t) => t.tier === 1).map((t) => t.id))
    const tiers = shuffled.map((t) => t.tier ?? 1)
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b))
    expect(shuffled[shuffled.length - 1].id).toBe('exhausted')
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

// {target} is the demo merchant's MCP endpoint, which answers 405 to a GET by
// design and 402 only to a POSTed JSON-RPC tools/call. "Fetch {target}" failed
// every trial of the first full run (2026-10-20); the plain-HTTP x402 tasks
// must spell out the request.
describe('plain-HTTP x402 tasks spell out the POST request', () => {
  it.each(['x402-plain-http-request-mode', 'x402-price-cap-below-price'])('%s names method, headers and the tools/call body', async (id) => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const task = JSON.parse(readFileSync(fileURLToPath(new URL(`./tasks/${id}.json`, import.meta.url)), 'utf8')) as { instruction: string }
    expect(task.instruction).toContain('POST {target}')
    expect(task.instruction).toContain('Content-Type: application/json')
    expect(task.instruction).toContain('Accept: application/json, text/event-stream')
    const body = task.instruction.match(/(\{"jsonrpc".*?\}\}\})/)?.[1]
    expect(body, 'the JSON-RPC body is present and parses').toBeDefined()
    expect(JSON.parse(body!)).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'buy_vpn', arguments: { plan: 'basic' } } })
  })
})
