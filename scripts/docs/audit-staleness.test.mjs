import test from 'node:test'
import assert from 'node:assert/strict'
import { toPathspec, rankFindings } from './audit-staleness.mjs'

test('toPathspec adds :(glob) only for glob patterns', () => {
  assert.equal(toPathspec('packages/backend/src/index.ts'), 'packages/backend/src/index.ts')
  assert.equal(toPathspec('packages/mcp/**'), ':(glob)packages/mcp/**')
  assert.equal(toPathspec('docs/?.md'), ':(glob)docs/?.md')
})

test('rankFindings sorts by commit count, oldest verification breaking ties', () => {
  const ranked = rankFindings([
    { doc: 'a', commits: 2, lastVerified: '2026-06-01' },
    { doc: 'b', commits: 5, lastVerified: '2026-07-01' },
    { doc: 'c', commits: 2, lastVerified: '2026-05-01' },
  ])
  assert.deepEqual(ranked.map((f) => f.doc), ['b', 'c', 'a'])
})
