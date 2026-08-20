// Tests for the CI change classifier (#1622, epic #1621).
//
// The routing program these cover decides which jobs run, which means it
// decides which GUARDS run. While it lived inline in ci.yml the only way to
// exercise a rule was to push a commit and read the job graph, and the two
// failures the epic cites (#1206, #1030) are both "a guard silently covered
// nothing". So the bar here is: every rule arm is reachable from a test, and
// the workflow's side of the contract is pinned rather than assumed.
//
// Run with: node --test scripts/ci/change-classifier.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs`)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  OUTPUT_NAMES,
  ZERO_SHA,
  SURFACE_RULES,
  PROPAGATION_RULES,
  DOC_ONLY_PATTERNS,
  classifyChangedFiles,
  PACKAGE_JOBS,
  dependentsOf,
  allSurfaces,
  changedFilesCommand,
  formatGithubOutput,
  globToRegExp,
} from './change-classifier.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const SCRIPT = path.join(HERE, 'change-classifier.mjs')
const workflow = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')

/** The surfaces that came out true, as a sorted array — readable assertions. */
const on = (files) =>
  Object.entries(classifyChangedFiles(files))
    .filter(([, v]) => v)
    .map(([k]) => k)
    .sort()

describe('the contract with ci.yml', () => {
  test('the workflow publishes exactly the ten outputs this script emits', () => {
    // Targeted reader rather than a YAML dependency: the `outputs:` block of
    // the `changes` job is a fixed shape, so if the shape changes this reads
    // nothing and the assertion fails loudly instead of passing vacuously.
    const start = workflow.indexOf('    outputs:\n')
    assert.notEqual(start, -1, 'ci.yml has no `outputs:` block on the changes job')
    const block = workflow.slice(start).split('\n').slice(1)
    const names = []
    for (const line of block) {
      const m = line.match(/^\s{6}([a-z_]+):\s*\$\{\{\s*steps\.filter\.outputs\.([a-z_]+)\s*\}\}\s*$/)
      if (!m) break
      assert.equal(m[1], m[2], `output ${m[1]} is wired to steps.filter.outputs.${m[2]}`)
      names.push(m[1])
    }
    assert.deepEqual(
      names,
      [...OUTPUT_NAMES],
      'ci.yml and OUTPUT_NAMES disagree. Downstream jobs read needs.changes.outputs.<name>, ' +
        'so a name that exists on only one side silently disables whatever reads it.',
    )
  })

  test('the workflow actually invokes this script', () => {
    // Extraction is only real if ci.yml calls the extracted program. Without
    // this, the script could be deleted or orphaned and every test above would
    // still pass while CI routed on something else entirely.
    assert.match(
      workflow,
      /node scripts\/ci\/change-classifier\.mjs/,
      'ci.yml no longer runs scripts/ci/change-classifier.mjs',
    )
  })

  test('the classify step passes the event name and both SHAs', () => {
    for (const key of ['EVENT_NAME:', 'BASE_SHA:', 'HEAD_SHA:']) {
      assert.ok(workflow.includes(key), `ci.yml no longer sets ${key} for the classifier`)
    }
  })
})

describe('workflow_dispatch forces everything', () => {
  test('allSurfaces sets all ten true', () => {
    const outputs = allSurfaces()
    assert.equal(Object.keys(outputs).length, OUTPUT_NAMES.length)
    for (const name of OUTPUT_NAMES) assert.equal(outputs[name], true, `${name} must be true`)
  })

  test('the CLI honours EVENT_NAME=workflow_dispatch without consulting git', () => {
    // No BASE_SHA, no HEAD_SHA, no --files-from: a dispatch must not depend on
    // any of them, which is what the old shell's early `exit 0` guaranteed.
    const { output } = runCli([], { EVENT_NAME: 'workflow_dispatch' })
    assert.equal(output, OUTPUT_NAMES.map((n) => `${n}=true`).join('\n') + '\n')
  })
})

