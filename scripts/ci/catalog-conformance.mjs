#!/usr/bin/env node
// The instrument behind quality-scan block 10 (#4757): catalog conformance by
// unpaid probe.
//
// Two questions, both answerable without paying anything:
//
//   Half A (call semantics) — does the catalog row declare the call shape the
//   merchant's own 402 declares? #4755 is the specimen: the Anchor calldata row
//   carries no `http_method` and no `body_example`, while the merchant's 402 to
//   a POST declares `method: POST, bodyType: json`. The row leads an agent to a
//   request the merchant cannot answer usefully.
//
//   Half B (header budget) — how large is the payment header the SDK would
//   build from that 402, and how many times does the retry put it on the wire?
//   #4754 is the specimen: the v2 envelope echoes the merchant's `extensions`
//   verbatim (a spec MUST, `x402V2PaymentEnvelope`), so Anchor's bazaar block
//   pushed an EIP-3009 header to 4,969 bytes and CoinGecko's to 6,520; sent
//   under both names that answered HTTP 431 after the funding leg confirmed.
//
// The header is BUILT and never sent. No payment header, no signer, no Haven
// payment tool, no credential or cookie leaves this script: `probe` sends one
// unpaid request per row, as the row declares it, with redirects not followed
// and one attempt.
//
// WHY THIS IS A SCRIPT AND NOT AN INLINE ONE-LINER
//
// Half B must go through the real `x402V2PaymentEnvelope` and the real
// `x402RetryHeadersFor` — a second copy of either is a second thing that can
// lie (dimensions.md, first rule). Those live in the built SDK, so the block's
// command needs a module, and a module needs a test.
//
// WHAT THE TEST PROVES, AND WHAT IT DOES NOT
//
// `catalog-conformance.test.mjs` runs in the always-run *Repo CI config checks*
// job (`node --test scripts/ci/*.test.mjs`), which does no `npm ci` and no
// build. It proves the JOIN can say yes and no — a mismatching pair is
// reported, a matching pair is not, a 402 with no declared input is reported as
// `no declared input` — and it proves the header-budget arithmetic on a fixture
// encoder. It does not prove the real envelope produces the bytes: that is
// `fixtures` mode's job, against the built package, and the block records the
// figures it printed.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
export const FIXTURE_DIR = join(HERE, 'fixtures', 'catalog-conformance')

/**
 * The Haven-operated hosts block 10 excludes from the third-party tier. Both
 * are the demo merchant's own deployments (migration 058), and both rows are
 * `protocol: mcp`, which this block does not cover — named so a reader can see
 * the exclusion is a decision, not an oversight.
 */
export const HAVEN_OPERATED_HOSTS = [
  'demo-merchant-dev-84e4.up.railway.app',
  'enthusiastic-blessing-production-171f.up.railway.app',
]

/** The largest payment header observed to SUCCEED (#4754, CoinGecko). */
export const HEADER_CLEAN_MAX = 6520
/** The observed FAILURE: 2 × 4,969 bytes against Anchor (#4754). */
export const HEADER_FAIL_MIN = 9938

/** Hosted Haven on dev — the only listing the default tier reads. */
export const DEFAULT_CATALOG_URL = 'https://havenbackend-dev-8b95.up.railway.app/catalog'

/** The `extensions.bazaar.info.input` block of a 402, or null when absent. */
export function declaredInput(challenge) {
  if (challenge === null || typeof challenge !== 'object') return null
  const extensions = challenge.extensions
  if (extensions === null || typeof extensions !== 'object') return null
  const bazaar = extensions.bazaar
  if (bazaar === null || typeof bazaar !== 'object') return null
  const info = bazaar.info
  if (info === null || typeof info !== 'object') return null
  const input = info.input
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  return input
}

const upper = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim().toUpperCase() : null)

/**
 * Half A: the row's declared call shape against the 402's declared input.
 *
 * `match` — the row declares what the merchant declares.
 * `mismatch` — it does not; `detail` names each difference.
 * `no declared input` — the 402 carries no `extensions.bazaar.info.input`. A
 * lead, never a match: Anchor's GET answer to the calldata row carried no
 * input, and the mismatch was in its POST answer (#4755).
 *
 * A row with no `http_method` is compared as GET — the refresh's own default
 * (`merchant-catalog.ts:447`), which is the request the row actually leads to.
 */
