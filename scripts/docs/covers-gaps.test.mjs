import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PATH_TOKEN_RE,
  blankFrontMatter,
  namedFiles,
  uncovered,
  countByDoc,
  newGaps,
  hasShrunk,
  lineOf,
} from './covers-gaps.mjs'

const TRACKED = new Set([
  'packages/backend/src/rails/hybrid-signer-actions.ts',
  'packages/backend/src/routes/x402.ts',
  'packages/backend/src/modules/x402/handler.ts',
  'packages/frontend/src/components/ui/Card.tsx',
  'scripts/docs/package-docs.mjs',
  '.github/workflows/dev-gate.yml',
  'package.json',
  'docs/product/design-system.md',
])

const doc = (front, body) => `---\n${front}\n---\n\n${body}\n`

test('finds a body path the covers globs cannot reach — the #1199 shape', () => {
  const raw = doc(
    'owner: "@x"\nstatus: current\ncovers:\n  - packages/backend/src/routes/x402.ts',
    'The `remove_passkey` action lives in `packages/backend/src/rails/hybrid-signer-actions.ts`.',
  )
  const gaps = uncovered(raw, TRACKED, ['packages/backend/src/routes/x402.ts'])
  assert.deepEqual(
    gaps.map((g) => g.file),
    ['packages/backend/src/rails/hybrid-signer-actions.ts'],
  )
})

test('declaring the path closes the gap', () => {
  const raw = doc(
    'owner: "@x"\nstatus: current',
    'See `packages/backend/src/rails/hybrid-signer-actions.ts`.',
  )
  assert.equal(uncovered(raw, TRACKED, ['packages/backend/src/rails/hybrid-signer-actions.ts']).length, 0)
})

test('deleting the claim closes the gap too — the remedy #2678 prefers', () => {
  const raw = doc('owner: "@x"\nstatus: current', 'The signer rail handles it.')
  assert.equal(uncovered(raw, TRACKED, []).length, 0)
})

test('a glob in covers: covers the files it reaches', () => {
  const raw = doc('owner: "@x"\nstatus: current', 'See `packages/backend/src/modules/x402/handler.ts`.')
  assert.equal(uncovered(raw, TRACKED, ['packages/backend/src/modules/x402/**']).length, 0)
  // The same file IS a gap when only a sibling exact path is declared — proving
  // the glob above did the work, not an accident of the token never matching.
  assert.equal(uncovered(raw, TRACKED, ['packages/backend/src/routes/x402.ts']).length, 1)
})

test('untracked path-like prose does not count', () => {
  const raw = doc('owner: "@x"\nstatus: current', 'A `packages/foo/bar.ts` style path.')
  assert.equal(uncovered(raw, TRACKED, []).length, 0)
})

test('front-matter is not scanned — covers: and the chain live there', () => {
  const raw = doc(
    'owner: "@x"\nstatus: current\nlast-verified: 2026-09-07 # touched packages/backend/src/routes/x402.ts',
    'No paths here.',
  )
  assert.equal(uncovered(raw, TRACKED, []).length, 0)
  // Blanking preserves newline count, so body line numbers stay true.
  assert.equal(blankFrontMatter(raw).split('\n').length, raw.split('\n').length)
})

test('a path inside a fenced block IS scanned — a runbook command is a claim', () => {
  const raw = doc('owner: "@x"\nstatus: current', '```bash\nnode scripts/docs/package-docs.mjs\n```')
  assert.deepEqual(
    uncovered(raw, TRACKED, []).map((g) => g.file),
    ['scripts/docs/package-docs.mjs'],
  )
})

test('a link target and a ./-prefixed path are caught', () => {
  const raw = doc(
    'owner: "@x"\nstatus: current',
    'See [the gate](../../.github/workflows/dev-gate.yml) and ./scripts/docs/package-docs.mjs.',
  )
  assert.deepEqual(
    uncovered(raw, TRACKED, []).map((g) => g.file).sort(),
    ['.github/workflows/dev-gate.yml', 'scripts/docs/package-docs.mjs'],
  )
})

