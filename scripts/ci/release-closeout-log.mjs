#!/usr/bin/env node
// Release closeout — machine-read the two production log checks (#4542).
//
// `promoting-dev-to-main.md` § *Merge, deploy, and verify prod* requires two
// reads of the production deploy log after a promotion: the migrations applied,
// and the ABSENCE of the unset-public-RPC warning. Until #4542 both were
// screenshot reads, and a screenshot cannot carry the one thing that makes
// either check mean anything: WHICH deployment it came from.
//
// Two ways that fails silently, both measured on this repo:
//
//   - `runMigrations()` runs before `listen()` (`packages/backend/src/index.ts`),
//     so a migration that fails means the new process never serves. Railway
//     keeps the previous deployment live, and `railway logs` with no deployment
//     id defaults to "most recent successful deployment" — the OLD process. A
//     read of that log passes while the promotion is broken.
//   - The RPC standard is an ABSENCE. An empty log, a truncated page, or the
//     wrong deployment's log all satisfy "no warning line" without proving
//     anything.
//
// So this script binds the evidence to the promotion's merge SHA twice, from
// two independent streams:
//
//   1. GitHub's own `deployment_status` stream for `Haven AI / production`
//      (credential-free: `gh` reads it with the operator's existing login).
//      The deployment record's `sha` must equal the promotion merge SHA and
//      carry a `success` status. Its `environment_url` names the Railway
//      project and environment, so the log read is aimed at the environment
//      GitHub recorded — not at whatever the operator's directory is linked to.
//   2. Railway's deployment list for that project/environment: the deployment
//      whose `meta.commitHash` equals the SHA, newest SUCCESS. Its id is passed
//      to `railway logs`, so the log is that deployment's own — never "the most
//      recent successful one".
//
// Then, inside that deployment's boot window, the script requires the POSITIVE
// markers ("Database migrations complete", "Haven backend running on port"),
// reports the last `[migrate] applied <version>` line, and only then counts the
// unset-public-RPC warnings (0 expected).
//
// No token enters the repo: `gh` uses the operator's GitHub login and `railway`
// uses the operator's Railway login. That is the owner's design (c) on #4542.
//
// Usage:
//   node scripts/ci/release-closeout-log.mjs --pr 4527
//   node scripts/ci/release-closeout-log.mjs --sha 454cf6d0e41d0388e90ee601e6a01d6d383c9003
//   node scripts/ci/release-closeout-log.mjs --sha <sha> --file saved.jsonl   # re-read a saved log
//   node scripts/ci/release-closeout-log.mjs --sha <sha> --json
//
// Exit codes:
//   0  the check passed
//   1  the check FAILED — the evidence does not support the verdict (wrong
//      deployment, missing boot marker, RPC warning present, empty/truncated log)
//   2  the check could not RUN — CLI missing, not logged in, no access,
//      unreadable output. Prints a one-line pointer to the manual check.
//
// The manual check in `promoting-dev-to-main.md` reaches the same verdict in
// the Railway web UI. Its strings are pinned to this file's constants by
// `release-closeout-log.test.mjs`, so the two paths cannot disagree.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/** The GitHub deployment environment Railway creates for production. */
export const PRODUCTION_ENVIRONMENT = 'Haven AI / production'
/** The Railway service the backend deploys as. */
export const PRODUCTION_SERVICE = '@haven/backend'
/** The two POSITIVE boot markers, in the order the process writes them. */
export const BOOT_MARKERS = ['Database migrations complete', 'Haven backend running on port']
/** `db/migrate.ts` writes one of these per migration it applies. */
export const MIGRATION_APPLIED_PREFIX = '[migrate] applied '
/** `warnPublicRpc` (`config.ts`) writes this when a dedicated RPC URL is unset. */
export const RPC_WARNING_MARKER = 'is not set — using the PUBLIC endpoint'
/** How long after the deployment starts the boot is expected to finish. */
export const DEFAULT_WINDOW_MINUTES = 30
/** `railway logs` caps a page at 500 lines whatever `--since` says. */
export const RAILWAY_PAGE_CAP = 500
/**
 * Railway states in which the deployment actually ran. `REMOVED` is a
 * deployment that ran and was later superseded — the normal state of a
 * promotion's deployment by the time anyone re-reads it. The boot markers, not
 * the state, are the proof that it served; a deployment removed before it
 * finished building has no markers and fails on that.
 */