export function compareCallShape(row, challenge) {
  const input = declaredInput(challenge)
  if (input === null) {
    return { verdict: 'no declared input', detail: 'the 402 carries no extensions.bazaar.info.input' }
  }
  const differences = []
  const rowMethod = upper(row.http_method) ?? 'GET'
  const declaredMethod = upper(input.method) ?? 'GET'
  if (rowMethod !== declaredMethod) differences.push(`method: row ${rowMethod}, 402 ${declaredMethod}`)

  const rowBodyType = row.body_example != null ? (row.body_type ?? 'json') : null
  const declaredBodyType = typeof input.bodyType === 'string' && input.bodyType.trim() !== '' ? input.bodyType.trim() : null
  if (declaredBodyType !== null && rowBodyType === null) {
    differences.push(`body: row none, 402 ${declaredBodyType}`)
  } else if (declaredBodyType !== null && rowBodyType !== null && declaredBodyType !== rowBodyType) {
    differences.push(`bodyType: row ${rowBodyType}, 402 ${declaredBodyType}`)
  }

  const queryParams = input.queryParams
  if (queryParams !== null && typeof queryParams === 'object' && !Array.isArray(queryParams)) {
    const names = Object.keys(queryParams)
    if (names.length) differences.push(`query parameters the catalog cannot carry: ${names.join(', ')}`)
  }

  if (differences.length) return { verdict: 'mismatch', detail: differences.join('; ') }
  return { verdict: 'match', detail: `row and 402 agree on ${rowMethod}` }
}

/**
 * Half B: the payment header the SDK would build from this 402, and what the
 * retry would put on the wire.
 *
 * `deps.encode` is the SDK's `encodeBase64Json`; `deps.namesFor` is
 * `x402RetryHeadersFor`'s name list. Both are injected so the self-test can run
 * without a build; `fixtures` mode passes the real ones.
 *
 * `product` is `bytes × names.length` — the total header bytes the retry sends.
 * Since #4756 a v2 payload goes out under one name, so at the tip the product
 * equals `bytes`; the multiplication stays because a v1 payload still sends
 * both, and the block's clean/finding thresholds are stated in product bytes.
 */
export function headerBudget(envelope, deps) {
  const header = deps.encode(envelope)
  const bytes = Buffer.byteLength(header, 'utf8')
  const names = deps.namesFor(header)
  const extensions = envelope?.extensions
  let largestExtension = 0
  if (extensions !== null && typeof extensions === 'object' && !Array.isArray(extensions)) {
    for (const value of Object.values(extensions)) {
      const size = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
      if (size > largestExtension) largestExtension = size
    }
  }
  const product = bytes * names.length
  const verdict = product > HEADER_FAIL_MIN ? 'finding' : product > HEADER_CLEAN_MAX ? 'lead' : 'clean'
  return { bytes, names, product, largestExtension, verdict }
}

/** The rows the third-party tier covers: active, operator, http, not Haven-operated. */
export function selectThirdPartyRows(entries) {
  return entries.filter(
    (e) =>
      e.status === 'active' &&
      e.source === 'operator' &&
      e.protocol === 'http' &&
      !HAVEN_OPERATED_HOSTS.includes(e.endpoint_host),
  )
}

/** The default tier's read of a public listing: counts, never a probe. */
export function summariseListing(entries) {
  const active = entries.filter((e) => e.status === 'active')
  const count = (predicate) => active.filter(predicate).length
  return {
    entries: entries.length,
    active: active.length,
    httpOperator: count((e) => e.protocol === 'http' && e.source === 'operator'),
    mcpOperator: count((e) => e.protocol === 'mcp' && e.source === 'operator'),
    bazaar: count((e) => e.source === 'bazaar'),
    thirdParty: selectThirdPartyRows(entries).length,
    hosts: [...new Set(selectThirdPartyRows(entries).map((e) => e.endpoint_host))].sort(),
  }
}

/** The 402's JSON, from the `PAYMENT-REQUIRED` header or the body. */
export function challengeFrom(headers, body) {
  const header = typeof headers?.get === 'function' ? headers.get('PAYMENT-REQUIRED') : null
  if (header) {
    try {
      return JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
    } catch {
      /* body fallback */
    }
  }
  if (body !== null && typeof body === 'object') return body
  return null
}

// ---------------------------------------------------------------------------
// Impure: the SDK, the network, the CLI
// ---------------------------------------------------------------------------

async function loadSdk(path) {
  const entry = path ?? join(REPO, 'packages', 'sdk', 'dist', 'index.js')
  try {
    return await import(entry)
  } catch (err) {
    console.error(
      `catalog-conformance: the SDK is not built at ${entry} (${err instanceof Error ? err.message : String(err)}).\n` +
        'Run `npm run build -w packages/sdk` first, or pass --sdk <path to dist/index.js>.',
    )
    process.exit(2)
  }
}

