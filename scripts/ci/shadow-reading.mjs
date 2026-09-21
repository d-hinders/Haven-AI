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
// Input: JSON lines on stdin (or `--file <path>`). Two shapes are read:
//   - a pino line as the backend writes it: `{"level":30,"time":…,"msg":"request_validation.seen","event":…,"route":…,"seen":…}`
//   - a Railway wrapper (`railway logs --json`): `{"timestamp":"…","message":"<the pino line as a string>", …}`
// Anything else is skipped and counted under `skipped`.
//
// The `seen` line carries a RUNNING TOTAL per process, so across a deploy the
// total restarts. Traffic for a route over the window is therefore the sum,
// per process segment, of that segment's LAST total — a segment boundary is a
// boot line (`Server listening at`). That is what `deploys` counts, and it is
// why the reading names the window and the deploy count beside every zero.
//
// Output: a Markdown table per route module (the same `routes/<file>.ts` key
// the plugin's `enforcedModules` and the ratchet baseline use, read from
// `packages/backend/src/openapi/route-modules.generated.ts`), then the window
// bounds, line counts and deploy count. `--json` prints the same as one object.
// `--min-window-hours <n>` (default 0) makes the script exit 1 when the window
// is narrower than the runbook's minimum, so a five-minute reading cannot be
// pasted as if it were a day's.
//
// Never a token in this file: the reader pipes the logs in.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
export const ROUTE_MODULES_PATH = resolve(REPO, 'packages/backend/src/openapi/route-modules.generated.ts')

const BOOT_RE = /Server listening at /
const EVENTS = new Set(['request_validation.seen', 'request_validation.would_refuse', 'request_validation.would_coerce'])

/** `METHOD /agents/:id/activity` (the plugin's `route`) → `METHOD /agents/{id}/activity` (the table's key). */
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

/** One parsed event, or null for a line that is not one of ours. */
export function parseLine(raw) {
  const text = raw.trim()
  if (!text) return null
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    return BOOT_RE.test(text) ? { kind: 'boot', time: null } : null
  }
  if (!obj || typeof obj !== 'object') return null
  const time = typeof obj.time === 'number' ? obj.time : typeof obj.time === 'string' ? Date.parse(obj.time) : null
  // A pino line first: a would_refuse line carries its own `message` (the ajv
  // text), which must not be mistaken for a Railway wrapper's `message`.
  if (typeof obj.msg === 'string' && BOOT_RE.test(obj.msg)) return { kind: 'boot', time }
  if (typeof obj.event === 'string' && EVENTS.has(obj.event) && typeof obj.route === 'string') {
    return { kind: obj.event, time, route: obj.route, field: obj.field, seen: obj.seen }
  }
  if (typeof obj.message === 'string' && obj.event === undefined) {
    // Railway wrapper: the pino line is the message. Its own timestamp is the
    // fallback when the inner line carries none.
    const inner = parseLine(obj.message)
    if (inner && inner.time === null && typeof obj.timestamp === 'string') inner.time = Date.parse(obj.timestamp)
    return inner
  }
  return null
}

/**
 * The reading. `lines` is the raw log text; `routeModules` the operation →
 * file table. Returns per-route and per-module aggregates plus the window.
 */
export function aggregate(lines, routeModules) {
  let read = 0
  let skipped = 0
  let deploys = 0
  let first = null
  let last = null
  // seen: per route, the sum over process segments of the segment's last
  // running total. `segmentSeen` holds the current segment's totals.
  const seen = new Map()
  let segmentSeen = new Map()
  const closeSegment = () => {
    for (const [route, total] of segmentSeen) seen.set(route, (seen.get(route) ?? 0) + total)
    segmentSeen = new Map()
  }
  const refused = new Map() // route → Map(field → n)
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
    if (ev.kind === 'boot') {
      deploys += 1
      closeSegment()
      continue
    }
    if (ev.kind === 'request_validation.seen') {
      // A running total: the latest line wins within a segment.
      segmentSeen.set(ev.route, Math.max(segmentSeen.get(ev.route) ?? 0, Number(ev.seen) || 0))
      continue
    }
    const bucket = ev.kind === 'request_validation.would_refuse' ? refused : coerced
    const byField = bucket.get(ev.route) ?? new Map()
    byField.set(ev.field ?? '?', (byField.get(ev.field ?? '?') ?? 0) + 1)
    bucket.set(ev.route, byField)
  }
  closeSegment()

  const routes = new Set([...seen.keys(), ...refused.keys(), ...coerced.keys()])
  const rows = [...routes].sort().map((route) => {
    const key = routeToOperationKey(route)
    const module = routeModules[key] ?? '(unmapped)'
    const s = seen.get(route) ?? 0
    return {
      module,
      route,
      seen: s,
      wouldRefuse: Object.fromEntries([...(refused.get(route) ?? new Map())].sort()),
      wouldCoerce: Object.fromEntries([...(coerced.get(route) ?? new Map())].sort()),
      // The verdict the epic's rule demands: no traffic is no proof.
      verdict: s === 0 ? 'NOT PROVEN (no traffic)' : Object.keys(Object.fromEntries(refused.get(route) ?? new Map())).length === 0 ? 'conformant' : 'refusals — classify each line',
    }
  })
  const windowHours = first !== null && last !== null ? (last - first) / 3_600_000 : 0
  return {
    window: { first: first === null ? null : new Date(first).toISOString(), last: last === null ? null : new Date(last).toISOString(), hours: Number(windowHours.toFixed(2)) },
    lines: { read, skipped },
    deploys,
    rows,
  }
}

export function renderMarkdown(reading) {
  const out = []
  out.push(`Shadow reading — window ${reading.window.first ?? '?'} → ${reading.window.last ?? '?'} (${reading.window.hours} h), ${reading.lines.read} lines read (${reading.lines.skipped} skipped), ${reading.deploys} deploy(s) inside the window.`)
  out.push('')
  out.push('| module | route | seen | would_refuse (field: n) | would_coerce (field: n) | verdict |')
  out.push('|---|---|---:|---|---|---|')
  const fmt = (o) => Object.entries(o).map(([f, n]) => `${f}: ${n}`).join(', ') || '—'
  for (const r of reading.rows) {
    out.push(`| \`${r.module}\` | \`${r.route}\` | ${r.seen} | ${fmt(r.wouldRefuse)} | ${fmt(r.wouldCoerce)} | ${r.verdict} |`)
  }
  if (reading.rows.length === 0) out.push('| — | — | — | — | — | NOT PROVEN (no request_validation lines in the window) |')
  return out.join('\n')
}

function main(argv) {
  const args = argv.slice(2)
  const opt = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const file = opt('--file')
  const minHours = Number(opt('--min-window-hours') ?? 0)
  const json = args.includes('--json')
  const text = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8')
  const routeModules = readRouteModules(readFileSync(ROUTE_MODULES_PATH, 'utf8'))
  const reading = aggregate(text, routeModules)
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
