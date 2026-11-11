// Self-test for the catalog-conformance instrument (#4757, quality-scan block 10).
//
// Runs in the always-run *Repo CI config checks* job (`node --test
// scripts/ci/*.test.mjs`), so it does no `npm ci` and no build: the join runs on
// the committed fixtures, and the header-budget arithmetic runs on a fixture
// encoder. The real `x402V2PaymentEnvelope` and `x402RetryHeadersFor` are the
// block command's job (`node scripts/ci/catalog-conformance.mjs fixtures`,
// against the built SDK), and the block records the figures it printed.
//
// WHAT IT PROVES, AND WHAT IT DOES NOT
//
// It proves the JOIN can say yes and no: a pair whose 402 declares a different
// method and a query parameter is reported, a matching pair is not, and a 402
// with no `extensions.bazaar.info.input` is reported as `no declared input`
// rather than as a match. It proves the budget arithmetic and its thresholds on
// a fixture encoder. It does not prove the real envelope produces the bytes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  FIXTURE_DIR,
  HEADER_CLEAN_MAX,
  HEADER_FAIL_MIN,
  HAVEN_OPERATED_HOSTS,
  challengeFrom,
  compareCallShape,
  declaredInput,
  fixtureControls,
  headerBudget,
  selectThirdPartyRows,
  summariseListing,
} from './catalog-conformance.mjs'

const read = (name) => JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'))
const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
const oneName = () => ['PAYMENT-SIGNATURE']
const bothNames = () => ['PAYMENT-SIGNATURE', 'X-PAYMENT']

test('declaredInput reads extensions.bazaar.info.input and nothing else', () => {
  const input = declaredInput(read('challenge-mismatch.json'))
  assert.equal(input.method, 'POST')
  assert.equal(input.bodyType, 'json')
  assert.deepEqual(Object.keys(input.queryParams), ['network'])
  assert.equal(declaredInput(read('challenge-no-input.json')), null)
  assert.equal(declaredInput({}), null)
  assert.equal(declaredInput({ extensions: { bazaar: { schema: {} } } }), null)
  assert.equal(declaredInput(null), null)
})

test('half A: a mismatching pair is reported, a matching pair is not, a no-input 402 is a lead', () => {
  const controls = fixtureControls()

  const mismatch = compareCallShape(controls.mismatch.row, controls.mismatch.challenge)
  assert.equal(mismatch.verdict, 'mismatch')
  assert.match(mismatch.detail, /method: row GET, 402 POST/)
  assert.match(mismatch.detail, /body: row none, 402 json/)
  assert.match(mismatch.detail, /query parameters the catalog cannot carry: network/)

  const match = compareCallShape(controls.match.row, controls.match.challenge)
  assert.equal(match.verdict, 'match')
  assert.equal(match.detail, 'row and 402 agree on POST')

  const noInput = compareCallShape(controls.noInput.row, controls.noInput.challenge)
  assert.equal(noInput.verdict, 'no declared input')
  assert.match(noInput.detail, /no extensions\.bazaar\.info\.input/)
})

test('half A: a row with no http_method is compared as GET, the refresh default', () => {
  const row = { http_method: null, body_type: null, body_example: null }
  const challenge = { extensions: { bazaar: { info: { input: { type: 'http', method: 'GET' } } } } }
  assert.equal(compareCallShape(row, challenge).verdict, 'match')
  const post = { extensions: { bazaar: { info: { input: { type: 'http', method: 'POST' } } } } }
  assert.equal(compareCallShape(row, post).verdict, 'mismatch')
})

