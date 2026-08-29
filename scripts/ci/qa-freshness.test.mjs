// Tests for the money-flow QA freshness gate (#1030).
//
// The first block is CHARACTERIZATION (money.md §2): it pins the behaviour of
// the inline-bash version this replaced, so the refactor is provably
// behaviour-preserving before the new rules are layered on. If one of those
// three fails, the rewrite changed something it was not supposed to.
//
// Everything after pins the NEW rules. The bias throughout is fail-closed: for
// each way the gate could be asked a question it cannot answer, there is a test
// asserting it refuses rather than passes. That direction is the whole point —
// #1030 exists because the old gate reported green while proving nothing.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, matchesGlob, moneyPathFiles, loadMoneyPathGlobs, completenessWarningFromJobs, greenRunQueryArgs, selectDiffBase, isVersionOnlyDiff, partitionVersionOnly } from './qa-freshness.mjs'

const HOUR = 3_600_000
const NOW = Date.parse('2026-07-27T12:00:00Z')
const run = (hoursAgo, headSha = 'aaa111') => ({
  createdAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
  headSha,
})
const base = {
  sourceBranch: 'dev',
  latestGreenRun: run(2),
  changedMoneyPathFiles: [],
  nowMs: NOW,
  freshnessHours: 30,
}

describe('characterization — behaviour of the inline-bash gate this replaced', () => {
  test('no green run at all → fail', () => {
    const r = evaluate({ ...base, latestGreenRun: null })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'no_run')
    assert.match(r.message, /No successful 'QA — money-flow \(dev\)' run found on dev/)
  })

  test('run older than FRESHNESS_HOURS → fail, with the age in the message', () => {
    const r = evaluate({ ...base, latestGreenRun: run(31) })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'stale')
    assert.match(r.message, /31h old \(> 30h\)/)
    // Operators grep this phrase; the refactor must not reword it.
    assert.match(r.message, /add the 'qa-override' label/)
  })

  test('run inside the window → pass', () => {
    assert.equal(evaluate({ ...base, latestGreenRun: run(29) }).ok, true)
  })

  test('exactly at the boundary passes — `-gt`, not `-ge`, as the bash used', () => {
    assert.equal(evaluate({ ...base, latestGreenRun: run(30) }).ok, true)
  })

  test('FRESHNESS_HOURS is honoured, not hardcoded', () => {
    assert.equal(evaluate({ ...base, latestGreenRun: run(40), freshnessHours: 50 }).ok, true)
    assert.equal(evaluate({ ...base, latestGreenRun: run(40), freshnessHours: 20 }).ok, false)
  })
})

describe('gap 1 — the run must have covered the promoted money-path code', () => {
  test('money-path file changed after the run → fail even though the run is fresh', () => {
    const r = evaluate({
      ...base,
      latestGreenRun: run(1, 'sha-old'),
      changedMoneyPathFiles: ['packages/backend/src/routes/payments.ts'],
    })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'money_path_after_run')
    // The failure must name the offending file — a gate that says "no" without
    // saying what is the kind people bypass rather than diagnose.
    assert.match(r.message, /routes\/payments\.ts/)
    assert.match(r.message, /recency is not coverage/)
  })

  test('no money-path change since the run → pass (ordinary promotions stay cheap)', () => {
    assert.equal(evaluate({ ...base, changedMoneyPathFiles: [] }).ok, true)
  })

  test('uncomputable diff → fail closed, never "nothing changed"', () => {
    const r = evaluate({ ...base, changedMoneyPathFiles: null })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'diff_unknown')
  })

  test('staleness is checked before coverage — the older problem is reported first', () => {
    const r = evaluate({
      ...base,
      latestGreenRun: run(99),
      changedMoneyPathFiles: ['packages/backend/src/routes/payments.ts'],
    })
    assert.equal(r.code, 'stale')
  })
})

