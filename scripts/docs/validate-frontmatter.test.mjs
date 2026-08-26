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

// ── #1366: satisfied-by is its OWN key — it must never clobber covers ─────────

import { test as test1366fm } from 'node:test'
import assert1366fm from 'node:assert'
import { parseFrontMatter as pfm1366 } from './validate-frontmatter.mjs'

test1366fm('satisfied-by parses as a separate list and covers survives (#1366)', () => {
  const raw = [
    '---',
    'owner: "@x"',
    'status: current',
    'covers:',
    '  - packages/signer/**',
    'satisfied-by:',
    '  - docs/regulatory/casp-changelog/**',
    'last-verified: "2026-08-12"',
    '---',
    '',
  ].join('\n')
  const parsed = pfm1366(raw)
  assert1366fm.strictEqual(parsed.ok, true)
  // The clobber bug this guards: both list keys writing to data.covers would
  // leave covers = the satisfied-by items — silently un-covering the code.
  assert1366fm.deepStrictEqual(parsed.data.covers, ['packages/signer/**'])
  assert1366fm.deepStrictEqual(parsed.data['satisfied-by'], ['docs/regulatory/casp-changelog/**'])
})

// ── `covers: []` must state a reason (#1993) ─────────────────────────────────
//
// Positive AND negative control for the rule, because the rule's own value is
// that it can distinguish "deliberately uncoupled, here is why" from "nobody
// decided". A detector that only ever answers "fine" would make that
// distinction unmeasurable — which is the failure the rule exists to catch,
// one layer up.
import { emptyCoversNote } from './validate-frontmatter.mjs'

test('emptyCoversNote: reads the inline reason on a literal `covers: []`', () => {
  const raw = '---\nowner: "@x"\nstatus: current\ncovers: []  # narrative — no direct code mirror\nlast-verified: "2026-08-26"\n---\n'
  assert.equal(emptyCoversNote(raw), 'narrative — no direct code mirror')
})

test('emptyCoversNote: an UNEXPLAINED `covers: []` returns null — the finding', () => {
  const raw = '---\nowner: "@x"\nstatus: current\ncovers: []\nlast-verified: "2026-08-26"\n---\n'
  assert.equal(emptyCoversNote(raw), null)
})

test('emptyCoversNote: a bare `#` with no text is not a reason', () => {
  const raw = '---\ncovers: []  #\n---\n'
  assert.equal(emptyCoversNote(raw), null)
})

test('emptyCoversNote: a NON-empty covers list is out of scope (returns null)', () => {
  const raw = '---\ncovers:\n  - packages/backend/src/index.ts  # not a reason\n---\n'
  assert.equal(emptyCoversNote(raw), null)
})

test('emptyCoversNote: CRLF front-matter is read the same way', () => {
  const raw = '---\r\ncovers: []  # process playbook\r\n---\r\n'
  assert.equal(emptyCoversNote(raw), 'process playbook')
})

test('emptyCoversNote: the non-canonical empty spellings fail CLOSED, not open', () => {
  // Both parse to an empty `covers` list, so the caller blocks; neither can be
  // rescued by a reason written on them. Pinned so the fail-closed direction is
  // a decision on record rather than an accident (#1993, from review).
  assert.equal(emptyCoversNote('---\ncovers: [ ]  # spaced inline\n---\n'), null)
  assert.equal(emptyCoversNote('---\ncovers:  # block header, no items\n---\n'), null)
})

test('emptyCoversNote: a `#` inside the reason text survives', () => {
  const raw = '---\ncovers: []  # narrative — see #1993 for why\n---\n'
  assert.equal(emptyCoversNote(raw), 'narrative — see #1993 for why')
})
