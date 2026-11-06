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
      for (const g of t.graders) expect(g.name).toMatch(/^(transfer_settled|payment_status_settled|haven_payment_submitted|no_payment_retry_after_refusal|agent_status_before_payment|x402_request_mode_replay|tool_called|merchant_settlement_recorded|eip3009_settlement_shape|nothing_stranded_on_delegate|resume_without_repayment|declined_before_paying|no_second_fresh_payment|onboarding_discovery|onboarding_first_reply|onboarding_tool_calls|onboarding_login_command|client_out_of_date|receipt_verified_offline|task_budget_lifecycle)$/)
    }
  })

  it('the 5-task subset (the workflow\'s --limit=5) is the same five tasks after #4676 added two', async () => {
    // agent-evals.yml's subset takes the first five tasks of the canonical
    // order; a new task whose file sorts among them would silently swap one
    // out (epic #4674 § Bar).
    const { tasks } = await loadTasks(TASKS_DIR)
    expect(selectTaskSequence(tasks, { limit: 5 }).map((t) => t.id)).toEqual([
      'direct-send-get-agent-first',
      'direct-send-partial-budget',
      'direct-send-then-report-remaining',
      'over-budget-check-status-no-retry',
      'over-budget-direct-refused',
    ])
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
  // An over-budget base that carries both graders with options.
  const base = {
    id: 'test-task',
    title: 'T',
    category: 'over-budget',
    instruction: 'Pay {amount} to {recipient}.',
    requires: [],
    amount: { rule: 'remaining_period_budget', delta_atomic: '1000000' },
    graders: [
      { name: 'no_payment_retry_after_refusal', options: { mustMention: ['budget'], acceptPreemptive: true } },
      { name: 'tool_called', options: { name: 'haven_get_allowances' } },
    ],
    expectTransfer: false,
    source: { kind: 'scenario', ref: 'x.ts', note: 'n' },
  }
  const withGraders = (graders: unknown[]) => ({ ...structuredClone(base), graders })
  const refusalGrader = (options: Record<string, unknown>) => withGraders([{ name: 'no_payment_retry_after_refusal', options }])

  it('accepts the well-formed base', () => {
    expect(validateTask(structuredClone(base), 'x.json')).toBeNull()
  })

  it.each(Object.keys(GRADER_OPTION_KEYS) as GraderName[])('rejects an unknown option key on %s', (name) => {
    const options: Record<string, unknown> = { misspeltKey: true }
    if (name === 'tool_called') options.name = 'haven_get_allowances'
    const t = withGraders([{ name, options }])
    expect(validateTask(t, 'x.json')).toContain('unknown option key(s) "misspeltKey"')
  })

  it('rejects the misspellings that would each silently drop a check: mustMention, probePaymentTools, acceptPreemptive', () => {
    expect(validateTask(refusalGrader({ mustMentions: ['budget'] }), 'x.json')).toContain('"mustMentions"')
    expect(validateTask(refusalGrader({ probePaymentTool: true }), 'x.json')).toContain('"probePaymentTool"')
    expect(validateTask(refusalGrader({ acceptPremptive: true }), 'x.json')).toContain('"acceptPremptive"')
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
    ['no_payment_retry_after_refusal', 'acceptPreemptive', true],
    ['no_payment_retry_after_refusal', 'preemptiveReadTools', ['haven_quote_x402']],
    ['tool_called', 'name', 'haven_get_allowances'],
    ['tool_called', 'after', 'haven_submit'],
    ['resume_without_repayment', 'mustMention', ['resumed']],
    ['declined_before_paying', 'preemptiveReadTools', ['haven_quote_x402']],
    ['declined_before_paying', 'mustMention', ['0.001']],
    ['no_second_fresh_payment', 'mustMention', ['settle']],
    // #4680: the cold-agent onboarding graders.
    ['onboarding_discovery', 'hooks', ['/llms.txt']],
    ['onboarding_discovery', 'target', '/for-agents.md'],
    ['onboarding_discovery', 'threshold', 3],
    ['onboarding_first_reply', 'steps', ['signup_and_passkey', 'fund', 'approve_budget']],
    ['onboarding_first_reply', 'threshold', 3],
    ['onboarding_tool_calls', 'max', 12],
    ['onboarding_login_command', 'package', '@haven_ai/cli@dev'],
    ['onboarding_login_command', 'threshold', 1],
    ['client_out_of_date', 'releasesPath', '/releases'],
    ['client_out_of_date', 'manifestPath', '/.well-known/haven.json'],
    ['client_out_of_date', 'startPath', '/for-agents.md'],
    ['client_out_of_date', 'mustMention', ['@haven_ai/connect', '--doctor']],
    ['receipt_verified_offline', 'mustMention', ['offline']],
    ['receipt_verified_offline', 'forbidMention', ['tampered']],
    ['task_budget_lifecycle', 'mustMention', ['closed']],
  ]

  it.each(WELL_TYPED)('accepts %s option %s with a well-typed value', (grader, key, value) => {
    // declined_before_paying requires preemptiveReadTools, so its other key is
    // checked alongside it.
    const options: Record<string, unknown> =
      grader === 'tool_called' ? { name: 'haven_get_allowances' } : grader === 'declined_before_paying' ? { preemptiveReadTools: ['haven_quote_x402'] } : {}
    options[key] = value
    expect(validateTask(withGraders([{ name: grader, options }]), 'x.json')).toBeNull()
  })

  it('the well-typed table covers exactly the keys GRADER_OPTION_KEYS lists', () => {
    const listed = Object.entries(GRADER_OPTION_KEYS).flatMap(([g, keys]) => keys.map((k) => `${g}.${k}`))
    expect(WELL_TYPED.map(([g, k]) => `${g}.${k}`).sort()).toEqual(listed.sort())
  })

  it.each(['probePaymentTools', 'acceptPreemptive'])('rejects a non-boolean %s — "true" would silently not apply the option', (key) => {
    for (const value of ['true', 1, null]) {
      expect(validateTask(refusalGrader({ [key]: value }), 'x.json')).toContain(`options.${key} must be a boolean`)
    }
  })

  it('rejects a preemptiveReadTools that is not a non-empty array of known tool names', () => {
    for (const value of ['haven_quote_x402', [], ['haven_quote_x40'], [1], null]) {
      expect(validateTask(refusalGrader({ acceptPreemptive: true, preemptiveReadTools: value }), 'x.json'))
        .toContain('options.preemptiveReadTools must be a non-empty array of known bare tool names')
    }
  })

  it('rejects a mustMention that is not a non-empty array of non-empty strings', () => {
    for (const value of ['budget', [1], [''], null, []]) {
      expect(validateTask(withGraders([{ name: 'no_payment_retry_after_refusal', options: { mustMention: value } }]), 'x.json'))
        .toContain('options.mustMention must be a non-empty array of non-empty strings')
    }
  })

  it.each([
    ['no_payment_retry_after_refusal', 'errorCode'],
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
      requires: ['EXHAUSTED-period-budget-below-0.001-USDC'],
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

describe('the per-trial payment id (#4678) — the resolve path leaves the placeholder for the setup', () => {
  const interrupted = (overrides: Partial<EvalTask> = {}): EvalTask =>
    ({
      id: 'interrupted-purchase-resume',
      title: 'Resume a prepared payment',
      category: 'interrupted-purchase',
      instruction: 'A payment was already prepared: payment_id {payment_id}. Resume it.',
      requires: ['THROWAWAY-identity'],
      graders: [{ name: 'resume_without_repayment' }],
      expectTransfer: false,
      source: { kind: 'scenario', ref: 'x', note: 'n' },
      lanes: ['claude-code'],
      setup: {
        kind: 'throwaway-identity',
        label: 'interrupted-purchase',
        budgetAtomic: '2000',
        fundingAtomic: '2000',
        prepare: 'interrupted-purchase',
      },
      ...overrides,
    }) as EvalTask

  it('resolveTask KEEPS {payment_id} — the payment does not exist yet, so the setup renders it', async () => {
    const r = await resolveTask(interrupted(), { budget: async () => ({ remaining: 0n }), recipient: '0xabc' })
    expect('resolved' in r).toBe(true)
    if (!('resolved' in r)) return
    // The regression: this used to read "(no payment was prepared)", which
    // made the setup's replaceAll a no-op and handed the agent no id at all.
    expect(r.resolved.instruction).toContain('payment_id {payment_id}')
    expect(r.resolved.instruction).not.toContain('no payment was prepared')
  })

  it('renderInstruction renders the id when the caller HAS one', () => {
    expect(renderInstruction(interrupted(), 2000n, '0xabc', undefined, 'pay-1')).toContain('payment_id pay-1')
  })

  it('refuses a task that renders {payment_id} without an interrupted-purchase setup', () => {
    const noSetup = interrupted({ setup: undefined, amount: { rule: 'remaining_period_budget', delta_atomic: '0' } })
    expect(validateTask(noSetup, 'x.json')).toContain('renders {payment_id} but setup.prepare is not "interrupted-purchase"')
    const wrongPrepare = interrupted({
      setup: { kind: 'throwaway-identity', label: 'ended', budgetAtomic: '2000', fundingAtomic: '2000', prepare: 'ended-budget' },
      category: 'budget-ended',
      commandTemplate: 'claude -p {instruction}',
    })
    expect(validateTask(wrongPrepare, 'x.json')).toContain('renders {payment_id}')
  })

  it('the real interrupted-purchase task file passes that rule', async () => {
    const { tasks, invalid } = await loadTasks(TASKS_DIR)
    expect(invalid).toEqual([])
    const task = tasks.find((t) => t.id === 'interrupted-purchase-resume')!
    expect(task.instruction).toContain('{payment_id}')
    expect(task.setup?.prepare).toBe('interrupted-purchase')
  })
})

describe('the tiered run order (#3992 A3)', () => {
  const mk = (id: string, tier: number | undefined, amount: EvalTask['amount'], category: EvalTask['category'] = 'direct-payment') =>
    ({ id, title: id, category, instruction: 'x', requires: [], tier, amount, graders: [], expectTransfer: true, source: { kind: 'issue', ref: '1', note: 'n' } }) as EvalTask

  it('tier 1 in file order, the drainer in tier 2, exhausted-budget tasks in tier 3', async () => {
    const { tasks } = await loadTasks(TASKS_DIR)
    const ordered = orderTasksForSequence(tasks)
    expect(ordered.map((t) => t.id)).toEqual([
      'agent-revoked-no-retry',
      'budget-ended-no-retry',
      'direct-send-get-agent-first',
      'direct-send-partial-budget',
      'direct-send-then-report-remaining',
      'interrupted-purchase-resume',
      'onboarding-client-out-of-date',
      'onboarding-cold-setup',
      'over-budget-check-status-no-retry',
      'over-budget-direct-refused',
      'receipt-verify-direct-payment',
      'task-budget-lifecycle',
      'x402-catalog-guided-purchase',
      'x402-eip3009-bridge-vpn-legacy',
      'x402-plain-http-request-mode',
      'x402-price-cap-below-price',
      'x402-price-mismatch-invoice',
      'x402-unsettled-purchase-no-double-pay',
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

  // #4218: the --task filter selects from the CANONICAL set, so a filtered
  // selection keeps the tier order, shuffles within tiers, and runs a
  // repeated id once.
  it('#4218: taskIds filter the canonical set — tier order kept, duplicates run once', () => {
    const filtered = selectTaskSequence(tasks, { taskIds: ['exhausted', 't1-b', 'drainer', 't1-b'] })
    expect(filtered.map((t) => t.id)).toEqual(['t1-b', 'drainer', 'exhausted'])
  })

  it('#4218: a filtered selection still shuffles WITHIN tiers only', () => {
    const filtered = selectTaskSequence(tasks, { taskIds: ['exhausted', 't1-b', 't1-a', 'drainer'], shuffleSeed: 7 })
    expect(filtered.map((t) => t.tier ?? 1)).toEqual([...filtered.map((t) => t.tier ?? 1)].sort((a, b) => a - b))
    expect([...filtered].sort((a, b) => a.id.localeCompare(b.id)).map((t) => t.id)).toEqual(['drainer', 'exhausted', 't1-a', 't1-b'])
    expect(filtered[filtered.length - 1].id).toBe('exhausted')
  })

  it('#4218: the real set — over-budget-x402-refused alone selects exactly it, with no drainer', async () => {
    const { tasks } = await loadTasks(TASKS_DIR)
    expect(selectTaskSequence(tasks, { taskIds: ['over-budget-x402-refused'] }).map((t) => t.id)).toEqual(['over-budget-x402-refused'])
    expect(selectTaskSequence(tasks, { taskIds: ['over-budget-x402-refused'] }).some((t) => t.tier === 2)).toBe(false)
  })

  // #4678 AC #1: "the `subset` keeps the same five tasks". The three new
  // throwaway tasks sort FIRST alphabetically, so a plain slice would have
  // swapped two shared-agent tasks for two that provision real testnet
  // identities and spend USDC on every subset run.
  it('#4678: the real --limit=5 subset is the SAME five shared-agent tasks as before', async () => {
    const { tasks } = await loadTasks(TASKS_DIR)
    const subset = selectTaskSequence(tasks, { limit: 5 })
    expect(subset.map((t) => t.id)).toEqual([
      'direct-send-get-agent-first',
      'direct-send-partial-budget',
      'direct-send-then-report-remaining',
      'over-budget-check-status-no-retry',
      'over-budget-direct-refused',
    ])
    // No task with a per-trial setup can enter the slice implicitly.
    expect(subset.every((t) => t.setup === undefined)).toBe(true)
    // ...and the slice is still shuffle-stable.
    const shuffled = selectTaskSequence(tasks, { limit: 5, shuffleSeed: 99 })
    expect([...shuffled].sort((a, b) => a.id.localeCompare(b.id)).map((t) => t.id)).toEqual([...subset].sort((a, b) => a.id.localeCompare(b.id)).map((t) => t.id))
  })

  it('#4678: a setup task still runs when it is NAMED, and in a full (unlimited) run', async () => {
    const { tasks } = await loadTasks(TASKS_DIR)
    expect(selectTaskSequence(tasks, { taskIds: ['interrupted-purchase-resume'] }).map((t) => t.id)).toEqual(['interrupted-purchase-resume'])
    expect(selectTaskSequence(tasks).some((t) => t.setup !== undefined)).toBe(true)
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

  it('the real task dir: exactly the five x402 URL tasks use {target}, and the loader validates them', async () => {
    const { tasks, invalid } = await loadTasks(TASKS_DIR)
    expect(invalid).toEqual([])
    expect(tasks.filter((t) => t.instruction.includes('{target}')).map((t) => t.id).sort()).toEqual([
      'x402-eip3009-bridge-vpn-legacy',
      'x402-plain-http-request-mode',
      'x402-price-cap-below-price',
      'x402-price-mismatch-invoice',
      'x402-unsettled-purchase-no-double-pay',
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

describe('tier-3 EXHAUSTED label must parse', () => {
  it('rejects a tier-3 task whose EXHAUSTED label the resolver cannot read', async () => {
    const { validateTask } = await import('./tasks.js')
    const base = JSON.parse(JSON.stringify((await (await import('./tasks.js')).loadTasks()).tasks.find((t) => t.tier === 3)))
    base.requires = ['EXHAUSTED-period-budget-below-0.001USDC']
    expect(validateTask(base, 'x.json')).toMatch(/must read EXHAUSTED-period-budget-below-<X>-USDC/)
  })
})

describe('{purchase_key} renders a fresh key per trial', () => {
  it('two renders of the bridge task carry different idempotency keys', async () => {
    const { loadTasks, renderInstruction } = await import('./tasks.js')
    const task = (await loadTasks()).tasks.find((t) => t.id === 'x402-eip3009-bridge-vpn-legacy')!
    const a = renderInstruction(task, 1n, undefined, 'https://m.example/mcp')
    const b = renderInstruction(task, 1n, undefined, 'https://m.example/mcp')
    const key = (s: string) => /idempotency_key "([^"]+)"/.exec(s)?.[1]
    expect(key(a)).toMatch(/^eval-x402-eip3009-bridge-vpn-legacy-/)
    expect(key(a)).not.toBe(key(b))
    expect(a).not.toContain('{purchase_key}')
  })
})

describe('validateTask — #4676 rules', () => {
  const base = {
    id: 'test-task',
    title: 'T',
    category: 'x402-paywall',
    instruction: 'Pay {target}.',
    requires: [],
    amount: { rule: 'fraction_of_remaining', fraction: '1/4' },
    graders: [{ name: 'declined_before_paying', options: { preemptiveReadTools: ['haven_quote_x402'] } }],
    expectTransfer: false,
    source: { kind: 'issue', ref: '4676', note: 'n' },
  }

  it('declined_before_paying is valid with preemptiveReadTools and refused without them', () => {
    expect(validateTask(structuredClone(base), 'x.json')).toBeNull()
    expect(validateTask({ ...structuredClone(base), graders: [{ name: 'declined_before_paying' }] }, 'x.json')).toContain('preemptiveReadTools')
    expect(validateTask({ ...structuredClone(base), graders: [{ name: 'declined_before_paying', options: { mustMention: ['x'] } }] }, 'x.json')).toContain('preemptiveReadTools')
  })

  it('refuses two spend reporters on one task (the guard would deduct one purchase twice)', () => {
    const t = { ...structuredClone(base), graders: [{ name: 'payment_status_settled' }, { name: 'no_second_fresh_payment', options: {} }] }
    expect(validateTask(t, 'x.json')).toContain('deduct one purchase twice')
    expect(validateTask({ ...structuredClone(base), graders: [{ name: 'no_second_fresh_payment', options: {} }] }, 'x.json')).toBeNull()
  })
})

describe('the cold-agent onboarding tasks (#4680)', () => {
  it('the cold setup prompt names NO path — the score measures the product, not the prompt', async () => {
    const { tasks } = await loadTasks(TASKS_DIR)
    const task = tasks.find((t) => t.id === 'onboarding-cold-setup')!
    expect(task).toBeDefined()
    // The landing URL is a placeholder the workflow fills; every path the
    // scenario exists to measure must be absent from the prompt.
    for (const path of ['/for-agents.md', '/llms.txt', '/robots.txt', '/sitemap.xml', '/.well-known', '/releases', '/device', '/signup', '/login']) {
      expect(task.instruction).not.toContain(path)
    }
    expect(task.instruction).toContain('{landing_url}')
  })

  it('both onboarding tasks are cold-profile, Claude-lane only, and spend nothing', async () => {
    const { tasks } = await loadTasks(TASKS_DIR)
    const onboarding = tasks.filter((t) => t.category === 'onboarding')
    expect(onboarding.map((t) => t.id).sort()).toEqual(['onboarding-client-out-of-date', 'onboarding-cold-setup'])
    for (const t of onboarding) {
      expect(t.profile).toBe('cold')
      expect(t.lanes).toEqual(['claude-code'])
      expect(t.amount).toBeUndefined()
      expect(t.expectTransfer).toBe(false)
    }
  })

  it('the tier pins still hold: the onboarding tasks are tier 1 and the subset keeps the same five', async () => {
    const { tasks } = await loadTasks(TASKS_DIR)
    expect(tasks.filter((t) => t.tier === 2).map((t) => t.id)).toEqual(['direct-send-full-remaining'])
    expect(tasks.filter((t) => t.tier === 3).map((t) => t.id)).toEqual(['over-budget-x402-refused'])
    expect(tasks.filter((t) => (t.tier ?? 1) === 1)).toHaveLength(tasks.length - 2)
    // A cold-profile task is excluded from the --limit slice, like a setup
    // task: it provisions its own HOME and spends a model session, so letting
    // one into the slice would change which five tasks the subset is.
    expect(selectTaskSequence(tasks, { limit: 5 }).map((t) => t.id)).toEqual([
      'direct-send-get-agent-first',
      'direct-send-partial-budget',
      'direct-send-then-report-remaining',
      'over-budget-check-status-no-retry',
      'over-budget-direct-refused',
    ])
  })

  it('an onboarding task resolves WITHOUT a budget read and renders the landing URL', async () => {
    const { tasks } = await loadTasks(TASKS_DIR)
    const task = tasks.find((t) => t.id === 'onboarding-cold-setup')!
    let read = false
    const r = await resolveTask(task, {
      budget: async () => {
        read = true
        return { remaining: 1n }
      },
      coldProfile: { landingUrl: 'https://dev.example', cliPackage: '@haven_ai/cli@dev' },
    })
    expect(read).toBe(false)
    expect('resolved' in r).toBe(true)
    if ('resolved' in r) {
      expect(r.resolved.amountAtomic).toBe(0n)
      expect(r.resolved.instruction).toContain('https://dev.example')
      expect(r.resolved.instruction).not.toContain('{landing_url}')
      expect(r.resolved.coldProfile?.cliPackage).toBe('@haven_ai/cli@dev')
    }
  })

  it('an onboarding task with no cold profile is an error, not a guessed URL', async () => {
    const { tasks } = await loadTasks(TASKS_DIR)
    const task = tasks.find((t) => t.id === 'onboarding-cold-setup')!
    const r = await resolveTask(task, { budget: async () => ({ remaining: 1n }) })
    expect('error' in r).toBe(true)
  })

  it('taskNeedsEvalBudgetFunds is false for an onboarding task', async () => {
    const { taskNeedsEvalBudgetFunds } = await import('./tasks.js')
    expect(taskNeedsEvalBudgetFunds({ tier: 1, setup: undefined, category: 'onboarding' })).toBe(false)
    expect(taskNeedsEvalBudgetFunds({ tier: 1, setup: undefined, category: 'direct-payment' })).toBe(true)
  })
})

describe('validateTask — the cold profile (#4680)', () => {
  const base = {
    id: 'cold-task',
    title: 'T',
    category: 'onboarding',
    instruction: 'Start here: {landing_url}',
    requires: [],
    graders: [{ name: 'onboarding_discovery', options: { hooks: ['/llms.txt'], target: '/for-agents.md', threshold: 3 } }],
    expectTransfer: false,
    source: { kind: 'issue', ref: '4680', note: 'n' },
    lanes: ['claude-code'],
    profile: 'cold',
    commandTemplate: 'claude -p {instruction} --mcp-config "$QA_EVAL_TRIAL_MCP_CONFIG"',
  }

  it('accepts the well-formed cold task', () => {
    expect(validateTask(structuredClone(base), 'x.json')).toBeNull()
  })

  it('refuses a cold task with no commandTemplate, which would run warm on the lane command (#4696)', () => {
    const { commandTemplate: _dropped, ...noTemplate } = structuredClone(base)
    expect(validateTask(noTemplate, 'x.json')).toContain('must carry a commandTemplate')
  })

  it('the real onboarding tasks resolve with their own command, not the lane command (#4696)', async () => {
    const { tasks } = await loadTasks(TASKS_DIR)
    const cold = tasks.filter((t) => t.profile === 'cold')
    expect(cold.map((t) => t.id).sort()).toEqual(['onboarding-client-out-of-date', 'onboarding-cold-setup'])
    for (const t of cold) {
      const r = await resolveTask(t, {
        budget: async () => ({ remaining: 0n }),
        recipient: '0x000000000000000000000000000000000000dEaD',
        agentAccount: '0x0000000000000000000000000000000000000001',
        startedAtBlock: 1,
        coldProfile: { landingUrl: 'https://dev.example', cliPackage: '@haven_ai/cli@dev' },
      })
      if ('error' in r) throw new Error(r.error)
      expect(r.resolved.commandTemplate).toBe(t.commandTemplate)
      expect(r.resolved.commandTemplate).toContain('$QA_EVAL_TRIAL_MCP_CONFIG')
      expect(r.resolved.commandTemplate).toContain('--allowedTools mcp__eval-command WebFetch')
    }
  })

  it('refuses an unknown profile', () => {
    expect(validateTask({ ...structuredClone(base), profile: 'warm' }, 'x.json')).toContain('profile must be "cold"')
  })

  it('refuses a cold task that does not render {landing_url}', () => {
    expect(validateTask({ ...structuredClone(base), instruction: 'Set it all up.' }, 'x.json')).toContain('{landing_url}')
  })

  it('refuses a cold task on any lane but claude-code', () => {
    expect(validateTask({ ...structuredClone(base), lanes: ['hermes'] }, 'x.json')).toContain('lanes ["claude-code"]')
    expect(validateTask({ ...structuredClone(base), lanes: undefined }, 'x.json')).toContain('lanes ["claude-code"]')
  })

  it('refuses an onboarding task with an amount rule it would never use', () => {
    // An amount is not forbidden, but the loader must not require one.
    const { amount, ...noAmount } = { ...structuredClone(base), amount: { rule: 'remaining_period_budget', delta_atomic: '0' } }
    expect(validateTask(noAmount, 'x.json')).toBeNull()
    expect(validateTask({ ...structuredClone(base), amount }, 'x.json')).toBeNull()
  })

  it('learns the eval-only tool name in grader options', () => {
    const t = {
      ...structuredClone(base),
      graders: [{ name: 'tool_called', options: { name: 'run_command' } }],
    }
    expect(validateTask(t, 'x.json')).toBeNull()
    const bad = { ...structuredClone(base), graders: [{ name: 'tool_called', options: { name: 'not_a_tool' } }] }
    expect(validateTask(bad, 'x.json')).toContain('known bare tool name')
  })

  it('refuses a wrongly typed scoring option', () => {
    const t = { ...structuredClone(base), graders: [{ name: 'onboarding_discovery', options: { threshold: '3' } }] }
    expect(validateTask(t, 'x.json')).toContain('threshold must be a non-negative integer')
  })
})

// ── #4677: the task-budget category and the two new tasks ──────────────────

describe('validateTask — the task-budget category (#4677)', () => {
  const base = {
    id: 'tb-task',
    title: 'T',
    category: 'task-budget',
    instruction: 'Open a task budget with a cap of {amount} USDC.',
    requires: ['THROWAWAY-identity'],
    amount: { rule: 'fraction_of_remaining', fraction: '1/2' },
    graders: [{ name: 'task_budget_lifecycle', options: { mustMention: ['closed'] } }],
    expectTransfer: false,
    source: { kind: 'issue', ref: '4677', note: 'n' },
    setup: { kind: 'throwaway-identity', label: 'task-budget', budgetAtomic: '2000', fundingAtomic: '0' },
    commandTemplate: 'claude -p {instruction} --mcp-config "$QA_EVAL_TRIAL_MCP_CONFIG"',
  }

  it('accepts the well-formed task-budget task', () => {
    expect(validateTask(structuredClone(base), 'x.json')).toBeNull()
  })

  it('refuses a setup task with no commandTemplate, which would run as the shared eval agent (#4696)', () => {
    const { commandTemplate: _dropped, ...noTemplate } = structuredClone(base)
    expect(validateTask(noTemplate, 'x.json')).toContain('must carry a commandTemplate')
  })

  it('requires an amount rule even though the task carries a setup — the cap is a slice, never the whole grant', () => {
    const noAmount = structuredClone(base) as Record<string, unknown>
    delete noAmount.amount
    expect(validateTask(noAmount, 'x.json')).toContain('must carry an amount rule')
  })

  it('refuses remaining_period_budget: the cap must be a fraction of the remaining budget', () => {
    const whole = { ...structuredClone(base), amount: { rule: 'remaining_period_budget', delta_atomic: '0' } }
    expect(validateTask(whole, 'x.json')).toContain('fraction_of_remaining')
  })

  it('refuses a forbidMention that is not an array of non-empty strings', () => {
    const bad = { ...structuredClone(base), graders: [{ name: 'receipt_verified_offline', options: { forbidMention: 'tampered' } }] }
    expect(validateTask(bad, 'x.json')).toContain('forbidMention')
  })
})

describe('the two #4677 task files (read from disk)', () => {
  it('both load, and the task-budget task resolves its cap from the throwaway grant', async () => {
    const { tasks, invalid } = await loadTasks(TASKS_DIR)
    expect(invalid).toEqual([])
    const receipt = tasks.find((t) => t.id === 'receipt-verify-direct-payment')
    const budget = tasks.find((t) => t.id === 'task-budget-lifecycle')
    expect(receipt).toBeDefined()
    expect(budget).toBeDefined()
    expect(receipt?.category).toBe('direct-payment')
    expect(budget?.category).toBe('task-budget')
    // The cap is a slice of the throwaway agent's own grant (2000 × 1/2).
    const resolved = await resolveTask(budget!, { budget: async () => ({ remaining: 0n }) })
    expect('resolved' in resolved && resolved.resolved.amountAtomic).toBe(1000n)
    expect('resolved' in resolved && resolved.resolved.instruction).toContain('0.001')
  })

  it('the task-budget task pins a short ttl_minutes as the backstop for a failed trial', async () => {
    const { tasks } = await loadTasks(TASKS_DIR)
    const budget = tasks.find((t) => t.id === 'task-budget-lifecycle')!
    const ttl = /ttl_minutes of (\d+)/.exec(budget.instruction)?.[1]
    expect(ttl).toBeDefined()
    // Short enough that a budget a failed trial left open releases the
    // parent's remainder on its own; long enough that the trial's own
    // open→close lifecycle finishes before it expires.
    expect(Number(ttl)).toBeGreaterThanOrEqual(5)
    expect(Number(ttl)).toBeLessThanOrEqual(30)
  })

  it('the receipt task requires settlement evidence before the receipt fetch', async () => {
    const { tasks } = await loadTasks(TASKS_DIR)
    const receipt = tasks.find((t) => t.id === 'receipt-verify-direct-payment')!
    expect(receipt.instruction).toContain('haven_get_payment_status')
    expect(receipt.instruction).toContain('haven_get_receipt')
    expect(receipt.instruction).toContain('haven_verify_receipt')
    expect(receipt.instruction).toContain('DIRECT')
  })

  it('neither new task enters the --limit=5 subset', async () => {
    const { tasks } = await loadTasks(TASKS_DIR)
    const subset = selectTaskSequence(tasks, { limit: 5 }).map((t) => t.id)
    expect(subset).not.toContain('receipt-verify-direct-payment')
    expect(subset).not.toContain('task-budget-lifecycle')
  })
})
