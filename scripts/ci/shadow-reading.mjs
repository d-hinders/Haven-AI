#!/usr/bin/env node
// The shadow reading epic #3028 gates slices 3–4 on — taken from the LOG
// STREAM, not from `/health/ops` (#3208).
//
// `GET /health/ops` reports the request-validation plugin's counters, and they
// are in-process: they start at the plugin install (`since`) and dev redeploys
// on every merge to `dev`, several times a day. The 2026-09-21 reading came
// five minutes after a deploy and could not prove a single module (#3028
// decision 8). The same events ride the log stream — one structured pino line
// per would-refusal (`request_validation.would_refuse`), per coerced field
// (`request_validation.would_coerce`) and, since #3208, at most one per route
// per minute carrying the route's running traffic total
// (`request_validation.seen`) — and the log stream survives deploys. This
// script aggregates a window of it into the per-module table the epic asks
// for, and it says NOT PROVEN for a route that saw no traffic instead of
// letting a zero pass as clean.
//
// Every SHADOWED operation is a row — enumerated from
// `route-modules.generated.ts`, not from the lines — so a route that logged
// nothing in the window is printed as NOT PROVEN rather than left out (round
// 1 of PR #3209: a module with ten operations and one `seen` line printed one
// row, "conformant"). Enforced modules (`index.ts` `enforcedModules`, read
// the way the ratchet reads it) refuse for real and log no `seen`; their
// rows say so instead of NOT PROVEN.
//
// Input: JSON lines on stdin (or `--file <path>`). Two shapes are read:
//   - a pino line as the backend writes it: `{"level":30,"time":…,"pid":…,"hostname":…,"msg":"request_validation.seen","event":…,"route":…,"seen":…}`
//   - a Railway wrapper (`railway logs --json`): `{"timestamp":"…","message":"<the pino line as a string>", …}`
// Anything else is skipped and counted under `skipped` — but its timestamp
// still widens the window, so a quiet day reads as the day it was, not as the
// five minutes that carried traffic.
//
// The `seen` line carries a RUNNING TOTAL per PROCESS, so a deploy — or a
// second replica — restarts it. A process is `(hostname, pid)`, which every
// pino line carries; traffic for a route over the window is the sum over
// processes of what each process's lines show. A process whose first line
// in the window is not its boot line started BEFORE the window, and its
// running total counts pre-window requests too; for such a process the
// in-window traffic is `last − first + 1` (the first line counted its own
// request) and the header says how many processes were cut that way. Boot
// lines (`Server listening at`) are counted as `deploys`. Lines are read in
// FILE order for the boot boundary: a `seen` line that precedes its own boot
// line in an unsorted file is counted once as cut traffic and once under
// the booted process — feed the reading in time order, as `railway logs`
// emits it (a concatenated export should be sorted on its timestamp first).
//
// Output: a Markdown table per route module (the same `routes/<file>.ts` key
// the plugin's `enforcedModules` and the ratchet baseline use), one row per
// operation, then the window bounds, line counts, process and deploy counts.
// `--json` prints the same as one object. `--module routes/<file>.ts` limits
// the rows to one module. `--min-window-hours <n>` (default 0) makes the
// script exit 1 — after printing, with a stderr note — when the window is
// narrower than the minimum (24 h by the runbook, unless the epic's slice
// says more), so a five-minute reading cannot pass as a day's in a pipeline.
//
// Never a token in this file: the reader pipes the logs in.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { enforcedModulesFromIndex } from '../lint-request-schemas.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
export const ROUTE_MODULES_PATH = resolve(REPO, 'packages/backend/src/openapi/route-modules.generated.ts')
export const INDEX_PATH = resolve(REPO, 'packages/backend/src/index.ts')

const BOOT_RE = /Server listening at /
const EVENTS = new Set(['request_validation.seen', 'request_validation.would_refuse', 'request_validation.would_coerce'])

/** `METHOD /agents/:id/activity` (the plugin's `route`) → `METHOD /agents/{id}/activity` (the table's key). The trailing-slash twin folds onto its operation. */
export function routeToOperationKey(route) {
  const [method, ...rest] = route.split(' ')
  const path = rest.join(' ').replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\/$/, '') || '/'
  return `${method} ${path}`
}

/** The operation → module table, read from the generated TS without importing it. */
export function readRouteModules(source) {
  const table = {}
  for (const m of source.matchAll(/^\s*"([A-Z]+ [^"]+)":\s*"([^"]+)",?\s*$/gm)) table[m[1]] = m[2]
  return table
}

const timeOf = (obj) =>
  typeof obj.time === 'number' ? obj.time : typeof obj.time === 'string' ? Date.parse(obj.time) : typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : null

