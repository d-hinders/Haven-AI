// Tests for the root-guard ownership manifest (#1624, epic #1621).
//
// The manifest claims that certain jobs OWN certain guard files. The point of
// this file is that the claim is checked rather than asserted: a manifest that
// names the wrong job reads exactly like one that names the right job, and the
// failure it causes — a guard that never runs on the PR weakening it — is
// silent by construction. That is the #1206/#1030 shape the epic exists to
// remove, so it must not be reintroduced one abstraction layer up.
//
// Four things are verified here that the routing tests cannot see:
//   1. every guard file the manifest names actually exists;
//   2. every job it names actually runs the guard, per ci.yml;
//   3. every npm script it names actually exists;
//   4. every entry is exercised by a routing-matrix row.
//
// Run with: node --test scripts/ci/root-guard-ownership.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs`)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT_GUARDS, ROOT_GUARD_RULES, OUTPUT_NAMES, globToRegExp } from './change-classifier.mjs'
import { ROUTING_MATRIX } from './routing-matrix.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8')
const workflow = read('.github/workflows/ci.yml')
const packageJson = JSON.parse(read('package.json'))

/**
 * Slice one job's block out of ci.yml.
 *
 * Targeted reader rather than a YAML dependency, matching the convention in
 * money-path.test.mjs: jobs are keys at exactly two spaces of indent, so the
 * block runs to the next such key. If that shape ever changes this returns
 * nothing and the assertions below fail loudly rather than passing vacuously.
 */
function jobBlock(jobKey) {
  const lines = workflow.split('\n')
  const start = lines.findIndex((l) => l === `  ${jobKey}:`)
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^  [a-z_]+:$/.test(l))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

/** The ci.yml job key for an output flag — `backend` -> `backend_checks`. */
const jobKeyFor = (flag) => `${flag}_checks`

/**
 * The flags that name a real per-surface job, i.e. the ones that can own a
 * guard. `code` and `full` are routing flags, not jobs.
 */
const OWNING_FLAGS = OUTPUT_NAMES.filter((flag) => flag !== 'code' && flag !== 'full')

describe('the manifest is well-formed', () => {
  test('it is not empty', () => {
    assert.ok(ROOT_GUARDS.length >= 10, `expected the full guard list, saw ${ROOT_GUARDS.length}`)
  })

  test('every path is exact — no glob metacharacters', () => {
    // The epic asks for exact paths before glob semantics, and this is where a
    // too-clever glob does the most damage: `scripts/*.mjs` would silently
    // claim every future script in that directory for whichever job it names.
    for (const guard of ROOT_GUARDS) {
      for (const ch of ['*', '?', '[', ']']) {
        assert.ok(
          !guard.path.includes(ch),
          `${guard.path} contains "${ch}" — the manifest takes exact paths. Add a line per file.`,
        )
      }
      assert.ok(!guard.path.startsWith('/'), `${guard.path} must be repo-root-relative`)
      assert.ok(!guard.path.includes('\\'), `${guard.path} must use forward slashes`)
    }
  })

  test('no duplicate paths', () => {
    const paths = ROOT_GUARDS.map((g) => g.path)
    assert.equal(new Set(paths).size, paths.length, 'a path is claimed twice')
  })

  test('every job named is a real output flag, and not a pseudo-flag', () => {
    for (const guard of ROOT_GUARDS) {
      assert.ok(guard.jobs.length > 0, `${guard.path} names no owning job`)
      for (const job of guard.jobs) {
        assert.ok(OUTPUT_NAMES.includes(job), `${guard.path} names unknown job "${job}"`)
        // `code` is set for every rule and `full` means "run everything" —
        // neither is an owner, and allowing them here would let a manifest
        // entry quietly force the full matrix.
        assert.ok(
          job !== 'code' && job !== 'full',
          `${guard.path} names "${job}", which is a routing flag rather than an owning job`,
        )
      }
      assert.equal(new Set(guard.jobs).size, guard.jobs.length, `${guard.path} repeats a job`)
    }
  })

  test('every entry gives a substantive reason', () => {
    for (const guard of ROOT_GUARDS) {
      assert.ok(
        typeof guard.reason === 'string' && guard.reason.length >= 40,
        `${guard.path} needs a real reason, got: ${JSON.stringify(guard.reason)}`,
      )
    }
  })
})