test('the extension boundary is exact — x402.tsx is not x402.ts', () => {
  assert.deepEqual(
    'packages/backend/src/routes/x402.tsx'.match(PATH_TOKEN_RE),
    ['packages/backend/src/routes/x402.tsx'],
  )
})

test('each file is reported once, at its first mention', () => {
  const raw = doc(
    'owner: "@x"\nstatus: current',
    'First `scripts/docs/package-docs.mjs`.\n\nAgain: `scripts/docs/package-docs.mjs`.',
  )
  const gaps = uncovered(raw, TRACKED, [])
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].line, 6)
})

// --- What this deliberately does NOT catch. Pinned so none of it is an accident.

test('MISS: a path split across a hard wrap', () => {
  const raw = doc(
    'owner: "@x"\nstatus: current',
    'The handler lives in packages/backend/src/\nrails/hybrid-signer-actions.ts today.',
  )
  assert.equal(uncovered(raw, TRACKED, []).length, 0)
})

test('MISS: a path split by inline markup', () => {
  const raw = doc('owner: "@x"\nstatus: current', 'See packages/backend/**src**/routes/x402.ts.')
  assert.equal(uncovered(raw, TRACKED, []).length, 0)
})

test('MISS: a tracked path outside the three scanned prefixes', () => {
  const raw = doc('owner: "@x"\nstatus: current', 'Declared in `package.json` and `docs/product/design-system.md`.')
  assert.equal(uncovered(raw, TRACKED, []).length, 0)
})

test('MISS: a path with no code extension, and a bare directory', () => {
  const raw = doc('owner: "@x"\nstatus: current', 'Under `packages/backend/src/rails/` and in the Dockerfile.')
  assert.equal(uncovered(raw, TRACKED, []).length, 0)
})

test('MISS: a package-relative path with no repo-root prefix', () => {
  const raw = doc('owner: "@x"\nstatus: current', 'See ./src/routes/x402.ts from the package root.')
  assert.equal(uncovered(raw, TRACKED, []).length, 0)
})

test('MISS: a file that no longer exists — the ls-files intersection drops it', () => {
  const raw = doc('owner: "@x"\nstatus: current', 'See `packages/backend/src/rails/deleted-rail.ts`.')
  assert.equal(uncovered(raw, TRACKED, []).length, 0)
})

// --- Baseline ratchet

test('baseline: a rise fails, an equal count passes, a fall reports shrink', () => {
  const counts = { 'a.md': 3, 'b.md': 1 }
  assert.deepEqual(newGaps(counts, { 'a.md': 3, 'b.md': 1 }), [])
  assert.deepEqual(newGaps(counts, { 'a.md': 2, 'b.md': 1 }), [{ doc: 'a.md', count: 3, allowed: 2 }])
  // A doc absent from the baseline is allowed zero.
  assert.deepEqual(newGaps({ 'c.md': 1 }, {}), [{ doc: 'c.md', count: 1, allowed: 0 }])
  assert.equal(hasShrunk(counts, { 'a.md': 3, 'b.md': 1 }), false)
  assert.equal(hasShrunk(counts, { 'a.md': 4, 'b.md': 1 }), true)
  // A doc that dropped to zero disappears from `counts` entirely.
  assert.equal(hasShrunk({ 'a.md': 3 }, { 'a.md': 3, 'b.md': 1 }), true)
})

test('countByDoc is sorted and counts pairs', () => {
  const results = [
    { doc: 'z.md', gaps: [{ file: 'x' }] },
    { doc: 'a.md', gaps: [{ file: 'x' }, { file: 'y' }] },
  ]
  assert.deepEqual(Object.entries(countByDoc(results)), [['a.md', 2], ['z.md', 1]])
})

test('lineOf and namedFiles agree on position', () => {
  assert.equal(lineOf('a\nb\nc', 4), 3)
  const raw = doc('owner: "@x"\nstatus: current', 'line one\nline two `scripts/docs/package-docs.mjs`')
  assert.equal(namedFiles(raw, TRACKED)[0].line, 7)
})