export const RAN_STATES = new Set(['SUCCESS', 'REMOVED'])
/** Clock skew allowed between Railway's deployment record and its log lines. */
export const SKEW_MS = 60_000
/** The labels the report prints — the manual check records the same shape. */
export const REPORT_FIELDS = [
  'promotion merge SHA',
  'GitHub deployment',
  'Railway deployment',
  'log window',
  'boot markers',
  'last applied migration',
  'unset public-RPC warnings',
  'verdict',
]
/** Printed on every exit-2 path: the fallback that reaches the same verdict. */
export const MANUAL_CHECK_POINTER =
  'Manual check: docs/operations/promoting-dev-to-main.md § Merge, deploy, and verify prod → "Manual check in the Railway web UI".'

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString())

/**
 * One log line. `railway logs --json` emits the pino object itself (not a
 * wrapper): `{"hostname","pid","level","timestamp","time","message",…}`.
 * `time` is the process's own ms clock; `timestamp` is Railway's ingest time
 * and is the fallback. A plain-text line (a container message) has no time.
 */
export function parseLogLine(raw) {
  const text = raw.trim()
  if (!text) return null
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    return { json: false, time: null, message: text, pid: null, hostname: null }
  }
  if (!obj || typeof obj !== 'object') return null
  const message =
    typeof obj.message === 'string' ? obj.message : typeof obj.msg === 'string' ? obj.msg : ''
  const time =
    typeof obj.time === 'number'
      ? obj.time
      : typeof obj.time === 'string'
        ? Date.parse(obj.time)
        : typeof obj.timestamp === 'string'
          ? Date.parse(obj.timestamp)
          : null
  return {
    json: true,
    time: time === null || Number.isNaN(time) ? null : time,
    message,
    pid: obj.pid ?? null,
    hostname: obj.hostname ?? null,
  }
}

/**
 * The Railway project and environment ids out of a deployment status's
 * `environment_url`:
 * `https://railway.com/project/<projectId>?environmentId=<environmentId>`.
 * Null when the URL is not that shape — the caller then cannot aim the log
 * read and must say so rather than guess.
 */
export function parseRailwayEnvironmentUrl(url) {
  if (typeof url !== 'string') return null
  const project = /\/project\/([0-9a-f-]{36})/i.exec(url)
  const environment = /[?&]environmentId=([0-9a-f-]{36})/i.exec(url)
  if (!project || !environment) return null
  return { projectId: project[1], environmentId: environment[1] }
}

/**
 * The verdict. Pure: every input is data, so the fixtures drive it without a
 * network or a CLI.
 *
 * `github`  — the `Haven AI / production` deployment record for the SHA, with
 *             its latest status: `{ id, environment, sha, createdAt, status: { state, createdAt, environmentUrl } }`
 * `railway` — the Railway deployment for the SHA: `{ id, status, createdAt, commitHash }`
 * `lines`   — the raw log text of THAT deployment
 */
