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
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PACKAGE_DEPENDENCIES,
  PACKAGE_JOBS,
  PACKAGE_DEPENDENCY_TABLE_PATH,
  PROPAGATION_RULES,
  OUTPUT_NAMES,
  dependentsOf,
} from './change-classifier.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const workflow = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')

/**
 * The RAW manifest, read directly rather than through PACKAGE_DEPENDENCIES —
 * the classifier only re-exports the `packages` object, and `noOwnJob` is a
 * sibling key next to it, not a package entry.
 */
const RAW_DEPENDENCY_MANIFEST = JSON.parse(readFileSync(PACKAGE_DEPENDENCY_TABLE_PATH, 'utf8'))

/** @type {Record<string, string>} workspace directory -> reason it has no CI job */
const NO_OWN_JOB = RAW_DEPENDENCY_MANIFEST.noOwnJob ?? {}

/** Job flag -> workspace directory. mcp_server and demo_merchant differ. */
const dirFor = (flag) => {
  if (flag === 'mcp_server') return 'mcp-server'
  if (flag === 'demo_merchant') return 'demo-merchant-mcp'
  return flag
}

/** Workspace directory -> job flag, for the internal deps we can route. */
const flagFor = (dir) => {
  if (dir === 'mcp-server') return 'mcp_server'
  if (dir === 'demo-merchant-mcp') return 'demo_merchant'
  return dir
}

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
      ['backend', 'cli', 'connect', 'demo_merchant', 'frontend', 'mcp', 'mcp_server', 'sdk', 'signer'],
    )
  })

  test('sdk fans out to backend, connect, mcp, mcp_server and signer — unchanged', () => {
    assert.deepEqual(thenFor('sdk'), ['backend', 'connect', 'mcp', 'mcp_server', 'signer'])
  })

  test('mcp fans out to connect AND mcp_server', () => {
    // mcp_server joined in #2348, on the identical reasoning that added it to
    // `signer` below: packages/mcp-server/src/strict-tool-input.test.ts imports
    // @haven_ai/mcp's toolSchemas, and mcp_server_checks runs it, so a rename in
    // the LOCAL tool schemas could break that test with its job never running.
    // The fan-out is the feature rather than a cost — that test exists precisely
    // to notice a local rename, so it has to run when the local surface moves.
    // Derived from the real dependency graph, not hand-added.
    assert.deepEqual(thenFor('mcp'), ['connect', 'mcp_server'])
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

  test('frontend, backend, cli and demo_merchant fan out to nothing', () => {
    for (const pkg of ['frontend', 'backend', 'cli', 'demo_merchant']) {
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

// Found by #2996: packages/demo-merchant-mcp had a `test` script, 142 tests,
// and NO entry anywhere — not in this table, not in ci.yml, not in the change
// classifier. Every check above this line only validates a table entry AGAINST
// itself or against ci.yml; none of them notice a workspace that is simply
// absent from both. This describe block reads the real packages/ directory
// and closes that blind spot directly.
describe('every workspace with a test script has a CI job', () => {
  const PACKAGES_DIR = path.join(ROOT, 'packages')

  /** Workspace directories that declare a `test` script in package.json. */
  function workspacesWithTestScript() {
    return readdirSync(PACKAGES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((dir) => existsSync(path.join(PACKAGES_DIR, dir, 'package.json')))
      .filter((dir) => {
        const manifest = JSON.parse(readFileSync(path.join(PACKAGES_DIR, dir, 'package.json'), 'utf8'))
        return Boolean(manifest.scripts && manifest.scripts.test)
      })
  }

  test('every such workspace has a table entry or a recorded exemption', () => {
    const missing = workspacesWithTestScript()
      .map((dir) => ({ dir, flag: flagFor(dir) }))
      .filter(({ dir, flag }) => !PACKAGE_JOBS.includes(flag) && !(dir in NO_OWN_JOB))
      .map(({ dir }) => dir)

    assert.deepEqual(
      missing,
      [],
      'these workspaces declare a `test` script but have no CI job (no entry in ' +
        '.github/package-dependencies.json\'s `packages`, and no `noOwnJob` exemption): ' +
        `${missing.join(', ')}. Either add a CI job for it (see #2996 for the ` +
        'demo_merchant precedent) or record why it is deliberately unrun in `noOwnJob`.',
    )
  })

  test('every `noOwnJob` exemption is a real workspace with a real test script', () => {
    // The other direction: an exemption for a package that no longer exists,
    // or that has since gained a job, is dead weight that hides a real gap
    // the next time this check should have fired.
    const withTests = new Set(workspacesWithTestScript())
    for (const dir of Object.keys(NO_OWN_JOB)) {
      assert.ok(
        existsSync(path.join(PACKAGES_DIR, dir)),
        `noOwnJob names "${dir}", which does not exist under packages/`,
      )
      assert.ok(
        withTests.has(dir),
        `noOwnJob names "${dir}", which has no \`test\` script — the exemption is stale`,
      )
      assert.ok(
        !PACKAGE_JOBS.includes(flagFor(dir)),
        `noOwnJob names "${dir}", which now HAS a CI job — remove the stale exemption`,
      )
    }
  })

  test('every noOwnJob exemption has a substantive reason', () => {
    for (const [dir, reason] of Object.entries(NO_OWN_JOB)) {
      assert.ok(
        typeof reason === 'string' && reason.length >= 20,
        `noOwnJob["${dir}"] needs a real reason, got: ${JSON.stringify(reason)}`,
      )
    }
  })
})
