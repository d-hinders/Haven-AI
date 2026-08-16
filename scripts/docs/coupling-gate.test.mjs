// Unit tests for the coupling gate's pure core.
// Run with: npm run docs:test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { implicatedDocs, ageDays, isIncidentalPath } from './coupling-gate.mjs'

const DOCS = [
  { doc: 'docs/architecture/04-x402.md', covers: ['packages/backend/src/routes/x402.ts'], lastVerified: '2026-06-01' },
  { doc: 'docs/regulatory/casp.md', covers: ['packages/backend/src/routes/x402.ts', 'packages/backend/src/routes/payments.ts'], lastVerified: '2026-06-01' },
  { doc: 'docs/product/README.md', covers: [], lastVerified: '2026-06-01' }, // narrative
  { doc: 'docs/operations/hosted-mcp.md', covers: ['packages/mcp-server/**'], lastVerified: '2026-06-01' },
]

test('flags docs whose covers match a changed file', () => {
  const f = implicatedDocs(['packages/backend/src/routes/x402.ts'], DOCS)
  assert.deepEqual(f.map((x) => x.doc).sort(), ['docs/architecture/04-x402.md', 'docs/regulatory/casp.md'])
})

test('records every matched file on a doc', () => {
  const f = implicatedDocs(
    ['packages/backend/src/routes/x402.ts', 'packages/backend/src/routes/payments.ts'],
    DOCS,
  )
  const casp = f.find((x) => x.doc === 'docs/regulatory/casp.md')
  assert.deepEqual(casp.matched, [
    'packages/backend/src/routes/payments.ts',
    'packages/backend/src/routes/x402.ts',
  ])
})

test('does not flag a doc that was itself changed', () => {
  const f = implicatedDocs(
    ['packages/backend/src/routes/x402.ts', 'docs/architecture/04-x402.md'],
    DOCS,
  )
  assert.deepEqual(f.map((x) => x.doc), ['docs/regulatory/casp.md'])
})

test('ignores narrative docs (empty covers)', () => {
  const f = implicatedDocs(['docs/product/README.md', 'packages/x/y.ts'], DOCS)
  assert.equal(f.length, 0)
})

test('matches ** globs across directories', () => {
  const f = implicatedDocs(['packages/mcp-server/src/http.ts'], DOCS)
  assert.deepEqual(f.map((x) => x.doc), ['docs/operations/hosted-mcp.md'])
})

test('returns nothing when no changed file is covered', () => {
  assert.equal(implicatedDocs(['packages/frontend/src/app/page.tsx'], DOCS).length, 0)
})

test('ageDays computes whole-day differences', () => {
  const now = Date.parse('2026-06-11T00:00:00Z')
  assert.equal(ageDays('2026-06-01', now), 10)
  assert.equal(ageDays('not-a-date', now), null)
})

test('suppresses a doc whose last-verified is today (same-day)', () => {
  // Inject '2026-06-01' as today → matches every doc's lastVerified → all suppressed.
  const f = implicatedDocs(['packages/backend/src/routes/x402.ts'], DOCS, '2026-06-01')
  assert.equal(f.length, 0)
})

test('still flags a doc verified before today', () => {
  // today is later than the docs' 2026-06-01 verification → not suppressed.
  const f = implicatedDocs(['packages/backend/src/routes/x402.ts'], DOCS, '2026-06-02')
  assert.deepEqual(f.map((x) => x.doc).sort(), ['docs/architecture/04-x402.md', 'docs/regulatory/casp.md'])
})

test('carries the contract flag through to findings (#646 strict mode)', () => {
  const docs = [
    { doc: 'docs/a.md', covers: ['packages/x/**'], lastVerified: '2026-06-01', contract: true },
    { doc: 'docs/b.md', covers: ['packages/x/**'], lastVerified: '2026-06-01' },
  ]
  const f = implicatedDocs(['packages/x/y.ts'], docs, '2026-06-02')
  assert.deepEqual(
    f.map((x) => [x.doc, x.contract]).sort(),
    [['docs/a.md', true], ['docs/b.md', false]],
  )
})

// --- #1077: same-day suppression must not weaken the BLOCKING half ---

const CONTRACT_DOCS = [
  { doc: 'docs/regulatory/casp.md', covers: ['packages/x/**'], lastVerified: '2026-06-01', contract: true },
  { doc: 'docs/advisory.md', covers: ['packages/x/**'], lastVerified: '2026-06-01' },
]

