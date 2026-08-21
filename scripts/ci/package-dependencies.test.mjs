// Tests for the package dependency table (#1625, epic #1621).
//
// The table drives CI job fan-out: if it says nothing depends on the signer,
// no consumer's job runs when the signer changes. A table that is quietly
// wrong therefore produces a green pull request whose consumers were never
// built — the #1206/#1030 shape, one layer up again.
//
// So the table is checked against the real package.json files, in BOTH
// directions, rather than trusted. That check is what found the gap #1625
// fixes: packages/mcp-server consumes @haven_ai/signer in its tests, and its
// job runs those tests, but a signer change never triggered it.
//
// Run with: node --test scripts/ci/package-dependencies.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs`)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PACKAGE_DEPENDENCIES,
  PACKAGE_JOBS,
  PROPAGATION_RULES,
  OUTPUT_NAMES,
  dependentsOf,
} from './change-classifier.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const workflow = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')

/** Job flag -> workspace directory. Only mcp_server differs. */
const dirFor = (flag) => (flag === 'mcp_server' ? 'mcp-server' : flag)

/** Workspace directory -> job flag, for the internal deps we can route. */
const flagFor = (dir) => (dir === 'mcp-server' ? 'mcp_server' : dir)

/**
 * The @haven_ai/* packages this workspace declares, as job flags.
 *
 * devDependencies count. packages/mcp-server only uses @haven_ai/signer in a
 * test, and its CI job runs its tests — a dependency that can redden the job
 * is a dependency for routing purposes, shipped or not.
 *
 * Internal packages with no job flag (core, qa-agent) are dropped: there is no
 * job to fan out to. They reach CI through the packages/* catch-all instead.
 */
function declaredDeps(flag) {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'packages', dirFor(flag), 'package.json'), 'utf8'))
  const names = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ])
  return [...names]
    .filter((n) => n.startsWith('@haven_ai/'))
    .map((n) => flagFor(n.slice('@haven_ai/'.length)))
    .filter((f) => PACKAGE_JOBS.includes(f))
    .sort()
}

describe('the table is well-formed', () => {
  test('every key is a real job flag, never a routing pseudo-flag', () => {
    for (const flag of PACKAGE_JOBS) {
      assert.ok(OUTPUT_NAMES.includes(flag), `${flag} is not an output flag`)
      assert.ok(flag !== 'code' && flag !== 'full', `${flag} is a routing flag, not a package`)
    }
  })

  test('every dependsOn entry names a package in the table', () => {
    for (const [flag, entry] of Object.entries(PACKAGE_DEPENDENCIES)) {
      assert.ok(Array.isArray(entry.dependsOn), `${flag} has no dependsOn array`)
      for (const dep of entry.dependsOn) {
        assert.ok(PACKAGE_JOBS.includes(dep), `${flag} depends on unknown package "${dep}"`)
        assert.notEqual(dep, flag, `${flag} depends on itself`)
      }
      assert.equal(new Set(entry.dependsOn).size, entry.dependsOn.length, `${flag} repeats a dependency`)
    }
  })

  test('every package in the table has a CI job', () => {
    // Same convention the guard manifest relies on. A table entry for a
    // package with no job would fan out to a flag nothing reads.
    for (const flag of PACKAGE_JOBS) {
      assert.ok(
        workflow.includes(`\n  ${flag}_checks:\n`),
        `ci.yml has no job "${flag}_checks" for the "${flag}" entry`,
      )
    }
  })

  test('every per-surface CI job has a table entry', () => {
    // The other direction: a job whose package is absent from the table can
    // never be a fan-out target, so a change to what it builds routes nowhere.
    const jobFlags = OUTPUT_NAMES.filter(
      (f) => f !== 'code' && f !== 'full' && workflow.includes(`\n  ${f}_checks:\n`),
    )
    assert.deepEqual([...PACKAGE_JOBS].sort(), jobFlags.sort())
  })
})

describe('the table matches the real package manifests', () => {
  test('dependsOn equals what package.json declares — both directions', () => {
    // THE test in this file. Anything else is bookkeeping about a table that
    // might not describe the repo.
    for (const flag of PACKAGE_JOBS) {
      assert.deepEqual(
        [...PACKAGE_DEPENDENCIES[flag].dependsOn].sort(),
        declaredDeps(flag),
        `packages/${dirFor(flag)}/package.json and the dependency table disagree. ` +
          'Update .github/package-dependencies.json to match package.json — a table that ' +
          'over-states fans out needlessly, and one that under-states skips a consumer whose ' +
          'build the change just broke.',
      )
    }
  })

  test('nothing is pre-expanded — dependsOn holds DIRECT dependencies only', () => {
    // The closure is computed, never written down. A pre-expanded chain looks
    // identical to a correct one right up until someone inserts a link.
    for (const flag of PACKAGE_JOBS) {
      assert.deepEqual(
        [...PACKAGE_DEPENDENCIES[flag].dependsOn].sort(),
        declaredDeps(flag),
        `${flag} lists something package.json does not declare directly`,
      )
    }
  })
})

