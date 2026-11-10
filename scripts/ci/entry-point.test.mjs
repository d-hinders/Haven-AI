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
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
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

    test(`${rep.script} does not run main() when it is imported`, () => {
      // The specifier goes into the source, never onto the command line: an
      // argument after `-e` becomes `process.argv[1]`, which is the one input
      // the entry test reads.
      const url = pathToFileURL(path.join(REPO, rep.script)).href
      const { status, out } = runNode(['--input-type=module', '-e', `await import(${JSON.stringify(url)})`])
      assert.equal(out, '', 'an import must print nothing')
      assert.equal(status, 0)
    })
  }
})
