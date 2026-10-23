/**
 * Compare fixtures (#3992 D): an alert after two consecutive pass^k
 * failures following a stable baseline; no alert on a single failure;
 * "baseline building" with fewer than 3 comparable reports; no comparison
 * across a model change; a new task never alerts; a malformed report is
 * skipped and named.
 */

import { describe, expect, it } from 'vitest'
import { compareAgainstBaseline, formatCompareVerdict, parseCompareReport } from './compare.js'
import type { ParsedCompareReport } from './compare.js'

let seq = 0

function reportJson(
  results: Record<string, boolean>,
  opts: { generatedAt?: string; adapter?: string; model?: string; trialsPerTask?: number; drains?: string[] } = {},
): string {
  seq += 1
  // Strictly increasing minute stamps — history entries are chronological in
  // array order, and the new report is always the newest night.
  return JSON.stringify({
    generatedAt: opts.generatedAt ?? new Date(Date.UTC(2026, 9, 15, 4, seq)).toISOString(),
    adapter: opts.adapter ?? 'hermes',
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    trialsPerTask: opts.trialsPerTask ?? 3,
    tasks: Object.entries(results).map(([id, passAll]) => ({
      id,
      passAll,
      ...(opts.drains?.includes(id) ? { drainsBudget: true } : {}),
    })),
  })
}

function parse(raw: string, path: string): ParsedCompareReport {
  const outcome = parseCompareReport(raw, path)
  if ('error' in outcome) throw new Error(outcome.error)
  return outcome.report
}

const T = 'direct-send-partial-budget'
const baseline = (): Record<string, boolean> => ({ [T]: true, 'over-budget-direct-refused': true })