const sdkDeps = (sdk) => ({ encode: sdk.encodeBase64Json, namesFor: (header) => Object.keys(sdk.x402RetryHeadersFor(header)) })

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** The fixture controls: three half-A pairs and one half-B challenge. */
export function fixtureControls() {
  return {
    mismatch: { row: readJson(join(FIXTURE_DIR, 'row-mismatch.json')), challenge: readJson(join(FIXTURE_DIR, 'challenge-mismatch.json')) },
    match: { row: readJson(join(FIXTURE_DIR, 'row-match.json')), challenge: readJson(join(FIXTURE_DIR, 'challenge-match.json')) },
    noInput: { row: readJson(join(FIXTURE_DIR, 'row-no-input.json')), challenge: readJson(join(FIXTURE_DIR, 'challenge-no-input.json')) },
    largeEcho: readJson(join(FIXTURE_DIR, 'challenge-large-echo.json')),
  }
}

async function modeFixtures(opts) {
  const sdk = await loadSdk(opts.sdk)
  const deps = sdkDeps(sdk)
  const controls = fixtureControls()
  const failures = []

  const rows = []
  const check = (label, pair, expected) => {
    const result = compareCallShape(pair.row, pair.challenge)
    rows.push(`| ${label} | ${result.verdict} | ${result.detail} |`)
    if (result.verdict !== expected) failures.push(`${label}: expected ${expected}, got ${result.verdict}`)
  }
  check('mismatch pair', controls.mismatch, 'mismatch')
  check('matching pair', controls.match, 'match')
  check('no-input pair', controls.noInput, 'no declared input')

  const challenge = controls.largeEcho
  const accepted = challenge.accepts?.[0]
  const envelope = sdk.x402V2PaymentEnvelope(
    { x402Version: challenge.x402Version, resource: challenge.resource, extensions: challenge.extensions },
    accepted,
    {
      signature: `0x${'11'.repeat(65)}`,
      authorization: {
        from: '0x' + '22'.repeat(20),
        to: '0x' + '33'.repeat(20),
        value: '1000',
        validAfter: '0',
        validBefore: '99999999999',
        nonce: `0x${'44'.repeat(32)}`,
      },
    },
  )
  const budget = headerBudget(envelope, deps)
  if (budget.product <= HEADER_CLEAN_MAX) failures.push(`large-echo fixture: product ${budget.product} is not above ${HEADER_CLEAN_MAX}`)

  console.log('| control | verdict | detail |')
  console.log('|---|---|---|')
  for (const row of rows) console.log(row)
  console.log('')
  console.log(
    `Half B, large-echo fixture: header ${budget.bytes} bytes; names ${budget.names.join(', ')}; ` +
      `product ${budget.product} bytes; largest echoed extension ${budget.largestExtension} bytes → ${budget.verdict}.`,
  )
  console.log('')
  if (failures.length) {
    for (const f of failures) console.error(`CONTROL FAILED ${f}`)
    process.exit(1)
  }
  console.log(
    `block 10 → fixtures → examined → 3 half-A pairs (1 mismatch reported, 1 match not reported, 1 no declared input reported); ` +
      `half B 1 challenge, product ${budget.product} bytes → ${budget.verdict}`,
  )
}

async function modeListing(opts) {
  const url = opts.url ?? DEFAULT_CATALOG_URL
  let payload
  try {
    const response = await fetch(url, { redirect: 'manual', headers: { Accept: 'application/json' } })
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
    payload = await response.json()
  } catch (err) {
    console.log(`block 10 → default tier → not examined → network unavailable (${err instanceof Error ? err.message : String(err)})`)
    process.exit(2)
  }
  const entries = Array.isArray(payload?.entries) ? payload.entries : []
  if (entries.length === 0) {
    console.log(`block 10 → default tier → not examined → the listing returned 0 rows (a row count of 0 is not clean)`)
    process.exit(2)
  }
  const s = summariseListing(entries)
  console.log(`listing ${url}`)
  for (const e of entries.filter((x) => x.status === 'active')) {
    console.log(`  ${e.name} | ${e.protocol} | ${e.source} | ${e.endpoint_host}`)
  }
  console.log(
    `entries ${s.entries}; active ${s.active}; http/operator ${s.httpOperator}; mcp/operator ${s.mcpOperator}; bazaar ${s.bazaar}`,
  )
  console.log(`third-party tier would cover ${s.thirdParty} rows across ${s.hosts.length} hosts: ${s.hosts.join(', ')}`)
  console.log(
    `block 10 → default tier → examined → ${url} → ${s.entries} entries, ${s.active} active, ` +
      `${s.httpOperator} http/operator, ${s.mcpOperator} mcp/operator, ${s.bazaar} bazaar`,
  )
  console.log('block 10 → third-party tier → not examined → third-party probes not requested')
}

