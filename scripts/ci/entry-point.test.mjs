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
//
// Since #4786 the guard also reads package source (`packages/*/src`), and one
// tool there answers the question differently: the operator command
// `cancel-stuck-lane` has no entry test at all. Its entry file always starts,
// its code lives in a module beside it, and (4) a check here fails on any
// import of the entry file, because importing it would run the command.
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
  {
    // The one script a workflow starts by an absolute path
    // (agent-evals.yml). With no files to read it reports a missing result.
    script: 'scripts/ci/agent-evals-login-check.mjs',
    was: 'E',
    args: [],
    status: 1,
    ran: /claude printed no result/,
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

// "Element 1 of process.argv", in the spellings a person would reach for:
// `[1]`, `['1']`, `.at(1)`, `.slice(1)[0]`, each with or without optional
// chaining or spaces, on `process.argv` or `process['argv']`.
//
// Not seen, by fixture: a computed index (`[+1]`, `[0x1]`), `.slice(1, 2)[0]`,
// a read split over two lines, and any alias or destructuring of
// `process.argv`. The matcher narrows the search; it is not a parser.
const PROCESS_ARGV = String.raw`process\s*(?:\?\.|\.)\s*argv|process\s*(?:\?\.)?\s*\[\s*['"\`]argv['"\`]\s*\]`
const ELEMENT_1 = [
  String.raw`(?:\?\.)?\s*\[\s*['"\`]?1['"\`]?\s*\]`,
  String.raw`(?:\?\.|\.)\s*at\s*(?:\?\.)?\s*\(\s*1\s*\)`,
  String.raw`(?:\?\.|\.)\s*slice\s*\(\s*1\s*\)\s*(?:\?\.)?\s*\[\s*0\s*\]`,
].join('|')
const ARGV1 = new RegExp(`(?:${PROCESS_ARGV})\\s*(?:${ELEMENT_1})`)

// The one read of `process.argv[1]` outside the entry test, allowed in one
// file only, as this exact line (#4786). `packages/connect/src/cli.ts` is a
// published bin whose `isCliEntrypoint(argvPath = process.argv[1], …)` already
// resolves both sides. The exception pins the READ: the line is a default
// parameter, and this guard does not follow where the value goes. What holds
// the comparison is that package's own test of `isCliEntrypoint`.
const FILE_EXCEPTIONS = {
  'packages/connect/src/cli.ts': 'argvPath: string | undefined = process.argv[1],',
}

/**
 * The code of `source`, line by line, with leading comments removed.
 *
 * Only a comment that STARTS a line (or follows another comment on it) is
 * removed: `// …` to the end of the line, `/* … *\/` across lines. Once code
 * has begun on a line the rest of the line is code. That keeps the two ways a
 * careless strip would hide a violation out of reach: the retired
 * `file://${…}` form contains `//`, and globs such as `packages/*\/src` look
 * like comment delimiters. One cost is in the safe direction: a comment body
 * that itself contains a comment terminator ends the comment early, and what
 * follows is read as code. One is not, and is a stated limit: this is not a
 * parser, so a line INSIDE a multi-line template literal that starts with a
 * block-comment opener is taken for a comment, and code after it is skipped
 * until the next terminator. No scanned file has such a line today.
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
function entryTestViolations(source, file = '') {
  return codeLines(source)
    .filter(({ code }) => ARGV1.test(code) && !ALLOWED_LINES.has(code.replace(/;$/, '')))
    .filter(({ code }) => FILE_EXCEPTIONS[file] !== code)
    .map(({ line, code }) => ({ line, text: code }))
}

/** Every tracked script and source file the guard covers: all but tests. */
function trackedScripts() {
  return execFileSync('git', ['ls-files', '-z', '--', '*.mjs', '*.js', '*.cjs', '*.ts', '*.mts', '*.cts'], {
    cwd: REPO,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .filter((file) => !/\.test\./.test(file))
}

// One script from each place they live. Each must be in the scan and must
// carry both allowed lines, which is what shows the scan read the entry tests
// it is about. A count would not: dropping every `packages/*/scripts` file
// still leaves more than sixty. `test-local.mjs` is here for its name: it is
// a script, not a test, and an exclusion wider than `*.test.*` would drop it.
const SENTINELS = [
  'scripts/release-scope.mjs',
  'scripts/ci/preflight.mjs',
  'scripts/docs/coupling-gate.mjs',
  'packages/frontend/scripts/design-lint.mjs',
  'packages/frontend/scripts/test-local.mjs',
  'packages/cli/scripts/sync-agent-guidance.mjs',
  // Package source, in the scan since #4786. Dropping `packages/*/src` from
  // the scan again loses this one.
  'packages/qa-agent/src/seed.ts',
]

// A TypeScript script, which carries no entry test today. It only has to be
// in the scan, so that dropping `*.ts` from the pathspec is noticed.
const TS_IN_SCAN = 'packages/backend/scripts/check-bundler.ts'

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
  'optional chaining': 'if (import.meta.url === pathToFileURL(process.argv?.[1]).href) main()',
  'optional call': 'if (import.meta.url === pathToFileURL(process.argv.at?.(1)).href) main()',
  "process['argv']": "if (import.meta.url === pathToFileURL(process['argv'][1]).href) main()",
  'an allowed line with more code after it':
    "return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) || process.argv[1].endsWith('gate.mjs')",
  'an allowed line with more code before it':
    'if (always) return true; if (!process.argv[1]) return false',
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

  test('known limits: these reads are not seen', () => {
    // Pinned so the comment above ARGV1 stays true. Each is a reason the
    // process-level tests exist beside this guard, not a licence to use one.
    for (const line of [
      'if (self === process.argv[+1]) main()',
      'if (self === process.argv[0x1]) main()',
      'if (self === process.argv.slice(1, 2)[0]) main()',
      'const [, entry] = process.argv',
      'if (self === process.argv[\n  1\n]) main()',
    ]) {
      assert.deepEqual(entryTestViolations(line), [], line)
    }
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

  test('the one exception is one line in one file (#4786)', () => {
    const [[file, line]] = Object.entries(FILE_EXCEPTIONS)
    assert.equal(Object.keys(FILE_EXCEPTIONS).length, 1)
    const source = `export function isCliEntrypoint(\n  ${line}\n) {}\n`
    assert.deepEqual(entryTestViolations(source, file), [])
    // The same line anywhere else is an ordinary violation.
    assert.deepEqual(entryTestViolations(source, 'packages/cli/src/cli.ts'), [{ line: 2, text: line }])
    assert.deepEqual(entryTestViolations(source), [{ line: 2, text: line }])
    // And the excepted file gets no other read of argv[1] for free.
    assert.deepEqual(entryTestViolations(`${source}${FORM_B}\n`, file), [{ line: 4, text: FORM_B }])
    const other = 'argvPath = process.argv[1],'
    assert.deepEqual(entryTestViolations(`f(\n  ${other}\n)\n`, file), [{ line: 2, text: other }])
    // The exception names a line that exists: a stale entry would allow
    // nothing and look like a rule.
    const code = codeLines(readFileSync(path.join(REPO, file), 'utf8')).map((l) => l.code)
    assert.ok(code.includes(line), `${file} no longer carries: ${line}`)
  })

  test('no tracked script or package source file reads argv[1] any other way', () => {
    const scripts = trackedScripts()
    const failures = []
    for (const file of scripts) {
      const source = readFileSync(path.join(REPO, file), 'utf8')
      for (const v of entryTestViolations(source, file)) failures.push(`${file}:${v.line}: ${v.text}`)
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
    assert.ok(scripts.has(TS_IN_SCAN), `${TS_IN_SCAN} is not in the scan`)
  })
})

// ---------------------------------------------------------------------------
// The operator tool's entry file is never imported (#4786)
// ---------------------------------------------------------------------------

// `packages/backend/src/ops/cancel-stuck-lane.ts` starts the command
// unconditionally, so an import of it runs the command. Its code is in the
// module beside it; that is what a test or a wrapper imports.
//
// The name is assembled so that this file's own fixtures are not what the
// scan finds.
const ENTRY_FILE = ['cancel', 'stuck', 'lane'].join('-')
const IMPORT_OF_ENTRY = new RegExp(
  String.raw`(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"\`])(?:[^'"\`\n]*\/)?` +
    ENTRY_FILE +
    String.raw`(?:\.[cm]?[jt]s)?\1`,
)

/** Lines of `source` that import the operator tool's entry file. */
function entryFileImports(source) {
  return source
    .split('\n')
    .map((text, index) => ({ line: index + 1, text: text.trim() }))
    .filter(({ text }) => IMPORT_OF_ENTRY.test(text))
}

describe('nothing imports the operator tool entry file (#4786)', () => {
  const refused = [
    `import './${ENTRY_FILE}.js'`,
    `import { runCli } from './${ENTRY_FILE}.js'`,
    `import { runCli } from '../src/ops/${ENTRY_FILE}.js'`,
    `import { runCli } from "../src/ops/${ENTRY_FILE}"`,
    `const { runCli } = await import('../ops/${ENTRY_FILE}.js')`,
    `const tool = require('./ops/${ENTRY_FILE}')`,
    `export { runCli } from './${ENTRY_FILE}.ts'`,
  ]
  for (const line of refused) {
    test(`refused: ${line}`, () => {
      assert.deepEqual(entryFileImports(`const x = 1\n${line}\n`), [{ line: 2, text: line }])
    })
  }

  test('allowed: the module beside it, and the built path in prose and commands', () => {
    const source = [
      "import { runCli } from './lane-cancel-command.js'",
      `// node packages/backend/dist/ops/${ENTRY_FILE}.js <outbound-row-id>`,
      `"ops:${ENTRY_FILE}:built": "node dist/ops/${ENTRY_FILE}.js",`,
      `const USAGE = 'node packages/backend/dist/ops/${ENTRY_FILE}.js <row id>'`,
      `runNode(['ops/${ENTRY_FILE}.js'], cwd)`,
      `import { x } from './${ENTRY_FILE}-other.js'`,
    ].join('\n')
    assert.deepEqual(entryFileImports(source), [])
  })

  test('no tracked code file imports it, tests included', () => {
    const files = execFileSync(
      'git',
      ['ls-files', '-z', '--', '*.ts', '*.mts', '*.cts', '*.tsx', '*.js', '*.mjs', '*.cjs', '*.jsx'],
      { cwd: REPO, encoding: 'utf8' },
    )
      .split('\0')
      .filter(Boolean)
    // The scan read the two files that matter: the entry file exists, and the
    // wrapper that used to import it is among the files read.
    assert.ok(files.includes(`packages/backend/src/ops/${ENTRY_FILE}.ts`), 'the entry file is not tracked')
    assert.ok(files.includes('packages/backend/scripts/cancel-stuck-attest-lane.ts'), 'the wrapper is not in the scan')
    const failures = []
    for (const file of files) {
      const source = readFileSync(path.join(REPO, file), 'utf8')
      for (const hit of entryFileImports(source)) failures.push(`${file}:${hit.line}: ${hit.text}`)
    }
    assert.deepEqual(
      failures,
      [],
      'the entry file starts the command on import: import packages/backend/src/ops/lane-cancel-command.js instead',
    )
  })
})