/**
 * One parsed line: `{ kind, time, process, … }`. `kind` is `boot`, one of the
 * three events, or `other` (a line that is not ours but may carry a time —
 * it widens the window and nothing else). Null for a line with nothing usable.
 */
export function parseLine(raw) {
  const text = raw.trim()
  if (!text) return null
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    return BOOT_RE.test(text) ? { kind: 'boot', time: null, process: '?:?' } : null
  }
  if (!obj || typeof obj !== 'object') return null
  const time = timeOf(obj)
  const process = `${obj.hostname ?? '?'}:${obj.pid ?? '?'}`
  // A pino line first: a would_refuse line carries its own `message` (the ajv
  // text), which must not be mistaken for a Railway wrapper's `message`.
  if (typeof obj.msg === 'string' && BOOT_RE.test(obj.msg)) return { kind: 'boot', time, process }
  if (typeof obj.event === 'string' && EVENTS.has(obj.event) && typeof obj.route === 'string') {
    return { kind: obj.event, time, process, route: obj.route, field: obj.field, seen: obj.seen }
  }
  if (typeof obj.message === 'string' && obj.event === undefined) {
    // Railway wrapper: the pino line is the message. Its own timestamp is the
    // fallback when the inner line carries none.
    const inner = parseLine(obj.message)
    if (inner === null) return time === null ? null : { kind: 'other', time, process }
    if (inner.time === null) inner.time = time
    return inner
  }
  return time === null ? null : { kind: 'other', time, process }
}

/**
 * The reading. `lines` is the raw log text; `routeModules` the operation →
 * file table; `enforcedModules` the file keys `index.ts` enforces.
 */
export function aggregate(lines, routeModules, enforcedModules = []) {
  let read = 0
  let skipped = 0
  let deploys = 0
  let first = null
  let last = null
  // Per process: whether its boot line was inside the window, and per
  // operation the first and last running totals seen.
  const processes = new Map() // process → { booted, totals: Map(opKey → { first, last }) }
  const proc = (id) => {
    let p = processes.get(id)
    if (!p) {
      p = { booted: false, totals: new Map() }
      processes.set(id, p)
    }
    return p
  }
  const refused = new Map() // opKey → Map(field → n)
  const coerced = new Map()
  for (const raw of lines.split('\n')) {
    if (!raw.trim()) continue
    read += 1
    const ev = parseLine(raw)
    if (!ev) {
      skipped += 1
      continue
    }
    if (ev.time !== null && !Number.isNaN(ev.time)) {
      if (first === null || ev.time < first) first = ev.time
      if (last === null || ev.time > last) last = ev.time
    }
    if (ev.kind === 'other') {
      skipped += 1
      continue
    }
    if (ev.kind === 'boot') {
      deploys += 1
      // A boot line starts a fresh process; a previous process under the same
      // id (pid reuse after a restart on one host) is closed by keeping its
      // totals under a distinct key.
      const p = processes.get(ev.process)
      if (p) processes.set(`${ev.process}#${deploys}`, p)
      processes.set(ev.process, { booted: true, totals: new Map() })
      continue
    }
    const key = routeToOperationKey(ev.route)
    if (ev.kind === 'request_validation.seen') {
      // Per process AND per raw route: the plugin keeps one running total per
      // registered route, so the trailing-slash twin is its own counter and
      // the two are summed into the operation below, never max'ed together.
      const p = proc(ev.process)
      const total = Number(ev.seen) || 0
      const t = p.totals.get(ev.route)
      if (!t) p.totals.set(ev.route, { first: total, last: total })
      else {
        // Order-insensitive: an export that concatenates two streams may
        // hand a process's lines out of time order (round 2 of PR #3209).
        t.first = Math.min(t.first, total)
        t.last = Math.max(t.last, total)
      }
      continue
    }
    const bucket = ev.kind === 'request_validation.would_refuse' ? refused : coerced
    const byField = bucket.get(key) ?? new Map()
    byField.set(ev.field ?? '?', (byField.get(ev.field ?? '?') ?? 0) + 1)
    bucket.set(key, byField)
  }

  // In-window traffic per operation: a booted process contributes its last
  // running total; a process cut by the window contributes `last − first + 1`.
  const seen = new Map()
  let cutProcesses = 0
  for (const p of processes.values()) {
    if (!p.booted && p.totals.size > 0) cutProcesses += 1
    for (const [rawRoute, t] of p.totals) {
      const key = routeToOperationKey(rawRoute)
      const inWindow = p.booted ? t.last : t.last - t.first + 1
      seen.set(key, (seen.get(key) ?? 0) + inWindow)
    }
  }

  const enforced = new Set(enforcedModules)
  const rows = Object.keys(routeModules)
    .sort()
    .map((key) => {
      const module = routeModules[key]
      const s = seen.get(key) ?? 0
      const wouldRefuse = Object.fromEntries([...(refused.get(key) ?? new Map())].sort())
      const wouldCoerce = Object.fromEntries([...(coerced.get(key) ?? new Map())].sort())
      const verdict = enforced.has(module)
        ? 'enforced — refuses for real, nothing to prove'
        : s === 0
          ? 'NOT PROVEN (no traffic)'
          : Object.keys(wouldRefuse).length > 0
            ? 'refusals — classify each line'
            : Object.keys(wouldCoerce).length > 0
              ? 'coercions — classify each field'
              : 'conformant'
      return { module, route: key, seen: s, wouldRefuse, wouldCoerce, verdict }
    })
  // Lines on a route the table does not know: shown so nothing is silently dropped.
  for (const key of new Set([...seen.keys(), ...refused.keys(), ...coerced.keys()])) {
    if (routeModules[key]) continue
    rows.push({
      module: '(unmapped)',
      route: key,
      seen: seen.get(key) ?? 0,
      wouldRefuse: Object.fromEntries([...(refused.get(key) ?? new Map())].sort()),
      wouldCoerce: Object.fromEntries([...(coerced.get(key) ?? new Map())].sort()),
      verdict: 'unmapped — regenerate route-modules.generated.ts',
    })
  }
  const windowHours = first !== null && last !== null ? (last - first) / 3_600_000 : 0
  return {
    window: {
      first: first === null ? null : new Date(first).toISOString(),
      last: last === null ? null : new Date(last).toISOString(),
      hours: Number(windowHours.toFixed(2)),
    },
    lines: { read, skipped },
    deploys,
    processes: processes.size,
    cutProcesses,
    rows,
  }
}

