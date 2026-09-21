// The shadow reading's arithmetic and its one rule (#3208): a route with no
// traffic in the window is NOT PROVEN, never clean. Fixture: two process
// segments (a deploy in the middle), running `seen` totals that restart,
// refusals on one route, a coercion on another, a route that only appears in
// the table because it was refused, Railway-wrapped and bare pino lines mixed.
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

const ROUTE_MODULES = {
  'POST /x402': 'routes/x402.ts',
  'GET /agents/{id}/delegations': 'routes/agent-delegations.ts',
  'POST /payments': 'routes/payments.ts',
}

const pino = (o) => JSON.stringify({ level: 30, time: o.time, msg: o.event ?? o.msg, ...o })
const wrap = (line, ts) => JSON.stringify({ timestamp: ts, message: line, severity: 'info' })

function fixture() {
  const t0 = Date.parse('2026-09-22T06:00:00.000Z')
  const h = 3_600_000
  return [
    pino({ time: t0, msg: 'Server listening at http://0.0.0.0:3001' }),
    pino({ time: t0 + 1 * h, event: 'request_validation.seen', route: 'POST /x402', seen: 1 }),
    pino({ time: t0 + 2 * h, event: 'request_validation.would_refuse', route: 'POST /x402', field: 'body/settlementScheme', message: 'x' }),
    pino({ time: t0 + 2 * h, event: 'request_validation.seen', route: 'POST /x402', seen: 40 }), // running total, this segment
    wrap(pino({ event: 'request_validation.seen', route: 'GET /agents/:id/delegations', seen: 7 }), '2026-09-22T09:00:00.000Z'), // wrapped, no inner time
    pino({ time: t0 + 4 * h, msg: 'Server listening at http://0.0.0.0:3001' }), // deploy: totals restart
    pino({ time: t0 + 5 * h, event: 'request_validation.seen', route: 'POST /x402', seen: 5 }),
    pino({ time: t0 + 5 * h, event: 'request_validation.would_coerce', route: 'GET /agents/:id/delegations', field: 'limit' }),
    pino({ time: t0 + 6 * h, event: 'request_validation.would_refuse', route: 'POST /payments', field: 'body/amount', message: 'y' }),
    'not json at all',
    JSON.stringify({ level: 30, time: t0 + 6 * h, msg: 'unrelated', event: 'something.else' }),
  ].join('\n') + '\n'
}

describe('shadow-reading (#3208)', () => {
  it('the committed fixture IS the generator\'s output (so the CLI case reads what the unit cases read)', () => {
    assert.equal(readFileSync(FIXTURE, 'utf8'), fixture())
  })

  it('maps the plugin\'s route spelling to the table\'s operation key', () => {
    assert.equal(routeToOperationKey('GET /agents/:id/delegations'), 'GET /agents/{id}/delegations')
    assert.equal(routeToOperationKey('POST /accounting/webhooks/accounted/:token/'), 'POST /accounting/webhooks/accounted/{token}')
    assert.equal(routeToOperationKey('GET /'), 'GET /')
  })

  it('reads the generated route-module table without importing TypeScript', () => {
    const table = readRouteModules(readFileSync(ROUTE_MODULES_PATH, 'utf8'))
    assert.equal(table['POST /x402'], 'routes/x402.ts')
    assert.ok(Object.keys(table).length > 100)
  })

  it('parses bare pino lines, Railway wrappers and boot lines; skips the rest', () => {
    assert.equal(parseLine('garbage'), null)
    assert.equal(parseLine(pino({ time: 1, msg: 'unrelated' })), null)
    assert.deepEqual(parseLine(pino({ time: 1, msg: 'Server listening at http://0.0.0.0:3001' })), { kind: 'boot', time: 1 })
    const w = parseLine(wrap(pino({ event: 'request_validation.seen', route: 'POST /x402', seen: 3 }), '2026-09-22T09:00:00.000Z'))
    assert.equal(w.kind, 'request_validation.seen')
    assert.equal(w.time, Date.parse('2026-09-22T09:00:00.000Z'))
  })

  it('sums seen per process segment (a deploy restarts the running total), counts refusals per field, states the window and the deploys', () => {
    const r = aggregate(fixture(), ROUTE_MODULES)
    assert.equal(r.deploys, 2)
    assert.equal(r.lines.read, 11)
    assert.equal(r.lines.skipped, 2)
    assert.equal(r.window.first, '2026-09-22T06:00:00.000Z')
    assert.equal(r.window.last, '2026-09-22T12:00:00.000Z')
    assert.equal(r.window.hours, 6)
    const x402 = r.rows.find((x) => x.route === 'POST /x402')
    // Segment 1's last total (40) + segment 2's (5) — NOT 1 + 40 + 5.
    assert.equal(x402.seen, 45)
    assert.deepEqual(x402.wouldRefuse, { 'body/settlementScheme': 1 })
    assert.equal(x402.module, 'routes/x402.ts')
    assert.equal(x402.verdict, 'refusals — classify each line')
    const del = r.rows.find((x) => x.route === 'GET /agents/:id/delegations')
    assert.equal(del.seen, 7)
    assert.deepEqual(del.wouldCoerce, { limit: 1 })
    assert.equal(del.verdict, 'conformant')
  })

  it('a route that saw no traffic is NOT PROVEN — never clean (the rule the reading exists for)', () => {
    // POST /payments was refused once but logged no `seen` line in the window
    // (its seen line fell outside it), so seen is 0 → not proven. Mutation:
    // derive the verdict from refusals alone (drop the `seen` join) → this
    // route would read as "refusals" and a refusal-free silent route as
    // "conformant" → red.
    const r = aggregate(fixture(), ROUTE_MODULES)
    const pay = r.rows.find((x) => x.route === 'POST /payments')
    assert.equal(pay.seen, 0)
    assert.equal(pay.verdict, 'NOT PROVEN (no traffic)')
    const silent = aggregate(pino({ time: 1, event: 'request_validation.would_coerce', route: 'GET /agents/:id/delegations', field: 'limit' }), ROUTE_MODULES)
    assert.equal(silent.rows[0].verdict, 'NOT PROVEN (no traffic)')
    const empty = aggregate('', ROUTE_MODULES)
    assert.equal(empty.rows.length, 0)
    assert.match(renderMarkdown(empty), /NOT PROVEN \(no request_validation lines in the window\)/)
  })

  it('renders the table with the verdict column and the window line', () => {
    const md = renderMarkdown(aggregate(fixture(), ROUTE_MODULES))
    assert.match(md, /window 2026-09-22T06:00:00.000Z → 2026-09-22T12:00:00.000Z \(6 h\), 11 lines read \(2 skipped\), 2 deploy\(s\)/)
    assert.match(md, /\| `routes\/x402.ts` \| `POST \/x402` \| 45 \| body\/settlementScheme: 1 \| — \| refusals — classify each line \|/)
    assert.match(md, /NOT PROVEN \(no traffic\)/)
  })

  it('CLI: reads the fixture file, and refuses a window narrower than --min-window-hours', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--file', FIXTURE, '--json'], { encoding: 'utf8' })
    const r = JSON.parse(out)
    assert.equal(r.deploys, 2)
    assert.equal(r.rows.find((x) => x.route === 'POST /x402').seen, 45)
    let status = 0
    try {
      execFileSync(process.execPath, [SCRIPT, '--file', FIXTURE, '--min-window-hours', '24'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      status = err.status
      assert.match(String(err.stderr), /below the 24 h minimum/)
    }
    assert.equal(status, 1)
  })
})