export function classify({ sha, github, railway, windowEnd, lines }) {
  const failures = []
  const windowStart = railway?.createdAt ?? github?.createdAt ?? null
  const end = windowEnd ?? null

  // 1. GitHub's deployment_status stream: the credential-free SHA anchor.
  if (!github) {
    failures.push(
      `no GitHub deployment in "${PRODUCTION_ENVIRONMENT}" carries ${sha} — the promotion SHA never reached production`,
    )
  } else if (github.status?.state !== 'success') {
    failures.push(
      `GitHub deployment ${github.id} for ${sha} has no successful status (latest: ${github.status?.state ?? 'none'})`,
    )
  }

  // 2. Railway's own record of the same commit: the deployment the log belongs to.
  if (!railway) {
    failures.push(`no Railway deployment of ${PRODUCTION_SERVICE} carries commit ${sha}`)
  } else if (railway.commitHash !== sha) {
    failures.push(`Railway deployment ${railway.id} carries commit ${railway.commitHash}, not ${sha}`)
  } else if (!RAN_STATES.has(railway.status)) {
    failures.push(`Railway deployment ${railway.id} is ${railway.status}, not a state in which it ran`)
  }

  // 3. The log itself.
  const parsed = []
  let read = 0
  for (const line of lines.split('\n')) {
    if (!line.trim()) continue
    read += 1
    const p = parseLogLine(line)
    if (p) parsed.push(p)
  }
  const truncated = read >= RAILWAY_PAGE_CAP
  const jsonLines = parsed.filter((p) => p.json).length
  if (read === 0) {
    failures.push('the log is empty — no lines in the deployment window')
  } else if (jsonLines === 0) {
    failures.push('the log has no readable lines — not the JSON lines `railway logs --json` emits')
  }
  if (truncated) {
    failures.push(
      `the log window returned ${read} lines, Railway's ${RAILWAY_PAGE_CAP}-line page cap — the boot lines or a warning may be cut; narrow --window-minutes or use the manual check`,
    )
  }

  const inWindow = (t) =>
    t === null || windowStart === null || (t >= windowStart - SKEW_MS && (end === null || t <= end))

  // 4. The POSITIVE markers. Absence of a marker is a failure, never silence.
  const boot = BOOT_MARKERS.map((marker) => {
    const hits = parsed.filter((p) => p.message.includes(marker))
    const inside = hits.filter((p) => inWindow(p.time))
    if (inside.length === 0) {
      if (hits.length > 0) {
        failures.push(
          `"${marker}" appears only outside the deployment window (${iso(hits[0].time) ?? 'no timestamp'}) — a stale process, not this deployment`,
        )
      } else {
        failures.push(`"${marker}" is absent from the deployment log — the process did not reach that point`)
      }
      return { marker, at: null, pid: null, hostname: null }
    }
    const last = inside[inside.length - 1]
    return { marker, at: iso(last.time), pid: last.pid, hostname: last.hostname }
  })

  // 5. The last migration this boot applied. None is a valid answer: it means
  //    the schema was already current, and "Database migrations complete" is
  //    the proof that `runMigrations()` finished.
  const applied = parsed
    .filter((p) => p.message.includes(MIGRATION_APPLIED_PREFIX) && inWindow(p.time))
    .map((p) => p.message.slice(p.message.indexOf(MIGRATION_APPLIED_PREFIX) + MIGRATION_APPLIED_PREFIX.length).trim())
    .filter(Boolean)

  // 6. The absence standard, counted rather than eyeballed.
  const rpcWarnings = parsed
    .filter((p) => p.message.includes(RPC_WARNING_MARKER) && inWindow(p.time))
    .map((p) => ({ at: iso(p.time), message: p.message }))
  if (rpcWarnings.length > 0) {
    failures.push(
      `${rpcWarnings.length} unset public-RPC warning(s) in the deployment log: ${rpcWarnings
        .map((w) => `${w.message.slice(0, 200)}${w.message.length > 200 ? '…' : ''}`)
        .join(' | ')}`,
    )
  }

  return {
    sha,
    github: github
      ? {
          id: github.id,
          environment: github.environment,
          sha: github.sha,
          createdAt: iso(github.createdAt),
          status: github.status?.state ?? null,
          statusAt: iso(github.status?.createdAt),
        }
      : null,
    railway: railway
      ? { id: railway.id, status: railway.status, createdAt: iso(railway.createdAt), commitHash: railway.commitHash }
      : null,
    window: { from: iso(windowStart), to: iso(end) },
    lines: { read, parsed: parsed.length, json: jsonLines, truncated },
    boot,
    migrations: { applied, last: applied.length > 0 ? applied[applied.length - 1] : null },
    rpcWarnings,
    verdict: failures.length === 0 ? 'pass' : 'fail',
    failures,
  }
}

