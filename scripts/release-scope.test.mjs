// Self-test for scripts/release-scope.mjs (#2724).
//
// ## What these tests are actually defending
//
// The 0.1.36-alpha.0 release record was hand-counted wrongly three times, in two
// opposite directions, and this file pins each specific error:
//
//   1. `packages/cli/README.md` was OMITTED though it ships (under-count).
//   2. 219 lines of test files were COUNTED though they never ship (over-count).
//   3. `connect`/`mcp`/`signer` package.json were omitted while `cli`/`sdk` were
//      included — an inconsistency no rule produced, only a human counting.
//
// A test that only checked "the script runs" would have passed against every one
// of those. So each error gets a test that fails if the behaviour regresses.
//
// ## Why the script is driven as a PROCESS
//
// Per epic #2720: testing the exported predicate proves the predicate, not the
// guard. Every refusal in release-scope.mjs lives on the path from `main()` and is
// only reachable by running the file. These tests run it with `spawnSync` against a
// throwaway git repo, and the two most important cases below additionally MUTATE
// the refusal out and assert the test goes red — a test that cannot fail is not
// evidence.
//
// The script derives its repo root from its own location, so copying it into the
// fixture repoints it at the fixture and the real repository is never read.

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const SCRIPTS_DIR = fileURLToPath(new URL('.', import.meta.url))
const SCRIPT = 'release-scope.mjs'

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

function write(root, rel, body) {
  const dest = join(root, rel)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, body)
}

const pkg = (name, extra = {}) =>
  JSON.stringify(
    { name, version: '1.0.0', files: ['dist', 'README.md'], main: './dist/index.cjs', ...extra },
    null,
    2,
  )

// A sourcemap is the build's record of which sources entered a bundle. `sources`
// is relative to dist/, exactly as tsup emits it.
const sourcemap = (sources) => JSON.stringify({ version: 3, sources, mappings: '' })

/**
 * Build a throwaway git repo with a published package, commit a base, apply
 * `changes`, commit a head, then run release-scope.mjs across that range.
 *
 * `mutate` optionally rewrites the script's source before it is copied in — this
 * is how a refusal is removed to prove the assertion against it can go red.
 */
function runScope({ base = {}, changes = {}, remove = [], args = [], mutate = null } = {}) {
  // realpathSync: on macOS mktemp is reached through a symlink, so a script that
  // self-guards on `import.meta.url === file://${argv[1]}` would never run main()
  // and would exit 0 having done nothing — a false pass shaped like a clean run
  // (#2721 measured exactly this).
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'release-scope-')))
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true })
    let source = readFileSync(join(SCRIPTS_DIR, SCRIPT), 'utf8')
    if (mutate) {
      const mutated = mutate(source)
      assert.notEqual(mutated, source, 'mutation changed nothing — the test would prove nothing')
      source = mutated
    }
    writeFileSync(join(root, 'scripts', SCRIPT), source)

    git(root, ['init', '-q'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'test'])

    const baseFiles = {
      'packages/alpha/package.json': pkg('@fix/alpha'),
      'packages/alpha/README.md': 'alpha readme\n',
      'packages/alpha/src/index.ts': 'export const a = 1\n',
      'packages/alpha/src/helper.ts': 'export const h = 1\n',
      'packages/alpha/src/index.test.ts': 'test stub\n',
      'packages/alpha/dist/index.js': 'bundle\n',
      'packages/alpha/dist/index.js.map': sourcemap(['../src/index.ts', '../src/helper.ts']),
      ...base,
    }
    for (const [rel, body] of Object.entries(baseFiles)) write(root, rel, body)
    git(root, ['add', '-A'])
    git(root, ['commit', '-qm', 'base'])
    const baseSha = git(root, ['rev-parse', 'HEAD'])

    for (const [rel, body] of Object.entries(changes)) write(root, rel, body)
    for (const rel of remove) rmSync(join(root, rel))
    git(root, ['add', '-A'])
    // --allow-empty: the argument-handling tests below make no file change, and a
    // git that refuses an empty commit would fail them for a reason unrelated to
    // what they assert.
    git(root, ['commit', '-q', '--allow-empty', '-m', 'head (#4242)'])
    const headSha = git(root, ['rev-parse', 'HEAD'])

    const r = spawnSync(
      process.execPath,
      [join(root, 'scripts', SCRIPT), `--base=${baseSha}`, `--head=${headSha}`, ...args],
      { cwd: root, encoding: 'utf8' },
    )
    return { status: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, root }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const shippedFiles = (stdout) => JSON.parse(stdout).shipped.files.map((f) => f.file)

