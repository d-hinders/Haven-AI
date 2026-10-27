// Self-test for the refusal census (#4471).
//
// Runs in the always-run *Repo CI config checks* job (`node --test
// scripts/ci/*.test.mjs`), so it does no `npm ci` and no build: the join runs on
// a fixture recording and fixture `normalizeError` results, and the toy-Fastify
// inertness test skips when `fastify` is not installed.
//
// WHAT IT PROVES, AND WHAT IT DOES NOT
//
// It proves the JOIN can say yes and no: a code the fixture mapper answers is
// not reported as unmapped, and a seeded unmapped code is. It does not prove
// the real `normalizeError` answers anything — that is the block command's job,
// against the built package. The block says so.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  CONTROL_CODE,
  CONTROL_KEY,
  CONTROL_ROUTE,
  MIN_ROWS,
  assertPlausible,
  dedupeKey,
  emittedKeys,
  joinRefusals,
  mapperReadKeys,
  readRecording,
  roundTrip,
  scanSdkSites,
  transportError,
} from './refusal-census.mjs'
import { FixtureHavenApiError, fixtureNormalize } from './fixtures/refusal-census/normalize.fixture.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
const RECORDING = join(HERE, 'fixtures/refusal-census/recording.fixture.ndjson')
const rows = readRecording(RECORDING)

// The six receipt keys #4469 added to `mapPaymentReceipt` in block form. They
// are the fixture's own wire names, so the join must see them as read.
const RECEIPT_KEYS = [
  'settlement_scheme',
  'budget_delegation_hash',
  'delivery_quality',
  'delivery_note',
  'delivery_reported_at',
  'delivery_reference',
]

test('transportError transcribes the transport: error: details, full body kept', () => {
  const row = {
    method: 'POST',
    route: '/payments/:id/sign',
    status: 502,
    body: { error: 'submission outcome unknown', details: { error_code: 'submission_outcome_unknown', payment_id: 'pay_1' } },
  }
  const err = transportError(row, FixtureHavenApiError)
  assert.equal(err.message, 'submission outcome unknown: {"error_code":"submission_outcome_unknown","payment_id":"pay_1"}')
  assert.equal(err.statusCode, 502)
  // The full body, not a rebuilt four-key one: `payment_id` is what
  // normalizeError reads to choose check_status_later.
  assert.equal(err.body.details.payment_id, 'pay_1')
})

test('transportError covers the transport’s other message shapes', () => {
  const cases = [
    [{ body: { error: 'only error' } }, 'only error'],
    [{ body: { details: 'only details' } }, 'only details'],
    [{ body: { detail: { error_code: 'x' } } }, '{"error_code":"x"}'],
    [{ body: {} }, 'API request failed'],
    [{ body: null }, 'API request failed'],
  ]
  for (const [partial, expected] of cases) {
    const err = transportError({ method: 'GET', route: '/x', status: 400, ...partial }, FixtureHavenApiError)
    assert.equal(err.message, expected)
  }
  // A non-JSON answer is the transport's catch branch: status 0, not the HTTP
  // status, because `res.json()` threw before the status was read.
  const nonJson = transportError({ method: 'GET', route: '/x', status: 200, body: '<html>', nonJson: true }, FixtureHavenApiError)
  assert.equal(nonJson.statusCode, 0)
})

test('dedupeKey keeps the decorating fields normalizeError reads', () => {
  const base = { method: 'POST', route: '/payments/:id/sign', status: 502, body: { error_code: 'submission_outcome_unknown' } }
  const withId = { ...base, body: { ...base.body, payment_id: 'pay_1' } }
  const withOtherId = { ...base, body: { ...base.body, payment_id: 'pay_2' } }
  assert.notEqual(dedupeKey(base), dedupeKey(withId))
  assert.notEqual(dedupeKey(withId), dedupeKey(withOtherId))
  for (const field of ['revert_cause', 'task_budget_id']) {
    const a = { ...base, body: { ...base.body, [field]: 'a' } }
    const b = { ...base, body: { ...base.body, [field]: 'b' } }
    assert.notEqual(dedupeKey(a), dedupeKey(b), `${field} must not collapse`)
  }
})

test('assertPlausible refuses a small recording and one without the control row', () => {
  assert.throws(() => assertPlausible(rows.slice(0, 3)), /below the .* floor/)
  const noControl = rows.filter((row) => row.route !== CONTROL_ROUTE)
  assert.throws(() => assertPlausible(noControl, { minRows: 1 }), /control row/)
  assert.doesNotThrow(() => assertPlausible(rows, { minRows: 1 }))
  assert.ok(MIN_ROWS > rows.length, 'the fixture is deliberately below the floor')
})