describe("gap 2 — a money-path hotfix cannot be verified, so it BLOCKS", () => {
  const hotfix = { ...base, sourceBranch: 'hotfix/urgent' }

  test('money-path hotfix blocks even with a fresh green run on dev', () => {
    // The old gate passed exactly here. So did my first attempt at the fix,
    // which accepted "a green run exists on the hotfix branch" — but qa-dev is
    // a black-box harness against a DEPLOYED backend, and a hotfix is deployed
    // nowhere until it merges. Accepting such a run would have been the same
    // lie in a new costume.
    const r = evaluate({
      ...hotfix,
      latestGreenRun: run(1),
      changedMoneyPathFiles: ['packages/backend/src/rails/allowance-module.ts'],
    })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'hotfix_money_path')
    assert.match(r.message, /deployed nowhere until it merges/)
    // The message must say how to proceed, or it just gets overridden blindly.
    assert.match(r.message, /qa-override/)
    assert.match(r.message, /allowance-module\.ts/)
  })

  test('a run on the hotfix branch itself does NOT clear it', () => {
    const r = evaluate({
      ...hotfix,
      latestGreenRun: run(0.1, 'hotfix-sha'),
      changedMoneyPathFiles: ['packages/backend/src/middleware/agentAuth.ts'],
    })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'hotfix_money_path')
  })

  test('hotfix touching no money-path file → pass, gate does not apply', () => {
    const r = evaluate({ ...hotfix, latestGreenRun: null, changedMoneyPathFiles: [] })
    assert.equal(r.ok, true)
    assert.equal(r.code, 'hotfix_no_money_path')
  })

  test('a non-money hotfix passes even with no run at all', () => {
    const r = evaluate({ ...hotfix, latestGreenRun: null, changedMoneyPathFiles: [] })
    assert.equal(r.ok, true)
  })

  test('hotfix with an uncomputable diff → fail closed', () => {
    const r = evaluate({ ...hotfix, latestGreenRun: null, changedMoneyPathFiles: null })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'hotfix_diff_unknown')
  })
})

describe('the gate refuses to run without a real bound or a known branch', () => {
  test('non-numeric QA_FRESHNESS_HOURS → fail closed, not a silent NaN pass', () => {
    // The repo variable is editable without code review. `ageH > NaN` is false,
    // so this silently disabled the staleness rule while printing "within NaNh".
    const r = evaluate({ ...base, latestGreenRun: run(1000), freshnessHours: Number('thirty') })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'bad_freshness_hours')
  })

  test('zero or negative freshness → fail closed', () => {
    assert.equal(evaluate({ ...base, freshnessHours: 0 }).code, 'bad_freshness_hours')
    assert.equal(evaluate({ ...base, freshnessHours: -5 }).code, 'bad_freshness_hours')
  })

  test('unknown source branch → fail closed', () => {
    // The docstring promised this; it was not true. `gate` restricts the branch,
    // but this function must not depend on another job for its own correctness.
    const r = evaluate({ ...base, sourceBranch: 'feature/x' })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'unknown_branch')
  })
})

describe('fail-closed on malformed input', () => {
  test('unparseable run timestamp → fail, not "assume recent"', () => {
    const r = evaluate({ ...base, latestGreenRun: { createdAt: 'not-a-date', headSha: 'x' } })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'unparseable_timestamp')
  })

  test('a future-dated run is not treated as stale', () => {
    // Clock skew between the runner and the API should not wedge a promotion.
    assert.equal(evaluate({ ...base, latestGreenRun: run(-1) }).ok, true)
  })
})

