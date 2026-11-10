#!/usr/bin/env node
// Quality-scan re-measurement (#4625) — `.github/workflows/scan-remeasure.yml`.
//
// ## The problem this exists for
//
// The quality-scan ledger (`docs/quality/scan-ledger.md`) records every run's
// `Probed clean` figures, and the skill's exclusion rule depends on
// re-measuring them. Nothing re-ran them between scans, and an instrument that
// keeps printing a plausible number is indistinguishable from one that works:
// block 6's copy-lint glob reached none of the SDK's top-level files and its
// figure was quoted in nine entries (#4611 → #4615); block 2's selector read a
// body example as front matter for two months (#4576).
//
// So the figures and the commands that produce them live in a manifest
// (`docs/quality/scan-baselines.json`), and this runner re-runs every row at
// one SHA and reports what moved. It never judges a finding and never files a
// defect: the weekly job upserts one standing issue, and the next scan starts
// from its table.
//
// ## How a row runs
//
// The SHA is resolved ONCE. A detached worktree is created at it, and each
// row's `command` runs under `bash -c` with its cwd at that worktree, so the
// instruments are that SHA's own scripts (no `node_modules`: the ones the
// manifest calls run dependency-free). The command reads `$SHA` (the full
// commit), `$SCRATCH` (an empty directory of its own) and `$RG` (ripgrep,
// overridable — `process.env.RG ?? 'rg'`). A row that `requires` a tool which
// does not resolve is REFUSED and reported apart, never run: a missing `rg`
// prints `command not found` to stderr and a pipeline then reports `0`
// (`references/dimensions.md`, "prove the tools resolve").
//
// ## The verdict, by `kind`
//
// - `invariant` — any move is flagged (block 5's merge-commit count on a
//   squash-only `dev`).
// - `grows` — growth is expected; a SHRINK is flagged.
// - `head-sample` — redefined by every head (the newest-N shards); never
//   flagged.
// - `count` — flagged when a figure moves past its row's `tolerance`
//   (a relative fraction; 0 is exact).
// - `control` — `expect: nonzero` fails on any zero figure;
//   `expect: no-CONTROL-FAILED-line` fails on a `CONTROL FAILED` line or a
//   non-zero exit. A failed control is listed apart: every figure the same
//   instrument printed is suspect until it passes.
//
// A row that exits non-zero, prints nothing, or prints a different number of
// figures than it recorded is listed under "failed", never compared — a
// missing number is not a zero.
//
// ## Freshness (#4625 item 4, decided here)
//
// The job is NOT registered in `scripts/ci/guard-freshness.mjs`. That registry
// watches guards whose silence hides a money or concurrency failure and
// escalates by opening an issue; this job is advisory and its output is
// itself a standing issue whose "Regenerated …" line dates the last run. A
// scan that finds the table stale is the signal. The gap is accepted here,
// where the next reader of the job will look.
//
// ## Doc figures (#4631)
//
// A count, ratio or percentage quoted in a `status: current` doc either carries
// the command that produced it and the SHA it was taken at and has a row in
// `docFigures`, or is written as a dated reading of the past. A doc row is
// exact — no `kind`, no `tolerance` — and its `sha` is the commit the figures
// were taken at, not the ledger's. The anchor is checked in the SHA's own copy
// of the doc, so a SHA from before the sentence existed reports `anchor not
// found` rather than `unchanged`. `docFigures` is never refreshed by a scan:
// the doc's editor moves `figures` and `sha` in the PR that changes the
// sentence, because refreshing a doc row without touching the doc would mark a
// stale figure unchanged for good.
//
// ## The attention signal
//
// The job stays advisory (exit 0), but a week that needs a reader should not
// wait for one to wander by. `--attention-out <path>` writes a JSON summary —
// `needsAttention` plus the counts behind it — and the full report ends with a
// `Needs attention:` line. Attention means: a row flagged, failed, refused or
// with a failed control, or a doc figure that moved, lost its anchor, failed or
// was refused. `grew`, `within tolerance` and a moving head sample do not. The
// workflow reads the file to label the standing issue and @mention the owner
// (`scan-remeasure.yml`); a quiet week stays silent.
//
// Usage:
//   node scripts/docs/scan-remeasure.mjs --sha <sha> [--scratch <dir>] [--manifest <path>]
//                                        [--doc-figures-only] [--out <path>] [--attention-out <path>]
//
// Exit 0 with the report on stdout, whatever moved (advisory). Exit 2 on a
// usage error, an unreadable manifest or an unresolvable SHA.

