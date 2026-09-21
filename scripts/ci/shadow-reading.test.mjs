// The shadow reading's arithmetic and its one rule (#3208): a route with no
// traffic in the window is NOT PROVEN, never clean — and every shadowed
// operation is a row, so silence is printed, not omitted (PR #3209 round 1).
//
// Fixture: two processes on one host across a deploy (running totals restart),
// a second replica, a process cut by the window (its first line is not a boot
// line), refusals on one route, a coercion on another, a route refused but
// never `seen`, a Railway-wrapped line, an unrelated timestamped line that
// widens the window, and junk.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import { aggregate, parseLine, readRouteModules, renderMarkdown, routeToOperationKey, ROUTE_MODULES_PATH } from './shadow-reading.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(HERE, 'shadow-reading.mjs')
const FIXTURE = resolve(HERE, 'fixtures', 'shadow-reading.jsonl')

// A three-module table: x402 has two operations so a silent one shows.
const ROUTE_MODULES = {
  'POST /x402': 'routes/x402.ts',
  'POST /x402/authorize': 'routes/x402.ts',
  'GET /agents/{id}/delegations': 'routes/agent-delegations.ts',
  'POST /payments': 'routes/payments.ts',
  'GET /contacts': 'routes/contacts.ts',
}
const ENFORCED = ['routes/contacts.ts']

const T0 = Date.parse('2026-09-22T00:00:00.000Z')
const H = 3_600_000
const pino = (o) => JSON.stringify({ level: 30, time: o.time, pid: o.pid ?? 100, hostname: o.hostname ?? 'h1', msg: o.event ?? o.msg, ...o })
const wrap = (line, ts) => JSON.stringify({ timestamp: ts, message: line, severity: 'info' })

export function fixture() {
  return [
    // A line that is not ours but carries a time: it widens the window.
    pino({ time: T0, msg: 'incoming request', reqId: 'r1' }),
    // Process h1:100 started BEFORE the window (no boot line): its first
    // in-window total is 500, last 503 → 4 in-window requests, not 503.
    pino({ time: T0 + 6 * H, pid: 100, event: 'request_validation.seen', route: 'POST /x402', seen: 500 }),
    pino({ time: T0 + 7 * H, pid: 100, event: 'request_validation.would_refuse', route: 'POST /x402', field: 'body/settlementScheme', message: 'x' }),
    pino({ time: T0 + 7 * H, pid: 100, event: 'request_validation.seen', route: 'POST /x402', seen: 503 }),
    // A Railway-wrapped line with no inner time takes the wrapper's.
    wrap(pino({ pid: 100, event: 'request_validation.seen', route: 'GET /agents/:id/delegations', seen: 7 }), '2026-09-22T08:00:00.000Z'),
    // Deploy on h1: pid 200 boots inside the window; its totals start fresh.
    pino({ time: T0 + 9 * H, pid: 200, msg: 'Server listening at http://0.0.0.0:3001' }),
    // A second replica boots in the same minute (chronological order, as the
    // CLI emits it — so boot-only segmentation would close h1:200 here).
    pino({ time: T0 + 9 * H, pid: 300, hostname: 'h2', msg: 'Server listening at http://0.0.0.0:3001' }),
    pino({ time: T0 + 10 * H, pid: 200, event: 'request_validation.seen', route: 'POST /x402', seen: 5 }),
    // The trailing-slash twin has its OWN running total in the plugin; the
    // two are summed under one operation.
    pino({ time: T0 + 10 * H, pid: 200, event: 'request_validation.seen', route: 'POST /x402/', seen: 2 }),
    pino({ time: T0 + 10 * H, pid: 200, event: 'request_validation.would_coerce', route: 'GET /agents/:id/delegations', field: 'limit' }),
    // The replica's own running total.
    pino({ time: T0 + 11 * H, pid: 300, hostname: 'h2', event: 'request_validation.seen', route: 'POST /x402', seen: 10 }),
    // Refused but never seen in the window.
    pino({ time: T0 + 12 * H, pid: 200, event: 'request_validation.would_refuse', route: 'POST /payments', field: 'body/amount', message: 'y' }),
    'not json at all',
    // Not ours, timestamped, later than everything: the window ends here.
    JSON.stringify({ level: 30, time: T0 + 24 * H, pid: 200, hostname: 'h1', msg: 'request completed', reqId: 'r2' }),
  ].join('\n') + '\n'
}

