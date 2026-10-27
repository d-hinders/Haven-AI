#!/usr/bin/env node
// The instrument behind quality-scan blocks 8 and 9 (#4471).
//
// Block 8 (refusal census) asks one question of the backend suite's own
// answers: when a route refuses, does the hosted mapper (`normalizeError`,
// `packages/mcp-server/src/tools/support/errors.ts`) answer it with a step the
// agent can follow, or does it fall through to the generic branch? Block 9
// (field round-trip) asks the mirror question of the 2xx bodies: does every key
// the backend emits get read by an SDK mapper, and does every key a mapper
// reads actually arrive?
//
// Both read ONE artifact: a recording of what the backend suite's `app.inject`
// calls returned. `record` produces it; `block8` and `block9` consume it. The
// recorder itself is `fixtures/refusal-census/recorder.setup.mjs` — a vitest
// setup file that wraps the `fastify` factory with an `onSend` hook. It is
// inert unless `HAVEN_RESPONSE_RECORDING` is set, it is never part of the
// backend's own config, and it does not change a response (`refusal-census.test.mjs`
// pins that on a toy app).
//
// WHY THE RECORDER MOCKS `fastify` BY ABSOLUTE PATH
//
// `fastify` is not hoisted: it resolves only from `packages/backend/node_modules`.
// A bare `vi.mock('fastify')` in a setup file under `scripts/ci/` resolves from
// THAT file's location, matches nothing the backend imports, and records zero
// rows — a false zero that reads as "the suite answers nothing". `record`
// resolves the entry from `packages/backend/package.json` with `createRequire`
// and passes it in `HAVEN_RECORDER_FASTIFY`.
//
// WHY THE ERROR IS BUILT BY TRANSCRIPTION, NOT BY DRIVING `HavenApiTransport`
//
// The transport is the authority on how a response becomes a `HavenApiError`
// (`packages/sdk/src/haven-api-transport.ts:120-137`), and driving it would be
// better than copying it. It cannot be driven from here: the class is not
// exported from the SDK entrypoint (`packages/sdk/src/index.ts` exports
// `HavenClient`, not the transport), and importing its source directly fails —
// `types.ts` uses TypeScript parameter properties, which Node's strip-only
// loader refuses (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). So `transportError`
// below is a line-for-line transcription of that block, and
// `refusal-census.test.mjs` pins it on a body table: `error: details`, a
// details object JSON-stringified, `error` alone, `details` alone, neither, and
// the non-JSON case the transport answers as status 0. The full body is kept —
// the trial rebuilt a four-key body and lost `payment_id`, which is exactly the
// field `normalizeError` reads to choose `check_status_later` over
// `stop_and_tell_user` (`errors.ts:577-583`).
//
// PREREQUISITES
//
//   npm run build -w packages/mcp-server   # builds the SDK too; block8 imports
//                                          # the built normalizeError
//   docker compose up -d postgres          # the backend suite's own prerequisite
//
// USAGE
//
//   node scripts/ci/refusal-census.mjs record [--out <path>]
//   node scripts/ci/refusal-census.mjs block8 [--recording <path>]
//   node scripts/ci/refusal-census.mjs block9 [--recording <path>]
//
// `record` propagates vitest's exit code: the suite has one known red file on a
// local database (`ops-readonly-role.test.ts`, `permission denied to create
// role`), and a red file does not stop the recording. Run block8/block9 anyway
// and report the red file in the coverage record.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readBlock, scanReceiptSurface, stripCommentsAndStrings } from './vocabulary-divergence.mjs'
import { CONTROL_CODE, CONTROL_KEY, CONTROL_ROUTE } from './fixtures/refusal-census/control.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
const FIXTURES = join(HERE, 'fixtures', 'refusal-census')
const ALLOWLIST_PATH = join(HERE, 'refusal-census-allowlist.json')
const DEFAULT_RECORDING = join(tmpdir(), 'refusal-census.ndjson')

/**
 * A recording smaller than this is not a run — it is a broken instrument. The
 * precedent is `assertPlausible` in `vocabulary-divergence.mjs` and the
 * `scanned >= 12` floor in `queue-framing-census.test.mjs`: a scanner that
 * silently finds nothing reports every row as clean, which reads as "the
 * surface is fine" rather than "the recorder never ran". The trial recorded
 * 1,972 rows from 120 test files; 200 is a floor, not a target.
 */
