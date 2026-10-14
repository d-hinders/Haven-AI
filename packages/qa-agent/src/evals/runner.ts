/**
 * The eval runner (#3958 § 5): k trials per task, graders, report.
 *
 * Adapter-shaped, not Hermes-shaped: #3959's Claude Code lane plugs in by
 * implementing {@link EvalAdapter}. The runner owns exactly three things —
 * trial iteration, grader application, and the report — and nothing else:
 * no budget reads (the resolver's), no chain reads (the probes'), no log
 * parsing (the adapters').
 *
 * The report is JSON plus a readable summary, with per-task pass rate,
 * pass^k (ALL k trials passed — the number #3957's regression tracking
 * cares about) and wall time per session. `wallMs` is measured around the
 * adapter call, so it is the session's wall time as the partner experiences
 * it, not the grader time.
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
  /** First failing grader's detail, or '' when the trial passed. */
  detail: string
}

export interface TaskReport {
  id: string
  title: string
  category: EvalTask['category']
  source: EvalTask['source']
  resolvedAmountAtomic?: string
  trials: TrialRecord[]
  /** passed / attempted, 0-1. */
  passRate: number
  /** pass^k: every trial passed. */
  passAll: boolean
  /** Wall time of the SLOWEST session, ms — the nightly-run bound. */
  slowestSessionMs: number
}

export interface EvalReport {
  generatedAt: string
  adapter: string
  trialsPerTask: number
  tasks: TaskReport[]
  /** Tasks that produced a usable verdict. */
  tasksRun: number
  tasksPassingAll: number
}

export interface RunSuiteOptions {
  resolved: ResolvedTask[]
  adapter: EvalAdapter
  trials: number
  /** Grader probes live here (chain/backend), injected per suite. */
  graderContext?: Omit<GraderContext, 'resolved'>
  /** Hook for the tests: observe each trial as it lands. */
  onTrial?: (task: ResolvedTask, record: TrialRecord) => void
}

export async function runTaskTrials(
  resolved: ResolvedTask,
  adapter: EvalAdapter,
  trials: number,
  grade: (log: AgentRunLog) => Promise<Array<GraderResult & { name: string }>>,
  onTrial?: RunSuiteOptions['onTrial'],
): Promise<TaskReport> {
  const records: TrialRecord[] = []
  for (let trial = 1; trial <= trials; trial++) {
    const startedAt = Date.now()
    let log: AgentRunLog
    try {
      log = await adapter.runTask(resolved, trial)
    } catch (err) {
      // An adapter failure is a RED TRIAL, not an exception up the stack:
      // a nightly run must finish and report, naming the cause.
      const record: TrialRecord = {
        trial,
        pass: false,
        graders: [],
        wallMs: Date.now() - startedAt,
        detail: `adapter failure: ${(err as Error).message.slice(0, 300)}`,
      }
      records.push(record)
      onTrial?.(resolved, record)
      continue
    }
    const graderResults = await grade(log)
    const firstFail = graderResults.find((g) => !g.pass)
    const record: TrialRecord = {
      trial,
      pass: !firstFail,
      graders: graderResults,
      wallMs: Date.now() - startedAt,
      detail: firstFail?.detail ?? '',
    }
    records.push(record)
    onTrial?.(resolved, record)
  }
  const passed = records.filter((r) => r.pass).length
  return {
    id: resolved.task.id,
    title: resolved.task.title,
    category: resolved.task.category,
    source: resolved.task.source,
    resolvedAmountAtomic: resolved.amountAtomic.toString(),
    trials: records,
    passRate: records.length === 0 ? 0 : passed / records.length,
    passAll: records.length > 0 && passed === records.length,
    slowestSessionMs: Math.max(0, ...records.map((r) => r.wallMs)),
  }
}

export async function runSuite(opts: RunSuiteOptions): Promise<EvalReport> {
  const gradeFor =
    (resolved: ResolvedTask) =>
    async (log: AgentRunLog) =>
      applyGraders(log, resolved.task.graders, { resolved, ...(opts.graderContext ?? {}) })
  const tasks: TaskReport[] = []
  for (const resolved of opts.resolved) {
    tasks.push(await runTaskTrials(resolved, opts.adapter, opts.trials, gradeFor(resolved), opts.onTrial))
  }
  return {
    generatedAt: new Date().toISOString(),
    adapter: opts.adapter.name,
    trialsPerTask: opts.trials,
    tasks,
    tasksRun: tasks.length,
    tasksPassingAll: tasks.filter((t) => t.passAll).length,
  }
}

/** The readable half of the report — plain text, pasteable into an issue. */
export function renderSummary(report: EvalReport): string {
  const lines: string[] = []
  lines.push(`Agent evals — ${report.adapter} — ${report.generatedAt}`)
  lines.push(`Trials per task: ${report.trialsPerTask}; pass^k on ${report.tasksPassingAll}/${report.tasksRun} tasks`)
  lines.push('')
  for (const t of report.tasks) {
    const rate = `${Math.round(t.passRate * 100)}%`
    lines.push(
      `${t.passAll ? 'PASS^k' : 'fail  '}  ${t.id}  (${t.category})  pass ${rate}  slowest session ${t.slowestSessionMs}ms  [${t.source.kind}: ${t.source.ref}]`,
    )
    for (const trial of t.trials) {
      if (!trial.pass) {
        lines.push(`        trial ${trial.trial} (${trial.wallMs}ms): ${trial.detail}`)
      }
    }
  }
  lines.push('')
  lines.push('Wall time per session is measured around the adapter call (the partner-experienced session time).')
  return lines.join('\n')
}