test('half B: product is bytes × names, and the thresholds are the observed ones', () => {
  const small = { x402Version: 2, accepted: { scheme: 'exact' }, payload: { signature: '0x' } }
  const clean = headerBudget(small, { encode, namesFor: oneName })
  assert.equal(clean.product, clean.bytes)
  assert.equal(clean.verdict, 'clean')

  const v1 = headerBudget(small, { encode, namesFor: bothNames })
  assert.equal(v1.product, v1.bytes * 2)
  assert.equal(v1.names.length, 2)

  // A header between the two observed figures is a lead, above the failure a finding.
  const filler = (n) => ({ x402Version: 2, extensions: { bazaar: { info: { input: { body: 'x'.repeat(n) } } } } })
  const lead = headerBudget(filler(HEADER_CLEAN_MAX), { encode, namesFor: oneName })
  assert.ok(lead.product > HEADER_CLEAN_MAX, `${lead.product} should exceed ${HEADER_CLEAN_MAX}`)
  assert.equal(lead.verdict, 'lead')
  const finding = headerBudget(filler(HEADER_FAIL_MIN), { encode, namesFor: oneName })
  assert.ok(finding.product > HEADER_FAIL_MIN)
  assert.equal(finding.verdict, 'finding')
})

test('half B: the largest echoed extension is measured, and an echo-less envelope reads 0', () => {
  const envelope = {
    x402Version: 2,
    extensions: { bazaar: { info: { input: { body: 'x'.repeat(100) } } }, 'haven-passport': { chain_id: 8453 } },
  }
  const budget = headerBudget(envelope, { encode, namesFor: oneName })
  assert.equal(budget.largestExtension, Buffer.byteLength(JSON.stringify(envelope.extensions.bazaar), 'utf8'))
  assert.ok(budget.largestExtension > Buffer.byteLength(JSON.stringify(envelope.extensions['haven-passport']), 'utf8'))
  assert.equal(headerBudget({ x402Version: 2 }, { encode, namesFor: oneName }).largestExtension, 0)
})

test('the large-echo fixture is in the size class that answered 431 (non-vacuity)', () => {
  const challenge = read('challenge-large-echo.json')
  const echo = Buffer.byteLength(JSON.stringify(challenge.extensions.bazaar), 'utf8')
  assert.ok(echo >= 5 * 1024, `the fixture echo is ${echo} bytes, below the 5 KB control`)
  const budget = headerBudget(
    { x402Version: 2, resource: challenge.resource, accepted: challenge.accepts[0], payload: { signature: '0x' }, extensions: challenge.extensions },
    { encode, namesFor: oneName },
  )
  assert.ok(budget.product > HEADER_CLEAN_MAX, `the fixture header is ${budget.product} bytes, not above ${HEADER_CLEAN_MAX}`)
})

test('the third-party tier selects active operator http rows and excludes the rest', () => {
  const entries = [
    { name: 'a', status: 'active', source: 'operator', protocol: 'http', endpoint_host: 'api.third-party.test' },
    { name: 'b', status: 'active', source: 'operator', protocol: 'mcp', endpoint_host: 'api.third-party.test' },
    { name: 'c', status: 'active', source: 'bazaar', protocol: 'http', endpoint_host: 'api.bazaar.test' },
    { name: 'd', status: 'degraded', source: 'operator', protocol: 'http', endpoint_host: 'api.third-party.test' },
    { name: 'e', status: 'active', source: 'operator', protocol: 'http', endpoint_host: HAVEN_OPERATED_HOSTS[0] },
  ]
  assert.deepEqual(selectThirdPartyRows(entries).map((e) => e.name), ['a'])
  const summary = summariseListing(entries)
  assert.equal(summary.entries, 5)
  assert.equal(summary.active, 4)
  assert.equal(summary.httpOperator, 2)
  assert.equal(summary.mcpOperator, 1)
  assert.equal(summary.bazaar, 1)
  assert.equal(summary.thirdParty, 1)
  assert.deepEqual(summary.hosts, ['api.third-party.test'])
})

test('challengeFrom reads the PAYMENT-REQUIRED header, then the body', () => {
  const challenge = read('challenge-match.json')
  const header = Buffer.from(JSON.stringify(challenge), 'utf8').toString('base64')
  const headers = { get: (name) => (name === 'PAYMENT-REQUIRED' ? header : null) }
  assert.deepEqual(challengeFrom(headers, null), challenge)
  assert.deepEqual(challengeFrom({ get: () => null }, challenge), challenge)
  assert.equal(challengeFrom({ get: () => null }, null), null)
  assert.deepEqual(challengeFrom({ get: () => 'not base64 json' }, challenge), challenge)
})
