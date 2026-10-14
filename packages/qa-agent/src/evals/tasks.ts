/**
 * Loading + resolving eval tasks (#3958).
 *
 * A task file is JSON — never Markdown (#3958's obligation list) — one file
 * per task under `src/evals/tasks/`. Loading validates the file against the
 * `EvalTask` shape AND its own internal coherence (graders exist in the
 * registry, over-budget tasks actually go over, transfer-expecting tasks
 * name a transfer grader): a task file that parses but means nothing would
 * otherwise pass silently and fail only on the partner's machine, three
 * hours into a nightly run.
 *
 * Resolution is the budget-aware half (#3958 § 4): the amount comes from a
 * LIVE read of the remaining period budget + the task's delta, so 30 nightly
 * sessions on one period budget do not turn later success tasks into
 * refusals, and over-budget tasks genuinely go over (remaining + 1, the
 * `over-budget-refused` derivation). The read is injected; a caller that
 * cannot read the budget gets an ERROR, not a guessed amount — same refusal
 * as `lib/delegation-budget.ts`'s fallback discipline.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GRADERS } from './graders.js'
import { HOSTED_TOOLS, PAYMENT_TOOLS, SIGNER_TOOLS } from './tools.js'
import type { EvalTask, ResolvedTask } from './types.js'

const TASKS_DIR = join(fileURLToPath(import.meta.url), '..', 'tasks')

/** The live budget source the resolver needs: atomic remaining, or a reason. */
export type BudgetSource = () => Promise<{ remaining: bigint } | { error: string }>

export interface LoadTasksResult {
  tasks: EvalTask[]
  /** Files that failed validation, with the reason. */
  invalid: Array<{ file: string; error: string }>
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
  if (amount?.rule !== 'remaining_period_budget') {
    return `${file}: amount.rule must be "remaining_period_budget" — the suite has no other budget-aware rule (#3958 § 4)`
  }
  if (typeof amount.delta_atomic !== 'string' || !/^\d+$/.test(amount.delta_atomic)) {
    return `${file}: amount.delta_atomic must be a non-negative integer as a string (bigint-safe JSON)`
  }
  const graders = t.graders as Array<{ name?: unknown }> | undefined
  if (!Array.isArray(graders) || graders.length === 0) return `${file}: graders must be a non-empty array`
  for (const g of graders) {
    if (typeof g?.name !== 'string') return `${file}: every grader needs a string name`
    if (!(g.name in GRADERS)) return `${file}: unknown grader "${g.name}" — the registry is closed; extend graders.ts deliberately`
  }
  const source = t.source as Record<string, unknown> | undefined
  if (typeof source?.kind !== 'string' || !['bug-report', 'scenario', 'issue'].includes(source.kind as string)) {
    return `${file}: source.kind must be bug-report | scenario | issue — every task cites its source (#3958)`
  }
  if (typeof source?.ref !== 'string' || source.ref.length === 0) return `${file}: source.ref is required`
  if (typeof source?.note !== 'string' || source.note.length === 0) return `${file}: source.note is required`
  if (typeof t.expectTransfer !== 'boolean') return `${file}: expectTransfer must be boolean`
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
  const delta = BigInt(amount.delta_atomic as string)
  if (t.category === 'over-budget' && delta === 0n && typeof t.instruction === 'string' && (t.instruction as string).includes('{amount}')) {
    return `${file}: over-budget task renders {amount} with delta_atomic 0 — it must go OVER the live remaining budget`
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
 * Render the instruction: `{amount}` → human USDC, `{recipient}` → address.
 * Unknown placeholders are left alone (a task may legitimately mention
 * `{...}` prose we do not own); a MISSING amount placeholder on an
 * over-budget task is left alone too — the grader still knows the amount.
 */
export function renderInstruction(task: EvalTask, amountAtomic: bigint, recipient?: string): string {
  const human = (Number(amountAtomic) / 1_000_000).toString()
  return task.instruction
    .replaceAll('{amount}', human)
    .replaceAll('{recipient}', recipient ?? '(recipient not configured)')
}

/** Resolve the task against a live budget read. */
export async function resolveTask(
  task: EvalTask,
  opts: { budget: BudgetSource; recipient?: string; agentAccount?: string; startedAtBlock?: number },
): Promise<{ resolved: ResolvedTask } | { error: string }> {
  const read = await opts.budget()
  if ('error' in read) return { error: `budget read failed for task ${task.id}: ${read.error}` }
  const amountAtomic = read.remaining + BigInt(task.amount.delta_atomic)
  return {
    resolved: {
      task,
      amountAtomic,
      instruction: renderInstruction(task, amountAtomic, opts.recipient),
      recipient: opts.recipient,
      agentAccount: opts.agentAccount,
      startedAtBlock: opts.startedAtBlock,
    },
  }
}

/** Counts the tests pin, so a copied list fails loudly instead of silently. */
export const TOOL_COUNTS = {
  hosted: HOSTED_TOOLS.length,
  signer: SIGNER_TOOLS.length,
  payment: PAYMENT_TOOLS.length,
} as const
