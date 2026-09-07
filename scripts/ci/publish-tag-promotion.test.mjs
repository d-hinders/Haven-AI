/**
 * The credential boundary between publishing and moving `latest` (#2647).
 *
 * ## What broke, and why a test rather than a comment
 *
 * npm Trusted Publishing (OIDC) authorises `npm publish` and nothing else.
 * `npm dist-tag add` is a separate registry mutation the OIDC credential has no
 * rights to. #2581 added the tag move inside the publish job on that untested
 * assumption; the 0.1.35-alpha.0 release was its first real execution and every
 * tag move failed E401, leaving `latest` a release behind `alpha` — the precise
 * defect #2536 was written to prevent.
 *
 * The repair moves the tag mutation into a `main`-only job holding a long-lived
 * token, scoped by a GitHub Environment. The property that matters is not "the
 * job exists" but that the credential and the publish path stay SEPARATE: the
 * publish job must never regain the ability to move a tag, and the token must
 * never become reachable from a `dev` run. Both are one careless edit away, and
 * neither fails visibly — a token leaking into the publish job's scope looks
 * exactly like a working release until someone reads the file.
 *
 * These are text assertions over a workflow, which is brittle by construction
 * and deliberately so — this suite has no YAML dependency, matching
 * release-bump.test.mjs, which reads the same file the same way. Every failure
 * here is a throw. If one breaks, re-point the matcher at the real structure;
 * never relax an assertion until it passes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORKFLOW = join(ROOT, '.github', 'workflows', 'publish.yml')

const workflow = await readFile(WORKFLOW, 'utf8')

/**
 * Split the file into "everything up to the promote-tags job" and "the
 * promote-tags job".
 *
 * The boundary is NOT the `promote-tags:` key itself. The job is introduced by
 * a long comment banner that explains why it exists, and that banner names
 * `npm dist-tag add` and the token in prose. Splitting on the key would file
 * the banner under the publish job and fail the very assertions it documents —
 * so the boundary walks BACK over the contiguous comment block above the key.
 * Asserting the split found something is the difference between a real test and
 * one that passes because both halves are empty.
 */
