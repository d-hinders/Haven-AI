// Every job that runs Playwright against a DOWNLOADED build must build
// `@haven_ai/core` first (#1930, and #1998 for the latent half).
//
// The defect this closes is one a reviewer cannot see and a green `dev` cannot
// warn about. `browser_smoke` and `design_visual` both `npm ci` and then
// download the prebuilt `frontend-next-build` artifact instead of running a
// build, so neither ever builds the workspace's own packages — and `npm ci`
// does not create `@haven_ai/core`'s `dist/`. The prebuilt `.next` already has
// core bundled INTO it, so the web server starts fine; it is the PLAYWRIGHT
// process that is short the module.
//
// That made the gap unreachable for as long as no spec in those suites imported
// core, which is exactly why it stayed invisible: `dev`'s green history was
// structurally green rather than lucky. The first spec to import the shared
// chain registry took `design_visual` down at COLLECTION — zero tests run, zero
// pixels compared, and no `visual-regression-diffs` artifact at all — which
// surfaces as "the blocking pixel gate is red" and reads like a baseline
// problem. The obvious repair (re-dispatch the regeneration workflow) is the
// harmful one: `--update-snapshots=all` blesses whatever renders and returns a
// green gate carrying no information.
//
// So the invariant is asserted rather than remembered. A THIRD job of this
// shape — and the shape is attractive, because downloading the build is what
// makes these jobs fast — cannot reintroduce it silently.
//
// Deliberately keyed on "downloads the build" rather than on a job-name list:
// a name list is a second thing to maintain and would silently under-report the
// day someone adds the third job, which is the failure mode being closed.
//
// Run with: node --test scripts/ci/e2e-workspace-deps.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs`)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const workflow = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')

/** The artifact the frontend build publishes and these jobs consume. */
const BUILD_ARTIFACT = 'frontend-next-build'
/** The step that makes `@haven_ai/core`'s `dist/` exist in the runner. */
const CORE_BUILD = 'npm run build -w packages/core'

/**
 * Split ci.yml into its top-level jobs.
 *
 * A targeted reader rather than a YAML dependency, matching the convention in
 * `root-guard-ownership.test.mjs` and `money-path.test.mjs`: job keys are the
 * only two-space-indented keys, so each block runs to the next one. If that
 * shape ever changes, `jobs` comes back empty and the guard below fails loudly
 * rather than passing vacuously — which is the whole point of asserting it.
 */
function jobs() {
  const lines = workflow.split('\n')
  const starts = []
  lines.forEach((line, i) => {
    if (/^  [a-z_]+:$/.test(line)) starts.push(i)
  })
  return starts.map((start, n) => ({
    key: lines[start].trim().replace(/:$/, ''),
    body: lines.slice(start + 1, starts[n + 1] ?? lines.length).join('\n'),
  }))
}

const ALL_JOBS = jobs()

describe('the ci.yml reader still works', () => {
  test('it finds a plausible number of jobs', () => {
    // Guards the guard. A reader that silently matches nothing would make every
    // assertion below vacuously true — the exact shape this file exists to stop.
    assert.ok(
      ALL_JOBS.length >= 10,
      `expected ci.yml's full job list, parsed ${ALL_JOBS.length}. The job-key ` +
        `shape this reader depends on has probably changed.`,
    )
  })

  test('it can see a job that is known to download the build', () => {
    const downloaders = ALL_JOBS.filter((j) => j.body.includes(BUILD_ARTIFACT))
    assert.ok(
      downloaders.length >= 1,
      `no job in ci.yml references the "${BUILD_ARTIFACT}" artifact. Either the ` +
        `artifact was renamed — update BUILD_ARTIFACT here — or this reader broke.`,
    )
  })
})

describe('a job that downloads the frontend build also builds core', () => {
  // Derived from ci.yml itself, so adding a third such job adds a case here.
  const downloaders = ALL_JOBS.filter(
    (j) => j.body.includes(BUILD_ARTIFACT) && j.body.includes('actions/download-artifact'),
  )

  for (const job of downloaders) {
    test(`${job.key} builds @haven_ai/core before running Playwright`, () => {
      assert.ok(
        job.body.includes(CORE_BUILD),
        `ci.yml job "${job.key}" downloads the ${BUILD_ARTIFACT} artifact but never runs ` +
          `\`${CORE_BUILD}\`.\n\n` +
          `npm ci does NOT create @haven_ai/core's dist/, and downloading the build does not ` +
          `either — the prebuilt .next has core bundled into it, so the web server starts fine ` +
          `and only the Playwright process is short the module. Any spec importing the shared ` +
          `chain registry will die at COLLECTION with:\n\n` +
          `    Cannot find module '.../node_modules/@haven_ai/core/dist/index.cjs'\n\n` +
          `Zero tests run, zero pixels compared, and no diff artifact is produced — so it ` +
          `surfaces as a red gate with nothing to diagnose. Add:\n\n` +
          `    - name: Build core (the e2e/visual specs import the shared chain registry)\n` +
          `      run: ${CORE_BUILD}\n\n` +
          `before the step that runs Playwright. See #1930 / #1998.`,
      )
    })
  }

  test('both known download-and-test jobs are covered', () => {
    // Pins the CURRENT membership so the loop above cannot quietly shrink to
    // zero cases and still report success — a passing suite that asserts
    // nothing is the failure this repo keeps paying for.
    const keys = downloaders.map((j) => j.key).sort()
    assert.deepEqual(
      keys,
      ['browser_smoke', 'design_visual'],
      `the set of jobs downloading ${BUILD_ARTIFACT} changed to [${keys}]. That is fine — ` +
        `but update this expectation deliberately, and make sure the new job builds core.`,
    )
  })
})