/** The block the operator pastes onto the promotion PR. */
export function renderReport(result) {
  const out = []
  out.push(`Release closeout — production boot log (#4542)`)
  out.push(`promotion merge SHA: ${result.sha}`)
  out.push(
    result.github
      ? `GitHub deployment: ${result.github.id} (${result.github.environment}) — ${result.github.status} at ${result.github.statusAt ?? '?'}`
      : 'GitHub deployment: none',
  )
  out.push(
    result.railway
      ? `Railway deployment: ${result.railway.id} — ${result.railway.status}, created ${result.railway.createdAt}`
      : 'Railway deployment: none',
  )
  out.push(
    `log window: ${result.window.from ?? '?'} → ${result.window.to ?? '?'} (${result.lines.read} lines, ${result.lines.parsed} parsed${result.lines.truncated ? ', TRUNCATED at the page cap' : ''})`,
  )
  out.push(
    `boot markers: ${result.boot
      .map((b) => `"${b.marker}" ${b.at ? `at ${b.at}` : 'ABSENT'}`)
      .join('; ')}`,
  )
  const readable = result.lines.json > 0
  out.push(
    `last applied migration: ${
      readable
        ? (result.migrations.last ?? 'none — no pending migrations at this boot')
        : 'unknown — no readable log lines'
    }`,
  )
  out.push(
    `unset public-RPC warnings: ${readable ? result.rpcWarnings.length : 'unknown — no readable log lines'}`,
  )
  out.push(`verdict: ${result.verdict.toUpperCase()}`)
  for (const failure of result.failures) out.push(`  - ${failure}`)
  return out.join('\n')
}

function run(cmd, args) {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
    return { ok: true, stdout }
  } catch (err) {
    const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString?.() ?? ''
    return {
      ok: false,
      code: err.status ?? null,
      errno: err.code ?? null,
      stderr: stderr.trim(),
      message: err.message,
    }
  }
}

const missing = (res, cli) => (res.errno === 'ENOENT' ? `the ${cli} CLI is not installed` : null)

function ghJson(args) {
  const res = run('gh', args)
  if (!res.ok) {
    const why = missing(res, '`gh`') ?? (res.stderr || res.message)
    return { ok: false, why }
  }
  try {
    return { ok: true, value: JSON.parse(res.stdout) }
  } catch {
    return { ok: false, why: '`gh api` returned output that is not JSON' }
  }
}

function railwayJson(args) {
  const res = run('railway', args)
  if (!res.ok) {
    const why = missing(res, 'Railway') ?? (res.stderr || res.message)
    return { ok: false, why }
  }
  try {
    return { ok: true, value: JSON.parse(res.stdout) }
  } catch {
    return { ok: false, why: '`railway` returned output that is not JSON' }
  }
}