import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_MANIFEST = join(REPO_ROOT, 'docs', 'quality', 'scan-baselines.json')
const KINDS = new Set(['invariant', 'grows', 'head-sample', 'count', 'control'])
const EXPECTS = new Set(['nonzero', 'no-CONTROL-FAILED-line'])
/** The keys a doc-figure row may carry; anything else is an exit-2 defect. */
const DOC_FIGURE_KEYS = new Set(['id', 'doc', 'anchor', 'command', 'figures', 'sha', 'requires'])
/** Per-row ceiling: a hung instrument names itself instead of burning the job. */
const ROW_TIMEOUT_MS = 10 * 60 * 1000

/** The reference's wording for a missing tool (`dimensions.md`, "prove the tools resolve"). */
export function refusalLine(tool) {
  return `${tool} missing: every count below would be a broken-instrument zero — stop`
}

export function parseArgs(argv) {
  const out = { sha: null, scratch: null, manifest: DEFAULT_MANIFEST, docFiguresOnly: false, out: null, attentionOut: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      return next
    }
    if (arg === '--sha') out.sha = value()
    else if (arg === '--scratch') out.scratch = value()
    else if (arg === '--manifest') out.manifest = resolve(value())
    else if (arg === '--doc-figures-only') out.docFiguresOnly = true
    else if (arg === '--out') out.out = resolve(value())
    else if (arg === '--attention-out') out.attentionOut = resolve(value())
    else throw new Error(`unknown argument ${arg}`)
  }
  if (!out.sha) throw new Error('--sha <sha> is required')
  return out
}

/** Read and shape-check the manifest; any defect is a thrown error (exit 2). */
export function loadManifest(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(parsed?.rows)) throw new Error(`${path}: no "rows" array`)
  for (const row of parsed.rows) {
    const where = `${path}: row ${row?.id ?? '(no id)'}`
    if (typeof row?.id !== 'string' || !row.id) throw new Error(`${where}: missing id`)
    if (!KINDS.has(row.kind)) throw new Error(`${where}: kind ${row.kind} is not one of ${[...KINDS].join(', ')}`)
    if (typeof row.command !== 'string' || !row.command.includes('$SHA')) {
      throw new Error(`${where}: command must be a string that reads $SHA`)
    }
    if (!Array.isArray(row.figures) || row.figures.some((f) => !Number.isInteger(f))) {
      throw new Error(`${where}: figures must be an array of integers`)
    }
    if (row.kind === 'control' && !EXPECTS.has(row.expect)) {
      throw new Error(`${where}: a control needs expect: ${[...EXPECTS].join(' | ')}`)
    }
  }
  return parsed.rows
}

/**
 * Read and shape-check the manifest's `docFigures` (#4631). Its own loader: a
 * doc row carries no `kind` and no `tolerance`, so an unknown key is an exit-2
 * defect rather than a silently ignored field. A manifest without the array is
 * a manifest with no doc figures, not an error.
 */