test('the join can say no: a mapped code is not reported as unmapped', () => {
  const result = joinRefusals({ rows, normalize: fixtureNormalize, HavenApiError: FixtureHavenApiError })
  const codes = result.typed.map((row) => row.code)
  assert.ok(!codes.includes('delegation_expired'), 'delegation_expired is answered by the fixture mapper')
  assert.ok(!codes.includes('submission_outcome_unknown'), 'submission_outcome_unknown is answered by the fixture mapper')
  assert.ok(result.control.mappedAnswered)
})

test('the join can say yes: a seeded unmapped code is reported', () => {
  const result = joinRefusals({ rows, normalize: fixtureNormalize, HavenApiError: FixtureHavenApiError })
  const codes = result.typed.map((row) => row.code)
  assert.ok(codes.includes('task_budget_not_open'), 'an unmarked typed code must be reported')
  assert.ok(result.control.unmappedReported)
})

test('the positive control refuses a mapper that answers nothing', () => {
  // The control's other half: a mapper that answers nothing must make the join
  // refuse to report, not report everything as unmapped. Without this, a join
  // that reports nothing would pass the test above.
  const answersNothing = (err) => ({ success: false, code: err.code, statusCode: err.statusCode, next_action: 'stop_and_tell_user' })
  assert.throws(
    () => joinRefusals({ rows, normalize: answersNothing, HavenApiError: FixtureHavenApiError }),
    /positive control failed: delegation_expired is not answered/,
  )
})

test('the join applies the allowlist and separates the agent payment routes', () => {
  const allowlist = new Map([['prepare_failed', { code: 'prepare_failed', disposition: 'deliberately-transient', reason: 'retry can change it' }]])
  const result = joinRefusals({ rows, normalize: fixtureNormalize, allowlist, HavenApiError: FixtureHavenApiError })
  const prepare = result.typed.find((row) => row.code === 'prepare_failed')
  assert.equal(prepare.disposition, 'deliberately-transient')
  assert.equal(prepare.reason, 'retry can change it')
  const unmarked = result.typed.find((row) => row.code === 'task_budget_not_open')
  assert.equal(unmarked.disposition, 'unmarked')
  assert.equal(unmarked.paymentRoute, true)
})

test('the join lists 5xx answered transient and non-answers', () => {
  const result = joinRefusals({ rows, normalize: fixtureNormalize, HavenApiError: FixtureHavenApiError })
  const routes = result.transient5xx.map((row) => row.route)
  assert.ok(routes.includes('POST /payments'), 'a 500 with no code reads transient')
  assert.ok(routes.includes('GET /contacts/boom'), 'a test stub route is listed, not filtered')
  assert.equal(result.nonAnswers.length, 1)
  assert.equal(result.nonAnswers[0].route, 'GET /machine-payments/:id/status')
})

test('mapperReadKeys reads the receipt mapper through scanReceiptSurface', () => {
  const source = readFileSync(join(REPO, 'packages/sdk/src/payment-mappers.ts'), 'utf8')
  const keys = mapperReadKeys(source, 'mapPaymentReceipt')
  assert.ok(keys.has('payment_id'))
  assert.ok(keys.has('scope'), 'the conditional tail is read')
  // #4469 landed: the six keys the mapper used to drop are read in block form
  // (`if ('settlement_scheme' in raw) receipt.settlementScheme = …`), which is
  // the shape `scanReceiptSurface` sees.
  for (const key of RECEIPT_KEYS) {
    assert.ok(keys.has(key), `${key} is read by mapPaymentReceipt (#4469)`)
  }
})

test('block 9 reports emitted-but-never-read keys', () => {
  const result = roundTrip({
    rows,
    readSource: (entry) => mapperReadKeys(readFileSync(join(REPO, entry.file), 'utf8'), entry.mapper),
    emits: () => true,
  })
  const receiptKeys = result.emittedNeverRead.filter((row) => row.mapper === 'mapPaymentReceipt').map((row) => row.key)
  // #4469 landed, so the six receipt keys are read and must not be reported.
  // The direction still says yes — `mpp` below and the seeded control — so this
  // is a re-pin to the post-#4469 tree, not a deletion of the direction.
  for (const key of RECEIPT_KEYS) {
    assert.ok(!receiptKeys.includes(key), `${key} is read by mapPaymentReceipt (#4469)`)
  }
  assert.ok(!receiptKeys.includes('scope'), 'scope is read by the mapper')
  const statusKeys = result.emittedNeverRead.filter((row) => row.mapper === 'mapPaymentStatusResult').map((row) => row.key)
  assert.ok(statusKeys.includes('mpp'), 'mpp is declared but never set by mapPaymentStatusResult')
})

