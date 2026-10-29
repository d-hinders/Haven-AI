// Tests for the CASP shard's shipped-delta drafter (#4541).
//
// The bar here is the one the issue sets: a FIXTURE `release:scope --json`
// payload pinned to SPECIFIC per-package and excluded values. A sum check alone
// is tautological — it would pass on a formatter that printed the right total
// from the wrong grouping — so every assertion below names the number it expects
// for a named package or a named exclusion reason.
//
// Run with: node --test scripts/ci/release-records.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs`)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { formatShippedDelta, exitCodeFor, Refusal, MINUS } from './release-records.mjs'

const SCRIPT = fileURLToPath(new URL('./release-records.mjs', import.meta.url))

// Inherited GIT_* variables (GIT_DIR, GIT_WORK_TREE, … — set when tests run from
// inside a git hook) would point the spawned release-scope at the HOST
// repository instead of the checkout this test lives in.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))

const shippedFile = (pkg, file) => ({ file, pkg, via: 'bundled (recorded in dist sourcemap)' })

// 8 shipped files: sdk 3, signer 2, cli 1, connect 1, mcp 1.
// 8 excluded: 5 outside a published package, 2 unreachable test files, 1 in a
// package but outside the tarball.
const FIXTURE = {
  range: { base: 'origin/main', baseSha: 'aaaa1111bbbb2222', head: 'origin/dev', headSha: 'cccc3333dddd4444' },
  commits: [
    { sha: '00000001', subject: 'feat(sdk): one (#1)' },
    { sha: '00000002', subject: 'fix(sdk): two (#2)' },
    { sha: '00000003', subject: 'fix(signer): three (#3)' },
    { sha: '00000004', subject: 'fix(signer): four (#4)' },
    { sha: '00000005', subject: 'feat(cli): five (#5)' },
    { sha: '00000006', subject: 'feat(connect): six (#6)' },
    { sha: '00000007', subject: 'feat(mcp): seven (#7)' },
  ],
  references: [1, 2, 3, 4, 5, 6, 7],
  packages: [
    { name: '@haven_ai/sdk', version: '0.12.0-alpha.0' },
    { name: '@haven_ai/signer', version: '0.12.0-alpha.0' },
    { name: '@haven_ai/mcp', version: '0.12.0-alpha.0' },
    { name: '@haven_ai/connect', version: '0.12.0-alpha.0' },
    { name: '@haven_ai/cli', version: '0.12.0-alpha.0' },
  ],
  affectedPackages: ['@haven_ai/cli', '@haven_ai/connect', '@haven_ai/mcp', '@haven_ai/sdk', '@haven_ai/signer'],
  shipped: {
    files: [
      shippedFile('@haven_ai/sdk', 'packages/sdk/src/a.ts'),
      shippedFile('@haven_ai/sdk', 'packages/sdk/src/b.ts'),
      shippedFile('@haven_ai/sdk', 'packages/sdk/src/c.ts'),
      shippedFile('@haven_ai/signer', 'packages/signer/src/d.ts'),
      shippedFile('@haven_ai/signer', 'packages/signer/src/e.ts'),
      shippedFile('@haven_ai/cli', 'packages/cli/src/f.ts'),
      shippedFile('@haven_ai/connect', 'packages/connect/src/g.ts'),
      shippedFile('@haven_ai/mcp', 'packages/mcp/src/h.ts'),
    ],
    count: 8,
    added: 120,
    removed: 34,
    binary: [],
    inferred: { count: 0, added: 0, removed: 0 },
  },
  excluded: [
    { file: 'docs/a.md', reason: 'not in a published package' },
    { file: 'docs/b.md', reason: 'not in a published package' },
    { file: 'docs/c.md', reason: 'not in a published package' },
    { file: 'docs/d.md', reason: 'not in a published package' },
    { file: 'docs/e.md', reason: 'not in a published package' },
    { file: 'packages/sdk/src/a.test.ts', reason: 'test file — not reachable from any bundle entry' },
    { file: 'packages/signer/src/d.test.ts', reason: 'test file — not reachable from any bundle entry' },
    { file: 'packages/cli/CHANGELOG.md', reason: 'in the package but outside the tarball' },
  ],
  unresolved: [],
}

const clone = (payload) => JSON.parse(JSON.stringify(payload))

test('the block is labelled with the range it measured, and with the run label when given', () => {
  const text = formatShippedDelta(FIXTURE, { label: 'door' })
  assert.match(text, /^Shipped delta — door \(range origin\/main \(aaaa1111\) \.\. origin\/dev \(cccc3333\)\)$/m)

  const unlabelled = formatShippedDelta(FIXTURE)
  assert.match(unlabelled, /^Shipped delta \(range origin\/main \(aaaa1111\) \.\. origin\/dev \(cccc3333\)\)$/m)
})

test('the headline carries the file count, the line counts and the commit count', () => {
  const text = formatShippedDelta(FIXTURE, { label: 'cut' })
  assert.ok(
    text.includes('8 files, +120/−34, over 7 commits from `origin/main` `aaaa1111`'),
    `headline missing or wrong:\n${text}`,
  )
})

test('the minus sign is U+2212, not ASCII hyphen', () => {
  const text = formatShippedDelta(FIXTURE)
  assert.ok(text.includes(MINUS), 'expected U+2212 in the delta figure')
  assert.equal(MINUS, '\u2212')
  assert.doesNotMatch(text, /\+120\/-34/, 'ASCII hyphen must not appear in the delta figure')
})

