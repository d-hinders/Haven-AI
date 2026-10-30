// The release closeout's log check (#4542): the evidence must be bound to the
// promotion's merge SHA, and every way of NOT having that evidence must fail
// loudly rather than read as a clean absence.
//
// The three cases the issue names are fixtures here — an injected RPC warning,
// an empty/truncated log, and a stale process — plus the identity failures
// (wrong commit, no GitHub deployment, a deployment that never ran) and the
// run-failure paths (CLI missing, not logged in), which must exit 2 with the
// pointer to the manual check rather than exit 1 as a failed check.
//
// The last block pins the manual check in `promoting-dev-to-main.md` to this
// script's constants: the two paths reach the same verdict, so they cannot
// disagree about what they are looking for.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BOOT_MARKERS,
  MANUAL_CHECK_POINTER,
  MIGRATION_APPLIED_PREFIX,
  PRODUCTION_ENVIRONMENT,
  RAILWAY_PAGE_CAP,
  REPORT_FIELDS,
  RPC_WARNING_MARKER,
  classify,
  parseLogLine,
  parseRailwayEnvironmentUrl,
  renderReport,
} from './release-closeout-log.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(HERE, 'release-closeout-log.mjs')
const FIXTURES = resolve(HERE, 'fixtures', 'release-closeout-log')
const DOC = resolve(HERE, '..', '..', 'docs', 'operations', 'promoting-dev-to-main.md')

const SHA = '454cf6d0e41d0388e90ee601e6a01d6d383c9003'
const CREATED = Date.parse('2026-10-29T14:47:34.122Z')
const WINDOW_END = CREATED + 30 * 60_000
const ENVIRONMENT_URL =
  'https://railway.com/project/81263b9e-2461-47f0-9771-c554a1f9ed52?environmentId=8efe99c5-d178-4eaa-bf76-a2495ffb4716'

const GITHUB = {
  id: 7409904028,
  environment: PRODUCTION_ENVIRONMENT,
  sha: SHA,
  createdAt: CREATED,
  status: { state: 'success', createdAt: Date.parse('2026-10-29T14:48:22Z'), environmentUrl: ENVIRONMENT_URL },
}
const RAILWAY = {
  id: '6c1dac88-5ce3-4046-8313-fc664fd27d28',
  status: 'SUCCESS',
  createdAt: CREATED,
  commitHash: SHA,
}

const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8')
const clean = () => fixture('clean.jsonl')
const verdict = (overrides = {}) =>
  classify({ sha: SHA, github: GITHUB, railway: RAILWAY, windowEnd: WINDOW_END, lines: clean(), ...overrides })

describe('classify — the evidence that passes', () => {
  it('states the SHA, the last applied migration and zero warnings', () => {
    const r = verdict()
    assert.equal(r.verdict, 'pass')
    assert.deepEqual(r.failures, [])
    assert.equal(r.sha, SHA)
    assert.equal(r.github.id, GITHUB.id)
    assert.equal(r.railway.id, RAILWAY.id)
    assert.equal(r.migrations.last, '117_merchant_catalog_source')
    assert.deepEqual(r.migrations.applied, ['116_owner_transfers', '117_merchant_catalog_source'])
    assert.equal(r.rpcWarnings.length, 0)
    assert.equal(r.lines.truncated, false)
    for (const marker of BOOT_MARKERS) {
      const row = r.boot.find((b) => b.marker === marker)
      assert.ok(row.at, `"${marker}" should carry a timestamp`)
    }
  })

  it('renders every field the manual check records', () => {
    const report = renderReport(verdict())
    for (const field of REPORT_FIELDS) assert.ok(report.includes(field), `report is missing "${field}"`)
    assert.ok(report.includes('verdict: PASS'))
  })

  it('accepts a deployment that ran and was later superseded', () => {
    const r = verdict({ railway: { ...RAILWAY, status: 'REMOVED' } })
    assert.equal(r.verdict, 'pass')
  })
})