describe('dependentsOf computes a transitive closure', () => {
  test('it follows a chain the table never spells out', () => {
    // a <- b <- c, with only the direct links declared. A direct-dependents
    // implementation returns [b]; the closure returns both.
    const chain = {
      a: { dependsOn: [] },
      b: { dependsOn: ['a'] },
      c: { dependsOn: ['b'] },
    }
    assert.deepEqual(dependentsOf('a', chain).sort(), ['b', 'c'])
    assert.deepEqual(dependentsOf('b', chain).sort(), ['c'])
    assert.deepEqual(dependentsOf('c', chain), [])
  })

  test('a diamond is not double-counted', () => {
    const diamond = {
      a: { dependsOn: [] },
      b: { dependsOn: ['a'] },
      c: { dependsOn: ['a'] },
      d: { dependsOn: ['b', 'c'] },
    }
    assert.deepEqual(dependentsOf('a', diamond).sort(), ['b', 'c', 'd'])
  })

  test('a cycle terminates instead of hanging', () => {
    // Impossible in a real package graph, but a walk that would hang on one is
    // a walk that can hang CI, and the table is hand-editable.
    const cyclic = { a: { dependsOn: ['b'] }, b: { dependsOn: ['a'] } }
    assert.deepEqual(dependentsOf('a', cyclic), ['b'])
  })

  test('a package nothing consumes has no dependents', () => {
    assert.deepEqual(dependentsOf('frontend'), [])
    assert.deepEqual(dependentsOf('cli'), [])
  })
})

describe('the fan-out the issue specifies', () => {
  const thenFor = (pkg) => {
    const rule = PROPAGATION_RULES.find((r) => r.when.length === 1 && r.when[0] === pkg)
    return rule ? [...rule.then].sort() : []
  }

  test('full fans out to every package job', () => {
    const full = PROPAGATION_RULES.find((r) => r.when.includes('full'))
    assert.deepEqual(
      [...full.then].sort(),
      ['backend', 'cli', 'connect', 'frontend', 'mcp', 'mcp_server', 'sdk', 'signer'],
    )
  })

  test('sdk fans out to backend, connect, mcp, mcp_server and signer — unchanged', () => {
    assert.deepEqual(thenFor('sdk'), ['backend', 'connect', 'mcp', 'mcp_server', 'signer'])
  })

  test('mcp fans out to connect — unchanged', () => {
    assert.deepEqual(thenFor('mcp'), ['connect'])
  })

  test('signer fans out to connect AND mcp_server', () => {
    // The one deliberate routing CHANGE in #1625. mcp_server was missing:
    // packages/mcp-server/src/hosted-signer-integration.test.ts imports
    // @haven_ai/signer and mcp_server_checks runs it, so a signer change could
    // break that test with its job never running. Derived, not hand-added.
    assert.deepEqual(thenFor('signer'), ['connect', 'mcp_server'])
    assert.ok(
      PACKAGE_DEPENDENCIES.mcp_server.dependsOn.includes('signer'),
      'the mcp_server fan-out must come from the declared dependency, not a special case',
    )
  })

  test('frontend, backend and cli fan out to nothing', () => {
    for (const pkg of ['frontend', 'backend', 'cli']) {
      assert.deepEqual(thenFor(pkg), [], `${pkg} should have no dependents`)
    }
  })
})

describe('propagation is not duplicated in the workflow', () => {
  const lines = workflow.split('\n').map((text, i) => ({ line: i + 1, text }))
  const flagsIn = (text) =>
    new Set([...text.matchAll(/needs\.changes\.outputs\.([a-z_]+)/g)].map((m) => m[1]))

  // NOTE ON STRICTNESS: the rule below is "one changed-surface flag per
  // expression", which is a proxy for the real invariant — no hand-maintained
  // copy of the dependency graph. It is deliberately stricter. A future job
  // that legitimately needs two UNRELATED surfaces (say frontend OR backend,
  // where neither depends on the other) cannot express that through the
  // dependency table, because the table models consumer edges and not
  // arbitrary unions. That case should get an explicit exemption here with a
  // reason, not a quiet widening of the regex.

  test('no expression names more than one changed-surface flag', () => {
    // Criterion 5. A `connect || mcp || sdk` gate is a SECOND copy of the
    // dependency graph: it says "connect also rebuilds when the sdk moves",
    // which the table already says and the classifier already computes. Two
    // copies drift, and the workflow's copy is the one no test was watching.
    //
    // Scans EVERY line, not just job gates: the review of #1625 found a
    // surviving copy inside the required-check summary's shell script, which a
    // gate-only scan cannot see. That is the whole reason this is line-wise.
    const offenders = lines
      .map((l) => ({ ...l, flags: flagsIn(l.text) }))
      .filter((l) => l.flags.size > 1)
      .map((l) => `ci.yml:${l.line} names ${[...l.flags].join(' + ')}`)

    assert.deepEqual(
      offenders,
      [],
      'a workflow expression re-states fan-out. Declare the dependency in ' +
        '.github/package-dependencies.json and test the single flag instead.',
    )
  })

  test('a multi-line boolean cannot smuggle a second flag past the line scan', () => {
    // The line-wise rule above is blind to an expression split across lines,
    // which is exactly the shape the original install_smoke gate used
    // (`if: >-` with one flag per continuation line). Catch both spellings:
    // a YAML block scalar on a job gate, and a shell/YAML line that references
    // a flag and then continues with || or && into another that does too.
    const blockGates = lines.filter((l) => /^    if: *[>|]/.test(l.text))
    assert.deepEqual(
      blockGates.map((g) => `ci.yml:${g.line}`),
      [],
      'a job gate uses a YAML block scalar; keep gates to one inline expression',
    )

    const continued = []
    for (let i = 0; i < lines.length - 1; i++) {
      const here = lines[i]
      const next = lines[i + 1]
      if (!flagsIn(here.text).size || !flagsIn(next.text).size) continue
      if (!/(\|\||&&|\\)\s*$/.test(here.text)) continue
      const combined = new Set([...flagsIn(here.text), ...flagsIn(next.text)])
      if (combined.size > 1) continued.push(`ci.yml:${here.line}-${next.line} names ${[...combined].join(' + ')}`)
    }
    assert.deepEqual(continued, [], 'a multi-line boolean re-states fan-out across lines')
  })
})