export const MIN_ROWS = 200

/** The row the recorder writes at truncate time, so a stale file cannot pass. */
export { CONTROL_CODE, CONTROL_KEY, CONTROL_ROUTE }

/**
 * The agent payment routes, as a rule rather than a hand list: every POST under
 * `/payments`, `/x402` or `/machine-payments`. The trial's named three
 * (`POST /payments`, `POST /x402`, `POST /x402/authorize`) are a subset; the
 * 5xx section adds `POST /payments/:id/sign`, which the rule already covers.
 */
export const AGENT_PAYMENT_ROUTE_RE = /^POST \/(payments|x402|machine-payments)(\/|$)/

/**
 * Keys a mapper's route emits that are read OUTSIDE the mapper, so "nothing
 * reads it" would be false. `client_update` is spliced in by
 * `client-compat.ts:353` and read by `haven-api-transport.ts:121`; the list
 * envelope's `total` / `has_more` / `next_cursor` are read by
 * `listReceiptsPage` itself (`account-reads.ts:660-668`).
 */
export const READ_OUTSIDE_MAPPER = new Set(['client_update', 'total', 'has_more', 'next_cursor'])

/**
 * The mapper set: every SDK mapper file, not only `payment-mappers.ts`. Each
 * entry names the route whose 2xx body the mapper reads and the backend file
 * that builds that body — the grep for the read-never-emitted direction is
 * scoped to the builder, because a key that is also a column or an OpenAPI
 * property would otherwise always grep non-zero.
 */
export const MAPPERS = [
  {
    mapper: 'mapPaymentReceipt',
    file: 'packages/sdk/src/payment-mappers.ts',
    route: 'GET /machine-payments/receipts',
    // The mapper reads each receipt, not the list envelope: `total`,
    // `has_more` and `next_cursor` are read by `listReceiptsPage` itself.
    path: 'receipts',
    builder: 'packages/backend/src/routes/machine-payments.ts',
  },
  {
    mapper: 'mapPaymentStatusResult',
    file: 'packages/sdk/src/payment-mappers.ts',
    route: 'GET /machine-payments/:id/status',
    path: null,
    builder: 'packages/backend/src/modules/payments/agent-payment-status.ts',
  },
  {
    mapper: 'mapPaymentResult',
    file: 'packages/sdk/src/payment-mappers.ts',
    route: 'GET /payments',
    path: 'payments',
    builder: 'packages/backend/src/routes/payments.ts',
  },
  {
    mapper: 'mapTaskBudget',
    file: 'packages/sdk/src/account-reads.ts',
    route: 'GET /agents/:id/task-budgets',
    path: 'task_budgets',
    builder: 'packages/backend/src/routes/agent-task-budgets.ts',
  },
  {
    mapper: 'mapSubBudget',
    file: 'packages/sdk/src/account-reads.ts',
    route: 'GET /agents/:id/sub-budgets',
    path: 'sub_budgets',
    builder: 'packages/backend/src/routes/agent-sub-budgets.ts',
  },
  {
    mapper: 'mapCatalogEntry',
    file: 'packages/sdk/src/client.ts',
    route: 'GET /catalog',
    path: 'entries',
    builder: 'packages/backend/src/routes/catalog.ts',
  },
]

/** Read the recording: one JSON row per line, blank lines skipped. */
export function readRecording(path) {
  const text = readFileSync(path, 'utf8')
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    rows.push(JSON.parse(line))
  }
  return rows
}

/**
 * Refuse an implausibly small recording, and refuse one that is not this run's.
 *
 * Two checks, because they catch different failures: the row floor catches a
 * recorder that never registered (a bare `vi.mock('fastify')` resolving from
 * the wrong package records zero), and the control row catches a file left over
 * from an earlier run (the recorder truncates at start, so a current file
 * always carries it).
 */
