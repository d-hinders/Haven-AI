/**
 * Loading + resolving eval tasks (#3958).
 *
 * A task file is JSON — never Markdown (#3958's obligation list) — one file
 * per task under `src/evals/tasks/`. Loading validates the file against the
 * `EvalTask` shape AND its own internal coherence (graders exist in the
 * registry and carry only the option keys they read, over-budget tasks
 * actually go over, transfer-expecting tasks name a transfer grader): a
 * task file that parses but means nothing would otherwise pass silently and
 * fail only on the partner's machine, three hours into a nightly run.
 *
 * Resolution is the budget-aware half (#3958 § 4, re-scoped per-trial by
 * #3992 A2): the amount comes from a LIVE read of the remaining period
 * budget — now taken immediately BEFORE EACH TRIAL by the CLI's injected
 * resolver, not once at launch, so every trial resolves and is graded
 * against the budget state of its own moment. Success tasks take a SLICE of
 * the remaining budget (`fraction_of_remaining`, floored) — 30 nightly
 * sessions share ONE period budget, so a success task that spends the whole
 * remaining budget turns every later success task into a refusal.
 * Full-remaining (`delta_atomic: 0`) and over-budget (`remaining + delta`)
 * tasks use `remaining_period_budget`. The read is injected; a caller that
 * cannot read the budget gets an ERROR, not a guessed amount — same refusal
 * as `lib/delegation-budget.ts`'s fallback discipline.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GRADER_OPTION_KEYS, GRADERS } from './graders.js'
import { ALL_TOOL_NAMES, HOSTED_TOOLS, PAYMENT_TOOLS, SIGNER_TOOLS } from './tools.js'
import type { EvalTask, GraderName, ResolvedTask } from './types.js'

const TASKS_DIR = join(fileURLToPath(import.meta.url), '..', 'tasks')

/** The live budget source the resolver needs: atomic remaining, or a reason. */
export type BudgetSource = () => Promise<{ remaining: bigint } | { error: string }>

export interface LoadTasksResult {
  tasks: EvalTask[]
  /** Files that failed validation, with the reason. */
  invalid: Array<{ file: string; error: string }>
}

/**
 * A fraction is `"N/D"` — positive BigInt-safe integers, N < D. A STRICT
 * fraction on purpose: `N >= D` is the full-remaining send, and that is
 * `remaining_period_budget` with `delta_atomic: "0"`'s job, not a
 * masquerading slice that leaves later success tasks nothing.
 */
function validateFraction(fraction: unknown, file: string): string | null {
  if (typeof fraction !== 'string' || !/^\d+\/[1-9]\d*$/.test(fraction)) {
    return `${file}: amount.fraction must be "N/D" — positive integers as a string (bigint-safe JSON, e.g. "1/4")`
  }
  const [num, den] = fraction.split('/').map((s) => BigInt(s))
  if (num === 0n) return `${file}: amount.fraction must be non-zero — a 0 amount is unpayable`
  if (num >= den) return `${file}: amount.fraction must be a STRICT fraction (N < D) — the whole remaining budget is remaining_period_budget's job`
  return null
}

/** floor(remaining × N/D) in pure bigint math — no float, no rounding surprise. */
export function fractionOfRemaining(remaining: bigint, fraction: string): bigint {
  const [num, den] = fraction.split('/').map((s) => BigInt(s))
  return (remaining * num) / den
}

/**
 * One grader's options (#4136). Every grader's option keys are closed
 * (`GRADER_OPTION_KEYS`): a grader ignores a key it does not read, so a
 * misspelt key is a check that silently does not run — a false pass, and so
 * is a wrongly typed value, so the value types are checked too. Tool names
 * (`tool_called`'s `name` / `after`, `preemptiveReadTools`) must be known
 * bare names (`ALL_TOOL_NAMES`).
 */
