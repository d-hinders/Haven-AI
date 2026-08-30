// Unit tests for the `packages/**` Markdown boundary (#2088).
// Run with: node --test scripts/docs/*.test.mjs  (or `npm run docs:test`).
//
// The point of this file is not that the boundary says YES on today's tree —
// a check that can only say yes is exactly the defect #2088 is about. Every
// rule below is exercised in BOTH directions, and the last three tests are
// controls: an empty scan must fail, a real widening must be detected, and the
// real tree must pass for a reason that is measured rather than assumed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  GOVERNED_PACKAGE_DOCS,
  EXEMPT_PACKAGE_DOCS,
  enumeratePackageDocs,
  checkPackageDocBoundary,
  packageDocRecords,
  boundaryScopeNotes,
} from './package-docs.mjs'
import { REPO_ROOT, walk } from './validate-frontmatter.mjs'

/** The real tree, walked once. */
const ALL_FILES = await walk(REPO_ROOT)

/** A synthetic file list that satisfies the boundary, for negative controls. */
function cleanTree(extra = []) {
  return [
    ...GOVERNED_PACKAGE_DOCS.flatMap((e) => [e.doc, ...e.covers.map((g) => g.replace(/\*\*$/, 'x.ts'))]),
    ...Object.keys(EXEMPT_PACKAGE_DOCS),
    ...extra,
  ]
}

test('the real repository tree satisfies the boundary', () => {
  assert.deepEqual(checkPackageDocBoundary(ALL_FILES), [])
})

test('REACH CONTROL: the enumeration actually sees the packages Markdown', () => {
  // A boundary check whose input is empty passes everything. Pin a floor, and
  // pin that both sets are non-trivial, so a future refactor that quietly stops
  // walking `packages/` cannot report a perfect run.
  const found = enumeratePackageDocs(ALL_FILES)
  assert.ok(found.length >= 13, `expected >= 13 packages/**/*.md, saw ${found.length}`)
  assert.ok(GOVERNED_PACKAGE_DOCS.length >= 5, 'the governed set must not be empty')
  assert.ok(Object.keys(EXEMPT_PACKAGE_DOCS).length >= 1, 'the exempt set must not be empty')
  // Every published package's README is governed — that is the enforced core.
  for (const p of ['sdk', 'signer', 'mcp', 'connect', 'cli']) {
    assert.ok(
      GOVERNED_PACKAGE_DOCS.some((e) => e.doc === `packages/${p}/README.md`),
      `packages/${p}/README.md (published to npm) must be governed`,
    )
  }
})

test('POSITIVE CONTROL: an empty enumeration is an error, not a pass', () => {
  const errors = checkPackageDocBoundary(['README.md', 'docs/x.md'])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /enumerated ZERO/)
})

test('a new packages/**/*.md in NEITHER set fails, and is named', () => {
  const errors = checkPackageDocBoundary(cleanTree(['packages/sdk/NOTES.md']))
  assert.equal(errors.length, 1)
  assert.match(errors[0], /packages\/sdk\/NOTES\.md/)
  assert.match(errors[0], /registered in neither/)
})

test('a nested new file is caught too, not just package-root READMEs', () => {
  const errors = checkPackageDocBoundary(cleanTree(['packages/backend/src/modules/x402/README.md']))
  assert.equal(errors.length, 1)
  assert.match(errors[0], /modules\/x402\/README\.md/)
})

test('taking a governed file out of the enforced set is detected', () => {
  // The mutation a maintainer would reach for to "quiet" the gate: delete the
  // row. The file is still on disk, so it must land in neither set and be named
  // — the gate notices the removal instead of silently shrinking its scope.
  const [removed] = GOVERNED_PACKAGE_DOCS.splice(0, 1)
  try {
    const errors = checkPackageDocBoundary(ALL_FILES)
    assert.equal(errors.length, 1, errors.join('\n'))
    assert.match(errors[0], new RegExp(removed.doc.replace(/[/.]/g, '\\$&')))
    assert.match(errors[0], /registered in neither/)
  } finally {
    GOVERNED_PACKAGE_DOCS.unshift(removed)
  }
  // …and the tree is clean again once it is back.
  assert.deepEqual(checkPackageDocBoundary(ALL_FILES), [])
})

test('a path in BOTH sets is ambiguous and fails', () => {
  const doc = GOVERNED_PACKAGE_DOCS[0].doc
  const saved = EXEMPT_PACKAGE_DOCS[doc]
  EXEMPT_PACKAGE_DOCS[doc] = 'conflicting decision'
  try {
    const errors = checkPackageDocBoundary(cleanTree())
    assert.equal(errors.length, 1)
    assert.match(errors[0], /is in BOTH/)
  } finally {
    if (saved === undefined) delete EXEMPT_PACKAGE_DOCS[doc]
    else EXEMPT_PACKAGE_DOCS[doc] = saved
  }
})

