/**
 * The eval runner (#3958 § 5): k trials per task, graders, report.
 *
 * Adapter-shaped, not Hermes-shaped: #3959's Claude Code lane plugs in by
 * implementing {@link EvalAdapter}. The runner owns exactly three things —
 * trial iteration, grader application, and the report — and nothing else:
 * no budget reads and no chain reads (the INJECTED resolver's and probes',
 * #3992 A2), no log parsing (the adapters').
 *
 * Per-trial resolution (#3992 A2): `resolveForTrial` is called immediately
 * before EVERY trial and returns that trial's own {@link ResolvedTask} —
 * its own amount against the live budget at that moment, and its own start
 * block. Every `TrialRecord` carries the resolved amount and block it was
 * graded against, and every grader's evidence is scoped to its own trial:
 * chain probes read from that trial's start block, payment ids come from
 * that trial's own log. A resolve error is a RED TRIAL with the cause, not
 * an exit — the same contract an adapter failure already has: a nightly run
 * must finish and report.
 */

import { applyGraders } from './graders.js'
import type { AgentRunLog, EvalTask, GraderContext, GraderResult, ResolvedTask } from './types.js'

/** One adapter lane. Hermes today; #3959 adds Claude Code. */
export interface EvalAdapter {
  name: string
  runTask(task: ResolvedTask, trial: number): Promise<AgentRunLog>
}

export interface TrialRecord {
  trial: number
  pass: boolean
  graders: Array<GraderResult & { name: string }>
  /** Wall time of the agent session, ms. */
  wallMs: number
  /**
   * Session cost in USD when the adapter reports one (the Claude Code lane's
   * `total_cost_usd`, #3959). Absent for lanes that cannot know it.
   */
  costUsd?: number
  /** First failing grader's detail, or '' when the trial passed. */
  detail: string
  /**
   * The amount this trial resolved to (#3992 A2) — the live budget slice
   * (or delta) at the moment immediately before the trial ran.
   */
  resolvedAmountAtomic?: string
  /**
   * The observer block this trial's chain evidence reads from (#3992 A2) —
   * its own, never the run's first block.
   */
  startBlock?: number
}

export interface TaskReport {
  id: string
  title: string
  category: EvalTask['category']
  source: EvalTask['source']
  /** True for the tier-2 budget drainer: it runs ONE trial, pass^k is not compared. */
  drainsBudget: boolean
  trials: TrialRecord[]
  /** passed / attempted, 0-1. */
  passRate: number
  /** pass^k: every trial passed. */
  passAll: boolean
  /** Wall time of the SLOWEST session, ms — the nightly-run bound. */
  slowestSessionMs: number
  /** Median wall time across the task's sessions, ms (#3959's summary metric). */
  medianSessionMs: number
}

/**
 * Where the hosted MCP leg ran. Recorded by the CLI from its args and echoed
 * into both report halves (#3959: the subset names the commit it built, not the deployed stack).
 */
export interface HostedMcpInfo {
  source: 'pr-checkout' | 'dev-deployed'
  url?: string
  /** The commit the hosted MCP served — the dispatched commit for the subset lane. */
  commit?: string
}

export interface EvalReport {
  generatedAt: string
  adapter: string
  trialsPerTask: number
  /**
   * The EXECUTED task order (#3992 B) — canonical (tiered) order, or the
   * `--shuffle=<seed>` order; the seed rides alongside.
   */
  order: string[]
  shuffleSeed?: number
  tasks: TaskReport[]
  /** Tasks that produced a usable verdict. */
  tasksRun: number
  tasksPassingAll: number
  /** Sum of the session costs the adapter reported, when it does (#3959). */
  totalCostUsd?: number
  /**
   * The model the sessions ran on — env-supplied for the Hermes lane, the
   * adapter's stream for Claude Code (#3959, #3992 C). 'not reported' in the
   * rendered summaries when absent.
   */
  model?: string
  /** The inference server build the model answered from (#3992 C). */
  inferenceServerBuild?: string
  /** The harness version that ran the suite (#3992 C). */
  harnessVersion?: string
  /** Budget INCREASES the resolver detected between trials (a refill boundary, #3992 E). */
  budgetEvents?: BudgetIncreaseEvent[]
  hostedMcp?: HostedMcpInfo
}

/** A budget increase observed between two trials — a daily refill boundary crossed. */
export interface BudgetIncreaseEvent {
  detectedBeforeTask: string
  detectedBeforeTrial: number
  previousRemainingAtomic: string
  observedRemainingAtomic: string
}