function validateGraderOptions(grader: { name: GraderName; options?: unknown }, file: string): string | null {
  const { name, options } = grader
  if (options === undefined) {
    return name === 'tool_called' ? `${file}: tool_called needs options.name — the tool it grades` : null
  }
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    return `${file}: ${name} options must be an object`
  }
  const allowed = GRADER_OPTION_KEYS[name]
  const unknown = Object.keys(options).filter((k) => !allowed.includes(k))
  if (unknown.length > 0) {
    return (
      `${file}: ${name} has unknown option key(s) ${unknown.map((k) => JSON.stringify(k)).join(', ')} — ` +
      `it reads only ${allowed.length > 0 ? allowed.map((k) => JSON.stringify(k)).join(', ') : 'no options'}; ` +
      `an ignored key is a check that silently does not run`
    )
  }
  const o = options as Record<string, unknown>
  // Value types: a wrongly typed value is as silent as a misspelt key —
  // `probePaymentTools: "true"` is not `=== true`, so the signer check never
  // runs; a non-array `mustMention` crashes or matches nothing.
  const nonEmptyString = (v: unknown): boolean => typeof v === 'string' && v.length > 0
  const isToolName = (v: unknown): boolean => typeof v === 'string' && ALL_TOOL_NAMES.includes(v)
  for (const key of ['errorCode', 'name', 'after'] as const) {
    if (key in o && !nonEmptyString(o[key])) {
      return `${file}: ${name} options.${key} must be a non-empty string, got ${JSON.stringify(o[key])}`
    }
  }
  for (const key of ['probePaymentTools', 'acceptPreemptive'] as const) {
    if (key in o && typeof o[key] !== 'boolean') {
      return `${file}: ${name} options.${key} must be a boolean, got ${JSON.stringify(o[key])} — any other value silently does not apply the option`
    }
  }
  if ('mustMention' in o && (!Array.isArray(o.mustMention) || !o.mustMention.every(nonEmptyString))) {
    return `${file}: ${name} options.mustMention must be an array of non-empty strings, got ${JSON.stringify(o.mustMention)}`
  }
  if ('preemptiveReadTools' in o && (!Array.isArray(o.preemptiveReadTools) || o.preemptiveReadTools.length === 0 || !o.preemptiveReadTools.every(isToolName))) {
    return `${file}: ${name} options.preemptiveReadTools must be a non-empty array of known bare tool names (tools.ts ALL_TOOL_NAMES), got ${JSON.stringify(o.preemptiveReadTools)}`
  }
  if (name !== 'tool_called') return null
  if (!isToolName(o.name)) {
    return `${file}: tool_called options.name must be a known bare tool name (tools.ts ALL_TOOL_NAMES), got ${JSON.stringify(o.name)}`
  }
  if (o.after !== undefined && !isToolName(o.after)) {
    return `${file}: tool_called options.after must be a known bare tool name (tools.ts ALL_TOOL_NAMES), got ${JSON.stringify(o.after)}`
  }
  return null
}