export function assertPlausible(rows, { minRows = MIN_ROWS } = {}) {
  const problems = []
  if (rows.length < minRows) {
    problems.push(`recording has ${rows.length} rows, below the ${minRows}-row floor — the recorder did not run`)
  }
  const control = rows.find((row) => row.route === CONTROL_ROUTE)
  if (!control) {
    problems.push(`recording carries no ${CONTROL_ROUTE} control row — it is not this run's file`)
  } else if (control.body?.error_code !== CONTROL_CODE) {
    problems.push(`control row carries ${JSON.stringify(control.body?.error_code)}, expected ${CONTROL_CODE}`)
  }
  if (problems.length > 0) throw new Error(problems.join('; '))
  return rows
}

/**
 * The transport's error construction, transcribed from
 * `packages/sdk/src/haven-api-transport.ts:120-137`.
 *
 * `HavenApiError` is passed in rather than imported so the join is testable
 * without a build, and so the CLI can hand it the SDK's own class — the one
 * `normalizeError`'s `instanceof` check is written against.
 */
export function transportError(row, HavenApiError) {
  if (row.nonJson) {
    // The transport's `res.json()` throws, and the catch answers status 0.
    return new HavenApiError(`Request to ${row.route} failed: unexpected token in JSON`, 0)
  }
  const data = row.body
  const record = data !== null && typeof data === 'object' ? data : {}
  const errorText = typeof record.error === 'string' ? record.error : undefined
  const rawDetails = record.details ?? record.detail
  const detailsText =
    typeof rawDetails === 'string'
      ? rawDetails
      : rawDetails != null
        ? JSON.stringify(rawDetails)
        : undefined
  const message =
    errorText && detailsText
      ? `${errorText}: ${detailsText}`
      : (errorText ?? detailsText ?? 'API request failed')
  return new HavenApiError(message, row.status, data)
}

/**
 * The dedupe key. It carries the decorating fields `normalizeError` reads —
 * `payment_id`, `revert_cause`, `task_budget_id` — because collapsing them
 * merges two rows that answer differently: the trial's four-key body made
 * `POST /payments/:id/sign 502 submission_outcome_unknown` read
 * `stop_and_tell_user`, where the real body's `payment_id` gives
 * `check_status_later` + `haven_get_payment_status`.
 */
export function dedupeKey(row) {
  const body = row.body !== null && typeof row.body === 'object' ? row.body : {}
  const code = typeof body.error_code === 'string' ? body.error_code : ''
  const decorate = ['payment_id', 'revert_cause', 'task_budget_id']
    .map((field) => `${field}=${body[field] ?? ''}`)
    .join('&')
  return `${row.method} ${row.route} ${row.status} ${code} ${decorate}`
}

/** The allowlist, keyed by code. A missing file is an empty allowlist. */
export function loadAllowlist(path = ALLOWLIST_PATH) {
  if (!existsSync(path)) return new Map()
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  return new Map((parsed.codes ?? []).map((entry) => [entry.code, entry]))
}

/**
 * Block 8's join: every distinct error row, fed to `normalize` the way the SDK
 * transport would hand it over.
 *
 * `normalize` is injected so the self-test can run on fixture results without a
 * build; the CLI passes the built `normalizeError`.
 *
 * The positive control is seeded, not checked out: one synthetic row carries a
 * code the mapper is known to answer (`delegation_expired` → `DELEGATION_EXPIRED`,
 * #4458) and one carries `CONTROL_CODE`, which nothing answers. The join must
 * report the second and not the first. A checkout of `bffb8dc97^` would rot as
 * sibling modules move, and it would edit `packages/mcp-server/src`, which
 * `dimensions.md:13-17` allows only in an isolated tree.
 */