describe('classify — the three cases the issue names', () => {
  it('fails on an injected RPC warning, naming the line', () => {
    const r = verdict({ lines: fixture('rpc-warning.jsonl') })
    assert.equal(r.verdict, 'fail')
    assert.equal(r.rpcWarnings.length, 1)
    assert.ok(r.rpcWarnings[0].message.includes(RPC_WARNING_MARKER))
    assert.ok(r.failures.some((f) => f.includes('unset public-RPC warning')))
  })

  it('fails on an empty log instead of reading the absence as clean', () => {
    const r = verdict({ lines: fixture('empty.jsonl') })
    assert.equal(r.verdict, 'fail')
    assert.equal(r.lines.read, 0)
    assert.ok(r.failures.some((f) => f.includes('the log is empty')))
    assert.ok(r.failures.some((f) => f.includes(BOOT_MARKERS[0])))
    assert.ok(renderReport(r).includes('unset public-RPC warnings: unknown'))
  })

  it('fails on a log truncated at Railway’s page cap', () => {
    const lines = Array.from({ length: RAILWAY_PAGE_CAP }, (_, i) =>
      JSON.stringify({
        message: i === 1 ? BOOT_MARKERS[0] : i === 2 ? BOOT_MARKERS[1] : 'incoming request',
        timestamp: new Date(CREATED + 30_000 + i).toISOString(),
        level: 'info',
      }),
    ).join('\n')
    const r = verdict({ lines })
    assert.equal(r.verdict, 'fail')
    assert.equal(r.lines.truncated, true)
    assert.ok(r.failures.some((f) => f.includes('page cap')))
  })

  it('fails on a stale process whose boot markers predate the deployment', () => {
    const r = verdict({ lines: fixture('stale.jsonl') })
    assert.equal(r.verdict, 'fail')
    for (const marker of BOOT_MARKERS) {
      assert.ok(
        r.failures.some((f) => f.includes(marker) && f.includes('stale process')),
        `"${marker}" should be reported as a stale process`,
      )
    }
  })
})

describe('classify — the identity binding', () => {
  it('fails when the Railway deployment carries a different commit', () => {
    const r = verdict({ railway: { ...RAILWAY, commitHash: 'a'.repeat(40) } })
    assert.equal(r.verdict, 'fail')
    assert.ok(r.failures.some((f) => f.includes('carries commit')))
  })

  it('fails when GitHub has no production deployment for the SHA', () => {
    const r = verdict({ github: null })
    assert.equal(r.verdict, 'fail')
    assert.ok(r.failures.some((f) => f.includes('never reached production')))
  })

  it('fails when the GitHub deployment never succeeded', () => {
    const r = verdict({ github: { ...GITHUB, status: { ...GITHUB.status, state: 'failure' } } })
    assert.equal(r.verdict, 'fail')
    assert.ok(r.failures.some((f) => f.includes('no successful status')))
  })

  it('fails when the Railway deployment never ran', () => {
    const r = verdict({ railway: { ...RAILWAY, status: 'FAILED' } })
    assert.equal(r.verdict, 'fail')
    assert.ok(r.failures.some((f) => f.includes('not a state in which it ran')))
  })

  it('fails when the log is not the JSON lines railway emits', () => {
    const r = verdict({ lines: 'not json\nstill not json\n' })
    assert.equal(r.verdict, 'fail')
    assert.ok(r.failures.some((f) => f.includes('no readable lines')))
  })
})