export function loadDocFigures(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const rows = parsed?.docFigures
  if (rows === undefined) return []
  if (!Array.isArray(rows)) throw new Error(`${path}: "docFigures" is not an array`)
  for (const row of rows) {
    const where = `${path}: doc figure ${row?.id ?? '(no id)'}`
    if (typeof row?.id !== 'string' || !row.id) throw new Error(`${where}: missing id`)
    for (const key of Object.keys(row)) {
      if (!DOC_FIGURE_KEYS.has(key)) throw new Error(`${where}: unknown key "${key}" (a doc figure carries ${[...DOC_FIGURE_KEYS].join(', ')})`)
    }
    for (const key of ['doc', 'anchor', 'command', 'sha']) {
      if (typeof row[key] !== 'string' || !row[key]) throw new Error(`${where}: "${key}" must be a non-empty string`)
    }
    if (!row.doc.startsWith('docs/')) throw new Error(`${where}: doc must be a path under docs/`)
    if (!row.command.includes('$SHA')) throw new Error(`${where}: command must be a string that reads $SHA`)
    if (!Array.isArray(row.figures) || row.figures.length === 0 || row.figures.some((f) => !Number.isInteger(f))) {
      throw new Error(`${where}: figures must be a non-empty array of integers`)
    }
    if (!Array.isArray(row.requires) || row.requires.some((t) => typeof t !== 'string')) {
      throw new Error(`${where}: requires must be an array of tool names`)
    }
  }
  return rows
}

const normalise = (s) => s.replace(/\s+/g, ' ').trim()

/** How many times `anchor` occurs in `text`, whitespace-normalised. */
export function anchorCount(text, anchor) {
  const a = normalise(anchor)
  if (!a) return 0
  return normalise(text).split(a).length - 1
}

/**
 * Compare one doc row's result to its recording. Returns
 * `{ status: 'unchanged' | 'moved' | 'anchor-not-found' | 'failed', note }`.
 * A doc figure is exact: any difference is `moved`.
 */
export function docFigureVerdict(row, { anchorFound, result }) {
  if (!anchorFound) return { status: 'anchor-not-found', note: 'anchor not found' }
  if (result.timedOut) return { status: 'failed', note: `timed out after ${ROW_TIMEOUT_MS / 60000} min` }
  if (result.code !== 0) return { status: 'failed', note: `exit ${result.code}` }
  if (result.stdout.trim() === '') return { status: 'failed', note: 'printed nothing' }
  const now = parseFigures(result.stdout)
  if (now === null) return { status: 'failed', note: 'printed a line that is not an integer' }
  if (now.length !== row.figures.length) {
    return { status: 'failed', note: `printed ${now.length} figure(s), recorded ${row.figures.length}` }
  }
  result.figures = now
  return now.every((f, i) => f === row.figures[i])
    ? { status: 'unchanged', note: 'unchanged' }
    : { status: 'moved', note: 'moved' }
}

/** The integers a command printed, one per line; null when any line is not one. */
export function parseFigures(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  const figures = []
  for (const line of lines) {
    if (!/^-?\d+$/.test(line)) return null
    figures.push(Number(line))
  }
  return figures
}

/**
 * Compare one row's result to its recording. Returns
 * `{ status: 'ok' | 'flagged' | 'failed' | 'control-failed', note }`.
 */
