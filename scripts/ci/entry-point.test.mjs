// The entry test: "was this file run directly, or imported?" (#4776)
//
// Every script here that exports functions for its self-test also carries an
// entry test, so that importing it does not run `main()`. The test has to
// answer one question — is this file the process's entry point — and for a
// long time most copies answered it by comparing `import.meta.url` with
// `process.argv[1]` as typed. Node resolves symlinks for the first and not for
// the second, so through a symlinked path the comparison was false, `main()`
// was skipped, and the process exited 0 with no output: a gate that reports a
// clean pass because it never ran. The `file://${…}` variant was also false
// for any path that needs percent-encoding (a space, a non-ASCII character).
//
// This file holds the three things that keep that from coming back:
//
//   1. a characterization of what the entry test must do on the ordinary
//      paths — run `main()` when invoked, stay silent when imported;
//   2. process-level regressions that drive real scripts through a symlink
//      and from a directory whose own name needs encoding;
//   3. a structural guard over every tracked script, because (2) can only run
//      read-only representatives — many of these scripts write files or call
//      GitHub.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'))

// Variables a parent process may carry that would change what the children
// print or write. `npm_config_*`: a suite started as `npm test --all` must not
// hand `--all` to the preflight child. The GitHub ones: `coupling-gate.mjs`
// appends to `GITHUB_OUTPUT`, and `qa-freshness.mjs` reaches the network once
// `GITHUB_REPOSITORY` and `SOURCE_BRANCH` are both set.
const DROPPED_ENV = [
  'npm_config_all',
  'npm_config_list',
  'npm_config_static',
  'npm_config_base',
  'npm_config_verify_ruleset',
  'GITHUB_OUTPUT',
  'GITHUB_STEP_SUMMARY',
  'GITHUB_REPOSITORY',
  'SOURCE_BRANCH',
  'BASE_SHA',
  'HEAD_SHA',
]

function childEnv() {
  const env = { ...process.env }
  for (const name of DROPPED_ENV) delete env[name]
  return env
}

const urlOf = (script) => pathToFileURL(path.join(REPO, script)).href

/** Run `node <args…>` in `cwd` and return its exit status and combined output. */
function runNode(args, cwd = REPO) {
  const child = spawnSync(process.execPath, args, { cwd, env: childEnv(), encoding: 'utf8' })
  return { status: child.status, out: `${child.stdout ?? ''}${child.stderr ?? ''}` }
}

// One read-only script per way the entry test used to be written, with the
// arguments that keep it read-only and a line only its `main()` prints.
// `control: true` marks the four files on the money-path control globs: their
// behaviour is pinned here before the entry line changes (money.md §2).
const REPRESENTATIVES = [
  {
    script: 'scripts/docs/validate-frontmatter.mjs',
    was: 'A',
    control: true,
    args: [],
    status: 0,
    ran: /Front-matter valid across \d+ docs/,
  },
  {
    script: 'scripts/docs/coupling-gate.mjs',
    was: 'A',
    control: true,
    args: ['--changed=LICENSE', '--out=/dev/null'],
    status: 0,
    ran: /Coupling gate: no covered docs implicated/,
  },
  {
    script: 'scripts/ci/money-path-restatement-scan.mjs',
    was: 'C',
    control: true,
    args: [],
    status: 0,
    ran: /money-path restatement scan/,
  },
  {
    // With the two variables dropped, main() refuses before any query.
    script: 'scripts/ci/qa-freshness.mjs',
    was: 'C',
    control: true,
    args: [],
    status: 1,
    ran: /GITHUB_REPOSITORY and SOURCE_BRANCH are required/,
  },
  {
    // `--all`: a plain `--list` diffs against origin/dev, which a shallow CI
    // checkout does not have.
    script: 'scripts/ci/preflight.mjs',
    was: 'B',
    args: ['--all', '--list'],
    status: 0,
    ran: /preflight: \d+ gate\(s\) known, \d+ selected/,
  },
  {
    script: 'scripts/docs/validate-agent-skills.mjs',
    was: 'D',
    args: [],
    status: 0,
    ran: /Agent skill validation passed/,
  },
  {
    script: 'scripts/ci/review-isolation.mjs',
    was: 'F',
    args: [],
    status: 2,
    ran: /a review root path is required/,
  },
  {
    script: 'scripts/ci/claim-collision.mjs',
    was: 'E',
    args: [],
    status: 2,
    ran: /usage: claim-collision\.mjs/,
  },
]