async function modeProbe(opts) {
  if (!opts.rows) {
    console.error('catalog-conformance probe: --rows <file> is required (a JSON array of catalog rows)')
    process.exit(2)
  }
  const sdk = await loadSdk(opts.sdk)
  const deps = sdkDeps(sdk)
  const rows = readJson(opts.rows)
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log('block 10 → third-party tier → not examined → the row source returned 0 rows (a row count of 0 is not clean)')
    process.exit(2)
  }
  const out = []
  for (const row of rows) {
    if (row.source === 'bazaar') {
      out.push(`${row.name}: not probed → source bazaar (seller-chosen URL, never probed)`)
      continue
    }
    if (row.protocol !== 'http') {
      out.push(`${row.name}: out of sample → protocol ${row.protocol}`)
      continue
    }
    if (HAVEN_OPERATED_HOSTS.includes(row.endpoint_host)) {
      out.push(`${row.name}: out of sample → Haven-operated host`)
      continue
    }
    if (!row.resource_url) {
      out.push(`${row.name}: no probe target → the source carries no resource_url`)
      continue
    }
    const method = upper(row.http_method) ?? 'GET'
    const init = { method, redirect: 'manual' }
    if (row.body_example != null && (row.body_type ?? 'json') === 'json' && method !== 'GET' && method !== 'HEAD') {
      init.body = JSON.stringify(row.body_example)
      init.headers = { 'Content-Type': 'application/json' }
    }
    let response
    try {
      response = await fetch(row.resource_url, init)
    } catch (err) {
      out.push(`${row.name}: reported → unreachable (${err instanceof Error ? err.message : String(err)})`)
      continue
    }
    if (response.status !== 402) {
      out.push(`${row.name}: reported → HTTP ${response.status} to ${method} (not retried)`)
      continue
    }
    let body = null
    try {
      body = await response.json()
    } catch {
      /* header-only challenge */
    }
    const challenge = challengeFrom(response.headers, body)
    if (challenge === null) {
      out.push(`${row.name}: reported → the 402 carries no readable challenge`)
      continue
    }
    const shape = compareCallShape(row, challenge)
    const accepted = challenge.accepts?.[0]
    let budget = null
    if (accepted) {
      const envelope = sdk.x402V2PaymentEnvelope(
        { x402Version: challenge.x402Version, resource: challenge.resource, extensions: challenge.extensions },
        accepted,
        {
          signature: `0x${'11'.repeat(65)}`,
          authorization: {
            from: '0x' + '22'.repeat(20),
            to: '0x' + '33'.repeat(20),
            value: '1000',
            validAfter: '0',
            validBefore: '99999999999',
            nonce: `0x${'44'.repeat(32)}`,
          },
        },
      )
      budget = headerBudget(envelope, deps)
    }
    out.push(
      `${row.name}: ${shape.verdict} — ${shape.detail}` +
        (budget ? `; header ${budget.bytes} bytes × ${budget.names.length} name(s) = ${budget.product} → ${budget.verdict}` : '; no accepts[] option, half B not run'),
    )
  }
  for (const line of out) console.log(line)
  console.log('')
  console.log(`block 10 → third-party tier → examined → ${rows.length} rows from ${opts.rows}`)
}

function parseArgs(argv) {
  const opts = { mode: argv[0] }
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--url') opts.url = argv[++i]
    else if (arg === '--rows') opts.rows = argv[++i]
    else if (arg === '--sdk') opts.sdk = argv[++i]
    else {
      console.error(`catalog-conformance: unknown argument ${arg}`)
      process.exit(2)
    }
  }
  return opts
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

const invokedDirectly = isEntryPoint()
if (invokedDirectly) {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.mode === 'fixtures') await modeFixtures(opts)
  else if (opts.mode === 'listing') await modeListing(opts)
  else if (opts.mode === 'probe') await modeProbe(opts)
  else {
    console.error('usage: catalog-conformance.mjs <fixtures|listing|probe> [--url <catalog url>] [--rows <file>] [--sdk <dist/index.js>]')
    process.exit(2)
  }
}