export function verdict(row, result) {
  if (row.kind === 'control' && row.expect === 'no-CONTROL-FAILED-line') {
    if (result.timedOut) return { status: 'control-failed', note: `timed out after ${ROW_TIMEOUT_MS / 60000} min` }
    if (result.code !== 0) return { status: 'control-failed', note: `exit ${result.code}` }
    if (/CONTROL FAILED/.test(result.stdout)) return { status: 'control-failed', note: 'printed a CONTROL FAILED line' }
    return { status: 'ok', note: 'control passed' }
  }
  if (result.timedOut) return { status: 'failed', note: `timed out after ${ROW_TIMEOUT_MS / 60000} min` }
  if (result.code !== 0) return { status: 'failed', note: `exit ${result.code}` }
  if (result.stdout.trim() === '') return { status: 'failed', note: 'printed nothing' }
  const now = parseFigures(result.stdout)
  if (now === null) return { status: 'failed', note: 'printed a line that is not an integer' }
  if (now.length !== row.figures.length) {
    return { status: 'failed', note: `printed ${now.length} figure(s), recorded ${row.figures.length}` }
  }
  result.figures = now
  const was = row.figures
  switch (row.kind) {
    case 'control':
      return now.some((f) => f === 0)
        ? { status: 'control-failed', note: 'expected non-zero, read 0' }
        : { status: 'ok', note: 'control passed' }
    case 'invariant':
      return now.every((f, i) => f === was[i])
        ? { status: 'ok', note: 'unchanged' }
        : { status: 'flagged', note: 'an invariant moved' }
    case 'grows':
      return now.some((f, i) => f < was[i])
        ? { status: 'flagged', note: 'shrank (expected to grow)' }
        : { status: 'ok', note: now.every((f, i) => f === was[i]) ? 'unchanged' : 'grew' }
    case 'head-sample':
      return { status: 'ok', note: 'head sample (not compared)' }
    default: {
      const tolerance = typeof row.tolerance === 'number' ? row.tolerance : 0
      const moved = now.some((f, i) => Math.abs(f - was[i]) > tolerance * Math.abs(was[i]))
      return moved
        ? { status: 'flagged', note: tolerance ? `moved past ±${tolerance * 100}%` : 'moved (exact)' }
        : { status: 'ok', note: now.every((f, i) => f === was[i]) ? 'unchanged' : 'within tolerance' }
    }
  }
}

