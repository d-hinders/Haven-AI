// The entry test: "was this file run directly, or imported?" (#4776)
//
// Every script here that exports functions for its self-test also carries an
// entry test, so that importing it does not run `main()`. The test has to
// answer one question — is this file the process's entry point — and for a
// long time most copies answered it by comparing `import.meta.url` with
// `process.argv[1]` unresolved. Node resolves symlinks for the first and not
// for the second, so through a symlinked path the comparison was false, `main()`
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

// Each `ran` line is what the script prints on its ordinary outcome, so a
// representative also goes red when its own gate does (a real front-matter
// error, say). The message names both readings; an empty output is the one
// that means main() never ran.
const notRun = (rep, status, out) =>
  out === ''
    ? `${rep.script}: main() did not run — exit ${status}, no output`
    : `${rep.script}: main() ran but did not print its usual line (exit ${status}): ${JSON.stringify(out.slice(0, 200))}`

describe('the entry test on the ordinary paths (#4776)', () => {
  for (const rep of REPRESENTATIVES) {
    test(`${rep.script} runs main() when invoked by a relative path`, () => {
      const { status, out } = runNode([rep.script, ...rep.args])
      assert.match(out, rep.ran, notRun(rep, status, out))
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
        assert.match(out, rep.ran, notRun(rep, status, out))
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

// The two lines of the one entry test. A code line that reads
// `process.argv[1]` must BE one of them, whole — not merely contain an allowed
// fragment. Handing `argv[1]` to `realpathSync` is not enough on its own:
// `file://${realpathSync(process.argv[1])}` is symlink-safe and still false
// from any path that needs percent-encoding.
const ALLOWED_LINES = new Set([
  'if (!process.argv[1]) return false',
  'return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))',
])

// Every spelling of "element 1 of process.argv" that is one expression.
const ARGV1 =
  /process\s*\.\s*argv\s*(?:\[\s*['"`]?1['"`]?\s*\]|\.\s*at\s*\(\s*1\s*\)|\.\s*slice\s*\(\s*1\s*\)\s*\[\s*0\s*\])/

/**
 * The code of `source`, line by line, with leading comments removed.
 *
 * Only a comment that STARTS a line (or follows another comment on it) is
 * removed: `// …` to the end of the line, `/* … *\/` across lines. Once code
 * has begun on a line the rest of the line is code. That keeps the two ways a
 * careless strip would hide a violation out of reach: the retired
 * `file://${…}` form contains `//`, and globs such as `packages/*\/src` look
 * like comment delimiters. The cost is in the safe direction: a comment body
 * that itself contains a comment terminator ends the comment early, and what
 * follows is read as code.
 */
function codeLines(source) {
  const lines = []
  let inBlock = false
  source.split('\n').forEach((text, index) => {
    let rest = text
    for (;;) {
      if (inBlock) {
        const end = rest.indexOf('*/')
        if (end === -1) return
        rest = rest.slice(end + 2)
        inBlock = false
        continue
      }
      const trimmed = rest.trimStart()
      if (trimmed.startsWith('//')) return
      if (trimmed.startsWith('/*')) {
        rest = trimmed.slice(2)
        inBlock = true
        continue
      }
      break
    }
    if (rest.trim() !== '') lines.push({ line: index + 1, code: rest.trim() })
  })
  return lines
}

/**
 * Code lines of `source` that read `process.argv[1]` and are not one of the
 * two allowed lines.
 *
 * Known limits: an alias or a destructuring of `process.argv` is not seen
 * (`const [, entry] = process.argv`), and an allowed line that a formatter has
 * wrapped is refused until it is put back on one line.
 */
function entryTestViolations(source) {
  return codeLines(source)
    .filter(({ code }) => ARGV1.test(code) && !ALLOWED_LINES.has(code.replace(/;$/, '')))
    .map(({ line, code }) => ({ line, text: code }))
}

/** Every tracked script the guard covers: not a test, not package source. */
function trackedScripts() {
  return execFileSync('git', ['ls-files', '-z', '--', '*.mjs', '*.js', '*.cjs', '*.ts', '*.mts', '*.cts'], {
    cwd: REPO,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .filter((file) => !/\.test\./.test(file))
    .filter((file) => !/^packages\/[^/]+\/src\//.test(file))
}

// One script from each place they live. Each must be in the scan and must
// carry both allowed lines, which is what shows the scan read the entry tests
// it is about. A count would not: dropping every `packages/*/scripts` file
// still leaves more than sixty.
const SENTINELS = [
  'scripts/release-scope.mjs',
  'scripts/ci/preflight.mjs',
  'scripts/docs/coupling-gate.mjs',
  'packages/frontend/scripts/design-lint.mjs',
  'packages/cli/scripts/sync-agent-guidance.mjs',
]

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

const FORM_B = 'if (import.meta.url === `file://${process.argv[1]}`) main()'

// One line of code each. The first seven are the forms #4776 retired; the
// rest are the nearest ways to keep an unresolved read past a looser guard.
const REFUSED = {
  'form A': 'if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()',
  'form A, operands swapped': 'if (process.argv[1] === fileURLToPath(import.meta.url)) main()',
  'form B': FORM_B,
  'form C': 'if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()',
  'form D': 'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()',
  'form F': "if (process.argv[1] && process.argv[1].endsWith('gate.mjs')) main()",
  'argv.at(1)': 'if (import.meta.url === pathToFileURL(process.argv.at(1)).href) main()',
  'a resolved path compared as a file:// URL': 'return import.meta.url === `file://${realpathSync(process.argv[1])}`',
  'a resolved path compared as a URL': 'return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href',
  'a method call behind the presence check': "if (!process.argv[1].endsWith('gate.mjs')) return false",
  'a presence check with more on the line': 'if (!process.argv[1] || other) return false',
  'a string index': "if (import.meta.url === pathToFileURL(process.argv['1']).href) main()",
  'spaced out': 'if (import.meta.url === pathToFileURL(process . argv .at( 1 )).href) main()',
  'slice(1)[0]': 'if (import.meta.url === pathToFileURL(process.argv.slice(1)[0]).href) main()',
}

describe('the structural guard: argv[1] is read only by the one entry test (#4776)', () => {
  for (const [name, line] of Object.entries(REFUSED)) {
    test(`refused: ${name}`, () => {
      assert.deepEqual(entryTestViolations(`const x = 1\n${line}\n`), [{ line: 2, text: line }])
    })
  }

  test('allowed: the canonical form', () => {
    assert.deepEqual(entryTestViolations(CANONICAL), [])
  })

  test('allowed: the canonical form with semicolons', () => {
    assert.deepEqual(entryTestViolations(CANONICAL.replace(/(false|\)\)|'\))$/gm, '$1;')), [])
  })

  test('allowed: other elements of process.argv, and index 1 of a local array', () => {
    const source = [
      'const args = process.argv.slice(2)',
      'const command = process.argv[2]',
      'const argv = parse(args)',
      'const second = argv[1]',
    ].join('\n')
    assert.deepEqual(entryTestViolations(source), [])
  })

  test('a comment that quotes a retired form is skipped', () => {
    const source = [`// ${FORM_B}`, `/* ${FORM_B} */`, '/**', ` * ${FORM_B}`, ' */', '/*', FORM_B, '*/'].join('\n')
    assert.deepEqual(entryTestViolations(source), [])
  })

  test('code after a comment on the same line is not skipped', () => {
    assert.deepEqual(entryTestViolations(`/* entry */ ${FORM_B}`), [{ line: 1, text: FORM_B }])
    assert.deepEqual(entryTestViolations(`/*\n a note\n*/ ${FORM_B}`), [{ line: 3, text: FORM_B }])
    assert.deepEqual(entryTestViolations(`/* a */ /* b */ ${FORM_B}`), [{ line: 1, text: FORM_B }])
  })

  test('a code line that only looks like a comment body is not skipped', () => {
    const continued = '* (process.argv[1] === self ? 1 : 0)'
    assert.deepEqual(entryTestViolations(`const weight = 2\n  ${continued}`), [{ line: 2, text: continued }])
  })

  test('a trailing comment does not hide the code before it', () => {
    const line = `${FORM_B} // entry`
    assert.deepEqual(entryTestViolations(line), [{ line: 1, text: line }])
  })

  test('no tracked script outside packages/*/src reads argv[1] any other way', () => {
    const scripts = trackedScripts()
    const failures = []
    for (const file of scripts) {
      const source = readFileSync(path.join(REPO, file), 'utf8')
      for (const v of entryTestViolations(source)) failures.push(`${file}:${v.line}: ${v.text}`)
    }
    assert.deepEqual(
      failures,
      [],
      'process.argv[1] may only be read by the entry test: copy isEntryPoint() from any script, unchanged',
    )
  })

  test('the scan reads the scripts it is about, in every place they live', () => {
    const scripts = new Set(trackedScripts())
    for (const file of SENTINELS) {
      assert.ok(scripts.has(file), `${file} is not in the scan`)
      const code = new Set(codeLines(readFileSync(path.join(REPO, file), 'utf8')).map((l) => l.code))
      for (const line of ALLOWED_LINES) assert.ok(code.has(line), `${file} does not carry: ${line}`)
    }
    assert.ok(
      [...scripts].every((file) => !/^packages\/[^/]+\/src\//.test(file)),
      'package source is outside this guard (#4776, Not in scope)',
    )
  })
})