export function renderMarkdown(reading) {
  const out = []
  out.push(
    `Shadow reading${reading.filteredTo ? ` (filtered to \`${reading.filteredTo}\`)` : ''} — window ${reading.window.first ?? '?'} → ${reading.window.last ?? '?'} (${reading.window.hours} h), ${reading.lines.read} lines read (${reading.lines.skipped} not ours), ${reading.deploys} deploy(s), ${reading.processes} process(es) seen, ${reading.cutProcesses} started before the window (their traffic counted from their first line in it).`,
  )
  out.push('')
  out.push('| module | operation | seen | would_refuse (field: n) | would_coerce (field: n) | verdict |')
  out.push('|---|---|---:|---|---|---|')
  const fmt = (o) => Object.entries(o).map(([f, n]) => `${f}: ${n}`).join(', ') || '—'
  for (const r of reading.rows) {
    out.push(`| \`${r.module}\` | \`${r.route}\` | ${r.seen} | ${fmt(r.wouldRefuse)} | ${fmt(r.wouldCoerce)} | ${r.verdict} |`)
  }
  if (reading.rows.length === 0) out.push('| — | — | — | — | — | NOT PROVEN (no operations in the table) |')
  return out.join('\n')
}

function main(argv) {
  const args = argv.slice(2)
  const opt = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const file = opt('--file')
  const moduleFilter = opt('--module')
  const minRaw = opt('--min-window-hours')
  const minHours = minRaw === undefined ? 0 : Number(minRaw)
  if (!Number.isFinite(minHours) || minHours < 0) {
    process.stderr.write(`shadow-reading: --min-window-hours needs a non-negative number, got ${JSON.stringify(minRaw)}.\n`)
    return 2
  }
  const json = args.includes('--json')
  const text = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8')
  const routeModules = readRouteModules(readFileSync(ROUTE_MODULES_PATH, 'utf8'))
  const enforcedModules = enforcedModulesFromIndex(readFileSync(INDEX_PATH, 'utf8'))
  const reading = aggregate(text, routeModules, enforcedModules)
  if (moduleFilter) {
    if (!Object.values(routeModules).includes(moduleFilter)) {
      process.stderr.write(`shadow-reading: --module ${moduleFilter} is not a key in route-modules.generated.ts.\n`)
      return 2
    }
    reading.rows = reading.rows.filter((r) => r.module === moduleFilter)
    reading.filteredTo = moduleFilter
  }
  process.stdout.write((json ? JSON.stringify(reading, null, 2) : renderMarkdown(reading)) + '\n')
  if (reading.window.hours < minHours) {
    process.stderr.write(`shadow-reading: the window is ${reading.window.hours} h, below the ${minHours} h minimum — not a reading to paste.\n`)
    return 1
  }
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv))
}