export function joinRefusals({ rows, normalize, allowlist = new Map(), HavenApiError }) {
  // A non-JSON answer is a non-answer whatever its status: the transport's
  // `res.json()` throws and the catch answers status 0, so a 200 that is not
  // JSON never reaches a mapper as a success.
  const errorRows = rows.filter((row) => (row.status >= 400 || row.nonJson) && row.route !== CONTROL_ROUTE)
  const seen = new Map()
  for (const row of errorRows) {
    const key = dedupeKey(row)
    if (!seen.has(key)) seen.set(key, row)
  }

  const typed = []
  const transient5xx = []
  const nonAnswers = []
  for (const row of seen.values()) {
    const body = row.body !== null && typeof row.body === 'object' ? row.body : {}
    const code = typeof body.error_code === 'string' ? body.error_code : null
    const answer = normalize(transportError(row, HavenApiError))
    const routeKey = `${row.method} ${row.route}`
    if (code && answer.code === 'API_ERROR') {
      const mark = allowlist.get(code)
      typed.push({
        route: routeKey,
        status: row.status,
        code,
        disposition: mark?.disposition ?? 'unmarked',
        reason: mark?.reason ?? null,
        paymentRoute: AGENT_PAYMENT_ROUTE_RE.test(routeKey),
      })
    }
    if (row.status >= 500 && answer.next_action === 'retry_with_explicit_context') {
      transient5xx.push({ route: routeKey, status: row.status, code, paymentRoute: AGENT_PAYMENT_ROUTE_RE.test(routeKey) })
    }
    if (row.nonJson) nonAnswers.push({ route: routeKey, status: row.status })
  }

  // The seeded control. `delegation_expired` must be answered; `CONTROL_CODE`
  // must not be. If either half fails the join cannot say yes or no, and its
  // numbers are not evidence.
  const controlRows = [
    { method: 'POST', route: '/payments', status: 403, body: { error_code: 'delegation_expired', payment_id: 'control' } },
    { method: 'POST', route: '/payments', status: 400, body: { error_code: CONTROL_CODE } },
  ]
  const controlAnswers = controlRows.map((row) => normalize(transportError(row, HavenApiError)))
  const control = {
    mappedAnswered: controlAnswers[0].code !== 'API_ERROR',
    unmappedReported: controlAnswers[1].code === 'API_ERROR',
  }
  if (!control.mappedAnswered) throw new Error('positive control failed: delegation_expired is not answered by the mapper')
  if (!control.unmappedReported) throw new Error(`positive control failed: ${CONTROL_CODE} is not reported as unmapped`)

  return {
    errorRows: errorRows.length,
    distinctKeys: seen.size,
    typed,
    transient5xx,
    nonAnswers,
    control,
  }
}

/**
 * The `raw.<key>` set a mapper reads.
 *
 * `mapPaymentReceipt` goes through `scanReceiptSurface` — the same extractor
 * `vocabulary-divergence.mjs` uses for the 31 receipt keys, so block 9 does not
 * grow a second key extractor that can disagree with the first. Every other
 * mapper is read with `readBlock` + `stripCommentsAndStrings` and a `raw.<key>`
 * match, which is the same shape one level less specific.
 */