describe('parseLogLine', () => {
  it('reads a pino line, preferring the process clock over the ingest time', () => {
    const p = parseLogLine(
      JSON.stringify({ time: CREATED, timestamp: '2026-10-29T14:48:04.660Z', message: 'x', pid: 1, hostname: 'h' }),
    )
    assert.equal(p.time, CREATED)
    assert.equal(p.message, 'x')
    assert.equal(p.pid, 1)
  })

  it('falls back to the Railway ingest timestamp', () => {
    const p = parseLogLine(JSON.stringify({ timestamp: '2026-10-29T14:48:04.660Z', message: 'x' }))
    assert.equal(p.time, Date.parse('2026-10-29T14:48:04.660Z'))
  })

  it('keeps a plain-text line with no time', () => {
    const p = parseLogLine('Starting Container')
    assert.equal(p.time, null)
    assert.equal(p.message, 'Starting Container')
  })
})

describe('parseRailwayEnvironmentUrl', () => {
  it('reads the project and environment ids', () => {
    assert.deepEqual(parseRailwayEnvironmentUrl(ENVIRONMENT_URL), {
      projectId: '81263b9e-2461-47f0-9771-c554a1f9ed52',
      environmentId: '8efe99c5-d178-4eaa-bf76-a2495ffb4716',
    })
  })

  it('returns null rather than guessing', () => {
    assert.equal(parseRailwayEnvironmentUrl('https://railway.com/project/x'), null)
    assert.equal(parseRailwayEnvironmentUrl(undefined), null)
  })
})

// --- the CLI, against stubbed `gh` and `railway` binaries -------------------

const GH_STUB = `#!/bin/sh
dump() { while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; done < "$1"; }
case "$*" in
  *"/statuses"*) dump "$STUB_DIR/statuses.json" ;;
  *"/deployments?"*) dump "$STUB_DIR/deployments.json" ;;
  *"pr view"*) dump "$STUB_DIR/pr.json" ;;
  *) echo "gh stub: unexpected args: $*" >&2; exit 1 ;;
esac
`
const RAILWAY_STUB = `#!/bin/sh
dump() { while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; done < "$1"; }
case "$1" in
  deployment) dump "$STUB_DIR/railway-deployments.json" ;;
  logs) dump "$STUB_DIR/logs.jsonl" ;;
  *) echo "railway stub: unexpected args: $*" >&2; exit 1 ;;
esac
`
const RAILWAY_LOGGED_OUT = `#!/bin/sh
echo "Unauthorized. Please run railway login to authenticate." >&2
exit 1
`

function stubWorld({ gh = GH_STUB, railway = RAILWAY_STUB, logs = clean(), statuses } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'closeout-'))
  const bin = join(dir, 'bin')
  const write = (path, body, mode) => {
    writeFileSync(path, body)
    if (mode) chmodSync(path, mode)
  }
  write(join(dir, 'deployments.json'), JSON.stringify([
    { id: GITHUB.id, environment: PRODUCTION_ENVIRONMENT, sha: SHA, created_at: '2026-10-29T10:34:23Z' },
  ]))
  write(join(dir, 'statuses.json'), JSON.stringify(statuses ?? [
    { state: 'in_progress', created_at: '2026-10-29T10:34:24Z', environment_url: ENVIRONMENT_URL },
    { state: 'success', created_at: '2026-10-29T14:48:22Z', environment_url: ENVIRONMENT_URL },
  ]))
  write(join(dir, 'railway-deployments.json'), JSON.stringify([
    { id: RAILWAY.id, status: 'SUCCESS', createdAt: '2026-10-29T14:47:34.122Z', meta: { commitHash: SHA } },
  ]))
  write(join(dir, 'pr.json'), JSON.stringify({ state: 'MERGED', mergeCommit: { oid: SHA } }))
  write(join(dir, 'logs.jsonl'), logs)
  // A PATH with only the stubs in it: `gh`/`railway` resolve there or not at all.
  mkdirSync(bin, { recursive: true })
  if (gh) write(join(bin, 'gh'), gh, 0o755)
  if (railway) write(join(bin, 'railway'), railway, 0o755)
  return { bin, dir }
}

function runCli(args, world) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: world.bin, STUB_DIR: world.dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    return { code: err.status, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' }
  }
}