describe('the manifest describes reality', () => {
  test('every guard file exists', () => {
    // A manifest entry for a deleted or renamed file is a rule that covers
    // nothing, and it looks identical to one that works.
    const missing = ROOT_GUARDS.map((g) => g.path).filter((p) => !existsSync(path.join(ROOT, p)))
    assert.deepEqual(missing, [], 'the manifest names files that do not exist')
  })

  test('every runsVia names a real npm script', () => {
    for (const guard of ROOT_GUARDS) {
      assert.ok(guard.runsVia?.length > 0, `${guard.path} names no runsVia command`)
      for (const script of guard.runsVia) {
        assert.ok(
          script in packageJson.scripts,
          `${guard.path} claims to run via "${script}", which is not a script in package.json`,
        )
      }
    }
  })

  test('every owning job actually runs the guard', () => {
    // THE test in this file. Ownership is a claim about ci.yml, so it is
    // checked against ci.yml. Without this, moving a guard from one job to
    // another and forgetting the manifest leaves the classifier routing the
    // PR to a job that no longer runs it — green, and covering nothing.
    for (const guard of ROOT_GUARDS) {
      for (const job of guard.jobs) {
        const key = jobKeyFor(job)
        const block = jobBlock(key)
        assert.ok(block, `ci.yml has no job "${key}" for the "${job}" flag`)
        const runs = guard.runsVia.filter((script) => block.includes(`npm run ${script}`))
        assert.ok(
          runs.length > 0,
          `${guard.path} names "${job}" as an owner, but ci.yml's ${key} runs none of ` +
            `${JSON.stringify(guard.runsVia)}. Either the manifest is stale or the guard ` +
            'moved jobs — routing a PR to a job that does not run the guard covers nothing.',
        )
      }
    }
  })

  test('every owning-job flag has a job in ci.yml under the expected key', () => {
    // jobKeyFor is a naming CONVENTION (`backend` -> `backend_checks`), and the
    // reverse-direction test below can only see a job whose key it can predict.
    // Asserting the convention here means renaming a job breaks loudly instead
    // of quietly shrinking what that test covers.
    for (const flag of OWNING_FLAGS) {
      assert.ok(
        jobBlock(jobKeyFor(flag)),
        `ci.yml has no job "${jobKeyFor(flag)}" for the "${flag}" flag. If the job was renamed, ` +
          'update jobKeyFor — the ownership checks resolve jobs through it.',
      )
    }
  })

  test('no job runs a listed guard without being named as an owner', () => {
    // The other direction. If frontend_checks starts running lint:deps, the
    // frontend job becomes an owner and a PR touching dep-lint should run it.
    for (const guard of ROOT_GUARDS) {
      for (const flag of OWNING_FLAGS) {
        const block = jobBlock(jobKeyFor(flag))
        // Never skip a missing block: a renamed job that also picked up a guard
        // command would otherwise leave this test silently covering less, which
        // is the failure shape this whole file exists to prevent.
        assert.ok(block, `ci.yml has no job "${jobKeyFor(flag)}" — see the convention test above`)
        const runsIt = guard.runsVia.some((script) => block.includes(`npm run ${script}`))
        if (!runsIt) continue
        assert.ok(
          guard.jobs.includes(flag),
          `ci.yml's ${jobKeyFor(flag)} runs a ${guard.path} command, but the manifest does not ` +
            `name "${flag}" as an owner. A PR touching that guard would skip the job running it.`,
        )
      }
    }
  })
})

describe('the manifest is wired into routing', () => {
  test('every entry becomes exactly one routing rule', () => {
    assert.equal(ROOT_GUARD_RULES.length, ROOT_GUARDS.length)
    for (const [i, guard] of ROOT_GUARDS.entries()) {
      assert.deepEqual(ROOT_GUARD_RULES[i].patterns, [guard.path])
      assert.deepEqual(ROOT_GUARD_RULES[i].surfaces, ['code', ...guard.jobs])
    }
  })

  test('every entry is exercised by a routing-matrix row', () => {
    // Criterion: adding or changing a manifest entry is covered by the matrix.
    // routing-matrix.test.mjs enforces this generically for every surface rule;
    // asserting it directly here means the manifest's own suite says so too,
    // and names the missing path rather than a rule's pattern list.
    const covered = new Set(ROUTING_MATRIX.flatMap((row) => row.files))
    const uncovered = ROOT_GUARDS.map((g) => g.path).filter((p) => !covered.has(p))
    assert.deepEqual(
      uncovered,
      [],
      'these manifest entries have no routing-matrix row. Add one to routing-matrix.mjs ' +
        'asserting which jobs the guard routes to.',
    )
  })

  test('the matrix row for each entry expects the jobs the manifest assigns', () => {
    // Catches the manifest and the matrix drifting apart in the same PR —
    // someone updating one to make the other pass.
    for (const guard of ROOT_GUARDS) {
      const row = ROUTING_MATRIX.find((r) => r.files.length === 1 && r.files[0] === guard.path)
      assert.ok(row, `no single-file matrix row for ${guard.path}`)
      for (const job of guard.jobs) {
        assert.ok(
          row.expect.includes(job),
          `manifest gives ${guard.path} to "${job}", but its matrix row does not expect that flag`,
        )
      }
    }
  })

  test('no guard path is shadowed by an earlier glob rule', () => {
    // Exact paths only help if they are reached. The root-config rule sits
    // ahead of the generated guard rules and carries globs, so a future
    // pattern there could swallow a guard without anything else noticing.
    const rootConfig = ['.github/workflows/*.yml', '.github/workflows/*.yaml', 'tsconfig*.json']
    for (const guard of ROOT_GUARDS) {
      for (const pattern of rootConfig) {
        assert.equal(
          globToRegExp(pattern).test(guard.path),
          false,
          `${guard.path} is shadowed by the earlier root-config pattern ${pattern}`,
        )
      }
    }
  })
})