// --- error 1: the omission that lost packages/cli/README.md ------------------

test('a README change is counted as shipped', () => {
  const { status, stdout } = runScope({
    changes: { 'packages/alpha/README.md': 'alpha readme, edited\n' },
    args: ['--json'],
  })
  assert.equal(status, 0)
  assert.deepEqual(shippedFiles(stdout), ['packages/alpha/README.md'])
})

test('a README change is attributed to the files field, not guessed', () => {
  const { stdout } = runScope({
    changes: { 'packages/alpha/README.md': 'edited\n' },
    args: ['--json'],
  })
  const entry = JSON.parse(stdout).shipped.files[0]
  assert.match(entry.via, /tarball member/)
})

test('a file the files field does not name is excluded even at the package root', () => {
  const { stdout } = runScope({
    changes: { 'packages/alpha/tsconfig.json': '{}\n' },
    args: ['--json'],
  })
  assert.deepEqual(shippedFiles(stdout), [])
})

// --- error 0: the baseline itself, which is the error that RECURRED ----------
//
// haven-doc-reviewer's figure table found this one unpinned while the commit
// message claimed all the hand-count errors were covered: nothing asserted the
// default range. Taking the baseline from the bump commit instead of from
// main..dev is the mistake that happened twice on 0.1.36-alpha.0, so it is the
// last one that should rest on a default nobody checks.

test('the default range is origin/main..origin/dev, not anything bump-relative', () => {
  const source = readFileSync(join(SCRIPTS_DIR, SCRIPT), 'utf8')
  assert.match(source, /const DEFAULT_BASE = 'origin\/main'/)
  assert.match(source, /const DEFAULT_HEAD = 'origin\/dev'/)
})

