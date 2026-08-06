// Unit tests for the front-matter parser and glob matcher.
// Run with: node --test scripts/docs/  (or `npm run docs:test`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFrontMatter, globToRegExp } from './validate-frontmatter.mjs'

test('parses a complete block-list header', () => {
  const r = parseFrontMatter(
    '---\nowner: "@x"\nstatus: current\ncovers:\n  - packages/a.ts\n  - packages/b.ts\nlast-verified: "2026-06-28"\n---\n\n# Title\n',
  )
  assert.equal(r.ok, true)
  assert.equal(r.data.owner, '@x')
  assert.equal(r.data.status, 'current')
  assert.deepEqual(r.data.covers, ['packages/a.ts', 'packages/b.ts'])
  assert.equal(r.data['last-verified'], '2026-06-28')
})

test('strips trailing # comments on block-list items (regression: SF-1)', () => {
  const r = parseFrontMatter(
    '---\nowner: "@x"\nstatus: current\ncovers:\n  - packages/a.ts  # the a route\nlast-verified: "2026-06-28"\n---\n',
  )
  assert.equal(r.ok, true)
  assert.deepEqual(r.data.covers, ['packages/a.ts'])
})

test('treats covers: [] as an empty (narrative) list, comment ignored', () => {
  const r = parseFrontMatter(
    '---\nowner: "@x"\nstatus: archived\ncovers: []  # narrative\nlast-verified: "2026-06-28"\n---\n',
  )
  assert.equal(r.ok, true)
  assert.deepEqual(r.data.covers, [])
})

test('parses inline list form', () => {
  const r = parseFrontMatter('---\ncovers: [a.ts, "b.ts"]\n---\n')
  assert.equal(r.ok, true)
  assert.deepEqual(r.data.covers, ['a.ts', 'b.ts'])
})

test('handles CRLF line endings', () => {
  const r = parseFrontMatter('---\r\nowner: "@x"\r\nstatus: current\r\ncovers: []\r\nlast-verified: "2026-06-28"\r\n---\r\n')
  assert.equal(r.ok, true)
  assert.equal(r.data.owner, '@x')
  assert.deepEqual(r.data.covers, [])
})

test('rejects a file with no front-matter', () => {
  const r = parseFrontMatter('# Just a heading\n')
  assert.equal(r.ok, false)
  assert.match(r.error, /missing front-matter/)
})

test('rejects an unterminated front-matter block', () => {
  const r = parseFrontMatter('---\nowner: "@x"\n')
  assert.equal(r.ok, false)
  assert.match(r.error, /unterminated/)
})

test('globToRegExp: ** matches across directories, * does not', () => {
  assert.match('packages/backend/src/openapi/spec.ts', globToRegExp('packages/backend/src/openapi/**'))
  assert.match('packages/x/y.ts', globToRegExp('packages/**'))
  assert.doesNotMatch('packages/a/b.ts', globToRegExp('packages/*.ts'))
  assert.match('packages/a.ts', globToRegExp('packages/*.ts'))
})

test('globToRegExp: an exact file path matches only itself', () => {
  const re = globToRegExp('packages/backend/src/lib/chains.ts')
  assert.match('packages/backend/src/lib/chains.ts', re)
  assert.doesNotMatch('packages/backend/src/lib/chains.test.ts', re)
})