function main(argv) {
  const args = argv.slice(2)
  const opt = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const json = args.includes('--json')
  const repo = opt('--repo') ?? 'd-hinders/Haven-AI'
  const file = opt('--file')
  const windowMinutes = Number(opt('--window-minutes') ?? DEFAULT_WINDOW_MINUTES)
  const cannotRun = (why) => {
    process.stderr.write(`release-closeout-log: cannot run — ${why}\n${MANUAL_CHECK_POINTER}\n`)
    return 2
  }

  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    return cannotRun(`--window-minutes needs a positive number, got ${JSON.stringify(opt('--window-minutes'))}`)
  }

  // The promotion merge SHA: given, or read off the promotion PR.
  let sha = opt('--sha')
  if (!sha) {
    const pr = opt('--pr')
    if (!pr) return cannotRun('pass --sha <promotion merge sha> or --pr <promotion PR number>')
    const prRes = ghJson(['pr', 'view', String(pr), '--repo', repo, '--json', 'mergeCommit,state'])
    if (!prRes.ok) return cannotRun(`could not read PR #${pr}: ${prRes.why}`)
    const merge = prRes.value?.mergeCommit?.oid
    if (!merge) return cannotRun(`PR #${pr} has no merge commit (state: ${prRes.value?.state ?? 'unknown'}) — is it merged?`)
    sha = merge
  }
  sha = String(sha).trim().toLowerCase()
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return cannotRun(`--sha ${JSON.stringify(sha)} is not a git SHA`)

  // 1. GitHub's deployment_status stream — the SHA anchor and the Railway target.
  const deployments = ghJson([
    'api',
    `repos/${repo}/deployments?environment=${encodeURIComponent(PRODUCTION_ENVIRONMENT)}&per_page=100`,
  ])
  if (!deployments.ok) return cannotRun(`could not read GitHub deployments: ${deployments.why}`)
  const matches = (Array.isArray(deployments.value) ? deployments.value : [])
    .filter((d) => typeof d.sha === 'string' && d.sha.toLowerCase().startsWith(sha))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  const deployment = matches[0] ?? null
  let github = null
  let target = null
  if (deployment) {
    const statuses = ghJson(['api', `repos/${repo}/deployments/${deployment.id}/statuses`])
    if (!statuses.ok) return cannotRun(`could not read deployment ${deployment.id} statuses: ${statuses.why}`)
    const list = Array.isArray(statuses.value) ? statuses.value : []
    const success = list
      .filter((s) => s.state === 'success')
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]
    const latest = list.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]
    github = {
      id: deployment.id,
      environment: deployment.environment,
      sha: deployment.sha,
      createdAt: Date.parse(deployment.created_at),
      status: {
        state: success ? 'success' : (latest?.state ?? null),
        createdAt: success ? Date.parse(success.created_at) : latest ? Date.parse(latest.created_at) : null,
        environmentUrl: success?.environment_url ?? latest?.environment_url ?? null,
      },
    }
    target = parseRailwayEnvironmentUrl(github.status.environmentUrl)
    if (!target) {
      return cannotRun(
        `GitHub deployment ${deployment.id} carries no Railway project/environment URL — cannot aim the log read`,
      )
    }
  }

  // 2. Railway's deployment for the same commit, in the environment GitHub named.
  let railway = null
  let windowEnd = null
  if (target) {
    const list = railwayJson([
      'deployment',
      'list',
      '--project',
      target.projectId,
      '--environment',
      target.environmentId,
      '--service',
      PRODUCTION_SERVICE,
      '--json',
      '--limit',
      '100',
    ])
    if (!list.ok) return cannotRun(`could not list Railway deployments: ${list.why}`)
    const all = (Array.isArray(list.value) ? list.value : [])
      .filter((d) => typeof d?.meta?.commitHash === 'string')
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    const sameCommit = all.filter((d) => d.meta.commitHash.toLowerCase().startsWith(sha))
    const chosen = sameCommit.find((d) => RAN_STATES.has(d.status)) ?? sameCommit[0] ?? null
    if (chosen) {
      railway = {
        id: chosen.id,
        status: chosen.status,
        createdAt: Date.parse(chosen.createdAt),
        commitHash: chosen.meta.commitHash,
      }
      // The window ends at the next deployment of this service, so a later
      // commit's boot can never be read as this one's.
      const newer = all.find((d) => Date.parse(d.createdAt) > railway.createdAt)
      windowEnd = newer ? Date.parse(newer.createdAt) : null
    }
  }

  // 3. The log of THAT deployment, over its boot window.
  let lines
  if (file) {
    try {
      lines = readFileSync(file, 'utf8')
    } catch (err) {
      return cannotRun(`could not read --file ${file}: ${err.message}`)
    }
  } else if (railway && target) {
    const from = railway.createdAt
    const until = Math.min(from + windowMinutes * 60_000, windowEnd ?? Number.POSITIVE_INFINITY, Date.now())
    const res = run('railway', [
      'logs',
      railway.id,
      '--project',
      target.projectId,
      '--environment',
      target.environmentId,
      '--service',
      PRODUCTION_SERVICE,
      '--json',
      '--since',
      new Date(from).toISOString(),
      '--until',
      new Date(until).toISOString(),
    ])
    if (!res.ok) {
      const why = missing(res, 'Railway') ?? (res.stderr || res.message)
      return cannotRun(`could not read the log of deployment ${railway.id}: ${why}`)
    }
    lines = res.stdout
    windowEnd = until
  } else {
    lines = ''
  }

  const result = classify({ sha, github, railway, windowEnd, lines })
  process.stdout.write((json ? JSON.stringify(result, null, 2) : renderReport(result)) + '\n')
  return result.verdict === 'pass' ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv))
}
