// Tests for the review-isolation guard (#2455).
//
// The thing under test is a claim about an ENVIRONMENT — "the reviewer's git
// view matches its file view" — so almost none of it can be established by
// feeding the decision function tidy objects. These tests build real
// repositories in a temp directory, make review copies the wrong way and the
// right way, and run the guard against both.
//
// The first case is the one that matters: it reproduces the #2421 skew end to
// end (builder commits while a `cp -R` copy is open; the copy's files stay
// frozen while its `git diff` reports the builder's addition as a REMOVAL),
// asserts the skew is real, and only then asserts that the guard refuses it.
// A guard proven against a mock of the defect is not proven against the
// defect.
//
// Run with: node --test scripts/ci/review-isolation.test.mjs
// (also collected by ci.yml's `ci_config_checks` job via scripts/ci/*.test.mjs)

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, cpSync, appendFileSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { evaluate, collectFacts, contract, parseArgs, splitRef, DEFAULT_BASE } from './review-isolation.mjs'

const GUARD = fileURLToPath(new URL('./review-isolation.mjs', import.meta.url))

const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** Run the guard as the CLI does, returning exit code and stdout. */
function runGuard(args) {
  try {
    const stdout = execFileSync('node', [GUARD, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout }
  } catch (err) {
    return { code: err.status ?? 1, stdout: String(err.stdout ?? '') }
  }
}

const idOf = (result, id) => result.checks.find((c) => c.id === id)

let lab
let origin
let mainRepo
let builderWt

before(() => {
  lab = realpathSync(mkdtempSync(path.join(tmpdir(), 'review-isolation-')))
  origin = path.join(lab, 'origin.git')
  mainRepo = path.join(lab, 'main-repo')
  builderWt = path.join(lab, 'builder-wt')

  execFileSync('git', ['init', '-q', '--bare', origin])
  execFileSync('git', ['clone', '-q', origin, mainRepo])
  git(mainRepo, 'config', 'user.email', 'test@haven.invalid')
  git(mainRepo, 'config', 'user.name', 'Review Isolation Test')
  writeFileSync(path.join(mainRepo, 'f.txt'), 'line one\n')
  git(mainRepo, 'add', 'f.txt')
  git(mainRepo, 'commit', '-qm', 'init')
  git(mainRepo, 'branch', '-M', 'dev')
  git(mainRepo, 'push', '-q', 'origin', 'dev')
  git(mainRepo, 'worktree', 'add', '-q', '-b', 'feat/x', builderWt, 'dev')
})

after(() => {
  if (lab) rmSync(lab, { recursive: true, force: true })
})

describe('the defect itself is reproduced before the guard is asked about it', () => {
  test('a cp -R copy of a worktree reads the builder\'s live git while its files stay frozen', () => {
    const bad = path.join(lab, 'reviewer-cp')
    cpSync(builderWt, bad, { recursive: true })

    // Builder keeps working, exactly as the workflow allows it to.
    appendFileSync(path.join(builderWt, 'f.txt'), 'LIVE EDIT\n')
    git(builderWt, 'add', 'f.txt')
    git(builderWt, 'commit', '-qm', 'builder commit while a review is open')

    // File view: frozen. This is what the reviewer READS.
    const frozen = execFileSync('cat', [path.join(bad, 'f.txt')], { encoding: 'utf8' })
    assert.equal(frozen, 'line one\n', 'the copy\'s files should still be the snapshot')

    // Git view: live. HEAD moved with the builder although nobody touched the copy.
    assert.equal(git(bad, 'rev-parse', 'HEAD'), git(builderWt, 'rev-parse', 'HEAD'), 'the copy\'s HEAD tracks the builder')

    // And this is the false finding, verbatim: the builder ADDED a line, and
    // the copy's diff reports it as a REMOVAL.
    const diff = git(bad, 'diff')
    assert.match(diff, /^-LIVE EDIT$/m, 'the skew should report the builder\'s addition as a deletion')
    assert.doesNotMatch(diff, /^\+LIVE EDIT$/m)
  })
})

describe('the guard refuses a wrongly-made copy', () => {
  test('cp -R of a worktree is REFUSED, and the failing check is the registration one', () => {
    const bad = path.join(lab, 'reviewer-cp-2')
    cpSync(builderWt, bad, { recursive: true })

    const facts = collectFacts(bad, { builder: builderWt, baseCheck: false })
    const result = evaluate(facts)

    assert.equal(result.ok, false)
    assert.equal(idOf(result, 'registered-at-own-path').ok, false)
    // The subtle part: the checks a path-restriction rule would rely on all PASS.
    assert.equal(idOf(result, 'toplevel-is-root').ok, true, 'the copy does report its own path as the toplevel')
    assert.equal(idOf(result, 'distinct-from-builder').ok, true, 'and it is not the builder\'s path either')
    assert.match(idOf(result, 'registered-at-own-path').detail, /never `cp -R`/)
  })

  test('the CLI exits non-zero on it and says REFUSED', () => {
    const bad = path.join(lab, 'reviewer-cp-3')
    cpSync(builderWt, bad, { recursive: true })
    const { code, stdout } = runGuard([bad, '--builder', builderWt, '--no-base-check'])
    assert.equal(code, 1)
    assert.match(stdout, /review-isolation: REFUSED/)
    assert.match(stdout, /\[FAIL\] registered-at-own-path/)
  })

  test('the builder\'s own live worktree is REFUSED', () => {
    const facts = collectFacts(builderWt, { builder: builderWt, baseCheck: false })
    const result = evaluate(facts)
    assert.equal(result.ok, false)
    assert.equal(idOf(result, 'distinct-from-builder').ok, false)
    assert.equal(idOf(result, 'registered-at-own-path').ok, true, 'it IS a real worktree — only the wrong one')
  })

  test('a subdirectory handed off as the review root is REFUSED', () => {
    const sub = path.join(mainRepo, 'nested')
    mkdirSync(sub, { recursive: true })
    const facts = collectFacts(sub, { builder: builderWt, baseCheck: false })
    const result = evaluate(facts)
    assert.equal(result.ok, false)
    assert.equal(idOf(result, 'toplevel-is-root').ok, false)
  })

  test('a path that is not a repository at all is REFUSED', () => {
    const plain = mkdtempSync(path.join(lab, 'not-a-repo-'))
    const result = evaluate(collectFacts(plain, { builder: builderWt, baseCheck: false }))
    assert.equal(result.ok, false)
    assert.equal(idOf(result, 'is-repo').ok, false)
  })

  test('a missing path is REFUSED rather than throwing', () => {
    const result = evaluate(collectFacts(path.join(lab, 'nope'), { builder: builderWt, baseCheck: false }))
    assert.equal(result.ok, false)
    assert.equal(idOf(result, 'root-exists').ok, false)
  })
})

describe('the guard accepts a correctly-made copy', () => {
  test('git worktree add is ACCEPTED and its HEAD does not move under the builder', () => {
    const good = path.join(lab, 'reviewer-wt')
    const reviewedHead = git(builderWt, 'rev-parse', 'HEAD')
    git(mainRepo, 'worktree', 'add', '-q', '--detach', good, reviewedHead)

    const before = evaluate(collectFacts(good, { builder: builderWt, baseCheck: false }))
    assert.equal(before.ok, true, JSON.stringify(before.checks, null, 2))
    assert.equal(idOf(before, 'registered-at-own-path').ok, true)

    // Builder carries on. A sound copy is unmoved by that; the cp -R copy was not.
    appendFileSync(path.join(builderWt, 'f.txt'), 'MORE\n')
    git(builderWt, 'add', 'f.txt')
    git(builderWt, 'commit', '-qm', 'builder keeps going')

    assert.equal(git(good, 'rev-parse', 'HEAD'), reviewedHead)
    assert.equal(git(good, 'status', '--porcelain'), '')

    // And the head binding now proves that, rather than asserting it.
    const after = evaluate(collectFacts(good, { builder: builderWt, baseCheck: false, expectHead: reviewedHead }))
    assert.equal(after.ok, true)
    assert.equal(idOf(after, 'head-matches-expected').ok, true)
  })

  test('git clone is ACCEPTED', () => {
    const good = path.join(lab, 'reviewer-clone')
    execFileSync('git', ['clone', '-q', mainRepo, good])
    const result = evaluate(collectFacts(good, { builder: builderWt, baseCheck: false }))
    assert.equal(result.ok, true, JSON.stringify(result.checks, null, 2))
  })

  test('the CLI exits zero on a sound copy and prints the contract to quote', () => {
    const good = path.join(lab, 'reviewer-wt-cli')
    const head = git(builderWt, 'rev-parse', 'HEAD')
    git(mainRepo, 'worktree', 'add', '-q', '--detach', good, head)
    const { code, stdout } = runGuard([good, '--builder', builderWt, '--no-base-check', '--expect-head', head])
    assert.equal(code, 0, stdout)
    assert.match(stdout, /review-isolation: ACCEPTED/)
    assert.match(stdout, new RegExp(`head: ${head}`))
    assert.match(stdout, /diff: git -C \S+ diff [0-9a-f]{40}\.\.\.[0-9a-f]{40}/)
  })
})

describe('head binding', () => {
  test('a HEAD that moved off the reviewed commit is REFUSED', () => {
    const good = path.join(lab, 'reviewer-wt-head')
    git(mainRepo, 'worktree', 'add', '-q', '--detach', good, 'dev')
    const result = evaluate(
      collectFacts(good, { builder: builderWt, baseCheck: false, expectHead: '0'.repeat(40) }),
    )
    assert.equal(result.ok, false)
    assert.equal(idOf(result, 'head-matches-expected').ok, false)
  })

  test('without --expect-head the check is inconclusive, not a pass, and says so', () => {
    const good = path.join(lab, 'reviewer-wt-nohead')
    git(mainRepo, 'worktree', 'add', '-q', '--detach', good, 'dev')
    const result = evaluate(collectFacts(good, { builder: builderWt, baseCheck: false }))
    assert.equal(idOf(result, 'head-matches-expected').ok, null)
    assert.ok(result.caveats.some((c) => c.includes('--expect-head was not given')))
  })
})

describe('baseline freshness — the second half of #2421', () => {
  test('a copy carrying a stale origin/dev is REFUSED even though its git view is sound', () => {
    // A plain clone, then the world moves on without it. This is exactly the
    // `cp -R`-of-a-clone case: own HEAD, own index, own refs, wrong baseline.
    const stale = path.join(lab, 'reviewer-stale')
    execFileSync('git', ['clone', '-q', origin, stale])

    appendFileSync(path.join(mainRepo, 'f.txt'), 'dev moved on\n')
    git(mainRepo, 'add', 'f.txt')
    git(mainRepo, 'commit', '-qm', 'dev advances')
    git(mainRepo, 'push', '-q', 'origin', 'dev')

    const facts = collectFacts(stale, { builder: builderWt, base: 'origin/dev' })
    const result = evaluate(facts)

    assert.equal(idOf(result, 'registered-at-own-path').ok, true, 'a clone is structurally sound')
    assert.equal(idOf(result, 'base-is-fresh').ok, false, 'but its baseline lags the remote')
    assert.equal(result.ok, false)

    // Fetching is the fix, and the guard then accepts the same directory.
    git(stale, 'fetch', '-q', 'origin', 'dev')
    const refetched = evaluate(collectFacts(stale, { builder: builderWt, base: 'origin/dev' }))
    assert.equal(idOf(refetched, 'base-is-fresh').ok, true)
    assert.equal(refetched.ok, true, JSON.stringify(refetched.checks, null, 2))
  })

  test('an unreachable remote is REFUSED as inconclusive, never quietly accepted', () => {
    const orphan = path.join(lab, 'reviewer-orphan')
    execFileSync('git', ['clone', '-q', origin, orphan])
    git(orphan, 'remote', 'set-url', 'origin', path.join(lab, 'no-such-remote.git'))
    const facts = collectFacts(orphan, { builder: builderWt, base: 'origin/dev' })
    assert.equal(facts.baseCheck, 'unreachable')
    const result = evaluate(facts)
    assert.equal(idOf(result, 'base-is-fresh').ok, false)
    assert.equal(result.ok, false)
  })

  test('--no-base-check leaves a caveat rather than a silent pass', () => {
    const good = path.join(lab, 'reviewer-wt-nobase')
    git(mainRepo, 'worktree', 'add', '-q', '--detach', good, 'dev')
    const result = evaluate(collectFacts(good, { builder: builderWt, baseCheck: false }))
    assert.equal(idOf(result, 'base-is-fresh').ok, null)
    assert.ok(result.caveats.some((c) => c.includes('Base freshness was NOT checked')))
  })
})

describe('caveats and contract', () => {
  test('a worktree copy is told its refs are shared with the builder', () => {
    const good = path.join(lab, 'reviewer-wt-shared')
    git(mainRepo, 'worktree', 'add', '-q', '--detach', good, 'dev')
    const facts = collectFacts(good, { builder: builderWt, baseCheck: false })
    assert.equal(facts.refsSharedWithBuilder, true)
    assert.ok(evaluate(facts).caveats.some((c) => c.includes('shares its ref store')))
  })

  test('a clone is not, because it has its own', () => {
    const good = path.join(lab, 'reviewer-clone-shared')
    execFileSync('git', ['clone', '-q', mainRepo, good])
    const facts = collectFacts(good, { builder: builderWt, baseCheck: false })
    assert.equal(facts.refsSharedWithBuilder, false)
  })

  test('omitting the builder is a caveat, not a pass on the distinctness check', () => {
    const good = path.join(lab, 'reviewer-wt-nobuilder')
    git(mainRepo, 'worktree', 'add', '-q', '--detach', good, 'dev')
    const facts = collectFacts(good, { builder: null, baseCheck: false })
    const result = evaluate(facts)
    assert.ok(result.caveats.some((c) => c.includes('was NOT verified')))
  })

  test('the contract names a frozen SHA, never the ref name', () => {
    const good = path.join(lab, 'reviewer-wt-contract')
    git(mainRepo, 'worktree', 'add', '-q', '--detach', good, 'dev')
    const facts = collectFacts(good, { builder: builderWt, baseCheck: false })
    const ct = contract(facts)
    assert.match(ct.base, /^[0-9a-f]{40}$/)
    assert.doesNotMatch(ct.diffCommand, /origin\/dev/)
    assert.match(ct.diffCommand, /\.\.\./, 'three-dot, so an advancing base cannot invent a revert')
  })
})

describe('argument parsing', () => {
  test('defaults', () => {
    const o = parseArgs(['/some/path'])
    assert.equal(o.root, '/some/path')
    assert.equal(o.base, DEFAULT_BASE)
    assert.equal(o.baseCheck, true)
  })
  test('a missing root is an error, not a default', () => {
    assert.throws(() => parseArgs([]), /review root path is required/)
  })
  test('unknown options are rejected', () => {
    assert.throws(() => parseArgs(['/p', '--sandbox']), /unknown option/)
  })
  test('splitRef', () => {
    assert.deepEqual(splitRef('origin/dev'), ['origin', 'dev'])
    assert.deepEqual(splitRef('dev'), ['origin', 'dev'])
    assert.deepEqual(splitRef('upstream/release/1.x'), ['upstream', 'release/1.x'])
  })
})