/**
 * What the resolver knows about the trial that just finished, across tasks:
 * the budget-consistency guard and the amount it may deduct both live in the
 * resolver (#3992 A2), and the drainer-before-tier-3 sequence spans tasks.
 * `settled` is true when the record's graders PROVED the resolved amount
 * left the budget (a settled transfer or a settled backend payment).
 */
export interface PriorTrialOutcome {
  taskId: string
  trial: number
  resolved: ResolvedTask
  record: TrialRecord
  settled: boolean
}

export interface RunSuiteOptions {
  tasks: EvalTask[]
  /**
   * Resolve ONE trial of ONE task (#3992 A2): a live budget read + a fresh
   * observer block immediately before the trial. The runner never reads the
   * budget or the chain itself. Throwing here is a RED TRIAL, not an exit.
   */
  resolveForTrial: (task: EvalTask, trial: number, prior?: PriorTrialOutcome) => Promise<ResolvedTask>
  adapter: EvalAdapter
  trials: number
  /** Per-task trial-count override (the tier-2 drainer runs exactly one trial). */
  trialCountFor?: (task: EvalTask) => number
  /** The `--shuffle=<seed>` the executed order came from, echoed into the report. */
  shuffleSeed?: number
  /** Where the hosted MCP leg ran, echoed into the report (#3959). */
  hostedMcp?: HostedMcpInfo
  /** Grader probes live here (chain/backend), injected per suite. */
  graderContext?: Omit<GraderContext, 'resolved'>
  /** Hook for the tests: observe each trial as it lands. */
  onTrial?: (resolved: ResolvedTask, record: TrialRecord) => void
}

const SETTLEMENT_GRADERS = new Set(['transfer_settled', 'payment_status_settled'])

/** A trial settled when one of its settlement graders PASSED. */
const recordSettled = (record: TrialRecord): boolean =>
  record.graders.some((g) => SETTLEMENT_GRADERS.has(g.name) && g.pass)

/**
 * Run one task's trials. Each trial resolves, runs, grades — and its record
 * (with its own resolved amount + start block) becomes the next resolve's
 * `prior` across task boundaries, because the drainer-before-tier-3 budget
 * sequence spans tasks.
 */
export async function runTaskTrials(
  task: EvalTask,
  opts: {
    adapter: EvalAdapter
    resolveForTrial: RunSuiteOptions['resolveForTrial']
    trials: number
    graderContext?: Omit<GraderContext, 'resolved'>
    onTrial?: RunSuiteOptions['onTrial']
  },
  state: { prior?: PriorTrialOutcome },
): Promise<TaskReport> {
  const records: TrialRecord[] = []
  for (let trial = 1; trial <= opts.trials; trial++) {
    const startedAt = Date.now()
    let resolved: ResolvedTask
    try {
      resolved = await opts.resolveForTrial(task, trial, state.prior)
    } catch (err) {
      // A resolve failure is a RED TRIAL, not an exit (#3992 A2): a nightly
      // run must finish and report, naming the cause, and let later trials
      // run.
      const record: TrialRecord = {
        trial,
        pass: false,
        graders: [],
        wallMs: Date.now() - startedAt,
        detail: `resolve failure: ${(err as Error).message.slice(0, 300)}`,
      }
      records.push(record)
      continue
    }
    let log: AgentRunLog
    try {
      log = await opts.adapter.runTask(resolved, trial)
    } catch (err) {
      // An adapter failure is a RED TRIAL, not an exception up the stack:
      // a nightly run must finish and report, naming the cause.
      const record: TrialRecord = {
        trial,
        pass: false,
        graders: [],
        wallMs: Date.now() - startedAt,
        detail: `adapter failure: ${(err as Error).message.slice(0, 300)}`,
        resolvedAmountAtomic: resolved.amountAtomic.toString(),
        startBlock: resolved.startedAtBlock,
      }
      records.push(record)
      state.prior = { taskId: task.id, trial, resolved, record, settled: false }
      opts.onTrial?.(resolved, record)
      continue
    }
    const graderResults = await applyGraders(log, task.graders, {
      resolved,
      ...(opts.graderContext ?? {}),
    })
    const firstFail = graderResults.find((g) => !g.pass)
    const record: TrialRecord = {
      trial,
      pass: !firstFail,
      graders: graderResults,
      wallMs: Date.now() - startedAt,
      detail: firstFail?.detail ?? '',
      resolvedAmountAtomic: resolved.amountAtomic.toString(),
      startBlock: resolved.startedAtBlock,
    }
    records.push(record)
    state.prior = { taskId: task.id, trial, resolved, record, settled: recordSettled(record) }
    opts.onTrial?.(resolved, record)
  }
  const passed = records.filter((r) => r.pass).length
  return {
    id: task.id,
    title: task.title,
    category: task.category,
    source: task.source,
    drainsBudget: task.tier === 2,
    trials: records,
    passRate: records.length === 0 ? 0 : passed / records.length,
    passAll: records.length > 0 && passed === records.length,
    slowestSessionMs: Math.max(0, ...records.map((r) => r.wallMs)),
    medianSessionMs: medianMs(records.map((r) => r.wallMs)),
  }
}

