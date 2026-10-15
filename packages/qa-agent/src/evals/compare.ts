/**
 * The regression-only compare (#3992 D): the new report against earlier
 * comparable reports, alerting only on a REAL regression — a task that
 * failed pass^k on the last two comparable nights after passing pass^k on
 * at least 5 of the 7 comparable nights before them. One flake never
 * alerts; a new task has no baseline and never alerts; a model change
 * starts a fresh baseline (comparability is lane + adapter + model — and
 * the same `trialsPerTask`, because pass^k at k=1 is not pass^k at k=3).
 *
 * Pure functions over report JSON: the transport (results branch, ping
 * target) is the partner's setup. Malformed reports are skipped and named,
 * never crashed on; thin history prints "baseline building" and exits zero.
 */

export interface ParsedCompareReport {
  path: string
  generatedAt: string
  adapter: string
  model?: string
  trialsPerTask: number
  /** taskId → pass^k, drainer tasks excluded (their k=1 is not comparable). */
  results: Map<string, boolean>
}

export type ParseOutcome = { report: ParsedCompareReport } | { error: string }

export function parseCompareReport(raw: string, path: string): ParseOutcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { error: `${path}: not JSON (${(err as Error).message.slice(0, 120)})` }
  }
  if (typeof parsed !== 'object' || parsed === null) return { error: `${path}: not a JSON object` }
  const r = parsed as Record<string, unknown>
  for (const key of ['generatedAt', 'adapter', 'trialsPerTask', 'tasks']) {
    if (!(key in r)) return { error: `${path}: missing report key "${key}" — not an eval report` }
  }
  if (typeof r.generatedAt !== 'string' || r.generatedAt.length === 0) {
    return { error: `${path}: generatedAt must be a non-empty string` }
  }
  if (typeof r.adapter !== 'string' || r.adapter.length === 0) {
    return { error: `${path}: adapter must be a non-empty string` }
  }
  if (typeof r.trialsPerTask !== 'number' || !Number.isInteger(r.trialsPerTask) || r.trialsPerTask < 1) {
    return { error: `${path}: trialsPerTask must be a positive integer` }
  }
  if (!Array.isArray(r.tasks)) return { error: `${path}: tasks must be an array` }
  const results = new Map<string, boolean>()
  for (const t of r.tasks) {
    if (typeof t !== 'object' || t === null) return { error: `${path}: a tasks entry is not an object` }
    const task = t as { id?: unknown; passAll?: unknown; drainsBudget?: unknown }
    if (typeof task.id !== 'string' || task.id.length === 0) return { error: `${path}: a task entry has no id` }
    if (typeof task.passAll !== 'boolean') return { error: `${path}: task ${task.id} has no boolean passAll` }
    if (task.drainsBudget === true) continue // k=1 on purpose; never compared
    results.set(task.id, task.passAll)
  }
  return {
    report: {
      path,
      generatedAt: r.generatedAt,
      adapter: r.adapter,
      ...(typeof r.model === 'string' && r.model.length > 0 ? { model: r.model } : {}),
      trialsPerTask: r.trialsPerTask,
      results,
    },
  }
}

export interface CompareVerdict {
  /** Fewer than 3 comparable reports — nothing is decided yet. */
  baselineBuilding: boolean
  /** The new report plus the comparable earlier ones. */
  comparableReports: number
  /** Task ids that regressed, per the alert rule. */
  alerts: string[]
  /** Malformed history files: skipped, and named. */
  skipped: Array<{ path: string; error: string }>
}

/**
 * The alert rule (#3992 D), evaluated per task of the NEW report: the task
 * failed pass^k on the last two comparable nights (the new run is the
 * newest of them) after passing pass^k on at least 5 of the 7 comparable
 * nights before them. Fewer than 3 comparable reports in total → baseline
 * building; a task absent from history simply cannot satisfy the rule
 * (a new task never alerts).
 */
export function compareAgainstBaseline(
  newReport: ParsedCompareReport,
  history: Array<{ outcome: ParseOutcome }>,
): CompareVerdict {
  const skipped: CompareVerdict['skipped'] = []
  const comparable: ParsedCompareReport[] = [newReport]
  for (const h of history) {
    if ('error' in h.outcome) {
      skipped.push({ path: h.outcome.error.slice(0, h.outcome.error.indexOf(':') + 1), error: h.outcome.error })
      continue
    }
    const r = h.outcome.report
    if (r.adapter === newReport.adapter && r.model === newReport.model && r.trialsPerTask === newReport.trialsPerTask) {
      comparable.push(r)
    }
    // Not comparable (a different lane/adapter/model/k): ignored silently —
    // a model change starts a fresh baseline, it is not an error.
  }
  comparable.sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : a.generatedAt > b.generatedAt ? -1 : 0))
  // The new report is the newest night by construction.
  const ordered = [newReport, ...comparable.filter((r) => r !== newReport)]

  if (ordered.length < 3) {
    return { baselineBuilding: true, comparableReports: ordered.length, alerts: [], skipped }
  }

  const alerts: string[] = []
  for (const [taskId, passAll] of newReport.results) {
    if (passAll) continue // passed tonight: nothing to alert about
    // The previous comparable night that graded this task must also FAIL.
    const rest = ordered.slice(1)
    const prevIndex = rest.findIndex((r) => r.results.has(taskId))
    if (prevIndex === -1 || rest[prevIndex]!.results.get(taskId) !== false) continue
    // Up to 7 comparable nights before the two failing ones.
    const prior = rest.slice(prevIndex + 1)
    const nights = prior.filter((r) => r.results.has(taskId)).slice(0, 7)
    const passes = nights.filter((r) => r.results.get(taskId) === true).length
    if (nights.length >= 5 && passes >= 5) {
      alerts.push(taskId)
    }
  }
  return { baselineBuilding: false, comparableReports: ordered.length, alerts, skipped }
}

/** The human-readable verdict: what was compared, what was skipped, what alerts. */
export function formatCompareVerdict(verdict: CompareVerdict, newReport: ParsedCompareReport): string {
  const lines: string[] = []
  lines.push(
    `Compare: ${verdict.comparableReports} comparable report(s) — adapter ${newReport.adapter}, ` +
      `model ${newReport.model ?? 'not reported'}, ${newReport.trialsPerTask} trial(s) per task.`,
  )
  for (const s of verdict.skipped) lines.push(`Skipped malformed report: ${s.error}`)
  if (verdict.baselineBuilding) {
    lines.push('Baseline building — fewer than 3 comparable reports; nothing alerts yet.')
    return lines.join('\n')
  }
  if (verdict.alerts.length === 0) {
    lines.push('No regressions: no task failed pass^k on the last two comparable nights after a stable baseline.')
  } else {
    for (const id of verdict.alerts) {
      lines.push(`ALERT: ${id} failed pass^k on the last two comparable nights after passing on at least 5 of the 7 before them.`)
    }
  }
  return lines.join('\n')
}