function jobs() {
  const lines = workflow.split('\n')
  const key = lines.findIndex((l) => l === '  promote-tags:')
  assert.notEqual(key, -1, 'publish.yml no longer has a `promote-tags:` job — re-point this guard, do not delete it')

  let at = key
  while (at > 0 && /^\s*(#.*)?$/.test(lines[at - 1])) at -= 1

  return {
    publishJob: lines.slice(0, at).join('\n'),
    promoteJob: lines.slice(at).join('\n'),
  }
}

test('the tag mutation lives ONLY in promote-tags, never in the publish job (#2647)', () => {
  const { publishJob, promoteJob } = jobs()

  // The whole point. A publish job that can move a tag is the arrangement that
  // failed: it would need the token, and the token cannot be scoped per-step.
  assert.doesNotMatch(
    publishJob,
    /npm dist-tag add/,
    'the publish job calls `npm dist-tag add` again — that call needs a credential OIDC cannot provide, and putting it here forces the token into the publish job scope',
  )
  assert.match(promoteJob, /npm dist-tag add/, 'promote-tags no longer moves the tag')

  // Exactly one CALL SITE in the file. Two means one of them is unguarded.
  // Comment lines are excluded deliberately: the banner above promote-tags and
  // the enforcement points in the file header both name the command in prose,
  // and counting those would make this assertion measure documentation.
  const calls = workflow
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#') && l.includes('npm dist-tag add'))
  assert.equal(calls.length, 1, `expected exactly one \`npm dist-tag add\` call site, found ${calls.length}: ${JSON.stringify(calls)}`)
})

test('the npm token is reachable only from promote-tags (#2647)', () => {
  const { publishJob, promoteJob } = jobs()

  assert.doesNotMatch(
    publishJob,
    /NPM_DIST_TAG_TOKEN/,
    'NPM_DIST_TAG_TOKEN is referenced in the publish job — that job runs on every dev snapshot push, so the long-lived credential would be in scope for runs that must never hold it',
  )
  assert.match(promoteJob, /NPM_DIST_TAG_TOKEN/, 'promote-tags no longer reads the token')
})

test('promote-tags is scoped to main by the ENVIRONMENT, not only by an if (#2647)', () => {
  const { promoteJob } = jobs()

  // The environment is the control: its deployment-branch policy withholds the
  // secret from any ref but `main`, and survives someone editing the `if:`.
  assert.match(
    promoteJob,
    /environment:\s*npm-production-tags/,
    'promote-tags lost its `environment:` — an `if:` alone does not withhold the secret from a dev run',
  )

  // The `if:` is the cheap half and still earns its place: it turns "no work to
  // do" into a clean skip rather than a job that starts and finds nothing.
  // `!cancelled()` is not decoration. Without it, `needs: publish` means this
  // job runs only when publish SUCCEEDED — so #1159's partial publish (four
  // packages live, one failed) would leave `latest` stale on the four that
  // did publish, which the inline call before the split handled correctly.
  // Asserted on the `if:` LINE, not on the job text: the comment above it
  // explains `!cancelled()` in prose, and matching that would let the
  // expression itself be deleted while the guard stayed green.
  const cond = promoteJob.split('\n').find((l) => l.trimStart().startsWith('if:'))
  assert.ok(cond, 'promote-tags has no `if:` at all')
  assert.match(
    cond,
    /!cancelled\(\)/,
    'promote-tags lost `!cancelled()` — a partial publish failure would now skip the tag move for the packages that DID publish (#1159)',
  )
  assert.match(cond, /needs\.publish\.outputs\.promote != ''/, 'promote-tags no longer skips when nothing published')
})

test('the nomination list is written before any exit that could skip it (#1159)', () => {
  const { publishJob } = jobs()

  // Same defect as above, one layer down: the output write must precede every
  // `exit 1` in the step, or a partial failure hands `promote-tags` nothing.
  // Scoped to the publish STEP, not the whole job: earlier steps (channel
  // resolution) exit before any publish happens and have nothing to hand over.
  const stepAt = publishJob.indexOf('        id: publish')
  assert.notEqual(stepAt, -1, 'the publish step lost its `id: publish`')
  const step = publishJob.slice(stepAt)

  const write = step.indexOf('echo "promote=$(echo $promote)" >> "$GITHUB_OUTPUT"')
  assert.notEqual(write, -1, 'the publish step no longer writes the `promote` output')

  const exits = [...step.matchAll(/^ +exit 1$/gm)].map((m) => m.index)
  const early = exits.filter((i) => i < write)
  assert.deepEqual(
    early,
    [],
    'an `exit 1` now precedes the `promote` output write — a partial publish would skip the tag move for the packages that did publish',
  )
})

test('promote-tags cannot publish: no id-token, and the publish job keeps it (#2647)', () => {
  const { publishJob, promoteJob } = jobs()

  // A tag mover with `id-token: write` could mint an OIDC credential and
  // publish. It has no reason to, so it must not be able to.
  assert.doesNotMatch(
    promoteJob,
    /id-token:\s*write/,
    'promote-tags requests `id-token: write` — it only moves a tag and must not be able to publish',
  )
  assert.match(
    publishJob,
    /id-token:\s*write/,
    'the publish job lost `id-token: write` — Trusted Publishing needs it, and without it publishing falls back to nothing',
  )
})

test('the publish job hands over only what it actually published (#2536 property, preserved)', () => {
  const { publishJob } = jobs()

  // The re-run safety property, carried through the job split. Nomination
  // happens inside the successful-publish branch, so re-running an OLD run —
  // where every version already exists and skips — nominates nothing and
  // promote-tags does not run at all. Losing this would let a stale re-run drag
  // `latest` backwards.
  assert.match(publishJob, /outputs:[\s\S]*?promote: \$\{\{ steps\.publish\.outputs\.promote \}\}/, 'the publish job no longer exposes the `promote` output')
  assert.match(publishJob, /record_latest_promotion "\$channel" "\$name" "\$version" "\$tag"/, 'the nomination call has moved or been renamed')

  const call = publishJob.indexOf('record_latest_promotion "$channel"')
  const publishBranch = publishJob.indexOf('if npm publish -w "packages/$pkg"')
  assert.ok(
    publishBranch !== -1 && call > publishBranch,
    'record_latest_promotion is no longer called from inside the successful-publish branch — that placement is what stops a re-run moving `latest` backwards',
  )
})

test('a snapshot can still never be nominated for latest (#2536 enforcement point 4)', () => {
  const { publishJob } = jobs()
  assert.match(
    publishJob,
    /0\.0\.0-dev\.\*\)[\s\S]{0,400}?refusing to move latest to snapshot version/,
    'the snapshot refusal in record_latest_promotion is gone — a dev snapshot could reach `latest`',
  )
})

/**
 * Behaviour, not text: the spec split must survive a SCOPED package name.
 *
 * `@haven_ai/sdk@0.1.36-alpha.0` contains two `@`. A split on the first one
 * yields an empty name and a version of `haven_ai/sdk@0.1.36-alpha.0`, and
 * `npm dist-tag add` would then either fail or, worse, act on the wrong thing.
 * Every package this workflow publishes is scoped, so the wrong expansion would
 * break all five — verified by running the real shell rather than by reasoning
 * about parameter expansion.
 */
test('the name@version split handles scoped packages (#2647)', () => {
  const script = `
    set -euo pipefail
    for spec in "$@"; do
      name="\${spec%@*}"; version="\${spec##*@}"
      echo "$name|$version"
    done
  `
  const out = execFileSync('bash', ['-c', script, '--',
    '@haven_ai/sdk@0.1.36-alpha.0',
    '@haven_ai/cli@1.0.0',
    'unscoped@2.3.4',
  ], { encoding: 'utf8' }).trim().split('\n')

  assert.deepEqual(out, [
    '@haven_ai/sdk|0.1.36-alpha.0',
    '@haven_ai/cli|1.0.0',
    'unscoped|2.3.4',
  ])
})

/**
 * The bridge has an expiry, and it is written down where someone will hit it.
 *
 * npm caps write-enabled granular tokens at 90 days, so this credential dies on
 * a known date and takes silent tag promotion with it — the same failure as the
 * incident that prompted the fix. A date in a comment is not a reminder, but its
 * ABSENCE guarantees nobody finds it while diagnosing the next failure.
 */
test('the token expiry and its deprecation are recorded in the workflow (#2647)', () => {
  const { promoteJob } = jobs()
  assert.match(promoteJob, /2026-12-06/, 'the token expiry date is no longer recorded next to the job that depends on it')
  assert.match(promoteJob, /BRIDGE, NOT THE ANSWER/, 'the bridge framing is gone — this job reads as a permanent design')
})
