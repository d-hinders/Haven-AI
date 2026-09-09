// Self-test for the retired-rail prose ratchet (#2685).
// Run with: node --test scripts/retired-rail-prose-ratchet.test.mjs
//
// The case that matters most is that A VIOLATION ACTUALLY FAILS — the
// dependency-boundary lint's own history records that a gate which silently
// passes during development is worse than no gate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { newViolations } from './lib/ratchet.mjs'
import {
  scanSource,
  scanAll,
  BASELINE_PATH,
  JUSTIFICATIONS_PATH,
  PHRASES,
} from './retired-rail-prose-ratchet.mjs'

test('scanSource counts each phrase in the family', () => {
  const src = `
    // historical agent records remain readable
    // history stays readable under Removed
    // #1083 gave Send to BOTH rails
    // Legacy AllowanceModule is import-only
  `
  assert.deepEqual(scanSource(src), {
    'remain-readable': 1,
    'stays-readable': 1,
    'both-rails': 1,
    'import-only': 1,
  })
})

test('a file with no family phrases counts as empty', () => {
  assert.deepEqual(scanSource('const x = 1\n// nothing to see here'), {})
})

test('the hyphenated identifiers match literally', () => {
  assert.deepEqual(scanSource('the rail-conditional row'), { 'rail-conditional': 1 })
  assert.deepEqual(scanSource('import-only mode'), { 'import-only': 1 })
})

test('a violation ACTUALLY FAILS: growth in a baselined file is reported', () => {
  const baseline = { 'a.ts': { 'both-rails': 1 } }
  const grown = newViolations({ 'a.ts': { 'both-rails': 2 } }, baseline)
  assert.equal(grown.length, 1)
  assert.deepEqual(grown[0], { file: 'a.ts', key: 'both-rails', count: 2, allowed: 1 })
})

test('a NEW file with a family phrase is a violation even at count 1', () => {
  const grown = newViolations({ 'brand-new.ts': { 'remain-readable': 1 } }, {})
  assert.equal(grown.length, 1)
  assert.equal(grown[0].allowed, 0)
})

test('equal and shrunk counts pass', () => {
  const baseline = { 'a.ts': { 'both-rails': 2, 'import-only': 1 } }
  assert.deepEqual(newViolations({ 'a.ts': { 'both-rails': 2, 'import-only': 1 } }, baseline), [])
  assert.deepEqual(newViolations({ 'a.ts': { 'both-rails': 1 } }, baseline), [])
})

test('the committed baseline matches the tree (bootstrap parity, shrink-only from here)', async () => {
  const counts = await scanAll()
  const baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8'))
  const grown = newViolations(counts, baseline)
  assert.deepEqual(
    grown,
    [],
    'the tree grew past the committed retired-rail prose baseline — remove the stale phrase, or hand-add a justified entry to BOTH the baseline and the justifications manifest',
  )
})

// The lockstep guard: the baseline and the justifications manifest must name
// the EXACT same (file, phrase) pairs. A count without a justification is a
// bulk-dumped entry the issue forbids; a justification without a count is a
// phantom that grants nothing and rots.
test('baseline and justifications are in lockstep (every count justified, no phantoms)', async () => {
  const counts = await scanAll()
  const baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8'))
  const justifications = JSON.parse(await readFile(JUSTIFICATIONS_PATH, 'utf8'))

  const pairs = (obj) =>
    Object.entries(obj).flatMap(([file, keys]) => Object.keys(keys).map((k) => `${file}::${k}`))

  const baselinePairs = new Set(pairs(baseline))
  const justificationPairs = new Set(pairs(justifications))

  const unjustified = [...baselinePairs].filter((p) => !justificationPairs.has(p))
  assert.deepEqual(
    unjustified,
    [],
    'baseline entries with no justification — the issue requires each entry to be traceable to a legitimate category. Add it to packages/retired-rail-prose-justifications.json.',
  )

  const phantom = [...justificationPairs].filter((p) => !baselinePairs.has(p))
  assert.deepEqual(
    phantom,
    [],
    'justification entries with no matching baseline count — the file/phrase no longer contributes a hit (deleted, or the phrase removed). Drop the justification and run: node scripts/retired-rail-prose-ratchet.mjs --update',
  )
})

// Every justification must name a category from the legitimate set the issue
// enumerates — a free-text category is how the allowlist stops meaning
// anything.
const LEGITIMATE_CATEGORIES = new Set([
  'mpp_demo',
  'archived-agents',
  'route-db-readability',
  'owner-decision-quote',
  'past-tense-history',
  'live-rail-architecture',
  'test-instrument',
  'ui-affordance',
])

test('every justification names a legitimate category and a non-empty note', async () => {
  const justifications = JSON.parse(await readFile(JUSTIFICATIONS_PATH, 'utf8'))
  const bad = []
  for (const [file, keys] of Object.entries(justifications)) {
    for (const [phrase, entry] of Object.entries(keys)) {
      if (!LEGITIMATE_CATEGORIES.has(entry.category)) {
        bad.push(`${file}::${phrase} -> unknown category "${entry.category}"`)
      }
      if (!entry.note || entry.note.trim().length < 10) {
        bad.push(`${file}::${phrase} -> note too short to be a justification`)
      }
    }
  }
  assert.deepEqual(bad, [], 'justifications must each name a legitimate category and carry a real note')
})