test('--help states the promotion-time baseline the defaults encode', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'release-scope-help-')))
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true })
    cpSync(join(SCRIPTS_DIR, SCRIPT), join(root, 'scripts', SCRIPT))
    const r = spawnSync(process.execPath, [join(root, 'scripts', SCRIPT), '--help'], { encoding: 'utf8' })
    assert.equal(r.status, 0)
    assert.match(r.stdout, /--base=origin\/main --head=origin\/dev/)
    // The reason for the default, not just the default: a reader who sees only
    // the refs can still reach for the bump commit.
    assert.match(r.stdout, /promotion time/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- error 2: the 219 counted lines that never ship --------------------------

test('a test file under src is excluded from the shipped delta', () => {
  const { status, stdout } = runScope({
    changes: { 'packages/alpha/src/index.test.ts': 'test stub, edited\n' },
    args: ['--json'],
  })
  assert.equal(status, 0, 'a test-only change is fully classified, not unresolved')
  const report = JSON.parse(stdout)
  assert.deepEqual(report.shipped.files, [])
  assert.equal(report.shipped.added, 0)
  assert.equal(
    report.excluded.find((e) => e.file === 'packages/alpha/src/index.test.ts')?.reason,
    'test file — not reachable from any bundle entry',
  )
})

test('test-file lines never reach the line counts', () => {
  const { stdout } = runScope({
    changes: {
      'packages/alpha/src/index.ts': 'export const a = 2\n',
      'packages/alpha/src/index.test.ts': `${'padding\n'.repeat(200)}`,
    },
    args: ['--json'],
  })
  const report = JSON.parse(stdout)
  // The source edit is +1/-1. If the 200 padding lines leaked in, this is +201.
  assert.equal(report.shipped.added, 1)
  assert.equal(report.shipped.removed, 1)
})

// --- error 3: package.json counted for some packages but not others ----------

test('package.json ships for every published package, not a subset', () => {
  const { stdout } = runScope({
    base: {
      'packages/beta/package.json': pkg('@fix/beta'),
      'packages/beta/dist/index.js.map': sourcemap(['../src/index.ts']),
      'packages/beta/src/index.ts': 'export const b = 1\n',
    },
    changes: {
      'packages/alpha/package.json': pkg('@fix/alpha', { version: '1.0.1' }),
      'packages/beta/package.json': pkg('@fix/beta', { version: '1.0.1' }),
    },
    args: ['--json'],
  })
  assert.deepEqual(shippedFiles(stdout).sort(), ['packages/alpha/package.json', 'packages/beta/package.json'])
})

test('a private package is not part of the published set', () => {
  const { stdout } = runScope({
    base: { 'packages/inner/package.json': pkg('@fix/inner', { private: true }) },
    changes: { 'packages/inner/package.json': pkg('@fix/inner', { private: true, version: '1.0.1' }) },
    args: ['--json'],
  })
  const report = JSON.parse(stdout)
  assert.deepEqual(shippedFiles(stdout), [])
  assert.ok(!report.packages.some((p) => p.name === '@fix/inner'))
})

// --- reachability is read from the build, not assumed ------------------------

test('a bundled source file ships; an unbundled one is unresolved, not silently dropped', () => {
  const { status, stdout } = runScope({
    base: { 'packages/alpha/src/orphan.ts': 'export const o = 1\n' },
    changes: {
      'packages/alpha/src/helper.ts': 'export const h = 2\n',
      'packages/alpha/src/orphan.ts': 'export const o = 2\n',
    },
    args: ['--json'],
  })
  const report = JSON.parse(stdout)
  assert.deepEqual(shippedFiles(stdout), ['packages/alpha/src/helper.ts'])
  assert.deepEqual(
    report.unresolved.map((u) => u.file),
    ['packages/alpha/src/orphan.ts'],
  )
  assert.equal(status, 1, 'an unresolved file must not exit 0 — a green run would be quoted as a clean measure')
})

// --- the entry point, which its own sourcemap does not always list -----------
//
// `sources` lists files that contributed MAPPED OUTPUT, so a pure re-export
// barrel entry emits nothing and is absent from its own map. Measured on this
// repo: sdk, signer, mcp and cli all omit src/index.ts; connect includes it,
// because that one has code of its own. Reading `sources` alone would classify a
// change to a package's public export surface as unshipped.

test('the bundle entry ships even when absent from its own sourcemap', () => {
  const { status, stdout } = runScope({
    base: {
      // A barrel that contributes no mapped output — sources names only helper.
      'packages/alpha/dist/index.js.map': sourcemap(['../src/helper.ts']),
    },
    changes: { 'packages/alpha/src/index.ts': "export * from './helper'\n" },
    args: ['--json'],
  })
  assert.equal(status, 0, 'the entry must classify cleanly, not land in unresolved')
  assert.deepEqual(shippedFiles(stdout), ['packages/alpha/src/index.ts'])
})

test('MUTATION: dropping the entry-point recovery sends the entry to unresolved', () => {
  const { status, stdout } = runScope({
    base: { 'packages/alpha/dist/index.js.map': sourcemap(['../src/helper.ts']) },
    changes: { 'packages/alpha/src/index.ts': "export * from './helper'\n" },
    mutate: (src) => src.replace('if (existsSync(join(REPO_ROOT, entry))) sources.add(entry)', ''),
    args: ['--json'],
  })
  assert.equal(status, 1, 'without the recovery the entry is unclassifiable')
  assert.deepEqual(shippedFiles(stdout), [], 'and it would NOT have been counted as shipped')
})

test('the entry recovery does not invent a source for a bundle with no matching src file', () => {
  const { stdout } = runScope({
    base: { 'packages/alpha/dist/extra.js.map': sourcemap(['../src/helper.ts']) },
    changes: { 'packages/alpha/src/helper.ts': 'export const h = 2\n' },
    args: ['--json'],
  })
  // src/extra.ts does not exist, so nothing is fabricated for dist/extra.js.
  assert.deepEqual(shippedFiles(stdout), ['packages/alpha/src/helper.ts'])
})

// --- refusals: the instrument must be able to say no -------------------------

test('refuses a package with no dist rather than reporting an empty shipped set', () => {
  const { status, out } = runScope({
    base: { 'packages/gamma/package.json': pkg('@fix/gamma') },
    changes: { 'packages/gamma/package.json': pkg('@fix/gamma', { version: '1.0.1' }) },
  })
  assert.equal(status, 2)
  assert.match(out, /REFUSING TO REPORT/)
  assert.match(out, /@fix\/gamma: packages\/gamma\/dist does not exist/)
})

test('refuses a dist with no sourcemaps', () => {
  const { status, out } = runScope({
    base: { 'packages/gamma/package.json': pkg('@fix/gamma'), 'packages/gamma/dist/index.js': 'bundle\n' },
    changes: { 'packages/gamma/package.json': pkg('@fix/gamma', { version: '1.0.1' }) },
  })
  assert.equal(status, 2)
  assert.match(out, /holds no \.map files/)
})

// --- mutation proof ----------------------------------------------------------
//
// Each assertion above is only evidence if it CAN fail. These two remove the
// mechanism under test and assert the earlier expectation no longer holds. Without
// them, a refusal could be deleted from the script and this suite would stay green
// — which is the exact defect epic #2720 exists to close.

test('MUTATION: replacing the missing-dist refusal with an empty set makes that test fail', () => {
  const { status, out, stdout } = runScope({
    base: { 'packages/gamma/package.json': pkg('@fix/gamma') },
    changes: { 'packages/gamma/package.json': pkg('@fix/gamma', { version: '1.0.1' }) },
    // Replace the refusal with the plausible WRONG behaviour — an empty set —
    // rather than deleting it. `if (false)` alone made the next readdirSync throw
    // ENOENT, so the assertion passed on an incidental crash and would have passed
    // on any unrelated breakage too (review finding 6).
    mutate: (src) =>
      src.replace('if (!existsSync(distDir)) {', 'if (!existsSync(distDir)) {\n    return new Set()\n  }\n  if (false) {'),
    args: ['--json'],
  })
  assert.equal(status, 0, 'the mutated script reports cleanly instead of refusing — which is the defect')
  assert.deepEqual(
    JSON.parse(stdout).shipped.files.map((f) => f.file),
    ['packages/gamma/package.json'],
    'and it reports a scope measured against a package it never built',
  )
  assert.doesNotMatch(out, /REFUSING TO REPORT/)
})

test('MUTATION: counting test files makes the exclusion test fail', () => {
  const { stdout } = runScope({
    changes: {
      'packages/alpha/src/index.ts': 'export const a = 2\n',
      'packages/alpha/src/index.test.ts': `${'padding\n'.repeat(200)}`,
    },
    // Swap sourcemap-measured reachability for the naive "everything under src
    // ships" rule this script exists to avoid. That rule is what counted 219 test
    // lines into the 0.1.36-alpha.0 record.
    //
    // An earlier version of this mutation flipped `if (isSource && !isTest)` to
    // `if (false)`, which only moved test files between two NON-shipping buckets
    // and left the count at 1 — a mutation that changes the source without
    // changing the behaviour under test proves nothing. It is replaced rather
    // than kept, because a vacuous mutation reads exactly like a real one.
    mutate: (src) => src.replace('if (bundled.has(file)) {', "if (file.includes('/src/')) {"),
    args: ['--json'],
  })
  const report = JSON.parse(stdout)
  assert.equal(report.shipped.added, 201, 'the naive rule should sweep the 200 padding lines in')
  assert.notEqual(report.shipped.added, 1, 'sourcemap reachability is what keeps test lines out of the count')
})

// --- range and argument handling ---------------------------------------------

test('reports the commits and the numbers they reference', () => {
  const { stdout } = runScope({
    changes: { 'packages/alpha/README.md': 'edited\n' },
    args: ['--json'],
  })
  const report = JSON.parse(stdout)
  assert.equal(report.commits.length, 1)
  // `references`, not `issues`: a squash subject carries its own PR number, and a
  // shard headed "issues" that lists PR numbers is a wrong regulatory record.
  assert.deepEqual(report.references, [4242])
  assert.equal(report.issues, undefined, 'the misleading field name must not come back')
})

test('names the affected packages', () => {
  const { stdout } = runScope({
    changes: { 'packages/alpha/src/helper.ts': 'export const h = 2\n' },
    args: ['--json'],
  })
  assert.deepEqual(JSON.parse(stdout).affectedPackages, ['@fix/alpha'])
})

test('refuses an unresolvable ref', () => {
  const { status, out } = runScope({ args: ['--base=no/such/ref'] })
  assert.equal(status, 2)
  assert.match(out, /cannot resolve ref/)
})

test('refuses an unknown argument rather than ignoring it', () => {
  const { status, out } = runScope({ args: ['--pacakges'] })
  assert.equal(status, 2)
  assert.match(out, /unknown argument/)
})

test('the human-readable report states its exclusions rather than hiding them', () => {
  const { stdout } = runScope({
    changes: {
      'packages/alpha/README.md': 'edited\n',
      'packages/alpha/src/index.test.ts': 'edited\n',
    },
  })
  assert.match(stdout, /Excluded from the shipped delta: 1 files/)
  assert.match(stdout, /test file — not reachable from any bundle entry/)
})

// --- review findings 2, 4 and 7 ----------------------------------------------

test('a deleted source file is counted as shipped, not left unresolved', () => {
  // It cannot be in head's sourcemaps — it does not exist at head — so absence
  // carries no information. Its removal is a real change to the tarball.
  const { status, stdout } = runScope({
    base: {
      'packages/alpha/src/doomed.ts': 'export const d = 1\n',
      'packages/alpha/dist/index.js.map': sourcemap(['../src/index.ts', '../src/helper.ts', '../src/doomed.ts']),
    },
    changes: { 'packages/alpha/dist/index.js.map': sourcemap(['../src/index.ts', '../src/helper.ts']) },
    remove: ['packages/alpha/src/doomed.ts'],
    args: ['--json'],
  })
  assert.equal(status, 0, 'a deletion must classify cleanly')
  const report = JSON.parse(stdout)
  assert.ok(
    report.shipped.files.some((f) => f.file === 'packages/alpha/src/doomed.ts'),
    'the removed module must appear in the shipped delta',
  )
  assert.deepEqual(report.unresolved, [])
})

test('a deleted TEST file is still excluded, not counted as shipped', () => {
  const { stdout } = runScope({
    remove: ['packages/alpha/src/index.test.ts'],
    args: ['--json'],
  })
  assert.deepEqual(JSON.parse(stdout).shipped.files, [])
})

test('refuses a glob in the files field rather than matching nothing silently', () => {
  const { status, out } = runScope({
    base: { 'packages/alpha/package.json': JSON.stringify({ name: '@fix/alpha', version: '1.0.0', files: ['dist/*.js', 'README.md'] }) },
    changes: { 'packages/alpha/README.md': 'edited\n' },
  })
  assert.equal(status, 2)
  assert.match(out, /is a glob/)
})

test('LICENSE ships even though the files field never names it', () => {
  const { stdout } = runScope({
    base: { 'packages/alpha/LICENSE': 'MIT\n' },
    changes: { 'packages/alpha/LICENSE': 'Apache-2.0\n' },
    args: ['--json'],
  })
  assert.deepEqual(shippedFiles(stdout), ['packages/alpha/LICENSE'])
})

test('refuses a partial dist missing a bundle its package.json resolves to', () => {
  const { status, out } = runScope({
    base: {
      // bin resolves to dist/cli.js, but only index.js.map exists.
      'packages/alpha/package.json': pkg('@fix/alpha', { bin: { alpha: './dist/cli.js' } }),
      'packages/alpha/src/cli.ts': 'export const c = 1\n',
    },
    changes: { 'packages/alpha/README.md': 'edited\n' },
  })
  assert.equal(status, 2)
  assert.match(out, /none for cli\.js/)
})

test('does NOT refuse over a src/cli.ts that is not a declared entry', () => {
  // Review finding B: deriving required bundles from the filename convention
  // /^(index|cli)\.ts$/ made an ordinary internal module named src/cli.ts a hard
  // exit 2 that no rebuild could clear — @haven_ai/sdk's only entry is
  // src/index.ts, so tsup will never emit dist/cli.js for it.
  const { status, stdout } = runScope({
    base: { 'packages/alpha/src/cli.ts': 'export const internal = 1\n' },
    changes: { 'packages/alpha/README.md': 'edited\n' },
    args: ['--json'],
  })
  assert.equal(status, 0, 'a non-entry module named cli.ts must not stop the measurement')
  assert.deepEqual(shippedFiles(stdout), ['packages/alpha/README.md'])
})

test('a renamed shipping file keeps its real line counts', () => {
  // Review finding A: a pathspec is applied BEFORE rename detection, so the old
  // path is filtered out and the rename reads as a pure add — measured at +107/-0
  // for a real +3/-5 rename. lineStats parses the whole range and filters after.
  const body = `${'line\n'.repeat(40)}`
  const { stdout } = runScope({
    base: { 'packages/alpha/src/old-name.ts': body, 'packages/alpha/dist/index.js.map': sourcemap(['../src/index.ts', '../src/new-name.ts']) },
    changes: { 'packages/alpha/src/new-name.ts': body },
    remove: ['packages/alpha/src/old-name.ts'],
    args: ['--json'],
  })
  const report = JSON.parse(stdout)
  assert.ok(report.shipped.added < 40, `a detected rename must not count all 40 lines as added (got +${report.shipped.added})`)
})

test('deleted-source lines are reported as attributed, not merged into the headline silently', () => {
  const { stdout } = runScope({
    base: {
      'packages/alpha/src/doomed.ts': `${'x\n'.repeat(30)}`,
      'packages/alpha/dist/index.js.map': sourcemap(['../src/index.ts', '../src/doomed.ts']),
    },
    changes: { 'packages/alpha/dist/index.js.map': sourcemap(['../src/index.ts']) },
    remove: ['packages/alpha/src/doomed.ts'],
    args: ['--json'],
  })
  const report = JSON.parse(stdout)
  assert.equal(report.shipped.inferred.count, 1)
  assert.equal(report.shipped.inferred.removed, 30)
})

test('a test-support module gets the same answer whether modified or deleted', () => {
  // Review finding D: test-helpers.ts is not `.test.ts`, so it used to be
  // unresolved when modified and SHIPPED when deleted — same file, opposite
  // answers, decided only by change status.
  const modified = runScope({
    base: { 'packages/alpha/src/test-helpers.ts': 'export const t = 1\n' },
    changes: { 'packages/alpha/src/test-helpers.ts': 'export const t = 2\n' },
    args: ['--json'],
  })
  const deleted = runScope({
    base: { 'packages/alpha/src/test-helpers.ts': 'export const t = 1\n' },
    remove: ['packages/alpha/src/test-helpers.ts'],
    args: ['--json'],
  })
  assert.deepEqual(shippedFiles(modified.stdout), [], 'modified: not shipped')
  assert.deepEqual(shippedFiles(deleted.stdout), [], 'deleted: also not shipped')
  assert.equal(JSON.parse(modified.stdout).unresolved.length, 0, 'and not unresolved either')
  assert.equal(modified.status, 0)
  assert.equal(deleted.status, 0)
})