export function mapperReadKeys(source, mapper) {
  if (mapper === 'mapPaymentReceipt') {
    const fields = scanReceiptSurface(source)
    const keys = new Set()
    for (const rawKey of Object.values(fields)) if (rawKey) keys.add(rawKey)
    return keys
  }
  const stripped = stripCommentsAndStrings(source)
  const body = readBlock(stripped, `function ${mapper}`)
  if (body === null) return new Set()
  // The parameter is not always named `raw` (`mapCatalogEntry(entry)`), so read
  // it from the signature: matching `raw.` blindly reported every catalog key
  // as emitted-but-unread.
  const signature = body.slice(0, body.indexOf(')'))
  const param = /\(\s*(\w+)/.exec(signature)?.[1] ?? 'raw'
  const keys = new Set()
  for (const match of body.matchAll(new RegExp(`\\b${param}\\.(\\w+)`, 'g'))) keys.add(match[1])
  return keys
}

/**
 * Top-level keys of the mapped object in a recorded 2xx body.
 *
 * `path` names the array the mapper reads (`receipts`, `payments`, …); `null`
 * means the body itself is the mapped object. The union over every recorded row
 * is what the mapper must account for.
 */
export function emittedKeys(rows, route, path = null) {
  const keys = new Set()
  for (const row of rows) {
    if (row.status < 200 || row.status >= 300) continue
    if (`${row.method} ${row.route}` !== route) continue
    if (row.body === null || typeof row.body !== 'object') continue
    const objects = path === null ? [row.body] : Array.isArray(row.body[path]) ? row.body[path] : []
    for (const object of objects) {
      if (object === null || typeof object !== 'object' || Array.isArray(object)) continue
      for (const key of Object.keys(object)) keys.add(key)
    }
  }
  return keys
}

/**
 * Whether the route's body builder mentions `key` at all.
 *
 * Scoped to the builder on purpose: a key that is also a column name or an
 * OpenAPI property greps non-zero tree-wide, so a tree-wide grep would report
 * every read-never-emitted key as a false positive. Migrations and
 * `openapi/spec.ts` are excluded for the same reason.
 */
export function builderEmits(builderPath, key) {
  if (!existsSync(builderPath)) return false
  const source = readFileSync(builderPath, 'utf8')
  return new RegExp(`\\b${key}\\b`).test(source)
}

/**
 * Block 9's round-trip, both directions.
 *
 * `readSource` and `emits` are injected so the self-test can run on fixtures.
 */
export function roundTrip({ rows, mappers = MAPPERS, readSource, emits }) {
  const emittedNeverRead = []
  const readNeverEmitted = []
  const noSample = []

  for (const entry of mappers) {
    const emitted = emittedKeys(rows, entry.route, entry.path ?? null)
    if (emitted.size === 0) {
      noSample.push(entry.route)
      continue
    }
    const read = readSource(entry)
    for (const key of emitted) {
      if (read.has(key)) continue
      if (READ_OUTSIDE_MAPPER.has(key)) continue
      emittedNeverRead.push({ route: entry.route, mapper: entry.mapper, key })
    }
    for (const key of read) {
      if (emitted.has(key)) continue
      const inSource = emits(entry, key)
      readNeverEmitted.push({
        route: entry.route,
        mapper: entry.mapper,
        key,
        // The known false-positive class: the builder emits it in a state the
        // recorded tests did not reach.
        emittedInSource: inSource,
      })
    }
  }

  // Seeded control: a key nothing emits must be reported, and a key the
  // recording does emit must not be. Without both halves the direction cannot
  // say yes or no.
  const controlRoute = 'GET /machine-payments/receipts'
  const controlEmitted = emittedKeys(rows, controlRoute, 'receipts')
  const control = {
    seededReported: !controlEmitted.has(CONTROL_KEY),
    emittedNotReported: controlEmitted.has('payment_id'),
  }
  if (!control.seededReported) throw new Error(`positive control failed: ${CONTROL_KEY} reads as emitted`)
  if (!control.emittedNotReported) throw new Error('positive control failed: the recording emits no payment_id on the receipt route')

  return { emittedNeverRead, readNeverEmitted, noSample, control }
}

/**
 * The SDK's own `new HavenApiError(` sites, from a scan rather than a hand
 * list (#4471).
 *
 * The rule: every `new HavenApiError(` in non-test `packages/sdk/src`. The
 * second argument is the status; a literal is classified, and a variable is
 * listed with the expression that supplies it — none is silently skipped.
 * `merchant-completion.ts:271` carries the merchant's own status, which is why
 * a variable site cannot be judged from the call alone.
 *
 * `sources` is `[{ file, source }]`; the return is
 * `{ sites, literal, variable, nonAnswers }`, where `nonAnswers` are the
 * transport's own `408` (timeout) and `0` (unreachable) sites.
 */
export function scanSdkSites(sources) {
  const sites = []
  for (const { file, source } of sources) {
    const stripped = stripCommentsAndStrings(source)
    for (const match of stripped.matchAll(/new HavenApiError\(/g)) {
      const open = match.index + match[0].length - 1
      const args = callArguments(stripped, open)
      if (args === null) continue
      const parts = splitTopLevel(args)
      const status = (parts[1] ?? '').trim()
      const line = stripped.slice(0, match.index).split('\n').length
      sites.push({
        file,
        line,
        status,
        literal: /^\d+$/.test(status),
      })
    }
  }
  const literal = sites.filter((site) => site.literal)
  const variable = sites.filter((site) => !site.literal)
  const nonAnswers = literal.filter((site) => site.status === '408' || site.status === '0')
  return { sites, literal, variable, nonAnswers }
}

/** The text between the paren at `open` and its matching close, or null. */
function callArguments(source, open) {
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const char = source[i]
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  return null
}

/** Split a call's arguments at top-level commas. */
function splitTopLevel(args) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < args.length; i += 1) {
    const char = args[i]
    if ('([{'.includes(char)) depth += 1
    else if (')]}'.includes(char)) depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(args.slice(start, i))
      start = i + 1
    }
  }
  parts.push(args.slice(start))
  return parts
}