describe('base-SHA handling', () => {
  test('both invocations are NUL-delimited', () => {
    // The whole of #1638. Drop -z from either arm and every path containing a
    // non-ASCII or control character comes back quoted and escaped, matches no
    // rule, and routes nowhere — silently, in the unsafe direction.
    for (const args of [
      changedFilesCommand({ baseSha: 'aaa', headSha: 'bbb' }),
      changedFilesCommand({ baseSha: undefined, headSha: 'bbb' }),
    ]) {
      assert.ok(args.includes('-z'), `${args.join(' ')} is missing -z`)
    }
  })

  test('a normal PR/push diffs base against head', () => {
    assert.deepEqual(changedFilesCommand({ baseSha: 'aaa', headSha: 'bbb' }), [
      'diff',
      '-z',
      '--name-only',
      'aaa',
      'bbb',
    ])
  })

  test('an all-zero base SHA falls back to the whole tree at head', () => {
    // git reports the absent base of a branch's first push this way. Diffing
    // against it would fail the step; listing the tree routes everything,
    // which is the safe direction.
    assert.deepEqual(changedFilesCommand({ baseSha: ZERO_SHA, headSha: 'bbb' }), [
      'ls-tree',
      '-r',
      '-z',
      '--name-only',
      'bbb',
    ])
  })

  test('an absent base SHA falls back the same way', () => {
    for (const baseSha of [undefined, '']) {
      assert.deepEqual(
        changedFilesCommand({ baseSha, headSha: 'bbb' }),
        ['ls-tree', '-r', '-z', '--name-only', 'bbb'],
        `base ${JSON.stringify(baseSha)} must list the tree`,
      )
    }
  })
})

// NOTE: the routing rules themselves — which file turns which flag on, the
// cross-surface guard arms, the doc-only skips, the CLAUDE.md exception, the
// package fan-out — are characterized in routing-matrix.mjs and asserted by
// routing-matrix.test.mjs on all ten outputs (#1623). They deliberately do NOT
// also live here: two places asserting the same rule is how one of them drifts
// and starts passing vacuously, which is the failure this epic exists to fix.
//
// What stays in this file is the classifier's PLUMBING — the contract with
// ci.yml, list handling, propagation ordering, output rendering, glob
// semantics, and the CLI/git entry points.

describe('list handling', () => {
  test('flags accumulate across files and never turn back off', () => {
    assert.deepEqual(on(['packages/frontend/src/app/page.tsx', 'packages/cli/src/index.ts']), [
      'cli',
      'code',
      'frontend',
    ])
  })

  test('an empty list produces ten falses, not an empty object', () => {
    // The shape matters as much as the values: a downstream job reads
    // needs.changes.outputs.<name>, and a missing key is not the same as false.
    const outputs = classifyChangedFiles([])
    assert.deepEqual(Object.keys(outputs).sort(), [...OUTPUT_NAMES].sort())
    for (const name of OUTPUT_NAMES) assert.equal(outputs[name], false)
  })

  test('a path is matched verbatim, never trimmed', () => {
    // Trimming the matched value would make "scripts/dep-lint.mjs " (trailing
    // space) — a different file — route as though it were the guard. Blank
    // entries are still skipped; it is only the value used for MATCHING that
    // is now exact (#1638).
    assert.deepEqual(on(['scripts/dep-lint.mjs ']), [])
    assert.deepEqual(on(['scripts/dep-lint.mjs']), ['backend', 'code'])
  })

  test('blank and whitespace-only lines are ignored', () => {
    // `git diff --name-only` output ends with a newline, so the last split
    // element is always empty.
    assert.deepEqual(on(['', '   ', 'packages/cli/src/index.ts', '']), ['cli', 'code'])
  })
})

describe('propagation structure', () => {
  test('full comes first, and every other rule is one package', () => {
    // `full` is a directive, not a dependency: it must fan out before the
    // package rules so they see the flags it set. Everything after it is a
    // single package's dependents, derived from the table (#1625).
    assert.deepEqual(PROPAGATION_RULES[0].when, ['full'])
    for (const rule of PROPAGATION_RULES.slice(1)) {
      assert.equal(rule.when.length, 1, `expected one package per rule, got ${rule.when.join('|')}`)
      assert.ok(PACKAGE_JOBS.includes(rule.when[0]), `${rule.when[0]} is not a package job`)
    }
  })

  test('every rule is transitively closed', () => {
    // The property the closure buys, and the one a hand-written fan-out list
    // loses first: if a rule pulls in a package, it must also pull in whatever
    // that package drags along. A half-expanded chain (a -> b listed, b -> c
    // forgotten) reads fine and under-routes silently.
    for (const rule of PROPAGATION_RULES) {
      for (const job of rule.then) {
        for (const downstream of dependentsOf(job)) {
          assert.ok(
            rule.then.includes(downstream),
            `rule ${rule.when.join('|')} pulls in ${job} but not ${downstream}, which depends on it`,
          )
        }
      }
    }
  })

  test('applying the rules in any order gives the same answer', () => {
    // Closure makes each rule self-sufficient, so ordering among the package
    // rules stops being load-bearing. Asserting it means a future edit that
    // reintroduces order-dependence fails here rather than in a job that
    // quietly did not run.
    const reversed = [PROPAGATION_RULES[0], ...PROPAGATION_RULES.slice(1).reverse()]
    for (const files of [
      ['packages/sdk/src/client.ts'],
      ['packages/signer/src/index.ts'],
      ['packages/mcp/src/index.ts'],
      ['packages/signer/src/index.ts', 'packages/frontend/src/app/page.tsx'],
    ]) {
      assert.deepEqual(
        classifyChangedFiles(files, { propagationRules: reversed }),
        classifyChangedFiles(files),
        `order changed the result for ${files.join(' + ')}`,
      )
    }
  })
})

