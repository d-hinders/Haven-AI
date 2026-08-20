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
import { readFileSync, existsSync, globSync } from 'node:fs'
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

describe('routing completeness — every gated guard has an owner (#1626)', () => {
  // The manifest says where the guards it LISTS belong. It does not, by
  // itself, say that every guard CI actually runs is listed. That gap is the
  // one this epic keeps circling: a guard nobody registered is a guard that
  // silently covers nothing on the pull request weakening it (#1206, #1030).
  //
  // The rule is narrow and mechanical, deliberately:
  //
  //   a root guard invoked by a CONDITIONALLY GATED job must be in the manifest.
  //
  // Guards invoked by an UNGATED job need no owner — they run on every pull
  // request already, so there is nothing for routing to get wrong. That
  // exemption is DERIVED from the job's own `if:`, never asserted here, so the
  // day someone gates a job that runs an unregistered guard, this fails.

  /** Root package.json script name -> the scripts/ files it runs. */
  const scriptTargets = new Map(
    Object.entries(packageJson.scripts).map(([name, body]) => [
      name,
      [...body.matchAll(/scripts\/[a-zA-Z0-9/._-]+/g)].map((m) => m[0]),
    ]),
  )

  /**
   * Walk ci.yml once, attributing every guard invocation to its job and
   * recording whether that job is gated on a changed-surface flag.
   *
   * Line-wise and shape-asserted rather than a YAML parse: the job key and the
   * `if:` key both sit at fixed indents, and the assertions below fail loudly
   * if that stops being true instead of quietly finding nothing.
   *
   * TWO KNOWN LIMITATIONS, recorded rather than papered over:
   *
   *   1. Gating is read from a job's OWN `if:`. A job gated only transitively —
   *      no `if:` of its own, but a `needs:` on a job that is gated, which
   *      GitHub skips along with it — reads as ungated here and would be
   *      exempted. No job in ci.yml has that shape today (every conditional
   *      job restates its flag), and the exemption is the dangerous direction,
   *      so this is the first thing to tighten if such a job appears.
   *   2. A self-test named anything other than `<guard>.test.<ext>` is not
   *      paired by the test below; it no-ops rather than failing.
   */
  function invocations() {
    const all = workflow.split('\n')
    // Only scan the jobs: block. `on:` has keys at the same indent (push,
    // pull_request, workflow_dispatch) that would otherwise read as jobs.
    const jobsAt = all.findIndex((l) => l === 'jobs:')
    assert.notEqual(jobsAt, -1, 'ci.yml has no top-level `jobs:` key')
    const lines = all.slice(jobsAt + 1)
    const offset = jobsAt + 2 // 1-indexed line numbers for messages

    const gated = new Map()
    let job = null
    for (const line of lines) {
      const header = line.match(/^  ([a-z_]+):$/)
      if (header) {
        job = header[1]
        gated.set(job, false)
        continue
      }
      if (/^    if: /.test(line) && /needs\.changes\.outputs/.test(line)) gated.set(job, true)
    }

    const found = []
    job = null
    for (const [i, raw] of lines.entries()) {
      const header = raw.match(/^  ([a-z_]+):$/)
      if (header) {
        job = header[1]
        continue
      }
      // Strip comments before matching. ci.yml:232 tells a reader to run
      // `npm run generate:api-types`; that is prose, not an invocation, and
      // counting it would let a comment satisfy a completeness check.
      const line = raw.replace(/#.*$/, '')

      const targets = []
      for (const m of line.matchAll(/npm run ([a-z:._-]+)/g)) targets.push(...(scriptTargets.get(m[1]) ?? []))
      for (const m of line.matchAll(/node (?:--test )?(scripts\/[a-zA-Z0-9/._*-]+)/g)) targets.push(m[1])

      for (const target of targets) {
        // Expand a glob invocation to the files it actually runs. Left as a
        // literal, `scripts/ci/*.test.mjs` could never be satisfied: the
        // manifest rejects `*` in a path, so gating that job would make this
        // suite unsatisfiable by ANY manifest edit rather than merely failing.
        const files = target.includes('*')
          ? globSync(target, { cwd: ROOT }).sort()
          : [target]
        for (const file of files) found.push({ job, file, line: i + offset, gated: gated.get(job) === true })
      }
    }
    return found
  }

  test('the ci.yml walk actually finds guards — it cannot pass by finding nothing', () => {
    // A completeness check that silently matches zero invocations reports
    // "complete" forever. Pin the shape before trusting the result.
    const all = invocations()
    assert.ok(all.length >= 10, `expected many guard invocations in ci.yml, saw ${all.length}`)
    assert.ok(
      all.some((i) => i.gated),
      'found no CONDITIONALLY gated guard invocation — the job/if walk has stopped working',
    )
    assert.ok(
      all.some((i) => !i.gated),
      'found no ungated guard invocation — the job/if walk has stopped working',
    )

    // A count floor alone would not notice the regex silently dropping half
    // the matches. Name guards the walk MUST see, in the jobs that run them,
    // so a partial break is a failure rather than a smaller number.
    for (const [file, job] of [
      ['scripts/dep-lint.mjs', 'backend_checks'],
      ['scripts/lint-wire-types.mjs', 'frontend_checks'],
      ['scripts/network-map-pins.test.mjs', 'sdk_checks'],
    ]) {
      assert.ok(
        all.some((i) => i.file === file && i.job === job && i.gated),
        `the walk no longer sees ${file} as a gated invocation in ${job}`,
      )
    }
  })

  test('prose naming a guard command is not counted as an invocation', () => {
    // ci.yml:232 tells the reader to run `npm run generate:api-types` in a
    // comment. Counting a comment would let documentation satisfy a
    // completeness check — the check would pass while nothing ran.
    const commentLine = workflow
      .split('\n')
      .findIndex((l) => l.trimStart().startsWith('#') && /npm run [a-z:._-]+/.test(l))
    assert.notEqual(commentLine, -1, 'expected ci.yml to contain a comment naming an npm script')
    assert.ok(
      !invocations().some((i) => i.line === commentLine + 1),
      `ci.yml:${commentLine + 1} is a comment but was counted as a guard invocation`,
    )
  })

  test('every guard run by a gated job is registered in the manifest', () => {
    const owned = new Set(ROOT_GUARDS.map((g) => g.path))
    const unowned = invocations()
      .filter((i) => i.gated && !owned.has(i.file))
      .map((i) => `ci.yml:${i.line} — ${i.job} runs ${i.file}`)

    assert.deepEqual(
      [...new Set(unowned)],
      [],
      'these guards run in a conditionally gated job with no entry in ' +
        '.github/root-guard-ownership.json. A gated job only runs when the classifier ' +
        'routes to it, so an unregistered guard is skipped on exactly the pull request ' +
        'that weakens it. Add an entry (and a routing-matrix row).',
    )
  })

  test('a guard and its self-test are registered together', () => {
    // Registering the lint but not its `.test.mjs` is the specific half-done
    // shape that leaves a ratchet able to start passing vacuously.
    const owned = new Set(ROOT_GUARDS.map((g) => g.path))
    for (const guard of ROOT_GUARDS) {
      if (guard.path.includes('.test.')) continue
      const selfTest = guard.path.replace(/\.(mjs|cjs)$/, '.test.$1')
      if (!existsSync(path.join(ROOT, selfTest))) continue
      assert.ok(
        owned.has(selfTest),
        `${guard.path} is registered but its self-test ${selfTest} is not. A self-test that ` +
          'does not route is a self-test that can be weakened without running.',
      )
    }
  })
})
