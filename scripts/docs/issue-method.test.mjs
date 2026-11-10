// Tests for the issue Method-block runner (#4771).
//
// The cases that run `git` use a small repository this file builds with fixed
// author, committer and dates, so its commit ids are the same on every machine
// and the committed fixture bodies can name them. The two `real-*.md` bodies
// read a commit of THIS repository and run only where its history is present;
// a depth-1 CI checkout skips them by name, and the `repo-*.md` twins are the
// ones CI can fail on.

import assert from 'node:assert/strict'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  GIT_ENV,
  GIT_OUTPUT_CAP,
  GIT_TIMEOUT_MS,
  MAX_BODY_BYTES,
  Refusal,
  buildGitArgs,
  exitCodeFor,
  extractMethodLines,
  formatReport,
  parseArgs,
  parseCheckableLine,
  printable,
  runChecks,
  verdict,
} from './issue-method.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SCRIPT = join(HERE, 'issue-method.mjs')
const FIXTURES = join(HERE, 'fixtures', 'issue-method')
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8')

/** The fixture repository's two commits. A change to `FILES` or the dates moves them. */
const BASE_SHA = '249c77ca0f0b1aa8b98d3df9d51d630dd49fefe3'
const SIDE_SHA = '8d170cd8c75a03bef0bcfc363332e838c050720b'

const FILES = {
  'packages/a/src/index.ts': "import x from 'y'\n// TODO later\nexport const a = 1\n",
  'packages/b/src/main.ts': "import z from 'w'\nconst b = 2\n",
  'docs/notes.md': 'line one\nline two runs bash -c somewhere\nline three\nline four\nline five\n',
}

const FIXTURE_GIT_ENV = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
}

let scratch
let repo
let bareRepo

function makeRepo(dir, { originDev }) {
  mkdirSync(dir, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: FIXTURE_GIT_ENV, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'core.autocrlf', 'false')
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture: base')
  const base = git('rev-parse', 'HEAD')
  if (originDev) git('update-ref', 'refs/remotes/origin/dev', base)
  writeFileSync(join(dir, 'side.txt'), 'side\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'fixture: side')
  return { base, side: git('rev-parse', 'HEAD') }
}

before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'issue-method-'))
  repo = join(scratch, 'repo')
  bareRepo = join(scratch, 'no-origin')
  const made = makeRepo(repo, { originDev: true })
  makeRepo(bareRepo, { originDev: false })
  assert.equal(made.base, BASE_SHA, 'the fixture repository moved: the repo-*.md fixtures name the old base commit')
  assert.equal(made.side, SIDE_SHA, 'the fixture repository moved: the fixtures name the old side commit')
})