/** Structural + coherence validation. Returns the error string, or null. */
export function validateTask(raw: unknown, file: string): string | null {
  if (typeof raw !== 'object' || raw === null) return `${file}: not a JSON object`
  const t = raw as Record<string, unknown>
  for (const key of ['id', 'title', 'category', 'instruction', 'requires', 'amount', 'graders', 'expectTransfer', 'source']) {
    if (!(key in t)) return `${file}: missing required key "${key}"`
  }
  if (typeof t.id !== 'string' || !/^[a-z0-9-]+$/.test(t.id)) return `${file}: id must be kebab-case`
  if (typeof t.instruction !== 'string' || t.instruction.trim().length === 0) return `${file}: instruction is empty`
  if (!['direct-payment', 'x402-paywall', 'over-budget'].includes(t.category as string)) {
    return `${file}: category must be direct-payment | x402-paywall | over-budget`
  }
  const amount = t.amount as Record<string, unknown> | undefined
  if (amount?.rule === 'remaining_period_budget') {
    if (typeof amount.delta_atomic !== 'string' || !/^\d+$/.test(amount.delta_atomic)) {
      return `${file}: amount.delta_atomic must be a non-negative integer as a string (bigint-safe JSON)`
    }
  } else if (amount?.rule === 'fraction_of_remaining') {
    const fractionError = validateFraction(amount.fraction, file)
    if (fractionError) return fractionError
  } else {
    return `${file}: amount.rule must be "remaining_period_budget" (delta_atomic) or "fraction_of_remaining" (fraction) — the suite has no other budget-aware rule (#3958 § 4)`
  }
  const graders = t.graders as Array<{ name?: unknown }> | undefined
  if (!Array.isArray(graders) || graders.length === 0) return `${file}: graders must be a non-empty array`
  for (const g of graders) {
    if (typeof g?.name !== 'string') return `${file}: every grader needs a string name`
    // Own keys only: `in` would accept Object.prototype names ("constructor").
    if (!Object.hasOwn(GRADERS, g.name)) return `${file}: unknown grader "${g.name}" — the registry is closed; extend graders.ts deliberately`
    const optionsError = validateGraderOptions(g as { name: GraderName; options?: unknown }, file)
    if (optionsError) return optionsError
  }
  const source = t.source as Record<string, unknown> | undefined
  if (typeof source?.kind !== 'string' || !['bug-report', 'scenario', 'issue'].includes(source.kind as string)) {
    return `${file}: source.kind must be bug-report | scenario | issue — every task cites its source (#3958)`
  }
  if (typeof source?.ref !== 'string' || source.ref.length === 0) return `${file}: source.ref is required`
  if (typeof source?.note !== 'string' || source.note.length === 0) return `${file}: source.note is required`
  if (typeof t.expectTransfer !== 'boolean') return `${file}: expectTransfer must be boolean`
  // The ordering tier (#3992 A3): membership comes from the task FILE, not
  // the category. 1 = budget-preserving (default), 2 = THE budget drainer,
  // 3 = the precondition is an exhausted budget.
  if (t.tier !== undefined && (![1, 2, 3].includes(t.tier as number) || typeof t.tier !== 'number')) {
    return `${file}: tier must be 1 (budget-preserving), 2 (the budget drainer) or 3 (requires an exhausted budget)`
  }
  if (t.tier === 2) {
    const drains = t.category === 'direct-payment' && amount?.rule === 'remaining_period_budget' && (amount as { delta_atomic?: unknown }).delta_atomic === '0'
    if (!drains) {
      return `${file}: tier 2 is the budget drainer — a direct-payment task sending the ENTIRE remaining budget (remaining_period_budget, delta_atomic "0"); everything else is tier 1 or 3`
    }
  }
  if (t.tier === 3) {
    const requires = t.requires
    if (!Array.isArray(requires) || !requires.some((r) => typeof r === 'string' && r.startsWith('EXHAUSTED'))) {
      return `${file}: tier 3 must declare its exhausted-budget precondition in "requires" (an EXHAUSTED-… entry) — the tier exists for tasks whose setup IS a spent budget`
    }
    if (exhaustedThresholdAtomic(t as unknown as EvalTask) === undefined) {
      return `${file}: tier 3's EXHAUSTED requires entry must read EXHAUSTED-period-budget-below-<X>-USDC — the resolver verifies that bound at run time, and a label it cannot parse would switch the check off`
    }
    if (t.expectTransfer) {
      return `${file}: tier 3 expects an exhausted budget — it cannot also expect a transfer_settled outcome`
    }
  }
  // #4071: the settled spend is the agent's own purchase, not the resolved
  // amount — the consistency guard waits for ANY decrease after such a
  // trial, so the amount must be honest about not being the spend.
  if (t.settled_amount_unknown !== undefined) {
    if (typeof t.settled_amount_unknown !== 'boolean') {
      return `${file}: settled_amount_unknown must be boolean`
    }
    if (t.settled_amount_unknown && t.expectTransfer) {
      return `${file}: settled_amount_unknown=true with expectTransfer — transfer_settled probes a transfer of exactly the resolved amount, which this flag denies is the spend; settle-proof here is payment_status_settled`
    }
  }
  // Coherence: a transfer-expecting task must carry a transfer grader, and a
  // task that never expects a transfer must not carry one.
  const hasTransferGrader = (graders as Array<{ name: string }>).some((g) => g.name === 'transfer_settled')
  if (t.expectTransfer && !hasTransferGrader) {
    return `${file}: expectTransfer=true without a transfer_settled grader — the transfer would never be proven`
  }
  if (!t.expectTransfer && hasTransferGrader) {
    return `${file}: transfer_settled grader on a task that does not expect a transfer`
  }
  // Coherence: an over-budget task must actually go over — either by
  // inflating a rendered {amount} (remaining + delta) or by requiring a
  // budget exhaustion its setup provides (the x402/price-driven cases,
  // where the refusal comes from the live budget vs. the merchant's price).
  // A fraction can never go over, so an over-budget task may not carry one.
  if (t.category === 'over-budget') {
    if (amount?.rule === 'fraction_of_remaining') {
      return `${file}: over-budget task with a fraction_of_remaining amount — a slice of the remaining budget can never go OVER it; use remaining_period_budget with a positive delta_atomic`
    }
    const delta = BigInt((amount as { delta_atomic: string }).delta_atomic)
    if (delta === 0n && typeof t.instruction === 'string' && (t.instruction as string).includes('{amount}')) {
      return `${file}: over-budget task renders {amount} with delta_atomic 0 — it must go OVER the live remaining budget`
    }
  }
  return null
}