test('per package is pinned to specific counts, derived from shipped.files[].pkg', () => {
  const text = formatShippedDelta(FIXTURE)
  assert.ok(
    text.includes(
      '- Per package: `@haven_ai/sdk` **3**, `@haven_ai/signer` **2**, `@haven_ai/cli` **1**, ' +
        '`@haven_ai/connect` **1**, `@haven_ai/mcp` **1**, which sums to 8.',
    ),
    `per-package line missing or wrong:\n${text}`,
  )
})

test('per package is not a hard-coded list of the five published names', () => {
  const payload = clone(FIXTURE)
  payload.shipped.files.push(shippedFile('@haven_ai/ops', 'packages/ops/src/i.ts'))
  payload.shipped.count = 9
  const text = formatShippedDelta(payload)
  assert.ok(text.includes('`@haven_ai/ops` **1**'), `a package outside the five must appear:\n${text}`)
  assert.ok(text.includes('which sums to 9.'))
})

test('the excluded breakdown is pinned to specific counts per reason', () => {
  const text = formatShippedDelta(FIXTURE)
  assert.ok(
    text.includes(
      '- Excluded: 8 files (5 outside a published package, 2 unreachable test files, ' +
        '1 in a package but outside the tarball).',
    ),
    `excluded line missing or wrong:\n${text}`,
  )
})

test('an exclusion reason the formatter does not know is printed verbatim, not dropped', () => {
  const payload = clone(FIXTURE)
  payload.excluded.push({ file: 'packages/sdk/src/x.ts', reason: 'a fourth reason nobody mapped' })
  const text = formatShippedDelta(payload)
  assert.ok(text.includes('1 a fourth reason nobody mapped'), `unknown reason must survive:\n${text}`)
  assert.ok(text.includes('- Excluded: 9 files ('))
})

test('deleted sources and binary files are stated beside the headline, not folded into it silently', () => {
  const payload = clone(FIXTURE)
  payload.shipped.inferred = { count: 2, added: 40, removed: 12 }
  payload.shipped.binary = ['packages/sdk/dist/logo.png']
  const text = formatShippedDelta(payload)
  assert.ok(
    text.includes('  of which attributed, not measured: 2 deleted source file(s), +40/−12'),
    `inferred sub-line missing:\n${text}`,
  )
  assert.ok(text.includes('  1 binary file(s) counted as files but not as lines'), `binary sub-line missing:\n${text}`)
})

test('an empty shipped set says so instead of printing a bare zero', () => {
  const payload = clone(FIXTURE)
  payload.shipped.files = []
  payload.shipped.count = 0
  payload.shipped.added = 0
  payload.shipped.removed = 0
  payload.excluded = []
  const text = formatShippedDelta(payload)
  assert.ok(text.includes('0 files, +0/−0, over 7 commits'))
  assert.ok(text.includes('- Per package: (none — nothing in this range reaches a tarball)'))
  assert.ok(text.includes('- Excluded: 0 files'))
})

test('unresolved files exit 1 and carry the warning with the block', () => {
  const payload = clone(FIXTURE)
  payload.unresolved = [{ file: 'packages/sdk/src/barrel.ts', pkg: '@haven_ai/sdk', reason: 'emits no mapped output' }]
  const text = formatShippedDelta(payload)
  assert.ok(text.includes('UNRESOLVED: 1 source file(s) could not be classified'), `warning missing:\n${text}`)
  assert.ok(text.includes('  packages/sdk/src/barrel.ts'))
  assert.ok(text.includes('Do not quote it as complete.'))
  assert.equal(exitCodeFor(payload), 1)
  assert.equal(exitCodeFor(FIXTURE), 0)
})

test('a payload whose shape drifted is refused rather than formatted as zeros', () => {
  const payload = clone(FIXTURE)
  delete payload.shipped.files
  assert.throws(() => formatShippedDelta(payload), Refusal)
  assert.throws(() => exitCodeFor(payload), Refusal)

  const noRange = clone(FIXTURE)
  delete noRange.range.headSha
  assert.throws(() => formatShippedDelta(noRange), Refusal)
})

test('a release-scope refusal is relayed verbatim on stderr, with nothing on stdout', () => {
  // A ref that cannot resolve makes release-scope refuse (exit 2) before it
  // measures anything. In a shallow CI checkout it refuses on shallowness
  // instead — either way the message is release-scope's own, which is what this
  // asserts: the wrapper does not paraphrase or swallow it.
  const r = spawnSync(process.execPath, [SCRIPT, '--base=refs/heads/definitely-not-a-ref-4541'], {
    encoding: 'utf8',
    env: ENV,
  })
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /release-scope: REFUSING TO REPORT/)
  assert.equal(r.stdout, '', 'a refusal must not print a block')
  // Exactly once: execFileSync inherits the child's stderr by default, so a
  // wrapper that also relays err.stderr prints the refusal twice.
  assert.equal(r.stderr.match(/REFUSING TO REPORT/g).length, 1, `refusal printed more than once:\n${r.stderr}`)
})

test('--help prints usage and exits 0', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8', env: ENV })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /Usage: node scripts\/ci\/release-records\.mjs/)
})

test('an unknown argument is refused with exit 2', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8', env: ENV })
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /release-records: unknown argument: --nope/)
})