test('a manifest row naming a file that does not exist fails (no stale rows)', () => {
  const tree = cleanTree().filter((p) => p !== GOVERNED_PACKAGE_DOCS[0].doc)
  const errors = checkPackageDocBoundary(tree)
  assert.ok(errors.some((e) => /GOVERNED_PACKAGE_DOCS names/.test(e)), errors.join('\n'))
})

test('a stale EXEMPT row fails the same way', () => {
  const path = Object.keys(EXEMPT_PACKAGE_DOCS)[0]
  const errors = checkPackageDocBoundary(cleanTree().filter((p) => p !== path))
  assert.ok(errors.some((e) => /EXEMPT_PACKAGE_DOCS names/.test(e)), errors.join('\n'))
})

test('an exemption with no written reason fails (#1993, one bucket out)', () => {
  const path = Object.keys(EXEMPT_PACKAGE_DOCS)[0]
  const saved = EXEMPT_PACKAGE_DOCS[path]
  EXEMPT_PACKAGE_DOCS[path] = '   '
  try {
    const errors = checkPackageDocBoundary(cleanTree())
    assert.ok(errors.some((e) => /needs a written reason/.test(e)), errors.join('\n'))
  } finally {
    EXEMPT_PACKAGE_DOCS[path] = saved
  }
})

test('a governed entry with an empty covers fails — no covers:[] via a side door', () => {
  const entry = GOVERNED_PACKAGE_DOCS[0]
  const saved = entry.covers
  entry.covers = []
  try {
    const errors = checkPackageDocBoundary(cleanTree())
    assert.ok(errors.some((e) => /non-empty `covers`/.test(e)), errors.join('\n'))
  } finally {
    entry.covers = saved
  }
})

test('a governed covers glob that resolves to nothing fails', () => {
  const entry = GOVERNED_PACKAGE_DOCS[0]
  const saved = entry.covers
  // Build the tree BEFORE the mutation: `cleanTree()` derives its file list
  // from `covers`, so mutating first would helpfully invent the very file the
  // assertion needs to be missing.
  const tree = cleanTree()
  entry.covers = ['packages/nope/src/**']
  try {
    const errors = checkPackageDocBoundary(tree)
    assert.ok(errors.some((e) => /resolves to no files/.test(e)), errors.join('\n'))
  } finally {
    entry.covers = saved
  }
})

test('a governed entry with a malformed last-verified or status fails', () => {
  const entry = GOVERNED_PACKAGE_DOCS[0]
  const savedDate = entry['last-verified']
  const savedStatus = entry.status
  entry['last-verified'] = 'yesterday'
  entry.status = 'live'
  try {
    const errors = checkPackageDocBoundary(cleanTree())
    assert.ok(errors.some((e) => /last-verified` must be YYYY-MM-DD/.test(e)), errors.join('\n'))
    assert.ok(errors.some((e) => /invalid status "live"/.test(e)), errors.join('\n'))
  } finally {
    entry['last-verified'] = savedDate
    entry.status = savedStatus
  }
})

test('every governed covers glob resolves on the REAL tree', () => {
  // Not redundant with the boundary test above: that one would still pass if
  // `covers` were quietly narrowed to something trivially true. This asserts
  // each glob names real code, per doc, so a failure says which doc.
  assert.deepEqual(checkPackageDocBoundary(ALL_FILES), [])
  for (const entry of GOVERNED_PACKAGE_DOCS) {
    for (const glob of entry.covers) {
      assert.ok(
        ALL_FILES.some((f) => f.startsWith(glob.replace(/\*\*$/, ''))),
        `${entry.doc}: covers "${glob}" names no real path`,
      )
    }
  }
})

test('package doc records are advisory, never blocking contract docs', () => {
  const records = packageDocRecords()
  assert.equal(records.length, GOVERNED_PACKAGE_DOCS.length)
  for (const r of records) {
    assert.equal(r.contract, false, `${r.doc} must not be a blocking contract doc`)
    assert.ok(r.covers.length > 0)
    assert.ok(r.lastVerified)
  }
})

test('the scope notes state what the boundary does NOT reach', () => {
  const notes = boundaryScopeNotes()
  assert.ok(notes.length >= 3)
  assert.ok(notes.some((n) => n.includes('.agents/**')))
  assert.ok(notes.some((n) => n.includes('contract: true')))
})

test('governed files really exist on disk (path typo control)', async () => {
  const { access } = await import('node:fs/promises')
  for (const entry of GOVERNED_PACKAGE_DOCS) {
    await access(join(REPO_ROOT, entry.doc))
  }
  for (const path of Object.keys(EXEMPT_PACKAGE_DOCS)) {
    await access(join(REPO_ROOT, path))
  }
})