describe('glob matching', () => {
  test('exact path', () => {
    assert.equal(matchesGlob('packages/sdk/src/signer.ts', 'packages/sdk/src/signer.ts'), true)
    assert.equal(matchesGlob('packages/sdk/src/signer2.ts', 'packages/sdk/src/signer.ts'), false)
  })

  test('trailing /** matches everything beneath', () => {
    const g = 'packages/backend/src/db/migrations/**'
    assert.equal(matchesGlob('packages/backend/src/db/migrations/050_x.sql', g), true)
    assert.equal(matchesGlob('packages/backend/src/db/migrations/sub/deep.sql', g), true)
    assert.equal(matchesGlob('packages/backend/src/db/other.sql', g), false)
  })

  test('* stays within one segment', () => {
    const g = 'packages/backend/src/rails/delegation-*.ts'
    assert.equal(matchesGlob('packages/backend/src/rails/delegation-redeem.ts', g), true)
    assert.equal(matchesGlob('packages/backend/src/rails/delegation.ts', g), false)
    // The bug a naive `.*` would introduce: crossing a directory boundary.
    assert.equal(matchesGlob('packages/backend/src/rails/delegation-a/b.ts', g), false)
  })

  test('regex metacharacters in a path are literal, not patterns', () => {
    assert.equal(matchesGlob('packages/backend/src/lib/aXb.ts', 'packages/backend/src/lib/a.b.ts'), false)
  })

  test('moneyPathFiles filters a mixed change set', () => {
    const globs = loadMoneyPathGlobs()
    const hits = moneyPathFiles(
      [
        'README.md',
        'packages/backend/src/routes/payments.ts',
        'packages/frontend/src/app/page.tsx',
        'packages/backend/src/db/migrations/051_a.sql',
        'packages/backend/src/rails/delegation-redeem.ts',
      ],
      globs,
    )
    assert.deepEqual(hits, [
      'packages/backend/src/routes/payments.ts',
      'packages/backend/src/db/migrations/051_a.sql',
      'packages/backend/src/rails/delegation-redeem.ts',
    ])
  })

  test('the delegation rail and the SDK signer are covered — they were NOT in labeler.yml', () => {
    // The specific hole #1030 found: money-path PRs on the delegation rail were
    // never auto-labeled, so they never loaded money.md.
    const globs = loadMoneyPathGlobs()
    for (const f of [
      'packages/backend/src/rails/delegation-redeem.ts',
      'packages/backend/src/rails/execution-rail.ts',
      'packages/backend/src/rails/hybrid-provisioning.ts',
      'packages/backend/src/routes/agent-delegations.ts',
      'packages/sdk/src/signer.ts',
    ]) {
      assert.equal(moneyPathFiles([f], globs).length, 1, `${f} must be money-path`)
    }
  })
})

describe('completeness warning (#1044)', () => {
  test('warns when the Coverage completeness step failed', () => {
    const jobs = [{ steps: [
      { name: 'Run money-flow QA (bounded flake-retry)', conclusion: 'success' },
      { name: 'Coverage completeness', conclusion: 'failure' },
    ] }]
    assert.match(completenessWarningFromJobs(jobs) ?? '', /GREEN-WITH-SKIPS/)
  })
  test('silent on full coverage, missing step, or no jobs', () => {
    assert.equal(completenessWarningFromJobs([{ steps: [
      { name: 'Coverage completeness', conclusion: 'success' },
    ] }]), null)
    assert.equal(completenessWarningFromJobs([{ steps: [] }]), null)
    assert.equal(completenessWarningFromJobs(undefined), null)
  })
})

// #1047 part 3 — the WIRING decisions main() feeds the pure core with. The
// core was pinned; these two choices (which runs count as evidence, which SHA
// the coverage diff anchors to) were not, and both are load-bearing.
describe('wiring — run-list filters (#1047)', () => {
  test('evidence is ONLY dev-branch successes of qa-dev.yml, newest first', () => {
    const args = greenRunQueryArgs('d-hinders/Haven-AI')
    const arg = (flag) => args[args.indexOf(flag) + 1]
    assert.equal(arg('--workflow'), 'qa-dev.yml')
    // Always dev — a hotfix has no valid evidence of its own, and a green run
    // on any other branch exercised different code.
    assert.equal(arg('--branch'), 'dev')
    assert.equal(arg('--status'), 'success')
    assert.equal(arg('--limit'), '1')
    assert.equal(arg('--repo'), 'd-hinders/Haven-AI')
    // headSha is what the coverage diff anchors to; dropping it from the JSON
    // fields would silently turn the coverage rule into fail-closed-always.
    assert.match(arg('--json'), /headSha/)
  })
})