/** Load every `*.json` task file in the tasks dir, validating each. */
export async function loadTasks(dir: string = TASKS_DIR): Promise<LoadTasksResult> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
  const tasks: EvalTask[] = []
  const invalid: LoadTasksResult['invalid'] = []
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(join(dir, file), 'utf8')) as unknown
      const error = validateTask(raw, file)
      if (error) {
        invalid.push({ file, error })
        continue
      }
      tasks.push(raw as EvalTask)
    } catch (err) {
      invalid.push({ file, error: `${file}: ${(err as Error).message}` })
    }
  }
  return { tasks, invalid }
}

/**
 * Render the instruction: `{amount}` → human USDC, `{recipient}` → address,
 * `{target}` → the x402 HTTP target (`QA_EVAL_X402_TARGET` — an address and
 * a URL cannot be one env var). Unknown placeholders are left alone (a task
 * may legitimately mention `{...}` prose we do not own); a MISSING amount
 * placeholder on an over-budget task is left alone too — the grader still
 * knows the amount.
 */
export function renderInstruction(task: EvalTask, amountAtomic: bigint, recipient?: string, target?: string): string {
  const human = (Number(amountAtomic) / 1_000_000).toString()
  return task.instruction
    .replaceAll('{amount}', human)
    .replaceAll('{recipient}', recipient ?? '(recipient not configured)')
    .replaceAll('{target}', target ?? '(x402 target not configured)')
}

/** True when any task renders `{target}` — the run then needs QA_EVAL_X402_TARGET set. */
export const anyTaskUsesTarget = (tasks: EvalTask[]): boolean =>
  tasks.some((t) => t.instruction.includes('{target}'))

/**
 * The tiered run order (#3992 A3). Tier membership comes from the task file
 * (`tier`, default 1) — NOT the category: `over-budget-x402-refused` is
 * category `over-budget` but tier 3, because its precondition is an
 * EXHAUSTED budget, while `over-budget-direct-refused` is tier 1 (it needs
 * the budget funded, refuses once, spends nothing, and is repeatable).
 *
 *   tier 1 — budget-preserving tasks, in file order;
 *   tier 2 — THE budget drainer (`direct-send-full-remaining`), once;
 *   tier 3 — tasks whose precondition is an exhausted budget.
 *
 * The task files sort alphabetically, which would otherwise put the drainer
 * FIRST; the run order must not. Stable sort on the tier keeps file order
 * within a tier.
 */