describe('output rendering', () => {
  test('every line is name=boolean, in contract order', () => {
    const rendered = formatGithubOutput(classifyChangedFiles(['packages/cli/src/index.ts']))
    const lines = rendered.trimEnd().split('\n')
    assert.deepEqual(
      lines.map((l) => l.split('=')[0]),
      [...OUTPUT_NAMES],
    )
    for (const line of lines) assert.match(line, /^[a-z_]+=(true|false)$/)
    assert.ok(rendered.endsWith('\n'), 'must end with a newline so appends do not glue lines together')
  })

  test('a non-boolean value is refused rather than emitted', () => {
    // GITHUB_OUTPUT is parsed line by line, so a value containing a newline
    // would forge additional outputs — e.g. a forged `full=true`, or a forged
    // `backend=false` that skips a guard. Nothing feeds caller-controlled text
    // in today; this is what keeps that true.
    for (const bad of ['true', 'true\nfull=true', 1, null, undefined]) {
      assert.throws(
        () => formatGithubOutput({ ...allSurfaces(), backend: bad }),
        /must be a boolean/,
        `value ${JSON.stringify(bad)} must be refused`,
      )
    }
  })

  test('a missing output is refused rather than emitted as empty', () => {
    const partial = allSurfaces()
    delete partial.full
    assert.throws(() => formatGithubOutput(partial), /full must be a boolean/)
  })
})

describe('glob semantics match the shell case they replaced', () => {
  test('* crosses directory separators', () => {
    // The rules were written for shell `case`, where * is not path-aware. If
    // this became path-aware, `packages/frontend/*` would stop matching the
    // subtree and only nested-file changes would route.
    assert.ok(globToRegExp('packages/frontend/*').test('packages/frontend/src/app/page.tsx'))
    assert.ok(globToRegExp('*.md').test('docs/a/b/c.md'))
  })

  test('patterns are anchored at both ends', () => {
    assert.equal(globToRegExp('package.json').test('packages/mcp/package.json'), false)
    assert.equal(globToRegExp('packages/mcp/*').test('x/packages/mcp/a.ts'), false)
  })

  test('regex metacharacters in a pattern are literal', () => {
    assert.ok(globToRegExp('.dependency-cruiser.cjs').test('.dependency-cruiser.cjs'))
    assert.equal(globToRegExp('.dependency-cruiser.cjs').test('Xdependency-cruiserXcjs'), false)
  })

  test('? matches exactly one character, as shell case does', () => {
    // No rule uses `?` today, but the translation implements it, and an
    // implemented-but-unverified branch is how a wrong rule ships the first
    // time someone reaches for one.
    assert.ok(globToRegExp('packages/mcp?/x.ts').test('packages/mcpX/x.ts'))
    assert.equal(globToRegExp('packages/mcp?/x.ts').test('packages/mcp/x.ts'), false)
    assert.equal(globToRegExp('packages/mcp?/x.ts').test('packages/mcpXY/x.ts'), false)
  })

  test('* matches a newline, as shell case does (#1638)', () => {
    // Without the dotAll flag `.*` stops at a newline, so a file whose name
    // contains one routes nowhere — the same silent, unsafe failure as the
    // quoted-path bug, reachable only once -z stopped hiding such paths.
    assert.ok(globToRegExp('packages/mcp/*').test('packages/mcp/src/new\nline.ts'))
    assert.ok(globToRegExp('*.md').test('docs/two\nlines.md'))
  })

  test('the tail anchor stays strict — no `m` flag creeps in', () => {
    // Unlike Perl and Python, a JavaScript `$` without `m` matches only at end
    // of input, so this already holds. It is pinned because ADDING `m` would
    // silently break it: `/^foo$/m.test('foo\n')` is true. The guard-ownership
    // manifest is built on exact paths meaning exact, so a lenient tail anchor
    // would let one file match another's entry.
    assert.equal(globToRegExp('scripts/dep-lint.mjs').test('scripts/dep-lint.mjs\n'), false)
    assert.equal(globToRegExp('scripts/dep-lint.mjs').test('scripts/dep-lint.mjs'), true)
    assert.equal(globToRegExp('scripts/dep-lint.mjs').flags.includes('m'), false)
  })

  test('bracket expressions are refused, not silently mis-matched', () => {
    assert.throws(() => globToRegExp('scripts/[abc].mjs'), /unsupported bracket expression/)
  })

  test('no rule pattern uses an unsupported construct', () => {
    for (const { patterns } of [...SURFACE_RULES, { patterns: DOC_ONLY_PATTERNS }]) {
      for (const p of patterns) assert.doesNotThrow(() => globToRegExp(p), `pattern ${p}`)
    }
  })
})