// The phrase family itself must be non-empty and well-formed — a typo that
// empties a regex would silently stop that phrase from ever matching.
test('every phrase regex matches its own canonical example', () => {
  const examples = {
    'remain-readable': 'records remain readable',
    'stays-readable': 'history stays readable',
    'still-readable': 'still readable',
    'readable-here': 'readable here',
    'readable-but': 'readable but',
    'both-rails': 'both rails',
    'either-rail': 'either rail',
    'rail-conditional': 'rail-conditional',
    'import-only': 'import-only',
    'read-only-record': 'read-only record',
  }
  for (const [id, re] of Object.entries(PHRASES)) {
    re.lastIndex = 0
    assert.ok(re.test(examples[id]), `phrase "${id}" does not match its own example`)
  }
})

// --- The CLI path (#2721, epic #2720)

import { runGuard } from './test-support/guard-cli.mjs'

const SRC = 'packages/backend/src/z.ts'
const BASE = 'packages/retired-rail-prose-baseline.json'
const JUST = 'packages/retired-rail-prose-justifications.json'

test('CLI: prose growth past the baseline exits non-zero and names the file', () => {
  const { status, out } = runGuard('retired-rail-prose-ratchet.mjs', {
    also: ['lib/ratchet.mjs'],
    files: {
      [SRC]: '// the row stays readable\n// and this one stays readable too\n',
      [BASE]: JSON.stringify({ [SRC]: { 'stays-readable': 1 } }),
      [JUST]: '{}',
    },
  })
  assert.equal(status, 1)
  assert.match(out, /retired-rail prose grew/)
  assert.match(out, /z\.ts/)
})

test('CLI: a tree at the baseline exits 0', () => {
  const { status } = runGuard('retired-rail-prose-ratchet.mjs', {
    also: ['lib/ratchet.mjs'],
    files: {
      [SRC]: '// the row stays readable\n',
      [BASE]: JSON.stringify({ [SRC]: { 'stays-readable': 1 } }),
      [JUST]: JSON.stringify({ [SRC]: { 'stays-readable': { category: 'x', note: 'y' } } }),
    },
  })
  assert.equal(status, 0)
})

test('CLI: `--update` REFUSES to raise a baselined file\'s count', () => {
  const { status, out } = runGuard('retired-rail-prose-ratchet.mjs', {
    also: ['lib/ratchet.mjs'],
    args: ['--update'],
    files: {
      [SRC]: '// stays readable\n// stays readable\n',
      [BASE]: JSON.stringify({ [SRC]: { 'stays-readable': 1 } }),
      [JUST]: '{}',
    },
  })
  assert.equal(status, 1)
  assert.match(out, /--update refuses to RAISE the baseline/)
})

test('CLI: an existing but EMPTY baseline REFUSES growth -- it is not a first run', () => {
  // #2728, pinned here for the same reason as in db-mock-ratchet: review
  // measured that reverting the shared allowance key left this suite entirely
  // green, so the tightening this gate received was unobserved. `{}` is what
  // `writeBaseline` writes at zero debt, so keying on emptiness disables the
  // refusal permanently after the first successful cleanup.
  const { status, out, wrote } = runGuard('retired-rail-prose-ratchet.mjs', {
    also: ['lib/ratchet.mjs'],
    args: ['--update'],
    files: {
      [SRC]: '// stays readable\n// stays readable\n',
      [BASE]: '{}',
      [JUST]: '{}',
    },
    readBack: [BASE],
  })
  assert.equal(status, 1)
  assert.match(out, /--update refuses to RAISE the baseline/)
  assert.equal(wrote[BASE], '{}')
})

test('CLI: a MISSING baseline file still writes -- the real first-run allowance', () => {
  const { status, wrote } = runGuard('retired-rail-prose-ratchet.mjs', {
    also: ['lib/ratchet.mjs'],
    args: ['--update'],
    files: { [SRC]: '// stays readable\n// stays readable\n', [JUST]: '{}' },
    readBack: [BASE],
  })
  assert.equal(status, 0)
  assert.match(wrote[BASE], /stays-readable/)
})

test('CLI: a malformed baseline prints one line, not a node:internal banner', () => {
  // #2761, same shape as db-mock's — this gate's entrypoint was byte-identical
  // to it before the conversion, and the acceptance criteria ask for a case per
  // gate rather than one case and an argument by similarity.
  const { status, out } = runGuard('retired-rail-prose-ratchet.mjs', {
    also: ['lib/ratchet.mjs'],
    files: {
      [SRC]: '// stays readable\n',
      [BASE]: JSON.stringify({ [SRC]: { 'stays-readable': 'x' } }),
      [JUST]: '{}',
    },
  })
  assert.equal(status, 1)
  assert.match(out, /✗ retired-rail-prose-ratchet: /)
  assert.doesNotMatch(out, /node:internal/)
})
