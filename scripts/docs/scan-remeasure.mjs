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
// Usage:
//   node scripts/docs/scan-remeasure.mjs --sha <sha> [--scratch <dir>] [--manifest <path>]
//
// Exit 0 with the report on stdout, whatever moved (advisory). Exit 2 on a
// usage error, an unreadable manifest or an unresolvable SHA.

import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_MANIFEST = join(REPO_ROOT, 'docs', 'quality', 'scan-baselines.json')
const KINDS = new Set(['invariant', 'grows', 'head-sample', 'count', 'control'])
const EXPECTS = new Set(['nonzero', 'no-CONTROL-FAILED-line'])
/** Per-row ceiling: a hung instrument names itself instead of burning the job. */
const ROW_TIMEOUT_MS = 10 * 60 * 1000

/** The reference's wording for a missing tool (`dimensions.md`, "prove the tools resolve"). */
export function refusalLine(tool) {
  return `${tool} missing: every count below would be a broken-instrument zero — stop`
}

export function parseArgs(argv) {
  const out = { sha: null, scratch: null, manifest: DEFAULT_MANIFEST }
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
    if (result.code !== 0) return { status: 'control-failed', note: `exit ${result.code}` }
    if (/CONTROL FAILED/.test(result.stdout)) return { status: 'control-failed', note: 'printed a CONTROL FAILED line' }
    return { status: 'ok', note: 'control passed' }
  }
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
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      done({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
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

export async function remeasure({ sha, scratch, manifest }) {
  const rows = loadManifest(manifest)
  let full
  try {
    full = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--verify', `${sha}^{commit}`], { encoding: 'utf8' }).trim()
  } catch {
    throw new Error(`cannot resolve ${sha} to a commit in ${REPO_ROOT} (shallow clone?)`)
  }
  const ownScratch = !scratch
  const base = realpathSync(scratch ?? mkdtempSync(join(tmpdir(), 'scan-remeasure-')))
  mkdirSync(base, { recursive: true })
  const tree = join(base, `tree-${full.slice(0, 12)}`)
  if (existsSync(tree)) throw new Error(`${tree} already exists — pass an empty --scratch`)
  execFileSync('git', ['-C', REPO_ROOT, 'worktree', 'add', '--detach', '--quiet', tree, full], { stdio: ['ignore', 'ignore', 'inherit'] })
  const results = new Map()
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
  } finally {
    execFileSync('git', ['-C', REPO_ROOT, 'worktree', 'remove', '--force', tree], { stdio: 'ignore' })
    if (ownScratch) rmSync(base, { recursive: true, force: true })
  }
  return renderReport({ sha: full, rows, results })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`scan-remeasure: ${err.message}`)
    console.error('usage: node scripts/docs/scan-remeasure.mjs --sha <sha> [--scratch <dir>] [--manifest <path>]')
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