describe('wiring — diff-base selection (#1047)', () => {
  test('an ordinary branch anchors to the green run commit; merge-base is not consulted', () => {
    let mergeBaseCalls = 0
    const base = selectDiffBase({
      sourceBranch: 'dev',
      latestGreenRun: { headSha: 'run-sha' },
      resolveMergeBaseWithMain: () => {
        mergeBaseCalls += 1
        return 'wrong'
      },
    })
    assert.equal(base, 'run-sha')
    assert.equal(mergeBaseCalls, 0)
  })

  test('a hotfix anchors to its merge-base with main, never the run commit', () => {
    const base = selectDiffBase({
      sourceBranch: 'hotfix/urgent',
      latestGreenRun: { headSha: 'run-sha' },
      resolveMergeBaseWithMain: () => 'mb-sha',
    })
    assert.equal(base, 'mb-sha')
  })

  test('no green run -> null anchor -> the caller fails closed', () => {
    const base = selectDiffBase({
      sourceBranch: 'dev',
      latestGreenRun: null,
      resolveMergeBaseWithMain: () => 'unused',
    })
    assert.equal(base, null)
  })

  test('an unresolvable hotfix merge-base stays null — never a silent fallback to the run', () => {
    const base = selectDiffBase({
      sourceBranch: 'hotfix/urgent',
      latestGreenRun: { headSha: 'run-sha' },
      resolveMergeBaseWithMain: () => null,
    })
    assert.equal(base, null)
  })
})

// ── Version-only money-path diffs (#2164) ───────────────────────────────────
//
// Every release bump rewrites SIGNER_VERSION into packages/signer/src/server.ts
// — a money-path file — after the last green run, so the gate refused every
// release by construction and qa-override became the route. These pin the
// narrow exception, and the bias is the same as everywhere else in this file:
// each test that could go the permissive way asserts it does not.

const signerVersionBump = `diff --git a/packages/signer/src/server.ts b/packages/signer/src/server.ts
--- a/packages/signer/src/server.ts
+++ b/packages/signer/src/server.ts
@@ -12 +12 @@
-export const SIGNER_VERSION = '0.1.30-alpha.0'
+export const SIGNER_VERSION = '0.1.31-alpha.0'
`

const packageJsonBump = `diff --git a/packages/signer/package.json b/packages/signer/package.json
--- a/packages/signer/package.json
+++ b/packages/signer/package.json
@@ -3 +3 @@
-  "version": "0.1.30-alpha.0",
+  "version": "0.1.31-alpha.0",
@@ -20 +20 @@
-    "@haven_ai/sdk": "0.1.30-alpha.0",
+    "@haven_ai/sdk": "0.1.31-alpha.0",
`