export const taskTier = (t: EvalTask): number => t.tier ?? 1

export const orderTasksForSequence = (tasks: EvalTask[]): EvalTask[] =>
  [...tasks].sort((a, b) => taskTier(a) - taskTier(b))

/**
 * mulberry32 — a tiny deterministic PRNG. Enough for task ordering; the seed
 * and the produced order are both recorded in the report so two runs with
 * the same `--shuffle=<seed>` give the same order.
 */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  let a = seed >>> 0
  const rand = (): number => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/**
 * Shuffle WITHIN tiers only (#3992 B): the drainer still runs after every
 * tier-1 task and before every tier-3 task, whatever the seed. Deterministic
 * for a given seed + task set.
 */
export function shuffleWithinTiers(tasks: EvalTask[], seed: number): EvalTask[] {
  const tiers = new Map<number, EvalTask[]>()
  for (const t of tasks) {
    const k = taskTier(t)
    const bucket = tiers.get(k) ?? []
    bucket.push(t)
    tiers.set(k, bucket)
  }
  return [...tiers.keys()].sort((x, y) => x - y).flatMap((k) => seededShuffle(tiers.get(k)!, seed))
}

/**
 * The full selection pipeline the CLI runs (#3992 B): canonical order
 * (tiered, file order within a tier) → the `--limit` slice chosen from the
 * CANONICAL order (so the workflow's 5-task subset is the same with or
 * without a shuffle) → an optional `--shuffle=<seed>` applied WITHIN tiers
 * only. Returns the executed order; the caller records it in the report.
 */
export function selectTaskSequence(
  tasks: EvalTask[],
  opts: { limit?: number; shuffleSeed?: number } = {},
): EvalTask[] {
  const canonical = orderTasksForSequence(tasks)
  const limited = opts.limit !== undefined ? canonical.slice(0, opts.limit) : canonical
  return opts.shuffleSeed !== undefined ? shuffleWithinTiers(limited, opts.shuffleSeed) : limited
}

/** Resolve the task against a live budget read. */
export async function resolveTask(
  task: EvalTask,
  opts: {
    budget: BudgetSource
    recipient?: string
    x402Target?: string
    agentAccount?: string
    startedAtBlock?: number
  },
): Promise<{ resolved: ResolvedTask } | { error: string }> {
  const read = await opts.budget()
  if ('error' in read) return { error: `budget read failed for task ${task.id}: ${read.error}` }
  const amountAtomic =
    task.amount.rule === 'fraction_of_remaining'
      ? fractionOfRemaining(read.remaining, task.amount.fraction)
      : read.remaining + BigInt(task.amount.delta_atomic)
  return {
    resolved: {
      task,
      amountAtomic,
      instruction: renderInstruction(task, amountAtomic, opts.recipient, opts.x402Target),
      recipient: opts.recipient,
      agentAccount: opts.agentAccount,
      startedAtBlock: opts.startedAtBlock,
    },
  }
}

/**
 * The list sizes, as a readable count. They catch no drift on their own: they
 * are computed from the lists in `tools.ts`, so they move with them. The drift
 * check is the set equality against the upstream sources in `tools.test.ts`.
 */
export const TOOL_COUNTS = {
  hosted: HOSTED_TOOLS.length,
  signer: SIGNER_TOOLS.length,
  payment: PAYMENT_TOOLS.length,
} as const

/**
 * The threshold a tier-3 task's `EXHAUSTED-period-budget-below-<X>-USDC`
 * precondition names, in atomic USDC (6 decimals). Undefined when the task
 * declares no such bound.
 */
export function exhaustedThresholdAtomic(task: EvalTask): bigint | undefined {
  if (task.tier !== 3) return undefined
  for (const r of task.requires) {
    const m = /^EXHAUSTED-period-budget-below-(\d+)(?:\.(\d{1,6}))?-USDC$/.exec(r)
    if (m) return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0')
  }
  return undefined
}