test('strict mode does not same-day-suppress a contract doc', () => {
  // A contract doc verified today by some OTHER PR says nothing about whether
  // THIS PR made it stale. Suppressing it would make a required check depend on
  // wall-clock time: green at 23:59, red at 00:01 with no code change.
  const f = implicatedDocs(['packages/x/y.ts'], CONTRACT_DOCS, '2026-06-01', { strict: true })
  assert.deepEqual(f.map((x) => x.doc), ['docs/regulatory/casp.md'])
})

test('strict mode still same-day-suppresses an advisory doc', () => {
  const f = implicatedDocs(['packages/x/y.ts'], CONTRACT_DOCS, '2026-06-01', { strict: true })
  assert.equal(f.some((x) => x.doc === 'docs/advisory.md'), false)
})

test('advisory mode same-day-suppresses a contract doc as before', () => {
  const f = implicatedDocs(['packages/x/y.ts'], CONTRACT_DOCS, '2026-06-01')
  assert.equal(f.length, 0)
})

// --- #1077: tests and generated files are incidental to prose ---

test('isIncidentalPath recognises tests and generated files', () => {
  for (const p of [
    'packages/frontend/src/components/__tests__/BudgetGrantAction.test.tsx',
    'packages/backend/src/routes/agent-connection-setups.test.ts',
    'packages/sdk/src/x402.spec.ts',
    'packages/core/src/api-types.ts',
  ]) {
    assert.equal(isIncidentalPath(p), true, p)
  }
  for (const p of [
    'packages/frontend/src/components/BudgetGrantAction.tsx',
    'packages/backend/src/routes/agent-connection-setups.ts',
    'packages/backend/src/lib/latest.ts', // "test" as a substring must not match
  ]) {
    assert.equal(isIncidentalPath(p), false, p)
  }
})

test('a wildcard glob does not implicate via a test file alone', () => {
  const docs = [{ doc: 'docs/product/design-review.md', covers: ['packages/frontend/src/components/**'], lastVerified: '2026-06-01' }]
  const f = implicatedDocs(
    ['packages/frontend/src/components/__tests__/BudgetGrantAction.test.tsx'],
    docs,
    '2026-06-02',
  )
  assert.equal(f.length, 0)
})

test('a non-test sibling under the same glob still implicates', () => {
  const docs = [{ doc: 'docs/product/design-review.md', covers: ['packages/frontend/src/components/**'], lastVerified: '2026-06-01' }]
  const f = implicatedDocs(
    [
      'packages/frontend/src/components/BudgetGrantAction.tsx',
      'packages/frontend/src/components/__tests__/BudgetGrantAction.test.tsx',
    ],
    docs,
    '2026-06-02',
  )
  // Implicated by the source file, and the incidental test is not listed as evidence.
  assert.deepEqual(f.map((x) => x.matched), [['packages/frontend/src/components/BudgetGrantAction.tsx']])
})

test('strict mode does not filter incidental paths for a contract doc (review finding)', () => {
  // casp-risk-guardrails.md covers `packages/sdk/src/**` — a wildcard. Filtering
  // test files out of a BLOCKING gate reopens the same green-when-it-should-be-red
  // hole this gate exists to close: a test-only PR against a money-path package.
  const docs = [{
    doc: 'docs/regulatory/casp.md',
    covers: ['packages/sdk/src/**'],
    lastVerified: '2026-06-01',
    contract: true,
  }]
  const changed = ['packages/sdk/src/client.test.ts']
  assert.equal(implicatedDocs(changed, docs, '2026-06-02', { strict: true }).length, 1)
  // Advisory posture keeps the noise reduction.
  assert.equal(implicatedDocs(changed, docs, '2026-06-02').length, 0)
})

test('packages whose content IS tests are never incidental', () => {
  // e2e-qa-runbook.md covers `packages/frontend/e2e/live/**` and agent-qa.md
  // covers `packages/qa-agent/**` — those specs are the documented subject, not
  // a test of some other source.
  assert.equal(isIncidentalPath('packages/frontend/e2e/live/smoke.spec.ts'), false)
  assert.equal(isIncidentalPath('packages/qa-agent/src/scenarios/x402.test.ts'), false)

  const docs = [{ doc: 'docs/operations/agent-qa.md', covers: ['packages/qa-agent/**'], lastVerified: '2026-06-01' }]
  const f = implicatedDocs(['packages/qa-agent/src/scenarios/x402.test.ts'], docs, '2026-06-02')
  assert.deepEqual(f.map((x) => x.doc), ['docs/operations/agent-qa.md'])
})