after(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const statuses = (result) => result.entries.map((e) => verdict(e))
const cli = (args, options = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', ...options })

describe('extractMethodLines', () => {
  it('reads only fenced lines under the Method heading, and marks the checkable ones', () => {
    const lines = extractMethodLines(fixture('repo-reproduces.md'))
    assert.equal(lines.length, 14)
    assert.equal(lines.filter((l) => l.checkable).length, 12)
    assert.ok(lines.every((l) => !l.text.includes('lines = 99')), 'a fence under a later heading was read')
    assert.match(lines[0].text, /^SHA=249c77ca0/)
    assert.equal(lines[0].lineNumber, 10)
  })

  it('does not take a heading inside a fence for the end of the section, and reads nested Method sub-headings', () => {
    const body = ['## Method', '```bash', '## Scope', 'a   # check: exists', '```', '### Detail', '~~~', 'b', '~~~', '## Next', '```', 'c', '```'].join('\n')
    assert.deepEqual(
      extractMethodLines(body).map((l) => [l.lineNumber, l.text, l.checkable]),
      [
        [3, '## Scope', false],
        [4, 'a   # check: exists', true],
        [8, 'b', false],
      ],
    )
  })

  it('closes a fence only on a bare run of the same character, at least as long', () => {
    const body = ['## Method', '````', '~~~~', '```', '```` bash', 'x', '````', 'outside', '```', 'y', '```'].join('\n')
    assert.deepEqual(
      extractMethodLines(body).map((l) => l.text),
      ['~~~~', '```', '```` bash', 'x', 'y'],
    )
  })

  it('reads a CRLF body as it reads an LF one', () => {
    const lf = extractMethodLines(fixture('repo-reproduces.md'))
    const crlf = extractMethodLines(fixture('repo-reproduces.md').replace(/\n/g, '\r\n'))
    assert.deepEqual(crlf, lf)
  })

  it('takes only a heading that begins with the word Method, and only a # after whitespace for a marker', () => {
    for (const heading of ['## Methodology', '## The method', '##Method']) {
      assert.deepEqual(extractMethodLines(`${heading}\n\`\`\`\nx\n\`\`\`\n`), [], heading)
    }
    assert.equal(extractMethodLines('## Method ##\n```\nx\n```\n').length, 1)
    const [line] = extractMethodLines('# METHOD (commands)\n```\ngit ls-tree abcdef1 -- a#check: exists\n```\n')
    assert.equal(line.checkable, false)
  })

  it('reads a hostile heading line in linear time', () => {
    // A run of spaces followed by a character the tail cannot match: the old
    // pattern took over a second at 1 600 spaces and grew with the cube.
    const started = process.hrtime.bigint()
    extractMethodLines(`# a${' '.repeat(1900)}x\n## Method\n`)
    assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 1000, 'the heading regexp backtracks')
  })

  it('finds nothing in a body with no Method heading', () => {
    assert.deepEqual(extractMethodLines('## Scope\n```bash\ngit ls-tree abcdef1 -- x   # check: exists\n```\n'), [])
  })
})

describe('the grammar', () => {
  it('parses the three kinds into fields', () => {
    assert.deepEqual(parseCheckableLine("git grep -c -w -E -e 'TODO|FIXME' 49747fac3 -- 'packages/*/src/**' ':!x'   # check: lines = 0; control: reach"), {
      command: {
        kind: 'grep-lines',
        sha: '49747fac3',
        pattern: 'TODO|FIXME',
        pathspecs: ['packages/*/src/**', ':!x'],
        word: true,
        ignoreCase: false,
        patternType: '-E',
      },
      expectation: { type: 'count', expected: 0, control: 'reach' },
    })
    assert.deepEqual(parseCheckableLine('git show 49747fac3:a/b.md # check: lines 19-45 contain "bash -c"  # the executor'), {
      command: { kind: 'show', sha: '49747fac3', path: 'a/b.md' },
      expectation: { type: 'contain', from: 19, to: 45, literal: 'bash -c' },
    })
    assert.deepEqual(parseCheckableLine('git ls-tree 49747fac3 -- a/b.md # check: absent'), {
      command: { kind: 'ls-tree', sha: '49747fac3', path: 'a/b.md' },
      expectation: { type: 'absent' },
    })
    assert.deepEqual(parseCheckableLine("git grep -l -e 'import' 49747fac3 -- src   # control: reach").expectation, { type: 'control', name: 'reach' })
  })

  it('pins the pattern type when the line names none, so user configuration cannot change what a pattern means', () => {
    assert.equal(parseCheckableLine("git grep -c -e 'a' 49747fac3 -- src # check: lines = 1").command.patternType, '-G')
    assert.equal(parseCheckableLine("git grep -c -F -e 'a' 49747fac3 -- src # check: lines = 1").command.patternType, '-F')
  })

  // One fixture line per refusal the issue names, and the reason each must carry.
  const REFUSALS = [
    ["git grep -c -e '-x' 49747fac3 -- src   # check: lines = 1", /pattern that begins with "-"/],
    ["git grep -c -e 'a' 49747fac3 -- '--output=x'   # check: lines = 1", /pathspec that begins with "-"/],
    ["git ls-tree 49747fac3 -- '-r'   # check: exists", /path that begins with "-"/],
    ['git ls-tree 49747fac3 -- /etc/passwd   # check: exists', /absolute path/],
    ["git show 49747fac3:/etc/passwd   # check: line 1 contains 'root'", /absolute path/],
    ["git show 49747fac3:a/../b   # check: line 1 contains 'x'", /contains "\.\."/],
    ["git grep -c -e 'a' 49747fac3 -- '../x'   # check: lines = 1", /contains "\.\."/],
    ["git grep -c -e 'a' 49747fac3 -- ':(top)src'   # check: lines = 1", /magic other than/],
    ["git grep -c -e 'a' HEAD -- src   # check: lines = 1", /not 7-40 lowercase hex/],
    ["git grep -c -e 'a' origin/dev -- src   # check: lines = 1", /not 7-40 lowercase hex/],
    ["git grep -c -e 'a' 49747F -- src   # check: lines = 1", /not 7-40 lowercase hex/],
    ["git grep -c -e 'a' 49747fac3 -- src | wc -l   # check: lines = 1", /^a pipe$/],
    ["git grep -c -e 'a' 49747fac3 -- src > out   # check: lines = 1", /^a redirection$/],
    ["git grep -c -e 'a' 49747fac3 -- src < in   # check: lines = 1", /^a redirection$/],
    ['git grep -c -e "$(id)" 49747fac3 -- src   # check: lines = 1', /^a substitution$/],
    ['git grep -c -e `id` 49747fac3 -- src   # check: lines = 1', /^a substitution$/],
    ["git grep -c -e 'a' ${SHA} -- src   # check: lines = 1", /^a substitution$/],
    ["git grep -c -e 'a' $SHA -- src   # check: lines = 1", /^a substitution$/],
    ["git grep -c -e 'a' 49747fac3 -- src; id   # check: lines = 1", /^a second command$/],
    ["git grep -c -e 'a' 49747fac3 -- src && id   # check: lines = 1", /^a second command$/],
    ["GIT_DIR=/tmp git grep -c -e 'a' 49747fac3 -- src   # check: lines = 1", /^an environment assignment$/],
    ["rg -c 'a' src   # check: lines = 1", /^a tool other than git$/],
    ["node -e '1'   # check: lines = 1", /^a tool other than git$/],
    ['gh issue view 1   # check: exists', /^a tool other than git$/],
    ['git log --oneline 49747fac3   # check: lines = 1', /subcommand outside the three check kinds \(log\)/],
    ['git diff 49747fac3   # check: lines = 1', /subcommand outside the three check kinds \(diff\)/],
    ["git -c core.pager=x grep -c -e 'a' 49747fac3 -- src   # check: lines = 1", /git flag outside the three check kinds \(-c\)/],
    ["git grep --output=x -c -e 'a' 49747fac3 -- src   # check: lines = 1", /grep flag outside the check kinds \(--output=x\)/],
    ["git grep -Oless -c -e 'a' 49747fac3 -- src   # check: lines = 1", /grep flag outside the check kinds \(-Oless\)/],
    ["git grep --open-files-in-pager=less -e 'a' 49747fac3 -- src   # check: files = 1", /grep flag outside the check kinds/],
    ["git grep -c --ext-diff -e 'a' 49747fac3 -- src   # check: lines = 1", /grep flag outside the check kinds \(--ext-diff\)/],
    ["git show --ext-diff 49747fac3:a   # check: line 1 contains 'x'", /not: git show <sha>:<path>/],
    ["git show --output=x 49747fac3:a   # check: line 1 contains 'x'", /not: git show <sha>:<path>/],
    ['git ls-tree -r 49747fac3 -- a   # check: exists', /not: git ls-tree <sha> -- <path>/],
    ["git grep -c 'a' 49747fac3 -- src   # check: lines = 1", /does not follow -e/],
    ["git grep -c -l -e 'a' 49747fac3 -- src   # check: lines = 1", /exactly one of -c/],
    ["git grep -e 'a' 49747fac3 -- src   # check: lines = 1", /exactly one of -c/],
    ["git grep -c -E -F -e 'a' 49747fac3 -- src   # check: lines = 1", /both -E and -F/],
    ["git grep -c -e 'a' 49747fac3 -- src/*   # check: lines = 1", /unquoted glob/],
    ["git grep -c -e 'a\\b' 49747fac3 -- src   # check: lines = 1", null],
    ['git grep -c -e a\\b 49747fac3 -- src   # check: lines = 1', /backslash escape/],
    ["git grep -c -e 'a' 49747fac3 src   # check: lines = 1", /not: git grep <flags> -e/],
    ["git grep -c -e 'a' 49747fac3 --   # check: lines = 1", /no pathspec/],
    ["git grep -l -e 'a' 49747fac3 -- src   # check: lines = 1", /"lines =" on a line that is not git grep -c/],
    ['git ls-tree 49747fac3 -- a   # check: lines = 1', /"lines =" on a line that is not/],
    ["git grep -c -e 'a' 49747fac3 -- src   # check: exists", /"exists" on a line that is not/],
    ['git ls-tree 49747fac3 -- a   # control: c', /control that is not a git grep line/],
    ["git show 49747fac3:a   # check: lines 3-1 contain 'x'", /does not run forward/],
    ["git show 49747fac3:a   # check: line 0 contains 'x'", /does not run forward/],
    ['git show 49747fac3:a   # check: line 1 contains x', /literal that is not quoted/],
    ["git grep -c -e 'a' 49747fac3 -- src   # check: lines = two", /grammar does not know/],
    ["git grep -c -e 'a' 49747fac3 -- src   # check: lines = 1 or so", /grammar does not know/],
    ["git grep -c -e ' # check: lines = 1' 49747fac3 -- src", /marker sits inside a quoted field/],
    ["git grep -c -e 'a 49747fac3 -- src   # check: lines = 1", /unterminated quote/],
    ['   # check: exists', /no command before/],
    // Review round 1 (#4771): every unquoted character, control characters, limits, names.
    ...['(', ')', '{', '}', '~', '!', '?', '[', ']'].map((ch) => [`git grep -c -e a${ch}b 49747fac3 -- src   # check: lines = 1`, /substitution or subshell|unquoted/]),
    ["git grep -c -e 'a\x1bb' 49747fac3 -- src   # check: lines = 1", /^a control character$/],
    ["git grep -c -e 'a' 49747fac3 -- src   # check: lines = 1 # \x1b[2K", /^a control character$/],
    ["git grep -c -e 'a' 49747fac3 -- src   # check: lines = 1 # a\rb", /^a control character$/],
    ["git grep -c -e 'a'\u00a049747fac3 -- src   # check: lines = 1", /whitespace other than space and tab/],
    ["git grep -c -e 'a' 49747fac3 -- src   # check: lines = 1 # x\u2028y", /whitespace other than space and tab/],
    ['git grep -c -e "a\\b" 49747fac3 -- src   # check: lines = 1', /inside double quotes/],
    ['git grep -c -e "a!b" 49747fac3 -- src   # check: lines = 1', /inside double quotes/],
    [`git grep -c -e '${'a'.repeat(501)}' 49747fac3 -- src   # check: lines = 1`, /pattern longer than 500/],
    [`git grep -c -e 'a' 49747fac3 -- src   # check: lines = 1 # ${'n'.repeat(2000)}`, /line longer than 2000/],
    [`git grep -c -e 'a' 49747fac3 -- ${Array.from({ length: 51 }, (_, i) => `p${i}`).join(' ')}   # check: lines = 1`, /more than 50 pathspecs/],
    ["git grep -c -e '' 49747fac3 -- src   # check: lines = 1", /an empty pattern/],
    ["git grep -c -e 'a' 49747fac3 -- ''   # check: lines = 1", /an empty pathspec/],
    ["git show 49747fac3:a   # check: line 1 contains ''", /an empty literal/],
    ["git show 49747fac3:a   # check: line 1 contains '\ufffd'", /U\+FFFD/],
    ["git grep -l -e 'a' 49747fac3 -- src   # control: a/b", /control name/],
    ["git grep -c -e 'a' 49747fac3 -- src   # check: lines = 0; control: a/b", /control name/],
    ["git grep -c -e 'a' 49747fac3 -- ':!/abs'   # check: lines = 1", /magic other than/],
    ["git grep -c -e 'a' 49747fac3 -- ':!../x'   # check: lines = 1", /contains "\.\."/],
    ["git grep -c -e 'a' 49747fac3 -- ':!:(top)x'   # check: lines = 1", /magic other than/],
    ["git grep -c -e 'a' 49747fac3 -- ':!^docs'   # check: lines = 1", /magic other than/],
    ["git grep -c -e 'a' 49747fac3 -- ':!!src'   # check: lines = 1", /magic other than/],
    ["git grep -c -e 'a' 49747fac3 -- ':!x/..'   # check: lines = 1", /contains "\.\."/],
    ["git show 49747fac3::x   # check: line 1 contains 'x'", /magic other than/],
    ['git ls-tree 49747fac3 -- :x   # check: exists', /magic other than/],
    ['git ls-tree 49747fac3 -- src/a.ts/   # check: absent', /ends in "\/"/],
    ["git show 49747fac3:src/   # check: line 1 contains 'x'", /ends in "\/"/],
  ]

  for (const [line, reason] of REFUSALS) {
    if (reason === null) {
      it(`accepts a backslash inside single quotes: ${line}`, () => {
        assert.equal(parseCheckableLine(line).command.pattern, 'a\\b')
      })
      continue
    }
    it(`refuses: ${line}`, () => {
      assert.throws(
        () => parseCheckableLine(line),
        (err) => err instanceof Refusal && reason.test(err.message),
      )
    })
  }
})

describe('buildGitArgs — the runner builds its own vector', () => {
  it('puts the pattern directly after -e and every pathspec after --', () => {
    const { command } = parseCheckableLine("git grep -c -w -i -E -e 'a|b' 49747fac3 -- 'x/**' ':!y'   # check: lines = 1")
    assert.deepEqual(buildGitArgs(command, 'f'.repeat(40)), [
      'grep',
      '--no-color',
      '--no-recurse-submodules',
      '-z',
      '-c',
      '-w',
      '-i',
      '-E',
      '-e',
      'a|b',
      'f'.repeat(40),
      '--',
      'x/**',
      ':!y',
    ])
  })

  it('reads a file and a tree entry at the full SHA, with the path as data', () => {
    const full = 'a'.repeat(40)
    assert.deepEqual(buildGitArgs({ kind: 'show', path: 'a b.md' }, full), ['show', '--no-textconv', '--no-ext-diff', `${full}:a b.md`])
    assert.deepEqual(buildGitArgs({ kind: 'ls-tree', path: 'a' }, full), ['ls-tree', '-z', '--name-only', full, '--', 'a'])
  })

  it('gives git a fixed environment: no token, no HOME, nothing inherited', () => {
    assert.deepEqual(
      { ...GIT_ENV },
      {
        PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_NO_LAZY_FETCH: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
      },
    )
    assert.ok(Object.isFrozen(GIT_ENV))
  })
})

describe('against the fixture repository', () => {
  it('reproduces every checkable line of a correct body, through the CLI, and exits 0', () => {
    const run = cli(['--body-file', join(FIXTURES, 'repo-reproduces.md'), '--repo', repo])
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /Summary: 12 checkable — 12 reproduce, 0 differ, 0 refused, 0 unproven zero\. 2 free-form not checked\./)
    assert.doesNotMatch(run.stdout, /Failed controls/)
  })

  it('reports each wrong figure as differs, with what it got, and exits 1', async () => {
    const result = await runChecks(fixture('repo-differs.md'), { repo })
    assert.deepEqual(statuses(result), [
      'differs (got 2)',
      'differs (got 2)',
      'differs (got 1)',
      'differs (got the literal at line 2)',
      'differs (got a file of 5 lines)',
      'differs (got no such literal in the file)',
      'differs (got no such path at the SHA)',
      'differs (got absent)',
      'differs (got exists)',
    ])
    assert.equal(exitCodeFor(result), 1)
  })

  it('reports the #4757 false zero as an unproven zero and lists its control apart', async () => {
    const result = await runChecks(fixture('repo-false-zero.md'), { repo })
    assert.deepEqual(statuses(result), ['differs (got 0)', 'unproven zero (control "reach" returned 0)'])
    assert.equal(exitCodeFor(result), 1)
    const report = formatReport(result)
    assert.match(report, /Failed controls[^\n]*\n  L9  differs \(got 0\)/)
    assert.match(report, /1 differ, 0 refused, 1 unproven zero/)
  })

  it('does not accept a zero whose control is missing, unnamed, refused, over other pathspecs, or zero itself', async () => {
    const result = await runChecks(fixture('repo-unproven.md'), { repo })
    assert.deepEqual(statuses(result), [
      'differs (got 0)',
      'reproduces (got 2)',
      'refused (a SHA that is not an ancestor of origin/dev or origin/main (8d170cd8c))',
      'unproven zero (no control named)',
      'unproven zero (control "missing" is not a line in this block)',
      'unproven zero (control "empty" returned 0)',
      'unproven zero (control "elsewhere" reads other pathspecs)',
      'unproven zero (control "offbranch" was refused)',
      'unproven zero (parent directory packages/a/scr does not exist at the SHA)',
    ])
  })

  it('does not accept a control that reads another SHA', async () => {
    const body = [
      '## Method',
      '```',
      `git grep -l -e 'import' ${BASE_SHA} -- packages   # control: c`,
      "git grep -c -e 'FIXME' 249c77ca0 -- packages   # check: lines = 0; control: c",
      '```',
    ].join('\n')
    assert.deepEqual(statuses(await runChecks(body, { repo })), ['reproduces (got 2)', 'reproduces (control "c" got 2)'], 'an abbreviation of the same commit is the same SHA')
    const other = mkdtempSync(join(scratch, 'two-'))
    const git = (...args) => execFileSync('git', args, { cwd: other, env: FIXTURE_GIT_ENV, encoding: 'utf8' }).trim()
    makeRepo(other, { originDev: false })
    git('update-ref', 'refs/remotes/origin/dev', SIDE_SHA)
    const twoShas = body.replace('249c77ca0 -- packages   # check', '8d170cd8c -- packages   # check')
    assert.deepEqual(statuses(await runChecks(twoShas, { repo: other })), ['reproduces (got 2)', 'unproven zero (control "c" reads another SHA)'])
  })

  it('refuses a control name used twice, and every zero that cites it', async () => {
    const body = [
      '## Method',
      '```',
      "git grep -l -e 'import' 249c77ca0 -- packages   # control: c",
      "git grep -l -e 'const' 249c77ca0 -- packages   # control: c",
      "git grep -c -e 'FIXME' 249c77ca0 -- packages   # check: lines = 0; control: c",
      '```',
    ].join('\n')
    assert.deepEqual(statuses(await runChecks(body, { repo })), [
      'refused (a control name used twice (c))',
      'refused (a control name used twice (c))',
      'unproven zero (control "c" was refused)',
    ])
  })

  it('refuses every line of the refusal fixture, and runs none of them', async () => {
    const cwdBefore = process.cwd()
    process.chdir(repo)
    try {
      const result = await runChecks(fixture('repo-refusals.md'), { repo })
      assert.equal(result.entries.length, 46)
      for (const entry of result.entries) assert.equal(entry.status, 'refused', `${entry.text} → ${verdict(entry)}`)
      assert.equal(exitCodeFor(result), 1)
      const reasons = new Set(result.entries.map((e) => e.detail))
      for (const reason of [
        'a SHA that is not an ancestor of origin/dev or origin/main (8d170cd8c)',
        'a SHA that does not resolve to one commit in this clone (0123456789abcdef)',
        'a pipe',
        'a redirection',
        'a substitution',
        'a second command',
        'an environment assignment',
        'a tool other than git',
      ]) {
        assert.ok(reasons.has(reason), `no line was refused as: ${reason}`)
      }
    } finally {
      process.chdir(cwdBefore)
    }
    for (const dir of [repo, HERE, REPO_ROOT, process.cwd()]) {
      assert.equal(existsSync(join(dir, 'CANARY')), false, `a refused line wrote CANARY into ${dir}`)
    }
    assert.deepEqual(readdirSync(repo).sort(), ['.git', 'docs', 'packages', 'side.txt'])
  })

  it('shows what stood behind a reproduced zero or absence, and that a top-level absence had no control', async () => {
    const result = await runChecks(fixture('repo-reproduces.md'), { repo })
    assert.deepEqual(
      statuses(result).filter((v) => v !== 'reproduces'),
      [
        'reproduces (got 2)',
        'reproduces (control "reach" got 2)',
        'reproduces (parent packages/a/src exists)',
        'reproduces (top-level path: no parent to check)',
      ],
    )
  })

  it('reproduces a CRLF body', async () => {
    const result = await runChecks(fixture('repo-reproduces.md').replace(/\n/g, '\r\n'), { repo })
    assert.equal(result.entries.length, 12)
    assert.equal(exitCodeFor(result), 0)
  })

  it('starts nothing but git, each call with the prefix, the fixed environment, the timeout and the cap, and no shell', async () => {
    const calls = []
    const exec = (file, args, options, callback) => {
      calls.push({ file, args, options })
      return execFile(file, args, options, callback)
    }
    for (const name of ['repo-reproduces.md', 'repo-differs.md', 'repo-unproven.md', 'repo-refusals.md']) {
      await runChecks(fixture(name), { repo, exec })
    }
    assert.ok(calls.length > 40)
    const subcommands = new Set()
    for (const { file, args, options } of calls) {
      assert.equal(file, 'git')
      assert.deepEqual(args.slice(0, 3), ['--no-pager', '-c', 'protocol.allow=never'])
      subcommands.add(args[3])
      assert.equal(options.env, GIT_ENV)
      assert.equal(options.cwd, repo)
      assert.equal(options.timeout, GIT_TIMEOUT_MS)
      assert.equal(options.maxBuffer, GIT_OUTPUT_CAP)
      assert.equal('shell' in options, false)
    }
    assert.deepEqual([...subcommands].sort(), ['cat-file', 'grep', 'ls-tree', 'merge-base', 'rev-parse', 'show'])
    assert.ok(GIT_TIMEOUT_MS > 0 && GIT_TIMEOUT_MS <= 60_000)
    assert.ok(GIT_OUTPUT_CAP > 0 && GIT_OUTPUT_CAP <= 64 * 1024 * 1024)
  })

  // A stand-in for one git subcommand: the real options go to a process that
  // hangs, floods or fails, so the runner's own timeout and cap are what stop it.
  const standIn = (subcommand, script) => (file, args, options, callback) =>
    args[3] === subcommand ? execFile(process.execPath, ['-e', script], options, callback) : execFile(file, args, options, callback)
  const oneLine = (line) => `## Method\n\`\`\`\n${line}\n\`\`\`\n`

  it('refuses a line whose git call outlives the timeout', async () => {
    const result = await runChecks(oneLine("git grep -c -e 'import' 249c77ca0 -- packages   # check: lines = 2"), {
      repo,
      timeoutMs: 300,
      exec: standIn('grep', 'setTimeout(() => {}, 30000)'),
    })
    assert.deepEqual(statuses(result), ['refused (git did not finish in 0.3s)'])
  })

  it('refuses a line whose git call prints more than the cap', async () => {
    const result = await runChecks(oneLine("git show 249c77ca0:docs/notes.md   # check: line 1 contains 'line one'"), {
      repo,
      outputCap: 64,
      exec: standIn('show', "process.stdout.write('line one\\n'.repeat(100))"),
    })
    assert.deepEqual(statuses(result), ['refused (git printed more than the output cap)'])
  })

  it('refuses, and never reads as zero or absent, a git call that fails', async () => {
    const fail = "process.stderr.write('fatal: boom\\n'); process.exit(128)"
    const cases = [
      ['grep', "git grep -c -e 'FIXME' 249c77ca0 -- packages   # check: lines = 0; control: c", 'refused (git grep failed (fatal: boom))'],
      ['ls-tree', 'git ls-tree 249c77ca0 -- packages/a/src/gone.ts   # check: absent', 'refused (git ls-tree failed (fatal: boom))'],
      ['show', "git show 249c77ca0:docs/notes.md   # check: line 1 contains 'line one'", 'refused (git show failed (exit 128))'],
      ['cat-file', "git show 249c77ca0:docs/notes.md   # check: line 1 contains 'line one'", 'refused (the file is in the tree but its content is not in this clone)'],
    ]
    for (const [subcommand, line, expected] of cases) {
      const result = await runChecks(oneLine(line), { repo, exec: standIn(subcommand, fail) })
      assert.deepEqual(statuses(result), [expected], subcommand)
    }
    const real = await runChecks(oneLine("git grep -c -E -e '(' 249c77ca0 -- packages   # check: lines = 0; control: c"), { repo })
    assert.match(statuses(real)[0], /^refused \(git grep failed \(/)
  })

  it('refuses git show of a directory instead of reading its listing as a file', async () => {
    const result = await runChecks(oneLine("git show 249c77ca0:docs   # check: line 1 contains 'notes.md'"), { repo })
    assert.deepEqual(statuses(result), ['refused (a git show path that is a tree, not a file)'])
  })

  it('does not take a branch whose name is hex for the SHA', async () => {
    const other = mkdtempSync(join(scratch, 'hexref-'))
    makeRepo(other, { originDev: true })
    execFileSync('git', ['branch', '1234567', BASE_SHA], { cwd: other, env: FIXTURE_GIT_ENV })
    const result = await runChecks(oneLine('git ls-tree 1234567 -- docs   # check: exists'), { repo: other })
    assert.deepEqual(statuses(result), ['refused (a SHA that does not resolve to one commit in this clone (1234567))'])
  })

  it('refuses the checkable lines past the 200th', async () => {
    const body = `## Method\n\`\`\`\n${'git ls-tree 249c77ca0 -- docs   # check: exists\n'.repeat(201)}\`\`\`\n`
    const result = await runChecks(body, { repo })
    assert.equal(result.entries.filter((e) => e.status === 'reproduces').length, 200)
    assert.equal(verdict(result.entries[200]), 'refused (more than 200 checkable lines in one block)')
  })

  it('prints no control character from the body: a refused line is shown escaped', async () => {
    const hostile = [
      "git ls-tree 249c77ca0 -- docs   # check: exists # \x1b[1A\x1b[2K  L3  FORGED\x1b]0;title\x07",
      'git ls-tree 249c77ca0 -- docs   # check: exists # a\rL9  reproduces',
      'git ls-tree 249c77ca0 -- docs   # check: exists # \u202eright-to-left',
    ].join('\n')
    const result = await runChecks(`## Method\n\`\`\`\n${hostile}\n\`\`\`\n`, { repo })
    assert.deepEqual(
      result.entries.map((e) => e.status),
      ['refused', 'refused', 'refused'],
    )
    const report = formatReport(result)
    assert.doesNotMatch(report, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028-\u202e]/)
    assert.match(report, /\\x1b\[1A\\x1b\[2K {2}L3 {2}FORGED\\x1b\]0;title\\x07/)
    assert.match(report, /a\\x0dL9/)
    assert.match(report, /\\u202eright-to-left/)
    assert.equal(printable('a\tb\x7f\u0085\u2066'), 'a\\x09b\\x7f\\x85\\u2066')
  })

  it('refuses every SHA when the clone has no origin/dev or origin/main to check it against', async () => {
    const body = "## Method\n```\ngit ls-tree 249c77ca0 -- docs   # check: exists\n```\n"
    assert.deepEqual(statuses(await runChecks(body, { repo: bareRepo })), [
      'refused (no origin/dev or origin/main remote-tracking ref in this clone to check the SHA against)',
    ])
  })

  it('does not hand git the caller’s environment', async () => {
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL }
    // Inherited, either of these breaks every git call in the fixture clone.
    process.env.GIT_DIR = join(scratch, 'does-not-exist')
    process.env.GIT_CONFIG_GLOBAL = join(scratch, 'does-not-exist', 'config')
    try {
      const result = await runChecks("## Method\n```\ngit ls-tree 249c77ca0 -- docs   # check: exists\n```\n", { repo })
      assert.deepEqual(statuses(result), ['reproduces'])
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('writes nothing to the repository it reads', async () => {
    const snapshot = () => execFileSync('git', ['status', '--porcelain', '--ignored'], { cwd: repo, env: FIXTURE_GIT_ENV, encoding: 'utf8' })
    const refs = () => execFileSync('git', ['for-each-ref'], { cwd: repo, env: FIXTURE_GIT_ENV, encoding: 'utf8' })
    const before = [snapshot(), refs()]
    await runChecks(fixture('repo-reproduces.md'), { repo })
    await runChecks(fixture('repo-differs.md'), { repo })
    assert.deepEqual([snapshot(), refs()], before)
  })
})

describe('the CLI', () => {
  it('exits 3, not 0, when the body has no checkable line', () => {
    const body = join(scratch, 'free-form.md')
    writeFileSync(body, '## Method\n```bash\ngit log --oneline | head -3   # 3\n```\n')
    const run = cli(['--body-file', body, '--repo', repo])
    assert.equal(run.status, 3)
    assert.match(run.stdout, /no checkable line in the Method block \(1 free-form\)\. Nothing was checked\./)
  })

  it('exits 1 with the report when a line does not reproduce', () => {
    const run = cli(['--body-file', join(FIXTURES, 'repo-false-zero.md'), '--repo', repo])
    assert.equal(run.status, 1)
    assert.match(run.stdout, /unproven zero \(control "reach" returned 0\)/)
  })

  it('exits 2 on a usage error or an unreadable body', () => {
    for (const args of [[], ['--body-file'], ['--body-file', 'a', '--issue', '1'], ['--issue', '1; id'], ['--issue', '-1'], ['--nope']]) {
      const run = cli(args)
      assert.equal(run.status, 2, args.join(' '))
      assert.match(run.stderr, /usage: node scripts\/docs\/issue-method\.mjs/)
    }
    const run = cli(['--body-file', join(scratch, 'no-such-body.md')])
    assert.equal(run.status, 2)
    assert.throws(() => parseArgs(['--issue', '0']), /issue number/)
    assert.equal(parseArgs(['--issue', '4771']).issue, '4771')
  })

  it('exits 2 on a body larger than the limit, before reading it', () => {
    const body = join(scratch, 'huge.md')
    writeFileSync(body, `## Method\n\`\`\`\ngit ls-tree 249c77ca0 -- docs   # check: exists\n\`\`\`\n${'x'.repeat(MAX_BODY_BYTES)}`)
    const run = cli(['--body-file', body, '--repo', repo])
    assert.equal(run.status, 2)
    assert.match(run.stderr, /the body is larger than 1048576 bytes/)
    assert.equal(run.stdout, '')
  })

  it('--issue makes exactly one gh call, a read of the body, and checks what it printed', () => {
    const bin = join(scratch, 'fake-bin')
    mkdirSync(bin)
    const log = join(scratch, 'gh-calls.log')
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\nprintf -- '--\\n' >> '${log}'\ncat '${join(FIXTURES, 'repo-reproduces.md')}'\n`,
    )
    chmodSync(join(bin, 'gh'), 0o755)
    const run = cli(['--issue', '4771', '--repo', repo], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /Summary: 12 checkable — 12 reproduce/)
    assert.equal(readFileSync(log, 'utf8'), ['issue', 'view', '4771', '--json', 'body', '--jq', '.body', '--', ''].join('\n'))
  })

  it('runs when started through a symlink (#4776)', () => {
    const link = join(scratch, 'link.mjs')
    execFileSync('ln', ['-s', SCRIPT, link])
    const run = cli([])
    const linked = spawnSync(process.execPath, [link], { encoding: 'utf8' })
    assert.equal(linked.status, 2)
    assert.equal(linked.stderr, run.stderr)
  })
})

// The two bodies that read this repository's own history. `49747fac3` is the
// commit #4771 was measured at.
describe('against this repository, where its history is present', () => {
  const env = { ...GIT_ENV }
  const probe = (...args) => spawnSync('git', args, { cwd: REPO_ROOT, env, encoding: 'utf8' }).status === 0
  const present =
    probe('rev-parse', '--verify', '--quiet', '49747fac3^{commit}') &&
    (probe('merge-base', '--is-ancestor', '49747fac3', 'refs/remotes/origin/dev') ||
      probe('merge-base', '--is-ancestor', '49747fac3', 'refs/remotes/origin/main'))
  const skip = present ? false : 'commit 49747fac3 or origin/dev is not in this checkout (a depth-1 CI clone); the repo-*.md twins cover it'

  it('reproduces #4771’s claims as transcribed into the runner’s syntax', { skip }, async () => {
    const result = await runChecks(fixture('real-4771.md'), { repo: REPO_ROOT })
    assert.deepEqual(statuses(result), ['reproduces', 'reproduces', 'reproduces', 'reproduces (parent scripts/docs exists)'])
    assert.equal(result.freeForm, 3)
    assert.equal(exitCodeFor(result), 0)
  })

  it('reports the false zero #4757 carried as an unproven zero', { skip }, async () => {
    const result = await runChecks(fixture('real-false-zero.md'), { repo: REPO_ROOT })
    assert.deepEqual(statuses(result), ['differs (got 0)', 'unproven zero (control "reach" returned 0)'])
  })
})