/** Every non-test `packages/sdk/src` file, as `[{ file, source }]`. */
export function sdkSources() {
  const dir = join(REPO, 'packages/sdk/src')
  const out = []
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__fixtures__' || entry.name === 'test-support') continue
        walk(full)
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        out.push({ file: full.slice(REPO.length + 1), source: readFileSync(full, 'utf8') })
      }
    }
  }
  walk(dir)
  return out
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

async function loadNormalizeError() {
  // The mcp-server entrypoint does not export `normalizeError` (its `dist` is a
  // two-entry bundle: `index` and `cli`), so the built package cannot be fed
  // directly. Bundle the ONE module with esbuild, keeping `@haven_ai/sdk`
  // external: the bundle must import the SAME `HavenApiError` class the
  // instrument hands it, or `normalizeError`'s `instanceof` check fails and
  // every row reads `UNKNOWN_ERROR`. The bundle lives under `node_modules/` so
  // that external resolves from the repo root, and it is removed after import.
  const sdkDist = join(REPO, 'packages/sdk/dist/index.js')
  if (!existsSync(sdkDist)) fail('packages/sdk/dist is missing — run `npm run build -w packages/sdk` first')
  const esbuild = join(REPO, 'node_modules/.bin/esbuild')
  if (!existsSync(esbuild)) fail('node_modules/.bin/esbuild is missing — run `npm ci` first')
  const cacheDir = join(REPO, 'node_modules/.cache/refusal-census')
  mkdirSync(cacheDir, { recursive: true })
  const out = join(cacheDir, 'normalize.mjs')
  execFileSync(
    esbuild,
    [
      join(REPO, 'packages/mcp-server/src/tools/support/errors.ts'),
      '--bundle',
      '--format=esm',
      '--platform=node',
      `--outfile=${out}`,
      '--external:@haven_ai/*',
      '--external:zod/*',
      '--log-level=warning',
    ],
    { cwd: REPO, stdio: 'inherit' },
  )
  const module = await import(pathToFileURL(out).href)
  if (typeof module.normalizeError !== 'function') fail(`${out} exports no normalizeError`)
  return module.normalizeError
}

async function loadHavenApiError() {
  const path = join(REPO, 'packages/sdk/dist/index.js')
  if (!existsSync(path)) {
    fail('packages/sdk/dist is missing — run `npm run build -w packages/sdk` first')
  }
  const module = await import(pathToFileURL(path).href)
  if (typeof module.HavenApiError !== 'function') fail(`${path} exports no HavenApiError`)
  return module.HavenApiError
}

function record() {
  const out = arg('out', DEFAULT_RECORDING)
  const require = createRequire(join(REPO, 'packages/backend/package.json'))
  const fastifyEntry = require.resolve('fastify')
  const vitest = join(REPO, 'node_modules/.bin/vitest')
  if (!existsSync(vitest)) fail('node_modules/.bin/vitest is missing — run `npm ci` first')
  console.log(`recording → ${out}`)
  console.log(`fastify   → ${fastifyEntry}`)
  // The run's start: remove the previous recording and its run marker, so the
  // recorder's first setup execution truncates and seeds the control row.
  rmSync(out, { force: true })
  rmSync(`${out}.run`, { force: true })
  let code = 0
  try {
    execFileSync(vitest, ['run', '--config', join(FIXTURES, 'vitest.config.mjs')], {
      cwd: REPO,
      stdio: 'inherit',
      env: {
        ...process.env,
        HAVEN_RESPONSE_RECORDING: out,
        HAVEN_RECORDER_FASTIFY: fastifyEntry,
        HAVEN_RECORDER_RUN: `${Date.now()}-${process.pid}`,
      },
    })
  } catch (err) {
    code = typeof err.status === 'number' ? err.status : 1
  }
  const rows = existsSync(out) ? readRecording(out) : []
  console.log(`\nrecorded ${rows.length} rows (vitest exit ${code})`)
  if (code !== 0) {
    console.log('a red file does not stop the recording — run block8/block9 and report the red file in the coverage record')
  }
  process.exit(code)
}