describe('the CLI', () => {
  test('--files-from a path writes GITHUB_OUTPUT when set', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'classifier-'))
    try {
      const list = path.join(dir, 'changed.txt')
      const ghOutput = path.join(dir, 'gh-output')
      writeFileSync(list, 'packages/cli/src/index.ts\ndocs/x.md\n')
      writeFileSync(ghOutput, '')
      runCli(['--files-from', list], { GITHUB_OUTPUT: ghOutput })
      const written = readFileSync(ghOutput, 'utf8')
      assert.match(written, /^cli=true$/m)
      assert.match(written, /^code=true$/m)
      assert.match(written, /^frontend=false$/m)
      assert.equal(written.trimEnd().split('\n').length, OUTPUT_NAMES.length)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('--files-from - reads stdin and prints to stdout when GITHUB_OUTPUT is unset', () => {
    const { output } = runCli(['--files-from', '-'], {}, 'packages/backend/src/routes/payments.ts\n')
    assert.match(output, /^backend=true$/m)
    assert.match(output, /^sdk=false$/m)
  })

  test('--files-from tolerates a CRLF list', () => {
    // #1638 stopped trimming the value used for matching, which is right for
    // the NUL-delimited git path but leaves this newline-delimited entrypoint
    // as the one place a line ending can still cling to a path. A stray \r
    // would match no rule and route NOTHING — the same silent, unsafe failure
    // this fix exists to remove.
    const dir = mkdtempSync(path.join(tmpdir(), 'classifier-crlf-'))
    try {
      const list = path.join(dir, 'changed.txt')
      writeFileSync(list, 'scripts/dep-lint.mjs\r\npackages/cli/src/index.ts\r\n')
      const { output } = runCli(['--files-from', list], {})
      assert.match(output, /^backend=true$/m, 'the guard should still route to backend')
      assert.match(output, /^cli=true$/m)
      assert.match(output, /^frontend=false$/m)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a bad invocation exits non-zero instead of emitting nothing quietly', () => {
    // A classifier that fails open would route nothing and every job would
    // skip — a green PR that tested nothing. Failing the step instead fails
    // the required `Detect changed surfaces` check, which blocks the merge.
    assert.throws(() => runCli(['--files-from', '/nope/missing.txt'], {}), /Command failed|status 1/)
  })
})

describe('the git-derived path ci.yml actually runs', () => {
  // Everything above drives the classifier through --files-from, but ci.yml
  // passes no such flag: it sets BASE_SHA/HEAD_SHA and lets the script shell
  // out to git. That leaves the production entry point — the git invocation,
  // its argument order, and the parse of its output — as the one path a
  // refactor could break with every other test still green. Which is the exact
  // failure this extraction exists to end, so it gets a real repo.

  /** A throwaway git repo with two commits; returns paths and SHAs. */
  function fixtureRepo(secondCommitFiles) {
    const dir = mkdtempSync(path.join(tmpdir(), 'classifier-git-'))
    const git = (...args) =>
      execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          // Isolate from the developer's own git config so a stray
          // core.quotepath or commit.gpgsign cannot change the result.
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@example.com',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@example.com',
        },
      }).trim()

    git('init', '-q', '-b', 'main')
    writeFileSync(path.join(dir, 'seed.txt'), 'seed\n')
    git('add', '-A')
    git('commit', '-qm', 'seed')
    const base = git('rev-parse', 'HEAD')

    for (const rel of secondCommitFiles) {
      const full = path.join(dir, rel)
      execFileSync('mkdir', ['-p', path.dirname(full)])
      writeFileSync(full, 'x\n')
    }
    git('add', '-A')
    git('commit', '-qm', 'change', ...(secondCommitFiles.length ? [] : ['--allow-empty']))
    const head = git('rev-parse', 'HEAD')

    return { dir, base, head }
  }

  test('BASE_SHA + HEAD_SHA classifies a real two-commit diff', () => {
    const { dir, base, head } = fixtureRepo([
      'packages/backend/src/routes/payments.ts',
      'docs/ignored.md',
    ])
    try {
      const { output } = runCli([], { BASE_SHA: base, HEAD_SHA: head }, '', dir)
      // The backend file routes; the doc does not. sdk stays false, which is
      // what proves the diff was really read rather than defaulted to "all".
      assert.match(output, /^backend=true$/m)
      assert.match(output, /^code=true$/m)
      assert.match(output, /^sdk=false$/m)
      assert.match(output, /^frontend=false$/m)
      assert.match(output, /^full=false$/m)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an all-zero BASE_SHA falls back to listing the whole tree at HEAD', () => {
    // A branch's first push. The fallback must classify every tracked file,
    // not fail the step and not silently route nothing.
    const { dir, head } = fixtureRepo(['packages/cli/src/index.ts'])
    try {
      const { output } = runCli([], { BASE_SHA: ZERO_SHA, HEAD_SHA: head }, '', dir)
      assert.match(output, /^cli=true$/m)
      assert.match(output, /^code=true$/m)
      // seed.txt is in the tree and routes nowhere; cli came from ls-tree.
      assert.match(output, /^backend=false$/m)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a path git would otherwise quote still routes (#1638)', () => {
    // THE regression test for #1638. With plain `--name-only`, core.quotepath
    // emits café.ts as "packages/frontend/src/caf\303\251.ts" — quotes and
    // escapes included — which matches no rule, so frontend_checks silently did
    // not run for it. Each file lives in a different package so the assertion
    // shows WHICH routing survived, not merely that something did.
    const { dir, base, head } = fixtureRepo([
      'packages/frontend/src/caf\u00e9.ts', // non-ASCII: the quoted case
      'packages/cli/src/back\\slash.ts', // a literal backslash in the name
      'packages/backend/src/with space.ts', // spaces were never quoted; pinned anyway
    ])
    try {
      const { output } = runCli([], { BASE_SHA: base, HEAD_SHA: head }, '', dir)
      for (const flag of ['code', 'frontend', 'cli', 'backend']) {
        assert.match(output, new RegExp(`^${flag}=true$`, 'm'), `${flag} should have routed`)
      }
      // Nothing spurious: these three packages fan out to nothing.
      for (const flag of ['sdk', 'mcp', 'signer', 'full']) {
        assert.match(output, new RegExp(`^${flag}=false$`, 'm'), `${flag} should not have routed`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a path containing a NEWLINE routes correctly', () => {
    // The case that makes NUL the only honest separator: a filename may contain
    // a newline, so newline-delimited output is ambiguous even with quoting
    // disabled. git quotes this one too, so it is also a #1638 case.
    const { dir, base, head } = fixtureRepo(['packages/mcp/src/new\nline.ts'])
    try {
      const { output } = runCli([], { BASE_SHA: base, HEAD_SHA: head }, '', dir)
      assert.match(output, /^mcp=true$/m)
      // mcp fans out to connect, which proves the path was classified rather
      // than merely producing some non-false flag.
      assert.match(output, /^connect=true$/m)
      assert.match(output, /^backend=false$/m)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an unusable SHA fails the step rather than routing nothing', () => {
    const { dir } = fixtureRepo([])
    try {
      assert.throws(
        () => runCli([], { BASE_SHA: 'nonexistentsha', HEAD_SHA: 'alsomissing' }, '', dir),
        /status 1|Command failed/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** Run the classifier CLI in a clean env; returns its stdout. */
function runCli(args, env, stdin = '', cwd = undefined) {
  const output = execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    input: stdin,
    cwd,
    // stderr is the script's log channel; keep it out of the test output.
    stdio: ['pipe', 'pipe', 'ignore'],
    env: {
      PATH: process.env.PATH,
      // Deliberately NOT inheriting: a real Actions env would otherwise leak
      // GITHUB_OUTPUT or EVENT_NAME into these assertions.
      ...env,
    },
  })
  return { output }
}
