// Unit tests for the coupling gate's pure core.
// Run with: npm run docs:test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { implicatedDocs, ageDays } from './coupling-gate.mjs'

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