async function block8() {
  const path = arg('recording', DEFAULT_RECORDING)
  if (!existsSync(path)) fail(`no recording at ${path} — run \`node scripts/ci/refusal-census.mjs record\` first`)
  const rows = assertPlausible(readRecording(path))
  const normalize = await loadNormalizeError()
  const HavenApiError = await loadHavenApiError()
  const result = joinRefusals({ rows, normalize, allowlist: loadAllowlist(), HavenApiError })

  console.log(`block 8 — refusal census (${path})`)
  console.log(`error rows ${result.errorRows}, distinct keys ${result.distinctKeys}`)
  console.log(`\ntyped codes the hosted mapper does not answer (${result.typed.length}):`)
  for (const row of result.typed) {
    const mark = row.disposition === 'unmarked' ? 'UNMARKED' : row.disposition
    console.log(`  ${mark.padEnd(22)} ${row.route} ${row.status} ${row.code}${row.paymentRoute ? '  [agent payment route]' : ''}`)
  }
  console.log(`\n5xx answered transient (${result.transient5xx.length}):`)
  for (const row of result.transient5xx) {
    console.log(`  ${row.route} ${row.status} ${row.code ?? '(no code)'}${row.paymentRoute ? '  [agent payment route]' : ''}`)
  }
  console.log(`\nnon-answers read as refusals (${result.nonAnswers.length}):`)
  for (const row of result.nonAnswers) console.log(`  ${row.route} ${row.status}`)

  // The SDK's own sites: a scan of `new HavenApiError(` over non-test
  // `packages/sdk/src`, not a hand list. A variable status is listed with the
  // expression that supplies it; none is silently skipped.
  const sdk = scanSdkSites(sdkSources())
  console.log(`\nSDK sites: ${sdk.sites.length} (${sdk.literal.length} literal status, ${sdk.variable.length} variable)`)
  for (const site of sdk.variable) console.log(`  variable  ${site.file}:${site.line}  status: ${site.status}`)
  for (const site of sdk.nonAnswers) console.log(`  non-answer ${site.file}:${site.line}  status: ${site.status}`)

  console.log(`\npositive control: delegation_expired answered=${result.control.mappedAnswered}, ${CONTROL_CODE} reported=${result.control.unmappedReported}`)
}

async function block9() {
  const path = arg('recording', DEFAULT_RECORDING)
  if (!existsSync(path)) fail(`no recording at ${path} — run \`node scripts/ci/refusal-census.mjs record\` first`)
  const rows = assertPlausible(readRecording(path))
  const result = roundTrip({
    rows,
    readSource: (entry) => mapperReadKeys(readFileSync(join(REPO, entry.file), 'utf8'), entry.mapper),
    emits: (entry, key) => builderEmits(join(REPO, entry.builder), key),
  })

  console.log(`block 9 — field round-trip (${path})`)
  console.log(`\nemitted but never read (${result.emittedNeverRead.length}):`)
  for (const row of result.emittedNeverRead) console.log(`  ${row.route} ${row.mapper} ${row.key}`)
  console.log(`\nread but never emitted (${result.readNeverEmitted.length}):`)
  for (const row of result.readNeverEmitted) {
    const note = row.emittedInSource ? '  [emitted in source, state not reached — known false positive]' : '  [no emitter in the builder]'
    console.log(`  ${row.route} ${row.mapper} ${row.key}${note}`)
  }
  if (result.noSample.length > 0) console.log(`\nno recorded 2xx body (partial): ${result.noSample.join(', ')}`)
  console.log(`\npositive control: seeded key reported=${result.control.seededReported}, emitted key not reported=${result.control.emittedNotReported}`)
}

const command = process.argv[2]
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (!invokedDirectly) {
  // Imported by the self-test: no command dispatch.
} else if (command === 'record') record()
else if (command === 'block8') await block8()
else if (command === 'block9') await block9()
else {
  console.error('usage: refusal-census.mjs <record|block8|block9> [--out <path>] [--recording <path>]')
  process.exit(2)
}