describe('isVersionOnlyDiff (#2164)', () => {
  test('a real SIGNER_VERSION bump is version-only', () => {
    assert.equal(isVersionOnlyDiff(signerVersionBump), true)
  })

  test('a package.json version + internal pin bump is version-only', () => {
    assert.equal(isVersionOnlyDiff(packageJsonBump), true)
  })

  test('THE CASE A PATH EXCLUSION GETS WRONG: a behavioural line in the same commit as a bump still counts', () => {
    // This is the whole reason the rule is content-based. Excusing
    // packages/signer/** by path would wave this through.
    const mixed = `--- a/packages/signer/src/server.ts
+++ b/packages/signer/src/server.ts
@@ -12 +12 @@
-export const SIGNER_VERSION = '0.1.30-alpha.0'
+export const SIGNER_VERSION = '0.1.31-alpha.0'
@@ -40 +40 @@
-  if (!verifySignature(hash, signature, delegateAddress)) {
+  if (false) {
`
    assert.equal(isVersionOnlyDiff(mixed), false)
  })

  test('a behavioural change alone counts', () => {
    const behavioural = `--- a/packages/signer/src/core.ts
+++ b/packages/signer/src/core.ts
@@ -40 +40 @@
-  const delegateAddress = addressFromKey(delegateKey)
+  const delegateAddress = OVERRIDE
`
    assert.equal(isVersionOnlyDiff(behavioural), false)
  })

  test('a non-semver value on a _VERSION constant is NOT excused', () => {
    // Guards the allowlist from widening into "any assignment to anything
    // ending in _VERSION".
    const sneaky = `--- a/packages/signer/src/server.ts
+++ b/packages/signer/src/server.ts
@@ -12 +12 @@
-export const SIGNER_VERSION = '0.1.30-alpha.0'
+export const SIGNER_VERSION = process.env.ANYTHING
`
    assert.equal(isVersionOnlyDiff(sneaky), false)
  })

  test('a comment-only edit is NOT excused — this function answers one question', () => {
    const comment = `--- a/packages/signer/src/server.ts
+++ b/packages/signer/src/server.ts
@@ -11 +11 @@
-// self-reported version
+// self-reported version, owned by release-bump.mjs
`
    assert.equal(isVersionOnlyDiff(comment), false)
  })

  // ── The three cases a per-line shape check let through (review finding) ────
  // Each of these is well-shaped on every line and would have been excused by
  // shape matching alone. They are refused because the SYMBOL removed must
  // equal the symbol added.

  test('a deletion of the version constant, with nothing replacing it, is NOT excused', () => {
    const deletionOnly = `--- a/packages/signer/src/server.ts
+++ b/packages/signer/src/server.ts
@@ -12 +11,0 @@
-export const SIGNER_VERSION = '0.1.30-alpha.0'
`
    assert.equal(isVersionOnlyDiff(deletionOnly), false)
  })

  test('a dependency IDENTITY swap is NOT excused — it retargets what the signer depends on', () => {
    // Both lines match the dep shape; only the pairing check catches that the
    // package name changed rather than its version.
    const swap = `--- a/packages/signer/package.json
+++ b/packages/signer/package.json
@@ -20 +20 @@
-    "@haven_ai/sdk": "0.1.30-alpha.0",
+    "@haven_ai/mcp": "0.1.31-alpha.0",
`
    assert.equal(isVersionOnlyDiff(swap), false)
  })

  test('a rename of the version constant is NOT excused', () => {
    const rename = `--- a/packages/signer/src/server.ts
+++ b/packages/signer/src/server.ts
@@ -12 +12 @@
-export const SIGNER_VERSION = '0.1.30-alpha.0'
+export const ATTACKER_VERSION = '0.1.31-alpha.0'
`
    assert.equal(isVersionOnlyDiff(rename), false)
  })

  test('a _VERSION constant release-bump does not own is NOT excused', () => {
    // The allowlist names SIGNER_VERSION literally rather than matching
    // [A-Z0-9_]*_VERSION, so an unowned constant is refused even when paired.
    const unowned = `--- a/packages/signer/src/server.ts
+++ b/packages/signer/src/server.ts
@@ -12 +12 @@
-export const SOMETHING_VERSION = '0.1.30-alpha.0'
+export const SOMETHING_VERSION = '0.1.31-alpha.0'
`
    assert.equal(isVersionOnlyDiff(unowned), false)
  })

  test('a pure ADDITION of a version line is NOT excused', () => {
    const addition = `--- a/packages/signer/package.json
+++ b/packages/signer/package.json
@@ -20,0 +21 @@
+    "@haven_ai/mcp": "0.1.31-alpha.0",
`
    assert.equal(isVersionOnlyDiff(addition), false)
  })

  test('a multi-symbol in-place bump IS excused — pairing is a multiset, not an order', () => {
    const reordered = `--- a/packages/signer/package.json
+++ b/packages/signer/package.json
@@ -3,2 +3,2 @@
-  "version": "0.1.30-alpha.0",
-    "@haven_ai/sdk": "0.1.30-alpha.0",
+    "@haven_ai/sdk": "0.1.31-alpha.0",
+  "version": "0.1.31-alpha.0",
`
    assert.equal(isVersionOnlyDiff(reordered), true)
  })

  test('a dependency MOVED between sections is NOT excused, though it nets to zero file-wide', () => {
    // Round-two review finding: `@haven_ai/sdk` leaves `dependencies` in one
    // hunk and appears in `devDependencies` in another. File-wide multiset
    // equality excuses this; per-hunk equality refuses it. It changes what
    // ships when @haven_ai/signer is installed.
    const sectionMove = `--- a/packages/signer/package.json
+++ b/packages/signer/package.json
@@ -19,2 +19,1 @@
   "dependencies": {
-    "@haven_ai/sdk": "0.1.30-alpha.0",
@@ -30,1 +29,2 @@
   "devDependencies": {
+    "@haven_ai/sdk": "0.1.31-alpha.0",
`
    assert.equal(isVersionOnlyDiff(sectionMove), false)
  })

  test('a real two-hunk bump IS still excused — each hunk balances on its own', () => {
    // Guards the per-hunk rule from being too strict: this is what
    // release-bump.mjs actually writes to a package.json.
    assert.equal(isVersionOnlyDiff(packageJsonBump), true)
  })

  test('a diff with no hunk header fails closed', () => {
    const headersOnly = `--- a/packages/signer/package.json
+++ b/packages/signer/package.json
`
    assert.equal(isVersionOnlyDiff(headersOnly), false)
  })

  test('empty, blank and non-string diffs fail closed', () => {
    for (const bad of ['', '   \n', null, undefined, 42]) {
      assert.equal(isVersionOnlyDiff(bad), false)
    }
  })

  test('a diff with only headers and context fails closed — no changed lines is not a pass', () => {
    const noChanges = `--- a/packages/signer/package.json
+++ b/packages/signer/package.json
@@ -3 +3 @@
   "name": "@haven_ai/signer",
`
    assert.equal(isVersionOnlyDiff(noChanges), false)
  })
})