describe('CLI', () => {
  it('passes end to end and prints the report', () => {
    const res = runCli(['--sha', SHA], stubWorld())
    assert.equal(res.code, 0, res.stderr)
    for (const field of REPORT_FIELDS) assert.ok(res.stdout.includes(field), `missing "${field}"`)
    assert.ok(res.stdout.includes('verdict: PASS'))
  })

  it('resolves --pr to the promotion merge commit', () => {
    const res = runCli(['--pr', '4527'], stubWorld())
    assert.equal(res.code, 0, res.stderr)
    assert.ok(res.stdout.includes(`promotion merge SHA: ${SHA}`))
  })

  it('exits 1 when the check fails, and still prints what failed', () => {
    const res = runCli(['--sha', SHA], stubWorld({ logs: fixture('rpc-warning.jsonl') }))
    assert.equal(res.code, 1)
    assert.ok(res.stdout.includes('verdict: FAIL'))
    assert.ok(res.stdout.includes('unset public-RPC warning'))
  })

  it('exits 2 with the manual-check pointer when the Railway CLI is missing', () => {
    const res = runCli(['--sha', SHA], stubWorld({ railway: null }))
    assert.equal(res.code, 2)
    assert.ok(res.stderr.includes('the Railway CLI is not installed'))
    assert.ok(res.stderr.includes(MANUAL_CHECK_POINTER))
  })

  it('exits 2 with the manual-check pointer when Railway is not logged in', () => {
    const res = runCli(['--sha', SHA], stubWorld({ railway: RAILWAY_LOGGED_OUT }))
    assert.equal(res.code, 2)
    assert.ok(res.stderr.includes('railway login'))
    assert.ok(res.stderr.includes(MANUAL_CHECK_POINTER))
  })

  it('exits 2 with the manual-check pointer when gh is missing', () => {
    const res = runCli(['--sha', SHA], stubWorld({ gh: null }))
    assert.equal(res.code, 2)
    assert.ok(res.stderr.includes('the `gh` CLI is not installed'))
    assert.ok(res.stderr.includes(MANUAL_CHECK_POINTER))
  })

  it('exits 2 when the GitHub deployment carries no Railway environment URL', () => {
    const res = runCli(
      ['--sha', SHA],
      stubWorld({ statuses: [{ state: 'success', created_at: '2026-10-29T14:48:22Z' }] }),
    )
    assert.equal(res.code, 2)
    assert.ok(res.stderr.includes('no Railway project/environment URL'))
    assert.ok(res.stderr.includes(MANUAL_CHECK_POINTER))
  })

  it('exits 2 when neither --sha nor --pr is given', () => {
    const res = runCli([], stubWorld())
    assert.equal(res.code, 2)
    assert.ok(res.stderr.includes(MANUAL_CHECK_POINTER))
  })
})

// --- the manual check cannot drift from the script --------------------------

function manualCheckSection() {
  const text = readFileSync(DOC, 'utf8')
  const start = text.indexOf('Manual check in the Railway web UI')
  assert.ok(start >= 0, 'promoting-dev-to-main.md has no "Manual check in the Railway web UI" section')
  const rest = text.slice(start)
  const end = rest.search(/\n#{2,3} /)
  return end >= 0 ? rest.slice(0, end) : rest
}

describe('the manual check matches the script', () => {
  it('names the same boot markers, migration prefix and RPC warning', () => {
    const section = manualCheckSection()
    for (const marker of BOOT_MARKERS) assert.ok(section.includes(marker), `manual check is missing "${marker}"`)
    assert.ok(section.includes(MIGRATION_APPLIED_PREFIX.trim()), 'manual check is missing the migration line prefix')
    assert.ok(section.includes(RPC_WARNING_MARKER), 'manual check is missing the RPC warning text')
  })

  it('records the result in the same shape the script prints', () => {
    const section = manualCheckSection()
    for (const field of REPORT_FIELDS) assert.ok(section.includes(field), `manual check is missing "${field}"`)
  })
})