describe('compareAgainstBaseline', () => {
  it('alerts when the task failed pass^k on the last two comparable nights after 5-of-7 passing', () => {
    const history = [
      ...Array.from({ length: 7 }, () => reportJson(baseline())), // the stable baseline
      reportJson({ [T]: false, 'over-budget-direct-refused': true }), // night -2: FAIL
    ]
    const newReport = parse(reportJson({ [T]: false, 'over-budget-direct-refused': true }), 'new.json')
    const verdict = compareAgainstBaseline(
      newReport,
      history.map((h) => ({ outcome: parseCompareReport(h, 'h.json') })),
    )
    expect(verdict.baselineBuilding).toBe(false)
    expect(verdict.alerts).toEqual([T])
  })

  it('no alert on a single failure — one flake never alerts', () => {
    const history = [...Array.from({ length: 8 }, () => reportJson(baseline()))]
    const newReport = parse(reportJson({ [T]: false, 'over-budget-direct-refused': true }), 'new.json')
    const verdict = compareAgainstBaseline(newReport, history.map((h) => ({ outcome: parseCompareReport(h, 'h.json') })))
    expect(verdict.alerts).toEqual([])
  })

  it('no alert when fewer than 5 of the 7 prior nights passed (the baseline was never stable)', () => {
    const history = [
      reportJson({ [T]: true }),
      reportJson({ [T]: true }),
      reportJson({ [T]: true }),
      reportJson({ [T]: true }),
      reportJson({ [T]: false }),
      reportJson({ [T]: false }),
      reportJson({ [T]: false }),
    ]
    const newReport = parse(reportJson({ [T]: false }), 'new.json')
    const verdict = compareAgainstBaseline(newReport, history.map((h) => ({ outcome: parseCompareReport(h, 'h.json') })))
    expect(verdict.alerts).toEqual([])
  })

  it('baseline building with fewer than 3 comparable reports — exits zero', () => {
    const history = [reportJson(baseline())]
    const newReport = parse(reportJson({ [T]: false }), 'new.json')
    const verdict = compareAgainstBaseline(newReport, history.map((h) => ({ outcome: parseCompareReport(h, 'h.json') })))
    expect(verdict.baselineBuilding).toBe(true)
    expect(verdict.alerts).toEqual([])
  })

  it('a model change starts a fresh baseline — other-model nights are not comparable', () => {
    const history = [
      ...Array.from({ length: 7 }, () => reportJson(baseline())),
      reportJson({ [T]: false }, { model: 'qwen3.8' }), // the previous night ran a DIFFERENT model
    ]
    const newReport = parse(reportJson({ [T]: false }, { model: 'glm-5.3-flash' }), 'new.json')
    const verdict = compareAgainstBaseline(newReport, history.map((h) => ({ outcome: parseCompareReport(h, 'h.json') })))
    expect(verdict.baselineBuilding).toBe(true) // only the new report is comparable
    expect(verdict.alerts).toEqual([])
  })

  it('a new task has no baseline and never alerts', () => {
    const history = [...Array.from({ length: 8 }, () => reportJson(baseline()))]
    const newReport = parse(reportJson({ ...baseline(), 'brand-new-task': false }), 'new.json')
    const verdict = compareAgainstBaseline(newReport, history.map((h) => ({ outcome: parseCompareReport(h, 'h.json') })))
    expect(verdict.alerts).toEqual([])
  })

  it('the drainer (k=1 on purpose) is never compared', () => {
    const results = () => ({ [T]: false, 'direct-send-full-remaining': false })
    const history = [...Array.from({ length: 8 }, () => reportJson(results(), { drains: ['direct-send-full-remaining'] }))]
    const newReport = parse(reportJson(results(), { drains: ['direct-send-full-remaining'] }), 'new.json')
    const verdict = compareAgainstBaseline(newReport, history.map((h) => ({ outcome: parseCompareReport(h, 'h.json') })))
    expect(verdict.alerts).toEqual([])
  })

  it('a different trialsPerTask is not comparable — pass^k at k=1 is not pass^k at k=3', () => {
    const history = [...Array.from({ length: 8 }, () => reportJson(baseline(), { trialsPerTask: 1 }))]
    const newReport = parse(reportJson({ [T]: false }, { trialsPerTask: 3 }), 'new.json')
    const verdict = compareAgainstBaseline(newReport, history.map((h) => ({ outcome: parseCompareReport(h, 'h.json') })))
    expect(verdict.baselineBuilding).toBe(true)
  })

  it('a malformed report is skipped and named, not crashed on', () => {
    const history = [
      '{ not json at all',
      reportJson(baseline()),
      reportJson(baseline()),
      reportJson(baseline()),
      reportJson(baseline()),
      reportJson(baseline()),
      reportJson(baseline()),
      reportJson({ [T]: false }),
    ]
    const newReport = parse(reportJson({ [T]: false }), 'new.json')
    const outcomes = history.map((raw, i) => ({ outcome: parseCompareReport(raw, `h${i}.json`) }))
    const verdict = compareAgainstBaseline(newReport, outcomes)
    expect(verdict.skipped).toHaveLength(1)
    expect(verdict.skipped[0].error).toContain('h0.json')
    expect(verdict.skipped[0].error).toContain('not JSON')
    // The rest of the history still drove the rule.
    expect(verdict.alerts).toEqual([T])
  })

  it('the formatted verdict names the alert and the exit-worthy line', () => {
    const newReport = parse(reportJson({ [T]: false }), 'new.json')
    const verdict = compareAgainstBaseline(newReport, Array.from({ length: 8 }, (_, i) => ({ outcome: parseCompareReport(i < 7 ? reportJson(baseline()) : reportJson({ [T]: false }), `h${i}.json`) })))
    const text = formatCompareVerdict(verdict, newReport)
    expect(text).toContain(`ALERT: ${T}`)
  })

  it('the formatted verdict says baseline building under thin history', () => {
    const newReport = parse(reportJson({ [T]: false }), 'new.json')
    const text = formatCompareVerdict(compareAgainstBaseline(newReport, []), newReport)
    expect(text).toContain('Baseline building')
  })
})