describe('partitionVersionOnly (#2164)', () => {
  test('splits a release bump away from behavioural money-path work', () => {
    const diffs = {
      'packages/signer/src/server.ts': signerVersionBump,
      'packages/signer/package.json': packageJsonBump,
      'packages/backend/src/modules/x402/settle.ts': `--- a/x
+++ b/x
@@ -1 +1 @@
-const a = 1
+const a = 2
`,
    }
    const { behavioural, versionOnly } = partitionVersionOnly(Object.keys(diffs), (f) => diffs[f])
    assert.deepEqual(versionOnly, ['packages/signer/src/server.ts', 'packages/signer/package.json'])
    assert.deepEqual(behavioural, ['packages/backend/src/modules/x402/settle.ts'])
  })

  test('an unreadable diff is treated as BEHAVIOURAL, never excused', () => {
    const { behavioural, versionOnly } = partitionVersionOnly(['packages/signer/src/server.ts'], () => null)
    assert.deepEqual(behavioural, ['packages/signer/src/server.ts'])
    assert.deepEqual(versionOnly, [])
  })

  test('a diffFor that throws is treated as BEHAVIOURAL', () => {
    const { behavioural, versionOnly } = partitionVersionOnly(['packages/signer/src/server.ts'], () => {
      throw new Error('git exploded')
    })
    assert.deepEqual(behavioural, ['packages/signer/src/server.ts'])
    assert.deepEqual(versionOnly, [])
  })

  test('a full release bump leaves NOTHING behavioural — the #2164 outcome', () => {
    const { behavioural } = partitionVersionOnly(
      ['packages/signer/src/server.ts', 'packages/signer/package.json'],
      (f) => (f.endsWith('.json') ? packageJsonBump : signerVersionBump),
    )
    assert.deepEqual(behavioural, [])
  })
})