function runBash(command, { cwd, env }) {
  return new Promise((done) => {
    execFile('bash', ['-c', command], { cwd, env, timeout: ROW_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      // A killed row names the timeout instead of reading as "exit 1".
      const timedOut = Boolean(err?.killed)
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      done({ code, timedOut, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

/** Does `tool` resolve in bash? `rg` resolves through `$RG`. */
function toolResolves(tool, env) {
  const target = tool === 'rg' ? env.RG : tool
  try {
    execFileSync('bash', ['-c', 'command -v -- "$1" >/dev/null', 'probe', target], { env, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const fmt = (figures) => (figures && figures.length ? figures.join(' / ') : '—')

export function renderReport({ sha, rows, results }) {
  const short = sha.slice(0, 9)
  const lines = []
  lines.push(`Quality-scan re-measurement at \`${short}\` (#4625). Advisory: nothing here is a finding until a scan reads it.`)
  lines.push('')
  lines.push('| block | instrument | kind | recorded @ sha | now @ ' + short + ' | delta | verdict |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const row of rows) {
    const r = results.get(row.id)
    if (r.refused) continue
    const now = r.figures ?? null
    const delta = now && now.length === row.figures.length ? now.map((f, i) => f - row.figures[i]).map((d) => (d > 0 ? `+${d}` : `${d}`)).join(' / ') : '—'
    const mark = r.verdict.status === 'flagged' ? '**flagged** — ' : r.verdict.status === 'ok' ? '' : `**${r.verdict.status}** — `
    lines.push(`| ${row.block} | ${row.name ?? row.id} | ${row.kind} | ${fmt(row.figures)} @ \`${row.sha ?? '?'}\` | ${fmt(now)} | ${delta} | ${mark}${r.verdict.note} |`)
  }
  const list = (title, pick) => {
    const hits = rows.filter((row) => pick(results.get(row.id)))
    lines.push('')
    lines.push(`**${title}:** ${hits.length ? '' : 'none'}`)
    for (const row of hits) {
      const r = results.get(row.id)
      lines.push(`- ${row.id} (block ${row.block}) — ${r.refused ? r.refused : r.verdict.note}${r.stderr ? ` — stderr: ${r.stderr.trim().split('\n').slice(-2).join(' ⏎ ')}` : ''}`)
    }
  }
  list('Failed or printed nothing', (r) => !r.refused && r.verdict.status === 'failed')
  list('Controls that failed their expect', (r) => !r.refused && r.verdict.status === 'control-failed')
  list('Refused for a missing tool', (r) => Boolean(r.refused))
  return lines.join('\n')
}

/**
 * Does this run need a reader? Counts the rows behind the answer; see the
 * docblock's "attention signal" for what counts.
 */
export function attentionSummary({ rows, results, docRows = [], docResults = new Map() }) {
  const summary = { flagged: 0, failed: 0, controlFailed: 0, refused: 0, docMoved: 0, docProblems: 0 }
  for (const row of rows) {
    const r = results.get(row.id)
    if (!r) continue
    if (r.refused) summary.refused++
    else if (r.verdict.status === 'flagged') summary.flagged++
    else if (r.verdict.status === 'failed') summary.failed++
    else if (r.verdict.status === 'control-failed') summary.controlFailed++
  }
  for (const row of docRows) {
    const r = docResults.get(row.id)
    if (!r) continue
    if (r.refused || r.verdict.status === 'anchor-not-found' || r.verdict.status === 'failed') summary.docProblems++
    else if (r.verdict.status === 'moved') summary.docMoved++
  }
  const needsAttention = Object.values(summary).some((n) => n > 0)
  return { needsAttention, ...summary }
}

/** The report's last line: what needs a reader, or `no`. */
export function attentionLine(summary) {
  if (!summary.needsAttention) return '**Needs attention:** no'
  const parts = [
    [summary.flagged, 'flagged'],
    [summary.failed, 'failed'],
    [summary.controlFailed, 'control failed'],
    [summary.refused, 'refused'],
    [summary.docMoved, 'doc figure moved'],
    [summary.docProblems, 'doc figure failed or lost its anchor'],
  ]
    .filter(([n]) => n > 0)
    .map(([n, what]) => `${n} ${what}`)
  return `**Needs attention:** yes — ${parts.join(', ')}`
}

/**
 * The doc-figure section (#4631). Plain lines, not a markdown table:
 * `docs-audit.yml` wraps its report in a code fence, and a table inside a fence
 * is unreadable in the issue body.
 */
export function renderDocFigures({ sha, rows, results }) {
  const short = sha.slice(0, 9)
  const lines = []
  lines.push(
    `Doc figures that moved (#4631) at \`${short}\`. Advisory: a moved figure is refreshed in the doc (figures + \`sha\` in the row) or rewritten as a dated reading — never \`last-verified\` alone.`,
  )
  lines.push('')
  if (!rows.length) {
    lines.push('none recorded')
    return lines.join('\n')
  }
  for (const row of rows) {
    const r = results.get(row.id)
    if (r.refused) {
      lines.push(`${row.doc} · ${row.id} · refused — ${r.refused}`)
      continue
    }
    const now = r.figures ?? null
    const verdict = r.verdict.status === 'anchor-not-found' ? 'anchor not found' : r.verdict.status
    const note = r.verdict.status === 'failed' ? ` — ${r.verdict.note}` : ''
    lines.push(
      `${row.doc} · ${row.id} · recorded ${fmt(row.figures)} @ \`${row.sha}\` · now ${fmt(now)} @ \`${short}\` · ${verdict}${note}`,
    )
  }
  return lines.join('\n')
}

export async function remeasure({ sha, scratch, manifest, docFiguresOnly = false, out = null, attentionOut = null }) {
  const rows = docFiguresOnly ? [] : loadManifest(manifest)
  const docRows = loadDocFigures(manifest)
  let full
  try {
    full = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--verify', `${sha}^{commit}`], { encoding: 'utf8' }).trim()
  } catch {
    throw new Error(`cannot resolve ${sha} to a commit in ${REPO_ROOT} (shallow clone?)`)
  }
  const ownScratch = !scratch
  // Create before resolving: the workflow passes a `$RUNNER_TEMP` path that
  // does not exist yet, and `realpathSync` refuses a missing path.
  if (scratch) mkdirSync(scratch, { recursive: true })
  const base = realpathSync(scratch ?? mkdtempSync(join(tmpdir(), 'scan-remeasure-')))
  const tree = join(base, `tree-${full.slice(0, 12)}`)
  if (existsSync(tree)) throw new Error(`${tree} already exists — pass an empty --scratch`)
  try {
    execFileSync('git', ['-C', REPO_ROOT, 'worktree', 'add', '--detach', '--quiet', tree, full], { stdio: ['ignore', 'ignore', 'inherit'] })
  } catch (err) {
    if (ownScratch) rmSync(base, { recursive: true, force: true })
    throw err
  }
  const results = new Map()
  const docResults = new Map()
  try {
    const env = { ...process.env, SHA: full, RG: process.env.RG ?? 'rg' }
    for (const row of rows) {
      const missing = (row.requires ?? []).filter((tool) => !toolResolves(tool, env))
      if (missing.length) {
        results.set(row.id, { refused: missing.map(refusalLine).join('; ') })
        continue
      }
      const rowScratch = join(base, 'rows', row.id)
      mkdirSync(rowScratch, { recursive: true })
      const result = await runBash(row.command, { cwd: tree, env: { ...env, SCRATCH: rowScratch } })
      result.verdict = verdict(row, result)
      results.set(row.id, result)
    }
    for (const row of docRows) {
      const missing = (row.requires ?? []).filter((tool) => !toolResolves(tool, env))
      if (missing.length) {
        docResults.set(row.id, { refused: missing.map(refusalLine).join('; ') })
        continue
      }
      // The anchor is checked in THIS SHA's copy of the doc, so a SHA from
      // before the sentence existed reports `anchor not found`, never
      // `unchanged`.
      let text = null
      try {
        text = readFileSync(join(tree, row.doc), 'utf8')
      } catch {
        text = null
      }
      const anchorFound = text !== null && anchorCount(text, row.anchor) === 1
      if (!anchorFound) {
        docResults.set(row.id, { verdict: { status: 'anchor-not-found', note: 'anchor not found' } })
        continue
      }
      const rowScratch = join(base, 'rows', row.id)
      mkdirSync(rowScratch, { recursive: true })
      const result = await runBash(row.command, { cwd: tree, env: { ...env, SCRATCH: rowScratch } })
      result.verdict = docFigureVerdict(row, { anchorFound, result })
      docResults.set(row.id, result)
    }
  } finally {
    // A cleanup failure must not replace the report: say so on stderr.
    try {
      execFileSync('git', ['-C', REPO_ROOT, 'worktree', 'remove', '--force', tree], { stdio: 'ignore' })
    } catch (err) {
      console.error(`scan-remeasure: could not remove the worktree ${tree}: ${err.message}`)
    }
    if (ownScratch) rmSync(base, { recursive: true, force: true })
  }
  const docSection = renderDocFigures({ sha: full, rows: docRows, results: docResults })
  const attention = attentionSummary({ rows, results, docRows, docResults })
  // The doc-figures-only report (docs-audit.yml) keeps its own shape.
  const report = docFiguresOnly
    ? docSection
    : `${renderReport({ sha: full, rows, results })}\n\n${docSection}\n\n${attentionLine(attention)}`
  if (out) writeFileSync(out, `${report}\n`)
  if (attentionOut) writeFileSync(attentionOut, `${JSON.stringify({ sha: full, ...attention })}\n`)
  return report
}

// True only when this file is the process's entry point, so importing it (a
// self-test, a build config) never runs the CLI. Both paths are resolved
// before they are compared: Node resolves symlinks for a module's own URL and
// not for `process.argv[1]`, so an unresolved comparison is false through any
// symlink, and the script would exit 0 without running (#4776).
function isEntryPoint() {
  if (!process.argv[1]) return false
  try {
    const { realpathSync } = process.getBuiltinModule('node:fs')
    const { fileURLToPath } = process.getBuiltinModule('node:url')
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`scan-remeasure: ${err.message}`)
    console.error(
      'usage: node scripts/docs/scan-remeasure.mjs --sha <sha> [--scratch <dir>] [--manifest <path>] [--doc-figures-only] [--out <path>] [--attention-out <path>]',
    )
    process.exit(2)
  }
  remeasure(args).then(
    (report) => {
      console.log(report)
    },
    (err) => {
      console.error(`scan-remeasure: ${err.message}`)
      process.exit(2)
    },
  )
}