describe('shadow-reading (#3208)', () => {
  it('the committed fixture IS the generator\'s output (so the CLI case reads what the unit cases read)', () => {
    assert.equal(readFileSync(FIXTURE, 'utf8'), fixture())
  })

  it('maps the plugin\'s route spelling to the table\'s operation key, twin included', () => {
    assert.equal(routeToOperationKey('GET /agents/:id/delegations'), 'GET /agents/{id}/delegations')
    assert.equal(routeToOperationKey('POST /accounting/webhooks/accounted/:token/'), 'POST /accounting/webhooks/accounted/{token}')
    assert.equal(routeToOperationKey('POST /x402/'), 'POST /x402')
    assert.equal(routeToOperationKey('GET /'), 'GET /')
  })

  it('reads the generated route-module table without importing TypeScript', () => {
    const table = readRouteModules(readFileSync(ROUTE_MODULES_PATH, 'utf8'))
    assert.equal(table['POST /x402'], 'routes/x402.ts')
    assert.ok(Object.keys(table).length > 100)
  })

  it('parses bare pino lines, Railway wrappers and boot lines; a timestamped line that is not ours is `other`; junk is null', () => {
    assert.equal(parseLine('garbage'), null)
    assert.deepEqual(parseLine(pino({ time: 1, msg: 'unrelated' })), { kind: 'other', time: 1, process: 'h1:100' })
    assert.deepEqual(parseLine(pino({ time: 1, msg: 'Server listening at http://0.0.0.0:3001' })), { kind: 'boot', time: 1, process: 'h1:100' })
    const w = parseLine(wrap(pino({ event: 'request_validation.seen', route: 'POST /x402', seen: 3 }), '2026-09-22T09:00:00.000Z'))
    assert.equal(w.kind, 'request_validation.seen')
    assert.equal(w.time, Date.parse('2026-09-22T09:00:00.000Z'))
    // A would_refuse line's own `message` is not a wrapper.
    const r = parseLine(pino({ time: 2, event: 'request_validation.would_refuse', route: 'POST /x402', field: 'f', message: 'ajv text' }))
    assert.equal(r.kind, 'request_validation.would_refuse')
  })

  it('sums seen per PROCESS (hostname:pid) — a cut process counts last−first+1, a booted one its last total, replicas add — and folds the twin', () => {
    const r = aggregate(fixture(), ROUTE_MODULES, ENFORCED)
    const x402 = r.rows.find((x) => x.route === 'POST /x402')
    // h1:100 cut: 503−500+1 = 4; h1:200 booted: 5 on `POST /x402` plus 2 on
    // its twin's own counter = 7; h2:300 booted: 10. Total 4 + 7 + 10 = 21.
    // Mutation: one process for every line (segment by boot line alone) →
    // the replica's boot, which precedes h1:200's lines, closes h1:200's
    // segment → 16 → red.
    assert.equal(x402.seen, 21)
    assert.deepEqual(x402.wouldRefuse, { 'body/settlementScheme': 1 })
    assert.equal(x402.verdict, 'refusals — classify each line')
    assert.equal(r.processes, 3)
    assert.equal(r.cutProcesses, 1)
    assert.equal(r.deploys, 2)
    // Out-of-order lines within a cut process: `first` is the minimum, not
    // the first in file order (531 / 500 / 530 → 32, not 1). Mutation:
    // `first` from file order → 1 → red.
    const shuffled = [531, 500, 530].map((n) => pino({ time: T0 + 1 * H, pid: 900, event: 'request_validation.seen', route: 'POST /payments', seen: n })).join('\n')
    assert.equal(aggregate(shuffled, ROUTE_MODULES, ENFORCED).rows.find((x) => x.route === 'POST /payments').seen, 32)
    // h1:100 is cut and logged ONE line for this route (total 7): the only
    // honest in-window figure is 1 — the request that line counted. The
    // pre-window six are not this window's.
    const del = r.rows.find((x) => x.route === 'GET /agents/{id}/delegations')
    assert.equal(del.seen, 1)
    assert.equal(del.verdict, 'coercions — classify each field')
  })

  it('the window is every timestamped line, not only ours — a quiet day reads as the day it was', () => {
    // First: the `incoming request` line at T0; last: `request completed` at
    // T0+24h; neither is a request_validation line. Mutation: take the window
    // from our lines only → 6 h → red.
    const r = aggregate(fixture(), ROUTE_MODULES, ENFORCED)
    assert.equal(r.window.first, '2026-09-22T00:00:00.000Z')
    assert.equal(r.window.last, '2026-09-23T00:00:00.000Z')
    assert.equal(r.window.hours, 24)
    assert.equal(r.lines.read, 14)
    assert.equal(r.lines.skipped, 3) // junk + the two `other` lines
  })

  it('every shadowed operation is a row: a silent one is NOT PROVEN, never omitted; an enforced module says so instead', () => {
    // `POST /x402/authorize` logged nothing at all; `POST /payments` was
    // refused but never seen. Both are NOT PROVEN. Mutation: build the rows
    // from the lines instead of the table → `/x402/authorize` vanishes → red.
    const r = aggregate(fixture(), ROUTE_MODULES, ENFORCED)
    const auth = r.rows.find((x) => x.route === 'POST /x402/authorize')
    assert.equal(auth.seen, 0)
    assert.equal(auth.verdict, 'NOT PROVEN (no traffic)')
    const pay = r.rows.find((x) => x.route === 'POST /payments')
    assert.equal(pay.seen, 0)
    assert.equal(pay.verdict, 'NOT PROVEN (no traffic)')
    const contacts = r.rows.find((x) => x.route === 'GET /contacts')
    assert.equal(contacts.verdict, 'enforced — refuses for real, nothing to prove')
    assert.equal(r.rows.length, Object.keys(ROUTE_MODULES).length)
    const empty = aggregate('', ROUTE_MODULES, ENFORCED)
    assert.equal(empty.rows.filter((x) => x.verdict === 'NOT PROVEN (no traffic)').length, 4)
    // A route the table does not know is shown, never dropped.
    const stray = aggregate(pino({ time: 1, event: 'request_validation.seen', route: 'GET /nowhere', seen: 1 }), ROUTE_MODULES, ENFORCED)
    assert.equal(stray.rows.find((x) => x.route === 'GET /nowhere').verdict, 'unmapped — regenerate route-modules.generated.ts')
  })

  it('renders the table with the verdict column and the window/process header', () => {
    const md = renderMarkdown(aggregate(fixture(), ROUTE_MODULES, ENFORCED))
    assert.match(md, /window 2026-09-22T00:00:00.000Z → 2026-09-23T00:00:00.000Z \(24 h\), 14 lines read \(3 not ours\), 2 deploy\(s\), 3 process\(es\) seen, 1 started before the window/)
    assert.match(md, /\| `routes\/x402.ts` \| `POST \/x402` \| 21 \| body\/settlementScheme: 1 \| — \| refusals — classify each line \|/)
    assert.match(md, /\| `routes\/x402.ts` \| `POST \/x402\/authorize` \| 0 \| — \| — \| NOT PROVEN \(no traffic\) \|/)
  })

  it('CLI: reads the fixture against the real table, filters by --module, refuses a narrow window and a non-numeric minimum', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--file', FIXTURE, '--json', '--module', 'routes/x402.ts'], { encoding: 'utf8' })
    const r = JSON.parse(out)
    assert.ok(r.rows.length >= 2)
    assert.ok(r.rows.every((x) => x.module === 'routes/x402.ts'))
    assert.equal(r.rows.find((x) => x.route === 'POST /x402').seen, 21)
    // The real table is enforced-aware: contacts is enforced in index.ts.
    const all = JSON.parse(execFileSync(process.execPath, [SCRIPT, '--file', FIXTURE, '--json'], { encoding: 'utf8' }))
    assert.equal(all.rows.find((x) => x.route === 'GET /contacts').verdict, 'enforced — refuses for real, nothing to prove')
    let status = 0
    try {
      execFileSync(process.execPath, [SCRIPT, '--file', FIXTURE, '--min-window-hours', '48'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      status = err.status
      assert.match(String(err.stderr), /below the 48 h minimum/)
    }
    assert.equal(status, 1)
    let bad = 0
    try {
      execFileSync(process.execPath, [SCRIPT, '--file', FIXTURE, '--min-window-hours', 'abc'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      bad = err.status
    }
    assert.equal(bad, 2)
    // A module the table does not know is exit 2, not an empty table; a known
    // one labels the header.
    let unknown = 0
    try {
      execFileSync(process.execPath, [SCRIPT, '--file', FIXTURE, '--module', 'routes/nope.ts'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      unknown = err.status
    }
    assert.equal(unknown, 2)
    assert.match(execFileSync(process.execPath, [SCRIPT, '--file', FIXTURE, '--module', 'routes/x402.ts'], { encoding: 'utf8' }), /^Shadow reading \(filtered to `routes\/x402.ts`\) — window/)
  })
})