test('an EXACT covers entry still implicates via a test file', () => {
  // 07-edge-signer.md deliberately pins hosted-signer-integration.test.ts.
  const docs = [{
    doc: 'docs/architecture/07-edge-signer.md',
    covers: ['packages/mcp-server/src/hosted-signer-integration.test.ts'],
    lastVerified: '2026-06-01',
  }]
  const f = implicatedDocs(['packages/mcp-server/src/hosted-signer-integration.test.ts'], docs, '2026-06-02')
  assert.deepEqual(f.map((x) => x.doc), ['docs/architecture/07-edge-signer.md'])
})

// ── #1337: computed-empty vs uncomputable change-sets ────────────────────────
import { changedFilesWithProvenance } from './coupling-gate.mjs'
import { execFileSync as _exec } from 'node:child_process'
import { test as test1337 } from 'node:test'
import assert1337 from 'node:assert'

test1337('a CI three-dot range that computes to empty is provably computed (pure merge/sync PR passes strict)', () => {
  const head = _exec('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  process.env.BASE_SHA = head
  process.env.HEAD_SHA = head
  try {
    const r = changedFilesWithProvenance()
    assert1337.deepStrictEqual(r.files, [])
    assert1337.strictEqual(r.computed, true)
  } finally {
    delete process.env.BASE_SHA
    delete process.env.HEAD_SHA
  }
})

test1337('a BROKEN range stays fail-closed: empty but not computed (#1076 protection intact)', () => {
  process.env.BASE_SHA = '0000000000000000000000000000000000000000'
  process.env.HEAD_SHA = 'HEAD'
  try {
    const r = changedFilesWithProvenance()
    assert1337.deepStrictEqual(r.files, [])
    assert1337.strictEqual(r.computed, false)
  } finally {
    delete process.env.BASE_SHA
    delete process.env.HEAD_SHA
  }
})

// ── #1366: satisfied-by shards ────────────────────────────────────────────────

import { test as test1366 } from 'node:test'
import assert1366 from 'node:assert'

const SHARDED_DOC = {
  doc: 'docs/regulatory/casp-risk-guardrails.md',
  covers: ['packages/signer/**'],
  lastVerified: '2020-01-01',
  contract: true,
  satisfiedBy: ['docs/regulatory/casp-changelog/**'],
}

test1366('a changed shard satisfies the contract doc in strict mode (#1366)', () => {
  const f = implicatedDocs(
    ['packages/signer/src/core.ts', 'docs/regulatory/casp-changelog/2026-08-12-1399.md'],
    [SHARDED_DOC],
    undefined,
    { strict: true },
  )
  assert1366.deepStrictEqual(f, [])
})

test1366('MUTATION PROOF: the same change WITHOUT a shard still blocks (#1366)', () => {
  const f = implicatedDocs(
    ['packages/signer/src/core.ts'],
    [SHARDED_DOC],
    undefined,
    { strict: true },
  )
  assert1366.strictEqual(f.length, 1)
  assert1366.strictEqual(f[0].contract, true)
})

test1366('a shard satisfies ONLY docs that declare it — not every contract doc (#1366)', () => {
  const other = {
    doc: 'docs/architecture/04-x402-payment-sequence.md',
    covers: ['packages/signer/**'],
    lastVerified: '2020-01-01',
    contract: true,
    satisfiedBy: [],
  }
  const f = implicatedDocs(
    ['packages/signer/src/core.ts', 'docs/regulatory/casp-changelog/2026-08-12-1399.md'],
    [SHARDED_DOC, other],
    undefined,
    { strict: true },
  )
  assert1366.strictEqual(f.length, 1)
  assert1366.strictEqual(f[0].doc, other.doc)
})

// #1496 — a doc with satisfied-by is satisfied by a shard, NOT by editing the
// doc; and the strict error names that path. Three one-day merge conflicts
// came from PRs editing the same last-verified line while their shards
// already satisfied the gate — because the message never said so.
test('a satisfied-by shard suppresses the strict contract finding (#1496)', () => {
  const docs = [{
    doc: 'docs/regulatory/casp-risk-guardrails.md',
    covers: ['packages/backend/src/modules/x402/**'],
    lastVerified: '2020-01-01',
    contract: true,
    satisfiedBy: ['docs/regulatory/casp-changelog/**'],
  }]
  const withShard = implicatedDocs(
    ['packages/backend/src/modules/x402/helpers.ts', 'docs/regulatory/casp-changelog/2026-08-16-1.md'],
    docs, '2000-01-01', { strict: true },
  )
  assert.deepEqual(withShard, [])
  const withoutShard = implicatedDocs(
    ['packages/backend/src/modules/x402/helpers.ts'],
    docs, '2000-01-01', { strict: true },
  )
  assert.equal(withoutShard.length, 1)
})