test('block 9 reports read-but-never-emitted keys with the false-positive flag', () => {
  const result = roundTrip({
    rows,
    readSource: (entry) => mapperReadKeys(readFileSync(join(REPO, entry.file), 'utf8'), entry.mapper),
    emits: (entry, key) => key === 'x402',
  })
  const status = result.readNeverEmitted.filter((row) => row.mapper === 'mapPaymentStatusResult')
  const x402 = status.find((row) => row.key === 'x402')
  assert.ok(x402, 'x402 is read and not emitted in the fixture')
  assert.equal(x402.emittedInSource, true, 'the builder mentions it — the known false-positive class')
  const unknown = status.find((row) => row.key === 'treasury_account')
  assert.equal(unknown, undefined, 'treasury_account is not read by the status mapper')
})

test('block 9’s seeded control can say yes and no', () => {
  const result = roundTrip({
    rows,
    readSource: (entry) => mapperReadKeys(readFileSync(join(REPO, entry.file), 'utf8'), entry.mapper),
    emits: () => false,
  })
  assert.equal(result.control.seededReported, true)
  assert.equal(result.control.emittedNotReported, true)
  // A recording that emits the seeded key must fail the control, not pass it.
  const poisoned = rows.map((row) =>
    row.method === 'GET' && row.route === '/machine-payments/receipts'
      ? { ...row, body: { ...row.body, receipts: [{ ...row.body.receipts[0], [CONTROL_KEY]: 1 }] } }
      : row,
  )
  assert.throws(
    () => roundTrip({ rows: poisoned, readSource: () => new Set(), emits: () => false }),
    /positive control failed/,
  )
})

test('emittedKeys reads the mapped object, not the list envelope', () => {
  const keys = emittedKeys(rows, 'GET /machine-payments/receipts', 'receipts')
  assert.ok(keys.has('payment_id'))
  assert.ok(!keys.has('total'), 'the envelope is read by listReceiptsPage, not the mapper')
})

test('the recorder does not change a response (toy Fastify app)', (t) => {
  let fastify
  try {
    const require = createRequire(join(REPO, 'packages/backend/package.json'))
    fastify = require(require.resolve('fastify'))
  } catch {
    t.skip('fastify is not installed in this job (no npm ci) — the inertness pin runs where it is')
    return
  }
  const build = (withHook) => {
    const app = fastify()
    if (withHook) {
      app.addHook('onSend', async (request, reply, payload) => payload)
    }
    app.get('/x', async () => ({ ok: true, nested: { a: [1, 2, 3] } }))
    return app
  }
  const plain = build(false)
  const hooked = build(true)
  const a = plain.inject({ method: 'GET', url: '/x' })
  const b = hooked.inject({ method: 'GET', url: '/x' })
  return Promise.all([a, b]).then(([left, right]) => {
    assert.equal(left.statusCode, right.statusCode)
    assert.equal(left.body, right.body, 'the response is byte-identical with and without the hook')
  })
})

test('scanSdkSites classifies literal statuses and lists variable ones with their source', () => {
  const source = [
    "throw new HavenApiError('a', 502)",
    "throw new HavenApiError('b', 408)",
    "throw new HavenApiError('c', 0)",
    "throw new HavenApiError('d', merchantStatus)",
    "throw new HavenApiError(`e ${x}`, statusFrom(res.status))",
    "// throw new HavenApiError('commented', 500)",
  ].join('\n')
  const result = scanSdkSites([{ file: 'packages/sdk/src/fixture.ts', source }])
  assert.equal(result.sites.length, 5, 'the commented site is not a site')
  assert.equal(result.literal.length, 3)
  assert.equal(result.variable.length, 2)
  assert.deepEqual(
    result.variable.map((site) => site.status),
    ['merchantStatus', 'statusFrom(res.status)'],
  )
  assert.deepEqual(
    result.nonAnswers.map((site) => site.status),
    ['408', '0'],
  )
})

test('the control constants are the ones the recorder writes', () => {
  const recorder = readFileSync(join(HERE, 'fixtures/refusal-census/recorder.setup.mjs'), 'utf8')
  assert.ok(recorder.includes('CONTROL_ROUTE'))
  assert.ok(recorder.includes('CONTROL_CODE'))
  assert.equal(CONTROL_CODE, 'refusal_census_control')
  assert.equal(CONTROL_KEY, 'refusal_census_control_key')
})