/** Median wall time in ms — the summary metric #3959 reports per task. */
export function medianMs(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

export async function runSuite(opts: RunSuiteOptions): Promise<EvalReport> {
  const tasks: TaskReport[] = []
  // The prior outcome is SHARED across tasks: the budget the tier-3 tasks
  // resolve against was spent by the tier-2 drainer of a DIFFERENT task.
  const state: { prior?: PriorTrialOutcome } = {}
  for (const task of opts.tasks) {
    const trials = opts.trialCountFor?.(task) ?? opts.trials
    tasks.push(await runTaskTrials(task, { ...opts, trials }, state))
  }
  return {
    generatedAt: new Date().toISOString(),
    adapter: opts.adapter.name,
    trialsPerTask: opts.trials,
    order: opts.tasks.map((t) => t.id),
    ...(opts.shuffleSeed !== undefined ? { shuffleSeed: opts.shuffleSeed } : {}),
    tasks,
    tasksRun: tasks.length,
    tasksPassingAll: tasks.filter((t) => t.passAll).length,
    ...(opts.hostedMcp ? { hostedMcp: opts.hostedMcp } : {}),
  }
}

/** The readable half of the report — plain text, pasteable into an issue. */
export function renderSummary(report: EvalReport): string {
  const lines: string[] = []
  lines.push(`Agent evals — ${report.adapter} — ${report.generatedAt}`)
  lines.push(`Trials per task: ${report.trialsPerTask}; pass^k on ${report.tasksPassingAll}/${report.tasksRun} tasks`)
  lines.push(`Executed order: ${report.order.join(' → ')}${report.shuffleSeed !== undefined ? ` (shuffle seed ${report.shuffleSeed})` : ''}`)
  lines.push(
    `Model: ${report.model ?? 'not reported'}; inference server build: ${report.inferenceServerBuild ?? 'not reported'}; harness version: ${report.harnessVersion ?? 'not reported'}`,
  )
  lines.push('')
  for (const t of report.tasks) {
    const rate = `${Math.round(t.passRate * 100)}%`
    const drain = t.drainsBudget ? '  k=1 (drains budget)' : ''
    lines.push(
      `${t.passAll ? 'PASS^k' : 'fail  '}  ${t.id}  (${t.category})  pass ${rate}${drain}  median session ${t.medianSessionMs}ms  slowest ${t.slowestSessionMs}ms  [${t.source.kind}: ${t.source.ref}]`,
    )
    for (const trial of t.trials) {
      if (!trial.pass) {
        lines.push(`        trial ${trial.trial} (${trial.wallMs}ms): ${trial.detail}`)
      }
    }
  }
  lines.push('')
  if (report.budgetEvents && report.budgetEvents.length > 0) {
    for (const e of report.budgetEvents) {
      lines.push(
        `Budget increase detected before ${e.detectedBeforeTask} trial ${e.detectedBeforeTrial}: ${e.previousRemainingAtomic} → ${e.observedRemainingAtomic} (a refill boundary was crossed mid-run).`,
      )
    }
    lines.push('')
  }
  if (report.totalCostUsd !== undefined) {
    lines.push(`Total cost the adapter reported: $${report.totalCostUsd.toFixed(4)}${report.model ? ` (model: ${report.model})` : ''}`)
  }
  if (report.hostedMcp) {
    lines.push(
      `Hosted MCP: ${report.hostedMcp.source}${report.hostedMcp.commit ? ` @ ${report.hostedMcp.commit}` : ''}${report.hostedMcp.url ? ` (${report.hostedMcp.url})` : ''}`,
    )
    if (report.hostedMcp.source === 'pr-checkout') {
      lines.push('Error bodies produced by packages/backend stay dev-deployed whatever this job checked out.')
    }
  }
  lines.push('Wall time per session is measured around the adapter call (the partner-experienced session time).')
  return lines.join('\n')
}