describe('the entry test on the ordinary paths (#4776)', () => {
  for (const rep of REPRESENTATIVES) {
    test(`${rep.script} runs main() when invoked by a relative path`, () => {
      const { status, out } = runNode([rep.script, ...rep.args])
      assert.match(out, rep.ran, `main() did not run; output was ${JSON.stringify(out.slice(0, 200))}`)
      assert.equal(status, rep.status)
    })

    test(`${rep.script} does not run main() when another file imports it`, () => {
      // The way a self-test or a build config loads it: `process.argv[1]` is
      // a real file, just not this one.
      const dir = mkdtempSync(path.join(tmpdir(), 'entry-point-'))
      try {
        const importer = path.join(dir, 'importer.mjs')
        writeFileSync(importer, `await import(${JSON.stringify(urlOf(rep.script))})\n`)
        const { status, out } = runNode([importer])
        assert.equal(out, '', 'an import must print nothing')
        assert.equal(status, 0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  // `node -e <code> <arg>` puts <arg> in `process.argv[1]`, which makes it the
  // way to hand the entry test an input no real invocation produces.
  const CONTROL_GATE = 'scripts/docs/coupling-gate.mjs'
  const importInline = (...argv) =>
    runNode(['--input-type=module', '-e', `await import(${JSON.stringify(urlOf(CONTROL_GATE))})`, ...argv])

  test('an argv[1] that does not resolve is "not the entry point", without a throw', () => {
    const { status, out } = importInline(path.join(REPO, 'no', 'such', 'file.mjs'))
    assert.equal(out, '')
    assert.equal(status, 0)
  })

  test('no argv[1] at all is "not the entry point", without a throw', () => {
    const { status, out } = importInline()
    assert.equal(out, '')
    assert.equal(status, 0)
  })
})

describe('through a symlink, every representative still runs main() (#4776)', () => {
  // The test makes its own symlink, so it does not depend on the machine's
  // temp directory being one (macOS) or not (the Linux runners).
  for (const rep of REPRESENTATIVES) {
    test(`${rep.script} (was form ${rep.was})`, () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'entry-point-'))
      try {
        const link = path.join(dir, 'repo')
        symlinkSync(REPO, link, 'dir')
        const viaLink = path.join(link, rep.script)
        assert.notEqual(realpathSync(viaLink), viaLink, 'the fixture path must go through a symlink')
        const { status, out } = runNode([viaLink, ...rep.args])
        assert.match(
          out,
          rep.ran,
          `main() did not run through the symlink (exit ${status}); output was ${JSON.stringify(out.slice(0, 200))}`,
        )
        assert.equal(status, rep.status)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})

describe('from a directory whose real path needs percent-encoding (#4776)', () => {
  // The symlink case cannot prove this one: the repository's own path has no
  // space in it. So a script is copied to a directory that has one, and a
  // non-ASCII letter, in its RESOLVED path. `db-concurrency-proof.mjs` imports
  // nothing of ours and prints its usage when given no report, which makes it
  // a self-contained witness. It compared `import.meta.url` with
  // `file://${argv[1]}` before, the form that failed here even by relative path.
  const SCRIPT = 'scripts/ci/db-concurrency-proof.mjs'

  function withCopy(fn) {
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'entry-point-')))
    const root = path.join(base, 'entry point é')
    try {
      mkdirSync(path.join(root, path.dirname(SCRIPT)), { recursive: true })
      cpSync(path.join(REPO, SCRIPT), path.join(root, SCRIPT))
      assert.equal(realpathSync(root), root, 'the fixture root must already be a resolved path')
      assert.notEqual(pathToFileURL(root).pathname, root, 'the fixture root must need percent-encoding')
      fn(root)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }

  test('by a relative path', () => {
    withCopy((root) => {
      const { status, out } = runNode([SCRIPT], root)
      assert.match(out, /usage: db-concurrency-proof\.mjs/, `main() did not run; output was ${JSON.stringify(out)}`)
      assert.equal(status, 2)
    })
  })

  test('by an absolute path', () => {
    withCopy((root) => {
      const { status, out } = runNode([path.join(root, SCRIPT)], REPO)
      assert.match(out, /usage: db-concurrency-proof\.mjs/, `main() did not run; output was ${JSON.stringify(out)}`)
      assert.equal(status, 2)
    })
  })
})

// ---------------------------------------------------------------------------
// The structural guard
// ---------------------------------------------------------------------------

// The only two things a script may do with `argv[1]`: hand it to
// `realpathSync`, or ask whether it is there at all.
const ALLOWED_ARGV1_USES = [
  /realpathSync\(\s*process\.argv\[1\]\s*\)/g,
  /!process\.argv\[1\]/g,
  /Boolean\(\s*process\.argv\[1\]\s*\)/g,
  /process\.argv\[1\]\s*&&/g,
]
const ARGV1 = /argv\s*\[\s*1\s*\]|argv\.at\(\s*1\s*\)/

/**
 * Lines of `source` that read `argv[1]` in any way other than the allowed two.
 *
 * Whole-line comments are skipped. A trailing comment is not stripped: the
 * old `file://${…}` form contains `//`, and stripping from there would hide
 * the very line this exists to find.
 *
 * Known limit: an entry test built from a destructured or aliased
 * `process.argv` is not seen.
 */
function entryTestViolations(source) {
  const violations = []
  source.split('\n').forEach((text, index) => {
    const trimmed = text.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    let rest = text
    for (const allowed of ALLOWED_ARGV1_USES) rest = rest.replace(allowed, '')
    if (ARGV1.test(rest)) violations.push({ line: index + 1, text: trimmed })
  })
  return violations
}

/** Every tracked script the guard covers: not a test, not package source. */
function trackedScripts() {
  return execFileSync('git', ['ls-files', '-z', '--', '*.mjs', '*.js', '*.cjs', '*.ts'], {
    cwd: REPO,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .filter((file) => !/\.test\./.test(file))
    .filter((file) => !/^packages\/[^/]+\/src\//.test(file))
}

const CANONICAL = `function isEntryPoint() {
  if (!process.argv[1]) return false
  try {
    const { realpathSync } = process.getBuiltinModule('node:fs')
    const { fileURLToPath } = process.getBuiltinModule('node:url')
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}
if (isEntryPoint()) main()`

// Each retired form, as one line of code.
const RETIRED_FORMS = {
  A: 'if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()',
  'A, operands swapped': 'if (process.argv[1] === fileURLToPath(import.meta.url)) main()',
  B: 'if (import.meta.url === `file://${process.argv[1]}`) main()',
  C: 'if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()',
  D: 'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()',
  F: "if (process.argv[1] && process.argv[1].endsWith('gate.mjs')) main()",
  'argv.at(1)': 'if (import.meta.url === pathToFileURL(process.argv.at(1)).href) main()',
}

describe('the structural guard: no script compares argv[1] unresolved (#4776)', () => {
  for (const [form, line] of Object.entries(RETIRED_FORMS)) {
    test(`form ${form} is flagged`, () => {
      assert.deepEqual(entryTestViolations(`const x = 1\n${line}\n`), [{ line: 2, text: line }])
    })
  }

  test('the canonical form is not flagged', () => {
    assert.deepEqual(entryTestViolations(CANONICAL), [])
  })

  test('the realpath variant that compares URLs is not flagged', () => {
    const line =
      'isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href'
    assert.deepEqual(entryTestViolations(line), [])
  })

  test('a comment that quotes a retired form is skipped; the same text as code is not', () => {
    const quoted = RETIRED_FORMS.B
    assert.deepEqual(entryTestViolations(`// ${quoted}\n * ${quoted}\n/* ${quoted} */\n`), [])
    assert.equal(entryTestViolations(`  ${quoted}\n`).length, 1)
  })

  test('no tracked script outside packages/*/src reads argv[1] any other way', () => {
    const scripts = trackedScripts()
    const failures = []
    let withEntryTest = 0
    for (const file of scripts) {
      const source = readFileSync(path.join(REPO, file), 'utf8')
      if (/realpathSync\(\s*process\.argv\[1\]\s*\)/.test(source)) withEntryTest += 1
      for (const v of entryTestViolations(source)) failures.push(`${file}:${v.line}: ${v.text}`)
    }
    // The scan must have read the scripts it is about before its silence
    // counts: 71 carried an entry test when this guard was written.
    assert.ok(withEntryTest >= 60, `only ${withEntryTest} of ${scripts.length} scanned files carry the entry test`)
    assert.deepEqual(
      failures,
      [],
      'resolve process.argv[1] with realpathSync before comparing it (see isEntryPoint in any script)',
    )
  })
})
